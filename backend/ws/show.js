'use strict';
// Show settings and on-air graphics state (labels, formats, preshow, break, spotlight, pulse) — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly; values server.js reassigns are
// read and written through ctx (miniGameManager, savedBrandKits).
let
  REPLAY_STYLES, activePackage, announceGameResult, bridgeClients, broadcast,
  broadcastFullState, buildLiveState, flowBus, gameTimers, obsSwitch, resolveClockTarget,
  sanitizePreshowPick, saveAppState, saveBrandKitsSoon, saveTwitchData,
  scheduleBreakAutoSwitch, setExclusiveGfxVisible, setGfxActive, state;
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

  // ── Break / "starting soon" standby (countdown scene) ────────────────
  // Partial updates merge. endsAt = epoch ms target (or null to clear the timer).
  set_break(msg, ws) {
    const b = msg.data || {};
    const cur = state.breakScreen || {};
    state.breakScreen = {
      visible: ('visible' in b) ? !!b.visible : !!cur.visible,
      title: typeof b.title === 'string' ? b.title : (cur.title ?? 'STARTING SOON'),
      message: typeof b.message === 'string' ? b.message : (cur.message ?? ''),
      finalMessage: typeof b.finalMessage === 'string' ? b.finalMessage : (cur.finalMessage ?? "WE'RE LIVE!"),
      // accept either an absolute endsAt, a `seconds` countdown from now, or a
      // `frozenSeconds` static value (paused producer timer). Running clears frozen.
      // `until: "23:00"` counts down to a wall-clock time; `seconds` counts down a duration;
      // `endsAt` is an absolute target; `frozenSeconds` is a paused static value.
      endsAt: ('frozenSeconds' in b) ? null
        : ('until' in b) ? resolveClockTarget(b.until)
        : ('seconds' in b) ? (b.seconds > 0 ? Date.now() + Math.round(b.seconds * 1000) : null)
        : ('endsAt' in b ? (b.endsAt || null) : (cur.endsAt ?? null)),
      frozenSeconds: ('frozenSeconds' in b) ? (b.frozenSeconds != null ? Math.max(0, Math.round(b.frozenSeconds)) : null)
        : (('seconds' in b || 'endsAt' in b || 'until' in b) ? null : (cur.frozenSeconds ?? null)),
      // Draw the title without a clock. Sticky like the other look settings: a bare timer
      // mirror ({seconds}/{frozenSeconds}) must not silently switch the clock back on.
      titleOnly: ('titleOnly' in b) ? !!b.titleOnly : !!cur.titleOnly,
      // OBS scene to auto-cut to when the countdown reaches 0 ('' = stay on the break screen).
      // Deliberately the ONLY thing a finished countdown can do: it never rolls a clip/ad playlist.
      thenScene: typeof b.thenScene === 'string' ? b.thenScene : (cur.thenScene ?? '')
    };
    // HIDE DISARMS THE CLOCK. Every consumer treats "break hidden" as "there is no countdown"
    // (the panel drops its mirror, the desk/replay/countdown-bar scenes blank their clock), but
    // the merge above kept `endsAt` alive through a Hide — leaving a half state the producer
    // could not see or clear. The counterpart to this is that those scenes no longer require
    // `visible`: the top-bar Start arms a segment clock WITHOUT putting the break GRAPHIC on
    // air, and that clock is exactly what the desk scenes borrow. Same reasoning as
    // scheduleBreakAutoSwitch: the timer is about the timer, not about which graphic is up.
    // Only a bare Hide clears it — a message that also sets a timer is setting one, not hiding one.
    if (b.visible === false && !('seconds' in b) && !('endsAt' in b) && !('until' in b) && !('frozenSeconds' in b)) {
      state.breakScreen.endsAt = null;
      state.breakScreen.frozenSeconds = null;
    }

    // Auto-start minigame when break screen becomes visible
    const wasVisible = cur.visible;
    const nowVisible = state.breakScreen.visible;
    // Keeps gfxActive in sync with .visible — see setExclusiveGfxVisible's own doc.
    if ('visible' in b) setExclusiveGfxVisible('break', nowVisible);

    if (!wasVisible && nowVisible && ctx.miniGameManager && state.twitch.minigame.settings.enabled) {
      // Break screen just turned on - auto-start a game
      const gameType = state.twitch.minigame.settings.breakScreenGameType || 'trivia';
      console.log('[Twitch] Auto-starting minigame on break screen:', gameType);

      // Create a default game based on type
      const _blueTeam   = state.teams?.blue?.name   || 'Blue';
      const _orangeTeam = state.teams?.orange?.name || 'Orange';
      const _triviaPool = [
        { q: 'How many players are on a Rocket League team?',       a: ['2', '3', '4', '5'],                                                  c: 1 },
        { q: 'How long is a standard Rocket League match?',          a: ['3 minutes', '4 minutes', '5 minutes', '6 minutes'],                  c: 2 },
        { q: 'What does RLCS stand for?',                             a: ['Rocket League Club Series', 'Rocket League Championship Series', 'Rocket League Cup Showdown', 'Rocket League Circuit Season'], c: 1 },
        { q: 'Which rank is the highest in Rocket League?',           a: ['Grand Champion', 'Champion', 'Diamond', 'Supersonic Legend'],        c: 3 },
        { q: 'How many goals are needed to win a standard RL match?', a: ['Most in 5 min', 'First to 5', 'First to 3', 'Most in 3 min'],        c: 0 },
        { q: 'What colour is the Rocket League logo?',                a: ['Blue', 'Red', 'Green', 'Orange'],                                    c: 0 },
        { q: `Who do you think will win this series — ${_blueTeam} or ${_orangeTeam}?`, a: [_blueTeam, _orangeTeam, 'Going to OT!', 'No idea!'], c: 0 },
      ];
      const _trivia = _triviaPool[Math.floor(Math.random() * _triviaPool.length)];

      let autoGame = null;
      if (gameType === 'trivia') {
        autoGame = ctx.miniGameManager.createTrivia(_trivia.q, _trivia.a, _trivia.c);
      } else if (gameType === 'prediction') {
        autoGame = ctx.miniGameManager.createPrediction(
          `Who will win — ${_blueTeam} or ${_orangeTeam}?`,
          [_blueTeam, _orangeTeam]
        );
      } else if (gameType === 'vote') {
        autoGame = ctx.miniGameManager.createVote(
          `Who do you think wins this series?`,
          [_blueTeam, _orangeTeam]
        );
      } else if (gameType === 'spin') {
        autoGame = ctx.miniGameManager.createSpin(['Sub Gift', '$10 Gift Card', 'Game Key', 'Shoutout']);
      }

      if (autoGame) {
        const gameId = autoGame.id;
        const duration = autoGame.duration || 30000;

        if (gameTimers.has(gameId)) clearTimeout(gameTimers.get(gameId));

        const timer = setTimeout(() => {
          if (ctx.miniGameManager && ctx.miniGameManager.currentGame?.id === gameId) {
            const result = ctx.miniGameManager.finalize();
            broadcastFullState();
            saveTwitchData();
            announceGameResult(result);
            console.log('[Twitch] Auto-game finalized');
            setTimeout(() => {
              if (state.twitch.minigame.current?.id === gameId) {
                state.twitch.minigame.current = null;
                broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
              }
            }, 10000);
          }
          gameTimers.delete(gameId);
        }, duration);

        gameTimers.set(gameId, timer);
      }
    }

    if (!wasVisible && nowVisible) flowBus.emit('break_shown', {});
    if (wasVisible && !nowVisible) flowBus.emit('break_hidden', {});
    saveAppState();
    broadcastFullState();
    obsSwitch(state.breakScreen.visible ? 'break' : 'inGame');
    scheduleBreakAutoSwitch();
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
    REPLAY_STYLES, activePackage, announceGameResult, bridgeClients, broadcast,
    broadcastFullState, buildLiveState, flowBus, gameTimers, obsSwitch, resolveClockTarget,
    sanitizePreshowPick, saveAppState, saveBrandKitsSoon, saveTwitchData,
    scheduleBreakAutoSwitch, setExclusiveGfxVisible, setGfxActive, state
  } = c);
  return handlers;
};
