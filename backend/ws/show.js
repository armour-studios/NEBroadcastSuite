'use strict';
// Show settings and on-air graphics state (labels, formats, preshow, spotlight, pulse) — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly; values server.js reassigns are
// read and written through ctx (savedBrandKits).
let
  REPLAY_STYLES, activePackage, bridgeClients, broadcast, broadcastFullState,
  sanitizePreshowPick, saveAppState, saveBrandKitsSoon, setGfxActive, state;
let ctx;

const handlers = {
  set_event_name(msg, ws) {
    state.eventName = msg.data.name || '';
    // Stamp the title as belonging to the event that's loaded right now, so re-activating that
    // same event (a refresh, a re-paste of its link) leaves the producer's wording alone.
    state.eventNameSlug = (state.startgg && state.startgg.selectedEvent && state.startgg.selectedEvent.eventSlug)
      || (state.activeEvent && state.activeEvent.slug) || state.eventNameSlug || '';
    saveAppState();
    broadcastFullState();
  },

  // Custom "GAME x | BEST OF x" label override (e.g. "UPCOMING MATCH" or any custom text).
  // Empty string restores the automatic GAME/BEST-OF text.
  set_game_label(msg, ws) {
    state.gameLabel = (typeof msg.data.text === 'string') ? msg.data.text : '';
    saveAppState();
    broadcastFullState();
  },

  set_round_label(msg, ws) {
    state.roundLabel = (typeof msg.data.text === 'string') ? msg.data.text : '';
    state.startgg.roundLabelAuto = false;   // hand-typed — retuneRoundLabel must not overwrite it
    state.startgg.roundLabelSetId = null;
    saveAppState();
    broadcastFullState();
  },

  set_speed_unit(msg, ws) {
    state.speedUnit = (msg.data && msg.data.unit === 'kmh') ? 'kmh' : 'mph';
    saveAppState();
    broadcastFullState();
  },

  set_date_format(msg, ws) {
    state.dateFormat = (msg.data && msg.data.format === 'intl') ? 'intl' : 'us';
    saveAppState();
    broadcastFullState();
  },

  // Replay ad slot (sponsor logo in the REPLAY transition + replay tag). Partial updates merge.
  set_replay(msg, ws) {
    const o = msg.data || {};
    const cur = state.replay || {};
    state.replay = {
      ...cur,   // keep the runtime program/preview buses — replacing the object wholesale emptied Preview mid-cue
      label: typeof o.label === 'string' ? o.label : (cur.label ?? 'REPLAY'),
      logo: ('logo' in o) ? (o.logo || null) : (cur.logo ?? null),
      outroLogo: ('outroLogo' in o) ? (o.outroLogo || null) : (cur.outroLogo ?? null),
      colorMode: ['mono', 'team', 'brand'].includes(o.colorMode) ? o.colorMode : (cur.colorMode || 'team'),
      skin: ('skin' in o) ? (o.skin || null) : (cur.skin ?? null),
      style: REPLAY_STYLES.includes(o.style) ? o.style : (cur.style || 'slam')
    };
    saveAppState();
    broadcastFullState();
  },

  // Scoreboard ad slot (sponsor logo on the end-of-match scorecard). Partial updates merge.
  set_scoreboard_ad(msg, ws) {
    const o = msg.data || {};
    const cur = state.scoreboardAd || {};
    state.scoreboardAd = {
      label: typeof o.label === 'string' ? o.label : (cur.label ?? 'PRESENTED BY'),
      logo: ('logo' in o) ? (o.logo || null) : (cur.logo ?? null),
      background: ('background' in o) ? (o.background || null) : (cur.background ?? null)
    };
    saveAppState();
    broadcastFullState();
  },

  // Desk footer manual override: a list of logos that replace the brand's desk sponsors on
  // the caster-desk scenes. Empty list → fall back to the active brand's desk-tagged sponsors.
  set_desk_footer(msg, ws) {
    const o = msg.data || {};
    if (Array.isArray(o.logos)) {
      state.deskFooter = { logos: o.logos.filter((l) => typeof l === 'string' && l).slice(0, 8) };
      saveAppState();
      broadcastFullState();
    }
  },

  set_preshow(msg, ws) {
    const p = msg.data || {};
    const cur = state.preshow || {};
    const topics = Array.isArray(p.topics)
      ? p.topics.filter((t) => t && typeof t === 'object').map((t) => ({
          text: typeof t.text === 'string' ? t.text.slice(0, 60) : '',
          sceneName: typeof t.sceneName === 'string' ? t.sceneName.slice(0, 100) : ''
        })).slice(0, 12)
      : cur.topics;
    const headline = typeof p.headline === 'string' ? p.headline.slice(0, 140) : (cur.headline ?? '');
    // The logo snapshot no longer travels in the live payload (see buildLiveState), so a panel
    // that echoes back an untouched pick sends it back logo-less. Keep the stored snapshot when
    // the name is unchanged — otherwise re-picking one slot would quietly wipe the other's logo.
    const predictions = Array.isArray(p.predictions)
      ? [0, 1].map((i) => {
          const next = sanitizePreshowPick(p.predictions[i]);
          const prev = (Array.isArray(cur.predictions) && cur.predictions[i]) || '';
          if (next && !next.logo && prev && prev.name === next.name && prev.logo) next.logo = prev.logo;
          return next;
        })
      : (Array.isArray(cur.predictions) ? cur.predictions : ['', '']);
    state.preshow = {
      headline, topics,
      activeTopicIndex: ('activeTopicIndex' in p) ? Math.max(0, parseInt(p.activeTopicIndex, 10) || 0) : (cur.activeTopicIndex ?? 0),
      homeScene: typeof p.homeScene === 'string' ? p.homeScene.slice(0, 100) : (cur.homeScene ?? ''),
      predictions
    };
    // Headline/topics are brand content — persist onto the active package too, so switching
    // packages (or kits) brings the right Desk Show topics back automatically.
    if (typeof p.headline === 'string' || Array.isArray(p.topics)) {
      const kit = ctx.savedBrandKits.find((b) => b.id === state.activeBrandKitId);
      const pkg = kit ? activePackage(kit) : null;
      if (kit && pkg) {
        pkg.topicsHeadline = headline;
        pkg.topics = topics;
        saveBrandKitsSoon();   // per-keystroke edits — write once typing stops (see saveBrandKitsSoon)
      }
    }
    saveAppState();
    broadcastFullState();
  },

  set_clock_format(msg, ws) {
    state.clock24h = !!msg.data.clock24h;
    saveAppState();
    broadcastFullState();
  },

  set_show_series(msg, ws) {
    state.showSeries = msg.data.show !== false;
    saveAppState();
    broadcastFullState();
  },

  // ── Player spotlight (featured-player lower-third) ───────────────────
  set_spotlight(msg, ws) {
    const p = msg.data || {};
    if (typeof p.visible === 'boolean') state.spotlight.visible = p.visible;
    if (typeof p.playerName === 'string') state.spotlight.playerName = p.playerName;
    broadcastFullState();
  },

  set_pulse(msg, ws) {
    if (msg.data) {
      if ('publish' in msg.data) state.pulse.publish = !!msg.data.publish;
      if (typeof msg.data.feedViewUrl === 'string') state.pulse.feedViewUrl = msg.data.feedViewUrl.trim().slice(0, 500);
      if (typeof msg.data.channel === 'string') state.pulse.channel = msg.data.channel.trim().slice(0, 60);
      if (typeof msg.data.label === 'string') state.pulse.label = msg.data.label.trim().slice(0, 40);
      saveAppState();
      broadcastFullState();
    }
  },

  // (set_upcoming / set_standings migrated to the WS_HANDLERS registry above handleControlMessage)

  // ── Unified graphics overlay (gfx.html) active scene ─────────────────
  set_gfx_active(msg, ws) {
    setGfxActive((msg.data && msg.data.scene) || null);
  },

  // Hard-reload every connected overlay/browser source — busts OBS's in-memory cache so they
  // pick up freshly-served code (used after overlay updates that OBS would otherwise keep stale).
  reload_overlays(msg, ws) {
    broadcast(bridgeClients, { type: 'reload_overlays' });
  },
};

module.exports = function createShowHandlers(c) {
  ctx = c;
  ({
    REPLAY_STYLES, activePackage, bridgeClients, broadcast, broadcastFullState,
    sanitizePreshowPick, saveAppState, saveBrandKitsSoon, setGfxActive, state
  } = c);
  return handlers;
};
