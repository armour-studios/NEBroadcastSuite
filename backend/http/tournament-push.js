'use strict';
// Challonge push, NXGEN, FACEIT and map veto import — HTTP routes (moved out of server.js's startHttpServer; called at the same point, so
// route order is unchanged). Values server.js reassigns, or declares further down, are
// read and written through ctx (challongeApiKey, faceitApiKey, nxgenApiKey, savedTeams, startggApiToken).
let
  app, broadcastFullState, buildChallongeParticipantMap, createChallongeClient,
  createStartGgClient, faceit, fetchAllSets, fetchEntrantTrueSeeds, fetchPageHtml,
  getNxgenEventLive, getNxgenEvents, getNxgenLeaderboard, handleControlMessage,
  resolveChallongeParticipant, saveAppState, setExclusiveGfxVisible, state, vetoImport,
  vetoLoad;
let ctx;

module.exports = function registerTournamentPushRoutes(c) {
  ctx = c;
  ({
    app, broadcastFullState, buildChallongeParticipantMap, createChallongeClient,
    createStartGgClient, faceit, fetchAllSets, fetchEntrantTrueSeeds, fetchPageHtml,
    getNxgenEventLive, getNxgenEvents, getNxgenLeaderboard, handleControlMessage,
    resolveChallongeParticipant, saveAppState, setExclusiveGfxVisible, state, vetoImport,
    vetoLoad
  } = c);

  // ── Challonge cross-platform push routes ─────────────────────────────────

  // Create a new Challonge tournament
  app.post('/api/challonge/create-tournament', async (req, res) => {
    const key = (req.body?.apiKey || ctx.challongeApiKey || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'Challonge API key required' });
    const { name, slug, tournamentType = 'single elimination', gameName = '', private: isPrivate = false } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ ok: false, error: 'Tournament name required' });
    if (!slug || !slug.trim()) return res.status(400).json({ ok: false, error: 'Tournament URL/slug required' });
    try {
      const client = createChallongeClient(key);
      const data = await client.post('/tournaments.json', {
        tournament: {
          name: name.trim(),
          url: slug.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/__+/g, '_').slice(0, 60),
          tournament_type: tournamentType,
          game_name: gameName || '',
          open_signup: false,
          private: !!isPrivate
        }
      });
      const t = data.tournament;
      res.json({ ok: true, slug: t.url, name: t.name, url: t.full_challonge_url, id: t.id });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // Bulk-add participants to a Challonge tournament (with optional seeding + username mapping)
  app.post('/api/challonge/sync-participants', async (req, res) => {
    const key = (req.body?.apiKey || ctx.challongeApiKey || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'Challonge API key required' });
    const { tournamentSlug, participants, clearExisting = false, eventSlug } = req.body || {};
    if (!tournamentSlug) return res.status(400).json({ ok: false, error: 'Tournament slug required' });
    if (!Array.isArray(participants) || participants.length === 0) return res.status(400).json({ ok: false, error: 'No participants provided' });
    try {
      const client = createChallongeClient(key);
      const slug = tournamentSlug.trim();

      // Prefer start.gg's REAL bracket seed over whatever the caller supplied — locally-cached
      // roster/seeding-studio order can drift from the seed that actually produced the real
      // bracket's bye placement, which would seed a mirrored Challonge bracket with a DIFFERENT
      // shape (wrong pairings throughout, not just cosmetically wrong seed numbers).
      let trueSeeds = null;
      if (eventSlug) { try { trueSeeds = await fetchEntrantTrueSeeds(eventSlug); } catch (e) { console.warn('[Challonge sync] true-seed fetch failed (falling back to supplied seeds):', e.message); } }

      // Optionally clear existing participants (only works if bracket not started)
      if (clearExisting) {
        try {
          const existing = await client.get(`/tournaments/${slug}/participants.json`);
          if (Array.isArray(existing) && existing.length > 0) {
            await client.del(`/tournaments/${slug}/participants/clear.json`);
          }
        } catch (clearErr) {
          // Non-fatal: if clear fails (e.g. bracket started), we proceed and add new ones
          console.warn('[Challonge sync] Clear participants failed (ignored):', clearErr.message);
        }
      }

      // Build participant payload — process in chunks of 100
      const CHUNK = 100;
      let added = 0;
      const errors = [];
      for (let i = 0; i < participants.length; i += CHUNK) {
        const chunk = participants.slice(i, i + CHUNK).map((p, idx) => {
          const entry = { name: (p.name || '').slice(0, 64) };
          const trueSeed = trueSeeds && trueSeeds[(p.name || '').toLowerCase()];
          const seed = trueSeed != null ? trueSeed : p.seed;
          if (seed) entry.seed = seed;
          if (p.challongeUsername) entry.challonge_username = p.challongeUsername;
          if (p.misc) entry.misc = String(p.misc).slice(0, 255);
          return entry;
        });
        try {
          await client.post(`/tournaments/${slug}/participants/bulk_add.json`, { participants: chunk });
          added += chunk.length;
        } catch (chunkErr) {
          errors.push(chunkErr.message);
        }
      }

      const msg = errors.length
        ? `Added ${added} of ${participants.length} participants. Errors: ${errors.join('; ')}`
        : `${added} participant${added !== 1 ? 's' : ''} added to "${slug}".`;
      res.json({ ok: errors.length === 0, added, total: participants.length, message: msg, errors });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // Start (generate bracket for) a Challonge tournament
  app.post('/api/challonge/start-bracket', async (req, res) => {
    const key = (req.body?.apiKey || ctx.challongeApiKey || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'Challonge API key required' });
    const { tournamentSlug } = req.body || {};
    if (!tournamentSlug) return res.status(400).json({ ok: false, error: 'Tournament slug required' });
    try {
      const client = createChallongeClient(key);
      await client.post(`/tournaments/${tournamentSlug.trim()}/start.json`, {});
      res.json({ ok: true, message: 'Bracket generated successfully.' });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // Repair an already-started Challonge bracket whose shape doesn't match start.gg's real one —
  // this happens when it was originally seeded with stale/wrong numbers (see fetchEntrantTrueSeeds).
  // Resets the tournament (clears recorded results, unlocks participant edits — does NOT remove
  // participants), re-applies each participant's TRUE start.gg seed, then regenerates the bracket.
  // After this, /api/challonge/push-results can actually find matching pairings to fill in.
  app.post('/api/challonge/rebuild-bracket', async (req, res) => {
    if (!ctx.challongeApiKey) return res.status(400).json({ ok: false, error: 'Challonge API key required' });
    const { tournamentSlug, eventSlug } = req.body || {};
    if (!tournamentSlug) return res.status(400).json({ ok: false, error: 'Challonge tournament slug required' });
    if (!eventSlug) return res.status(400).json({ ok: false, error: 'start.gg event slug required' });
    const slug = tournamentSlug.trim();
    try {
      const trueSeeds = await fetchEntrantTrueSeeds(eventSlug);
      const client = createChallongeClient(ctx.challongeApiKey);

      const tData = await client.get(`/tournaments/${slug}.json`);
      if (tData.tournament.state !== 'pending') {
        await client.post(`/tournaments/${slug}/reset.json`, {});
      }

      const participants = await client.get(`/tournaments/${slug}/participants.json`);
      let reseeded = 0, missed = 0;
      for (const p of (participants || [])) {
        const d = p.participant || p;
        const trueSeed = trueSeeds[(d.name || d.display_name || '').toLowerCase()];
        if (trueSeed == null) { missed++; continue; }
        if (d.seed === trueSeed) continue;   // already correct, skip the write
        try {
          await client.put(`/tournaments/${slug}/participants/${d.id}.json`, { participant: { seed: trueSeed } });
          reseeded++;
        } catch (e) {
          console.error('[challonge rebuild-bracket] reseed failed for', d.name, e.message);
        }
      }

      await client.post(`/tournaments/${slug}/start.json`, {});
      res.json({ ok: true, reseeded, missed, total: (participants || []).length, message: `Reseeded ${reseeded} participant(s) with their true start.gg seed and regenerated the bracket.` });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // Backfill every COMPLETED start.gg result onto a Challonge bracket, in one call. Works for a
  // fully-played PAST event (fills in the whole bracket at once) and for a partially-played
  // current one (fills in what's done so far — live results then keep flowing via the existing
  // link_event_challonge auto-sync). Independent of state.bracket, so it doesn't matter whether
  // this event is the one currently loaded live — it fetches the event's own sets fresh.
  app.post('/api/challonge/push-results', async (req, res) => {
    if (!ctx.challongeApiKey) return res.status(400).json({ ok: false, error: 'Challonge API key required' });
    const { tournamentSlug, eventSlug } = req.body || {};
    if (!tournamentSlug) return res.status(400).json({ ok: false, error: 'Challonge tournament slug required' });
    if (!eventSlug) return res.status(400).json({ ok: false, error: 'start.gg event slug required' });
    if (!ctx.startggApiToken) return res.status(400).json({ ok: false, error: 'No start.gg API token yet. Add it under Apps > start.gg.' });
    const slug = tournamentSlug.trim();
    try {
      const sgClient = createStartGgClient(ctx.startggApiToken);
      const { sets } = await fetchAllSets(sgClient, eventSlug);

      // Every decided 1v1 set with two named entrants — this is the full result history.
      const completed = [];
      (sets || []).forEach((s) => {
        if (!s || !s.winnerId) return;
        const slots = s.slots || [];
        if (slots.length !== 2) return;
        const [s0, s1] = slots;
        const nameA = s0.entrant && s0.entrant.name, nameB = s1.entrant && s1.entrant.name;
        if (!nameA || !nameB) return;
        const scoreOf = (slot) => { const v = slot.standing && slot.standing.stats && slot.standing.stats.score && slot.standing.stats.score.value; return (v == null) ? null : Number(v); };
        let scoreA = scoreOf(s0), scoreB = scoreOf(s1);
        const winnerIsA = s.winnerId === s0.entrant.id;
        if (scoreA == null || scoreB == null) { scoreA = winnerIsA ? 1 : 0; scoreB = winnerIsA ? 0 : 1; }   // DQ/no-score sets
        completed.push({ nameA, nameB, scoreA, scoreB, winnerIsA, round: Number(s.round) || 0 });
      });
      if (!completed.length) return res.json({ ok: true, pushed: 0, total: 0, message: 'No completed matches yet on start.gg for this event.' });

      // Order so that when the SAME two teams meet more than once (e.g. Winners match then a Grand
      // Finals rematch), the earlier-bracket result is consumed first: winners/GF (round>0) ascending,
      // then losers (round<0) by depth. This keeps rematches from grabbing each other's result.
      const _rk = (r) => (r >= 0 ? r : 1e6 + Math.abs(r));
      completed.sort((a, b) => _rk(a.round) - _rk(b.round));

      const pm = await buildChallongeParticipantMap(slug);
      const cClient = createChallongeClient(ctx.challongeApiKey);

      // Resolve each set's two entrants to Challonge participants up front (tolerant of case/spacing/
      // punctuation differences). Names that don't resolve are reported, not silently dropped — a
      // missing prerequisite stalls the cascade and leaves losers/grand finals empty.
      const nameMisses = new Set();
      completed.forEach((cm) => {
        cm.pA = resolveChallongeParticipant(pm, cm.nameA);
        cm.pB = resolveChallongeParticipant(pm, cm.nameB);
        cm.consumed = false;
        if (!cm.pA) nameMisses.add(cm.nameA);
        if (!cm.pB) nameMisses.add(cm.nameB);
      });

      // Challonge only opens a match once its feeders are recorded, so cascade: fill every open
      // match we can, re-fetch, repeat until a full pass makes no progress. Iterate OPEN matches and
      // take the first unconsumed set for each pairing — so a Grand-Finals rematch gets its OWN
      // result instead of being deduped away (the previous bug that left grand finals blank).
      let pushed = 0, guard = 0, progressed = true;
      while (progressed && guard < 60) {
        guard++;
        progressed = false;
        const mData = await cClient.get(`/tournaments/${slug}/matches.json`);
        const openMatches = (mData || []).filter((m) => (m.match || m).state === 'open');
        if (!openMatches.length) break;
        for (const m of openMatches) {
          const d = m.match || m;
          if (!d.player1_id || !d.player2_id) continue;
          const cm = completed.find((c) => !c.consumed && c.pA && c.pB &&
            ((d.player1_id === c.pA.id && d.player2_id === c.pB.id) ||
             (d.player1_id === c.pB.id && d.player2_id === c.pA.id)));
          if (!cm) continue;
          const isAp1 = d.player1_id === cm.pA.id;
          const winnerId = cm.winnerIsA ? cm.pA.id : cm.pB.id;
          const scoresCSV = isAp1 ? `${cm.scoreA}-${cm.scoreB}` : `${cm.scoreB}-${cm.scoreA}`;
          try {
            await cClient.put(`/tournaments/${slug}/matches/${d.id}.json`, { match: { winner_id: winnerId, scores_csv: scoresCSV } });
            cm.consumed = true; pushed++; progressed = true;
          } catch (e) {
            cm.consumed = true;   // don't let one rejected set spin the cascade — skip it and continue
            console.error('[challonge push-results] failed:', cm.nameA, 'vs', cm.nameB, e.message);
          }
        }
      }

      const misses = Array.from(nameMisses);
      const unplaced = completed.filter((c) => c.pA && c.pB && !c.consumed).map((c) => `${c.nameA} vs ${c.nameB}`);
      let message = `Pushed ${pushed} of ${completed.length} completed result(s) to Challonge.`;
      if (misses.length) message += ` ${misses.length} team name(s) don't match any Challonge participant: ${misses.slice(0, 8).join(', ')}${misses.length > 8 ? '…' : ''}. Rename them in Challonge to match start.gg, then push again.`;
      else if (unplaced.length) message += ` ${unplaced.length} result(s) never found an open Challonge match — the bracket shape likely differs from start.gg. Try Rebuild bracket, then push again.`;
      res.json({ ok: true, pushed, total: completed.length, unmatchedNames: misses, unplaced, message });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // ── NXGEN API routes ──────────────────────────────────────────────────────

  app.post('/api/nxgen/events', async (req, res) => {
    const key = (req.body?.apiKey || ctx.nxgenApiKey || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'API key required' });
    try {
      const { limit = 30, status, includePast = false } = req.body || {};
      const data = await getNxgenEvents(key, { limit, status, includePast });
      res.json({ ok: true, events: data.events || [] });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/nxgen/event-live', async (req, res) => {
    const key = (req.body?.apiKey || ctx.nxgenApiKey || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'API key required' });
    const slug = (req.body?.slug || '').trim();
    if (!slug) return res.status(400).json({ ok: false, error: 'slug required' });
    try {
      const data = await getNxgenEventLive(key, slug);
      res.json({ ok: true, ...data });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/nxgen/leaderboard', async (req, res) => {
    const key = (req.body?.apiKey || ctx.nxgenApiKey || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'API key required' });
    try {
      const data = await getNxgenLeaderboard(key);
      res.json({ ok: true, teams: data.teams || [], players: data.players || [] });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // ── FACEIT API routes ─────────────────────────────────────────────────────
  // Same contract as the NXGEN routes: the control panel is file:// so it calls these over
  // http://localhost:3000 rather than talking to FACEIT itself (which would leak the key into
  // the renderer and trip CORS).

  const faceitKey = (req) => (req.body?.apiKey || ctx.faceitApiKey || '').trim();

  // The Events tab's "my competitions" list: an organiser's own championships + hubs, so a
  // producer who runs a league sees their own events instead of searching the whole platform.
  // ── Map veto import: paste a FACEIT room or HLTV match link ──
  // Two steps so the producer sees what was found before anything changes: fetch → preview →
  // apply (with or without replacing the match teams).
  app.post('/api/veto/import', async (req, res) => {
    const url = String((req.body && req.body.url) || '').trim();
    try {
      const imp = await vetoImport.importVeto(url, { faceitKey: faceitKey(req), fetchHtml: fetchPageHtml });
      res.json(Object.assign({ ok: true }, imp));
    } catch (e) { res.status(400).json({ ok: false, error: e.message || String(e), openUrl: e.openUrl || '' }); }
  });
  app.post('/api/veto/import/apply', (req, res) => {
    const imp = req.body && req.body.import;
    if (!imp || !Array.isArray(imp.steps) || !imp.steps.length) return res.status(400).json({ ok: false, error: 'Nothing to apply' });
    try {
      const norm = (x) => String(x == null ? '' : x).trim().toLowerCase();
      const teams = Array.isArray(imp.teams) ? imp.teams : [];
      const names = teams.map((tm) => norm(tm && tm.name));
      // Imported team 1 goes to blue unless the sides are already set the other way round.
      let flip = false;
      if (names[1] && names[1] === norm(state.teams.blue && state.teams.blue.name)) flip = true;
      else if (names[0] && names[0] === norm(state.teams.orange && state.teams.orange.name)) flip = true;
      if (req.body.flip === true) flip = true; else if (req.body.flip === false) flip = false;
      const sw = (i) => (i == null ? null : (flip ? 1 - i : i));
      const prepared = Object.assign({}, imp, {
        teamStart: flip ? (imp.teamStart === 'b' ? 'a' : 'b') : imp.teamStart,
        steps: imp.steps.map((s) => Object.assign({}, s, { by: sw(s.by) })),
        results: (imp.results || []).map((r) => Object.assign({}, r, { winner: sw(r.winner), score: flip && r.score ? { a: r.score.b, b: r.score.a } : r.score })),
      });
      if (req.body.applyTeams) {
        const ordered = flip ? [teams[1], teams[0]] : teams;
        ['blue', 'orange'].forEach((side, i) => {
          const tm = ordered[i]; if (!tm || !tm.name) return;
          // A team already in the library keeps its own logo; an unknown one takes the page's.
          const lib = (ctx.savedTeams || []).find((x) => x && norm(x.name) === norm(tm.name));
          handleControlMessage({ type: 'set_team', data: { side, name: String(tm.name).trim(), logo: (lib && lib.logo) || tm.logo || null } }, null);
        });
        const bo = Number(prepared.bestOf);
        if ([1, 3, 5, 7].includes(bo) && bo !== state.bestOf) handleControlMessage({ type: 'set_best_of', data: { value: bo } }, null);
      }
      vetoLoad(prepared, { game: 'csgo' });
      if (req.body.show) setExclusiveGfxVisible('veto', true);
      saveAppState(); broadcastFullState();
      res.json({ ok: true, flip });
    } catch (e) { res.status(400).json({ ok: false, error: e.message || String(e) }); }
  });

  app.post('/api/faceit/my-competitions', async (req, res) => {
    const key = faceitKey(req);
    if (!key) return res.status(400).json({ ok: false, error: 'API key required' });
    try {
      let orgId = (req.body?.organizerId || state.faceit.organizerId || '').trim();
      const orgName = (req.body?.organizerName || state.faceit.organizerName || '').trim();
      if (!orgId && orgName) {
        const org = await faceit.getFaceitOrganizerByName(key, orgName);
        orgId = org && org.organizer_id ? org.organizer_id : '';
        if (orgId) { state.faceit.organizerId = orgId; state.faceit.organizerName = org.name || orgName; saveAppState(); }
      }
      if (!orgId) return res.json({ ok: true, competitions: [], needsOrganizer: true });
      const [champs, hubs] = await Promise.all([
        faceit.getFaceitOrganizerChampionships(key, orgId),
        faceit.getFaceitOrganizerHubs(key, orgId)
      ]);
      const competitions = [
        ...champs.map((c) => ({
          id: c.championship_id, type: 'championship', name: c.name,
          game: c.game_id || '', region: c.region || '', status: c.status || '',
          slots: c.slots || c.total_slots || null, avatar: c.avatar || c.cover_image || '',
          url: faceit.faceitUrl(c.faceit_url)
        })),
        ...hubs.map((h) => ({
          id: h.hub_id, type: 'hub', name: h.name,
          game: h.game_id || '', region: h.region || '', status: 'hub',
          slots: null, avatar: h.avatar || h.cover_image || '',
          url: faceit.faceitUrl(h.faceit_url)
        }))
      ];
      res.json({ ok: true, competitions, organizerId: orgId });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/faceit/search', async (req, res) => {
    const key = faceitKey(req);
    if (!key) return res.status(400).json({ ok: false, error: 'API key required' });
    try {
      const { name = '', game = '', region = '', limit = 30 } = req.body || {};
      const items = await faceit.searchFaceitChampionships(key, { name, game, region, limit });
      res.json({
        ok: true,
        competitions: items.map((c) => ({
          id: c.championship_id || c.id, type: 'championship', name: c.name,
          game: c.game_id || c.game || '', region: c.region || '', status: c.status || '',
          slots: c.slots || c.total_slots || null,
          avatar: c.avatar || c.cover_image || (c.organizer && c.organizer.avatar) || '',
          organizer: (c.organizer && c.organizer.name) || c.organizer_name || '',
          url: faceit.faceitUrl(c.faceit_url)
        }))
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/faceit/organizer', async (req, res) => {
    const key = faceitKey(req);
    if (!key) return res.status(400).json({ ok: false, error: 'API key required' });
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'organizer name required' });
    try {
      const org = await faceit.getFaceitOrganizerByName(key, name);
      res.json({ ok: true, organizerId: org.organizer_id || '', name: org.name || name, avatar: org.avatar || '' });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/faceit/competition', async (req, res) => {
    const key = faceitKey(req);
    if (!key) return res.status(400).json({ ok: false, error: 'API key required' });
    const parsed = faceit.parseFaceitCompetition(req.body?.id || '');
    const id = parsed ? parsed.id : (req.body?.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'championship or hub id required' });
    const type = req.body?.competitionType || (parsed ? parsed.type : 'championship');
    try {
      const { comp, matches, subs, results } = await (async () => {
        if (type === 'hub') {
          const [c, m] = await Promise.all([faceit.getFaceitHub(key, id), faceit.getFaceitHubMatches(key, id, 'all')]);
          return { comp: c, matches: m, subs: [], results: [] };
        }
        const [c, m, s, r] = await Promise.all([
          faceit.getFaceitChampionship(key, id),
          faceit.getFaceitChampionshipMatches(key, id, 'all'),
          faceit.getFaceitChampionshipSubscriptions(key, id),
          faceit.getFaceitChampionshipResults(key, id)
        ]);
        return { comp: c, matches: m, subs: s, results: r };
      })();
      res.json({ ok: true, competition: comp, matches, subscriptions: subs, results });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
};
