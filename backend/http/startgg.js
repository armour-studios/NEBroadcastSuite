'use strict';
// start.gg — HTTP routes (moved out of server.js's startHttpServer; called at the same point, so
// route order is unchanged). Values server.js reassigns, or declares further down, are
// read and written through ctx (savedTeams, startggApiToken).
let
  app, broadcastFullState, createStartGgClient, fetchAllEntrants, fetchEventSeeding,
  fetchLeagueInfo, fetchLeagueStandings, fetchMyTournaments, fetchTournamentDetail,
  fetchTournamentSets, lgRecalcServer, mapEntrantsToTeams, normalizeLeagueSlug, parseEventSlug,
  saveAppState, saveTeams, searchStartggLeagues, srvLgUid, state;
let ctx;

module.exports = function registerStartggRoutes(c) {
  ctx = c;
  ({
    app, broadcastFullState, createStartGgClient, fetchAllEntrants, fetchEventSeeding,
    fetchLeagueInfo, fetchLeagueStandings, fetchMyTournaments, fetchTournamentDetail,
    fetchTournamentSets, lgRecalcServer, mapEntrantsToTeams, normalizeLeagueSlug,
    parseEventSlug, saveAppState, saveTeams, searchStartggLeagues, srvLgUid, state
  } = c);

  // ── Start.gg API routes ──────────────────────────────────────────────────
  app.post('/api/startgg/search-teams', async (req, res) => {
    const { query, apiToken } = req.body;

    if (!apiToken) {
      return res.status(400).json({ error: 'Start.gg API token required' });
    }

    if (!query || query.length < 2) {
      return res.status(400).json({ error: 'Search query too short' });
    }

    try {
      const client = createStartGgClient(apiToken);
      const gqlQuery = `
        query searchTeams($query: String!) {
          teams(query: {filter: {name: $query}}) {
            nodes {
              id
              slug
              name
              members {
                id
              }
            }
          }
        }
      `;
      const result = await client.request(gqlQuery, { query });

      if (!result || result.errors) {
        return res.status(400).json({ error: 'Invalid Start.gg token or API error' });
      }

      const teams = (result?.teams?.nodes || []).map(t => ({
        name: t.name,
        slug: t.slug,
        playerCount: t.members?.length || 0,
        state: 'Active'
      }));
      res.json({ teams: teams.slice(0, 10) });
    } catch (err) {
      console.error('[Team Search Error]', err.message);
      res.status(500).json({ error: 'Failed to search teams. Check your API token.' });
    }
  });

  app.post('/api/startgg/test-token', async (req, res) => {
    const { apiToken } = req.body;

    if (!apiToken) {
      return res.status(400).json({ error: 'API token required', valid: false });
    }

    try {
      console.log('[Token Test] Testing with token length:', apiToken.length);
      const client = createStartGgClient(apiToken);
      const gqlQuery = `
        query {
          currentUser {
            id
            slug
          }
        }
      `;
      const result = await client.request(gqlQuery);

      console.log('[Token Test] Response:', result);

      if (result?.currentUser?.id) {
        console.log('[Token Test] SUCCESS - User:', result.currentUser.slug);
        res.json({ valid: true, user: result.currentUser.slug });
      } else if (result?.errors) {
        console.error('[Token Test] GraphQL Errors:', result.errors);
        res.json({ valid: false, error: 'GraphQL error: ' + (result.errors[0]?.message || 'Unknown') });
      } else {
        console.warn('[Token Test] No user in response:', result);
        res.json({ valid: false, error: 'Token returned no user' });
      }
    } catch (err) {
      console.error('[Token Test] Exception:', err.message);
      console.error('[Token Test] Full error:', err);
      res.json({ valid: false, error: 'Error: ' + err.message });
    }
  });

  // Pull season standings (placement + league points) from a start.gg LEAGUE and store them
  // so the overlay team-record feature can show authoritative season points/placement.
  app.post('/api/startgg/league-standings', async (req, res) => {
    const slug = (req.body && req.body.slug) || state.startggLeagueStandings.slug || '';
    if (!slug) return res.status(400).json({ error: 'League slug or URL required' });
    try {
      const { name, teams } = await fetchLeagueStandings(slug);
      state.startggLeagueStandings = {
        slug: normalizeLeagueSlug(slug), name, teams,
        fetchedAt: Date.now(), lastError: null
      };
      saveAppState();
      broadcastFullState();
      res.json({ ok: true, name, count: teams.length, teams });
    } catch (err) {
      state.startggLeagueStandings.lastError = err.message;
      state.startggLeagueStandings.slug = normalizeLeagueSlug(slug);
      saveAppState();
      broadcastFullState();
      res.status(502).json({ error: err.message });
    }
  });

  // Search start.gg leagues by name
  app.post('/api/startgg/search-leagues', async (req, res) => {
    const { name } = req.body || {};
    if (!name || name.length < 2) return res.status(400).json({ error: 'Search name too short' });
    try {
      const results = await searchStartggLeagues(name);
      res.json({ results });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Get league info (name + tournament list) without syncing
  app.post('/api/startgg/league-info', async (req, res) => {
    const { slug } = req.body || {};
    if (!slug) return res.status(400).json({ error: 'Slug required' });
    try {
      res.json(await fetchLeagueInfo(slug));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Sync completed sets from a start.gg league into an in-app league's schedule
  app.post('/api/startgg/league-sync', async (req, res) => {
    const { leagueId, slug } = req.body || {};
    const lg = (state.leagues || []).find(l => l.id === leagueId);
    if (!lg) return res.status(404).json({ error: 'League not found in app' });
    const rawSlug = slug || lg.startggSource;
    if (!rawSlug) return res.status(400).json({ error: 'No start.gg source set for this league' });

    try {
      const leagueInfo = await fetchLeagueInfo(rawSlug);

      // Build team name index for fuzzy matching against in-app roster
      const inAppTeams = (lg.teams || []).map(ref => ({
        id: ref.id,
        name: (ref.teamName || ref.name || '').trim()
      }));
      // Resolve a start.gg entrant to an in-app league team.
      //
      // This was "first exact, else first bidirectional substring, else null" — and `find` returns
      // whichever the array happened to hold first. With "TSM", "TSM Reborn" and "TSM Academy" all
      // in a league, an entrant named "TSM" bound to an arbitrary one of the three and silently
      // wrote results against the wrong team. Now every candidate is scored, and an ambiguous
      // result (two candidates within a hair of each other) resolves to null and gets logged —
      // an unlinked match a producer can fix beats a confidently wrong one.
      const _fmNorm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      function fuzzyMatch(entrantName) {
        if (!entrantName || !inAppTeams.length) return null;
        const needle = _fmNorm(entrantName);
        if (!needle) return null;
        const scored = inAppTeams.map((t) => {
          const tn = _fmNorm(t.name);
          let s = -1;
          if (!tn) s = -1;
          else if (tn === needle) s = 100;
          else if (tn.startsWith(needle) || needle.startsWith(tn)) {
            // Longer shared prefix = better; penalise the length the two names disagree on, so
            // "TSM" prefers "TSM" over "TSM Academy" and, among only the longer ones, prefers the
            // closest in length.
            s = 60 - Math.min(30, Math.abs(tn.length - needle.length));
          } else if (tn.includes(needle) || needle.includes(tn)) {
            s = 40 - Math.min(30, Math.abs(tn.length - needle.length));
          }
          return { t, s };
        }).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s);

        if (!scored.length) return null;
        if (scored.length > 1 && scored[0].s - scored[1].s < 8) {
          console.warn('[league-sync] ambiguous entrant "%s" — matches %s; left unlinked',
            entrantName, scored.slice(0, 3).map((x) => x.t.name).join(' / '));
          return null;
        }
        return scored[0].t.id;
      }

      const existingSggIds = new Set((lg.schedule || []).map(m => m.sggSetId).filter(Boolean));
      // Content fallback so matches added BEFORE sggSetId was reliably stored (or any that lost it)
      // still dedup — a given matchup in a given week is unique in league play.
      const contentKey = (a, b, wk) => `${String(a || '').toLowerCase().trim()}|${String(b || '').toLowerCase().trim()}|${String(wk || '')}`;
      const existingContent = new Set((lg.schedule || []).map(m => contentKey(m.sggTeamA, m.sggTeamB, m.week)));
      let imported = 0, skipped = 0;

      for (const tournament of leagueInfo.tournaments) {
        if (!tournament.slug) continue;
        let tData;
        try { tData = await fetchTournamentSets(tournament.slug); } catch (e) {
          console.warn('[league-sync] tournament skipped:', tournament.slug, e.message);
          continue;
        }
        const weekMatch = (tData.name || '').match(/\b(\d+)\b/);
        const week = weekMatch ? weekMatch[1] : '';
        const date = tData.startAt ? new Date(tData.startAt * 1000).toISOString().slice(0, 10) : '';

        for (const event of (tData.events || [])) {
          const sets = (event.sets && event.sets.nodes) || [];
          for (const set of sets) {
            if (!set) continue;
            if (existingSggIds.has(String(set.id))) { skipped++; continue; }
            const slots = set.slots || [];
            if (slots.length < 2) continue;
            const entA = slots[0] && slots[0].entrant;
            const entB = slots[1] && slots[1].entrant;
            if (!entA || !entB) continue;
            const cKey = contentKey(entA.name, entB.name, week);
            if (existingContent.has(cKey)) { skipped++; continue; }   // same matchup+week already present

            // Parse score from displayScore e.g. "TEAM A 2 - TEAM B 1"
            let scoreA = null, scoreB = null;
            const ds = String(set.displayScore || '');
            const sm = ds.match(/(\d+)\s*-\s*(\d+)/);
            if (sm) { scoreA = Number(sm[1]); scoreB = Number(sm[2]); }

            lg.schedule = lg.schedule || [];
            lg.schedule.push({
              id: srvLgUid('m'),
              sggSetId: String(set.id),
              teamA: fuzzyMatch(entA.name),
              teamB: fuzzyMatch(entB.name),
              sggTeamA: entA.name,
              sggTeamB: entB.name,
              format: 'BO3',
              week,
              date,
              result: { scoreA, scoreB }
            });
            existingSggIds.add(String(set.id));
            existingContent.add(cKey);
            imported++;
          }
        }
      }

      lg.startggSource = normalizeLeagueSlug(rawSlug);
      lg.sggSyncedAt = Date.now();
      lg.sggLeagueName = leagueInfo.name;

      if (imported > 0) lgRecalcServer(lg);
      saveAppState();
      broadcastFullState();
      // Return the updated league so the client can refresh its authoritative copy (schedule +
      // sggSetIds + standings). Without this the client keeps a stale copy — its next set_leagues save
      // wipes the imported matches, so the next sync's dedup set is empty and re-imports everything.
      res.json({ ok: true, imported, skipped, leagueName: leagueInfo.name, tournaments: leagueInfo.tournaments.length, league: lg });
    } catch (err) {
      console.error('[league-sync]', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  app.post('/api/startgg/search-tournaments', async (req, res) => {
    const { query } = req.body;
    const apiToken = req.body.apiToken || ctx.startggApiToken;   // fall back to the saved token

    if (!apiToken) {
      return res.status(400).json({ error: 'No start.gg API token yet. Add it under Apps > start.gg.' });
    }
    if (!query || query.length < 2) {
      return res.status(400).json({ error: 'Search query too short' });
    }

    // Optional date window: 'upcoming' (now→future), 'past' (→now), or 'all'.
    const filter = req.body.filter || 'all';
    const nowSec = Math.floor(Date.now() / 1000);

    const NODE_FIELDS = `
      id slug name startAt endAt numAttendees countryCode city
      events { id name slug numEntrants state startAt videogame { id name } }
      images { type url }
    `;

    try {
      const client = createStartGgClient(apiToken);
      const run = async (dateFilter, sortBy, perPage) => {
        const gqlQuery = `
          query searchTournaments($query: String!) {
            tournaments(query: {perPage: ${perPage}, page: 1, filter: {name: $query${dateFilter}}, sortBy: ${JSON.stringify(sortBy)}}) {
              nodes { ${NODE_FIELDS} }
            }
          }
        `;
        const result = await client.request(gqlQuery, { query });
        if (!result || result.errors) throw new Error('Start.gg API error');
        return result?.tournaments?.nodes || [];
      };

      let nodes;
      if (filter === 'upcoming') {
        nodes = await run(`, afterDate: ${nowSec}`, 'startAt asc', 32);
      } else if (filter === 'past') {
        nodes = await run(`, beforeDate: ${nowSec}`, 'startAt desc', 32);
      } else {
        // 'all' used to be ONE "startAt asc" query with no date window, i.e. the OLDEST tournaments
        // ever named like the query — searching "rocket" surfaced 2016 brackets. Ask for the nearest
        // upcoming AND the most recent past instead, then merge; that's what a producer means by "all".
        const [upcoming, past] = await Promise.all([
          run(`, afterDate: ${nowSec}`, 'startAt asc', 20).catch(() => []),
          run(`, beforeDate: ${nowSec}`, 'startAt desc', 20).catch(() => [])
        ]);
        const seen = new Set();
        nodes = [];
        [...upcoming, ...past].forEach((n) => { if (n && !seen.has(n.id)) { seen.add(n.id); nodes.push(n); } });
      }

      const tournaments = nodes.map(t => {
        const imageUrl = t.images?.find(img => img.type === 'profile')?.url ||
                        t.images?.find(img => img.type === 'banner')?.url ||
                        t.images?.[0]?.url || null;
        const events = (t.events || []).map(e => ({
          id: e.id, name: e.name, slug: e.slug, numEntrants: e.numEntrants || 0,
          state: e.state, startAt: e.startAt, game: (e.videogame && e.videogame.name) || ''
        }));
        return {
          name: t.name, slug: t.slug, id: t.id,
          startAt: t.startAt, endAt: t.endAt,
          numAttendees: t.numAttendees || 0,
          events,
          eventCount: events.length,
          games: [...new Set(events.map(e => e.game).filter(Boolean))],
          countryCode: t.countryCode || '', city: t.city || '',
          image: imageUrl
        };
      });
      res.json({ tournaments });
    } catch (err) {
      console.error('[Start.gg Tournament Search]', err);
      res.status(500).json({ error: 'Search failed. Check your start.gg API token under Apps > start.gg.' });
    }
  });

  app.post('/api/startgg/import-tournament', async (req, res) => {
    const { tournamentSlug, eventSlug, apiToken } = req.body;

    if (!apiToken) {
      return res.status(400).json({ error: 'Start.gg API token required' });
    }

    if (!tournamentSlug && !eventSlug) {
      return res.status(400).json({ error: 'Tournament or event slug required' });
    }

    try {
      const token = apiToken || ctx.startggApiToken;
      const slug = parseEventSlug(eventSlug || tournamentSlug);
      if (!slug) return res.status(400).json({ error: 'Invalid slug' });

      const client = createStartGgClient(token);
      const entrants = await fetchAllEntrants(client, slug);
      const teams = mapEntrantsToTeams(entrants);

      // Legacy behavior: still merge into saved on this call (for backward compat with old UI)
      let teamsAdded = 0;
      let playersAdded = 0;
      teams.forEach((t) => {
        const existing = ctx.savedTeams.find((st) => (st.name || '').toLowerCase() === t.name.toLowerCase());
        if (existing) {
          if (t.players && t.players.length) existing.players = t.players;
          if (t.logo && !existing.logo) existing.logo = t.logo;
        } else {
          ctx.savedTeams.push({ name: t.name, logo: t.logo, players: t.players });
          teamsAdded++;
        }
        playersAdded += (t.players || []).length;
      });
      saveTeams();
      broadcastFullState();

      res.json({ teamsAdded, playersAdded, totalTeams: teams.length });
    } catch (err) {
      console.error('[import-tournament]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // List tournaments the authenticated user administrates/owns (for Event picker)
  app.post('/api/startgg/my-tournaments', async (req, res) => {
    const { apiToken } = req.body;
    const token = apiToken || ctx.startggApiToken;
    if (!token) return res.status(400).json({ error: 'Start.gg API token required' });
    try {
      const list = await fetchMyTournaments(token);
      res.json({ tournaments: list });
    } catch (err) {
      console.error('[my-tournaments]', err.message);
      res.status(500).json({ error: err.message || 'Failed to load your tournaments' });
    }
  });

  // Full detail for one tournament (Events tab): events + player roster + sponsorship aggregates
  app.post('/api/startgg/tournament-detail', async (req, res) => {
    const { slug, apiToken } = req.body;
    const token = apiToken || ctx.startggApiToken;
    if (!token) return res.status(400).json({ error: 'Start.gg API token required' });
    if (!slug) return res.status(400).json({ error: 'Tournament slug required' });
    try {
      const detail = await fetchTournamentDetail(token, slug);
      res.json({ detail });
    } catch (err) {
      console.error('[tournament-detail]', err.message);
      res.status(500).json({ error: err.message || 'Failed to load tournament' });
    }
  });

  // Entrants + their current start.gg seed for an event (Tournaments tab, My Events refresh).
  app.post('/api/startgg/event-seeding', async (req, res) => {
    const token = (req.body && req.body.apiToken) || ctx.startggApiToken;
    const eventSlug = (req.body && req.body.eventSlug || '').trim();
    if (!token) return res.status(400).json({ error: 'Start.gg API token required' });
    if (!eventSlug) return res.status(400).json({ error: 'eventSlug required' });
    try {
      const data = await fetchEventSeeding(token, eventSlug);
      res.json({ ok: true, ...data });
    } catch (err) {
      console.error('[event-seeding]', err.message);
      res.status(500).json({ error: err.message || 'Failed to load entrants' });
    }
  });
};
