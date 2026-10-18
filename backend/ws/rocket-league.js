'use strict';
// Rocket League (scene automation, stats screens, director, native UI) — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly; values server.js reassigns are
// read and written through ctx (_boardShownAt, directorEngine, onRlSpectatorUiHotkeyChange, telemetry).
let
  autoSwitch, bridgeClients, broadcast, broadcastDirectorUpdate, broadcastFullState,
  clearPostGameBoard, logAuto, mergeDirectorRuntime, recordDirectorDecision, rlSpectatorUi,
  sanitizeScorebarDrop, sanitizeWorldsSidebar, saveAppState, scoreboardRoster, sendRlCommand, state,
  triggerClipCapture, triggerRlHideNativeUi;
let ctx;

const handlers = {
  // Overtime ad slot (sellable sponsor slot shown during OT). Partial updates merge.
  set_overtime(msg, ws) {
    const o = msg.data || {};
    const cur = state.overtime || {};
    state.overtime = {
      label: typeof o.label === 'string' ? o.label : (cur.label ?? 'OVERTIME'),
      logo: ('logo' in o) ? (o.logo || null) : (cur.logo ?? null),
      bg: o.bg || cur.bg || '#e0202a',
      color: o.color || cur.color || '#ffffff'
    };
    saveAppState();
    broadcastFullState();
  },

  force_scoreboard(msg, ws) {
    state.view = 'scoreboard';
    ctx._boardShownAt = Date.now();
    const roster = scoreboardRoster();
    state.scoreboard = {
      players: Object.values(roster).map((p) => ({ ...p })),
      blueScore: state.game.blueScore ?? 0,
      orangeScore: state.game.orangeScore ?? 0,
      series: { ...state.series }
    };
    broadcast(bridgeClients, { type: 'view_change', data: { view: 'scoreboard', playerCache: roster } });
  },

  force_hud(msg, ws) {
    if (state.view === 'scoreboard' || state.scoreboard) { clearPostGameBoard(); return; }
    state.view = 'hud';
    broadcast(bridgeClients, { type: 'view_change', data: { view: 'hud' } });
  },

  // ── RL scene automation (Match ▸ Teams panel) — opt-in kickoff + post-game OBS scene cuts ─────
  set_rl_scene_automation(msg, ws) {
    const p = msg.data || {};
    if (p.kickoff && typeof p.kickoff === 'object') {
      state.obs.kickoff = {
        enabled: !!p.kickoff.enabled,
        scene: typeof p.kickoff.scene === 'string' ? p.kickoff.scene.trim() : '',
        transition: typeof p.kickoff.transition === 'string' ? p.kickoff.transition.trim() : ''
      };
    }
    if (p.scoreboardScene && typeof p.scoreboardScene === 'object') {
      state.obs.scoreboardScene = {
        enabled: !!p.scoreboardScene.enabled,
        scene: typeof p.scoreboardScene.scene === 'string' ? p.scoreboardScene.scene.trim() : '',
        transition: typeof p.scoreboardScene.transition === 'string' ? p.scoreboardScene.transition.trim() : ''
      };
    }
    if (p.postGame && typeof p.postGame === 'object') {
      state.obs.postGame = {
        enabled: !!p.postGame.enabled,
        scene: typeof p.postGame.scene === 'string' ? p.postGame.scene.trim() : '',
        delaySec: Math.max(1, Math.min(120, Math.round(Number(p.postGame.delaySec) || 20))),
        transition: typeof p.postGame.transition === 'string' ? p.postGame.transition.trim() : ''
      };
    }
    saveAppState();
    broadcastFullState();
  },

  // Post-game stats screen skin (RL scoreboard) — show/hide the stat table + pick its design.
  set_rl_stats_screen(msg, ws) {
    const p = msg.data || {};
    // MUST match the <option> list in the two Scoreboard style pickers (Settings ▸ Games ▸ Rocket
    // League and Match — Teams ▸ gear). 'compare' was added to the UI and to rl-hud.html
    // (renderStatCompare + the .sb-cmp-* styles) but never here, so the server rejected it and
    // kept the previous design — the producer picked Compare and nothing happened.
    const DESIGNS = ['default', 'glass', 'block', 'radar', 'compare'];
    const cur = state.rlStatsScreen || { showStats: true, design: 'default' };
    state.rlStatsScreen = {
      showStats: typeof p.showStats === 'boolean' ? p.showStats : cur.showStats,
      design: DESIGNS.includes(p.design) ? p.design : cur.design
    };
    saveAppState();
    broadcastFullState();
  },

  // Pause / resume the LIVE match via the Stats API SetMatchPaused command.
  set_rl_paused(msg, ws) {
    const paused = !!(msg.data && msg.data.paused);
    const ok = sendRlCommand('SetMatchPaused', { bPaused: paused });
    if (ok) {
      // Optimistic — the MatchPaused/MatchUnpaused event will confirm/correct it.
      state.rlPaused = paused;
      logAuto('rlpause', paused ? 'Match paused (SetMatchPaused)' : 'Match resumed (SetMatchPaused)');
    } else {
      logAuto('rlpause', 'Pause/resume failed — RL Stats API not connected');
    }
    broadcastFullState();
  },

  // Manual "clear the post-game board now" (it otherwise holds until the next kickoff).
  clear_scoreboard(msg, ws) {
    clearPostGameBoard();
  },

  set_rl_replay_transitions(msg, ws) {
    state.rlReplayTransitions = !!(msg.data && msg.data.on);
    saveAppState();
    broadcastFullState();
  },

  set_rl_sponsor_roll(msg, ws) {
    state.rlSponsorRoll = !!(msg.data && msg.data.on);
    saveAppState();
    broadcastFullState();
  },

  set_worlds_sidebar(msg, ws) {
    state.worldsSidebar = sanitizeWorldsSidebar(msg.data || {});
    saveAppState();
    broadcastFullState();
  },

  // Scorebar drop-down (Settings > Games > Rocket League > Overlay): on/off, timing and the
  // producer's own messages. Sent whole; sanitizeScorebarDrop keeps only what the HUD can show.
  set_scorebar_drop(msg, ws) {
    const d = msg.data || {};
    state.scorebarDrop = sanitizeScorebarDrop({ ...state.scorebarDrop, ...d });
    saveAppState();
    broadcastFullState();
  },

  set_worlds_ticker(msg, ws) {
    state.worldsTicker = !!(msg.data && msg.data.on);
    saveAppState();
    broadcastFullState();
  },

  set_rl_scoreboard_separate(msg, ws) {
    state.rlScoreboardSeparate = !!(msg.data && msg.data.separate);
    saveAppState();
    broadcastFullState();
  },

  set_rl_hide_ui(msg, ws) {
    state.rlHudHidden = !!(msg.data && msg.data.hidden);
    broadcastFullState();
  },

  rl_hide_native_ui(msg, ws) {
    triggerRlHideNativeUi().catch((e) => console.warn('[rl: hide-native-ui failed]', (e && e.message) || e));
  },

  set_rl_spectator_ui(msg, ws) {
    const d = msg.data || {};
    state.rlSpectatorUi = {
      ...rlSpectatorUi.DEFAULTS,
      ...(state.rlSpectatorUi || {}),
      ...d
    };
    if ('enabled' in d) state.rlSpectatorUi.enabled = !!d.enabled;
    if ('autoOnMatch' in d) state.rlSpectatorUi.autoOnMatch = !!d.autoOnMatch;
    if ('focusWindow' in d) state.rlSpectatorUi.focusWindow = !!d.focusWindow;
    saveAppState();
    broadcastFullState();
    if (ctx.onRlSpectatorUiHotkeyChange) ctx.onRlSpectatorUiHotkeyChange();
  },

  // ── AI Auto-Director ─────────────────────────────────────────────────
  set_director(msg, ws) {
    const d = msg.data || {};
    if (ctx.directorEngine) {
      // Patch must only carry the keys the client actually sent — setSettings
      // tests key presence, so a present-but-undefined key wipes that setting.
      const patch = {};
      if ('enabled' in d) patch.enabled = !!d.enabled;
      if ('sensitivity' in d) patch.sensitivity = Number(d.sensitivity);
      if ('lockTarget' in d) patch.lockTarget = d.lockTarget || null;
      if ('autoSwitch' in d) patch.autoSwitch = !!d.autoSwitch;
      ctx.directorEngine.setSettings(patch);
      state.director = mergeDirectorRuntime(ctx.directorEngine.getState());
      autoSwitch.setEnabled(!!state.director.autoSwitch);
    } else if (state.director) {
      if ('enabled' in d) state.director.enabled = !!d.enabled;
      if ('sensitivity' in d) state.director.sensitivity = Math.max(0, Math.min(1, Number(d.sensitivity) || 0.5));
      if ('lockTarget' in d) state.director.lockTarget = d.lockTarget || null;
      if ('autoSwitch' in d) {
        state.director.autoSwitch = !!d.autoSwitch;
        autoSwitch.setEnabled(state.director.autoSwitch);
      }
    }
    saveAppState();
    broadcastDirectorUpdate();
  },

  director_feed_action(msg, ws) {
    const { feedId, action } = msg.data || {};
    const feedItem = (state.director?.feed || []).find((f) => f.id === feedId);
    if (!feedItem) return;
    (async () => {
      let clipOk = false;
      if (action === 'capture' || action === 'both') {
        const clip = await triggerClipCapture({
          type: feedItem.type,
          game: state.activeGame,
          player: feedItem.target || '',
          reason: feedItem.reason || 'Producer tagged from feed',
          label: `Feed — ${feedItem.type} ${feedItem.target || ''}`,
          captureKey: `feed:${feedId}`,
          feedTs: feedItem.ts,
          force: true
        });
        clipOk = !!clip;
      }
      if ((action === 'train' || action === 'both') && ctx.directorEngine) {
        ctx.directorEngine.recordFeedback({
          eventType: feedItem.type,
          targetId: feedItem.targetId || feedItem.target,
          action: 'accepted'
        });
        if (ctx.telemetry) ctx.telemetry.directorDecision({
          recommendation: { type: feedItem.type, target: { id: feedItem.targetId || null, name: feedItem.target || null }, reason: feedItem.reason || null },
          decision: 'accept', note: 'tagged from feed',
        });
        state.director = mergeDirectorRuntime(ctx.directorEngine.getState());
        broadcastDirectorUpdate();
      }
      ws.send(JSON.stringify({
        type: 'clips-result',
        data: {
          ok: clipOk || action === 'train',
          message: clipOk
            ? `Saved replay clip for ${feedItem.type} — ${feedItem.target || 'moment'}`
            : (action === 'train' ? 'Trained AI on feed moment' : 'Replay save failed — check OBS + replay buffer')
        }
      }));
    })();
  },

  director_feedback(msg, ws) {
    if (ctx.directorEngine && msg.data) {
      const action = msg.data.action || 'accepted';
      ctx.directorEngine.recordFeedback({
        eventType: msg.data.eventType || state.director?.primary?.type || 'unknown',
        targetId: msg.data.targetId || state.director?.primary?.target?.id,
        action
      });
      // Telemetry: map the engine action → a training decision label.
      const DEC = { accepted: 'accept', overridden: 'override', locked: 'lock', declined: 'decline', rejected: 'decline' };
      recordDirectorDecision(DEC[action] || 'accept', {
        chosen: msg.data.chosen || (msg.data.targetId ? { kind: 'player', id: msg.data.targetId } : null),
        note: msg.data.note || null,
      });
      state.director = mergeDirectorRuntime(ctx.directorEngine.getState());
      broadcastDirectorUpdate();
    }
  },

  director_accept(msg, ws) {
    if (ctx.directorEngine) {
      ctx.directorEngine.recordFeedback({
        eventType: state.director?.primary?.type,
        targetId: state.director?.primary?.target?.id,
        action: 'accepted'
      });
      recordDirectorDecision('accept', { note: (msg.data && msg.data.note) || null });
      state.director = mergeDirectorRuntime(ctx.directorEngine.getState());
      broadcastDirectorUpdate();
    }
  },

  // ── AI master controls (Shield kill-switch + telemetry) ───────────────
  set_ai_shield(msg, ws) {
    const on = !!(msg.data && msg.data.on);
    if (!state.ai) state.ai = { shield: false, telemetry: { enabled: true, uploadEnabled: false, lastUploadAt: null, lastUploadCount: 0 } };
    state.ai.shield = on;
    if (ctx.telemetry) ctx.telemetry.mark('shield', { on });
    console.log(`[AI] Shield ${on ? 'ENGAGED — all AI automations paused' : 'released'}`);
    saveAppState();
    broadcastFullState();
  },
};

module.exports = function createRocketLeagueHandlers(c) {
  ctx = c;
  ({
    autoSwitch, bridgeClients, broadcast, broadcastDirectorUpdate, broadcastFullState,
    clearPostGameBoard, logAuto, mergeDirectorRuntime, recordDirectorDecision, rlSpectatorUi,
    sanitizeScorebarDrop, sanitizeWorldsSidebar, saveAppState, scoreboardRoster, sendRlCommand, state,
    triggerClipCapture, triggerRlHideNativeUi
  } = c);
  return handlers;
};
