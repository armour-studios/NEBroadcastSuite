'use strict';
// Stats, analytics and historical import — HTTP routes (moved out of server.js's startHttpServer; called at the same point, so
// route order is unchanged). Values server.js reassigns, or declares further down, are
// read and written through ctx (_startggImportRunning, _twitchStatsCache, socialPublisher, startggApiToken).
let
  analytics, app, bridgeClients, broadcast, createStartGgClient, express, startggImport, state,
  stats, streamStateManager, twitchStats;
let ctx;

module.exports = function registerStatsAnalyticsRoutes(c) {
  ctx = c;
  ({
    analytics, app, bridgeClients, broadcast, createStartGgClient, express, startggImport,
    state, stats, streamStateManager, twitchStats
  } = c);

  // ─── Stats API ───────────────────────────────────────────────────────────────
  app.get('/api/stats/matches', (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      res.json({ ok: true, matches: stats.getRecentMatches(limit) });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  app.get('/api/stats/matches/:id', (req, res) => {
    try {
      const detail = stats.getMatchDetail(parseInt(req.params.id));
      if (!detail) return res.status(404).json({ ok: false, message: 'Not found' });
      res.json({ ok: true, match: detail });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  app.get('/api/stats/players', (req, res) => {
    try {
      const name = req.query.name || '';
      if (!name) return res.status(400).json({ ok: false, message: 'name param required' });
      res.json({ ok: true, history: stats.getPlayerHistory(name) });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  app.get('/api/stats/aggregate', (req, res) => {
    try { res.json({ ok: true, ...stats.getAggregateStats() }); }
    catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });
  // Deep analytics: player leaderboards (RL + CS2) and team records.
  app.get('/api/stats/leaders', (req, res) => {
    try { res.json({ ok: true, ...stats.getLeaders(Number(req.query.limit) || 25) }); }
    catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });
  app.get('/api/stats/teams', (req, res) => {
    try { res.json({ ok: true, teams: stats.getTeamRecords() }); }
    catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });
  app.get('/api/stats/h2h', (req, res) => {
    try { res.json({ ok: true, ...stats.getHeadToHead(req.query.a || '', req.query.b || '') }); }
    catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });
  // Cross-game player profile + the distinct-player list that feeds its picker.
  app.get('/api/stats/player-list', (req, res) => {
    try { res.json({ ok: true, players: stats.listPlayers() }); }
    catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });
  app.get('/api/stats/profile', (req, res) => {
    try {
      const name = req.query.name || '';
      if (!name) return res.status(400).json({ ok: false, message: 'name param required' });
      const profile = stats.getPlayerProfile(name);
      if (!profile) return res.status(404).json({ ok: false, message: 'no record for that player' });
      res.json({ ok: true, profile });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });
  app.get('/api/stats/player-event', (req, res) => {
    try {
      const { name, tournament } = req.query;
      if (!name || !tournament) return res.status(400).json({ ok: false, message: 'name and tournament params required' });
      const result = stats.getPlayerEventStats(name, tournament);
      res.json({ ok: true, stats: result || null });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  // ── Filtered analytics dashboard (single source of truth) ──────────────────
  app.get('/api/stats/filters', (req, res) => {
    try { res.json({ ok: true, ...stats.getFilterOptions() }); }
    catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });
  app.get('/api/stats/dashboard', (req, res) => {
    try {
      const f = { from: req.query.from ? Number(req.query.from) : 0, to: req.query.to ? Number(req.query.to) : 0,
        game: req.query.game || '', tournament: req.query.tournament || '' };
      res.json({ ok: true, filters: f, data: stats.getDashboard(f) });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  // ── Analytics: broadcast sessions (producer show reports) ──────────────────
  app.get('/api/analytics/overview', (req, res) => res.json({ ok: true, ...analytics.overview(req.query.event), auto: analytics.getAuto() }));
  app.get('/api/analytics/live', (req, res) => res.json({ ok: true, live: analytics.getLive() }));
  app.get('/api/analytics/sessions', (req, res) => res.json({ ok: true, sessions: analytics.getSessions() }));
  app.get('/api/analytics/session/:id', (req, res) => {
    const s = analytics.getSession(req.params.id);
    if (!s) return res.status(404).json({ ok: false, message: 'not found' });
    res.json({ ok: true, session: s });
  });
  app.post('/api/analytics/start', express.json({ limit: '2mb' }), (req, res) => res.json({ ok: true, live: analytics.startSession(req.body && req.body.label) }));
  app.post('/api/analytics/stop', (req, res) => res.json({ ok: true, session: analytics.stopSession() }));
  app.post('/api/analytics/auto', express.json({ limit: '2mb' }), (req, res) => { analytics.setAuto(!(req.body && req.body.on === false)); res.json({ ok: true, auto: analytics.getAuto() }); });
  app.delete('/api/analytics/session/:id', (req, res) => { analytics.deleteSession(req.params.id); res.json({ ok: true, sessions: analytics.getSessions() }); });
  // Clear ALL broadcast sessions (fresh reporting).
  app.delete('/api/analytics/sessions', (req, res) => { try { analytics.clearAllSessions(); } catch (e) {} res.json({ ok: true, sessions: analytics.getSessions() }); });
  app.delete('/api/stats/match/:id', (req, res) => { const ok = stats.deleteMatch(req.params.id); res.json({ ok }); });
  app.delete('/api/stats/matches', (req, res) => { stats.clearAllMatches(); res.json({ ok: true }); });
  app.delete('/api/stats/team/:name', (req, res) => { const n = stats.deleteMatchesByTeam(decodeURIComponent(req.params.name)); res.json({ ok: true, removed: n }); });
  app.delete('/api/stats/player/:name', (req, res) => { const n = stats.deletePlayerStats(decodeURIComponent(req.params.name)); res.json({ ok: true, removed: n }); });
  app.get('/api/analytics/export', (req, res) => {
    const out = analytics.exportCsv((req.query.session || '').toString());
    if (!out) return res.status(404).json({ ok: false, message: 'not found' });
    res.setHeader('Content-Disposition', `attachment; filename="${out.name}.csv"`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(out.csv);
  });

  // ── Twitch channel stats (followers / subs / past broadcasts / clips) ───────
  app.get('/api/twitch/stats', async (req, res) => {
    const token = state.twitch && state.twitch.apiToken;
    const userId = state.twitch && state.twitch.channelId;
    if (!token || !userId) return res.status(400).json({ ok: false, needsReconnect: true, message: 'Twitch is not connected. Connect it under Apps > Twitch to pull channel stats.' });
    if (!req.query.refresh && ctx._twitchStatsCache && (Date.now() - ctx._twitchStatsCache.at < 60000)) {
      return res.json({ ok: true, data: ctx._twitchStatsCache.data, cached: true });
    }
    try {
      const data = await twitchStats.fetchTwitchStats({ clientId: process.env.TWITCH_CLIENT_ID, accessToken: token, userId });
      ctx._twitchStatsCache = { at: Date.now(), data };
      res.json({ ok: true, data });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  // YouTube channel stats — subscriber count, video views, recent uploads, live viewer count
  app.get('/api/youtube/stats', async (req, res) => {
    if (!ctx.socialPublisher) return res.status(503).json({ ok: false, message: 'Social publisher not initialised.' });
    if (!ctx.socialPublisher.getConnections().youtube.connected) return res.status(400).json({ ok: false, needsConnect: true, message: 'YouTube not connected — connect via Settings → Social.' });
    try {
      const data = await ctx.socialPublisher.getYouTubeStats();
      if (!data) return res.status(400).json({ ok: false, needsConnect: true, message: 'YouTube not connected.' });
      res.json({ ok: true, data });
    } catch (e) {
      console.error('[youtube/stats]', e.message);
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  // ── Import historical results from the producer's own start.gg tournaments ──
  // Runs in the background; progress + final summary are pushed over WS ('startgg_import').
  app.post('/api/stats/import-startgg', express.json({ limit: '2mb' }), (req, res) => {
    if (!ctx.startggApiToken) return res.status(400).json({ ok: false, message: 'Connect start.gg under Apps > start.gg first.' });
    if (ctx._startggImportRunning) return res.status(409).json({ ok: false, message: 'An import is already running.' });
    const nameQuery = (req.body && req.body.nameQuery || 'rocket rush').toString().slice(0, 80);
    const gameQuery = (req.body && req.body.gameQuery || 'rocket league').toString().slice(0, 80);
    ctx._startggImportRunning = true;
    const client = createStartGgClient(ctx.startggApiToken);
    const onProgress = (p) => broadcast(bridgeClients, { type: 'startgg_import', data: p });
    res.json({ ok: true, started: true });
    startggImport.importFromStartgg({ client, stats, nameQuery, gameQuery, onProgress })
      .then((summary) => { broadcast(bridgeClients, { type: 'startgg_import', data: { message: 'Import complete.', summary, done: true } }); })
      .catch((err) => { broadcast(bridgeClients, { type: 'startgg_import', data: { message: 'Import failed: ' + err.message, error: true, done: true } }); })
      .finally(() => { ctx._startggImportRunning = false; });
  });

  // Import ONE searched start.gg event (find-and-add) into the stats DB.
  app.post('/api/stats/import-startgg-event', express.json({ limit: '2mb' }), (req, res) => {
    if (!ctx.startggApiToken) return res.status(400).json({ ok: false, message: 'Connect start.gg under Apps > start.gg first.' });
    if (ctx._startggImportRunning) return res.status(409).json({ ok: false, message: 'An import is already running.' });
    const eventId = req.body && req.body.eventId;
    if (!eventId) return res.status(400).json({ ok: false, message: 'eventId required' });
    const tournamentName = (req.body.tournamentName || '').toString().slice(0, 120);
    const gameType = (req.body.gameType || 'rl').toString();
    ctx._startggImportRunning = true;
    const client = createStartGgClient(ctx.startggApiToken);
    const onProgress = (p) => broadcast(bridgeClients, { type: 'startgg_import', data: p });
    res.json({ ok: true, started: true });
    startggImport.importEventById({ client, stats, eventId, tournamentName, gameType, onProgress })
      .then((summary) => { broadcast(bridgeClients, { type: 'startgg_import', data: { message: 'Import complete.', summary, done: true } }); })
      .catch((err) => { broadcast(bridgeClients, { type: 'startgg_import', data: { message: 'Import failed: ' + err.message, error: true, done: true } }); })
      .finally(() => { ctx._startggImportRunning = false; });
  });

  // ── Analytics: event / tournament (computed live from start.gg + bracket + stats) ──
  app.get('/api/analytics/event', (req, res) => {
    try {
      const sg = state.startgg || {}, br = state.bracket || {};
      let total = 0, done = 0;
      const countRounds = (rounds) => (rounds || []).forEach((r) => (r.sets || []).forEach((s) => {
        total++; if ((s.a && s.a.winner) || (s.b && s.b.winner)) done++;
      }));
      countRounds(br.winners); countRounds(br.losers); countRounds(br.finals);
      const feed = sg.matchFeed || [], queue = sg.queue || [];
      const liveCount = feed.filter((m) => m.status === 'live' || m.state === 2).length;
      const doneCount = feed.filter((m) => m.status === 'done' || m.state === 3).length;
      const upcomingCount = (queue.filter((m) => m.state === 1 || m.status === 'upcoming').length) || Math.max(0, (queue.length - liveCount));
      const sel = sg.selectedEvent || {};
      res.json({ ok: true, data: {
        event: { name: sel.name || state.eventName || '', tournament: sel.tournamentName || '', game: state.activeGame || '',
          entrants: (sg.eventTeams || []).length || 0 },
        bracket: { type: br.type || '', total, completed: done, pct: total ? Math.round(done / total * 100) : 0,
          phases: (br.phases || []).map((p) => ({ id: p.id, name: p.name, type: p.type })) },
        queue: { live: liveCount, done: doneCount, upcoming: upcomingCount, streams: sg.streams || [], following: sg.streamName || '' },
        pacing: stats.getPacing(), maps: stats.getMapStats(), tournaments: stats.getTournaments()
      } });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  // ── Analytics: audience engagement (computed live from Twitch state) ───────
  app.get('/api/analytics/engagement', (req, res) => {
    try {
      const tw = state.twitch || {};
      const ph = (tw.predictions && tw.predictions.history) || [];
      const cur = tw.predictions && tw.predictions.current;
      const allPreds = cur ? [cur, ...ph] : ph.slice();
      const sumOut = (p, f) => (p.outcomes || []).reduce((a, o) => a + (o[f] || 0), 0);
      const predictions = {
        total: allPreds.length,
        resolved: allPreds.filter((p) => p.state === 'RESOLVED').length,
        cancelled: allPreds.filter((p) => p.state === 'CANCELLED').length,
        totalPoints: allPreds.reduce((a, p) => a + sumOut(p, 'votes'), 0),
        totalVoters: allPreds.reduce((a, p) => a + sumOut(p, 'users'), 0),
        recent: allPreds.slice(0, 10).map((p) => ({ title: p.title, state: p.state, points: sumOut(p, 'votes'), voters: sumOut(p, 'users'), createdAt: p.createdAt }))
      };
      const polls = (tw.poll && tw.poll.history) || [];
      const pollStats = { total: polls.length, totalVotes: polls.reduce((a, p) => a + (p.total || 0), 0),
        recent: polls.slice(0, 10).map((p) => ({ title: p.title, total: p.total, endedAt: p.endedAt })) };
      const wheel = tw.wheel || {}, wHist = wheel.history || [];
      const wheelStats = { spins: wHist.length, participants: (wheel.participants || []).length, byMethod: {} };
      (wheel.participants || []).forEach((p) => { wheelStats.byMethod[p.method] = (wheelStats.byMethod[p.method] || 0) + 1; });
      const mini = tw.minigame || {}, mHist = mini.history || [];
      const miniStats = { total: mHist.length, byType: {} };
      mHist.forEach((g) => { miniStats.byType[g.type] = (miniStats.byType[g.type] || 0) + 1; });
      const log = tw.activityLog || [];
      const act = { follow: 0, subscribe: 0, raid: 0, bits: 0, raidViewers: 0, bitsAmount: 0 };
      log.forEach((e) => {
        if (e.type === 'follow') act.follow++;
        else if (e.type === 'subscribe' || e.type === 'sub' || e.type === 'resub' || e.type === 'gift_sub') act.subscribe++;
        else if (e.type === 'raid') { act.raid++; act.raidViewers += e.viewers || 0; }
        else if (e.type === 'bits') { act.bits++; act.bitsAmount += e.amount || 0; }
      });
      let stream = { isLive: false, viewers: 0, title: '', game: '' };
      try { if (typeof streamStateManager !== 'undefined' && streamStateManager) stream = { isLive: streamStateManager.streamState.isLive, viewers: streamStateManager.streamState.viewerCount, title: streamStateManager.streamState.title, game: streamStateManager.streamState.game }; } catch (e) {}
      res.json({ ok: true, data: { stream, predictions, polls: pollStats, wheel: wheelStats, minigames: miniStats, activity: act, recentActivity: log.slice(-40).reverse() } });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });
};
