// Control panel, part 2 of 17: Graphics hub and graphics actions.
// Built into control-panel/app.js with the other parts (scripts/build-panel-app.js): one script, one scope.

// ── Graphics hub (Production → Graphics) ─────────────────────────────────────
// ── Graphics actions: what showing / hiding each graphic does ─────────────────────────────────
// Every path that takes a graphic on or off air (its own buttons, Hide all, showing another graphic,
// the deck, the rundown, automations) calls gfxShow(key) / gfxHide(key). They used to .click() the
// scene's hidden button, so a button whose handler did more than hide ran that extra work from
// every one of those paths: Hide all emptied the schedule that way. A graphic that has not
// registered its actions falls back to its button.
const GFX_ACTIONS = { show: Object.create(null), hide: Object.create(null) };
function gfxAction(kind, key, fn, btnId) {
  GFX_ACTIONS[kind][key] = fn;
  if (btnId) el(btnId)?.addEventListener('click', function (...a) { return fn.apply(this, a); });
}
function gfxSceneMetaOf(key) { return (window._gfxSceneMeta && window._gfxSceneMeta[key]) || {}; }
function gfxHide(key) {
  const fn = GFX_ACTIONS.hide[key]; if (fn) return fn();
  const m = gfxSceneMetaOf(key); el(m.clearId || ('btn-hide-' + key))?.click();
}
function gfxShow(key) {
  const fn = GFX_ACTIONS.show[key]; if (fn) return fn();
  const m = gfxSceneMetaOf(key); el(m.pushId || ('btn-show-' + key))?.click();
}

