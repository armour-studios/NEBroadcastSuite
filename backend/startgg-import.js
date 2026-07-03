/* ─── start.gg historical importer ────────────────────────────────────────────
 *
 * Pulls completed sets from a producer's own start.gg tournaments (admin view),
 * filtered by name + game, and writes them into the stats DB as match records
 * (one per set, with series score, winner, entrants, tournament name and the real
 * tournament date). Idempotent: skips sets already imported (by startgg_set_id),
 * so re-running tops up new results. Rate-limited to stay under start.gg's caps.
 *
 * start.gg has no per-player RL stats (goals/assists), so this populates team
 * records, head-to-head, tournament history and match counts — not player lines.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GAP = 650;   // ms between API calls (start.gg allows ~80 req / 60s)

const TOURNEYS_Q = `query($perPage:Int,$page:Int){ currentUser{ id
  tournaments(query:{perPage:$perPage,page:$page,filter:{tournamentView:"admin"}}){
    pageInfo{ totalPages }
    nodes{ id name slug startAt endAt events{ id name numEntrants videogame{ id name } } } } } }`;

const SETS_Q = `query($id:ID!,$page:Int,$perPage:Int){ event(id:$id){ id
  sets(page:$page, perPage:$perPage, filters:{state:[3]}){
    pageInfo{ totalPages }
    nodes{ id completedAt startedAt winnerId displayScore
      slots{ entrant{ id name } standing{ stats{ score{ value } } } }
      games{ id winnerId orderNum } } } } }`;

const num = (v) => (typeof v === 'number' && isFinite(v) && v >= 0) ? v : null;

// One set → a stats match (+ game rows when start.gg has per-game winners).
function importSet(stats, node, tournamentName, gameType) {
  const slots = node.slots || [];
  if (slots.length < 2) return false;
  const eA = slots[0] && slots[0].entrant, eB = slots[1] && slots[1].entrant;
  if (!eA || !eB || !eA.name || !eB.name) return false;   // bye / placeholder
  const scoreA = num(slots[0].standing && slots[0].standing.stats && slots[0].standing.stats.score && slots[0].standing.stats.score.value);
  const scoreB = num(slots[1].standing && slots[1].standing.stats && slots[1].standing.stats.score && slots[1].standing.stats.score.value);
  const winner = node.winnerId === eA.id ? 'a' : node.winnerId === eB.id ? 'b' : null;
  const win = Math.max(scoreA || 0, scoreB || 0);
  const bestOf = win > 0 ? (win * 2 - 1) : 5;
  const endMs = (node.completedAt || node.startedAt || 0) * 1000 || Date.now();
  const startMs = (node.startedAt || node.completedAt || 0) * 1000 || endMs;

  const matchId = stats.startMatch({
    gameType: gameType || 'rl', teamA: eA.name, teamB: eB.name, bestOf,
    startggSetId: String(node.id), tournament: tournamentName, startedAt: startMs
  });
  stats.endMatch(matchId, { scoreA, scoreB, winner, endedAt: endMs });

  // Per-game rows only when the TO actually reported game winners.
  const games = (node.games || []).filter((g) => g && g.winnerId);
  games.sort((a, b) => (a.orderNum || 0) - (b.orderNum || 0));
  games.forEach((g, i) => {
    const gid = stats.startGame({ matchId, gameNumber: g.orderNum || (i + 1), gameType: gameType || 'rl', startedAt: startMs });
    stats.endGame(gid, { winner: g.winnerId === eA.id ? 'a' : g.winnerId === eB.id ? 'b' : null, endedAt: endMs });
  });
  return true;
}

/**
 * @param client   createStartGgClient(token)
 * @param stats    backend/db/stats module
 * @param opts     { nameQuery='rocket rush', gameQuery='rocket league', onProgress }
 */
