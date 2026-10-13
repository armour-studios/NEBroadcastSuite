'use strict';
// Roles / production teams — HTTP routes (moved out of server.js's startHttpServer; called at the same point, so
// route order is unchanged). Values server.js reassigns, or declares further down, are
// read and written through ctx (discordDataFile, marbleRaceManager, miniGameManager, predictionManager, twitchClient, wheelManager).
let
  BROADCAST_API_KEY, BROADCAST_REMOTE_URL, analytics, announceGameResult, app, axios,
  bridgeClients, broadcast, broadcastFullState, buildGameAnnouncement, buildLiveState,
  chatManager, fs, gameTimers, normalizePrediction, path, safeReadJson, safeWriteJson,
  saveTwitchData, startPredictionPolling, state, stopPredictionPolling;
let ctx;

module.exports = function registerRoleRoutes(c) {
  ctx = c;
  ({
    BROADCAST_API_KEY, BROADCAST_REMOTE_URL, analytics, announceGameResult, app, axios,
    bridgeClients, broadcast, broadcastFullState, buildGameAnnouncement, buildLiveState,
    chatManager, fs, gameTimers, normalizePrediction, path, safeReadJson, safeWriteJson,
    saveTwitchData, startPredictionPolling, state, stopPredictionPolling
  } = c);

  // ─── Roles / Production Teams (local store) ──────────────────────────────────

  const rolesFile = () => path.join(path.dirname(ctx.discordDataFile || path.join(require('os').homedir(), 'dummy')), 'roles.json');

  app.get('/api/roles', (req, res) => {
    try {
      const data = fs.existsSync(rolesFile()) ? safeReadJson(rolesFile(), { teams: [] }) : { teams: [] };
      res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/roles/teams', (req, res) => {
    try {
      const data = fs.existsSync(rolesFile()) ? safeReadJson(rolesFile(), { teams: [] }) : { teams: [] };
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: 'name required' });
      const team = { id: Date.now().toString(36), name, members: [] };
      data.teams.push(team);
      safeWriteJson(rolesFile(), data);
      res.json(team);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/roles/teams/:id', (req, res) => {
    try {
      const data = fs.existsSync(rolesFile()) ? safeReadJson(rolesFile(), { teams: [] }) : { teams: [] };
      const team = data.teams.find((t) => t.id === req.params.id);
      if (!team) return res.status(404).json({ error: 'Team not found' });
      if (req.body.name) team.name = req.body.name;
      if (Array.isArray(req.body.members)) team.members = req.body.members;
      safeWriteJson(rolesFile(), data);
      res.json(team);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/roles/teams/:id', (req, res) => {
    try {
      const data = fs.existsSync(rolesFile()) ? safeReadJson(rolesFile(), { teams: [] }) : { teams: [] };
      data.teams = data.teams.filter((t) => t.id !== req.params.id);
      safeWriteJson(rolesFile(), data);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Proxy: search registered broadcast users from the remote DB.
  // API key stays server-side — the client only hits localhost:3000.
  app.get('/api/broadcast-users/search', async (req, res) => {
    if (!BROADCAST_REMOTE_URL || !BROADCAST_API_KEY) {
      return res.json({ users: [] });
    }
    try {
      const r = await axios.get(`${BROADCAST_REMOTE_URL}/api/broadcast-users/search`, {
        params: { q: req.query.q || '' },
        headers: { 'x-api-key': BROADCAST_API_KEY },
        timeout: 5000
      });
      res.json(r.data);
    } catch (err) {
      console.warn('[broadcast-users] search proxy failed:', err.message);
      res.json({ users: [] });
    }
  });

  // Prediction creation
  app.post('/api/twitch/prediction/settings', (req, res) => {
    const { autoCreate, template, cooldown, overlayLoop, overlayHide, overlayHidden, hideInReplay } = req.body;
    if (typeof autoCreate === 'boolean') state.twitch.predictions.settings.autoCreate = autoCreate;
    if (template) state.twitch.predictions.settings.template = template;
    if (typeof cooldown === 'number') state.twitch.predictions.settings.cooldown = cooldown;
    if (typeof overlayLoop === 'number') state.twitch.predictions.settings.overlayLoop = overlayLoop;
    if (typeof overlayHide === 'number') state.twitch.predictions.settings.overlayHide = Math.max(1, Math.round(overlayHide));
    if (typeof overlayHidden === 'boolean') state.twitch.predictions.settings.overlayHidden = overlayHidden;
    if (typeof hideInReplay === 'boolean') state.twitch.predictions.settings.hideInReplay = hideInReplay;
    saveTwitchData();
    broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
    res.json({ ok: true });
  });

  app.post('/api/twitch/wheel/settings', (req, res) => {
    const { prizes, entryMethod, duration, requireLiveView } = req.body;
    if (Array.isArray(prizes)) state.twitch.wheel.prizes = prizes;
    if (entryMethod) state.twitch.wheel.settings.entryMethod = entryMethod;
    if (typeof duration === 'number') state.twitch.wheel.settings.duration = duration;
    if (typeof requireLiveView === 'boolean') state.twitch.wheel.settings.requireLiveView = requireLiveView;
    saveTwitchData();
    broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
    res.json({ ok: true });
  });

  app.post('/api/twitch/prediction/create', async (req, res) => {
    const { title, outcomes, duration } = req.body;
    console.log(`[Twitch] Create prediction: "${title}"`);

    if (!ctx.predictionManager) {
      return res.status(400).json({ error: 'Twitch not connected' });
    }

    if (!title || !outcomes || outcomes.length < 2) {
      return res.status(400).json({ error: 'Title and at least 2 outcomes required' });
    }

    try {
      const durationSeconds = duration || 300; // 5 min default
      const result = await ctx.predictionManager.createPrediction(
        title,
        outcomes,
        durationSeconds
      );

      // Update state with new prediction
      state.twitch.predictions.current = normalizePrediction(result, durationSeconds, outcomes);
      try { analytics.event('prediction_create'); } catch (e) {}

      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      saveTwitchData();
      startPredictionPolling();

      res.json({
        success: true,
        predictionId: result.id,
        prediction: state.twitch.predictions.current
      });
    } catch (err) {
      console.error('[Twitch] Prediction creation failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // If the app has no record of a running prediction, ADOPT the channel's live one from
  // Twitch (created on the dashboard / another tool, or lost across a relaunch or a
  // failed-create confusion) so resolve/lock/cancel still work on it.
  async function adoptActivePrediction() {
    if (state.twitch.predictions.current) return state.twitch.predictions.current;
    if (!ctx.twitchClient || !state.twitch.channelId) return null;
    try {
      const list = await ctx.twitchClient.getLatestPredictions(state.twitch.channelId, 5);
      const live = (list || []).find((p) => p.status === 'ACTIVE' || p.status === 'LOCKED');
      if (!live) return null;
      const endsAt = new Date(live.created_at).getTime() + (Number(live.prediction_window) || 0) * 1000;
      const secs = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
      state.twitch.predictions.current = normalizePrediction(live, secs);
      if (ctx.predictionManager) ctx.predictionManager.currentPrediction = live;
      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      saveTwitchData();
      console.log('[Twitch] Adopted live prediction from Twitch:', live.id, `"${live.title}"`);
      return state.twitch.predictions.current;
    } catch (e) {
      console.warn('[Twitch] adopt prediction failed:', e.message);
      return null;
    }
  }

  // Prediction resolution
  app.post('/api/twitch/prediction/resolve', async (req, res) => {
    const { outcomeId } = req.body;

    if (!ctx.predictionManager) {
      return res.status(400).json({ error: 'Twitch not connected' });
    }

    if (!(await adoptActivePrediction())) {
      return res.status(400).json({ error: 'No active prediction — none running on the channel either' });
    }

    if (!outcomeId) {
      return res.status(400).json({ error: 'Outcome ID required' });
    }

    try {
      const prior = state.twitch.predictions.current;
      stopPredictionPolling();
      const result = await ctx.predictionManager.resolvePrediction(outcomeId, prior?.id);
      const resolved = result
        ? normalizePrediction(result, 0)
        : { ...prior, state: 'RESOLVED', winningOutcomeId: outcomeId };
      state.twitch.predictions.current = resolved;
      try { analytics.event('prediction_resolve'); } catch (e) {}

      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      saveTwitchData();
      res.json({ success: true, message: 'Prediction resolved' });

      // Clear after overlay has time to show winner splash
      const resolvedId = resolved.id;
      setTimeout(() => {
        if (state.twitch.predictions.current?.id === resolvedId) {
          state.twitch.predictions.history.unshift(state.twitch.predictions.current);
          if (state.twitch.predictions.history.length > 50) state.twitch.predictions.history.pop();
          state.twitch.predictions.current = null;
          broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
          saveTwitchData();
        }
      }, 18000);
    } catch (err) {
      console.error('[Twitch] Prediction resolution failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Prediction lock (close voting window early)
  app.post('/api/twitch/prediction/lock', async (req, res) => {
    if (!ctx.predictionManager) return res.status(400).json({ error: 'Twitch not connected' });
    if (!(await adoptActivePrediction())) return res.status(400).json({ error: 'No active prediction — none running on the channel either' });
    try {
      await ctx.predictionManager.lockPrediction(state.twitch.predictions.current.id);
      res.json({ success: true });
    } catch (err) {
      console.error('[Twitch] Prediction lock failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Prediction cancel
  app.post('/api/twitch/prediction/cancel', async (req, res) => {
    if (!ctx.predictionManager) return res.status(400).json({ error: 'Twitch not connected' });
    if (!(await adoptActivePrediction())) return res.status(400).json({ error: 'No active prediction — none running on the channel either' });
    try {
      stopPredictionPolling();
      await ctx.predictionManager.cancelPrediction(state.twitch.predictions.current.id);
      state.twitch.predictions.current = null;
      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      saveTwitchData();
      res.json({ success: true });
    } catch (err) {
      console.error('[Twitch] Prediction cancel failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Wheel spin
  app.post('/api/twitch/wheel/spin', async (req, res) => {
    console.log(`[Twitch] Spin wheel`);

    if (!ctx.wheelManager) {
      return res.status(400).json({ error: 'Twitch not connected' });
    }

    if (!state.twitch.wheel.participants || state.twitch.wheel.participants.length === 0) {
      return res.status(400).json({ error: 'No participants in wheel' });
    }

    try {
      const result = ctx.wheelManager.spin(4000);
      try { analytics.event('wheel_spin'); } catch (e) {}

      // Broadcast spin state
      broadcastFullState();
      saveTwitchData();

      res.json({
        success: true,
        spinId: result.spinId,
        winner: result.winner,
        duration: result.duration
      });
    } catch (err) {
      console.error('[Twitch] Wheel spin failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Clear wheel participants
  app.post('/api/twitch/wheel/clear', async (req, res) => {
    console.log(`[Twitch] Clear wheel participants`);

    if (!ctx.wheelManager) {
      return res.status(400).json({ error: 'Twitch not connected' });
    }

    try {
      ctx.wheelManager.clearParticipants();
      broadcastFullState();
      saveTwitchData();

      res.json({ success: true, message: 'Participants cleared' });
    } catch (err) {
      console.error('[Twitch] Clear participants failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Mini-game creation (universal endpoint)
  app.post('/api/twitch/minigame/create', async (req, res) => {
    const { type, question, answers, correctAnswerIndex, options, prizes,
            targetNumber, keyword, teamA, teamB, maxGames, duration } = req.body;
    console.log(`[Twitch] Create mini-game: ${type}`);

    if (!ctx.miniGameManager) {
      return res.status(400).json({ error: 'Twitch not connected' });
    }

    const durationMs = duration ? Math.max(5000, Math.min(600000, Number(duration) * 1000)) : undefined;

    try {
      let game;
      if (type === 'trivia') {
        if (!question || !answers || answers.length < 2) {
          return res.status(400).json({ error: 'Trivia requires question and at least 2 answers' });
        }
        const correctIdx = (correctAnswerIndex !== undefined && correctAnswerIndex !== null)
          ? Number(correctAnswerIndex)
          : Math.floor(Math.random() * answers.length);
        game = ctx.miniGameManager.createTrivia(question, answers, correctIdx, durationMs);
      } else if (type === 'prediction' || type === 'vote') {
        if (!question || !options || options.length < 2) {
          return res.status(400).json({ error: 'Vote requires question and at least 2 options' });
        }
        game = type === 'prediction'
          ? ctx.miniGameManager.createPrediction(question, options, durationMs)
          : ctx.miniGameManager.createVote(question, options, durationMs);
      } else if (type === 'spin') {
        if (!prizes || prizes.length < 2) {
          return res.status(400).json({ error: 'Spin requires at least 2 prizes' });
        }
        game = ctx.miniGameManager.createSpin(prizes, durationMs);
      } else if (type === 'number_guess') {
        if (!question || targetNumber === undefined || targetNumber === null) {
          return res.status(400).json({ error: 'Number Guess requires a question and target number' });
        }
        game = ctx.miniGameManager.createNumberGuess(question, Number(targetNumber), durationMs);
      } else if (type === 'fastest_finger') {
        if (!keyword) {
          return res.status(400).json({ error: 'Fastest Finger requires a keyword' });
        }
        game = ctx.miniGameManager.createFastestFinger(keyword, durationMs);
      } else if (type === 'score_prediction') {
        game = ctx.miniGameManager.createScorePrediction(question, teamA, teamB, maxGames ? Number(maxGames) : 5, durationMs);
      } else {
        return res.status(400).json({ error: 'Unknown game type' });
      }

      try { analytics.event('minigame'); } catch (e) {}

      // Auto-finalize game after duration
      const gameId = game.id;
      const duration = game.duration || 30000;

      if (gameTimers.has(gameId)) {
        clearTimeout(gameTimers.get(gameId));
      }

      const timer = setTimeout(() => {
        if (ctx.miniGameManager && ctx.miniGameManager.currentGame?.id === gameId) {
          const result = ctx.miniGameManager.finalize();
          broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
          saveTwitchData();
          announceGameResult(result);
          console.log('[Twitch] Game auto-finalized:', gameId);
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

      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      saveTwitchData();

      // Announce in chat so viewers know the game started
      const chatAnnounce = buildGameAnnouncement(game);
      if (chatAnnounce && chatManager?.isConnected) chatManager.sendMessage(chatAnnounce);

      res.json({
        success: true,
        gameId: game.id,
        game
      });
    } catch (err) {
      console.error('[Twitch] Mini-game creation failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Mini-game response (chat interaction)
  app.post('/api/twitch/minigame/respond', async (req, res) => {
    const { userId, username, answer, optionId } = req.body;

    if (!ctx.miniGameManager) {
      return res.status(400).json({ error: 'Twitch not connected' });
    }

    try {
      const added = ctx.miniGameManager.addResponse(userId, username, answer, optionId);

      if (added) {
        broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      }

      res.json({ success: true, added });
    } catch (err) {
      console.error('[Twitch] Game response failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Finalize mini-game
  app.post('/api/twitch/minigame/finalize', async (req, res) => {
    if (!ctx.miniGameManager) {
      return res.status(400).json({ error: 'Twitch not connected' });
    }

    try {
      const gameId = ctx.miniGameManager.currentGame?.id;
      const { actualScore } = req.body || {};
      const result = ctx.miniGameManager.finalize(actualScore ? { actualScore } : {});

      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      saveTwitchData();
      announceGameResult(result);

      if (gameId) {
        setTimeout(() => {
          if (state.twitch.minigame.current?.id === gameId) {
            state.twitch.minigame.current = null;
            broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
          }
        }, 10000);
      }

      res.json({ success: true, result });
    } catch (err) {
      console.error('[Twitch] Game finalization failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Cancel mini-game
  app.post('/api/twitch/minigame/cancel', async (req, res) => {
    if (!ctx.miniGameManager) {
      return res.status(400).json({ error: 'Twitch not connected' });
    }

    try {
      const gameId = ctx.miniGameManager.currentGame?.id;
      if (gameId && gameTimers.has(gameId)) {
        clearTimeout(gameTimers.get(gameId));
        gameTimers.delete(gameId);
      }
      ctx.miniGameManager.cancel();
      state.twitch.minigame.current = null;
      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      saveTwitchData();
      res.json({ success: true });
    } catch (err) {
      console.error('[Twitch] Game cancel failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Marble Race — cross-platform chat game (everyone's marble races a 3D obstacle course).
  // Sibling namespace to /api/twitch/minigame/* (not nested under /api/twitch/) since Kick and
  // YouTube entries flow through this too.
  app.post('/api/marblerace/start', async (req, res) => {
    if (!ctx.marbleRaceManager) return res.status(400).json({ error: 'Marble race not initialized' });
    try {
      const { entryWindowSec, autoEnterViewers, customViewers } = req.body || {};
      const round = ctx.marbleRaceManager.startRound({
        entryWindowMs: (Number(entryWindowSec) || 30) * 1000,
        autoEnterViewers: !!autoEnterViewers,
        customViewers: Array.isArray(customViewers) ? customViewers : []
      });
      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      res.json({ success: true, marbleRace: round });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/marblerace/cancel', async (req, res) => {
    if (!ctx.marbleRaceManager) return res.status(400).json({ error: 'Marble race not initialized' });
    const cancelled = ctx.marbleRaceManager.cancel();
    broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
    res.json({ success: cancelled });
  });

  // Mini-game settings
  app.post('/api/twitch/minigame/settings', async (req, res) => {
    const { enabled, breakScreenGameType, defaultDuration, pointReward } = req.body;

    try {
      if (typeof enabled === 'boolean') {
        state.twitch.minigame.settings.enabled = enabled;
      }
      if (breakScreenGameType) {
        state.twitch.minigame.settings.breakScreenGameType = breakScreenGameType;
      }
      if (typeof defaultDuration === 'number') {
        state.twitch.minigame.settings.defaultDuration = defaultDuration;
      }
      if (pointReward !== undefined) {
        state.twitch.minigame.settings.pointReward = pointReward;
      }

      saveTwitchData();
      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });

      res.json({ success: true, settings: state.twitch.minigame.settings });
    } catch (err) {
      console.error('[Twitch] Settings error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
};