(function buildGraphicsHub() {
  const gtab = document.getElementById('prod-graphics-tab');
  if (!gtab) return;
  const nav = document.getElementById('gfx-scene-nav');
  if (!nav) return;

  // Per-scene metadata for the unified top bar. hasApply = this scene has its own editable content
  // worth saving without forcing it on/off (Apply, in the panel footer). Scenes whose content
  // already saves live as you edit it (series/matchup/veto/draft/spotlight/bracket) have no Apply —
  // Push to Live (top bar) is the only action they need.
  const SCENE_META = {
    break:     { name: 'Break / Starting Soon', link: 'countdown.html',       hasClear: true,  hasQueue: true,  hasPush: true,  hasApply: true  },
    winner:    { name: 'Winner / Post-match',   link: 'winner.html',          hasClear: true,  hasQueue: true,  hasPush: true,  hasApply: true  },
    intro:     { name: 'Team Line-up / Intro',  link: 'intro.html',           hasClear: true,  hasQueue: true,  hasPush: true,  hasApply: true  },
    ticker:    { name: 'Ticker',                link: 'ticker.html',          hasClear: true,  hasQueue: false, hasPush: true,  hasApply: true,  pushId: 'btn-ticker-apply' },
    // Standalone OBS scene (like duorow/quaddesk) — not a gfx.html layer, so "Push Live" can't mean
    // "toggle a layer" here. standaloneScene names the real OBS/vMix scene this graphic lives on;
    // the top-bar button cuts the switcher straight to it instead of calling doPush().
    preshow:   { name: 'Desk Show',              link: 'preshow.html',         hasClear: false, hasQueue: false, hasPush: true, standaloneScene: 'Desk Show' },
    series:    { name: 'Series Score',          link: 'series.html',          hasClear: true,  hasQueue: false, hasPush: true  },
    matchup:   { name: 'Pre-Match Lineup',      link: 'matchup.html',         hasClear: true,  hasQueue: false, hasPush: true  },
    seriesstats: { name: 'Series Stats',        link: 'rl-series-stats.html', hasClear: true,  hasQueue: false, hasPush: true,  popout: true, rlOnly: true },
    veto:      { name: 'Map Pool',               link: 'mapscreen.html',       hasClear: true,  hasQueue: false, hasPush: true,  clearId: 'btn-hide-veto-gfx', pushId: 'btn-show-veto-gfx', popout: true },
    draft:     { name: 'Pick / Ban',            link: 'draft.html',           hasClear: true,  hasQueue: false, hasPush: true,  popout: true },
    spotlight: { name: 'Spotlight',             link: 'watchlist.html',       hasClear: true,  hasQueue: false, hasPush: true,  popout: true },
    standings: { name: 'Standings',             link: 'standings.html',       hasClear: true,  hasQueue: false, hasPush: true,  hasApply: true,  pushId: 'btn-gfx-standings-push', clearId: 'btn-gfx-standings-clear', popout: true },
    schedule:  { name: 'Schedule',              link: 'schedule.html',        hasClear: true,  hasQueue: false, hasPush: true,  hasApply: true,  pushId: 'btn-gfx-schedule-push', clearId: 'btn-hide-schedule-gfx', popout: true },
    bracket:   { name: 'Bracket',               link: 'bracket.html',         hasClear: true,  hasQueue: false, hasPush: true,  popout: true },
    credits:   { name: 'Stream Credits',        link: 'stream-credits.html',  hasClear: true,  hasQueue: false, hasPush: true  },
    // Battle-royale scenes. Their CONTENT is driven from Match — Lobby (that's where the field
    // is), so these entries exist to make them pushable/clearable from the same Graphics rail as
    // everything else — hasApply is off because there's nothing here to save.
    brdrop:    { name: 'Drop Map',              link: 'fn-dropmap.html',      hasClear: true,  hasQueue: false, hasPush: true, brOnly: true },
    brcompare: { name: 'Comparison Card',       link: 'fn-compare.html',      hasClear: true,  hasQueue: false, hasPush: true, brOnly: true },
    brvictory: { name: 'Victory Royale',        link: 'fn-victory.html',      hasClear: true,  hasQueue: false, hasPush: true, brOnly: true },
  };

  let currentKey = 'break';

  // Footer status message (fades after 2.5s).
  function gfxFootStatus(msg, ok) {
    const st = el('gfx-foot-status'); if (!st) return;
    st.textContent = msg; st.style.color = ok ? '#4ade80' : 'var(--muted)';
    clearTimeout(gfxFootStatus._t); gfxFootStatus._t = setTimeout(() => { if (st) st.textContent = ''; }, 2500);
  }

  // Update the top bar + panel footer to reflect the active scene.
  function refreshTopBar(key) {
    const meta = SCENE_META[key] || { name: key, link: '' };
    const base = window.SCENE_BASE_URL || 'http://localhost:3000';
    const nameEl = el('gfx-active-name'), linkEl = el('gfx-active-link');
    if (nameEl) nameEl.textContent = meta.name || key;
    // The ⓘ chip: the ONE OBS browser source URL, surfaced on hover (each scene's own overlay
    // URL sits in the scene header next to its ON/OFF AIR pill — not up here).
    if (linkEl) {
      linkEl.href = base + '/gfx.html';
      linkEl.title = 'OBS browser source: ' + base + '/gfx.html — one source carries every pushed graphic. Click to open.';
    }
    // Top bar Push to Live — the sole way to change what's live. Standalone scenes (not a
    // gfx.html layer) get a relabeled button that cuts the switcher straight to their OBS scene.
    const topPush = el('gfx-top-push');
    if (topPush) {
      topPush.style.display = meta.hasPush ? '' : 'none';
      if (meta.standaloneScene) {
        topPush.textContent = 'Cut to Scene';
        topPush.title = `Cut OBS/vMix straight to the "${meta.standaloneScene}" scene`;
      } else {
        topPush.textContent = 'Push Live';
        topPush.title = 'Show this scene on gfx.html — hides every other scene there';
      }
    }
    // Footer: Apply (save content, no visibility change) + Add to Rundown only. No Clear here —
    // Clear All (top bar) and Push to Live (top bar) are the only visibility controls now.
    // Pop-out scenes have their own footer inside the modal — this shared one only applies to
    // whatever's currently rendered inline in the settings column.
    const footPush = el('gfx-foot-push'), footQueue = el('gfx-foot-queue');
    const hasApply = !meta.popout && !!meta.hasApply;
    const hasQueue = !meta.popout && !!meta.hasQueue;
    if (footPush) footPush.style.display = hasApply ? '' : 'none';
    if (footQueue) footQueue.style.display = hasQueue ? '' : 'none';
    const footer = el('gfx-panel-footer');
    if (footer) footer.style.display = (hasApply || hasQueue) ? '' : 'none';
    // Uniform scene header — same frame on every scene: name, THIS scene's on-air state
    // (gfx layer OR the scene's own visible flag), and its overlay link.
    const headName = el('gfx-scene-head-name');
    if (headName) {
      // Scenes without an Apply step broadcast every edit AS YOU TYPE (their inputs send
      // straight to the server) — badge them so the producer knows typing is on-air-visible
      // whenever the scene is live. Standalone scenes (preshow) cut via the switcher instead.
      const liveEdit = !meta.hasApply && !meta.standaloneScene;
      headName.innerHTML = esc(meta.name || key)
        + (liveEdit ? ' <span class="gfx-liveedit-badge" title="No Apply step — edits in this panel reach the overlay immediately while it is on air">Live edit</span>' : '');
      const VIS_PATHS = {
        bracket: 'bracket.visible', veto: 'veto.visible', standings: 'standings.visible',
        schedule: 'upcoming.visible', spotlight: 'watchlist.visible', winner: 'winner.visible',
        intro: 'intro.visible', break: 'breakScreen.visible', ticker: 'ticker.visible', draft: 'draft.visible'
      };
      const ownVisible = (typeof getPath === 'function' && VIS_PATHS[key])
        ? !!getPath(currentState || {}, VIS_PATHS[key]) : false;
      const onAir = (currentState && currentState.gfxActive === key) || ownVisible;
      const headLive = el('gfx-scene-head-live');
      if (headLive) { headLive.classList.toggle('is-off', !onAir); headLive.textContent = onAir ? 'ON AIR' : 'OFF AIR'; }
      const headLink = el('gfx-scene-head-link');
      if (headLink) {
        if (meta.link) { headLink.style.display = ''; headLink.href = (window.SCENE_BASE_URL || 'http://localhost:3000') + '/' + meta.link; }
        else headLink.style.display = 'none';
      }
    }
    // Live dot on sidenav + "Live on gfx.html" name + always-visible status pill.
    const liveScene = currentState && currentState.gfxActive;
    document.querySelectorAll('.gfx-sidenav-btn[data-gfxscene]').forEach((b) => b.classList.toggle('gfx-nav-live', b.dataset.gfxscene === liveScene));
    const liveNameEl = el('gfx-live-name');
    if (liveNameEl) liveNameEl.textContent = liveScene ? ((SCENE_META[liveScene] && SCENE_META[liveScene].name) || liveScene) : 'Nothing';
    const badge = el('gfx-live-badge');
    if (badge) { badge.classList.toggle('is-off', !liveScene); badge.textContent = liveScene ? 'LIVE' : 'OFF AIR'; }
    // Push button reflects whether the EDITED scene is the live one (re-push is harmless).
    if (topPush) {
      const isLive = !!liveScene && liveScene === key;
      topPush.textContent = isLive ? 'Live — Re-push' : 'Push Live';
      topPush.style.opacity = isLive ? '.75' : '';
    }
    // OBS program chip — pushing a graphic only changes gfx.html layering; whether viewers see
    // it depends on which OBS scene is on program. Surface that here, amber when a graphic is
    // live but Auto-cut is off (the "why isn't my graphic on stream?" trap).
    const obsChip = el('gfx-obs-chip');
    if (obsChip) {
      const obs = (currentState && currentState.obs) || {};
      if (obs.connected && obs.currentScene) {
        obsChip.style.display = '';
        obsChip.textContent = 'OBS: ' + obs.currentScene;
        const warn = !!liveScene && !el('gfx-autocut-on')?.checked;
        obsChip.style.color = warn ? '#fbbf24' : 'var(--muted)';
        obsChip.style.borderColor = warn ? 'rgba(251,191,36,.45)' : 'var(--border,#2e3340)';
        obsChip.title = warn
          ? 'A graphic is live on gfx.html, but OBS is on "' + obs.currentScene + '" — viewers only see the graphic if that scene shows gfx.html. Arm Auto-cut OBS to switch scenes on push.'
          : 'Current OBS program scene';
      } else {
        obsChip.style.display = 'none';
      }
    }
  }
  // State-driven topbar refresh (OBS program scene / gfxActive can change server-side).
  window._gfxRefreshTopBar = () => refreshTopBar(currentKey);
  // Display name for a gfx scene key — used by the topbar ON AIR strip (GFX chip).
  window._gfxSceneName = (k) => ((SCENE_META[k] || {}).name) || k;

  // Clear ALL GFX scenes (one-click clear everything) — top bar only.
  function clearAllGfxScenes() {
    Object.entries(SCENE_META).forEach(([k, meta]) => {
      if (meta.hasClear) gfxHide(k);
    });
    send('set_gfx_active', { scene: null });
    // Optimistic update — the server round-trip hasn't landed yet, so reflect "nothing live" in
    // the top bar immediately rather than waiting on the next full_state broadcast.
    if (currentState) currentState.gfxActive = null;
    refreshTopBar(currentKey);
  }

  // Push a scene LIVE, auto-clearing the previously live GFX scene first. This is the ONLY action
  // that changes visibility / gfxActive — it hides every other scene on gfx.html and shows this one
  // (the scene's own standalone overlay URL is unaffected either way, per its own visible flag).
  function doPush(key) {
    const meta = SCENE_META[key] || {};
    const prev = currentState && currentState.gfxActive;
    if (prev && prev !== key && SCENE_META[prev]) {
      gfxHide(prev);
    }
    gfxShow(key);
    send('set_gfx_active', { scene: key });
    // Optimistic update — reflect the new live scene immediately rather than waiting on the
    // server round-trip (same reasoning as clearAllGfxScenes above).
    if (currentState) currentState.gfxActive = key;
    gfxFootStatus((meta.name || key) + ' pushed live.', true);
    refreshTopBar(key);
    // Auto-cut OBS: when the producer has armed it, switch OBS to their chosen scene so the graphic
    // and the OBS scene that holds it go live together.
    if (el('gfx-autocut-on')?.checked) {
      const _sc = (el('gfx-autocut-scene')?.value || '').trim();
      if (_sc) { send('obs_switch_scene', { sceneName: _sc }); gfxFootStatus((meta.name || key) + ' live — cut OBS to ' + _sc + '.', true); }
    } else {
      // No auto-cut: the graphic only reaches viewers if the current OBS program scene shows
      // gfx.html — say so instead of letting "pushed live" imply it's on stream.
      const _obs = (currentState && currentState.obs) || {};
      if (_obs.connected && _obs.currentScene) {
        gfxFootStatus((meta.name || key) + ' pushed — OBS is on "' + _obs.currentScene + '". Viewers see it only if that scene shows gfx.html.', false);
      }
    }
  }

  // Save a scene's content WITHOUT touching visibility/gfxActive — omitting the `visible` key from
  // each set_X payload lets the server preserve whatever's already showing (a widespread convention
  // in this codebase's WS handlers).
  function stripVisible(payload) { const { visible, ...rest } = payload || {}; return rest; }
  const SCENE_APPLY = {
    break: () => el('btn-update-break')?.click(),
    winner: () => send('set_winner', stripVisible(winnerPayload(true))),
    intro: () => send('set_intro', stripVisible(introPayload(true))),
    ticker: () => send('set_ticker', tickerContentPayload()),
    standings: () => {
      const src = document.querySelector('#gfx-std-src .gfx-src-tab.is-on')?.dataset.stdsrc || 'league';
      if (src === 'manual') { el('gfx-std-save')?.click(); return; }
      const r = buildStandingsPayload();
      if (!r.ok) { gfxStdStatus(r.err, true); return; }
      send('set_standings', r.payload);
      gfxStdStatus('Saved.', false);
    },
    schedule: () => {
      send('set_upcoming', buildScheduleContentPayload());
      const st = el('gfx-sch-status');
      if (st) { st.textContent = 'Saved.'; setTimeout(() => { st.textContent = ''; }, 2500); }
    },
  };
  function applyScene(key) {
    const fn = SCENE_APPLY[key];
    if (fn) fn();
    gfxFootStatus('Saved.', true);
  }

  // Top bar: "Clear All" clears every GFX overlay; "Push to Live" is the sole way to make the
  // currently-edited scene live.
  document.getElementById('gfx-top-clear')?.addEventListener('click', async () => {
    // Only prompt when a graphic is actually on air — clearing nothing is harmless. (The qrail
    // "clear all" link funnels through this button too, so this guard covers both entry points.)
    if (currentState && currentState.gfxActive) {
      const ok = await appConfirm('Take every on-air graphic down? A graphic is live right now.', 'Clear all');
      if (!ok) return;
    }
    clearAllGfxScenes(); gfxFootStatus('All scenes cleared.', false);
  });
  // Hidden delegation targets kept for rundown and external callers.
  document.getElementById('gfx-top-queue')?.addEventListener('click', () => el('btn-queue-' + currentKey)?.click());
  document.getElementById('gfx-top-push')?.addEventListener('click', () => {
    const meta = SCENE_META[currentKey] || {};
    if (meta.standaloneScene) {
      const backend = typeof swBackend === 'function' ? swBackend(currentState) : 'obs';
      const ready = backend === 'vmix' ? !!(currentState.vmix && currentState.vmix.connected) : !!(currentState.obs && currentState.obs.connected);
      if (!ready) { gfxFootStatus(`${backend === 'vmix' ? 'vMix' : 'OBS'} isn't connected — can't cut scenes.`, false); return; }
      send('obs_switch_scene', { sceneName: meta.standaloneScene });
      gfxFootStatus(`Cut ${backend === 'vmix' ? 'vMix' : 'OBS'} to "${meta.standaloneScene}".`, true);
      return;
    }
    doPush(currentKey);
  });

  // Panel footer: Apply only (saves content, no visibility change).
  el('gfx-foot-push')?.addEventListener('click', () => applyScene(currentKey));
  el('gfx-foot-queue')?.addEventListener('click', () => el('gfx-top-queue')?.click());

  // Dynamic preview scaling — scales any open pop-out's own embedded preview and the floating
  // OBS Program panel's GFX-mode iframe to fit their container.
  // The retry below used to be unbounded: any preview box with no width re-armed the whole scan
  // 120ms later, forever. A box that is DISPLAY:NONE (every closed pop-out / inactive scene panel)
  // never gains width, so the loop never ended — and since several callers can start it, the loops
  // stacked. A profile of a 36-minute-old session had this one function at 64% of the renderer's
  // CPU, re-running querySelectorAll over the whole panel DOM ~8x a second. Hence: skip hidden
  // boxes entirely (they're re-fit when opened — see the fitScenePreviews() call in show() and the
  // ResizeObserver on these same boxes), cap the retries at boxes that are laid out but not yet
  // measured, and keep ONE pending retry rather than one per caller.
  let _fitPvTimer = null, _fitPvTries = 0;
  function fitScenePreviews(_retry) {
    if (!_retry) _fitPvTries = 0;
    let anyMissed = false;
    document.querySelectorAll('.gfx-popout-box .live-pv, .obs-prev-gfx .live-pv').forEach(function(wrap) {
      const iframe = wrap.querySelector('iframe');
      if (!iframe) return;
      // Not rendered at all (closed pop-out / inactive scene panel) — nothing to measure, and it
      // won't gain a size until it's shown, so don't let it re-arm the retry below forever.
      // getClientRects() rather than offsetParent: the floating OBS Program panel is position:fixed,
      // which has a null offsetParent while being perfectly visible and very much in need of fitting.
      if (!wrap.getClientRects().length) return;
      const w = wrap.offsetWidth, h = wrap.offsetHeight || wrap.clientHeight;
      if (!w) { anyMissed = true; return; }
      const scale = h ? Math.min(w / 1920, h / 1080) : (w / 1920);
      iframe.style.left = Math.max(0, (w - 1920 * scale) / 2) + 'px';
      iframe.style.transform = 'scale(' + scale + ')';
    });
    clearTimeout(_fitPvTimer); _fitPvTimer = null;
    // Visible-but-unmeasured is a real transient (mid-layout, iframe still loading) — retry a few
    // times, then stop. ~1.2s is far longer than a layout pass; anything still 0 isn't coming.
    if (anyMissed && ++_fitPvTries <= 10) _fitPvTimer = setTimeout(() => fitScenePreviews(true), 120);
  }
  window._fitScenePreviews = fitScenePreviews;

  // Scene-specific side effects that must fire whenever a scene becomes the active one — whether
  // that's by inline selection or by opening its pop-out. Kept as one function so both paths stay
  // in sync (previously these lived directly inside show(), only reachable via sidenav select).
  function runSceneSideEffects(key) {
    if (key === 'spotlight') {
      try {
        if (typeof renderSpotlight === 'function') renderSpotlight();
        const spMode = typeof _spMode !== 'undefined' ? _spMode : 'watch';
        if (typeof spSetMode === 'function') spSetMode(spMode);
        syncSpotlightPreview(spMode);
        if (typeof fitLivePreviews === 'function') setTimeout(fitLivePreviews, 40);
      } catch (_) {}
    }
    if (key === 'veto' && typeof mpSyncFromState === 'function') mpSyncFromState(currentState);
  }

  // Front-facing panels for pop-out scenes. Bracket, Map Pool and Spotlight host real, persistent
  // quick-action controls (import field, map-pool form, team search/reorder) — those never get
  // rebuilt here, they self-update via their own state-driven render functions, so typing/dragging
  // in them never gets clobbered by a state broadcast. Standings/Schedule/Draft don't need real
  // inputs on the front panel, so they keep the simple text-summary + quick-action rebuild.
  function renderPopoutSummary(key) {
    const data = currentState || {};
    const row = (label, value) => `<div class="gfx-pos-row"><span class="gfx-pos-label">${label}</span><span class="gfx-pos-value">${value}</span></div>`;
    const empty = (msg) => `<p class="gfx-pos-empty">${msg}</p>`;
    if (key === 'standings') {
      const body = el('gfx-front-standings-body'); if (!body) return;
      const s = data.standings || {};
      // Sync inline quick-edit controls (don't clobber a field the producer is typing in)
      const tEl = el('gfx-front-std-title');
      if (tEl && document.activeElement !== tEl) tEl.value = s.title || '';
      // Leaving Title blank falls through to the event title on the overlay, so SAY so in the
      // placeholder rather than making the producer guess what an empty field will show.
      if (tEl) tEl.placeholder = (data.eventName || '').trim() || 'STANDINGS';
      const sEl = el('gfx-front-std-subtitle'); if (sEl && document.activeElement !== sEl) sEl.value = s.subtitle || '';
      const rEl = el('gfx-front-std-showrecord'); if (rEl && document.activeElement !== rEl) rEl.checked = s.showRecord !== false;
      const layoutChoice = s.layout || 'auto';
      document.querySelectorAll('#gfx-std-layout-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.stdlayout === layoutChoice));
      stdRenderFighters();
      const srcBtn = document.querySelector('#gfx-std-src .gfx-std-src-tab.is-on, #gfx-std-src .gfx-src-tab.is-on');
      // Mirror the pop-out's active source onto the front-panel chips (legacy names → 'tournament').
      const srcKey = gfxStdNormSrc(srcBtn ? srcBtn.dataset.stdsrc : 'league');
      document.querySelectorAll('#gfx-front-std-src .gfx-src-tab').forEach((t) => t.classList.toggle('is-on', t.dataset.fstdsrc === srcKey));
      // Live preview of the standings rows currently on air.
      const rows = s.rows || [];
      const cnt = el('gfx-front-std-count'); if (cnt) cnt.textContent = rows.length ? (rows.length + (rows.length === 1 ? ' team' : ' teams')) : '';
      if (!rows.length) {
        body.innerHTML = '<p class="gfx-fp-empty">No rows yet — pick a league / tournament above, or add rows in the Full Board.</p>';
      } else {
        const showRec = s.showRecord !== false;
        body.innerHTML = rows.slice(0, 24).map((r, i) => {
          const rk = r.placement || (i + 1);
          const logo = r.logo ? `<img class="logo" src="${tlEsc(String(r.logo))}" alt="">` : '';
          const rec = showRec ? `<span class="rec">${(r.wins || 0)}-${(r.losses || 0)}</span>` : '';
          const pts = (r.points != null && r.points !== '') ? `<span class="pts">${tlEsc(String(r.points))}</span>` : '';
          const nm = tlEsc(r.name || 'TBD');
          return `<div class="gfx-fp-prow"><span class="rk">${rk}</span>${logo}<span class="nm" title="${nm}">${nm}</span>${rec}${pts}</div>`;
        }).join('');
      }
    } else if (key === 'schedule') {
      const u = data.upcoming || {};
      const tEl = el('gfx-front-sch-title'); if (tEl && document.activeElement !== tEl) tEl.value = u.title || '';
      // The editable preview (remove/reorder inline) is owned by schFrontRender(), which renders from
      // _schMatches so edits and the pop-out list stay in lock-step.
      if (typeof schFrontRender === 'function') schFrontRender();
    } else if (key === 'draft') {
      const body = el('gfx-front-draft-body'); if (!body) return;
      const d = data.draft || {};
      const started = !!(d.sequence && d.sequence.length);
      // Overwatch bans ARE the whole draft, so they get a real board on the front card instead
      // of a status readout — everything else keeps the simple summary + Full board link.
      const isOwActive = started && d.game === 'overwatch';
      const blueTeam = (data.teams?.blue?.name) || 'Blue';
      const orangeTeam = (data.teams?.orange?.name) || 'Orange';
      const blueColor = (data.teams?.blue?.color) || '#2f8dff';
      const orangeColor = (data.teams?.orange?.color) || '#f0444e';
      // Goes-first toggle: team-named buttons over the hidden #draft-front-start select (the value
      // the Start handler reads). Only classes/labels change per broadcast, never the elements, so
      // a click can't be destroyed mid-press by a re-render.
      const ts = d.teamStart === 'b' ? 'b' : 'a';
      const firstSel = el('draft-front-start');
      if (firstSel && document.activeElement !== firstSel) firstSel.value = ts;
      el('draft-front-first-seg')?.querySelectorAll('button[data-v]').forEach((b) => {
        const side = b.dataset.v === 'b' ? 'b' : 'a';
        const nm = side === 'b' ? orangeTeam : blueTeam;
        if (b.textContent !== nm) b.textContent = nm;
        b.style.setProperty('--seg-c', side === 'b' ? orangeColor : blueColor);
        b.classList.toggle('is-on', side === ts);
      });
      // Overwatch: say which map the bans are being saved to. Pick / Ban follows the scoreboard's game
      // number, which is the easy thing to get out of step with; any map's bans can also be set
      // straight on its Map Pool card.
      const owNote = el('draft-front-ow-map');
      if (owNote) {
        const isOw = data.activeGame === 'overwatch' || d.game === 'overwatch';
        owNote.hidden = !isOw;
        if (isOw) {
          const n = Math.max(1, (data.game && data.game.number) || 1);
          const played = ((data.veto && data.veto.maps) || []).filter((m) => m && (m.action === 'pick' || m.action === 'decider'));
          const m = played[n - 1];
          const txt = `Bans save to map ${n}${m && m.name ? ': ' + m.name : ''} (the scoreboard's game ${n}). For any other map, set its bans on its Map Pool card.`;
          if (owNote.textContent !== txt) owNote.textContent = txt;
        }
      }
      // Status readout — hidden while the Overwatch board is up (the board IS the status).
      body.style.display = isOwActive ? 'none' : '';
      const sig = isOwActive ? 'ow' : started
        ? 'run::' + d.game + '::' + (d.ops || []).length + '/' + d.sequence.length + '::' + !!d.complete
        : 'idle';
      if (body.dataset.sig !== sig) {
        body.dataset.sig = sig;
        body.innerHTML = isOwActive ? '' : started
          ? row('Game', tlEsc((data.games && data.games[d.game] && data.games[d.game].name) || d.game || ''))
            + row('Progress', (d.ops || []).length + ' / ' + d.sequence.length)
            + row('Status', d.complete ? 'Complete' : 'In progress')
          : empty('Not started. Choose who goes first, then start.');
      }
      const startBtn = el('btn-draft-front-start');
      if (startBtn) startBtn.textContent = started ? 'Restart' : 'Start pick / ban';
      const hasOps = !!(d.ops && d.ops.length);
      const undoBtn = el('btn-draft-front-undo'); if (undoBtn) undoBtn.disabled = !hasOps;
      // Reset stays live once started: with no bans it still re-applies Goes first / ban count.
      const resetBtn = el('btn-draft-front-reset'); if (resetBtn) resetBtn.disabled = !started;
      // Clear-all is live whenever ANY map of the series has a ban, even if this map's board is empty.
      const clearAllBtn = el('btn-draft-front-clear-all'); if (clearAllBtn) clearAllBtn.disabled = !owSeriesHasBans(data);
      const owWrap = el('gfx-front-draft-ow');
      if (owWrap) {
        owWrap.style.display = isOwActive ? '' : 'none';
        if (isOwActive && typeof renderOwFrontBoard === 'function') renderOwFrontBoard(data, d);
      }
    }
    // bracket / veto / spotlight: nothing to rebuild — their front panels host persistent real
    // markup (moved-not-cloned from their pop-out editors) that updates itself in place.
  }
  // Quick-action button markup for the Standings/Schedule/Draft summary cards — handled by one
  // delegated listener on the whole front-panel container below.
  el('gfx-popout-summary')?.addEventListener('click', (e) => {
    if (e.target.closest('#btn-draft-front-start')) {
      const go = () => {
        const game = currentState?.activeGame || '';
        // Overwatch bans already show on the scoreboard bar, so starting them must NOT throw the
        // full-screen ban scene on air — the producer pushes it with Push Live when they want it.
        // Other games keep the old behaviour: the board is the only place their picks show.
        const isOw = game === 'overwatch';
        const payload = { game, teamStart: el('draft-front-start')?.value || 'a',
          title: el('draft-front-title')?.value || '', subtitle: el('draft-front-subtitle')?.value || '',
          owBanCount: Number(el('draft-front-owbans')?.value) || 2 };
        if (!isOw) payload.visible = true;
        send('draft_start', payload);
        if (!isOw) doPush('draft');
      };
      // Restarting over real picks/bans wipes them — confirm first.
      if ((currentState?.draft?.ops || []).length) {
        appConfirm('Restart pick / ban? Every pick and ban made so far will be cleared.', 'Restart', true).then((ok) => { if (ok) go(); });
      } else go();
    }
  });
  // Segmented toggles proxy their hidden selects, so the existing change wiring stays the one path.
  const _segPick = (segId, selId) => el(segId)?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]'); const sel = el(selId); if (!b || !sel) return;
    el(segId).querySelectorAll('button[data-v]').forEach((x) => x.classList.toggle('is-on', x === b));
    if (sel.value === b.dataset.v) return;
    sel.value = b.dataset.v; sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  _segPick('draft-front-first-seg', 'draft-front-start');
  _segPick('draft-front-owbans-seg', 'draft-front-owbans');
  // Board look (layout / strip edge / shot clock): presentation only, so each change goes straight to air.
  const _draftLookSeg = (segId, key) => el(segId)?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    el(segId).querySelectorAll('button[data-v]').forEach((x) => x.classList.toggle('is-on', x === b));
    send('set_draft_meta', { [key]: b.dataset.v });
  });
  _draftLookSeg('draft-front-layout-seg', 'layout');
  _draftLookSeg('draft-front-pos-seg', 'stripPos');
  el('draft-front-clock')?.addEventListener('change', (e) => send('set_draft_meta', { turnSeconds: Number(e.target.value) || 0 }));
  // Persist the front-card "which side starts" pick so it survives re-renders and the full board mirrors it.
  el('gfx-popout-summary')?.addEventListener('change', (e) => {
    const s = e.target.closest('#draft-front-start');
    if (s) send('set_draft_meta', { teamStart: s.value === 'b' ? 'b' : 'a' });
  });

  // Inline quick-edit controls on the Standings / Schedule front cards — write straight to state
  // (title/subtitle/showRecord all take live effect), so producers don't open the Full Board for
  // the common tweaks. Deep source/rows/layout config still lives in the pop-out.
  // Standings front-panel source chips — proxy-click the pop-out's real source tabs so the
  // existing load/apply wiring stays the single implementation.
  el('gfx-front-std-src')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fstdsrc]'); if (!b) return;
    document.querySelector(`#gfx-std-src .gfx-src-tab[data-stdsrc="${b.dataset.fstdsrc}"]`)?.click();
    el('gfx-front-std-src')?.querySelectorAll('.gfx-src-tab').forEach((t) => t.classList.toggle('is-on', t === b));
    renderPopoutSummary('standings');
  });
  const _stdTitle = debounce(() => send('set_standings', { title: (el('gfx-front-std-title')?.value || '').trim() }), 350);
  el('gfx-front-std-title')?.addEventListener('input', _stdTitle);
  const _stdSub = debounce(() => send('set_standings', { subtitle: (el('gfx-front-std-subtitle')?.value || '').trim() }), 350);
  el('gfx-front-std-subtitle')?.addEventListener('input', _stdSub);
  el('gfx-front-std-showrecord')?.addEventListener('change', function () { send('set_standings', { showRecord: this.checked }); });
  const _schTitle = debounce(() => send('set_upcoming', { title: (el('gfx-front-sch-title')?.value || '').trim() }), 350);
  el('gfx-front-sch-title')?.addEventListener('input', _schTitle);
  // Push / Clear right on the front cards — proxy the existing hidden scene buttons so all the
  // build-payload + visible:true logic stays single-sourced (no clicking up to the top rail).
  el('gfx-front-std-push')?.addEventListener('click', () => el('btn-gfx-standings-push')?.click());
  el('gfx-front-std-clear')?.addEventListener('click', () => el('btn-gfx-standings-clear')?.click());
  el('gfx-front-sch-push')?.addEventListener('click', () => el('btn-gfx-schedule-push')?.click());
  el('gfx-front-sch-clear')?.addEventListener('click', () => el('btn-gfx-schedule-clear')?.click());

  // Open/close a scene's FULL BOARD (Bracket, Spotlight, Standings, Schedule, Map Pool, Draft).
  // No longer a floating modal — the board docks full-width below the hub (#gfx-popout-<key>)
  // and we scroll it into view; only one board is open at a time.
  // The boards (the manual bracket builder above all) are deep editors: they open as a popup over
  // the hub rather than docking below it, so the scene you were on is still there behind them.
  function openGfxPopout(key) {
    const modal = el('gfx-popout-' + key); if (!modal) return;
    document.querySelectorAll('.gfx-fullboard').forEach((m) => { if (m !== modal) m.style.display = 'none'; });
    modal.style.display = 'flex';
    document.body.classList.add('gfx-board-open');
    runSceneSideEffects(key);
    requestAnimationFrame(() => requestAnimationFrame(fitScenePreviews));
  }
  function closeGfxPopout(key) {
    const modal = el('gfx-popout-' + key); if (modal) modal.style.display = 'none';
    if (!document.querySelector('.gfx-fullboard[style*="flex"]')) document.body.classList.remove('gfx-board-open');
  }
  // Esc closes whichever board is open; clicking the backdrop (outside the box) does too.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('.gfx-fullboard').forEach((m) => {
      if (m.style.display === 'flex') closeGfxPopout(m.id.replace('gfx-popout-', ''));
    });
  });
  document.querySelectorAll('.gfx-fullboard[id^="gfx-popout-"]').forEach((m) => {
    m.addEventListener('mousedown', (e) => { if (e.target === m) closeGfxPopout(m.id.replace('gfx-popout-', '')); });
  });
  window._gfxOpenPopout = openGfxPopout;
  window._gfxClosePopout = closeGfxPopout;
  // Keep the front-facing summary live as state changes (e.g. a match gets queued elsewhere)
  // while a pop-out scene is the current selection but its editor isn't open.
  window._gfxRefreshPopoutSummary = () => { if (SCENE_META[currentKey] && SCENE_META[currentKey].popout) renderPopoutSummary(currentKey); };
  el('gfx-popout-summary-open')?.addEventListener('click', () => openGfxPopout(currentKey));
  // "Pop out preview" — opens the floating, draggable, resizable OBS Program panel already
  // switched to its GFX tab (mirrors whatever scene is currently selected here).
  el('gfx-preview-popout')?.addEventListener('click', () => { if (typeof window._obsPreviewOpenGfx === 'function') window._obsPreviewOpenGfx(); });
  // Generic wiring for every pop-out present in the DOM: close (× button or backdrop click),
  // Push Live / Clear / Apply footer buttons reuse the exact same SCENE_META-driven actions as
  // the main top bar so there's only one push/clear/apply implementation in the whole hub.
  document.querySelectorAll('.gfx-fullboard[id^="gfx-popout-"]').forEach((modal) => {
    const key = modal.id.replace('gfx-popout-', '');
    modal.querySelectorAll('[data-popout-close]').forEach((b) => b.addEventListener('click', () => closeGfxPopout(key)));
    modal.querySelectorAll('[data-popout-push]').forEach((b) => b.addEventListener('click', () => doPush(key)));
    modal.querySelectorAll('[data-popout-clear]').forEach((b) => b.addEventListener('click', () => {
      gfxHide(key);
    }));
    modal.querySelectorAll('[data-popout-apply]').forEach((b) => b.addEventListener('click', () => applyScene(key)));
    modal.querySelectorAll('[data-popout-queue]').forEach((b) => b.addEventListener('click', () => el('btn-queue-' + key)?.click()));
    // Internal tabs within a pop-out (e.g. Map Pool's "Guided Veto" / "Quick Map Pool").
    modal.querySelectorAll('.gfx-popout-tab[data-ptab]').forEach((tabBtn) => {
      tabBtn.addEventListener('click', () => {
        modal.querySelectorAll('.gfx-popout-tab[data-ptab]').forEach((b) => b.classList.toggle('is-on', b === tabBtn));
        modal.querySelectorAll('.gfx-popout-pane[data-ppane]').forEach((p) => { p.hidden = p.dataset.ppane !== tabBtn.dataset.ptab; });
      });
    });
  });

  // Points the floating OBS Program panel's GFX mode at a scene's standalone overlay (?preview=1)
  // — the inline preview column this used to also drive was removed once GFX mode covered the
  // same job. `force` is kept for callers still passing it (harmless no-op now: there's no longer
  // a second, re-parented iframe that needs a forced reload to un-stick).
  function gfxApplyPreview(key) {
    if (!SCENE_META[key] || !SCENE_META[key].link) return;
    if (typeof window._obsPrevSyncGfx === 'function') window._obsPrevSyncGfx();
  }
  // Re-sync the floating GFX preview after a DOM re-parent (Dashboard borrow/return) — the hub's
  // own DOM moved, so anything driven by scene-selection needs re-poking to notice.
  window._gfxReapplyPreview = () => { if (currentKey) gfxApplyPreview(currentKey); };
  // The URL for whatever scene is currently being edited — used by the floating OBS Program
  // panel's GFX mode (a separate iframe, not the same DOM node as the inline preview above).
  window._gfxCurrentPreviewUrl = () => {
    if (!currentKey || !SCENE_META[currentKey] || !SCENE_META[currentKey].link) return '';
    const base = window.SCENE_BASE_URL || 'http://localhost:3000';
    return base + '/' + SCENE_META[currentKey].link + '?preview=1';
  };

  // Tab switching.
  const ALIAS = { scenes: 'break', lower: 'spotlight', manual: 'bracket', upcoming: 'schedule', brackets: 'bracket' };
  function show(which) {
    const btns = Array.from(nav.querySelectorAll('.gfx-sidenav-btn[data-gfxscene]'));
    const keys = btns.map((b) => b.dataset.gfxscene);
    // 'series' has no sidenav button of its own — it shares Map Pool's entry via the mode toggle
    // below — so fall back to any valid SCENE_META key, not just ones with a button.
    const key = keys.includes(which) ? which : (SCENE_META[which] ? which : (ALIAS[which] && keys.includes(ALIAS[which]) ? ALIAS[which] : keys[0]));
    currentKey = key;
    const navHighlightKey = (key === 'series') ? 'veto' : key;
    // Map Pool's map cards need the full width: the preview moves above the editor for it.
    const setCol = el('gfx-settings-col');
    setCol?.classList.toggle('gfx-wide-editor', key === 'veto' || key === 'series');
    // Switching graphics while scrolled down a long editor: open the next one at its top.
    if (setCol && setCol.offsetParent && setCol.getBoundingClientRect().top < 0) setCol.scrollIntoView({ block: 'start' });
    btns.forEach((b) => b.classList.toggle('active', b.dataset.gfxscene === navHighlightKey));
    // Keep the floating OBS Program panel's GFX mode pointed at this scene, in case it's open.
    gfxApplyPreview(key);
    refreshTopBar(key);
    // Map Pool / Series mode toggle — visible only for these two scenes; reuses show() itself
    // as the transport so Push Live/Clear/preview swap above all stay correct with zero extra code.
    const msToggle = el('gfx-mapseries-toggle');
    if (msToggle) {
      msToggle.style.display = (key === 'veto' || key === 'series') ? '' : 'none';
      msToggle.querySelectorAll('.sp-mode-btn').forEach((b) => b.classList.toggle('is-on', b.dataset.mstoggle === key));
    }
    const isPopout = !!(SCENE_META[key] && SCENE_META[key].popout) && !!el('gfx-popout-' + key);
    const summary = el('gfx-popout-summary');
    if (isPopout) {
      // Pop-out scenes: show that scene's front panel (quick actions / status) instead of the
      // full editor — the editor itself only opens when the Settings button is clicked.
      // Global lookup, not gtab-scoped: when the hub has been borrowed onto the Dashboard (see
      // _borrowGraphicsToDash), these panels are no longer descendants of gtab (#prod-graphics-tab,
      // now an empty shell) — a gtab-scoped query silently finds nothing and the whole panel
      // switcher stops working whenever the app starts on Dashboard instead of Production.
      document.querySelectorAll('.gfx-scene-panel').forEach((p) => { p.style.display = 'none'; });
      if (summary) {
        summary.style.display = '';
        summary.querySelectorAll('.gfx-front-panel[data-frontkey]').forEach((p) => { p.style.display = (p.dataset.frontkey === key) ? '' : 'none'; });
      }
      renderPopoutSummary(key);
    } else {
      if (summary) summary.style.display = 'none';
      document.querySelectorAll('.gfx-scene-panel').forEach((p) => { p.style.display = (p.dataset.gfxpanel === key) ? '' : 'none'; });
    }
    // Universal Full Board button (under the preview): one button, one place, for every scene
    // whose deep editor lives on the docked board. Spotlight/Schedule edit fully inline (their
    // front cards ARE the whole feature) so the board adds nothing there. Switching scenes also
    // closes any open board so a stale editor never lingers under the wrong scene.
    const FULLBOARD_SCENES = ['bracket', 'standings', 'veto', 'draft'];
    const fbBtn = el('gfx-popout-summary-open');
    if (fbBtn) fbBtn.style.display = FULLBOARD_SCENES.includes(key) && el('gfx-popout-' + key) ? '' : 'none';
    document.querySelectorAll('.gfx-fullboard').forEach((m) => { m.style.display = 'none'; });
    // Refresh data pickers so they always show current state when navigated to.
    if (key === 'matchup' && typeof window._gfxRefreshMatchupPickers === 'function') window._gfxRefreshMatchupPickers(currentState);
    if (key === 'winner'  && typeof window._gfxRefreshWinnerPicker   === 'function') window._gfxRefreshWinnerPicker(currentState);
    if (key === 'draft'   && typeof renderDraftManager === 'function') renderDraftManager(currentState);
    // Per-scene appearance preset bar (accent/accent2/font overrides) — retired, per-scene
    // theming duplicated what the active Brand Kit's own color/accent/font already provide and
    // wasn't used anywhere. PRESET_SCENES stays empty (rather than deleting this block) so the
    // bar can come back for a specific scene later without rebuilding the mount/render wiring.
    const presetMount = el('gfx-preset-mount');
    if (presetMount) {
      const PRESET_SCENES = [];
      if (PRESET_SCENES.includes(key)) {
        if (presetMount.dataset.scene !== key) {
          presetMount.dataset.scene = key;
          presetMount.innerHTML = custBarHtml(key);
        }
        presetMount.style.display = '';
        if (typeof renderScenePresets === 'function' && currentState) renderScenePresets(currentState);
      } else {
        presetMount.style.display = 'none';
        presetMount.dataset.scene = '';
        presetMount.innerHTML = '';
      }
    }
    runSceneSideEffects(key);
    requestAnimationFrame(() => requestAnimationFrame(fitScenePreviews));
    try { localStorage.setItem('gfx_active_grp', key); } catch (_) {}
  }
  nav.querySelectorAll('.gfx-sidenav-btn[data-gfxscene]').forEach((b) => b.addEventListener('click', () => show(b.dataset.gfxscene)));
  document.querySelectorAll('#gfx-mapseries-toggle .sp-mode-btn').forEach((b) => b.addEventListener('click', () => show(b.dataset.mstoggle)));

  // Collapsible sidenav category groups (Show/Match/Event/Talent & Features) — state persists
  // across sessions like the rest of the hub's per-scene preference (gfx_active_grp).
  const NAV_COLLAPSE_KEY = 'gfx_nav_collapsed';
  function getNavCollapsed() { try { return JSON.parse(localStorage.getItem(NAV_COLLAPSE_KEY) || '[]'); } catch (_) { return []; } }
  function setNavCollapsed(arr) { try { localStorage.setItem(NAV_COLLAPSE_KEY, JSON.stringify(arr)); } catch (_) {} }
  const collapsedGroups = new Set(getNavCollapsed());
  nav.querySelectorAll('.gfx-nav-group[data-navgroup]').forEach((grp) => {
    if (collapsedGroups.has(grp.dataset.navgroup)) grp.classList.add('collapsed');
  });
  nav.querySelectorAll('.gfx-nav-cat[data-navtoggle]').forEach((catBtn) => {
    catBtn.addEventListener('click', () => {
      const grp = catBtn.closest('.gfx-nav-group'); if (!grp) return;
      grp.classList.toggle('collapsed');
      const set = new Set(getNavCollapsed());
      const key = grp.dataset.navgroup;
      if (grp.classList.contains('collapsed')) set.add(key); else set.delete(key);
      setNavCollapsed(Array.from(set));
    });
  });

  window._gfxCfgShow = (which) => show(which);
  window._gfxSceneMeta = SCENE_META;  // expose for on-air board auto-clear
  window._gfxDoPush = doPush;         // expose for external callers (hotkeys, rundown)
  // Take ONE scene off air (its own hide button), and drop gfxActive if it was the live layer.
  window._gfxDoClear = (key) => {
    const meta = SCENE_META[key]; if (!meta) return;
    if (meta.hasClear) gfxHide(key);
    if (currentState && currentState.gfxActive === key) { send('set_gfx_active', { scene: null }); currentState.gfxActive = null; }
    refreshTopBar(currentKey);
  };

  // ── Battle-royale scenes ────────────────────────────────────────────────────
  // doPush()/clearAllGfxScenes() drive scenes through hidden btn-show-*/btn-hide-* buttons, so
  // the BR graphics need theirs wired the same way rather than being special-cased in the hub.
  gfxAction('show', 'brdrop', () => send('set_br_dropmap', { visible: true }), 'btn-show-brdrop');
  gfxAction('hide', 'brdrop', () => send('set_br_dropmap', { visible: false }), 'btn-hide-brdrop');
  gfxAction('show', 'brcompare', () => send('set_br_compare', { visible: true }), 'btn-show-brcompare');
  gfxAction('hide', 'brcompare', () => send('set_br_compare', { visible: false }), 'btn-hide-brcompare');
  gfxAction('show', 'brvictory', () => send('set_br_victory', { visible: true }), 'btn-show-brvictory');
  gfxAction('hide', 'brvictory', () => send('set_br_victory', { visible: false }), 'btn-hide-brvictory');

  // Drop-map settings (the only BR content that has no home in Match — Lobby).
  el('gfx-brdrop-title')?.addEventListener('change', function () { send('set_br_dropmap', { title: this.value }); });
  el('gfx-brdrop-map')?.addEventListener('change', function () { send('set_br_dropmap', { mapUrl: this.value }); });
  el('gfx-brdrop-players')?.addEventListener('change', function () { send('set_br_dropmap', { showPlayers: this.checked }); });
  el('gfx-brdrop-logos')?.addEventListener('change', function () { send('set_br_dropmap', { showLogos: this.checked }); });
  el('gfx-brcompare-goto')?.addEventListener('click', () => {
    // Match — Lobby lives inside Match — Teams, which relocates between the Dashboard and the
    // Teams tab. Go to the Dashboard (its default home), then open the builder.
    document.querySelector('.tab-btn[data-tab="principal"]')?.click();
    setTimeout(() => {
      const box = el('mlb-compare');
      if (box && box.style.display === 'none') el('mlb-compare-open')?.click();
      el('match-lobby')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
  });
  el('gfx-brvic-apply')?.addEventListener('click', () => send('set_br_victory', {
    team: (el('gfx-brvic-team') || {}).value || '',
    stage: (el('gfx-brvic-stage') || {}).value || '',
    match: (el('gfx-brvic-match') || {}).value || ''
  }));
  el('gfx-brvic-auto')?.addEventListener('click', () => {
    const m = Math.max(1, parseInt((el('mlb-match') || {}).value, 10) || 1);
    send('set_br_victory', { fromMatch: m });
  });

  // Series Stats is Rocket League only (same rule as the BR group below, one button rather than a
  // group). Hydrates both copies of its controls — the Graphics panel and the Match — Teams gear —
  // because the two edit the same state and ids are global to this document.
  window.gfxSyncSeriesStats = function (data) {
    const isRl = !!(data && data.activeGame === 'rocket-league');
    const tab = el('gfx-tab-seriesstats');
    if (tab) tab.style.display = isRl ? '' : 'none';
    // Don't strand a producer on a hidden panel when they switch games.
    if (!isRl && currentKey === 'seriesstats') show('break');
    // The gear-panel copies live inside #msp-rl-scenes, which applyRlSceneAuto already shows/hides.

    const ss = (data && data.seriesStats) || {};
    const games = Array.isArray(ss.games) ? ss.games : [];
    [el('chk-series-stats'), el('gfx-ss-enabled')].forEach((cb) => {
      if (cb && document.activeElement !== cb) cb.checked = !!ss.enabled;
    });
    const design = ss.design || 'table';
    const sel = el('sel-series-stats-design');
    if (sel && document.activeElement !== sel) sel.value = design;
    document.querySelectorAll('#gfx-ss-design .gfx-pill').forEach((b) => b.classList.toggle('is-on', b.dataset.ssd === design));
    // Winner reveal design — same pill pattern.
    const wStyle = (data.winner && data.winner.style) || 'slam';
    document.querySelectorAll('#gfx-winner-style .gfx-pill').forEach((b) => b.classList.toggle('is-on', b.dataset.wstyle === wStyle));

    window.gfxSeriesStatsStatus(data);
  };

  // Status line, split out because the RL live tick refreshes it on its own (see the state_update
  // branch in the socket handler): a producer watching this mid-game needs "game 2 is live and
  // being tracked", not a line that sits on "nothing cached yet" until the game ends.
  window.gfxSeriesStatsStatus = function (data) {
    const ss = (data && data.seriesStats) || {};
    const games = Array.isArray(ss.games) ? ss.games : [];
    const KEYS = ['score', 'goals', 'assists', 'saves', 'shots', 'demos'];
    // A live game counts only once it has actually produced something, matching the board.
    const tick = Array.isArray(data && data.players) ? data.players : [];
    const live = (tick.length ? tick : Object.values((data && data.playerCache) || {}))
      .filter((p) => p && p.name);
    const liveOn = !ss.liveBanked && live.some((p) => KEYS.some((k) => (Number(p[k]) || 0) > 0));
    const scores = games.map((g) => (Number(g.blueScore) || 0) + '-' + (Number(g.orangeScore) || 0)).join(', ');

    let txt;
    if (!ss.enabled) {
      txt = 'Off — the board can only show the game being played.';
    } else if (games.length && liveOn) {
      txt = games.length + (games.length === 1 ? ' game' : ' games') + ' cached (' + scores + ') + game '
          + (games.length + 1) + ' live now.';
    } else if (games.length) {
      txt = games.length + (games.length === 1 ? ' game' : ' games') + ' cached (' + scores + ').';
    } else if (liveOn) {
      txt = 'Game 1 live — tracking ' + live.length + (live.length === 1 ? ' player' : ' players')
          + '. Banked when the game ends.';
    } else {
      txt = 'On — nothing cached yet. Games are added as they finish.';
    }
    ['mt-series-stats-status', 'gfx-ss-status'].forEach((id) => { const n = el(id); if (n) n.textContent = txt; });
  };

  // Show the BR nav group + hydrate its fields only while a BR lobby game is active. Called from
  // applyState so it tracks a game switch immediately.
  window.gfxSyncBrNav = function (data) {
    const grp = el('gfx-nav-group-br');
    const meta = (data && data.brMeta) || {};
    const on = (meta.lobbyGames || []).includes(data && data.activeGame);
    if (grp) grp.style.display = on ? '' : 'none';
    // A producer sitting on a BR scene when they switch to a non-BR game would otherwise be
    // stranded on a hidden panel — put them somewhere real.
    if (!on && SCENE_META[currentKey] && SCENE_META[currentKey].brOnly) show('break');
    if (!on) return;
    const dm = ((data.br || {}).dropmap) || {};
    const set = (id, v) => { const n = el(id); if (n && n !== document.activeElement) n.value = v; };
    set('gfx-brdrop-title', dm.title || '');
    set('gfx-brdrop-map', dm.mapUrl || '');
    const p = el('gfx-brdrop-players'); if (p && p !== document.activeElement) p.checked = dm.showPlayers !== false;
    const l = el('gfx-brdrop-logos');   if (l && l !== document.activeElement) l.checked = !!dm.showLogos;
    const v = ((data.br || {}).victory) || {};
    set('gfx-brvic-team', v.team || '');
    set('gfx-brvic-stage', v.stage || '');
    set('gfx-brvic-match', v.match || '');
  };

  // Inject Spotlight panel into the right-column body of the split layout.
  const spotlightPanel = document.getElementById('ev-spotlight-panel');
  const spotlightHost  = document.getElementById('gfx-spotlight-body');
  if (spotlightPanel && spotlightHost) {
    spotlightPanel.style.display = '';
    spotlightHost.appendChild(spotlightPanel);
    const btn = document.getElementById('gfx-tab-spotlight');
    if (btn) btn.style.display = '';
  }

  // Sync the left-panel preview iframe to the active spotlight mode (watch vs solo).
  function syncSpotlightPreview(mode) {
    const pv = document.getElementById('gfx-pv-spotlight');
    if (!pv) return;
    const base = window.SCENE_BASE_URL || 'http://localhost:3000';
    pv.src = base + (mode === 'solo' ? '/team-spotlight.html' : '/watchlist.html') + '?preview=1';
  }

  // When the user clicks Teams to Watch / Team Spotlight, update the main preview too.
  document.querySelectorAll('#sp-modes .sp-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => syncSpotlightPreview(btn.dataset.spmode));
  });

  // Refined Bracket panel: pull ONLY the start.gg bracket editor + phase builder INTO the scene
  // body (so they live inside the preview/controls split + scroll, not clipped below it). The old
  // Upcoming/Standings sections are NOT injected — those graphics now have their own refined scenes.
  const bracketsPanel = document.getElementById('ev-brackets-panel');
  const bracketBody   = document.getElementById('gfx-bracket-body');
  if (bracketsPanel && bracketBody) {
    const sectIn = (id) => { const e = bracketsPanel.querySelector('#' + id); return e ? e.closest('section.section') : null; };
    ['input-bracket-slug', 'bb-phases'].forEach((id) => {
      const sec = sectIn(id); if (sec) { sec.classList.add('gfx-injected'); bracketBody.appendChild(sec); }
    });
    // The injected start.gg editor is the complete one (Load Event + view chips + match picker).
    // The quick-import source tabs + slug field live on the front panel now (#gfx-front-bracket),
    // not inside this pop-out body. The bracket builder runs FULL WIDTH (CSS drops the left preview
    // column for this scene), so the injected inline `bracket-live-preview` stays on as the
    // bracket's own full-width, collapsible preview.
    const btn = document.getElementById('gfx-tab-bracket');
    if (btn) btn.style.display = '';
  }

  // Remove Spotlight and Bracket from Events sub-nav (surfaced here instead).
  document.querySelectorAll('#ev-subnav .ev-subnav-btn[data-evtab="spotlight"], #ev-subnav .ev-subnav-btn[data-evtab="brackets"]').forEach((b) => b.remove());

  // Queue buttons (hidden delegation targets wired here).
  const QUEUE_LABELS = { break: 'Break / Starting Soon', winner: 'Winner Screen', intro: 'Team Line-up', veto: 'Map Veto' };
  ['break', 'winner', 'intro', 'veto'].forEach((scene) => {
    const btn = document.getElementById('btn-queue-' + scene);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const rdType  = document.getElementById('rd-add-type');
      const rdLabel = document.getElementById('rd-add-label');
      const rdAdd   = document.getElementById('rd-add-btn');
      if (rdType && rdAdd) {
        const typeVal = Array.from(rdType.options).find((o) => o.value === scene || o.value === 'graphic' || o.value === 'gfx');
        if (typeVal) rdType.value = typeVal.value;
        if (rdLabel) rdLabel.value = QUEUE_LABELS[scene] || scene;
        rdAdd.click();
      }
      if (typeof _pdShow === 'function') _pdShow('rundown');
    });
  });

  // Veto push live / clear (hidden delegation targets wired here).
  gfxAction('show', 'veto', () => send('set_veto', { visible: true }), 'btn-show-veto-gfx');
  gfxAction('hide', 'veto', () => send('set_veto', { visible: false }), 'btn-hide-veto-gfx');

  // ── Map Pool (manual mode) ────────────────────────────────────────────────
  // A simpler alternative to the guided pick/ban sequence: choose each map from the active
  // game's pool and enter a score. A Best-of-X series does NOT always play all X maps — Bo3 is
  // often decided 2-0, Bo5 often 3-0/3-1 — so "Best of X" only sets the natural STARTING count
  // (the minimum maps needed to decide the series) and a ceiling (can't play more maps than the
  // format allows); the producer grows the list with "+ Add map" only if the series actually
  // goes that far, and can remove a slot they added by mistake. Auto-saves as you edit (mirrors
  // mapscreen.html's data contract — same set_veto {title, maps} the guided veto uses).
  function mpMapPool() {
    const game = currentState && currentState.activeGame;
    return (currentState && currentState.vetoPools && currentState.vetoPools[game]) || [];
  }
  // Panel runs from file://, so asset paths from the server need an absolute origin.
  const MP_ASSET_BASE = location.protocol === 'file:' ? 'http://127.0.0.1:3000' : '';
  // Game-mode vocabulary comes from the ACTIVE GAME (backend/veto.js VETO_META.modes — Overwatch
  // Control/Hybrid/…, Rocket League Standard/Hoops/Dropshot/Snow Day/Rumble/Heatseeker/Spike Rush),
  // plus any type already on a pool entry. A game with no modes gets no dropdown at all instead of
  // the old Overwatch-only list showing up on every game.
  function mpModeOptions() {
    const game = currentState && currentState.activeGame;
    const meta = (currentState && currentState.vetoMeta && currentState.vetoMeta[game]) || {};
    const out = Array.isArray(meta.modes) ? meta.modes.slice() : [];
    mpMapPool().forEach((p) => { if (p.type && !out.includes(p.type)) out.push(p.type); });
    return out;
  }
  function mpModeIcon(mode) {
    const src = (window._vmModeImg || {})[String(mode || '').toLowerCase().trim()];
    return src ? MP_ASSET_BASE + src : '';
  }
  // Map names arriving from the series editor / start.gg rarely match a pool entry character for
  // character ("DFH" vs "DFH Stadium"), so match loosely before giving up and keeping it as a
  // free-text row.
  const mpNorm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  function mpFindPool(pool, name) {
    if (!name) return null;
    const n = mpNorm(name); if (!n) return null;
    return pool.find((p) => p.name === name)
        || pool.find((p) => mpNorm(p.name) === n)
        || pool.find((p) => mpNorm(p.name).startsWith(n) || n.startsWith(mpNorm(p.name)))
        || null;
  }
  const MP_CUSTOM = 'custom:';   // <option> value for a name with no pool match (kept, not dropped)
  // Type-to-search front for a row's map <select>. The native select stays in the row (hidden) as
  // the value store, so mpBuildMapsPayload and the change listeners are untouched — picking from
  // the list just sets sel.value and fires 'change'. List is alphabetical; the query matches the
  // map name (accent-insensitive, so "paraiso" finds Paraíso) or its mode ("escort").
  // Icon dropdown for a row's Mode <select> — a native <option> can't show an image, and the mode
  // logo is what the overlay badges the map card with. The select stays (hidden) as the value
  // store; picking sets it and fires 'change', so the existing wiring is untouched.
  function mpModePick(modeSel) {
    const box = document.createElement('div'); box.className = 'mp-ipick';
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'input-select mp-ipick-btn';
    btn.title = modeSel.title || '';
    const dd = document.createElement('div'); dd.className = 'team-dd mp-ipick-dd'; dd.setAttribute('role', 'listbox');
    modeSel.style.display = 'none';
    box.appendChild(btn); box.appendChild(dd); box.appendChild(modeSel);
    const icon = (v) => { const src = v ? mpModeIcon(v) : ''; return src ? `<img src="${dEsc(src)}" alt="" onerror="this.style.visibility='hidden'">` : '<span class="mp-ipick-ph"></span>'; };
    const paint = () => {
      const o = modeSel.options[modeSel.selectedIndex];
      const v = o ? o.value : '';
      btn.classList.toggle('is-empty', !v);
      btn.innerHTML = icon(v) + `<span class="mp-ipick-txt">${v ? dEsc(o.textContent) : 'Mode'}</span>`;
    };
    const close = () => dd.classList.remove('show');
    const open = () => {
      dd.innerHTML = [...modeSel.options].map((o, i) =>
        `<div class="team-dd-item${o.value === modeSel.value ? ' active' : ''}" data-i="${i}">${icon(o.value)}<span class="team-dd-name">${o.value ? dEsc(o.textContent) : 'No mode'}</span></div>`).join('');
      const r = btn.getBoundingClientRect();
      dd.style.left = r.left + 'px'; dd.style.top = (r.bottom + 4) + 'px'; dd.style.width = Math.max(r.width, 170) + 'px';
      dd.classList.add('show');
    };
    btn.addEventListener('click', () => (dd.classList.contains('show') ? close() : open()));
    btn.addEventListener('blur', () => setTimeout(close, 120));
    dd.addEventListener('mousedown', (e) => {
      const it = e.target.closest('.team-dd-item'); if (!it) return;
      e.preventDefault();
      const o = modeSel.options[Number(it.dataset.i)];
      if (o && modeSel.value !== o.value) { modeSel.value = o.value; modeSel.dispatchEvent(new Event('change', { bubbles: true })); }
      paint(); close();
    });
    window.addEventListener('scroll', () => { if (dd.classList.contains('show')) close(); }, { capture: true, passive: true });
    paint();
    return { box, paint };
  }
  function mpMapCombo(sel, pool) {
    const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const sorted = pool.slice().sort((a, b) => fold(a.name).localeCompare(fold(b.name)));
    // Same base as vmAsset(), inlined — that const is declared further down the file (TDZ on early render).
    const img = (p) => (p && p.startsWith('/') && location.protocol === 'file:' ? 'http://127.0.0.1:3000' + p : p || '');
    const box = document.createElement('div'); box.className = 'team-typeahead mp-map-combo';
    const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'input-text mp-map-search';
    inp.placeholder = 'Search maps…'; inp.autocomplete = 'off'; inp.spellcheck = false;
    const dd = document.createElement('div'); dd.className = 'team-dd'; dd.setAttribute('role', 'listbox');
    sel.style.display = 'none';
    box.appendChild(inp); box.appendChild(dd); box.appendChild(sel);
    const label = () => { const o = sel.options[sel.selectedIndex]; return o && o.value ? o.textContent : ''; };
    inp.value = label();
    let hits = [], active = 0;
    const draw = () => {
      const q = fold(inp.value.trim());
      // Opening on the current pick shows the whole list, not just that one map.
      hits = (!q || inp.value === label()) ? sorted : sorted.filter((p) => fold(p.name).includes(q) || fold(p.type).includes(q));
      active = Math.max(0, Math.min(active, hits.length - 1));
      dd.innerHTML = hits.length ? hits.map((p, i) =>
        `<div class="team-dd-item${i === active ? ' active' : ''}${p.id === sel.value ? ' is-current' : ''}" data-i="${i}">`
        + (p.image ? `<img class="team-dd-logo mp-map-thumb" src="${dEsc(img(p.image))}" alt="" onerror="this.style.visibility='hidden'">` : '')
        + `<span class="team-dd-name">${dEsc(p.name)}</span>`
        + (p.type ? `<span class="team-dd-tag">${dEsc(p.type)}</span>` : '') + '</div>').join('')
        : '<div class="team-dd-empty">No map matches</div>';
      const r = inp.getBoundingClientRect();
      dd.style.left = r.left + 'px'; dd.style.top = (r.bottom + 4) + 'px'; dd.style.width = Math.max(r.width, 240) + 'px';
      dd.classList.add('show');
      const a = dd.querySelector('.team-dd-item.active'); if (a) a.scrollIntoView({ block: 'nearest' });
    };
    const close = () => { dd.classList.remove('show'); inp.value = label(); };
    const choose = (p) => {
      if (!p) return;
      if (sel.value !== p.id) { sel.value = p.id; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      inp.value = label(); dd.classList.remove('show'); inp.blur();
    };
    inp.addEventListener('focus', () => { active = Math.max(0, sorted.findIndex((p) => p.id === sel.value)); inp.select(); draw(); });
    inp.addEventListener('input', () => { active = 0; draw(); });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, hits.length - 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); draw(); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(hits[active]); }
      else if (e.key === 'Escape') { close(); inp.blur(); }
    });
    // mousedown (not click) so the pick lands before the input's blur closes the list.
    dd.addEventListener('mousedown', (e) => {
      const it = e.target.closest('.team-dd-item'); if (!it) return;
      e.preventDefault(); choose(hits[Number(it.dataset.i)]);
    });
    inp.addEventListener('blur', () => setTimeout(close, 0));
    // The list is position:fixed — drop it if the panel scrolls out from under it.
    window.addEventListener('scroll', () => { if (dd.classList.contains('show')) close(); }, { capture: true, passive: true });
    return box;
  }
  function mpMinSlots(bo) { return Math.max(1, Math.ceil((Number(bo) || 5) / 2)); }   // maps needed to CLINCH
  function mpMaxSlots(bo) { return Math.max(1, Number(bo) || 5); }                    // can't exceed the format
  // count omitted → max(existing picks, the format's minimum). Pass it explicitly for Add/Remove/BO-change.
  // Inline icons, NOT svgIcon(): this IIFE renders at startup, before app.js reaches its ICON_SVG
  // table further down, and touching that const here throws a TDZ error that halts the whole panel.
  const MP_ICON_RESET = '<svg class="svg-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
  const MP_ICON_GRIP = '<svg class="svg-ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';
  const MP_ICON_REMOVE = '<svg class="svg-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  // One card per map, two lines:
  //   top    = number · map picture · map search · mode · remove
  //   bottom = who picked it (segmented) · score steppers per team · Draw · reset · result in words
  // The native <select>/<input> value stores keep their class names (mp-map-select, mp-mode-select,
  // mp-pick-by, mp-score-a/-b, mp-draw), so mpBuildMapsPayload and Clear scores read them as before.
  function mpRenderSlots(prefill, count) {
    const wrap = el('mp-slots'); if (!wrap) return;
    const bo = parseInt(el('mp-bestof')?.value, 10) || 5;
    const existing = prefill || [];
    const n = Math.max(1, Math.min(mpMaxSlots(bo), count != null ? count : Math.max(existing.length, mpMinSlots(bo))));
    const pool = mpMapPool();
    const _tms = (currentState && currentState.teams) || {};
    const _tA = (_tms.blue && _tms.blue.name) || 'Blue';
    const _tB = (_tms.orange && _tms.orange.name) || 'Orange';
    const _cA = (_tms.blue && _tms.blue.color) || '#3b82f6';
    const _cB = (_tms.orange && _tms.orange.color) || '#e97139';
    // No abbreviation set: initials for a multi-word name (Rocket Rush → RR), else the first letters.
    const autoTag = (n) => { const w = String(n || '').trim().split(/\s+/).filter(Boolean); return (w.length > 1 ? w.map((x) => x[0]).join('').slice(0, 4) : (w[0] || '').slice(0, 5)).toUpperCase(); };
    const tagA = ((_tms.blue && _tms.blue.abbr) || autoTag(_tA)).toUpperCase().slice(0, 6);
    const tagB = ((_tms.orange && _tms.orange.abbr) || autoTag(_tB)).toUpperCase().slice(0, 6);
    // Cards label themselves; the old column-heading row is not used.
    const headEl = el('mp-head'); if (headEl) { headEl.innerHTML = ''; headEl.hidden = true; }
    const modeOpts = mpModeOptions();
    const auto = mpAutoOn();
    const imgUrl = (p) => (p && p.startsWith('/') && location.protocol === 'file:' ? 'http://127.0.0.1:3000' + p : p || '');
    wrap.classList.toggle('is-auto', auto);
    wrap.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const m = existing[i] || {};
      const card = document.createElement('div'); card.className = 'mp-slot mp-card';
      card.style.setProperty('--mp-a', _cA); card.style.setProperty('--mp-b', _cB);

      // ── Top line ──
      const top = document.createElement('div'); top.className = 'mp-card-top';
      const grip = document.createElement('span'); grip.className = 'mp-drag'; grip.innerHTML = MP_ICON_GRIP;
      grip.title = 'Drag to change the order';
      const num = document.createElement('span'); num.className = 'mp-slot-num'; num.textContent = i + 1;
      const thumb = document.createElement('div'); thumb.className = 'mp-thumb';
      const sel = document.createElement('select'); sel.className = 'input-select mp-map-select';
      const curPool = mpFindPool(pool, m.name);
      sel.innerHTML = '<option value="">Select map</option>' +
        pool.map((p) => `<option value="${p.id}"${curPool && p.id === curPool.id ? ' selected' : ''}>${p.name}</option>`).join('');
      // A name that matches nothing in the pool (a series/start.gg map name, a custom stage) stays
      // on the card as its own option instead of silently blanking and being dropped on save.
      if (!curPool && m.name) {
        const o = document.createElement('option'); o.value = MP_CUSTOM + m.name; o.textContent = m.name + ' (custom)'; o.selected = true;
        sel.appendChild(o);
      }
      const modeSel = document.createElement('select'); modeSel.className = 'input-select mp-mode-select';
      modeSel.title = 'Game mode for this map';
      const modeVal = m.mode || (curPool && curPool.type) || '';
      modeSel.innerHTML = '<option value="">No mode</option>' +
        modeOpts.map((md) => `<option value="${md}"${md === modeVal ? ' selected' : ''}>${md}</option>`).join('');
      if (!modeSel.value && modeVal) { const o = document.createElement('option'); o.value = modeVal; o.textContent = modeVal; o.selected = true; modeSel.appendChild(o); }
      const modePick = mpModePick(modeSel);
      if (!modeOpts.length && !modeVal) modePick.box.hidden = true;   // this game has no modes
      const paintThumb = () => {
        const p = pool.find((x) => x.id === sel.value);
        const src = p && p.image ? imgUrl(p.image) : '';
        thumb.innerHTML = src ? `<img src="${dEsc(src)}" alt="" onerror="this.remove()">` : '';
        thumb.classList.toggle('is-empty', !src);
        if (!src) thumb.textContent = sel.value ? '' : 'Map';
      };
      modeSel.addEventListener('change', () => modePick.paint());
      sel.addEventListener('change', () => {
        const p = pool.find((x) => x.id === sel.value);
        if (p && p.type) { modeSel.value = p.type; modePick.paint(); }
        paintThumb();
      });
      paintThumb();
      const main = document.createElement('div'); main.className = 'mp-card-main';
      main.appendChild(mpMapCombo(sel, pool)); main.appendChild(modePick.box);
      const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'btn btn-ghost btn-xs mp-slot-rm';
      rm.innerHTML = MP_ICON_REMOVE; rm.title = 'Remove this map'; rm.disabled = n <= 1;
      rm.addEventListener('click', () => {
        const rows = mpBuildMapsPayload(true); rows.splice(i, 1);
        if (mpOwOn()) send('ow_remove_map', { idx: i });   // its bans go with it, later maps' bans shift up
        mpRenderSlots(rows, n - 1); mpSendDebounced();
      });
      top.appendChild(grip); top.appendChild(num); top.appendChild(thumb); top.appendChild(main); top.appendChild(rm);

      // ── Bottom line: picked by ──
      const bottom = document.createElement('div'); bottom.className = 'mp-card-bottom';
      const pick = document.createElement('select'); pick.className = 'mp-pick-by'; pick.hidden = true;
      pick.innerHTML = '<option value=""></option><option value="a"></option><option value="b"></option><option value="decider"></option>';
      pick.value = m.action === 'decider' ? 'decider' : (m.by === 'a' || m.by === 'b') ? m.by : '';
      const pickSeg = document.createElement('div'); pickSeg.className = 'mp-seg'; pickSeg.setAttribute('role', 'group');
      pickSeg.setAttribute('aria-label', 'Picked by');
      const pickLbl = document.createElement('span'); pickLbl.className = 'mp-lbl'; pickLbl.textContent = 'Picked by';
      [['a', tagA, _cA, _tA + ' picked this map'], ['b', tagB, _cB, _tB + ' picked this map'], ['decider', 'Decider', '', 'Decider map (nobody picked it)']].forEach(([v, txt, col, tip]) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'mp-seg-btn'; b.dataset.v = v;
        b.textContent = txt; b.title = tip; if (col) b.style.setProperty('--seg', col);
        b.addEventListener('click', () => {
          pick.value = pick.value === v ? '' : v;   // clicking the active choice clears it
          paintPick(); pick.dispatchEvent(new Event('change', { bubbles: true }));
        });
        pickSeg.appendChild(b);
      });
      const paintPick = () => pickSeg.querySelectorAll('.mp-seg-btn').forEach((b) => b.classList.toggle('is-on', b.dataset.v === pick.value));
      paintPick();
      const pickBox = document.createElement('div'); pickBox.className = 'mp-pickbox';
      pickBox.appendChild(pickLbl); pickBox.appendChild(pickSeg); pickBox.appendChild(pick);

      // ── Bottom line: result ──
      const mkScore = (cls, val, team, color) => {
        const box = document.createElement('div'); box.className = 'mp-step';
        box.style.setProperty('--team', color);
        const tag = document.createElement('span'); tag.className = 'mp-step-tag'; tag.textContent = team;
        const minus = document.createElement('button'); minus.type = 'button'; minus.className = 'mp-step-btn'; minus.textContent = '−'; minus.title = 'One less';
        const inp = document.createElement('input'); inp.type = 'number'; inp.min = '0'; inp.className = 'input-text ' + cls;
        inp.placeholder = '–'; inp.value = val || ''; inp.title = team + ' score';
        const plus = document.createElement('button'); plus.type = 'button'; plus.className = 'mp-step-btn'; plus.textContent = '+'; plus.title = 'One more';
        const bump = (d) => {
          if (inp.readOnly) return;
          const cur = parseInt(inp.value, 10);
          const next = Math.max(0, (isNaN(cur) ? 0 : cur) + d);
          inp.value = String(next);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        };
        minus.addEventListener('click', () => bump(-1)); plus.addEventListener('click', () => bump(1));
        if (auto) { inp.readOnly = true; minus.disabled = true; plus.disabled = true; inp.title += ' (from the series editor)'; }
        const ctl = document.createElement('div'); ctl.className = 'mp-step-ctl';
        ctl.appendChild(minus); ctl.appendChild(inp); ctl.appendChild(plus);
        box.appendChild(tag); box.appendChild(ctl);
        return { box, inp };
      };
      const A = mkScore('mp-score-a', m.score && m.score.a, tagA, _cA);
      const B = mkScore('mp-score-b', m.score && m.score.b, tagB, _cB);
      const sep = document.createElement('span'); sep.className = 'mp-sep'; sep.textContent = '–';
      // A drawn map (Overwatch escort/hybrid can end level, 0-0 included) — scores alone can't say
      // "played, nobody won", so it's an explicit toggle. It wins over the scores when on.
      const draw = document.createElement('button'); draw.type = 'button'; draw.className = 'btn btn-ghost btn-xs mp-draw';
      draw.textContent = 'Draw'; draw.title = 'Mark this map as a draw';
      const setDraw = (on) => { draw.classList.toggle('is-on', on); draw.setAttribute('aria-pressed', on ? 'true' : 'false'); };
      setDraw(m.winner === 'draw');
      const clr = document.createElement('button'); clr.type = 'button'; clr.className = 'btn btn-ghost btn-xs mp-score-clr';
      clr.innerHTML = MP_ICON_RESET; clr.title = 'Back to not played (clears the score and draw)';
      const result = document.createElement('span'); result.className = 'mp-result-txt';
      // The card says in words what the overlay will show, and its edge takes the winner's colour.
      const paintResult = () => {
        const a = parseInt(A.inp.value, 10), b = parseInt(B.inp.value, 10);
        const has = !isNaN(a) || !isNaN(b);
        const sa = isNaN(a) ? 0 : a, sb = isNaN(b) ? 0 : b;
        let state = 'none', txt = 'Not played yet';
        if (draw.classList.contains('is-on')) { state = 'draw'; txt = `Draw ${sa}–${sb}`; }
        else if (has && sa !== sb) { state = sa > sb ? 'a' : 'b'; txt = `${sa > sb ? tagA : tagB} won ${Math.max(sa, sb)}–${Math.min(sa, sb)}`; }
        else if (has) { txt = `Level ${sa}–${sb}: press Draw if it ended that way`; }
        card.dataset.result = state;
        result.textContent = txt;
        clr.disabled = !(has || state === 'draw');
      };
      clr.addEventListener('click', () => {
        A.inp.value = ''; B.inp.value = ''; setDraw(false); paintResult();
        if (mpAutoOn()) mpClearSeriesScores(i);
        mpSendDebounced();
      });
      draw.addEventListener('click', () => { setDraw(!draw.classList.contains('is-on')); paintResult(); mpSendDebounced(); });
      [A.inp, B.inp].forEach((inp) => inp.addEventListener('input', paintResult));
      paintResult();
      const res = document.createElement('div'); res.className = 'mp-resultbox';
      res.appendChild(A.box); res.appendChild(sep); res.appendChild(B.box); res.appendChild(draw); res.appendChild(clr);
      bottom.appendChild(pickBox); bottom.appendChild(res);

      [sel, modeSel, pick, A.inp, B.inp].forEach((inp) => { inp.addEventListener('input', mpSendDebounced); inp.addEventListener('change', mpSendDebounced); });
      card.appendChild(top); card.appendChild(bottom);
      const bans = mpBansRow(i, { tagA, tagB, _cA, _cB, imgUrl });
      if (bans) card.appendChild(bans);
      card.appendChild(result);
      wrap.appendChild(card);
    }
    const max = mpMaxSlots(bo);
    const addBtn = el('mp-add-slot');
    if (addBtn) {
      addBtn.style.display = '';
      addBtn.disabled = n >= max;
      addBtn.title = n >= max ? `A best of ${bo} has at most ${max} map${max === 1 ? '' : 's'}` : 'Add another map at the end';
    }
    const cnt = el('mp-count'); if (cnt) cnt.textContent = `${n} of ${max}`;
    const hint = el('mp-drag-hint'); if (hint) hint.hidden = n < 2;
    // Drag a card by its handle to reorder. The list element survives re-renders (only its
    // children are replaced), so the Sortable is created once and kept.
    if (typeof Sortable !== 'undefined' && !wrap._mpSortable) {
      wrap._mpSortable = Sortable.create(wrap, {
        animation: 150, draggable: '.mp-card', handle: '.mp-drag', ghostClass: 'mp-card-ghost', chosenClass: 'mp-card-chosen',
        onStart: () => { wrap._mpDragging = true; },
        onEnd: (e) => {
          wrap._mpDragging = false;
          if (e.oldIndex === e.newIndex) return;
          const rows = mpBuildMapsPayload(true);   // DOM order = the new order
          if (mpAutoOn()) mpReorderSeries(e.oldIndex, e.newIndex);
          if (mpOwOn()) send('ow_move_map', { from: e.oldIndex, to: e.newIndex });   // bans travel with their map
          mpRenderSlots(rows, rows.length);
          mpSendDebounced();
        }
      });
    }
    if (wrap._mpSortable) wrap._mpSortable.option('disabled', n < 2);
    // Compact cards when the list is narrow (Modern puts the editor beside the preview, and the Live
    // dock narrows it further). Container queries are not available in this Chromium, so measure.
    if (!wrap._mpRO && typeof ResizeObserver === 'function') {
      wrap._mpRO = new ResizeObserver(() => wrap.classList.toggle('is-narrow', wrap.clientWidth > 0 && wrap.clientWidth < 520));
      wrap._mpRO.observe(wrap);
    }
    wrap.classList.toggle('is-narrow', wrap.clientWidth > 0 && wrap.clientWidth < 520);
  }
  // ── Overwatch hero bans, per map card ──
  // Bans live in owMatch.bansByMap[mapIndex] ({a:[{hero,role},…], b:[…]}). Pick / Ban writes them
  // to the map the scoreboard's game number points at; here they are set on the map itself, so the
  // order you do things in no longer matters. The card Pick / Ban is writing to is labelled.
  function mpOwOn() { return !!(currentState && currentState.activeGame === 'overwatch'); }
  function mpBanArr(entry, side) {
    const v = entry && entry[side];
    return Array.isArray(v) ? v : (v && v.hero ? [v] : []);
  }
  function mpBansRow(i, t) {
    if (!mpOwOn()) return null;
    const heroes = ((currentState.draftRosters || {}).overwatch || []).slice().sort((x, y) => String(x.name).localeCompare(String(y.name)));
    const entry = (((currentState.owMatch || {}).bansByMap) || [])[i] || {};
    const perTeam = (((currentState.draft || {}).owBanCount) || 2) >= 4 ? 2 : 1;
    const liveIdx = Math.max(0, (((currentState.game || {}).number) || 1) - 1);
    const row = document.createElement('div'); row.className = 'mp-bans';
    const lbl = document.createElement('span'); lbl.className = 'mp-lbl'; lbl.textContent = 'Hero bans';
    row.appendChild(lbl);
    const heroByName = (n) => heroes.find((h) => String(h.name).toLowerCase() === String(n || '').toLowerCase());
    [['a', t.tagA, t._cA], ['b', t.tagB, t._cB]].forEach(([side, tag, col]) => {
      const team = document.createElement('div'); team.className = 'mp-ban-team'; team.style.setProperty('--team', col);
      const tg = document.createElement('span'); tg.className = 'mp-ban-tag'; tg.textContent = tag;
      team.appendChild(tg);
      const cur = mpBanArr(entry, side);
      const slots = Math.max(perTeam, cur.filter((b) => b && b.hero).length);
      for (let s = 0; s < slots; s++) {
        const ban = cur[s] && cur[s].hero ? cur[s] : null;
        const b = document.createElement('button'); b.type = 'button'; b.className = 'mp-ban' + (ban ? ' is-set' : '');
        if (ban) {
          const h = heroByName(ban.hero);
          b.innerHTML = (h && h.image ? `<img src="${dEsc(t.imgUrl(h.image))}" alt="" onerror="this.remove()">` : '')
            + `<span>${dEsc(ban.hero)}</span><i class="mp-ban-x" title="Remove this ban">×</i>`;
          b.title = `${tag} banned ${ban.hero}. Click to change it.`;
        } else {
          b.innerHTML = '<span>+ Ban</span>'; b.title = `Add a ${tag} hero ban for this map`;
        }
        b.addEventListener('click', (e) => {
          if (e.target.closest('.mp-ban-x')) { send('ow_ban_hero', { mapIdx: i, side, slot: s, hero: '' }); return; }
          mpOpenBanPicker(row, heroes, t.imgUrl, (h) => send('ow_ban_hero', { mapIdx: i, side, slot: s, hero: h.name, role: h.role || '' }));
        });
        team.appendChild(b);
      }
      row.appendChild(team);
    });
    if (i === liveIdx) {
      const live = document.createElement('span'); live.className = 'mp-ban-live';
      live.textContent = 'Pick / Ban is on this map';
      live.title = 'Pick / Ban records bans on the map matching the scoreboard\'s game number (game ' + (liveIdx + 1) + ').';
      row.appendChild(live);
    }
    return row;
  }
  // Inline hero search under a card's bans line. It lives INSIDE the card, so while its search box
  // has focus the editor does not re-render under it (mpSyncFromState skips while #mp-slots has focus).
  function mpOpenBanPicker(row, heroes, imgUrl, onPick) {
    document.querySelectorAll('.mp-ban-picker').forEach((p) => p.remove());
    const box = document.createElement('div'); box.className = 'mp-ban-picker';
    const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'input-text'; inp.placeholder = 'Search heroes';
    inp.autocomplete = 'off'; inp.spellcheck = false;
    const grid = document.createElement('div'); grid.className = 'mp-ban-grid';
    const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const draw = () => {
      const q = fold(inp.value.trim());
      const hits = heroes.filter((h) => !q || fold(h.name).includes(q) || fold(h.role).includes(q));
      grid.innerHTML = hits.length ? hits.map((h, k) => `<button type="button" class="mp-ban-hero" data-k="${heroes.indexOf(h)}" title="${dEsc(h.name)}${h.role ? ' · ' + dEsc(h.role) : ''}">`
        + (h.image ? `<img src="${dEsc(imgUrl(h.image))}" alt="" loading="lazy">` : '') + `<span>${dEsc(h.name)}</span></button>`).join('')
        : '<div class="mp-ban-none">No hero matches</div>';
    };
    const close = () => box.remove();
    grid.addEventListener('mousedown', (e) => {
      const b = e.target.closest('.mp-ban-hero'); if (!b) return;
      e.preventDefault();
      const h = heroes[Number(b.dataset.k)]; close(); if (h) onPick(h);
    });
    inp.addEventListener('input', draw);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter') { const first = grid.querySelector('.mp-ban-hero'); if (first) { const h = heroes[Number(first.dataset.k)]; close(); if (h) onPick(h); } }
    });
    inp.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== inp) close(); }, 150));
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-ghost btn-xs'; cancel.textContent = 'Cancel';
    cancel.addEventListener('mousedown', (e) => { e.preventDefault(); close(); });
    const head = document.createElement('div'); head.className = 'mp-ban-picker-head'; head.appendChild(inp); head.appendChild(cancel);
    box.appendChild(head); box.appendChild(grid);
    row.after(box);
    draw();
    inp.focus();
  }
  // With Auto from Series on, the pool mirrors the series editor BY POSITION, so a reorder here has
  // to move the series editor's maps too, or the next sync would put the scores back on the wrong maps.
  function mpReorderSeries(from, to) {
    const src = ((currentState && currentState.match && currentState.match.maps) || []).slice();
    if (from >= src.length) return;
    const [moved] = src.splice(from, 1);
    src.splice(Math.min(to, src.length), 0, moved);
    send('set_match', { maps: src.map((m) => ({ name: (m && m.name) || '', scoreA: (m && m.scoreA) || 0, scoreB: (m && m.scoreB) || 0, played: !!(m && m.played) })) });
  }
  // keepBlanks=true preserves unselected slots (needed so Add/Remove/BO-change re-render at the
  // exact right index) — the version actually SENT to the server always filters them out.
  function mpBuildMapsPayload(keepBlanks) {
    const wrap = el('mp-slots'); if (!wrap) return [];
    const pool = mpMapPool();
    const rows = [...wrap.querySelectorAll('.mp-slot')].map((row) => {
      const sel = row.querySelector('.mp-map-select');
      const p = pool.find((x) => x.id === sel.value);
      const a = parseInt(row.querySelector('.mp-score-a').value, 10);
      const b = parseInt(row.querySelector('.mp-score-b').value, 10);
      const hasScore = !isNaN(a) || !isNaN(b);
      const sa = isNaN(a) ? 0 : a, sb = isNaN(b) ? 0 : b;
      // Pick attribution — same action/by fields the guided veto writes, so the
      // mapscreen overlay shows its "TEAM PICK" / "DECIDER" chips.
      const pk = (row.querySelector('.mp-pick-by') || {}).value || '';
      const modeOverride = (row.querySelector('.mp-mode-select') || {}).value || '';
      const drawBtn = row.querySelector('.mp-draw');
      const isDraw = !!(drawBtn && drawBtn.classList.contains('is-on'));
      // Free-text row (a map name with no pool entry) — keep the name, no art.
      const custom = sel.value.startsWith(MP_CUSTOM) ? sel.value.slice(MP_CUSTOM.length) : '';
      if (!p && custom) {
        return {
          name: custom, image: '', mode: modeOverride,
          action: pk === 'decider' ? 'decider' : 'pick',
          by: (pk === 'a' || pk === 'b') ? pk : '',
          winner: isDraw ? 'draw' : (hasScore && sa !== sb) ? (sa > sb ? 'a' : 'b') : '',
          score: { a: sa, b: sb }
        };
      }
      return {
        // mode falls back to the pool entry's `type` (intrinsic map data, e.g. Overwatch's
        // Control/Hybrid) — never to `tier`, which is only a ruleset hint for the veto.
        name: p ? p.name : '', image: p ? (p.image || '') : '', mode: modeOverride || (p ? (p.type || '') : ''),
        action: pk === 'decider' ? 'decider' : 'pick',
        by: (pk === 'a' || pk === 'b') ? pk : '',
        winner: isDraw ? 'draw' : (hasScore && sa !== sb) ? (sa > sb ? 'a' : 'b') : '',
        score: { a: sa, b: sb }
      };
    });
    return keepBlanks ? rows : rows.filter((m) => m.name);   // sent payload skips unselected slots
  }
  const mpSendDebounced = debounce(() => {
    send('set_veto', { title: (el('mp-title')?.value || '').trim(), maps: mpBuildMapsPayload() });
  }, 350);
  el('mp-add-slot')?.addEventListener('click', () => {
    const cur = mpBuildMapsPayload(true);
    mpRenderSlots(cur, cur.length + 1);
    mpSendDebounced();
  });
  el('mp-bestof')?.addEventListener('change', () => {
    // Keep whatever's already picked (capped to the new format's max); re-derive the slot count
    // from that, not a hard reset — switching Bo5→Bo7 shouldn't erase the 3 maps already entered.
    const bo = parseInt(el('mp-bestof')?.value, 10) || 5;
    const capped = mpBuildMapsPayload(true).slice(0, mpMaxSlots(bo));
    mpRenderSlots(capped, Math.max(mpMinSlots(bo), capped.length));
    mpSendDebounced();
    // Map Pool's best-of IS the series format — write it to the same global state.bestOf the
    // Series panel/scoreboard already use, so the lower third knows the real series length
    // even when only some of the maps have been entered yet.
    send('set_best_of', { value: bo });
  });
  el('mp-title')?.addEventListener('input', mpSendDebounced);
  el('btn-veto-front-open')?.addEventListener('click', () => openGfxPopout('veto'));
  // Populate from current state when the Map Pool tab opens. Best-of drives the MAX/starting
  // count, but the actual slot count shown is whatever's already saved (or that format's minimum
  // if nothing's picked yet) — never force it down to a stale best-of-derived count.
  // One click pulls the series editor's maps + scores (Match — Teams) into the pool. Existing
  // pick attribution / mode per slot survives — only the map name and score come across.
  function mpPullSeries(quiet) {
    const match = (currentState && currentState.match) || {};
    const maps = Array.isArray(match.maps) ? match.maps.filter((m) => m && (m.name || m.scoreA || m.scoreB)) : [];
    if (!maps.length) {
      if (!quiet) showToast('No maps in the series editor yet — set them in Match — Teams.', '#fbbf24');
      return 0;
    }
    const fmtN = parseInt(String(match.format || '').replace(/\D/g, ''), 10);
    const boSel = el('mp-bestof');
    if (boSel && fmtN && [...boSel.options].some((o) => +o.value === fmtN)) boSel.value = String(fmtN);
    const cur = mpBuildMapsPayload(true);
    const prefill = maps.map((m, i) => {
      const keep = cur[i] || {};
      const a = Math.max(0, Number(m.scoreA) || 0), b = Math.max(0, Number(m.scoreB) || 0);
      return {
        name: m.name || keep.name || '', mode: keep.mode || '',
        action: keep.action || 'pick', by: keep.by || '',
        winner: keep.winner === 'draw' ? 'draw' : (a !== b && (a || b)) ? (a > b ? 'a' : 'b') : '',
        score: { a, b }
      };
    });
    mpRenderSlots(prefill, Math.max(prefill.length, cur.length, 1));
    mpSendDebounced();
    return prefill.length;
  }
  el('mp-from-series')?.addEventListener('click', () => {
    const n = mpPullSeries();
    if (n) showToast('Pulled ' + n + ' map(s) from the series editor', '#22c55e');
  });

  // ── Auto from Series ──────────────────────────────────────────────────────
  // Match — Teams is the score of record for the series; with this on, the pool rows mirror it
  // live (by slot index — map 3 is map 3 whatever it's called) so nobody has to enter a result
  // twice. Off by default; the choice is remembered.
  const MP_AUTO_KEY = 'ne_mp_auto_series_v1';
  function mpAutoOn() { return !!el('mp-auto-series')?.checked; }
  const autoBox = el('mp-auto-series');
  if (autoBox) {
    try { autoBox.checked = localStorage.getItem(MP_AUTO_KEY) === '1'; } catch (e) {}
    autoBox.addEventListener('change', () => {
      try { localStorage.setItem(MP_AUTO_KEY, autoBox.checked ? '1' : '0'); } catch (e) {}
      if (autoBox.checked) mpPullSeries(true);
      else mpRenderSlots(mpBuildMapsPayload(true));     // re-render to unlock the score fields
      showToast(autoBox.checked ? 'Scores now follow the series editor' : 'Scores are manual again', '#38bdf8');
    });
  }
  // Merge state.match.maps into the pool rows by index. Returns the merged list + whether
  // anything actually moved (so we only push to the server on a real change, never in a loop).
  function mpMergeSeries(maps, data) {
    const src = ((data && data.match && data.match.maps) || []).filter((m) => m);
    if (!src.length) return { maps, changed: false };
    const out = maps.map((m) => ({ ...m, score: { a: (m.score && m.score.a) || 0, b: (m.score && m.score.b) || 0 } }));
    let changed = false;
    src.forEach((s, i) => {
      // A slot with no map name either side is dropped by the send payload — merging it would
      // mark "changed" on every broadcast and push forever, so skip it entirely.
      const name = (out[i] && out[i].name) || s.name || '';
      if (!name) return;
      if (!out[i]) { out[i] = { name, mode: '', action: 'pick', by: '', winner: '', score: { a: 0, b: 0 } }; changed = true; }
      const cur = out[i];
      const a = Math.max(0, Number(s.scoreA) || 0), b = Math.max(0, Number(s.scoreB) || 0);
      if (!cur.name && s.name) { cur.name = s.name; changed = true; }
      if (cur.score.a !== a || cur.score.b !== b) { cur.score = { a, b }; changed = true; }
      const win = cur.winner === 'draw' ? 'draw' : (a !== b && (a || b)) ? (a > b ? 'a' : 'b') : '';   // a draw is set by hand, the series editor has no draw
      if ((cur.winner || '') !== win) { cur.winner = win; changed = true; }
    });
    return { maps: out, changed };
  }
  // Blank one (or every) series-editor row so a cleared score doesn't come straight back from Auto.
  function mpClearSeriesScores(idx) {
    const src = ((currentState && currentState.match && currentState.match.maps) || []);
    if (!src.length) return;
    send('set_match', {
      maps: src.map((m, i) => (idx == null || i === idx)
        ? { name: m.name || '', scoreA: 0, scoreB: 0, played: false }
        : { name: m.name || '', scoreA: m.scoreA || 0, scoreB: m.scoreB || 0, played: !!m.played })
    });
  }
  // Blank every map's score, keeping the maps, modes and pick attribution.
  el('mp-clear-scores')?.addEventListener('click', () => {
    const rows = [...(el('mp-slots')?.querySelectorAll('.mp-slot') || [])];
    if (!rows.some((r) => r.querySelector('.mp-score-a').value || r.querySelector('.mp-score-b').value || r.querySelector('.mp-draw.is-on'))) {
      showToast('No scores to clear', '#fbbf24'); return;
    }
    // Each card's own reset clears its score AND draw and repaints its result line.
    rows.forEach((r) => { const c = r.querySelector('.mp-score-clr'); if (c && !c.disabled) c.click(); });
    if (mpAutoOn()) mpClearSeriesScores(null);
    mpSendDebounced();
    showToast('Cleared every map score', '#22c55e');
  });

  // Clear the whole map list in one go (maps, picks, scores). With Auto from Series on, the series
  // editor's maps go too, or the merge would put every name straight back.
  el('mp-clear-maps')?.addEventListener('click', async () => {
    const n = mpBuildMapsPayload().length;
    if (!n) { showToast('No maps to clear', '#fbbf24'); return; }
    if (!await customConfirm('Clear maps', `Remove all ${n} map${n === 1 ? '' : 's'} from the series, with their picks and scores?`, 'Clear maps')) return;
    if (mpAutoOn()) send('set_match', { maps: [] });
    send('set_veto', { title: (el('mp-title')?.value || '').trim(), maps: [] });
    const bo = parseInt(el('mp-bestof')?.value, 10) || 5;
    mpRenderSlots([], mpMinSlots(bo));
    showToast('Cleared the map list', '#22c55e');
  });

  function mpSyncFromState(data) {
    const v = (data && data.veto) || {};
    const titleEl = el('mp-title');
    if (titleEl && document.activeElement !== titleEl) titleEl.value = (v.title && v.title !== 'MAP POOL') ? v.title : '';
    const maps = Array.isArray(v.maps) ? v.maps : [];
    const boSel = el('mp-bestof');
    if (boSel && document.activeElement !== boSel) boSel.value = String((data && data.bestOf) || 5);
    if (document.activeElement?.closest('#mp-slots') == null && !el('mp-slots')?._mpDragging) {
      // Blank slots aren't in the saved payload, so a plain broadcast would otherwise wipe the
      // empty slot the producer just added with "+ Add map". Never shrink below the current count.
      const bo = parseInt(boSel?.value, 10) || 5;
      const curCount = el('mp-slots')?.querySelectorAll('.mp-slot').length || 0;
      // Auto from Series: fold the series editor's scores in before rendering, and push the
      // result on only if it actually differs from what's saved (so this can't loop).
      let rows = maps, push = false;
      if (mpAutoOn()) { const merged = mpMergeSeries(maps, data); rows = merged.maps; push = merged.changed; }
      mpRenderSlots(rows, Math.max(rows.length, curCount, mpMinSlots(bo)));
      if (push) mpSendDebounced();
    }
    if (typeof window._gfxRefreshVetoSeriesLink === 'function') window._gfxRefreshVetoSeriesLink(data);
  }
  // Exposed so the front-panel live-refresh hook (outside this IIFE) can reach it.
  window._gfxSyncVetoFront = mpSyncFromState;

  // Series overlay (series.html) reads state.veto.maps directly once any pick/decider lands —
  // same condition it uses client-side — so producers can see right here whether it's linked yet.
  window._gfxRefreshVetoSeriesLink = function (data) {
    const statusEl = el('mp-series-link-status'); if (!statusEl) return;
    const maps = ((data && data.veto && data.veto.maps) || []).filter((m) => m.action === 'pick' || m.action === 'decider');
    if (maps.length) { statusEl.textContent = `Linked — ${maps.length} map${maps.length > 1 ? 's' : ''} picked`; statusEl.style.color = '#4ade80'; }
    else { statusEl.textContent = 'Not linked yet — showing the manual Series editor until a map is picked'; statusEl.style.color = 'var(--muted)'; }
  };

  // Ticker — hide (push uses the existing btn-ticker-apply).
  gfxAction('hide', 'ticker', () => send('set_ticker', { visible: false }), 'btn-hide-ticker');

  // Draft — show/hide the champion draft overlay.
  gfxAction('show', 'draft', () => send('draft_visible', { visible: true }), 'btn-show-draft');
  gfxAction('hide', 'draft', () => send('draft_visible', { visible: false }), 'btn-hide-draft');

  // Spotlight — route push to the active mode (Teams to Watch vs Team Spotlight).
  gfxAction('show', 'spotlight', () => {
    const mode = (typeof _spMode !== 'undefined' ? _spMode : 'watch');
    if (mode === 'solo') send('set_team_spotlight', { visible: true });
    else send('set_watchlist', { visible: true });
  }, 'btn-show-spotlight');
  gfxAction('hide', 'spotlight', () => {
    send('set_watchlist', { visible: false });
    send('set_team_spotlight', { visible: false });
  }, 'btn-hide-spotlight');


  // Bracket — show/hide the bracket overlay.
  gfxAction('show', 'bracket', () => send('set_bracket_settings', { visible: true }), 'btn-show-bracket');
  gfxAction('hide', 'bracket', () => send('set_bracket_settings', { visible: false }), 'btn-hide-bracket');

  // Real-time preview: debounced auto-push on field change.
  function debounce(fn, ms) { let t; return function() { clearTimeout(t); t = setTimeout(fn, ms); }; }

  const doBreakPreview = debounce(() => {
    if (typeof send !== 'function' || typeof getBreakTitle !== 'function') return;
    send('set_break', { title: getBreakTitle(), message: (el('input-break-message')?.value || '').trim() });
  }, 350);
  ['select-break-preset', 'input-break-title', 'input-break-message'].forEach((id) => {
    el(id)?.addEventListener('input', doBreakPreview);
    el(id)?.addEventListener('change', doBreakPreview);
  });

  function _winnerNameFromSel(sel) {
    if (!sel || sel === 'blue' || sel === 'orange') return '';
    if (sel === '__custom__') return (el('input-winner-name')?.value || '').trim();
    if (sel.startsWith('__saved_')) {
      const idx = parseInt(sel.replace('__saved_', ''), 10);
      const t = currentState && currentState.savedTeams && currentState.savedTeams[idx];
      return t ? (t.name || '') : '';
    }
    return '';
  }
  window._winnerNameFromSel = _winnerNameFromSel;   // winnerPayload() (Show button) lives outside this block
  const doWinnerPreview = debounce(() => {
    if (typeof send !== 'function') return;
    const sel = el('select-winner-side')?.value || 'blue';
    const subtitle = (el('input-winner-subtitle')?.value || '').trim();
    const isSide = sel === 'blue' || sel === 'orange';
    send('set_winner', isSide ? { side: sel, name: '', subtitle } : { side: '', name: _winnerNameFromSel(sel), subtitle });
  }, 350);
  ['select-winner-side', 'input-winner-name', 'input-winner-subtitle'].forEach((id) => {
    el(id)?.addEventListener('input', doWinnerPreview);
    el(id)?.addEventListener('change', doWinnerPreview);
  });
  // Once the producer types their own subtitle, stop auto-suggesting the series score into it.
  el('input-winner-subtitle')?.addEventListener('input', () => { if (window._winnerAuto) window._winnerAuto.subTouched = true; });

  const doIntroPreview = debounce(() => {
    if (typeof send !== 'function') return;
    send('set_intro', { side: el('select-intro-side')?.value || 'blue', title: (el('input-intro-title')?.value || '').trim(), showFooter: el('check-intro-footer') ? !!el('check-intro-footer').checked : false, showRealName: el('check-intro-realname') ? !!el('check-intro-realname').checked : false, showBench: el('check-intro-bench') ? !!el('check-intro-bench').checked : true });
  }, 350);
  ['select-intro-side', 'input-intro-title'].forEach((id) => {
    el(id)?.addEventListener('input', doIntroPreview);
    el(id)?.addEventListener('change', doIntroPreview);
  });
  ['check-intro-footer', 'check-intro-realname', 'check-intro-bench'].forEach((id) => {
    el(id)?.addEventListener('change', doIntroPreview);
  });

  // ── Series panel: format pills, stage field, map grid ───────────────────
  document.querySelectorAll('#gfx-ser-format .gfx-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      const bo = parseInt(btn.dataset.bo, 10);
      const maps = ((currentState && currentState.match) || {}).maps || [];
      while (maps.length < bo) maps.push({ name: '', scoreA: 0, scoreB: 0, played: false });
      maps.length = bo;
      send('set_best_of', { value: bo });
      send('set_match', { maps });
    });
  });
  el('gfx-ser-division')?.addEventListener('change', function () { send('set_match', { division: this.value.trim() }); });
  el('gfx-ser-division')?.addEventListener('keydown', function (e) { if (e.key === 'Enter') this.blur(); });
  el('gfx-ser-reset')?.addEventListener('click', async () => { if (await appConfirm('Reset series to 0-0?', 'Reset')) send('reset_series', {}); });

  // ── Series Stats (Rocket League) ──
  // Push/clear go through the standard btn-show-/btn-hide-<key> pair so doPush() and the top bar
  // drive this scene exactly like every other one.
  gfxAction('show', 'seriesstats', () => send('set_series_stats', { visible: true }), 'btn-show-seriesstats');
  gfxAction('hide', 'seriesstats', () => send('set_series_stats', { visible: false }), 'btn-hide-seriesstats');
  // Both copies of the opt-in write the same field; the server is the single source of truth and
  // the next full_state re-hydrates whichever copy the producer did not touch.
  ['chk-series-stats', 'gfx-ss-enabled'].forEach((id) => {
    el(id)?.addEventListener('change', function () { send('set_series_stats', { enabled: this.checked }); });
  });
  el('sel-series-stats-design')?.addEventListener('change', function () { send('set_series_stats', { design: this.value }); });
  document.querySelectorAll('#gfx-ss-design .gfx-pill').forEach((btn) => {
    btn.addEventListener('click', () => send('set_series_stats', { design: btn.dataset.ssd }));
  });
  // Winner reveal design. Sent WITHOUT a side/name so picking a look never fires a winner on air.
  document.querySelectorAll('#gfx-winner-style .gfx-pill').forEach((btn) => {
    btn.addEventListener('click', () => send('set_winner', { style: btn.dataset.wstyle }));
  });
  // Destructive: throws away the banked games. Confirmed, and worded so it is clear the series
  // SCORE is untouched (that is reset_series, a different button).
  const _ssReset = async () => {
    if (await appConfirm('Throw away the player stats cached for this series? The series score is not affected.', 'Reset cache')) {
      send('set_series_stats', { clear: true });
    }
  };
  el('gfx-ss-reset')?.addEventListener('click', _ssReset);
  el('btn-mt-series-stats-reset')?.addEventListener('click', _ssReset);
  el('btn-mt-series-stats-push')?.addEventListener('click', () => {
    if (typeof window._gfxDoPush === 'function') window._gfxDoPush('seriesstats');
    else send('set_series_stats', { visible: true });   // rail not initialised yet — at least air it
  });
  // The server drives gfxActive for this scene (setExclusiveGfxVisible), so the client just asks.
  el('btn-mt-series-stats-hide')?.addEventListener('click', () => send('set_series_stats', { visible: false }));

  function gfxCollectSeriesMaps() {
    return [...(el('gfx-ser-maps') || { querySelectorAll: () => [] }).querySelectorAll('.gfx-ser-map-row')].map((row) => ({
      name: row.querySelector('.gfx-ser-map-name')?.value || '',
      scoreA: parseInt(row.querySelector('.gfx-ser-map-sa')?.value) || 0,
      scoreB: parseInt(row.querySelector('.gfx-ser-map-sb')?.value) || 0,
      played: !!row.querySelector('.gfx-ser-map-pl')?.checked
    }));
  }

  // When the Map Pool has picked/decider maps, the Series overlay renders THOSE (same data,
  // different style) — so the Series editor shows them read-only instead of a second grid the
  // producer would fill in twice. "Enter manually" is the escape hatch for a Series-only board.
  let _serManualOverride = false;
  function _serVetoPicks() {
    return (((currentState && currentState.veto) || {}).maps || [])
      .filter((m) => m.action === 'pick' || m.action === 'decider');
  }
  function _serEnsureBanner() {
    let b = el('gfx-ser-link-banner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'gfx-ser-link-banner';
      b.style.cssText = 'display:none; align-items:center; gap:8px; flex-wrap:wrap; background:rgba(74,222,128,0.08); border:1px solid rgba(74,222,128,0.35); border-radius:8px; padding:8px 10px; margin-bottom:8px; font-size:12px;';
      const head = el('gfx-ser-maps')?.previousElementSibling; // the .gfx-ser-map-head
      const wrap = el('gfx-ser-maps');
      if (head && head.parentNode) head.parentNode.insertBefore(b, head);
      else if (wrap && wrap.parentNode) wrap.parentNode.insertBefore(b, wrap);
    }
    return b;
  }

  function gfxRenderSeriesMaps(maps, teams) {
    const wrap = el('gfx-ser-maps'); if (!wrap) return;
    const blueN = (teams && teams.blue && teams.blue.name) || 'A';
    const orgN  = (teams && teams.orange && teams.orange.name) || 'B';
    const colA = el('gfx-ser-col-a'), colB = el('gfx-ser-col-b');
    if (colA) colA.textContent = blueN.length > 8 ? blueN.slice(0, 8) + '…' : blueN;
    if (colB) colB.textContent = orgN.length > 8 ? orgN.slice(0, 8) + '…' : orgN;

    // ── Linked-to-Map-Pool read-only mode ──
    const picks = _serVetoPicks();
    const banner = _serEnsureBanner();
    const head = el('gfx-ser-maps')?.previousElementSibling;
    if (picks.length && !_serManualOverride) {
      banner.style.display = 'flex';
      banner.innerHTML = `<span style="color:#4ade80; font-weight:600;">Linked to Map Pool</span>
        <span style="color:var(--muted);">${picks.length} map${picks.length > 1 ? 's' : ''} — edit them on the Map Pool scene.</span>
        <button class="btn btn-ghost btn-xs" id="gfx-ser-manual-btn" style="margin-left:auto;">Enter manually instead</button>`;
      el('gfx-ser-manual-btn')?.addEventListener('click', () => { _serManualOverride = true; gfxRenderSeriesMaps(maps, teams); });
      if (head) head.style.display = '';
      wrap.innerHTML = picks.map((m, i) => {
        const a = (m.score && m.score.a) || 0, b = (m.score && m.score.b) || 0;
        const done = m.winner || a || b;
        return `<div class="gfx-ser-map-row gfx-ser-map-row--linked" style="opacity:.85;">
          <span class="gfx-ser-map-num">${i + 1}</span>
          <input class="input-text gfx-ser-map-name" value="${(m.name || '').replace(/"/g, '&quot;')}" disabled>
          <input type="number" class="input-text gfx-ser-map-sa" value="${a}" disabled>
          <span class="gfx-ser-map-sep">:</span>
          <input type="number" class="input-text gfx-ser-map-sb" value="${b}" disabled>
          <label class="gfx-ser-map-done"><input type="checkbox" class="gfx-ser-map-pl" ${done ? 'checked' : ''} disabled><span>${m.action === 'decider' ? 'Dec' : 'Done'}</span></label>
        </div>`;
      }).join('');
      return;
    }
    // Manual mode (no picks yet, or producer opted into a Series-only board)
    if (picks.length && _serManualOverride) {
      banner.style.display = 'flex';
      banner.innerHTML = `<span style="color:var(--muted);">Series-only maps (ignoring Map Pool).</span>
        <button class="btn btn-ghost btn-xs" id="gfx-ser-link-btn" style="margin-left:auto;">Use Map Pool maps</button>`;
      el('gfx-ser-link-btn')?.addEventListener('click', () => { _serManualOverride = false; gfxRenderSeriesMaps(maps, teams); });
    } else {
      banner.style.display = 'none';
    }
    if (head) head.style.display = '';
    // Purge any read-only rows left over from linked mode before diffing editable rows
    wrap.querySelectorAll('.gfx-ser-map-row--linked').forEach((r) => r.remove());
    const existing = [...wrap.querySelectorAll('.gfx-ser-map-row')];
    maps.forEach((map, i) => {
      if (existing[i]) {
        const row = existing[i];
        const nm = row.querySelector('.gfx-ser-map-name');
        const sa = row.querySelector('.gfx-ser-map-sa');
        const sb = row.querySelector('.gfx-ser-map-sb');
        const pl = row.querySelector('.gfx-ser-map-pl');
        if (nm && document.activeElement !== nm) nm.value = map.name || '';
        if (sa && document.activeElement !== sa) sa.value = map.scoreA || 0;
        if (sb && document.activeElement !== sb) sb.value = map.scoreB || 0;
        if (pl) pl.checked = !!map.played;
      } else {
        const row = document.createElement('div');
        row.className = 'gfx-ser-map-row';
        row.innerHTML = `<span class="gfx-ser-map-num">${i + 1}</span><input class="input-text gfx-ser-map-name" value="${map.name || ''}" placeholder="Map name"><input type="number" class="input-text gfx-ser-map-sa" value="${map.scoreA || 0}" min="0"><span class="gfx-ser-map-sep">:</span><input type="number" class="input-text gfx-ser-map-sb" value="${map.scoreB || 0}" min="0"><label class="gfx-ser-map-done"><input type="checkbox" class="gfx-ser-map-pl" ${map.played ? 'checked' : ''}><span>Done</span></label>`;
        row.addEventListener('change', () => send('set_match', { maps: gfxCollectSeriesMaps() }));
        row.querySelector('.gfx-ser-map-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
        wrap.appendChild(row);
      }
    });
    while (wrap.children.length > maps.length) wrap.removeChild(wrap.lastChild);
  }

  // ── Matchup team pickers ─────────────────────────────────────────────────
  el('gfx-mu-apply')?.addEventListener('click', () => {
    const saved2 = (currentState && currentState.savedTeams) || [];
    const bv = el('gfx-mu-blue')?.value, ov = el('gfx-mu-orange')?.value;
    const bt = saved2[parseInt(bv, 10)], ot = saved2[parseInt(ov, 10)];
    if (bt) send('set_team', { side: 'blue',   name: bt.name, logo: bt.logo || null });
    if (ot) send('set_team', { side: 'orange', name: ot.name, logo: ot.logo || null });
    const st = el('gfx-mu-status');
    if (st) { st.textContent = 'Teams updated.'; setTimeout(() => { st.textContent = ''; }, 2000); }
  });
  el('gfx-mu-swap')?.addEventListener('click', () => send('swap_teams', {}));
  // Real names on the Matchup graphic ride the shared intro.showRealName flag (Line-up + Bracket
  // read it too). set_intro applies only the keys it's given, so this can't clobber the rest.
  el('check-matchup-realname')?.addEventListener('change', function () {
    send('set_intro', { showRealName: !!this.checked });
  });

  // ── Standings panel ──────────────────────────────────────────────────────
  // Legacy source values: 'startgg' (seeding-only, all zeros) and 'bracket' (phase/pool) were merged
  // into one 'tournament' source, so map anything saved under the old names onto it.
  function gfxStdNormSrc(src) {
    return (src === 'startgg' || src === 'bracket') ? 'tournament' : (src || 'league');
  }
  function gfxStdSrc(rawSrc) {
    const src = gfxStdNormSrc(rawSrc);
    el('gfx-std-league-wrap').style.display  = src === 'league' ? '' : 'none';
    el('gfx-std-sg-wrap').style.display      = 'none';   // old seeding-only pane, folded into Tournament
    el('gfx-std-manual-wrap').style.display  = src === 'manual' ? '' : 'none';
    // Side-column config that goes with each source (split out of the old single stacked column
    // so the pop-out can show config + live rows side by side).
    const leagueSel = el('gfx-std-league-select-wrap'); if (leagueSel) leagueSel.style.display = src === 'league' ? '' : 'none';
    const sgSel = el('gfx-std-sg-select-wrap'); if (sgSel) sgSel.style.display = 'none';
    // Phase/pool pickers are an OPTIONAL override under Tournament — blank means "follow the live one".
    const bktSel = el('gfx-std-bkt-select-wrap'); if (bktSel) bktSel.style.display = src === 'tournament' ? '' : 'none';
    const manualActions = el('gfx-std-manual-actions-wrap'); if (manualActions) manualActions.style.display = src === 'manual' ? '' : 'none';
    document.querySelectorAll('#gfx-std-src .gfx-src-tab').forEach((b) => b.classList.toggle('is-on', b.dataset.stdsrc === src));
  }
  document.querySelectorAll('#gfx-std-src .gfx-src-tab').forEach((b) => b.addEventListener('click', () => gfxStdSrc(b.dataset.stdsrc)));

  function gfxStdStatus(msg, err) {
    const s = el('gfx-std-status'); if (!s) return;
    s.textContent = msg; s.style.color = err ? 'var(--red, #ef4444)' : 'var(--muted)';
    setTimeout(() => { s.textContent = ''; }, 3000);
  }

  function gfxRefreshStandingsPreview() {
    const prev = el('gfx-std-league-preview'); if (!prev) return;
    const lid = el('gfx-std-league')?.value;
    const lg = lid && currentState && (currentState.leagues || []).find((l) => l.id === lid);
    if (!lg) { prev.innerHTML = '<p class="sps-empty">Select a league to preview.</p>'; return; }
    const byId = {}; (lg.standings || []).forEach((s) => { byId[s.teamId] = s; });
    const teamsById = {}; (lg.teams || []).forEach(t => { teamsById[t.id] = t; });
    // Use stored standings order (respects manual drag); fall back to pts sort
    const ordered = (lg.standings && lg.standings.length)
      ? lg.standings.map(s => teamsById[s.teamId]).filter(Boolean)
      : (lg.teams || []).slice().sort((a, b) => ((byId[b.id] || {}).pts || 0) - ((byId[a.id] || {}).pts || 0));
    prev.innerHTML = ordered.slice(0, 8).map((tm, i) => {
      const s = byId[tm.id] || {};
      return `<div class="gfx-std-row"><span class="gfx-std-rank">${i + 1}</span><span class="gfx-std-team">${lgResolveTeam(tm).name || '—'}</span><span class="gfx-std-rec">${s.w || 0}–${s.l || 0}</span><span class="gfx-std-pts">${s.pts || 0}</span></div>`;
    }).join('');
  }
  el('gfx-std-league')?.addEventListener('change', gfxRefreshStandingsPreview);

  // start.gg seeding source — build rows from eventTeams seeding order
  function gfxRefreshSgStandingsPreview() {
    const prev = el('gfx-std-sg-preview'); if (!prev) return;
    const sg = (currentState && currentState.startgg) || {};
    const teams = sg.eventTeams || [];
    if (!teams.length) { prev.innerHTML = '<p class="sps-empty">No start.gg event loaded. Connect an event in the Events tab.</p>'; return; }
    prev.innerHTML = teams.slice(0, 8).map((tm, i) =>
      `<div class="gfx-std-row"><span class="gfx-std-rank">${i + 1}</span><span class="gfx-std-team">${tm.name || '—'}</span></div>`
    ).join('');
  }

  // Content only (no visibility) — shared by the top-bar Push (adds visible:true) and the panel's
  // Apply action. Returns { title, rows } for league/start.gg sources; { title } for manual (that
  // source's rows are edited + saved separately via #gfx-std-save, which already omits visible).
  // Title/Subtitle/Show-record live ONLY on the front card now (Graphics ▸ Standings) — reading
  // from there is what makes them the single source of truth for Push/Apply/Save.
  function gfxStdCommon() {
    return {
      title: (el('gfx-front-std-title')?.value || '').trim(),
      subtitle: (el('gfx-front-std-subtitle')?.value || '').trim(),
      showRecord: el('gfx-front-std-showrecord') ? el('gfx-front-std-showrecord').checked : true,
    };
  }
  // Shared: build standings-shaped rows [{placement,name,logo,wins,losses,points}] from an
  // in-app league's current standings — used by both the Standings scene's League source and
  // the Bracket scene's League source (same rows, different destination field).
  function buildLeagueStandingsRows(leagueId) {
    const lg = leagueId && currentState && (currentState.leagues || []).find((l) => l.id === leagueId);
    if (!lg) return null;
    const byId = {}; (lg.standings || []).forEach((s) => { byId[s.teamId] = s; });
    const teamsById = {}; (lg.teams || []).forEach(t => { teamsById[t.id] = t; });
    const ordered = (lg.standings && lg.standings.length)
      ? lg.standings.map(s => teamsById[s.teamId]).filter(Boolean)
      : (lg.teams || []).slice().sort((a, b) => ((byId[b.id] || {}).pts || 0) - ((byId[a.id] || {}).pts || 0));
    return ordered.map((tm, i) => { const s = byId[tm.id] || {}; const r = lgResolveTeam(tm); return { placement: i + 1, name: r.name || 'Team', logo: r.logo || null, wins: s.w || 0, losses: s.l || 0, points: s.pts || 0 }; });
  }
  // Exposed globally so the legacy Standings pop-out (outside this closure) can reuse the same
  // row-building logic instead of keeping its own near-duplicate (standingsRowsFromLeague, removed).
  window.buildLeagueStandingsRows = buildLeagueStandingsRows;
  function buildStandingsPayload() {
    const common = gfxStdCommon();
    const src = document.querySelector('#gfx-std-src .gfx-src-tab.is-on')?.dataset.stdsrc || 'league';
    if (src === 'league') {
      const leagueId = el('gfx-std-league')?.value || '';
      const rows = buildLeagueStandingsRows(leagueId);
      if (!rows) return { ok: false, err: 'Select a league first.' };
      // Send the league id, not just a snapshot of its rows — the server re-mirrors this league's
      // points on every league change, so the board stays live instead of freezing at push time.
      return { ok: true, payload: { ...common, source: 'league', leagueId, rows }, msg: 'from league' };
    } else if (src === 'tournament') {
      // ONE tournament source. state.bracket is populated by whichever platform is connected —
      // start.gg, Challonge or NXGEN all feed it — so this works for any of them with no extra
      // picker. Defaults to the phase/pool that's LIVE on the Bracket scene, so it "just works"
      // when an event is connected; the phase/pool selects below are an optional override.
      const bk = (currentState && currentState.bracket) || {};
      const phases = bk.phases || [];
      const phaseId = el('gfx-std-bkt-phase')?.value || bk.activePhaseId || '';
      const ph = phases.find((p) => p.id === phaseId) || phases[0] || null;
      const poolId = el('gfx-std-bkt-pool')?.value || (ph && ph.id === bk.activePhaseId ? bk.activePoolId : '') || '';
      const pool = (ph && poolId && Array.isArray(ph.pools)) ? ph.pools.find((pl) => pl.id === poolId) : null;
      // Prefer pool → phase → the top-level mirror (which syncActiveBracketPhase keeps pointed at
      // the live phase/pool, and is what a single-phase event has).
      let rowsSrc = (pool && pool.standings) || (ph && ph.standings) || bk.standings || [];
      if (rowsSrc.length) {
        const rows = rowsSrc.map((r, i) => ({ ...r, placement: r.placement || i + 1 }));
        const where = ph ? ((ph.name || 'phase') + (pool ? ' · ' + (pool.name || 'pool') : '')) : 'event';
        return { ok: true, payload: { ...common, source: 'bracket-phase', rows }, msg: 'from ' + where };
      }
      // No results yet (bracket loaded but nothing played) — fall back to the seeding list so the
      // graphic isn't empty, and SAY it's seeding rather than passing zeros off as standings.
      const teams = ((currentState && currentState.startgg) || {}).eventTeams || [];
      if (!teams.length) return { ok: false, err: 'No tournament event connected — load one on the Bracket scene.' };
      const rows = teams.map((tm, i) => ({ placement: i + 1, name: tm.name || 'Team', logo: tm.logo || null, wins: 0, losses: 0, points: 0 }));
      return { ok: true, payload: { ...common, source: 'startgg-league', rows }, msg: 'from SEEDING (no results played yet)' };
    }
    return { ok: true, payload: { ...common, source: 'manual' }, msg: '' };
  }
  // -- Top 8 builder (Smash placement board) ----------------------------------
  // This is a row EDITOR, not just an annotation pass: a producer sets who finished where and the
  // fighter they played. It seeds from whichever source is selected above, and the first hand edit
  // takes ownership (_stdTop8 stops being null) so a start.gg refetch can't reorder the board out
  // from under them mid-show. "Reload from source" hands control back.
  let _stdTop8 = null;          // null = mirror the source; array = producer-owned rows
  const STD_TOP8_SEED = 8;      // it's a TOP 8 board -- seed eight and let "Add slot" go further
  // Which board the push will actually draw -- mirrors standings.html's own 'auto' rule.
  function stdLayoutChoice() {
    const btn = document.querySelector('#gfx-std-layout-seg .seg-btn.active');
    return btn ? btn.dataset.stdlayout : (((currentState || {}).standings || {}).layout || 'auto');
  }
  // The top-8 placement board belongs to Smash -- it is the only game with fighter art, and
  // standings.html refuses to draw it for anything else. Mirror that rule here so the panel can
  // never offer a board the overlay won't render.
  function stdGameIsSmash() {
    const st = currentState || {};
    const game = (st.games || {})[st.activeGame] || {};
    return (game.features || []).indexOf('stocks') >= 0;
  }
  // The Top 8 placement wall itself is for every FIGHTING game (Smash, Marvel Tokon, Tekken...);
  // only the fighter-art column is Smash's. Mirrors standings.html's gate.
  function stdGameHasTop8() {
    const st = currentState || {};
    const f = ((st.games || {})[st.activeGame] || {}).features || [];
    return f.indexOf('stocks') >= 0 || f.indexOf('fgc') >= 0;
  }
  function stdIsPlacement() {
    // Explicitly choosing the placement wall works for ANY game — the cards fall back to the
    // entrant's logo, so a Rocket League top 8 is a real graphic. 'auto' is the fighting-game rule.
    const choice = stdLayoutChoice();
    if (choice === 'placement') return true;
    return stdGameHasTop8() && choice !== 'podium';
  }
  // Real finish order from start.gg for the linked event, or null. This is the ONLY source with
  // true placements: an elimination bracket's standings are ordered by set wins, so they have no
  // 5/5 or 7/7 ties and can rank a losers-run runner-up above the champion.
  function stdStartggPlacements() {
    return stdPlacements().rows;
  }
  /*
    Real finish order from whichever PLATFORM is driving the event, or null.

    Both start.gg and Challonge publish a true placement per entrant, and they are the only sources
    with one: an elimination bracket's standings are ordered by set wins, so they have no 5/5 or
    7/7 ties and can rank a losers-run runner-up above the champion. The rows come back in the same
    shape from either, so everything downstream — this builder, the push, the overlay — is
    platform-agnostic; only `source` differs, and that is what tells the server which one to keep
    re-mirroring as the bracket resolves.

    The ACTIVE platform wins. A producer who loaded a Challonge bracket after a start.gg one must
    not get the old event's top 8 just because those rows are still in state.
  */
  function stdPlacements() {
    const st = currentState || {};
    // One entry per platform that publishes a real finish order. Keep this list in the order we
    // would fall back through when no platform is active.
    const SOURCES = [
      { platform: 'startgg', state: st.startggPlacements, source: 'startgg-placements', label: 'start.gg' },
      { platform: 'challonge', state: st.challongePlacements, source: 'challonge-placements', label: 'Challonge' },
      { platform: 'challengermode', state: st.challengermodePlacements, source: 'challengermode-placements', label: 'Challengermode' }
    ].map((x) => ({ ...x, rows: (x.state && Array.isArray(x.state.rows) && x.state.rows.length) ? x.state.rows : null,
                    complete: !!(x.state && x.state.complete) }));
    const active = ((st.activeEvent || {}).platform) || '';
    // The ACTIVE platform wins. A producer who loaded a Challengermode bracket after a start.gg one
    // must not get the old event's top 8 just because those rows are still sitting in state.
    const hit = SOURCES.find((x) => x.platform === active && x.rows) || SOURCES.find((x) => x.rows);
    if (hit) return { rows: hit.rows, source: hit.source, label: hit.label, complete: hit.complete };
    return { rows: null, source: 'manual', label: '', complete: false };
  }
  // The rows the selected source WOULD send, falling back to what is already on air so the list
  // still populates for a board pushed in an earlier session.
  function stdCandidateRows() {
    // A top-8 board wants finish order, so real placements beat anything derived from the bracket.
    if (stdIsPlacement()) {
      const pl = stdStartggPlacements();
      // `character` rides along: it is start.gg's reported per-game selection, which is what
      // auto-fills the fighters. Dropping it here would have made the whole pull invisible.
      // `players` is the entrant's roster — the Top 8 card lists it under a TEAM/doubles name, so
      // it has to survive this mapping the same way `character` does.
      // `countryCode` is the entrant's start.gg country (ISO-2) — the card's flag.
      // `logo` rides along for Challonge, which attaches a participant portrait and has no
      // character selections at all; `character` rides along for start.gg, which does. Dropping
      // either here is what makes a whole pull look like it never happened.
      // `placementText` is Challengermode's tie RANGE ("5-8"); `logo` is Challonge/Challengermode's
      // entrant portrait; `character` is start.gg's reported fighter. Each platform fills a
      // different subset, and dropping any of them here is what makes a whole pull look like it
      // never happened.
      if (pl) return pl.map((r) => ({ placement: r.placement, placementText: r.placementText || '',
                                      name: r.name,
                                      character: r.character || '', players: r.players || [],
                                      logo: r.logo || null,
                                      countryCode: r.countryCode || '' }));
    }
    let rows = [];
    try { const r = buildStandingsPayload(); if (r.ok && Array.isArray(r.payload.rows)) rows = r.payload.rows; } catch (e) { rows = []; }
    if (!rows.length) rows = ((currentState || {}).standings || {}).rows || [];
    return rows;
  }
  // Rows for the board: the producer's list once they've touched it, else the live source.
  function stdTop8Rows() {
    if (_stdTop8) return _stdTop8;
    return stdCandidateRows().slice(0, STD_TOP8_SEED).map((r, i) => ({ ...r, placement: r.placement || (i + 1) }));
  }
  // standings.html sizes the cards by ARRAY ORDER (rows[0] is the hero) but PRINTS row.placement,
  // so a placement typed out of order would show a rank that contradicts the card it sits on.
  // Sorting by placement keeps the two in step; it is stable, so slots sharing a placement (5, 5)
  // keep the order the producer put them in.
  function stdTop8Sorted(rows) {
    return rows
      .map((r, i) => ({ r, i }))
      .sort((a, b) => ((Number(a.r.placement) || 999) - (Number(b.r.placement) || 999)) || (a.i - b.i))
      .map((x) => x.r);
  }
  // Take ownership before applying an edit.
  function stdTop8Own() {
    if (!_stdTop8) _stdTop8 = stdTop8Rows().map((r) => ({ ...r }));
    return _stdTop8;
  }
  // Every player name we know of, for the name picker: event entrants and their rosters, the
  // profile registry, and the saved team library.
  function stdPlayerNames() {
    const st = currentState || {};
    const out = new Set();
    const add = (n) => { n = String(n || '').trim(); if (n) out.add(n); };
    ((st.startgg || {}).eventTeams || []).forEach((t) => { add(t.name); (t.players || []).forEach((pl) => add(pl && pl.name)); });
    Object.keys(st.playerProfiles || {}).forEach((k) => { const v = st.playerProfiles[k]; add((v && v.gamertag) || k); });
    (st.savedTeams || []).forEach((t) => { add(t.name); (t.players || []).forEach((pl) => add(pl && (pl.gamertag || pl.name))); });
    (((st.bracket || {}).standings) || []).forEach((r) => add(r && r.name));
    return [...out].sort((a, b) => a.localeCompare(b));
  }
  function stdSyncPlayerList() {
    const dl = el('gfx-std-players'); if (!dl) return;
    const names = stdPlayerNames();
    const sig = String(names.length) + '|' + names.slice(0, 6).join(',');
    if (dl.dataset.sig === sig) return;
    dl.dataset.sig = sig;
    dl.innerHTML = names.slice(0, 400).map((n) => '<option value="' + tlEsc(n) + '"></option>').join('');
  }
  // Compare a row list to what's pushed, so the chip can say whether the two agree.
  const stdRowSig = (rows) => (rows || []).map((r) =>
    [r.placement, r.placementText || '', (r.name || '').trim().toLowerCase(), (r.character || '').trim().toLowerCase()].join('|')).join(';');

  function stdRenderFighters() {
    const wrap = el('gfx-std-fighters'); if (!wrap) return;
    // Off Smash there is no board choice to make, so the whole selector goes away.
    // The board selector stays visible for every game: the placement wall is no longer
    // Smash-only, so hiding the choice would hide a board the overlay will happily draw.
    const seg = el('gfx-std-layout-row'); if (seg) seg.style.display = '';
    const block = el('gfx-std-fighters-wrap');
    const show = stdIsPlacement();
    if (block) block.style.display = show ? '' : 'none';
    if (!show) {
      // Non-placement standings still want the read-only preview — it's only redundant when the
      // Top 8 builder is on screen showing the same eight players.
      const d = el('gfx-front-standings-body');
      const df = d && d.closest('.gfx-fp-field');
      if (df) df.style.display = '';
      return;
    }
    stdSyncPlayerList();
    // Settle the list into board order once focus leaves it — re-sorting mid-keystroke would
    // yank the row the producer is typing in out from under the cursor.
    if (_stdTop8 && !wrap.contains(document.activeElement)) _stdTop8 = stdTop8Sorted(_stdTop8);
    const liveRows = (((currentState || {}).standings || {}).rows) || [];
    const rows = stdTop8Rows();
    const visible = !!(((currentState || {}).standings || {}).visible);

    const showTog = el('gfx-std-show-overlay');
    if (showTog && document.activeElement !== showTog) showTog.checked = visible;

    // Whether what's on screen has actually reached the overlay — the only thing the old
    // read-only "On overlay" list was really telling the producer.
    const chip = el('gfx-std-live-chip');
    if (chip) {
      const same = stdRowSig(liveRows) === stdRowSig(rows);
      chip.className = 'gfx-std-live-chip ' + (!visible ? 'is-off' : (same ? 'is-live' : 'is-dirty'));
      chip.textContent = !visible ? 'Hidden' : (same ? 'On overlay' : 'Unpushed changes');
    }
    // The separate read-only "On overlay" list is redundant while this builder is showing.
    const dupe = el('gfx-front-standings-body');
    const dupeField = dupe && dupe.closest('.gfx-fp-field');
    if (dupeField) dupeField.style.display = 'none';

    const emptyEl = el('gfx-std-fighters-empty');
    if (emptyEl) emptyEl.style.display = rows.length ? 'none' : '';
    // Fighter art only exists for Smash; other fighting games (Marvel Tokon...) get the same Top 8
    // builder without the fighter column or the "fighters reported" count.
    const withFighters = stdGameIsSmash();
    wrap.classList.toggle('no-fighters', !withFighters);
    const stateEl = el('gfx-std-pl-state');
    if (stateEl) {
      // Say how many fighters start.gg actually reported. Blank slots are almost always a player
      // who didn't pick a character when reporting, not a fault here — without this the producer
      // is left guessing whether the pull ran at all.
      const pl = (currentState || {}).startggPlacements || {};
      let label = 'Following the source';
      const plSrc = stdPlacements();
      if (_stdTop8) label = 'Edited by hand';
      // Challonge reports no character selections, so its board never shows a fighter count —
      // saying "0/8 fighters reported" for a platform that has no such field would read as a fault.
      else if (plSrc.rows && (!withFighters || plSrc.source !== 'startgg-placements')) {
        label = 'Following ' + plSrc.label + (plSrc.complete ? '' : ' · bracket still running');
      }
      else if (stdStartggPlacements()) {
        const filled = rows.filter((r) => (r.character || '').trim()).length;
        label = 'Following start.gg · ' + filled + '/' + rows.length + ' fighters reported';
        // Say WHY none arrived. A blank fighter column is otherwise indistinguishable from a
        // broken pull, which is exactly the hole this feature fell into.
        if (!filled) {
          label += pl.charError ? ' (' + pl.charError + ')'
                 : (pl.setsScanned ? ' — none reported on ' + pl.setsScanned + ' set(s)' : '');
        }
      }
      stateEl.textContent = label;
    }
    // Rebuild only when the row COUNT changes; values are synced below so a state push never
    // wipes a half-typed name or fighter out from under the producer.
    if (wrap.dataset.count !== String(rows.length)) {
      wrap.dataset.count = String(rows.length);
      wrap.innerHTML = rows.map((r, i) => (
        '<div class="gfx-std-pl-row" data-i="' + i + '" draggable="true">' +
          '<span class="gfx-std-pl-grip" title="Drag to reorder">⠿</span>' +
          '<input type="text" class="input-text gfx-std-pl-rank" data-fld="placement" title="Placement (ties are fine - 5, 5, 7, 7)">' +
          '<input type="text" class="input-text gfx-std-pl-name" data-fld="name" list="gfx-std-players" placeholder="Player" autocomplete="off">' +
          '<span class="smash-char-pick"><img class="smash-char-thumb is-empty" alt="">' +
            '<input type="text" class="input-text smash-char-input" data-fld="character" placeholder="Pick a fighter" readonly></span>' +
          '<button type="button" class="btn btn-ghost btn-xs gfx-std-pl-rm" title="Remove this slot">&times;</button>' +
        '</div>'
      )).join('');
    }
    wrap.querySelectorAll('.gfx-std-pl-row').forEach((row, i) => {
      const r = rows[i] || {};
      row.querySelectorAll('[data-fld]').forEach((inp) => {
        const v = inp.dataset.fld === 'placement' ? String(r.placement || (i + 1)) : String(r[inp.dataset.fld] || '');
        if (document.activeElement !== inp) inp.value = v;
      });
      const pick = row.querySelector('.smash-char-pick');
      if (pick) pick.style.visibility = withFighters ? '' : 'hidden';
      smashSetThumb(row.querySelector('.smash-char-thumb'), row.querySelector('[data-fld="character"]').value);
      // Medal tint for the podium — 1st/2nd/3rd otherwise look identical to 8th.
      const place = parseInt(r.placement || (i + 1), 10);
      row.classList.toggle('is-1', place === 1);
      row.classList.toggle('is-2', place === 2);
      row.classList.toggle('is-3', place === 3);
    });
  }

  /* Drag-to-reorder. Placements are NOT renumbered 1..n on drop — that would destroy the ties a
     bracket legitimately produces (5, 5, 7, 7). Instead the existing placement VALUES are taken in
     ascending order and re-applied down the new row order, so the shape of the ties survives while
     the entrants move. */
  let _stdDragFrom = null;
  el('gfx-std-fighters')?.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.gfx-std-pl-row'); if (!row) return;
    _stdDragFrom = parseInt(row.dataset.i, 10);
    row.classList.add('is-dragging');
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(_stdDragFrom)); } catch (_) {}
  });
  el('gfx-std-fighters')?.addEventListener('dragend', () => {
    _stdDragFrom = null;
    document.querySelectorAll('.gfx-std-pl-row').forEach((r) => r.classList.remove('is-dragging', 'is-over'));
  });
  el('gfx-std-fighters')?.addEventListener('dragover', (e) => {
    if (_stdDragFrom == null) return;
    e.preventDefault();
    const row = e.target.closest('.gfx-std-pl-row');
    document.querySelectorAll('.gfx-std-pl-row').forEach((r) => r.classList.toggle('is-over', r === row));
  });
  el('gfx-std-fighters')?.addEventListener('drop', (e) => {
    if (_stdDragFrom == null) return;
    e.preventDefault();
    const row = e.target.closest('.gfx-std-pl-row'); if (!row) return;
    const to = parseInt(row.dataset.i, 10);
    const from = _stdDragFrom;
    _stdDragFrom = null;
    document.querySelectorAll('.gfx-std-pl-row').forEach((r) => r.classList.remove('is-dragging', 'is-over'));
    if (isNaN(to) || isNaN(from) || to === from) return;
    const list = stdTop8Own();
    const places = list.map((r, i) => parseInt(r.placement || (i + 1), 10)).sort((a, b) => a - b);
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    list.forEach((r, i) => { r.placement = places[i]; });
    // The row DOM is only rebuilt when the COUNT changes; a reorder keeps the count, so the value
    // sync in stdRenderFighters() is what repaints it.
    stdRenderFighters();
  });
  // Fighter fields open the icon picker; bound on demand because the rows are rebuilt whenever
  // the slot count changes.
  el('gfx-std-fighters')?.addEventListener('mousedown', (e) => {
    const inp = e.target.closest('[data-fld="character"]'); if (!inp) return;
    const row = inp.closest('.gfx-std-pl-row');
    smashBindPicker(inp, (name) => {
      const i = parseInt(row.dataset.i, 10);
      const list = stdTop8Own();
      if (list[i]) list[i].character = name;
      smashSetThumb(row.querySelector('.smash-char-thumb'), name);
      stdRenderFighters();
    });
  }, true);
  el('gfx-std-fighters')?.addEventListener('change', (e) => {
    const row = e.target.closest('.gfx-std-pl-row'); if (!row) return;
    const fld = e.target.dataset.fld; if (!fld) return;
    const i = parseInt(row.dataset.i, 10);
    const list = stdTop8Own();
    if (!list[i]) return;
    if (fld === 'character') {
      // The picker writes canonical names, but a seeded/imported row can carry any spelling
      // ("zss", "gnw"), so still normalise here — the board should read the same as the picker.
      const f = smashResolve(e.target.value);
      if (f) e.target.value = f.name;
      list[i].character = e.target.value.trim();
      smashSetThumb(row.querySelector('.smash-char-thumb'), e.target.value);
    } else if (fld === 'placement') {
      const n = parseInt(e.target.value, 10);
      list[i].placement = Number.isFinite(n) && n > 0 ? n : (i + 1);
      e.target.value = String(list[i].placement);
    } else {
      list[i].name = e.target.value.trim();
      // A hand-picked player brings their saved logo along, so a card with no fighter set still
      // has something to show. ALWAYS reassign it, including to '': re-typing the slot as someone
      // else used to leave the previous player's logo attached to the new name.
      const known = ((currentState || {}).savedTeams || []).find((t) => t && (t.name || '').toLowerCase() === list[i].name.toLowerCase());
      list[i].logo = (known && known.logo) || '';
    }
    stdRenderFighters();
  });
  el('gfx-std-fighters')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.gfx-std-pl-rm'); if (!btn) return;
    const row = btn.closest('.gfx-std-pl-row');
    stdTop8Own().splice(parseInt(row.dataset.i, 10), 1);
    const wrap = el('gfx-std-fighters'); if (wrap) wrap.dataset.count = '';
    stdRenderFighters();
  });
  // Show / hide the board straight from the editor — same message the Full Board's checkbox sends.
  el('gfx-std-show-overlay')?.addEventListener('change', function () {
    send('set_standings', { visible: this.checked });
  });
  el('gfx-std-pl-add')?.addEventListener('click', () => {
    const list = stdTop8Own();
    list.push({ placement: list.length + 1, name: '', character: '' });
    stdRenderFighters();
  });
  el('gfx-std-pl-reload')?.addEventListener('click', () => {
    _stdTop8 = null;                       // back to mirroring the selected source
    const wrap = el('gfx-std-fighters'); if (wrap) wrap.dataset.count = '';
    stdRenderFighters();
    gfxStdStatus('Top 8 reloaded from the source.', false);
  });

  el('gfx-std-layout-seg')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-stdlayout]'); if (!b) return;
    document.querySelectorAll('#gfx-std-layout-seg .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    send('set_standings', { layout: b.dataset.stdlayout });
    stdRenderFighters();
  });

  gfxAction('show', 'standings', () => {
    // On the Top 8 board the BUILDER owns the rows (placement / player / fighter). A producer can
    // hand-build that board with no source at all, so an unconfigured source is NOT an error
    // there -- only an empty builder is. Every other board still needs its source.
    const placement = stdIsPlacement();
    const top8 = placement ? stdTop8Sorted(stdTop8Rows().filter((x) => (x.name || '').trim())) : [];
    const r = buildStandingsPayload();
    if (!r.ok && !(placement && top8.length)) { gfxStdStatus(r.err, true); return; }
    let payload = r.ok ? r.payload : { ...gfxStdCommon(), source: 'manual' };
    // Tag a top 8 that is still following start.gg so the server re-mirrors it as the bracket
    // resolves (refreshStartggPlacements). Once the producer edits the list it becomes theirs,
    // and a manual tag stops the server overwriting their names.
    // A board still MIRRORING a platform keeps following it (the server re-pushes the rows as the
    // bracket resolves); the moment the producer edits a row it becomes theirs, so it goes as
    // 'manual' and nothing can reorder it out from under them mid-show.
    if (placement) payload = { ...payload, source: _stdTop8 ? 'manual' : (stdPlacements().source || 'manual') };
    if (placement && !top8.length) { gfxStdStatus('Add at least one player to the Top 8.', true); return; }
    // Off the Top 8 board the Manual source deliberately sends NO rows (the server keeps the
    // hand-entered ones), so fall back to what's on air rather than wiping them with an empty array.
    const rows = placement ? top8
      : (Array.isArray(payload.rows) ? payload.rows : (((currentState || {}).standings || {}).rows || []));
    send('set_standings', { ...payload, layout: stdLayoutChoice(), rows, visible: true });
    gfxStdStatus('Pushed live' + (r.ok && r.msg ? ' ' + r.msg : '') + '.', false);
  });
  gfxAction('hide', 'standings', () => {
    send('set_standings', { visible: false });
    gfxStdStatus('Standings hidden.', false);
  }, 'btn-gfx-standings-clear');
  el('gfx-std-add')?.addEventListener('click', () => {
    const list = el('gfx-std-rows-list'); if (!list) return;
    const idx = list.querySelectorAll('.gfx-std-edit-row').length;
    const row = document.createElement('div'); row.className = 'gfx-std-edit-row';
    row.innerHTML = `<span class="gfx-std-rank-lbl">#${idx + 1}</span><input class="input-text" placeholder="Team name" style="flex:1;min-width:0;"><input class="input-text" placeholder="W" style="width:38px;text-align:center;"><input class="input-text" placeholder="L" style="width:38px;text-align:center;"><input class="input-text" placeholder="Pts" style="width:46px;text-align:center;"><button class="btn btn-ghost btn-xs gfx-std-rm">×</button>`;
    row.querySelector('.gfx-std-rm').addEventListener('click', () => { row.remove(); });
    list.appendChild(row);
    el('gfx-std-empty').style.display = 'none';
  });
  el('gfx-std-clear-rows')?.addEventListener('click', () => {
    const list = el('gfx-std-rows-list'); if (list) list.innerHTML = '';
    el('gfx-std-empty').style.display = '';
  });
  el('gfx-std-save')?.addEventListener('click', () => {
    const rows = [...(el('gfx-std-rows-list') || { querySelectorAll: () => [] }).querySelectorAll('.gfx-std-edit-row')].map((r, i) => {
      const inputs = r.querySelectorAll('input');
      return { placement: i + 1, name: inputs[0]?.value.trim() || '', wins: parseInt(inputs[1]?.value) || 0, losses: parseInt(inputs[2]?.value) || 0, points: parseInt(inputs[3]?.value) || 0 };
    });
    send('set_standings', { ...gfxStdCommon(), source: 'manual', rows });
    gfxStdStatus('Saved.', false);
  });

  // ── Schedule panel ───────────────────────────────────────────────────────
  // State lives in _schMatches (JS array). Initialized once from server state on first load,
  // then driven locally. Auto-saved to server via set_upcoming on every change.
  let _schMatches = [];
  let _schInitialized = false;
  let _schDragFrom = -1;   // index being dragged in the front-card schedule list (drag-to-reorder)
  // Set after a "Pull from league" — {leagueId, week, sig, pulledAt}. Lets us detect when the
  // source league's schedule changes after the one-shot pull, without reactively re-binding
  // state.upcoming to state.leagues (which would silently clobber hand-edited pulled rows).
  let _schPullMeta = null;
  function _schLeagueSig(lg, week) {
    if (!lg) return '';
    let sched = lg.schedule || [];
    sched = week ? sched.filter((m) => String(m.week || '') === week) : sched.filter((m) => !m.result || m.result.scoreA == null);
    return sched.map((m) => `${m.id}:${m.result ? m.result.scoreA : ''}:${m.result ? m.result.scoreB : ''}`).join('|');
  }

  function schFmtDate(v) {
    const s = (v || '').trim(); const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return s;
    const dt = new Date(+m[1], +m[2] - 1, +m[3]);
    return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function schFmtTime(v) {
    const s = (v || '').trim(); const m = /^(\d{1,2}):(\d{2})/.exec(s);
    if (!m) return s;
    let h = +m[1]; const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return h + ':' + m[2] + ' ' + ap;
  }

  function schRenderList() {
    const list = el('gfx-sch-list');
    const emptyEl = el('gfx-sch-manual-empty');
    const countEl = el('gfx-sch-count');
    if (!list) return;
    list.innerHTML = '';
    const n = _schMatches.length;
    if (countEl) countEl.textContent = n ? n + ' match' + (n > 1 ? 'es' : '') : '';
    if (emptyEl) emptyEl.style.display = n ? 'none' : '';
    const _teamLogo = (() => {
      const map = {};
      ((currentState && currentState.savedTeams) || []).forEach((t) => { if (t && t.name) map[t.name.toLowerCase()] = t.logo || ''; });
      ((currentState && currentState.startgg && currentState.startgg.eventTeams) || []).forEach((t) => { if (t && t.name && !map[t.name.toLowerCase()]) map[t.name.toLowerCase()] = t.logo || ''; });
      return (nm) => map[(nm || '').toLowerCase()] || '';
    })();
    _schMatches.forEach((m, i) => {
      const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const logoImg = (nm) => { const l = _teamLogo(nm); return l ? `<img class="gfx-sch-list-logo" src="${esc(l)}" alt="" onerror="this.style.display='none'">` : ''; };
      const row = document.createElement('div'); row.className = 'gfx-sch-list-row';
      row.innerHTML =
        `<div class="gfx-sch-list-teams"><span class="gfx-sch-list-team">${logoImg(m.teamA)}${esc(m.teamA || 'TBD')}</span><span class="gfx-sch-vs">vs</span><span class="gfx-sch-list-team">${logoImg(m.teamB)}${esc(m.teamB || 'TBD')}</span></div>`
        + `<div class="gfx-sch-list-meta">`
        + (m.round ? `<span class="gfx-sch-round">${esc(m.round)}</span>` : '')
        + ((m.date || m.time) ? `<span class="gfx-sch-list-when">${esc([m.date, m.time].filter(Boolean).join(' · '))}</span>` : '')
        + (m.stream ? `<span class="gfx-sch-list-badge">On Air</span>` : '')
        + `</div>`;
      const del = document.createElement('button');
      del.className = 'btn btn-ghost btn-xs'; del.textContent = '×'; del.title = 'Remove';
      del.addEventListener('click', () => { _schMatches.splice(i, 1); schRenderList(); schAutoSave(); });
      row.appendChild(del);
      list.appendChild(row);
    });
    schFrontRender();   // keep the front card's editable preview in lock-step with the pop-out list
  }

  // Editable match preview ON the Schedule front card (remove / reorder inline — no need to open
  // the Full Board). Renders from _schMatches (the single source of truth) and drives the same save.
  function schFrontRender() {
    const body = el('gfx-front-schedule-body'); if (!body) return;
    // Pause rebuilds only while a row FIELD is being typed in — a clicked button
    // (remove / move) also holds focus, and skipping then froze the list until a
    // manual refresh.
    const ae = document.activeElement;
    if (ae && body.contains(ae) && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
    if (typeof schFillTeamList === 'function') schFillTeamList();
    if (!_schInitialized) {   // hydrate once from server state so indices line up before any edit
      const up = (currentState && currentState.upcoming) || {};
      if (Array.isArray(up.matches) && up.matches.length) { _schMatches = up.matches.slice(); _schInitialized = true; }
    }
    const esc = (s) => (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const n = _schMatches.length;
    const cnt = el('gfx-front-sch-count'); if (cnt) cnt.textContent = n ? (n + ' match' + (n > 1 ? 'es' : '')) : '';
    if (!n) { body.innerHTML = '<p class="gfx-fp-empty">No matches queued — pull from a tournament / league above.</p>'; return; }
    body.innerHTML = '';
    _schMatches.forEach((m, i) => {
      const rd = m.round ? `<span class="rd" title="${esc(m.round)}">${esc(m.round)}</span>` : '';
      const a = esc(m.teamA || 'TBD'), b = esc(m.teamB || 'TBD');
      const live = '';
      const rowEl = document.createElement('div'); rowEl.className = 'gfx-fp-prow';
      rowEl.innerHTML = `<span class="gfx-fp-grip" title="Drag to reorder" aria-hidden="true">&#8942;&#8942;</span>${rd}<span class="tm" title="${a} vs ${b}">${a}<span class="vs">vs</span>${b}</span>`
        + `<input type="date" class="input-text gfx-fp-date" value="${esc(/^\d{4}-\d{2}-\d{2}$/.test(m.date || '') ? m.date : '')}" title="Match date — edits save automatically" style="width:118px; flex:0 0 auto; font-size:11px; padding:2px 4px;">`
        + '<select class="input-select gfx-fp-th" title="Hour" style="width:46px; flex:0 0 auto; font-size:11px; padding:2px 2px;"></select>'
        + '<select class="input-select gfx-fp-tm" title="Minutes" style="width:52px; flex:0 0 auto; font-size:11px; padding:2px 2px;"></select>'
        + '<select class="input-select gfx-fp-tap" title="AM / PM" style="width:52px; flex:0 0 auto; font-size:11px; padding:2px 2px;"><option>AM</option><option>PM</option></select>'
        + `<button type="button" class="gfx-fp-str${m.stream ? ' is-on' : ''}" title="Mark as the stream match — shows the ON AIR badge on the overlay" style="flex:0 0 auto; font-size:9px; font-weight:800; letter-spacing:.06em; padding:3px 7px; border-radius:999px; cursor:pointer; border:1px solid ${m.stream ? 'rgba(74,222,128,.5)' : 'var(--border)'}; background:${m.stream ? 'rgba(74,222,128,.15)' : 'transparent'}; color:${m.stream ? '#4ade80' : 'var(--muted)'};">ON AIR</button>`
        + live
        + `<span class="gfx-fp-rowbtns"><button type="button" class="gfx-fp-mv" data-mv="-1" title="Move up">&#8593;</button>`
        + `<button type="button" class="gfx-fp-mv" data-mv="1" title="Move down">&#8595;</button>`
        + `<button type="button" class="gfx-fp-rm" title="Remove">&times;</button></span>`;
      const th = rowEl.querySelector('.gfx-fp-th'), tm = rowEl.querySelector('.gfx-fp-tm'), tap = rowEl.querySelector('.gfx-fp-tap');
      schFillTimeSel(th, tm);
      const tcur = schTimeToSel(m.time);
      th.value = tcur.h; tm.value = tcur.m; tap.value = tcur.ap;
      const tSave = () => { _schMatches[i].time = schTimeFromSel(th.value, tm.value, tap.value); schAutoSave(); };
      [th, tm, tap].forEach((x) => x.addEventListener('change', tSave));
      const dtInp = rowEl.querySelector('.gfx-fp-date');
      dtInp.addEventListener('change', () => { _schMatches[i].date = dtInp.value.trim(); schAutoSave(); });
      rowEl.querySelector('.gfx-fp-str').addEventListener('click', () => {
        _schMatches[i].stream = !_schMatches[i].stream;
        schRenderList(); schAutoSave();
      });
      rowEl.querySelector('.gfx-fp-rm').addEventListener('click', () => { _schMatches.splice(i, 1); schRenderList(); schAutoSave(); });
      rowEl.querySelectorAll('.gfx-fp-mv').forEach((btn) => btn.addEventListener('click', () => {
        const j = i + (btn.dataset.mv === '-1' ? -1 : 1);
        if (j < 0 || j >= _schMatches.length) return;
        const t = _schMatches[i]; _schMatches[i] = _schMatches[j]; _schMatches[j] = t;
        schRenderList(); schAutoSave();
      }));
      // Drag-to-reorder. The whole row is draggable, but a drag that STARTS inside an input/select/
      // button is cancelled so those stay clickable — grab the grip (or the team text) to reorder.
      rowEl.draggable = true;
      rowEl.dataset.idx = i;
      rowEl.addEventListener('dragstart', (e) => {
        if (e.target.closest('input, select, button')) { e.preventDefault(); return; }
        _schDragFrom = i;
        rowEl.classList.add('gfx-fp-dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(i)); } catch (_) {}
      });
      const clearDropMarks = () => body.querySelectorAll('.gfx-fp-drop-before, .gfx-fp-drop-after')
        .forEach((x) => x.classList.remove('gfx-fp-drop-before', 'gfx-fp-drop-after'));
      rowEl.addEventListener('dragend', () => { rowEl.classList.remove('gfx-fp-dragging'); clearDropMarks(); _schDragFrom = -1; });
      rowEl.addEventListener('dragover', (e) => {
        if (_schDragFrom < 0 || _schDragFrom === i) return;
        e.preventDefault(); e.dataTransfer.dropEffect = 'move';
        const r = rowEl.getBoundingClientRect();
        const after = (e.clientY - r.top) > r.height / 2;
        clearDropMarks();
        rowEl.classList.add(after ? 'gfx-fp-drop-after' : 'gfx-fp-drop-before');
      });
      rowEl.addEventListener('drop', (e) => {
        if (_schDragFrom < 0) return;
        e.preventDefault();
        const from = _schDragFrom; _schDragFrom = -1;
        const r = rowEl.getBoundingClientRect();
        const after = (e.clientY - r.top) > r.height / 2;
        let to = i + (after ? 1 : 0);
        if (from === to || from === to - 1) { clearDropMarks(); return; }   // no-op drop in place
        const item = _schMatches.splice(from, 1)[0];
        if (from < to) to -= 1;                                             // account for the removal shift
        _schMatches.splice(to, 0, item);
        schRenderList(); schAutoSave();
      });
      body.appendChild(rowEl);
    });
  }

  // Team-name autocomplete for the front card's Add-match row — saved teams + the
  // linked event's entrants, so adding "the next two matches" is type-ahead fast.
  function schFillTeamList() {
    const dl = el('gfx-sch-teamlist'); if (!dl) return;
    const names = new Set();
    ((currentState && currentState.savedTeams) || []).forEach((t) => t && t.name && names.add(t.name));
    ((currentState && currentState.startgg && currentState.startgg.eventTeams) || []).forEach((t) => t && t.name && names.add(t.name));
    const list = [...names].slice(0, 400);
    const sig = list.length + '|' + (list[0] || '') + '|' + (list[list.length - 1] || '');
    if (dl.dataset.sig === sig) return;
    dl.dataset.sig = sig;
    dl.innerHTML = list.map((n) => '<option value="' + n.replace(/"/g, '&quot;', 'btn-gfx-standings-push') + '"></option>').join('');
  }
  el('gfx-sch-add-front')?.addEventListener('click', () => {
    const a = (el('gfx-sch-add-a')?.value || '').trim();
    const b = (el('gfx-sch-add-b')?.value || '').trim();
    const when = schTimeFromSel(el('gfx-sch-add-h')?.value, el('gfx-sch-add-m')?.value, el('gfx-sch-add-ap')?.value);
    if (!a && !b) { showToast('Type at least one team name.', '#fbbf24'); return; }
    const dateVal = (el('gfx-sch-add-date')?.value || '').trim();
    // No setId: manual rows append alongside queue-pulled ones instead of being deduped.
    _schMatches.push({ teamA: a || 'TBD', teamB: b || 'TBD', time: when, date: dateVal, round: '', stream: false, state: 1 });
    ['gfx-sch-add-a', 'gfx-sch-add-b', 'gfx-sch-add-date', 'gfx-sch-add-h', 'gfx-sch-add-m'].forEach((id) => { const i = el(id); if (i) i.value = ''; });
    schRenderList(); schAutoSave();
  });
  // The Layout picker belongs on the card — with add/reorder/remove inline, the
  // pop-out is only needed for tournament search now.
  (function moveSchLayoutToFront() {
    const sel = el('gfx-sch-layout'); const front = el('gfx-front-schedule');
    if (!sel || !front) return;
    const row = sel.closest('.gfx-ctrl-row'); const actions = front.querySelector('.gfx-fp-actions');
    if (row && actions) front.insertBefore(row, actions);
  })();

  // Bounded 12-hour time selects (hour 1-12 / minute 00-59 / AM-PM) — the native time
  // spinner scroll-wraps forever, which made picking times miserable.
  function schFillTimeSel(hSel, mSel) {
    if (hSel && !hSel.options.length) hSel.innerHTML = '<option value="">Hr</option>' + Array.from({ length: 12 }, (_, i) => '<option>' + (i + 1) + '</option>').join('');
    if (mSel && !mSel.options.length) mSel.innerHTML = '<option value="">Min</option>' + Array.from({ length: 60 }, (_, i) => '<option>' + String(i).padStart(2, '0') + '</option>').join('');
  }
  function schTimeFromSel(h, m, ap) {
    if (!h) return '';
    let hh = parseInt(h, 10) % 12;
    if (ap === 'PM') hh += 12;
    return String(hh).padStart(2, '0') + ':' + (m || '00');
  }
  function schTimeToSel(t) {
    const x = /^(\d{2}):(\d{2})/.exec(t || '');
    if (!x) return { h: '', m: '', ap: 'PM' };
    let hh = +x[1];
    const ap = hh >= 12 ? 'PM' : 'AM';
    hh = hh % 12 || 12;
    return { h: String(hh), m: x[2], ap };
  }
  schFillTimeSel(el('gfx-sch-add-h'), el('gfx-sch-add-m'));

  // Full-clear hook for the Clear button (defined here because _schMatches is module-scoped).
  window._schClearLocal = function () { _schMatches = []; _schInitialized = true; schRenderList(); };

  // Server echo -> local truth: edits made anywhere else (the pop-out list, pulls,
  // a second panel window) land here on the next broadcast instead of after a refresh.
  window._schSyncFromState = function (data) {
    const up = (data && data.upcoming) || {};
    const eb = el('gfx-front-sch-eyebrow');
    if (eb && document.activeElement !== eb && typeof up.eyebrow === 'string') eb.value = up.eyebrow;
    if (!Array.isArray(up.matches)) return;
    const ae = document.activeElement;
    const body = el('gfx-front-schedule-body');
    if (ae && body && body.contains(ae) && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
    const sig = JSON.stringify(up.matches);
    if (sig === JSON.stringify(_schMatches)) return;
    _schMatches = up.matches.slice();
    _schInitialized = true;
    schRenderList();
  };

  // Title lives on the front card only now (Graphics ▸ Schedule) — single source of truth.
  function schAutoSave() {
    send('set_upcoming', {
      matches: _schMatches,
      title: (el('gfx-front-sch-title')?.value || 'SCHEDULE').trim(),
      eyebrow: (el('gfx-front-sch-eyebrow')?.value || '').trim(),
      layout: el('gfx-sch-layout')?.value || 'cards'
    });
  }
  el('gfx-front-sch-eyebrow')?.addEventListener('change', schAutoSave);

  function buildScheduleContentPayload() {
    return {
      title: (el('gfx-front-sch-title')?.value || 'SCHEDULE').trim(),
      eyebrow: (el('gfx-front-sch-eyebrow')?.value || '').trim(),
      layout: el('gfx-sch-layout')?.value || 'cards',
      matches: _schMatches
    };
  }

  function gfxRenderScheduleQueue(state) {
    const sg = (state && state.startgg) || {};
    const queue = sg.queue || [];
    const connected = !!sg.connected;
    const rc = el('gfx-sch-showresults'); if (rc && document.activeElement !== rc) rc.checked = !!(state && state.upcoming && state.upcoming.showResults);
    // Sync league dropdown
    if (typeof lgPopulateLeagueSelect === 'function') {
      lgPopulateLeagueSelect(el('gfx-sch-league'), (state && state.leagues) || [], { placeholder: 'League…' });
    }
    gfxCheckScheduleStale(state);
    const up = (state && state.upcoming) || {};
    const raw = up.layout || 'cards';
    const lay = (raw === 'board' || raw === 'dual') ? 'board' : 'cards';
    // Initialize layout, title, and matches only on first load — never overwrite after that
    // (every broadcast would otherwise reset the dropdown the moment the user clicks away)
    if (!_schInitialized) {
      _schInitialized = true;
      const laySel = el('gfx-sch-layout'); if (laySel) laySel.value = lay;
      const pv = el('gfx-pv-schedule');
      if (pv) { pv.dataset.lay = lay; pv.src = (window.SCENE_BASE_URL || 'http://localhost:3000') + '/schedule.html?preview=1&layout=' + lay; }
      // Title hydration handled by renderPopoutSummary('schedule') on every broadcast now
      // (front card owns it) — no separate one-time sync needed here.
      if (Array.isArray(up.matches) && up.matches.length) {
        _schMatches = up.matches.slice();
        schRenderList();
      }
    }
    if (typeof gfxFillScheduleWeeks === 'function' && document.activeElement !== el('gfx-sch-week')) gfxFillScheduleWeeks();
    const conn = el('gfx-sch-conn');
    if (conn) conn.textContent = connected ? (queue.length ? `${queue.length} in queue` : 'Connected — no queue') : 'start.gg not connected';
    const liveSlot = el('gfx-sch-live-slot');
    const nextList = el('gfx-sch-next-list');
    const noQueue = el('gfx-sch-no-queue');
    if (!liveSlot || !nextList) return;
    const live = queue.find((q) => q.live);
    const next = queue.filter((q) => !q.live).slice(0, 3);
    if (!connected || !queue.length) {
      liveSlot.textContent = 'No stream match queued.';
      liveSlot.className = 'gfx-sch-live';
      nextList.innerHTML = '';
      if (noQueue) noQueue.style.display = connected ? 'none' : '';
      return;
    }
    if (noQueue) noQueue.style.display = 'none';
    if (live) {
      liveSlot.className = 'gfx-sch-live gfx-sch-live--on';
      liveSlot.innerHTML = `<span class="gfx-sch-round">${live.round || ''}</span><span class="gfx-sch-teams">${live.teamA || '?'} <span class="gfx-sch-vs">vs</span> ${live.teamB || '?'}</span>`;
    } else {
      liveSlot.className = 'gfx-sch-live';
      liveSlot.textContent = 'No match currently on stream.';
    }
    nextList.innerHTML = next.map((q) =>
      `<div class="gfx-sch-next-row"><span class="gfx-sch-round">${q.round || ''}</span><span class="gfx-sch-teams">${q.teamA || '?'} <span class="gfx-sch-vs">vs</span> ${q.teamB || '?'}</span></div>`
    ).join('') || '<p class="sps-empty" style="margin:0;">No upcoming matches in queue.</p>';
  }

  // Push to live (top-bar button)
  gfxAction('show', 'schedule', () => {
    const payload = buildScheduleContentPayload();
    send('set_upcoming', { ...payload, visible: true });
    const st = el('gfx-sch-status');
    if (st) { st.textContent = `Pushed ${payload.matches.length} match${payload.matches.length !== 1 ? 'es' : ''} live.`; setTimeout(() => { st.textContent = ''; }, 2500); }
  }, 'btn-gfx-schedule-push');
  // Taking the Schedule graphic off air (Hide, Hide all, or showing another graphic) only hides it.
  gfxAction('hide', 'schedule', () => { send('set_upcoming', { visible: false }); }, 'btn-hide-schedule-gfx');
  el('btn-gfx-schedule-clear')?.addEventListener('click', async () => {
  // Full reset — hide the overlay, empty the board, AND detach from start.gg so the
  // next poll can't refill it (that refill made a linked event impossible to clear).
  const has = ((currentState && currentState.upcoming && currentState.upcoming.matches) || []).length || (typeof _schMatches !== 'undefined' && _schMatches.length);
  if (has && !(await appConfirm('Clear the schedule? This empties the board and stops start.gg filling it until you pull again.', 'Clear schedule'))) return;
  send('set_upcoming', { visible: false, matches: [] });
  send('startgg_set_upcoming_mode', { mode: 'manual' });
  if (typeof window._schClearLocal === 'function') window._schClearLocal();
  showToast('Schedule cleared — start.gg auto-fill off (pull or Event mode re-enables it)', '#22c55e');
});

  // Layout toggle — persist immediately so the preview iframe updates
  el('gfx-sch-layout')?.addEventListener('change', (e) => {
    const lay = e.target.value;
    send('set_upcoming', { layout: lay });
    const pv = el('gfx-pv-schedule');
    if (pv) pv.src = (window.SCENE_BASE_URL || 'http://localhost:3000') + '/schedule.html?preview=1&layout=' + lay;
  });
  // Keep finished matches on the board (with their final series score)
  el('gfx-sch-showresults')?.addEventListener('change', function () { send('set_upcoming', { showResults: this.checked }); });

  // Source tab toggle
  el('gfx-sch-tab-auto')?.addEventListener('click', () => {
    el('gfx-sch-tab-auto').classList.add('is-on'); el('gfx-sch-tab-manual').classList.remove('is-on'); el('gfx-sch-tab-team')?.classList.remove('is-on');
    el('gfx-sch-auto-wrap').style.display = ''; el('gfx-sch-manual-wrap').style.display = 'none'; if (el('gfx-sch-team-wrap')) el('gfx-sch-team-wrap').style.display = 'none';
  });
  el('gfx-sch-tab-manual')?.addEventListener('click', () => {
    el('gfx-sch-tab-manual').classList.add('is-on'); el('gfx-sch-tab-auto').classList.remove('is-on'); el('gfx-sch-tab-team')?.classList.remove('is-on');
    el('gfx-sch-manual-wrap').style.display = ''; el('gfx-sch-auto-wrap').style.display = 'none'; if (el('gfx-sch-team-wrap')) el('gfx-sch-team-wrap').style.display = 'none';
  });
  el('gfx-sch-tab-team')?.addEventListener('click', () => {
    el('gfx-sch-tab-team').classList.add('is-on'); el('gfx-sch-tab-auto').classList.remove('is-on'); el('gfx-sch-tab-manual').classList.remove('is-on');
    el('gfx-sch-team-wrap').style.display = ''; el('gfx-sch-auto-wrap').style.display = 'none'; el('gfx-sch-manual-wrap').style.display = 'none';
  });

  // Team queue search
  el('gfx-sch-team-load')?.addEventListener('click', () => {
    const slug = (el('gfx-sch-team-slug')?.value || '').trim();
    const name = (el('gfx-sch-team-name')?.value || '').trim();
    const st = el('gfx-sch-team-status');
    if (!name) { if (st) { st.textContent = 'Enter a team name.'; st.style.color = '#f56565'; } return; }
    if (st) { st.textContent = 'Searching...'; st.style.color = 'var(--muted)'; }
    send('startgg_fetch_team_queue', { teamName: name, tournamentSlug: slug });
  });
  el('gfx-sch-team-pull')?.addEventListener('click', () => {
    const tq = (currentState && currentState.startgg && currentState.startgg.teamQueue) || [];
    if (!tq.length) return;
    tq.forEach((q) => _schMatches.push({ setId: q.setId || '', round: q.round || '', teamA: q.teamA || 'TBD', teamB: q.teamB || 'TBD', logoA: q.logoA || '', logoB: q.logoB || '', date: '', time: '', stream: !!q.live }));
    schRenderList(); schAutoSave();
    const st = el('gfx-sch-team-status');
    if (st) { st.textContent = `Added ${tq.length} match(es) to schedule.`; st.style.color = '#9ae6b4'; }
  });

  // Add match from form
  el('gfx-sch-add')?.addEventListener('click', () => {
    const a = (el('gfx-sch-fa')?.value || '').trim();
    const b = (el('gfx-sch-fb')?.value || '').trim();
    if (!a && !b) return;
    _schMatches.push({
      round: (el('gfx-sch-fround')?.value || '').trim(),
      teamA: a, teamB: b,
      date: schFmtDate(el('gfx-sch-fdate')?.value || ''),
      time: schFmtTime(el('gfx-sch-ftime')?.value || ''),
      stream: !!(el('gfx-sch-fstream')?.checked)
    });
    ['gfx-sch-fa', 'gfx-sch-fb', 'gfx-sch-fround', 'gfx-sch-fdate', 'gfx-sch-ftime'].forEach((id) => { const e = el(id); if (e) { e.value = ''; if (e._btLoad) e._btLoad(); } });
    const fs = el('gfx-sch-fstream'); if (fs) fs.checked = false;
    schRenderList(); schAutoSave();
  });

  // Clear all
  el('gfx-sch-clear-all')?.addEventListener('click', async () => {
    if (!_schMatches.length || !(await appConfirm('Clear all scheduled matches?', 'Clear'))) return;
    _schMatches = []; schRenderList(); schAutoSave();
  });

  // Pull from start.gg queue
  el('gfx-sch-pull-startgg')?.addEventListener('click', () => {
    const sg = (currentState && currentState.startgg) || {};
    const queue = (sg.queue || []);
    const rows = [...queue.filter((q) => q.live), ...queue.filter((q) => !q.live).slice(0, 5)];
    const st = el('gfx-sch-status');
    if (!rows.length) { if (st) { st.textContent = 'No start.gg queue. Load an event on the Event page first.'; setTimeout(() => { st.textContent = ''; }, 3000); } return; }
    rows.forEach((q) => _schMatches.push({ setId: String(q.setId || ''), round: q.round || '', teamA: q.teamA || '', teamB: q.teamB || '', date: '', time: '', stream: !!q.live }));
    schRenderList(); schAutoSave();
    if (st) { st.textContent = `Added ${rows.length} match${rows.length > 1 ? 'es' : ''} from queue.`; setTimeout(() => { st.textContent = ''; }, 2500); }
  });

  // Populate week dropdown from selected league
  function gfxFillScheduleWeeks() {
    const wSel = el('gfx-sch-week'); if (!wSel) return;
    const lg = (currentState.leagues || []).find((l) => String(l.id) === String(el('gfx-sch-league')?.value || ''));
    const weeks = [...new Set((lg?.schedule || []).map((m) => String(m.week || '')).filter(Boolean))]
      .sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
    const prev = wSel.value;
    wSel.innerHTML = '<option value="">All weeks</option>' + weeks.map((w) => `<option value="${w}">Week ${w}</option>`).join('');
    if (weeks.includes(prev)) wSel.value = prev;
  }
  el('gfx-sch-league')?.addEventListener('change', gfxFillScheduleWeeks);

  // Pull from league
  el('gfx-sch-pull-league')?.addEventListener('click', () => {
    const id = el('gfx-sch-league')?.value || '';
    const lg = (currentState.leagues || []).find((l) => String(l.id) === String(id));
    const st = el('gfx-sch-status');
    if (!lg) { if (st) { st.textContent = 'Pick a league first.'; setTimeout(() => { st.textContent = ''; }, 2000); } return; }
    const week = (el('gfx-sch-week')?.value || '').trim();
    let sched = (lg.schedule || []);
    if (week) sched = sched.filter((m) => String(m.week || '') === week);
    else sched = sched.filter((m) => !m.result || m.result.scoreA == null);
    sched = sched.slice(0, 12);
    if (!sched.length) { if (st) { st.textContent = week ? `No matches in week ${week}.` : 'No upcoming matches in that league.'; setTimeout(() => { st.textContent = ''; }, 2500); } return; }
    const lgTeamName = (id) => { const tm = (lg.teams || []).find((t) => t.id === id); return tm ? lgResolveTeam(tm).name : (id || ''); };
    sched.forEach((m) => _schMatches.push({
      srcMatchId: m.id,
      round: m.week ? ('Week ' + m.week) : (lg.name || ''),
      teamA: lgTeamName(m.teamA), teamB: lgTeamName(m.teamB),
      date: m.date || '', time: m.time || '', week: m.week || '', stream: false,
      scoreA: m.result && m.result.scoreA != null ? m.result.scoreA : null,
      scoreB: m.result && m.result.scoreB != null ? m.result.scoreB : null
    }));
    if (week) {
      const lay = el('gfx-sch-layout'); if (lay) lay.value = 'dual';
      const ttl = el('gfx-front-sch-title'); if (ttl) ttl.value = 'WEEK ' + week;
    }
    _schPullMeta = { leagueId: id, week, sig: _schLeagueSig(lg, week), pulledAt: Date.now() };
    gfxHideScheduleStaleBanner();
    schRenderList(); schAutoSave();
    if (st) { st.textContent = `Added ${sched.length} match${sched.length !== 1 ? 'es' : ''}${week ? ' from week ' + week : ''}.`; setTimeout(() => { st.textContent = ''; }, 2500); }
  });

  // Re-pull after the stale banner fires: append only matches not already pulled (matched by the
  // source league row's own id), so hand-edits to already-pulled rows survive. Score corrections on
  // an already-pulled row are NOT picked up this way — re-pull won't overwrite an existing row.
  function gfxRepullLeagueSchedule() {
    const meta = _schPullMeta; if (!meta) return;
    const lg = (currentState.leagues || []).find((l) => String(l.id) === String(meta.leagueId));
    const st = el('gfx-sch-status');
    if (!lg) { gfxHideScheduleStaleBanner(); return; }
    let sched = lg.schedule || [];
    sched = meta.week ? sched.filter((m) => String(m.week || '') === meta.week) : sched.filter((m) => !m.result || m.result.scoreA == null);
    const existingIds = new Set(_schMatches.map((m) => m.srcMatchId).filter(Boolean));
    const fresh = sched.filter((m) => !existingIds.has(m.id)).slice(0, 12);
    const lgTeamName = (id) => { const tm = (lg.teams || []).find((t) => t.id === id); return tm ? lgResolveTeam(tm).name : (id || ''); };
    fresh.forEach((m) => _schMatches.push({
      srcMatchId: m.id,
      round: m.week ? ('Week ' + m.week) : (lg.name || ''),
      teamA: lgTeamName(m.teamA), teamB: lgTeamName(m.teamB),
      date: m.date || '', time: m.time || '', week: m.week || '', stream: false,
      scoreA: m.result && m.result.scoreA != null ? m.result.scoreA : null,
      scoreB: m.result && m.result.scoreB != null ? m.result.scoreB : null
    }));
    _schPullMeta = { ...meta, sig: _schLeagueSig(lg, meta.week), pulledAt: Date.now() };
    gfxHideScheduleStaleBanner();
    schRenderList(); schAutoSave();
    if (st) { st.textContent = fresh.length ? `Added ${fresh.length} new match${fresh.length !== 1 ? 'es' : ''}.` : 'No new matches — existing rows kept as-is.'; setTimeout(() => { st.textContent = ''; }, 2500); }
  }

  function gfxHideScheduleStaleBanner() {
    const banner = el('gfx-sch-stale-banner'); if (banner) { banner.style.display = 'none'; banner.innerHTML = ''; }
  }

  // Called on every state update (from gfxRenderScheduleQueue) — compares the source league's
  // current schedule signature against the one captured at pull time; does NOT reactively re-bind
  // state.upcoming (that would silently clobber hand-edits to already-pulled rows).
  function gfxCheckScheduleStale(state) {
    const banner = el('gfx-sch-stale-banner'); if (!banner) return;
    if (!_schPullMeta) { gfxHideScheduleStaleBanner(); return; }
    const lg = ((state && state.leagues) || []).find((l) => String(l.id) === String(_schPullMeta.leagueId));
    if (!lg) { gfxHideScheduleStaleBanner(); return; }
    const curSig = _schLeagueSig(lg, _schPullMeta.week);
    if (curSig === _schPullMeta.sig) { gfxHideScheduleStaleBanner(); return; }
    banner.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:6px;padding:6px 10px;border-radius:8px;background:rgba(201,138,31,.12);border:1px solid rgba(201,138,31,.35);color:#c98a1f;font-size:11px;font-weight:600;';
    banner.innerHTML = `<span style="flex:1;">Schedule updated in ${String(lg.name || 'league').replace(/</g, '&lt;')} since last pull.</span><button class="btn btn-ghost btn-xs" id="gfx-sch-restale-btn" type="button">Re-pull</button>`;
    el('gfx-sch-restale-btn')?.addEventListener('click', gfxRepullLeagueSchedule);
  }

  // Expose refresh hooks called from applyState
  window._gfxRefreshSeriesControls = function (state) {
    const bestOf = state.bestOf || 5;
    document.querySelectorAll('#gfx-ser-format .gfx-pill').forEach((b) => b.classList.toggle('is-on', parseInt(b.dataset.bo, 10) === bestOf));
    const divEl = el('gfx-ser-division');
    if (divEl && document.activeElement !== divEl) divEl.value = (state.match && state.match.division) || '';
    gfxRenderSeriesMaps((state.match && state.match.maps) || [], state.teams);
    // Summary: use server-authoritative series wins (auto-tracked for RL/OW/CS2)
    const bv = el('gfx-ser-score-blue'), ov = el('gfx-ser-score-org');
    if (bv) bv.textContent = (state.series && state.series.blue) || 0;
    if (ov) ov.textContent = (state.series && state.series.orange) || 0;
    const bn = el('gfx-ser-name-blue'), on2 = el('gfx-ser-name-org');
    if (bn) bn.textContent = (state.teams && state.teams.blue && state.teams.blue.name) || 'Team A';
    if (on2) on2.textContent = (state.teams && state.teams.orange && state.teams.orange.name) || 'Team B';
  };

  window._gfxRefreshMatchupPickers = function (state) {
    const teams = (state && state.savedTeams) || [];
    const curBlue = ((state.teams && state.teams.blue && state.teams.blue.name) || '').toLowerCase();
    const curOrg  = ((state.teams && state.teams.orange && state.teams.orange.name) || '').toLowerCase();
    [['gfx-mu-blue', curBlue], ['gfx-mu-orange', curOrg]].forEach(([id, curName]) => {
      const sel = el(id); if (!sel) return;
      const prev = sel.value;
      sel.innerHTML = '<option value="">Select team…</option>';
      teams.forEach((t, i) => {
        const opt = document.createElement('option');
        opt.value = i; opt.textContent = t.name || '(unnamed)';
        if ((t.name || '').toLowerCase() === curName) opt.selected = true;
        sel.appendChild(opt);
      });
      if (!sel.value && prev) sel.value = prev;
    });
  };

  // Winner-screen auto-suggest helpers. Attached to window so both the picker (this scope) and
  // winnerPayload (top level) share them. _winnerAuto tracks whether the producer has overridden the
  // auto-picked side / typed their own subtitle, so we stop suggesting once they take control.
  window._winnerAuto = window._winnerAuto || { sideManual: false, subTouched: false, lastScore: '' };
  window._winnerLeadingSide = function (state) {
    const s = (state && state.series) || {};
    const b = Number(s.blue) || 0, o = Number(s.orange) || 0;
    if (b === o) return '';                 // tie / no games played → don't guess a winner
    return b > o ? 'blue' : 'orange';
  };
  window._winnerSeriesScore = function (state, sideVal) {
    const s = (state && state.series) || {};
    const b = Number(s.blue) || 0, o = Number(s.orange) || 0;
    if (b + o <= 0) return '';
    let hi, lo;
    if (sideVal === 'blue') { hi = b; lo = o; }
    else if (sideVal === 'orange') { hi = o; lo = b; }
    else { hi = Math.max(b, o); lo = Math.min(b, o); }   // custom/saved winner → winner's (higher) score first
    return hi + '–' + lo;              // en-dash
  };

  window._gfxRefreshWinnerPicker = function (state) {
    const sel = el('select-winner-side'); if (!sel) return;
    const teams  = (state && state.savedTeams) || [];
    const blueNm = (state && state.teams && state.teams.blue && state.teams.blue.name)   || '';
    const orgNm  = (state && state.teams && state.teams.orange && state.teams.orange.name) || '';
    const prev   = sel.value;
    sel.innerHTML = '';
    // Blue / Orange quick options (label = actual team name when loaded)
    const mkOpt = (val, lbl) => { const o = document.createElement('option'); o.value = val; o.textContent = lbl; return o; };
    sel.appendChild(mkOpt('blue',   blueNm   || 'Blue team'));
    sel.appendChild(mkOpt('orange', orgNm    || 'Orange team'));
    if (teams.length) {
      const sep = document.createElement('option'); sep.disabled = true; sep.textContent = '──────────'; sel.appendChild(sep);
      teams.forEach((t, i) => sel.appendChild(mkOpt('__saved_' + i, t.name || '(unnamed)')));
    }
    sel.appendChild(mkOpt('__custom__', '— Custom name… —'));
    // Restore previous selection if it still makes sense
    if (prev && Array.from(sel.options).some((o) => o.value === prev)) sel.value = prev;
    // Auto-suggest: KNOW THE WINNER from the live series score (the leading side) and SUGGEST the
    // series score as the subtitle — until the producer overrides either.
    const auto = window._winnerAuto;
    const seriesTotal = ((state && state.series && Number(state.series.blue)) || 0)
                      + ((state && state.series && Number(state.series.orange)) || 0);
    if (seriesTotal === 0) { auto.sideManual = false; auto.subTouched = false; auto.lastScore = ''; }  // fresh match → re-arm
    if (!auto.sideManual) {
      const lead = window._winnerLeadingSide(state);
      if (lead && Array.from(sel.options).some((o) => o.value === lead)) sel.value = lead;
    }
    const subEl = el('input-winner-subtitle');
    const score = window._winnerSeriesScore(state, sel.value);
    if (subEl) {
      subEl.placeholder = score || '2025 Spring Champions';
      // Keep the suggestion in sync while it's still ours (empty, or the score we last filled) and the
      // producer isn't typing in it. Once they type their own subtitle, subTouched stops us.
      if (score && !auto.subTouched && document.activeElement !== subEl &&
          (!subEl.value.trim() || subEl.value === auto.lastScore)) {
        subEl.value = score;
        auto.lastScore = score;
      }
    }
    // Show/hide custom name row
    const row = el('winner-custom-row');
    if (row) row.style.display = (sel.value === '__custom__') ? '' : 'none';
  };

  window._gfxRefreshStandingsLeagues = function (state) {
    const sel = el('gfx-std-league'); if (!sel) return;
    if (typeof lgPopulateLeagueSelect === 'function') lgPopulateLeagueSelect(sel, (state && state.leagues) || []);
    // Re-select the league the on-air board is actually following, so re-opening the panel (or
    // relaunching) shows the live source rather than defaulting to the first league in the list.
    const followed = (state && state.standings && state.standings.leagueId) || '';
    if (followed && document.activeElement !== sel && [...sel.options].some((o) => o.value === followed)) {
      sel.value = followed;
    }
    gfxRefreshStandingsPreview();
    gfxRefreshSgStandingsPreview();
  };

  // Bracket-phase source for Standings: pick any loaded phase (Pool Play / Swiss / Round Robin /
  // elimination) and, if it has multiple pools, which pool — independent of whichever phase/pool
  // is currently ACTIVE on the Bracket scene itself (that's a different, live-switched concept).
  function gfxStdBktPools() {
    const phaseSel = el('gfx-std-bkt-phase'), poolRow = el('gfx-std-bkt-pool-row'), poolSel = el('gfx-std-bkt-pool');
    if (!phaseSel || !poolSel) return;
    const phases = (currentState && currentState.bracket && currentState.bracket.phases) || [];
    const ph = phases.find((p) => p.id === phaseSel.value);
    const pools = (ph && Array.isArray(ph.pools)) ? ph.pools : [];
    const prev = poolSel.value;
    if (pools.length > 1) {
      poolSel.innerHTML = '<option value="">Select pool…</option>';
      pools.forEach((pl) => {
        const opt = document.createElement('option');
        opt.value = pl.id; opt.textContent = pl.name || pl.id;
        if (pl.id === prev) opt.selected = true;
        poolSel.appendChild(opt);
      });
      poolRow.style.display = '';
    } else {
      poolSel.innerHTML = '<option value="">Select pool…</option>';
      poolRow.style.display = 'none';
    }
  }
  window._gfxRefreshStandingsBracketPhases = function (state) {
    const sel = el('gfx-std-bkt-phase'); if (!sel) return;
    const prev = sel.value;
    const phases = (state && state.bracket && state.bracket.phases) || [];
    sel.innerHTML = '<option value="">Select phase…</option>';
    phases.forEach((ph) => {
      const opt = document.createElement('option');
      opt.value = ph.id; opt.textContent = ph.name || ph.id;
      if (ph.id === prev) opt.selected = true;
      sel.appendChild(opt);
    });
    gfxStdBktPools();
  };
  el('gfx-std-bkt-phase')?.addEventListener('change', gfxStdBktPools);

  window._gfxRefreshScheduleQueue = gfxRenderScheduleQueue;
  window._schSetMatches = function(matches) { _schMatches = matches.slice(); schRenderList(); schAutoSave(); };

  window.addEventListener('resize', fitScenePreviews);

  // ── GFX Bracket panel — guided source switcher (start.gg / Challonge / NXGEN / Manual) ──
  (function () {
    // Segmented source picker: show only the chosen source's input.
    function bktSetSrc(src) {
      document.querySelectorAll('#gfx-bkt-srctabs .gfx-src-tab').forEach((t) => t.classList.toggle('is-on', t.dataset.bktsrc === src));
      document.querySelectorAll('#gfx-front-bracket .gfx-bkt-srcwrap').forEach((w) => { w.style.display = w.dataset.bktwrap === src ? '' : 'none'; });
    }
    document.querySelectorAll('#gfx-bkt-srctabs .gfx-src-tab').forEach((t) => t.addEventListener('click', () => bktSetSrc(t.dataset.bktsrc)));
    // renderBracketCC() lights the tab that matches the bracket actually loaded, so the panel
    // never opens on "Tournament Organizer" while a custom bracket is the thing on air.
    window._bktSetSrc = bktSetSrc;

    // Mirror a status field from the ESPORTS #bracket-status line for ~15s after an import kicks off.
    function mirrorBracketStatus(statusEl) {
      const srcEl = el('bracket-status'); if (!srcEl || !statusEl) return;
      const obs = new MutationObserver(() => { if (srcEl.textContent) statusEl.textContent = srcEl.textContent; });
      obs.observe(srcEl, { childList: true, characterData: true, subtree: true });
      setTimeout(() => obs.disconnect(), 15000);
    }

    // start.gg — reuse the ESPORTS bracket machinery (slug field + fetch button).
    el('gfx-bkt-fetch')?.addEventListener('click', () => {
      const slug = (el('gfx-bkt-slug')?.value || '').trim();
      const statusEl = el('gfx-bkt-sg-status');
      if (!slug) { if (statusEl) statusEl.textContent = 'Enter an event URL or slug first.'; return; }
      const target = el('input-bracket-slug'); if (target) target.value = slug;
      el('btn-bracket-fetch')?.click();
      if (statusEl) statusEl.textContent = 'Importing…';
      mirrorBracketStatus(statusEl);
    });

    // One paste box for every platform. The link already identifies the service, so route on it
    // rather than making a producer choose the right field mid-show. An NXGEN slug is the only
    // one with no distinctive URL, so it is the fallback for a bare slug that isn't a start.gg path.
    function bktRouteLink(raw) {
      const v = String(raw || '').trim();
      if (!v) return null;
      if (/challonge\.com/i.test(v)) return { kind: 'challonge', msg: 'load_challonge_tournament', data: { slug: v } };
      if (/faceit\.com/i.test(v)) return { kind: 'faceit', msg: 'load_faceit_event', data: { id: v } };
      if (/start\.gg|smash\.gg/i.test(v) || /^tournament\//i.test(v)) return { kind: 'startgg', msg: 'load_startgg_url', data: { url: v } };
      if (/^[0-9a-f-]{20,}$/i.test(v)) return { kind: 'faceit', msg: 'load_faceit_event', data: { id: v } };
      return { kind: 'nxgen', msg: 'load_nxgen_event', data: { slug: v } };
    }
    el('gfx-bkt-any-go')?.addEventListener('click', () => {
      const statusEl = el('gfx-bkt-any-status');
      const r = bktRouteLink(el('gfx-bkt-any')?.value);
      if (!r) { if (statusEl) statusEl.textContent = 'Paste a bracket link or slug first.'; return; }
      const LBL = { startgg: 'start.gg', challonge: 'Challonge', nxgen: 'NXGEN', faceit: 'FACEIT' };
      send(r.msg, r.data);
      if (statusEl) statusEl.textContent = 'Importing from ' + LBL[r.kind] + '…';
      mirrorBracketStatus(statusEl);
    });
    el('gfx-bkt-any')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); el('gfx-bkt-any-go')?.click(); }
    });

    // Re-pull whatever the Dashboard has active, with no link to find. Also the action behind
    // the status header's "Sync now" and every button the truth bar renders, so there is exactly
    // one way back to the live event no matter which of them a producer reaches for.
    function bktReloadActiveEvent() {
      const ae = (typeof currentState !== 'undefined' && currentState && currentState.activeEvent) || {};
      const statusEl = el('gfx-bkt-any-status');
      const slug = (ae.slug || '').trim();
      if (!ae.platform || !slug) {
        showToast('No active event to load — set one as Active on the Dashboard, or paste a link under Source.', '#fbbf24');
        if (statusEl) statusEl.textContent = 'No active event to reload.';
        return;
      }
      if (ae.platform === 'challonge') send('load_challonge_tournament', { slug });
      else if (ae.platform === 'nxgen') send('load_nxgen_event', { slug });
      else if (ae.platform === 'faceit') send('load_faceit_event', { id: slug });
      else send('fetch_bracket', { eventSlug: slug });
      showToast('Loading ' + (ae.name || slug) + '…', '#60a5fa');
      if (statusEl) statusEl.textContent = 'Reloading ' + (ae.name || slug) + '…';
      mirrorBracketStatus(statusEl);
    }
    window._bktReloadActiveEvent = bktReloadActiveEvent;
    el('gfx-bkt-reload')?.addEventListener('click', bktReloadActiveEvent);

    // Challonge — same load path the platform tab uses.
    el('gfx-bkt-ch-fetch')?.addEventListener('click', () => {
      const slug = (el('gfx-bkt-ch-slug')?.value || '').trim();
      const statusEl = el('gfx-bkt-ch-status');
      if (!slug) { if (statusEl) statusEl.textContent = 'Enter a Challonge URL or slug first.'; return; }
      send('load_challonge_tournament', { slug });
      if (statusEl) statusEl.textContent = 'Importing from Challonge…';
      mirrorBracketStatus(statusEl);
    });

    // NXGEN — same load path the platform tab uses.
    el('gfx-bkt-nx-fetch')?.addEventListener('click', () => {
      const slug = (el('gfx-bkt-nx-slug')?.value || '').trim();
      const statusEl = el('gfx-bkt-nx-status');
      if (!slug) { if (statusEl) statusEl.textContent = 'Enter an NXGEN event slug first.'; return; }
      send('load_nxgen_event', { slug });
      if (statusEl) statusEl.textContent = 'Importing from NXGEN…';
      mirrorBracketStatus(statusEl);
    });

    // FACEIT — same load path the platform tab uses. The server pulls the id + kind out of a
    // pasted link, so a bare UUID and a full championship/hub URL both work here.
    el('gfx-bkt-fc-fetch')?.addEventListener('click', () => {
      const id = (el('gfx-bkt-fc-slug')?.value || '').trim();
      const statusEl = el('gfx-bkt-fc-status');
      if (!id) { if (statusEl) statusEl.textContent = 'Paste a FACEIT championship or hub link first.'; return; }
      send('load_faceit_event', { id });
      if (statusEl) statusEl.textContent = 'Importing from FACEIT…';
      mirrorBracketStatus(statusEl);
    });

    // Manual — pick a format + size on the front card, scaffold an empty bracket in the builder,
    // then open the full editor. Drives the existing builder controls (#bb-type-seg / #bb-size).
    document.querySelectorAll('#gfx-bkt-mformat .gfx-src-tab').forEach((t) => t.addEventListener('click', () => {
      document.querySelectorAll('#gfx-bkt-mformat .gfx-src-tab').forEach((x) => x.classList.toggle('is-on', x === t));
    }));
    el('gfx-bkt-mbuild')?.addEventListener('click', async () => {
      const fmt = document.querySelector('#gfx-bkt-mformat .gfx-src-tab.is-on')?.dataset.mfmt || 'single';
      const size = el('gfx-bkt-msize')?.value || '8';
      const statusEl = el('gfx-bkt-m-status');
      // This button REPLACES the loaded bracket and flips the scene to manual mode, which stops
      // the connected event's auto-refresh. One unconfirmed click used to turn a live five-stage
      // start.gg import into an empty 8-team board — with the Source panel still cheerfully
      // reporting "Following: <event>" while nothing updated again.
      const cur = (currentState && currentState.bracket) || {};
      if (cur.mode === 'imported' && ((cur.phases || []).length || cur.lastFetchAt)) {
        const src = ({ startgg: 'start.gg', challonge: 'Challonge', nxgen: 'NXGEN', faceit: 'FACEIT' })[cur.source] || 'a platform';
        const nph = (cur.phases || []).length;
        const ok = await appConfirm(
          `This replaces the ${src} import "${cur.title || 'Bracket'}"${nph ? ` (${nph} stage${nph > 1 ? 's' : ''})` : ''} with an empty ${size}-team ${fmt} bracket, and stops it auto-updating from the event. Continue?`,
          'Replace it', true);
        if (!ok) return;
      }
      // Drive the builder's own controls so its model + rendering stay the single source of truth.
      const typeBtn = document.querySelector(`#bb-type-seg .seg-btn[data-type="${fmt}"]`);
      if (typeBtn) typeBtn.click();
      const sizeSel = el('bb-size'); if (sizeSel) { sizeSel.value = size; sizeSel.dispatchEvent(new Event('change')); }
      if (typeof bbGenerate === 'function') bbGenerate();
      if (typeof bbSendPhases === 'function') bbSendPhases();   // persist as manual mode
      if (statusEl) statusEl.textContent = `Built an empty ${size}-team ${fmt} bracket — opening editor…`;
      el('gfx-popout-summary-open')?.click();   // open the Full Board (the full builder)
    });

    // League — fully front-facing: pick a league, the rows flow through the same set_standings
    // pipeline the Standings scene's League source uses (bracket.html already prefers
    // data.standings.rows over its own computed standings), while title/subtitle/showRecord and
    // the view mode are Bracket-owned display fields sent via set_bracket_settings.
    function bktPushLeagueRows() {
      const rows = buildLeagueStandingsRows(el('gfx-bkt-league')?.value);
      if (rows) send('set_standings', { source: 'league', rows });
    }
    el('gfx-bkt-league')?.addEventListener('change', () => {
      send('set_bracket_settings', { view: 'standings' });
      bktPushLeagueRows();
    });
    el('gfx-bkt-title')?.addEventListener('input', function () { send('set_bracket_settings', { title: this.value }); });
    el('gfx-bkt-subtitle')?.addEventListener('input', function () { send('set_bracket_settings', { subtitle: this.value }); });
    el('gfx-bkt-showrecord')?.addEventListener('change', function () { send('set_bracket_settings', { showRecord: this.checked }); });
    el('gfx-bkt-ignore-reset')?.addEventListener('change', function () { send('set_bracket_settings', { ignoreReset: this.checked }); });
    el('gfx-bkt-ignore-rounds')?.addEventListener('change', function () { send('set_bracket_settings', { ignoreRounds: Math.max(0, Math.min(12, parseInt(this.value, 10) || 0)) }); });
    el('gfx-bkt-hide-logos')?.addEventListener('change', function () { send('set_bracket_settings', { hideLogos: this.checked }); });
    el('gfx-bkt-logo-wm')?.addEventListener('change', function () { send('set_bracket_settings', { logoWatermark: this.checked }); });
    // Live readout while dragging (input), but only SEND on release (change) — a slider fires
    // input per pixel and each send is a state write + a full broadcast.
    el('gfx-bkt-wm-op')?.addEventListener('input', function () { const v = el('gfx-bkt-wm-op-val'); if (v) v.textContent = this.value + '%'; });
    el('gfx-bkt-wm-op')?.addEventListener('change', function () { send('set_bracket_settings', { watermarkOpacity: parseInt(this.value, 10) }); });
    document.querySelector('#gfx-bkt-srctabs [data-bktsrc="league"]')?.addEventListener('click', () => {
      send('set_bracket_settings', { view: 'standings' });
      bktPushLeagueRows();
    });

    window._gfxRefreshBracketLeagues = function (state) {
      const sel = el('gfx-bkt-league'); if (!sel) return;
      if (typeof lgPopulateLeagueSelect === 'function') lgPopulateLeagueSelect(sel, (state && state.leagues) || []);
    };

    // Tournament Organizer — status line reflects whichever platform the Dashboard has active,
    // regardless of which one it is; no slug typing needed for the common case.
    const PLATFORM_LABEL = { startgg: 'start.gg', challonge: 'Challonge', nxgen: 'NXGEN', faceit: 'FACEIT' };
    window._gfxRefreshBracketOrgStatus = function (data) {
      const st = el('gfx-bkt-org-status'); if (!st) return;
      const ae = (data && data.activeEvent) || {};
      const bk = (data && data.bracket) || {};
      const rl = el('gfx-bkt-reload-wrap');
      if (rl) rl.style.display = (ae.platform && (ae.name || ae.slug)) ? '' : 'none';
      if (ae.platform && (ae.name || ae.slug)) {
        const label = `${ae.name || ae.slug} — ${PLATFORM_LABEL[ae.platform] || ae.platform}`;
        // "Following" is only true when the bracket is actually imported: a manual bracket makes
        // the server skip syncBracketToActiveEvent() entirely, so claiming to follow the event
        // was the single most misleading line on this panel.
        if (bk.mode === 'manual') {
          st.textContent = `Linked (NOT followed): ${label} — a custom bracket owns this scene. Reload below to switch back to the event.`;
          st.style.color = '#fbbf24';
        } else {
          st.textContent = `Following: ${label}`;
          st.style.color = 'var(--good, #4ade80)';
        }
      } else {
        st.textContent = 'No active event — paste a link below, or set one as Active from the Dashboard.';
        st.style.color = 'var(--muted)';
      }
      // Manual tab: say up front what "Build" would destroy, before the click.
      const mw = el('gfx-bkt-m-warn');
      if (mw) {
        const nph = (bk.phases || []).length;
        if (bk.mode === 'imported' && (nph || bk.lastFetchAt)) {
          const src = PLATFORM_LABEL[bk.source] || 'a platform';
          mw.textContent = `Building here replaces the live ${src} import "${bk.title || 'Bracket'}"${nph ? ` (${nph} stage${nph > 1 ? 's' : ''})` : ''} and stops it auto-updating.`;
          mw.style.display = '';
        } else {
          mw.style.display = 'none';
        }
      }
    };
  })();

  // ── Per-scene customization preset bars ────────────────────────────────────
  const GFX_FONTS = ['Industry', 'Bourgeois', 'Rajdhani', 'Barlow Condensed', 'Oswald', 'Bebas Neue',
    'Inter', 'Anton', 'Exo 2', 'Teko', 'Saira Condensed', 'Saira', 'Arial', 'Impact', 'Verdana'];
  const GFX_DEFAULT_ACCENT  = '#e83a8b';
  const GFX_DEFAULT_ACCENT2 = '#8b5cf6';

  function custBarHtml(sceneKey) {
    const fontOpts = `<option value="">— use global —</option>` +
      GFX_FONTS.map((f) => `<option value="${f}">${f}</option>`).join('');
    return `<div class="gfx-cust-bar" data-scene="${sceneKey}">
      <div class="gfx-cust-head">
        <span class="gfx-cust-title">PRESET</span>
        <span class="gfx-cust-active-name" data-cust-active="${sceneKey}">Brand theme</span>
        <button class="gfx-cust-toggle btn-icon" data-cust-toggle="${sceneKey}" title="Customize scene appearance">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M8 4a1 1 0 1 1 0-2 1 1 0 0 1 0 2zM8 9a1 1 0 1 1 0-2 1 1 0 0 1 0 2zM8 14a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/></svg>
        </button>
      </div>
      <div class="gfx-cust-body" data-cust-body="${sceneKey}" hidden>
        <div class="gfx-cust-preset-row">
          <select class="input-select gfx-cust-sel" data-cust-sel="${sceneKey}"></select>
          <button class="btn btn-xs gfx-cust-save" data-cust-save="${sceneKey}">Save As</button>
          <button class="btn btn-xs btn-danger gfx-cust-del" data-cust-del="${sceneKey}">Delete</button>
        </div>
        <div class="gfx-cust-fields">
          <label class="gfx-cust-field">
            <span class="gfx-cust-lbl">Accent</span>
            <input type="color" class="gfx-cust-color1" data-cust-c1="${sceneKey}" value="${GFX_DEFAULT_ACCENT}">
          </label>
          <label class="gfx-cust-field">
            <span class="gfx-cust-lbl">Accent 2</span>
            <input type="color" class="gfx-cust-color2" data-cust-c2="${sceneKey}" value="${GFX_DEFAULT_ACCENT2}">
          </label>
          <label class="gfx-cust-field gfx-cust-field-wide">
            <span class="gfx-cust-lbl">Font</span>
            <select class="input-select gfx-cust-font-sel" data-cust-font="${sceneKey}">${fontOpts}</select>
          </label>
        </div>
        <div class="gfx-cust-actions">
          <button class="btn btn-xs btn-secondary gfx-cust-apply" data-cust-apply="${sceneKey}">Apply Preview</button>
          <button class="btn btn-xs gfx-cust-reset" data-cust-reset="${sceneKey}">Reset</button>
        </div>
      </div>
    </div>`;
  }

  // The per-scene accent/accent-2/font "PRESET" bar is injected into #gfx-preset-mount by show()
  // for scenes whose overlays apply sceneConfig — default theming still comes from the active
  // brand kit (+ per-game theme); a preset is an explicit per-scene override on top.

  // Toggle expand/collapse of a customize body.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cust-toggle]');
    if (!btn) return;
    const key = btn.dataset.custToggle;
    const body = document.querySelector(`[data-cust-body="${key}"]`);
    if (body) body.hidden = !body.hidden;
  });

  // Build the config object from the current UI inputs for a scene.
  function custReadConfig(sceneKey) {
    const c1  = document.querySelector(`[data-cust-c1="${sceneKey}"]`);
    const c2  = document.querySelector(`[data-cust-c2="${sceneKey}"]`);
    const fnt = document.querySelector(`[data-cust-font="${sceneKey}"]`);
    return {
      accent:  (c1  && c1.value  !== GFX_DEFAULT_ACCENT)  ? c1.value  : '',
      accent2: (c2  && c2.value  !== GFX_DEFAULT_ACCENT2) ? c2.value  : '',
      font:    (fnt && fnt.value) ? fnt.value : '',
    };
  }

  // Save As — prompt for a name, then save.
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-cust-save]');
    if (!btn) return;
    const key = btn.dataset.custSave;
    const sel = document.querySelector(`[data-cust-sel="${key}"]`);
    const current = sel ? sel.value : 'Default';
    const name = await customPrompt('Save Preset', '', current === 'Default' ? '' : current, 'Save');
    if (name == null || !name.trim()) return;
    send('save_scene_preset', { scene: key, name: name.trim(), config: custReadConfig(key) });
  });

  // Delete preset (cannot delete Default).
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-cust-del]');
    if (!btn) return;
    const key = btn.dataset.custDel;
    const sel = document.querySelector(`[data-cust-sel="${key}"]`);
    const name = sel ? sel.value : '';
    if (!name || name === 'Default') { alert('Cannot delete the Default preset.'); return; }
    if (!(await appConfirm(`Delete preset "${name}"?`, 'Delete'))) return;
    send('delete_scene_preset', { scene: key, name });
  });

  // Activate preset from dropdown.
  document.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-cust-sel]');
    if (!sel) return;
    send('activate_scene_preset', { scene: sel.dataset.custSel, name: sel.value });
  });

  // Apply preview — send the current picker values live without saving.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cust-apply]');
    if (!btn) return;
    const key = btn.dataset.custApply;
    send('save_scene_preset', { scene: key, name: '__preview__', config: custReadConfig(key) });
  });

  // Reset — activate Default, restoring brand colors.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cust-reset]');
    if (!btn) return;
    const key = btn.dataset.custReset;
    send('activate_scene_preset', { scene: key, name: 'Default' });
  });

  const saved = (() => { try { return localStorage.getItem('gfx_active_grp'); } catch (_) { return null; } })();
  show(saved || 'break');
  setTimeout(fitScenePreviews, 120);
})();
