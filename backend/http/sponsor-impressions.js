'use strict';
// Sponsor proof-of-play — HTTP routes (moved out of server.js's startHttpServer; called at the same point, so
// route order is unchanged). Values server.js reassigns, or declares further down, are
// read and written through ctx (_adProofTimer, twitchClient).
let
  adProof, adProofCsv, adProofReport, adProofStart, adProofStop, adProofValueMetrics,
  analytics, app, bridgeClients, broadcast, registerTwitchEventSubRoutes, saveAppState,
  saveTwitchData, state;
let ctx;

module.exports = function registerSponsorImpressionRoutes(c) {
  ctx = c;
  ({
    adProof, adProofCsv, adProofReport, adProofStart, adProofStop, adProofValueMetrics,
    analytics, app, bridgeClients, broadcast, registerTwitchEventSubRoutes, saveAppState,
    saveTwitchData, state
  } = c);

  // ── Sponsor proof-of-play (impression reports) ─────────────────────────────
  app.get('/api/adproof', (req, res) => res.json(adProofReport()));

  // Cross-broadcast roll-up for the Analytics overview and the Sponsors tab: every saved report in
  // the window plus the live tracker, keyed by sponsor id (by name for reports that predate ids).
  app.get('/api/adproof/summary', (req, res) => {
    const days = Math.max(0, Math.min(3650, Number(req.query.days) || 30));
    const since = days ? Date.now() - days * 86400000 : 0;
    const by = {};
    const add = (sp, sessId) => {
      if (!sp) return;
      const key = sp.id || ('name:' + String(sp.name || '').trim().toLowerCase());
      const rec = by[key] || (by[key] = { id: sp.id || '', name: sp.name || '', logo: sp.logo || '', seconds: 0, impressions: 0, viewerSeconds: 0, peakViewers: 0, byPlacement: {}, sessions: new Set(), valueDelivered: 0, dealValue: 0 });
      if (sp.name) rec.name = sp.name;
      if (sp.logo && !rec.logo) rec.logo = sp.logo;
      rec.seconds += sp.seconds || 0; rec.impressions += sp.impressions || 0; rec.viewerSeconds += sp.viewerSeconds || 0;
      rec.peakViewers = Math.max(rec.peakViewers, sp.peakViewers || 0);
      Object.keys(sp.byPlacement || {}).forEach((k) => { rec.byPlacement[k] = (rec.byPlacement[k] || 0) + (sp.byPlacement[k] || 0); });
      rec.valueDelivered += sp.valueDelivered || 0; rec.dealValue += sp.dealValue || 0;
      rec.sessions.add(sessId);
    };
    const sessions = (state.adProofSessions || []).filter((s) => (s.endedAt || s.startedAt || 0) >= since);
    sessions.forEach((s) => (s.sponsors || []).forEach((sp) => add(sp, s.id)));
    if (adProof.active) adProofReport().sponsors.forEach((sp) => add(sp, 'live'));
    const sponsors = Object.values(by).map((r) => ({ ...r, sessions: r.sessions.size, avgViewers: r.seconds ? Math.round(r.viewerSeconds / r.seconds) : 0 })).sort((a, b) => b.seconds - a.seconds);
    res.json({
      days, since, broadcasts: sessions.length + (adProof.active ? 1 : 0),
      seconds: sponsors.reduce((a, x) => a + x.seconds, 0),
      viewerSeconds: sponsors.reduce((a, x) => a + x.viewerSeconds, 0),
      impressions: sponsors.reduce((a, x) => a + x.impressions, 0),
      sponsors
    });
  });

  app.post('/api/adproof/start', (req, res) => {
    adProofStart(req.body && req.body.label);
    res.json({ success: true, report: adProofReport() });
  });

  app.post('/api/adproof/stop', (req, res) => {
    const session = adProofStop();
    res.json({ success: true, session, report: adProofReport() });
  });

  app.post('/api/adproof/reset', (req, res) => {
    adProof.active = false;
    if (ctx._adProofTimer) { clearInterval(ctx._adProofTimer); ctx._adProofTimer = null; }
    adProof.ticks = 0; adProof.sponsors = {}; adProof.startedAt = 0; adProof.label = '';
    broadcast(bridgeClients, { type: 'adproof_update', data: adProofReport() });
    res.json({ success: true, report: adProofReport() });
  });

  app.delete('/api/adproof/session/:id', (req, res) => {
    const before = (state.adProofSessions || []).length;
    state.adProofSessions = (state.adProofSessions || []).filter((s) => s.id !== req.params.id);
    if (state.adProofSessions.length !== before) saveAppState();
    broadcast(bridgeClients, { type: 'adproof_update', data: adProofReport() });
    res.json({ success: true, report: adProofReport() });
  });
  // Clear ALL saved sponsor sessions (fresh reporting).
  app.delete('/api/adproof/sessions', (req, res) => {
    state.adProofSessions = [];
    try { saveAppState(); } catch (e) {}
    broadcast(bridgeClients, { type: 'adproof_update', data: adProofReport() });
    res.json({ success: true, report: adProofReport() });
  });

  // Download one session (or the live tracker) as CSV or JSON.
  app.get('/api/adproof/export', (req, res) => {
    const which = (req.query.session || 'current').toString();
    let sess;
    if (which === 'current' || which === '') {
      sess = { label: adProof.label || (state.eventName || 'Broadcast'), startedAt: adProof.startedAt, endedAt: Date.now(), durationSec: adProof.ticks,
        sponsors: Object.values(adProof.sponsors).map((r) => ({
          id: r.id, name: r.name, seconds: r.seconds, impressions: r.impressions, byPlacement: { ...r.byPlacement },
          viewerSeconds: r.viewerSeconds || 0, peakViewers: r.peakViewers || 0, avgViewers: r.seconds ? Math.round((r.viewerSeconds || 0) / r.seconds) : 0,
          ...adProofValueMetrics(r)
        })).sort((a, b) => b.seconds - a.seconds) };
    } else {
      sess = (state.adProofSessions || []).find((s) => s.id === which);
      if (!sess) return res.status(404).json({ error: 'Session not found' });
    }
    const safe = (sess.label || 'proof-of-play').toString().replace(/[^a-z0-9_-]+/gi, '-').slice(0, 50) || 'proof-of-play';
    if ((req.query.format || 'csv').toString() === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="${safe}.json"`);
      res.setHeader('Content-Type', 'application/json');
      return res.send(JSON.stringify(sess, null, 2));
    }
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.csv"`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(adProofCsv(sess));
  });

  // GET /api/twitch/stream — get live stream info (title, game, viewers)
  app.get('/api/twitch/stream', async (req, res) => {
    if (!ctx.twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    try {
      const info = await ctx.twitchClient.getStreamInfo(state.twitch.channelId);
      res.json(info);
    } catch (e) {
      console.error('[Twitch] getStreamInfo error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // POST /api/twitch/poll — create a channel poll
  app.post('/api/twitch/poll', async (req, res) => {
    if (!ctx.twitchClient || !state.twitch.connected) return res.status(400).json({ error: 'Twitch not connected' });
    const { title, choices, duration } = req.body;
    if (!title || !Array.isArray(choices) || choices.length < 2) {
      return res.status(400).json({ error: 'title and at least 2 choices required' });
    }
    try {
      console.log('[Twitch] Creating poll:', title);
      const poll = await ctx.twitchClient.createPoll(state.twitch.channelId, title, choices, duration || 60);
      try { analytics.event('poll_create'); } catch (e) {}
      res.json({ success: true, poll });
    } catch (e) {
      console.error('[Twitch] createPoll error:', e.message);
      res.status(500).json({ error: e.response?.data?.message || e.message });
    }
  });

  // POST /api/twitch/automations — save match-start/end automation message templates
  app.post('/api/twitch/automations', (req, res) => {
    const { announceOnMatchStart, announceOnMatchEnd } = req.body;
    if (typeof announceOnMatchStart === 'string') state.twitch.automations.announceOnMatchStart = announceOnMatchStart;
    if (typeof announceOnMatchEnd   === 'string') state.twitch.automations.announceOnMatchEnd   = announceOnMatchEnd;
    saveTwitchData();
    console.log('[Twitch] Automations updated:', state.twitch.automations);
    res.json({ success: true, automations: state.twitch.automations });
  });

  // Twitch EventSub + stream-state routes. They're defined at module scope below (so they
  // can use eventSubService/streamStateManager) but MUST be registered here, where `app`
  // exists — registering at module top-level crashed on load ("app is not defined").
  registerTwitchEventSubRoutes(app);

  // An unknown /api/ path fell through to Express's default handler, which replies with an HTML
  // error page. Every caller in the app does `await res.json()` on these, so the failure surfaced
  // as the useless "Unexpected token < in JSON at position 0" instead of naming the route. This is
  // the common shape of "the running app predates a new route" — server.js only reloads on a full
  // app restart — so say that outright.
  app.use('/api', (req, res) => {
    res.status(404).json({
      error: `No such API route: ${req.method} /api${req.path}`,
      hint: 'If this feature is new, the running app still has the old server — fully quit and relaunch Broadcast Studio.',
    });
  });
};
