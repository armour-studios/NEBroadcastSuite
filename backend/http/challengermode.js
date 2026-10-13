'use strict';
// Challengermode — HTTP routes (moved out of server.js's startHttpServer; called at the same point, so
// route order is unchanged). Values server.js reassigns, or declares further down, are
// read and written through ctx (challengermodeRefreshKey).
let
  GAMES, app, challengermodeClient, cmData, createChallengermodeClient,
  fetchChallengermodeTournament, parseChallengermodeId, resolveGameId;
let ctx;

module.exports = function registerChallengermodeRoutes(c) {
  ctx = c;
  ({
    GAMES, app, challengermodeClient, cmData, createChallengermodeClient,
    fetchChallengermodeTournament, parseChallengermodeId, resolveGameId
  } = c);

  // ── Challonge API routes ──────────────────────────────────────────────────

  // ── Challengermode (challengermode.com) ────────────────────────────────────
  // NOT Challonge. GraphQL behind a bot token — see backend/integrations/challengermode-client.js.

  // Verify the refresh key without touching tournament data.
  app.post('/api/challengermode/test-token', async (req, res) => {
    const key = (req.body?.refreshKey || ctx.challengermodeRefreshKey || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'Refresh key required' });
    try {
      const client = (key === ctx.challengermodeRefreshKey) ? challengermodeClient() : createChallengermodeClient(key);
      await client.testConnection();
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // Browse tournaments to load. Two ways in, because organisers think in both:
  //   spaceId  → "my organisation's tournaments"
  //   gameSlug → "every open tournament for this game"
  app.post('/api/challengermode/tournaments', async (req, res) => {
    if (!ctx.challengermodeRefreshKey) return res.status(400).json({ ok: false, error: 'Challengermode refresh key required' });
    const spaceId = parseChallengermodeId(req.body?.spaceId || '') || '';
    const gameSlug = String(req.body?.gameSlug || '').trim();
    const completed = !!req.body?.completed;
    // The filter is a @oneOf input — exactly one selector, never both.
    const tournamentFilter = completed ? { completedTournamentSelector: {} } : { openTournamentSelector: {} };
    try {
      let rows = [];
      if (spaceId) {
        const d = await challengermodeClient().query(cmData.SPACE_QUERY, {
          input: { spaceId, tournamentFilter, includeUnlisted: true, includeInviteOnly: true }
        });
        rows = (d && d.tournamentsForSpace) || [];
      } else if (gameSlug) {
        const d = await challengermodeClient().query(cmData.SEARCH_QUERY, {
          input: { gameSlug, tournamentFilter }
        });
        rows = (d && d.tournamentsForGame) || [];
      } else {
        return res.status(400).json({ ok: false, error: 'Give a Space id (your organisation) or a game slug.' });
      }
      res.json({
        ok: true,
        tournaments: rows.map((t) => ({
          id: t.id,
          name: t.name || '',
          state: t.state || '',
          gameName: (t.gameTitle && (t.gameTitle.title || t.gameTitle.slug)) || '',
          gameSlug: (t.gameTitle && t.gameTitle.slug) || '',
          // Which of OUR games it is, so the picker can show what loading it will switch to.
          gameId: resolveGameId((t.gameTitle && t.gameTitle.slug) || (t.gameTitle && t.gameTitle.title) || '', Object.keys(GAMES)),
          entrants: (((t.attendance || {}).roster || {}).lineupCount) || 0,
          url: `https://www.challengermode.com/tournaments/${t.id}`
        }))
      });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  // One tournament's detail, for the confirm step before loading it.
  app.post('/api/challengermode/tournament-detail', async (req, res) => {
    if (!ctx.challengermodeRefreshKey) return res.status(400).json({ ok: false, error: 'Challengermode refresh key required' });
    const id = parseChallengermodeId(req.body?.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'Paste a Challengermode tournament link or id.' });
    try {
      const t = await fetchChallengermodeTournament(id, { live: false });
      const series = cmData.allSeries(t);
      res.json({
        ok: true,
        tournament: {
          id: t.id, name: t.name || '', state: t.state || '',
          gameName: (t.gameTitle && (t.gameTitle.title || t.gameTitle.slug)) || '',
          gameId: resolveGameId((t.gameTitle && t.gameTitle.slug) || '', Object.keys(GAMES)),
          stages: (t.stages || []).map((st) => ({ index: st.index, format: st.format })),
          entrants: (((t.attendance || {}).roster || {}).lineupCount) || 0,
          url: `https://www.challengermode.com/tournaments/${id}`
        },
        entrants: cmData.buildEventTeams(t).map((x) => ({ name: x.name, seed: x.seed, logo: x.logo })),
        matches: series.length,
        live: series.filter((x) => x.state === 'RUNNING').length,
        placements: cmData.buildPlacements(t, 8).rows.length
      });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });
};
