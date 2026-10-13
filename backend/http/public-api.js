'use strict';
// Public APIs: Competition API v1 and Control API v1 — HTTP routes (moved out of server.js's startHttpServer; called at the same point, so
// route order is unchanged). Values server.js reassigns, or declares further down, are
// read and written through ctx (competitionApiKey, leaguesVer, savedBrandKits, savedTeams, startggApiToken).
let
  GFX_EXCLUSIVE_VISIBLE, app, applyCompetitionDoc, broadcastFullState, compResolveTeam,
  competition, competitionGoLive, competitionLiveIds, describeSyncReport,
  fetchTournamentEvents, handleControlMessage, lgRecalcServer, loadStartggEventTeams,
  migrateLeague, refreshCompetitionFeed, saveAppState, saveTeams, srvLgUid, state, teamDb,
  vaultTouch;
let ctx;

module.exports = function registerPublicApiRoutes(c) {
  ctx = c;
  ({
    GFX_EXCLUSIVE_VISIBLE, app, applyCompetitionDoc, broadcastFullState, compResolveTeam,
    competition, competitionGoLive, competitionLiveIds, describeSyncReport,
    fetchTournamentEvents, handleControlMessage, lgRecalcServer, loadStartggEventTeams,
    migrateLeague, refreshCompetitionFeed, saveAppState, saveTeams, srvLgUid, state, teamDb,
    vaultTouch
  } = c);

  // ── Competition API v1 (docs/competition-api.md) ────────────────────────────────────────────
  // The write/read API a league's own tools (a Discord bot, a results script, a Stream Deck, their
  // website's backend on the same PC or through a tunnel) use to drive a league. Every route but the
  // schema needs the API key from Apps ▸ API (Marketplace ▸ API in the Classic interface):
  // `Authorization: Bearer <key>` or `X-Api-Key: <key>`. The server only listens on 127.0.0.1, so a
  // remote caller has to run a relay on the broadcast PC (or publish a feed the app polls instead).
  const compAuth = (req, res, next) => {
    const hdr = String(req.get('Authorization') || '');
    const given = hdr.toLowerCase().startsWith('bearer ') ? hdr.slice(7).trim() : String(req.get('X-Api-Key') || '').trim();
    if (!ctx.competitionApiKey) return res.status(401).json({ ok: false, error: 'No API key has been created yet. Open Apps > API in the app to create one.' });
    const a = Buffer.from(given), b = Buffer.from(ctx.competitionApiKey);
    if (a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) return res.status(401).json({ ok: false, error: 'Missing or wrong API key.' });
    next();
  };
  const compFind = (req, res) => {
    const id = String(req.params.id || '');
    const lg = (state.leagues || []).find((l) => l.id === id || (l.source && l.source.externalId === id));
    if (!lg) { res.status(404).json({ ok: false, error: `No competition with id "${id}".` }); return null; }
    return lg;
  };
  const compSummary = (lg) => ({ id: lg.id, name: lg.name || '', season: lg.season || '', game: lg.game || '',
    teams: (lg.teams || []).length, matches: (lg.schedule || []).length, source: (lg.source && lg.source.type) || 'manual',
    live: !!(state.competition && state.competition.leagueId === lg.id) });

  app.get('/api/v1/schema', (req, res) => res.json(competition.SCHEMA));
  app.get('/api/v1/competitions', compAuth, (req, res) => {
    res.json({ ok: true, live: (state.competition && state.competition.leagueId) || '', competitions: (state.leagues || []).map(compSummary) });
  });
  // Create a league from a document.
  app.post('/api/v1/competitions', compAuth, (req, res) => {
    const v = competition.validateDoc(req.body);
    if (!v.doc) return res.status(400).json({ ok: false, errors: v.errors, warnings: v.warnings });
    const c = v.doc.competition;
    if (!c.name) return res.status(400).json({ ok: false, errors: ['competition.name is required to create a competition.'] });
    const lg = migrateLeague({ id: srvLgUid('lg'), name: c.name, season: c.season, game: c.game || state.activeGame || '', status: 'active',
      source: { type: 'push' }, teams: [], schedule: [], standings: [] });
    state.leagues = (state.leagues || []).concat([lg]);
    const r = applyCompetitionDoc(lg, v.doc, { prune: false });
    ctx.leaguesVer++; saveAppState(); broadcastFullState();
    res.status(201).json({ ok: true, competition: compSummary(lg), summary: r.ok ? describeSyncReport(r.report) : '', warnings: v.warnings });
  });
  app.get('/api/v1/competitions/:id', compAuth, (req, res) => {
    const lg = compFind(req, res); if (!lg) return;
    res.json(competition.leagueToDoc(lg, compResolveTeam));
  });
  // PUT = this document is the whole truth (fixtures it no longer lists, that came from the API or
  // a sync, are removed). PATCH = merge only. Neither touches fixtures added by hand in the app.
  const compWrite = (prune) => (req, res) => {
    const lg = compFind(req, res); if (!lg) return;
    const r = applyCompetitionDoc(lg, req.body, { prune: prune && req.query.prune !== 'false' });
    if (!r.ok) return res.status(400).json({ ok: false, errors: r.errors, warnings: r.warnings });
    res.json({ ok: true, summary: describeSyncReport(r.report), report: r.report, warnings: r.warnings });
  };
  app.put('/api/v1/competitions/:id', compAuth, compWrite(true));
  app.patch('/api/v1/competitions/:id', compAuth, compWrite(false));
  // Update one match — the call a results bot makes. :matchId is your id (from the document) or ours.
  app.patch('/api/v1/competitions/:id/matches/:matchId', compAuth, (req, res) => {
    const lg = compFind(req, res); if (!lg) return;
    const mid = String(req.params.matchId);
    const m = (lg.schedule || []).find((x) => x.extId === mid) || (lg.schedule || []).find((x) => x.id === mid);
    if (!m) return res.status(404).json({ ok: false, error: `No match with id "${mid}" in this competition.` });
    const b = req.body || {};
    const num = (v) => (v === null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : undefined));
    m.result = m.result || { scoreA: null, scoreB: null, ot: false };
    if ('scoreA' in b) { const n = num(b.scoreA); if (n !== undefined) m.result.scoreA = n; }
    if ('scoreB' in b) { const n = num(b.scoreB); if (n !== undefined) m.result.scoreB = n; }
    if (Array.isArray(b.games)) m.games = b.games.slice(0, 15).map((g) => ({ scoreA: Number(g && g.scoreA) || 0, scoreB: Number(g && g.scoreB) || 0 }));
    if ('overtime' in b) m.result.ot = !!b.overtime;
    if (typeof b.stream === 'string') m.stream = b.stream.slice(0, 2048);
    if (typeof b.round === 'string') m.round = b.round.slice(0, 60);
    if (b.week != null) m.week = String(b.week).slice(0, 20);
    if (b.scheduledAt || b.date || b.time) {
      const v = competition.validateDoc({ matches: [{ teamA: 'a', teamB: 'b', scheduledAt: b.scheduledAt, date: b.date, time: b.time }] });
      const w = v.doc && v.doc.matches[0];
      if (w && w.date) m.date = w.date;
      if (w && w.time) m.time = w.time;
    }
    if ('status' in b) {
      const st = competition.parseStatus(b.status);
      if (!st) return res.status(400).json({ ok: false, error: `status must be one of ${competition.MATCH_STATUSES.join(', ')}.` });
      if (st === 'live') (lg.schedule || []).forEach((x) => { if (x !== m && x.status === 'live') delete x.status; });
      if (st === 'live' || st === 'cancelled' || st === 'postponed') m.status = st; else delete m.status;
      if (st === 'scheduled') { m.result.scoreA = null; m.result.scoreB = null; m.games = []; }
    }
    if (!lg.standingsMode || lg.standingsMode === 'schedule') lgRecalcServer(lg);
    ctx.leaguesVer++;
    refreshCompetitionFeed();
    saveAppState();
    broadcastFullState();
    const doc = competition.leagueToDoc(lg, compResolveTeam);
    res.json({ ok: true, match: doc.matches.find((x) => x.id === (m.extId || m.id)) });
  });
  // What is on air right now for this competition (the same feed the scenes draw).
  app.get('/api/v1/competitions/:id/feed', compAuth, (req, res) => {
    const lg = compFind(req, res); if (!lg) return;
    res.json({ ok: true, feed: competition.buildFeed(lg, { resolveTeam: compResolveTeam, liveIds: competitionLiveIds(lg) }) });
  });
  // Put a competition on air (or { "id": "" } to take it off).
  app.post('/api/v1/live', compAuth, (req, res) => {
    const id = String((req.body && req.body.id) || '');
    const lg = competitionGoLive(id);
    if (id && !lg) return res.status(404).json({ ok: false, error: `No competition with id "${id}".` });
    saveAppState();
    broadcastFullState();
    res.json({ ok: true, live: lg ? compSummary(lg) : null });
  });

  // ── Control API (v1): run the show from your own app ────────────────────────────────────
  // The same actions the control panel and the Stream Deck send over the WebSocket, as plain HTTP
  // for bots, web tools and apps built on the platform. Each action is validated here and then run
  // through handleControlMessage, so there is exactly one implementation of every change. Same API
  // key as the competition routes; loopback-only like the rest of the server.
  const V1_SIDE = (v) => (v === 'blue' || v === 'a' || v === 'A' ? 'blue' : v === 'orange' || v === 'b' || v === 'B' ? 'orange' : '');
  const V1_URL = (v) => (typeof v === 'string' && /^(https?:\/\/|data:image\/)/i.test(v) && v.length < 2000000 ? v : undefined);
  const V1_ACTIONS = {
    score:        { desc: 'Add or take away a game win: { side: "blue"|"orange", delta: 1 }', build: (b) => V1_SIDE(b.side) && { type: 'adjust_series', data: { side: V1_SIDE(b.side), delta: Math.max(-9, Math.min(9, Math.trunc(Number(b.delta) || 1))) } } },
    'series-reset': { desc: 'Reset the series score and game number: {}', build: () => ({ type: 'reset_series', data: {} }) },
    'swap-sides': { desc: 'Swap the two teams between the sides: {}', build: () => ({ type: 'swap_teams', data: {} }) },
    game:         { desc: 'Move the game number: { delta: 1 }', build: (b) => ({ type: 'adjust_game_number', data: { delta: Math.max(-9, Math.min(9, Math.trunc(Number(b.delta) || 1))) } }) },
    'best-of':    { desc: 'Series length: { value: 5 }', build: (b) => { const n = Math.trunc(Number(b.value)); return n >= 1 && n <= 15 && { type: 'set_best_of', data: { value: n } }; } },
    team:         { desc: 'Put a team on a side: { side, name, logo?, abbr?, color? }. A team in your library brings its roster and logo.',
      build: (b) => V1_SIDE(b.side) && typeof b.name === 'string' && b.name.trim() && { type: 'set_team', data: Object.fromEntries(Object.entries({
        side: V1_SIDE(b.side), name: b.name.trim().slice(0, 80), logo: V1_URL(b.logo), abbr: typeof b.abbr === 'string' ? b.abbr.slice(0, 6) : undefined,
        color: typeof b.color === 'string' && /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : undefined }).filter(([, v]) => v !== undefined)) } },
    'team-color': { desc: 'A side\'s colour: { side, color: "#rrggbb" }', build: (b) => V1_SIDE(b.side) && /^#[0-9a-f]{6}$/i.test(String(b.color || '')) && { type: 'set_team_color', data: { side: V1_SIDE(b.side), color: b.color } } },
    round:        { desc: 'The round label on the overlays: { text: "Grand Final" }', build: (b) => ({ type: 'set_round_label', data: { text: String(b.text || '').slice(0, 80) } }) },
    'event-name': { desc: 'The event title: { name }', build: (b) => ({ type: 'set_event_name', data: { name: String(b.name || '').slice(0, 160) } }) },
    graphic:      { desc: 'Show one full-screen graphic, or hide it: { key: "standings" } / { key: null }. GET /api/v1/state lists the keys.', build: (b) => ({ type: 'set_gfx_active', data: { scene: b.key ? String(b.key).slice(0, 60) : null } }) },
    break:        { desc: 'Break screen and countdown: { visible, title?, message?, seconds? | until: "21:30" }',
      build: (b) => { const d = {}; ['visible', 'titleOnly'].forEach((k) => { if (k in b) d[k] = !!b[k]; });
        ['title', 'message', 'finalMessage', 'until', 'thenScene'].forEach((k) => { if (typeof b[k] === 'string') d[k] = b[k].slice(0, 200); });
        if (b.seconds != null && Number.isFinite(Number(b.seconds))) d.seconds = Math.max(0, Math.min(86400, Number(b.seconds)));
        return Object.keys(d).length && { type: 'set_break', data: d }; } },
    banner:       { desc: 'Sponsor banner on or off: { visible }', build: (b) => ({ type: 'set_banner_visibility', data: { visible: !!b.visible } }) },
    casters:      { desc: 'Caster lower third on or off (also cuts to the casters scene if set up): { visible }', build: (b) => ({ type: 'set_casters_visibility', data: { visible: !!b.visible } }) },
    scene:        { desc: 'Cut OBS to a scene: { scene: "Gameplay" }', build: (b) => typeof b.scene === 'string' && b.scene.trim() && { type: 'obs_switch_scene', data: { sceneName: b.scene.trim().slice(0, 200) } } },
    'brand-kit':  { desc: 'Make a brand kit live: { id } (null for none). GET /api/v1/state lists them.', build: (b) => ({ type: 'activate_brand_kit', data: { id: b.id ? String(b.id) : null } }) },
    'color-mode': { desc: 'Overlay colours: { mode: "team"|"brand"|"default"|"game" }', build: (b) => ['team', 'brand', 'default', 'game'].includes(b.mode) && { type: 'set_color_mode', data: { mode: b.mode } } },
  };
  // A compact picture of the show for an outside app (no images inlined, no secrets).
  const v1State = () => {
    const side = (k) => { const t = state.teams[k] || {}; return { name: t.name || '', abbr: t.abbr || '', color: t.color || '', score: (state.series && state.series[k]) || 0,
      logo: typeof t.logo === 'string' && /^https?:/i.test(t.logo) ? t.logo : (t.logo ? '(image)' : ''), players: (t.players || []).map((p) => (p && p.name) || '').filter(Boolean) }; };
    return {
      game: state.activeGame, eventName: state.eventName || '', roundLabel: state.roundLabel || '',
      bestOf: state.bestOf, gameNumber: (state.game && state.game.number) || 1,
      teams: { blue: side('blue'), orange: side('orange') },
      graphic: typeof state.gfxActive === 'string' ? state.gfxActive : null,
      graphics: Object.keys(GFX_EXCLUSIVE_VISIBLE).filter((k) => k !== 'upcoming').concat(['matchup']),
      break: { visible: !!(state.breakScreen && state.breakScreen.visible), title: (state.breakScreen && state.breakScreen.title) || '', endsAt: (state.breakScreen && state.breakScreen.endsAt) || null },
      banner: !!(state.banner && state.banner.visible), casters: !!(state.casters && state.casters.visible),
      brandKit: state.activeBrandKitId || null, brandKits: (ctx.savedBrandKits || []).map((k) => ({ id: k.id, name: k.name || '' })),
      colorMode: state.colorMode || 'team',
      obs: { connected: !!(state.obs && state.obs.connected), scene: (state.obs && state.obs.currentScene) || '', scenes: ((state.obs && state.obs.availableScenes) || []).map((s) => (typeof s === 'string' ? s : s && (s.sceneName || s.name))).filter(Boolean).slice(0, 100) },
      event: state.activeEvent && state.activeEvent.name ? { platform: state.activeEvent.platform, name: state.activeEvent.name } : null,
    };
  };
  app.get('/api/v1/state', compAuth, (req, res) => res.json({ ok: true, state: v1State() }));
  app.get('/api/v1/control', compAuth, (req, res) => res.json({ ok: true, actions: Object.keys(V1_ACTIONS).map((k) => ({ action: k, method: 'POST', path: '/api/v1/control/' + k, body: V1_ACTIONS[k].desc })) }));
  app.post('/api/v1/control/:action', compAuth, (req, res) => {
    const a = V1_ACTIONS[String(req.params.action || '')];
    if (!a) return res.status(404).json({ ok: false, error: 'Unknown action. GET /api/v1/control lists them.' });
    const msg = a.build((req.body && typeof req.body === 'object') ? req.body : {});
    if (!msg) return res.status(400).json({ ok: false, error: 'Bad body for this action. Expected ' + a.desc });
    const replies = [];
    const fakeWs = { readyState: 1, _role: 'api', _client: 'api', send: (raw) => { try { replies.push(JSON.parse(raw)); } catch (e) {} } };
    try { handleControlMessage(msg, fakeWs); }
    catch (e) { return res.status(500).json({ ok: false, error: (e && e.message) || 'The action failed.' }); }
    res.json({ ok: true, action: req.params.action, state: v1State(), messages: replies.filter((r) => r && r.type !== 'full_state').slice(0, 5) });
  });

  // Wipe the whole vault. Library teams are kept — they only lose their vault link.
  app.delete('/api/teamdb', (req, res) => {
    const removed = teamDb.clearAll();
    ctx.savedTeams.forEach((t) => { if (t && t.vaultId) delete t.vaultId; });
    saveTeams(); vaultTouch(); broadcastFullState();
    res.json({ ok: true, removed });
  });

  app.delete('/api/teamdb/:id', (req, res) => {
    const removed = teamDb.remove(req.params.id);
    if (removed) { ctx.savedTeams.forEach((t) => { if (t && t.vaultId === req.params.id) delete t.vaultId; }); saveTeams(); vaultTouch(); broadcastFullState(); }
    res.json({ ok: true, removed });
  });

  // Vault settings (enabled / autoLink).
  app.post('/api/teamdb/settings', (req, res) => {
    const b = req.body || {};
    if (!state.teamVault) state.teamVault = { enabled: true, autoLink: true, count: 0, ver: 0 };
    if (typeof b.enabled    === 'boolean') state.teamVault.enabled    = b.enabled;
    if (typeof b.autoLink   === 'boolean') state.teamVault.autoLink   = b.autoLink;
    if (typeof b.autoEnrich === 'boolean') state.teamVault.autoEnrich = b.autoEnrich;
    saveAppState();
    broadcastFullState();
    res.json({ ok: true, settings: state.teamVault });
  });

  // Seed the vault from the team library that already exists — a one-click migration so an
  // established producer doesn't start with an empty vault and lose everything they've built.
  app.post('/api/teamdb/import-library', (req, res) => {
    let created = 0, updated = 0;
    (ctx.savedTeams || []).forEach((t) => {
      if (!t || !(t.name || '').trim()) return;
      const before = teamDb.count();
      const rec = teamDb.upsertFromLibrary(t, { source: 'library' });
      if (!rec) return;
      t.vaultId = rec.id;
      if (teamDb.count() > before) created++; else updated++;
    });
    saveTeams();
    vaultTouch();
    broadcastFullState();
    res.json({ ok: true, created, updated, total: teamDb.count() });
  });

  // List events/phases under a tournament slug (so user can pick the right event for teams/stats)
  app.post('/api/startgg/tournament-events', async (req, res) => {
    const { tournamentSlug, apiToken } = req.body;
    const token = apiToken || ctx.startggApiToken;
    if (!token) return res.status(400).json({ error: 'Start.gg API token required' });
    if (!tournamentSlug) return res.status(400).json({ error: 'tournamentSlug required' });
    try {
      const events = await fetchTournamentEvents(token, tournamentSlug);
      res.json({ events });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Load transient event teams (for start.gg teams list). Does NOT auto-save to saved library.
  app.post('/api/startgg/event-teams', async (req, res) => {
    const { tournamentSlug, eventSlug, apiToken } = req.body;
    const token = apiToken || ctx.startggApiToken;
    if (!token) return res.status(400).json({ error: 'Start.gg API token required' });
    const slug = eventSlug || tournamentSlug;
    if (!slug) return res.status(400).json({ error: 'eventSlug or tournamentSlug required' });
    try {
      const teams = await loadStartggEventTeams(tournamentSlug, eventSlug);  // reuses the func which also updates state + broadcasts
      // loadStartgg... already broadcast; return count
      res.json({ ok: true, teamsLoaded: teams.teams || 0, playersLoaded: teams.players || 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
};
