'use strict';
// Brawlhalla API — HTTP routes (moved out of server.js's startHttpServer; called at the same point, so
// route order is unchanged). Values server.js reassigns, or declares further down, are
// read and written through ctx (challongeApiKey).
let
  app, brawlhalla, broadcastFullState, challongePartMap, createChallongeClient, saveAppState,
  state;
let ctx;

module.exports = function registerBrawlhallaRoutes(c) {
  ctx = c;
  ({
    app, brawlhalla, broadcastFullState, challongePartMap, createChallongeClient, saveAppState,
    state
  } = c);

  // ── Brawlhalla API (api.brawlhalla.com v1) ─────────────────────────────────
  // No API key — v1 dropped the key requirement — so these routes work out of the box. Budget is
  // 2000 requests / 5 min; backend/brawlhalla.js caches so a panel polling these can't blow it.
  //
  // There is NO live match feed for Brawlhalla. These routes serve the IDENTITY layer (who this
  // player is, how they rank, what they play); stocks and the legend on air stay producer-driven.

  // Find a player by name. This is a ranked-LEADERBOARD search — the only name lookup v1 has — so
  // an unranked player genuinely cannot be found this way. `hits: []` means "not on the ladder",
  // not "lookup failed"; the response says so in `note` for the panel to print.
  app.post('/api/brawlhalla/search', async (req, res) => {
    const q = String(req.body?.query || '').trim();
    if (!q) return res.status(400).json({ ok: false, error: 'query required' });
    try {
      const hits = await brawlhalla().searchPlayers(q, {
        mode: req.body?.mode || '1v1',
        region: req.body?.region || state.brawlhalla.region || 'ALL',
        limit: Math.min(25, Number(req.body?.limit) || 10)
      });
      res.json({ ok: true, hits, note: hits.length ? '' : 'No ranked player by that name. Brawlhalla can only be searched through the ranked leaderboard, so an unranked player will not appear — link them by Brawlhalla ID instead.' });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  // One player's ranked card (ELO, tier, peak, ranks, season W/L, most-played legends).
  app.post('/api/brawlhalla/card', async (req, res) => {
    const id = Number(req.body?.brawlhallaId) || 0;
    if (!id) return res.status(400).json({ ok: false, error: 'brawlhallaId required' });
    try {
      const card = await brawlhalla().playerCard(id, { mode: req.body?.mode || state.brawlhalla.rankMode, force: !!req.body?.force });
      if (!card) return res.json({ ok: true, card: null, note: 'No ranked record for that Brawlhalla ID this season.' });
      res.json({ ok: true, card });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  // A region's ranked ladder — a standings/top-N board that needs no bracket at all.
  app.post('/api/brawlhalla/leaderboard', async (req, res) => {
    try {
      const r = await brawlhalla().leaderboard({
        mode: req.body?.mode || '1v1',
        region: req.body?.region || state.brawlhalla.region || 'ALL',
        page: Number(req.body?.page) || 1,
        limit: Math.min(50, Number(req.body?.limit) || 25),
        orderBy: req.body?.orderBy || ''
      });
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  // Push a ranked ladder straight onto the standings board. The board is game-agnostic, so this is
  // the same graphic every other source fills — it just arrives from a ladder instead of a bracket.
  app.post('/api/brawlhalla/push-leaderboard', async (req, res) => {
    try {
      const region = String(req.body?.region || state.brawlhalla.region || 'ALL').toUpperCase();
      const mode = req.body?.mode || '1v1';
      const limit = Math.min(50, Number(req.body?.limit) || 8);
      const r = await brawlhalla().leaderboard({ mode, region, limit });
      state.standings.rows = r.rows.map((row) => ({
        placement: row.placement, name: row.name, wins: row.wins, losses: row.losses, points: row.rating
      }));
      state.standings.source = 'manual';   // a one-shot snapshot: nothing re-mirrors a ladder
      state.standings.title = state.standings.title || `Brawlhalla ${mode} — ${region === 'ALL' ? 'Global' : region}`;
      state.standings.subtitle = 'Ranked ladder';
      state.standings.attribution = 'Brawlhalla Ranked';
      saveAppState();
      broadcastFullState();
      res.json({ ok: true, rows: state.standings.rows.length });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  // The static legend table. The shipped overlay/brawlhalla-legends.js is the offline copy of
  // this — the route exists so assets/fetch-brawlhalla-legends.js can regenerate it after a patch.
  app.get('/api/brawlhalla/legends', async (req, res) => {
    try {
      res.json({ ok: true, legends: await brawlhalla().legends({ force: req.query.force === '1' }) });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/challonge/test-token', async (req, res) => {
    const key = (req.body?.apiKey || ctx.challongeApiKey || '').trim();
    if (!key) return res.status(400).json({ error: 'API key required' });
    try {
      const client = createChallongeClient(key);
      await client.get('/tournaments.json', { state: 'all', per_page: 1 });
      res.json({ ok: true, message: 'API key is valid.' });
    } catch (e) {
      res.status(401).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/challonge/my-tournaments', async (req, res) => {
    const key = (req.body?.apiKey || ctx.challongeApiKey || '').trim();
    const extraSubdomains = Array.isArray(req.body?.subdomains)
      ? req.body.subdomains.filter(s => s && typeof s === 'string').map(s => s.trim().toLowerCase())
      : [];
    if (!key) return res.status(400).json({ error: 'API key required' });
    try {
      const client = createChallongeClient(key);
      const subdomainErrors = [];
      async function fetchGroup(subdomain) {
        const p = subdomain ? { subdomain } : {};
        try {
          const [pending, inProgress, ended] = await Promise.all([
            client.get('/tournaments.json', { state: 'pending',  ...p }),
            client.get('/tournaments.json', { state: 'underway', ...p }),
            client.get('/tournaments.json', { state: 'ended',    ...p })
          ]);
          return [...(inProgress || []), ...(pending || []), ...((ended || []).slice(0, 15))];
        } catch (e) {
          if (subdomain) subdomainErrors.push({ subdomain, error: e.message });
          return [];
        }
      }
      // Affiliates: APIv2.1 returns every community tournament they can see with
      // include_community_tournaments=1, so the subdomain doesn't have to be typed in by hand.
      // Keys without affiliate access just get nothing extra, so any failure here is swallowed.
      let communityError = null;
      async function fetchCommunityV2() {
        const states = ['in_progress', 'pending', 'ended'];
        try {
          const pages = await Promise.all(states.map(state =>
            client.getV2('/tournaments.json', { include_community_tournaments: 1, state, per_page: 50 })));
          return pages.flatMap((p, i) => {
            const rows = Array.isArray(p?.data) ? p.data : [];
            return states[i] === 'ended' ? rows.slice(0, 15) : rows;
          });
        } catch (e) {
          communityError = e.message;
          return [];
        }
      }
      // Map a v2.1 JSON:API row onto the v1 { tournament: {...} } shape the rest of this route reads.
      function v2ToV1(row) {
        const a = row?.attributes || {};
        const ts = a.timestamps || {};
        const fullUrl = a.full_challonge_url || '';
        let sub = a.subdomain || '';
        if (!sub && fullUrl) {
          try {
            const host = new URL(fullUrl).hostname.toLowerCase();
            if (host.endsWith('.challonge.com') && host !== 'www.challonge.com') sub = host.slice(0, -'.challonge.com'.length);
          } catch (_) {}
        }
        return { tournament: {
          id: Number(row?.id) || row?.id, name: a.name, url: a.url, subdomain: sub,
          full_challonge_url: fullUrl || (a.url ? `https://challonge.com/${a.url}` : ''),
          tournament_type: a.tournament_type, state: a.state === 'in_progress' ? 'underway' : a.state,
          participants_count: a.participants_count ?? a.participant_count,
          game_name: a.game_name, started_at: ts.started_at || a.started_at || a.starts_at,
          live_image_url: a.live_image_url, _community: true
        } };
      }
      const [groups, community] = await Promise.all([
        Promise.all([fetchGroup(''), ...extraSubdomains.map(s => fetchGroup(s))]),
        fetchCommunityV2()
      ]);
      const seen = new Set();
      // v1 rows first so they win the dedupe; v2.1 only fills in what v1 couldn't see.
      const all = [...groups.flat(), ...community.map(v2ToV1)].filter(t => {
        const id = Number(t?.tournament?.id) || t?.tournament?.id;
        if (!id || seen.has(id)) return false;
        seen.add(id); return true;
      });
      if (communityError) console.warn('[challonge] community tournaments (v2.1) skipped:', communityError);
      const tournaments = all.map((t) => {
        const d = t.tournament;
        const sub = (d.subdomain || '').toLowerCase();
        const rawUrl = d.url || '';
        const apiSlug = sub ? `${sub}-${rawUrl}` : rawUrl;
        return { id: d.id, slug: apiSlug, name: d.name, url: d.full_challonge_url, type: d.tournament_type, state: d.state, participantsCount: d.participants_count, gameName: d.game_name || '', startedAt: d.started_at, logo: d.live_image_url || '', subdomain: sub, community: !!d._community };
      });
      res.json({ tournaments, subdomainErrors: subdomainErrors.length ? subdomainErrors : undefined });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/challonge/tournament-detail', async (req, res) => {
    const key = (req.body?.apiKey || ctx.challongeApiKey || '').trim();
    const slug = (req.body?.slug || '').trim();
    if (!key) return res.status(400).json({ error: 'API key required' });
    if (!slug) return res.status(400).json({ error: 'Tournament slug required' });
    try {
      const client = createChallongeClient(key);
      const [tData, pData, mData] = await Promise.all([
        client.get(`/tournaments/${slug}.json`),
        client.get(`/tournaments/${slug}/participants.json`),
        client.get(`/tournaments/${slug}/matches.json`)
      ]);
      const t = tData.tournament;
      const partMap = challongePartMap(pData);
      const participants = Object.values(partMap).sort((a, b) => (a.seed || 99) - (b.seed || 99));
      const openMatches = mData.filter((m) => ['open', 'pending'].includes(m.match.state)).length;
      res.json({ tournament: { id: t.id, slug: t.url, name: t.name, url: t.full_challonge_url, type: t.tournament_type, state: t.state, participantsCount: t.participants_count, gameName: t.game_name || '' }, participants, openMatches, totalMatches: mData.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};