async function importFromStartgg({ client, stats, nameQuery = 'rocket rush', gameQuery = 'rocket league', onProgress } = {}) {
  const nameRe = new RegExp(nameQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'), 'i');
  const gameRe = new RegExp(gameQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'), 'i');
  const report = (msg, extra) => { try { onProgress && onProgress({ message: msg, ...(extra || {}) }); } catch (e) {} };

  const seen = new Set(stats.getStartggSetIds());
  const summary = { tournaments: 0, events: 0, sets: 0, imported: 0, skipped: 0, errors: 0, done: false };

  // 1) Gather admin tournaments (paginated).
  report('Finding your tournaments…');
  const tournaments = [];
  let page = 1, totalPages = 1;
  do {
    const d = await client.request(TOURNEYS_Q, { perPage: 25, page });
    const t = d.currentUser && d.currentUser.tournaments;
    if (!t) break;
    totalPages = (t.pageInfo && t.pageInfo.totalPages) || 1;
    tournaments.push(...(t.nodes || []));
    page++; await sleep(GAP);
  } while (page <= totalPages && page <= 20);

  const matched = tournaments.filter((t) => nameRe.test(t.name || ''));
  summary.tournaments = matched.length;
  report(`Matched ${matched.length} "${nameQuery}" tournaments.`, { summary });

  // 2) Each matching tournament's events for the target game.
  for (const t of matched) {
    const events = (t.events || []).filter((e) => gameRe.test((e.videogame && e.videogame.name) || ''));
    for (const e of events) {
      summary.events++;
      report(`Importing ${t.name} — ${e.name}…`, { summary });
      let sp = 1, stp = 1;
      do {
        let d;
        try { d = await client.request(SETS_Q, { id: e.id, page: sp, perPage: 40 }); }
        catch (err) { summary.errors++; report(`Error on ${e.name}: ${err.message}`, { summary }); break; }
        const sets = (d.event && d.event.sets) || {};
        stp = (sets.pageInfo && sets.pageInfo.totalPages) || 1;
        for (const node of (sets.nodes || [])) {
          summary.sets++;
          if (seen.has(String(node.id))) { summary.skipped++; continue; }
          try {
            if (importSet(stats, node, t.name)) { summary.imported++; seen.add(String(node.id)); }
            else summary.skipped++;
          } catch (err) { summary.errors++; }
        }
        sp++; await sleep(GAP);
      } while (sp <= stp && sp <= 60);
      report(`${t.name} — ${e.name}: ${summary.imported} imported so far.`, { summary });
    }
  }

  summary.done = true;
  report(`Done. Imported ${summary.imported} new matches (${summary.skipped} already present).`, { summary });
  return summary;
}

// Import ONE specific event (by start.gg event id) — powers the search-and-add flow;
// works for any public event, not just the producer's admin tournaments.
async function importEventById({ client, stats, eventId, tournamentName = '', gameType = 'rl', onProgress } = {}) {
  const report = (msg, extra) => { try { onProgress && onProgress({ message: msg, ...(extra || {}) }); } catch (e) {} };
  const seen = new Set(stats.getStartggSetIds());
  const summary = { tournaments: 1, events: 1, sets: 0, imported: 0, skipped: 0, errors: 0, done: false };
  report('Importing ' + (tournamentName || 'event') + '…', { summary });
  let sp = 1, stp = 1;
  do {
    let d;
    try { d = await client.request(SETS_Q, { id: eventId, page: sp, perPage: 40 }); }
    catch (err) { summary.errors++; report('Error: ' + err.message, { summary }); break; }
    const sets = (d.event && d.event.sets) || {};
    stp = (sets.pageInfo && sets.pageInfo.totalPages) || 1;
    for (const node of (sets.nodes || [])) {
      summary.sets++;
      if (seen.has(String(node.id))) { summary.skipped++; continue; }
      try { if (importSet(stats, node, tournamentName, gameType)) { summary.imported++; seen.add(String(node.id)); } else summary.skipped++; }
      catch (err) { summary.errors++; }
    }
    sp++; await sleep(GAP);
  } while (sp <= stp && sp <= 60);
  summary.done = true;
  report('Done. Imported ' + summary.imported + ' new matches (' + summary.skipped + ' already present).', { summary });
  return summary;
}

module.exports = { importFromStartgg, importEventById };
