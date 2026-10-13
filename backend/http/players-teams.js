'use strict';
// Player database and team vault — HTTP routes (moved out of server.js's startHttpServer; called at the same point, so
// route order is unchanged). Values server.js reassigns, or declares further down, are
// read and written through ctx (savedTeams).
let
  app, applyVaultToLibrary, broadcastFullState, enrichVaultFromStartgg,
  importStartggTeamBySlug, playerDb, propagateVaultCrest, refreshVaultTeamFromStartgg,
  saveAppState, saveTeams, state, teamDb, upsertPlayerProfile, vaultEnrichTargets, vaultTouch;
let ctx;

module.exports = function registerPlayerTeamRoutes(c) {
  ctx = c;
  ({
    app, applyVaultToLibrary, broadcastFullState, enrichVaultFromStartgg,
    importStartggTeamBySlug, playerDb, propagateVaultCrest, refreshVaultTeamFromStartgg,
    saveAppState, saveTeams, state, teamDb, upsertPlayerProfile, vaultEnrichTargets,
    vaultTouch
  } = c);

  // ── Player database ───────────────────────────────────────────────────────
  // Persistent cross-event registry keyed by gamertag. Never cleared on state reset.

  app.get('/api/playerdb', (req, res) => {
    const { q, rank, region, limit } = req.query;
    res.json({ ok: true, players: playerDb.search({ q, rank, region, limit: limit ? Number(limit) : 200 }), total: playerDb.count() });
  });

  app.get('/api/playerdb/:gamertag', (req, res) => {
    const rec = playerDb.get(req.params.gamertag);
    if (!rec) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, player: rec });
  });

  app.post('/api/playerdb', (req, res) => {
    const records = Array.isArray(req.body) ? req.body : [req.body];
    const updated = [];
    for (const r of records) {
      if (!r || !r.gamertag) continue;
      const rec = playerDb.upsert(r.gamertag, r);
      if (rec) {
        updated.push(rec);
        upsertPlayerProfile(r.gamertag, { startggSlug: r.startggSlug, startggPlayerId: r.startggId, sixmans: r.sixmans });
      }
    }
    if (updated.length) { saveAppState(); broadcastFullState(); }
    res.json({ ok: true, updated: updated.length });
  });

  app.delete('/api/playerdb/:gamertag', (req, res) => {
    const removed = playerDb.remove(req.params.gamertag);
    res.json({ ok: true, removed });
  });
  // Clear the ENTIRE player database (also wipes the in-state profile map).
  app.delete('/api/playerdb', (req, res) => {
    const n = playerDb.clearAll();
    state.playerProfiles = {}; state.playerProfilesVer = (state.playerProfilesVer || 0) + 1;
    try { saveAppState(); } catch (e) {}
    res.json({ ok: true, removed: n });
  });

  // ── Team vault ────────────────────────────────────────────────────────────
  // Permanent cross-event team registry (backend/team-db.js). Kept OUT of the broadcast state on
  // purpose — records carry base64 logos and full roster history, and everything in state ships to
  // every overlay on every change. The control panel polls these routes and re-fetches when
  // state.teamVault.ver bumps.

  app.get('/api/teamdb', (req, res) => {
    const { q, limit, linked } = req.query;
    const opts = { q, limit: limit ? Number(limit) : 500 };
    if (linked === 'true')  opts.linked = true;
    if (linked === 'false') opts.linked = false;
    res.json({
      ok: true, teams: teamDb.search(opts), stats: teamDb.stats(), settings: state.teamVault,
      // How many banked teams the automatic sweep still wants to read from start.gg.
      pending: vaultEnrichTargets(false).length,
    });
  });

  app.get('/api/teamdb/:id', (req, res) => {
    const rec = teamDb.get(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, team: rec });
  });

  // Who would this name/roster resolve to? Used by the UI to warn before creating a duplicate.
  app.post('/api/teamdb/resolve', (req, res) => {
    const r = teamDb.resolve(req.body || {});
    res.json({ ok: true, team: r.rec || null, via: r.via, score: r.score });
  });

  // Create or field-update a vault record. Anything set here is PINNED against future imports.
  app.post('/api/teamdb', (req, res) => {
    const b = req.body || {};
    try {
      let rec = b.id ? teamDb.update(b.id, b) : teamDb.upsertFromLibrary(b, { source: 'manual' });
      if (!rec) return res.status(400).json({ error: 'A team name is required' });
      if (!b.id) rec = teamDb.update(rec.id, b) || rec;
      vaultTouch();
      if (b.applyToLibrary) { applyVaultToLibrary(rec); saveTeams(); }
      // A crest edited here reaches every copy right away - library, event teams, logo map and the
      // side on air. Left in the vault alone, the library's stale copy was written back over it.
      if (b.logo !== undefined) {
        if (propagateVaultCrest(rec)) saveTeams();
        saveAppState();
      }
      broadcastFullState();
      res.json({ ok: true, team: rec });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Pull a team from its start.gg team page — the "save a team by slug" entry point.
  app.post('/api/teamdb/pull-startgg', async (req, res) => {
    try {
      const r = await importStartggTeamBySlug((req.body && req.body.slug) || '', { alsoLibrary: (req.body && req.body.alsoLibrary) !== false });
      res.json({ ok: true, result: r });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Kick the background start.gg sweep by hand. It normally runs itself after every import — this
  // is the "refresh everything now" button, and `force` ignores the weekly re-read window.
  app.post('/api/teamdb/enrich', async (req, res) => {
    try {
      const r = await enrichVaultFromStartgg({ force: !!(req.body && req.body.force) });
      res.json({ ok: true, result: r, pending: vaultEnrichTargets(false).length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Re-read one team's start.gg page now (the vault card's "Check start.gg" button).
  app.post('/api/teamdb/:id/refresh-startgg', async (req, res) => {
    try {
      res.json({ ok: true, ...(await refreshVaultTeamFromStartgg(req.params.id)) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Push a vault record into the working team library (what the Match panel and overlays read).
  app.post('/api/teamdb/:id/apply', (req, res) => {
    const rec = teamDb.get(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Not found' });
    applyVaultToLibrary(rec);
    saveTeams();
    broadcastFullState();
    res.json({ ok: true, team: teamDb.toLibraryTeam(rec) });
  });

  // Flip one roster slot active/inactive (optionally pinning it so imports stop moving it).
  app.post('/api/teamdb/:id/roster', (req, res) => {
    const b = req.body || {};
    const rec = b.remove
      ? teamDb.removePlayer(req.params.id, b.playerId)
      : teamDb.setRosterStatus(req.params.id, b.playerId, b.rosterStatus, b.pinned);
    if (!rec) return res.status(404).json({ error: 'Team or player not found' });
    vaultTouch();
    broadcastFullState();
    res.json({ ok: true, team: rec });
  });

  // Fold a duplicate record into the one the producer wants to keep.
  app.post('/api/teamdb/merge', (req, res) => {
    const b = req.body || {};
    const rec = teamDb.merge(b.into, b.from);
    if (!rec) return res.status(400).json({ error: 'Both teams must exist and differ' });
    // Library rows that pointed at the losing record now point at the survivor.
    ctx.savedTeams.forEach((t) => { if (t && t.vaultId === String(b.from)) t.vaultId = rec.id; });
    saveTeams();
    vaultTouch();
    broadcastFullState();
    res.json({ ok: true, team: rec });
  });
};
