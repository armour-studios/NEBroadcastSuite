'use strict';
// Live game data feeds (Overwolf GEP: Overwatch, Marvel Rivals, R6, Valorant; Apex LiveAPI; Bedwars) — HTTP routes (moved out of server.js's startHttpServer; called at the same point, so
// route order is unchanged). Values server.js reassigns, or declares further down, are
// read and written through ctx (_apexServer, bedwarsToken).
let
  apexLive, app, applyValorantGep, broadcastFullState, express, flowBus, path,
  startValorantWatchdog, state;
let ctx;

module.exports = function registerGameFeedRoutes(c) {
  ctx = c;
  ({
    apexLive, app, applyValorantGep, broadcastFullState, express, flowBus, path,
    startValorantWatchdog, state
  } = c);

  // ── Overwolf GEP → Overwatch live game data ─────────────────────────────────
  // Called by the companion Overwolf app on the spectator PC (same relay pattern as
  // Marvel Rivals below). Body: { roster: [{player_name,battlenet_tag,hero_name,hero_role,
  // team,kills,deaths,assists,damage,healed,mitigated,is_local}×12], map, game_mode,
  // game_state, match_outcome }
  app.post('/api/ow-gep', express.json({ limit: '64kb' }), (req, res) => {
    const b = req.body || {};
    if (!state.owMatch) {
      state.owMatch = { visible: true, format: 'FT3', currentMapIdx: 0, bansByMap: [], gameMode: 'escort', showMapLabels: true, mapWinners: [], mapModes: [], gepData: null };
    }
    const prev = state.owMatch.gepData || {};
    state.owMatch.gepData = {
      gepConnected: true,
      lastSeen: Date.now(),
      roster: Array.isArray(b.roster) ? b.roster.slice(0, 12) : (prev.roster || []),
      map: (typeof b.map === 'string' && b.map) ? b.map : (prev.map || null),
      game_mode: (typeof b.game_mode === 'string' && b.game_mode) ? b.game_mode : (prev.game_mode || null),
      game_state: b.game_state || prev.game_state || null,
      match_outcome: b.match_outcome || null
    };
    // Auto game-mode: GEP mode strings map cleanly onto the scoreboard's mode set.
    const gm = String(b.game_mode || '').toLowerCase();
    const hit = ['escort', 'hybrid', 'control', 'push', 'flashpoint', 'clash'].find((k) => gm.includes(k));
    if (hit) state.owMatch.gameMode = hit;
    // GEP match/round events -> Flow triggers (same shape as the CS2 GSI ones). The
    // companion posts { events: ['match_start' | 'round_start' | 'round_end' | 'match_end', ...] }.
    const OW_EVENT_TRIGGERS = { match_start: 'ow_match_start', round_start: 'ow_round_start', round_end: 'ow_round_end', match_end: 'ow_match_end' };
    (Array.isArray(b.events) ? b.events : []).forEach((ev) => {
      const name = typeof ev === 'string' ? ev : (ev && ev.name);
      const trig = OW_EVENT_TRIGGERS[String(name || '').toLowerCase()];
      if (trig) flowBus.emit(trig, {
        map: state.owMatch.gepData.map || null,
        game_mode: state.owMatch.gepData.game_mode || null,
        match_outcome: state.owMatch.gepData.match_outcome || null
      });
    });
    broadcastFullState();
    res.json({ ok: true });
  });

  // ── Apex LiveAPI setup: write config.json + report the connection details ────
  // GET returns the launch-option string, the config.json contents, and the target
  // path (so the UI can show copy-paste instructions). POST writes config.json into
  // the Apex Saved-Games folder on this machine. See backend/apex-live.js.
  app.get('/api/apex/liveapi', (req, res) => {
    const port = (state.apex && state.apex.port) || 7777;
    res.json({
      connected: !!(state.apex && state.apex.connected),
      running: !!ctx._apexServer,
      port,
      launchOptions: apexLive.launchOptions({ port }),
      configPath: path.join(apexLive.defaultConfigDir(), 'config.json'),
      config: apexLive.buildConfig({ port }),
    });
  });
  app.post('/api/apex/liveapi/config', express.json({ limit: '16kb' }), (req, res) => {
    const port = (state.apex && state.apex.port) || 7777;
    const result = apexLive.writeConfig({ port });
    if (!result.ok) return res.status(500).json({ ok: false, error: result.error });
    res.json({ ok: true, file: result.file });
  });

  // ── Overwolf GEP → Marvel Rivals live game data ─────────────────────────────
  // Called by the companion Overwolf app (companion-overwolf/) on a PC that is IN the
  // match — GEP reads the local client (see docs/marvel-rivals-production.md §3).
  // Body: { roster: [{name,character_name,character_id,team,kills,deaths,assists,ult_charge,is_alive,…}×12],
  //         map, game_mode, game_type, match_id, scene, match_outcome,
  //         banned_characters: [{character_id,character_name,is_teammate}], selected_character,
  //         player_stats: {damage_dealt,damage_block,accuracy,total_heal},
  //         objective_progress: {game_mode,checkpoint,left_capture,right_capture,team},
  //         events: ['match_start'|'round_start'|'round_end'|'match_end' | {name:'kill_feed',data:{attacker,victim}}] }
  app.post('/api/mr-gep', express.json({ limit: '64kb' }), (req, res) => {
    const body = req.body || {};
    if (!state.mrMatch) {
      state.mrMatch = { visible: false, format: 'BO5', bansByMap: [], gameMode: 'convergence', showMapLabels: true, mapWinners: [], mapModes: [], gepData: null };
    }
    const prevGep = state.mrMatch.gepData || {};
    state.mrMatch.gepData = {
      gepConnected: true,
      lastSeen: Date.now(),
      roster: Array.isArray(body.roster) ? body.roster.slice(0, 12) : (prevGep.roster || []),
      map: typeof body.map === 'string' && body.map ? body.map : (prevGep.map || null),
      game_mode: typeof body.game_mode === 'string' && body.game_mode ? body.game_mode : (prevGep.game_mode || null),
      game_type: typeof body.game_type === 'string' && body.game_type ? body.game_type : (prevGep.game_type || null),
      match_id: body.match_id || prevGep.match_id || null,
      scene: body.scene || prevGep.scene || null,
      match_outcome: body.match_outcome || null,
      banned_characters: Array.isArray(body.banned_characters) ? body.banned_characters : (prevGep.banned_characters || []),
      selected_character: body.selected_character || prevGep.selected_character || null,
      player_stats: body.player_stats || prevGep.player_stats || null,
      objective_progress: body.objective_progress || prevGep.objective_progress || null,
      killFeed: Array.isArray(prevGep.killFeed) ? prevGep.killFeed : []
    };
    // Auto game-mode: GEP mode strings map onto the series scoreboard's mode set
    // (objective_progress.game_mode is the reliable one; match_info.game_mode is a display name).
    const mrGm = String(body.game_mode || (body.objective_progress && body.objective_progress.game_mode) || '').toLowerCase();
    const mrHit = ['convergence', 'domination', 'convoy'].find((k) => mrGm.includes(k.slice(0, 6)));
    if (mrHit) state.mrMatch.gameMode = mrHit;
    // GEP match/round events → Flow triggers (same shape as the Overwatch relay above).
    // kill_feed entries accumulate on gepData.killFeed (last 12) for overlay use.
    const MR_EVENT_TRIGGERS = { match_start: 'mr_match_start', round_start: 'mr_round_start', round_end: 'mr_round_end', match_end: 'mr_match_end' };
    (Array.isArray(body.events) ? body.events : []).forEach((ev) => {
      const name = String((typeof ev === 'string' ? ev : (ev && ev.name)) || '').toLowerCase();
      if (name === 'kill_feed') {
        const kf = (ev && ev.data) || {};
        state.mrMatch.gepData.killFeed = state.mrMatch.gepData.killFeed
          .concat([{ attacker: kf.attacker || null, victim: kf.victim || null, ts: Date.now() }]).slice(-12);
        return;
      }
      const trig = MR_EVENT_TRIGGERS[name];
      if (trig) flowBus.emit(trig, {
        map: state.mrMatch.gepData.map || null,
        game_mode: state.mrMatch.gepData.game_mode || null,
        match_outcome: state.mrMatch.gepData.match_outcome || null
      });
    });
    broadcastFullState();
    res.json({ ok: true });
  });

  // ── Rainbow Six Siege — Overwolf GEP relay ─────────────────────────────────
  // Same pipeline as /api/ow-gep and /api/mr-gep. R6 has no first-party GSI, so the Overwolf
  // companion running on an OBSERVER machine is the practical source (one install per broadcast,
  // rather than asking every competitor to install something).
  //
  // Body: { roster: [{name,operator,team,kills,deaths,assists,is_alive,…}×10],
  //         map, game_mode, match_id, round, score: {a,b}, side, operators: [{name,team}],
  //         events: ['match_start'|'round_start'|'round_end'|'match_end' | {name:'kill_feed',data:{attacker,victim}}] }
  //
  // Field names follow the shape the relay normalises to, NOT raw GEP keys — Overwolf's R6 feature
  // and field names must be confirmed against their docs and mapped in the companion (see the
  // R6_TODO note in companion-overwolf/background.html). Keeping the mapping in the relay means
  // this endpoint never has to change when Overwolf renames a field.
  app.post('/api/r6-gep', express.json({ limit: '64kb' }), (req, res) => {
    const body = req.body || {};
    if (!state.r6) state.r6 = { autoScore: false, gepData: null };
    const prev = state.r6.gepData || {};
    const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
    const score = {
      a: num(body.score && body.score.a, num(prev.score && prev.score.a, 0)),
      b: num(body.score && body.score.b, num(prev.score && prev.score.b, 0))
    };
    state.r6.gepData = {
      gepConnected: true,
      lastSeen: Date.now(),
      roster: Array.isArray(body.roster) ? body.roster.slice(0, 10) : (prev.roster || []),
      map: typeof body.map === 'string' && body.map ? body.map : (prev.map || null),
      game_mode: typeof body.game_mode === 'string' && body.game_mode ? body.game_mode : (prev.game_mode || null),
      match_id: body.match_id || prev.match_id || null,
      round: num(body.round, num(prev.round, 0)),
      side: typeof body.side === 'string' ? body.side : (prev.side || null),   // 'attack' | 'defense'
      score: score,
      operators: Array.isArray(body.operators) ? body.operators.slice(0, 10) : (prev.operators || []),
      killFeed: Array.isArray(prev.killFeed) ? prev.killFeed : []
    };
    // Opt-in only. A spectator client reconnecting mid-round can re-send a stale score, and a
    // scoreboard that moves on its own mid-broadcast is worse than one a producer has to nudge.
    if (state.r6.autoScore) {
      state.series.blue = score.a;
      state.series.orange = score.b;
    }
    const R6_EVENT_TRIGGERS = { match_start: 'r6_match_start', round_start: 'r6_round_start', round_end: 'r6_round_end', match_end: 'r6_match_end' };
    (Array.isArray(body.events) ? body.events : []).forEach((ev) => {
      const name = String((typeof ev === 'string' ? ev : (ev && ev.name)) || '').toLowerCase();
      if (name === 'kill_feed') {
        const kf = (ev && ev.data) || {};
        state.r6.gepData.killFeed = state.r6.gepData.killFeed
          .concat([{ attacker: kf.attacker || null, victim: kf.victim || null, ts: Date.now() }]).slice(-12);
        return;
      }
      const trig = R6_EVENT_TRIGGERS[name];
      if (trig) flowBus.emit(trig, { map: state.r6.gepData.map || null, round: state.r6.gepData.round, score: score });
    });
    broadcastFullState();
    res.json({ ok: true });
  });

  // ── Minecraft Bedwars — server-side plugin push ────────────────────────────
  // NOT a game-client relay. Bedwars is played on a server the organiser controls, so the server is
  // the authoritative scorer: a Spigot/Paper plugin POSTs here on bed break / final kill / team
  // elimination. Higher fidelity than any client-side scrape, no per-player install, no delay.
  //
  // Body: { teams: [{ key, name, bedAlive, players, eliminated }],
  //         events: [{ type:'bed_break'|'final_kill'|'team_eliminated'|'game_start'|'game_end',
  //                    team, by, victim }] }
  // Auth: optional shared secret in X-Suite-Token, matched against state.bedwars.token. Blank token
  // accepts any post (the suite binds locally; a token matters when the MC server is another host).
  app.post('/api/bedwars', express.json({ limit: '64kb' }), (req, res) => {
    if (!state.bedwars) state.bedwars = { autoScore: false, data: null };
    const want = String(ctx.bedwarsToken || '');
    if (want && String(req.get('X-Suite-Token') || '') !== want) {
      return res.status(401).json({ ok: false, error: 'bad token' });
    }
    const body = req.body || {};
    const prev = state.bedwars.data || {};
    const teams = Array.isArray(body.teams) ? body.teams.slice(0, 16).map((t) => ({
      key: String(t.key || t.name || '').slice(0, 32),
      name: String(t.name || t.key || '').slice(0, 64),
      bedAlive: t.bedAlive !== false,
      players: Math.max(0, Number(t.players) || 0),
      eliminated: !!t.eliminated
    })) : (prev.teams || []);
    state.bedwars.data = {
      connected: true,
      lastSeen: Date.now(),
      teams: teams,
      events: (Array.isArray(prev.events) ? prev.events : [])
        .concat((Array.isArray(body.events) ? body.events : []).map((e) => ({
          type: String((e && e.type) || '').slice(0, 32),
          team: (e && e.team) || null,
          by: (e && e.by) || null,
          victim: (e && e.victim) || null,
          ts: Date.now()
        })))
        .slice(-40)
    };
    // Surviving teams (bed intact or still alive) drive the two-sided scoreboard only when asked.
    if (state.bedwars.autoScore && teams.length >= 2) {
      state.series.blue = teams[0].eliminated ? 0 : 1;
      state.series.orange = teams[1].eliminated ? 0 : 1;
    }
    const BW_TRIGGERS = { bed_break: 'bedwars_bed_break', final_kill: 'bedwars_final_kill',
      team_eliminated: 'bedwars_team_eliminated', game_start: 'bedwars_game_start', game_end: 'bedwars_game_end' };
    (Array.isArray(body.events) ? body.events : []).forEach((e) => {
      const trig = BW_TRIGGERS[String((e && e.type) || '').toLowerCase()];
      if (trig) flowBus.emit(trig, { team: (e && e.team) || null, by: (e && e.by) || null, victim: (e && e.victim) || null });
    });
    broadcastFullState();
    res.json({ ok: true });
  });


  // ── Overwolf GEP → Valorant live game data ─────────────────────────────
  // Same relay pattern as /api/ow-gep and /api/mr-gep. Valorant has no first-party live feed of
  // any kind — no GSI, and its local client API serves nothing resembling match state — so
  // Overwolf is the route. GEP reads the LOCAL client, so the relay PC must be in the match; an
  // observer seat counts, and match_info.observing names who that seat is watching.
  // Body shape and the fields Valorant does NOT expose: backend/integrations/valorant-gep.js.
  app.post('/api/val-gep', express.json({ limit: '64kb' }), (req, res) => {
    try {
      applyValorantGep(req.body || {});
      // The watchdog is what turns the HUD's "not detected" badge back on when the relay stops.
      // Start it on first contact so a producer who never switched the app to Valorant still
      // gets an honest scoreboard rather than a frozen one.
      startValorantWatchdog();
      const VAL_EVENT_TRIGGERS = { match_start: 'val_match_start', match_end: 'val_match_end',
        spike_planted: 'val_spike_planted', spike_defused: 'val_spike_defused', spike_detonated: 'val_spike_detonated' };
      (Array.isArray(req.body && req.body.events) ? req.body.events : []).forEach((ev) => {
        const name = String((typeof ev === 'string' ? ev : (ev && ev.name)) || '').toLowerCase();
        const trig = VAL_EVENT_TRIGGERS[name];
        if (trig) flowBus.emit(trig, { map: state.valorant.map.displayName || null, round: state.valorant.round.number,
          score: { a: state.valorant.order.score, b: state.valorant.chaos.score } });
      });
      res.json({ ok: true });
    } catch (e) {
      console.error('[val-gep] relay update failed:', e && e.message);
      res.status(400).json({ ok: false, message: e && e.message });
    }
  });
};
