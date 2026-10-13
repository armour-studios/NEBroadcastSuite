// backend/platforms/challonge-sync.js — moved out of server.js (refactor step 3) unchanged; server.js creates it once
// with createChallongeSync(ctx). ctx carries stable references plus live getters (ctx.<name>) for values
// server.js replaces at runtime, and set_<name>(v) for the ones this code writes.
module.exports = function createChallongeSync(ctx) {
  const { createChallongeClient, state, saveAppState, touchMyEvents, broadcastFullState } = ctx;

// ─── Challonge real-time match sync ──────────────────────────────────────────

async function buildChallongeParticipantMap(slug) {
  const client = createChallongeClient(ctx.challongeApiKey);
  const pData = await client.get(`/tournaments/${slug}/participants.json`);
  const map = {};
  (pData || []).forEach(p => {
    const d = p.participant || p;
    [d.name, d.display_name].filter(Boolean).forEach(n => {
      map[n.toLowerCase()] = { id: d.id, name: n };
    });
  });
  return map;
}

// Normalize a team/entrant name for matching across start.gg ↔ Challonge (case, spacing and
// punctuation differ constantly). Deliberately keeps alphanumerics only — no substring/"contains"
// matching, so "Tarn C" never collapses into "Tarn B".
function _normName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Resolve a start.gg entrant name to a Challonge participant {id,name}. Tries exact (lowercased)
// then a normalized-equality pass. Returns null if nothing matches — caller should surface that
// rather than silently dropping the result (a dropped prerequisite stalls the whole cascade).
function resolveChallongeParticipant(pm, name) {
  if (!name) return null;
  const lc = String(name).toLowerCase();
  if (pm[lc]) return pm[lc];
  const n = _normName(name);
  if (!n) return null;
  for (const k in pm) { if (_normName(k) === n) return pm[k]; }
  return null;
}

async function syncLinkedChallongeTournament(ev) {
  const link = ev.challongeSync;
  if (!link || !link.enabled || !link.slug || !ctx.challongeApiKey) return;
  try {
    const client = createChallongeClient(ctx.challongeApiKey);
    if (!link.participantMap || Object.keys(link.participantMap).length === 0) {
      link.participantMap = await buildChallongeParticipantMap(link.slug);
    }
    const pm = link.participantMap;
    if (!link.pushedMatches) link.pushedMatches = {};

    // Gather completed bracket matches from all phases, in bracket order
    // (winners early→late, then losers early→late, then finals).
    // Bracket order matters so we push prerequisites before downstream matches.
    const completedMatches = [];
    (state.bracket.phases || []).forEach(phase => {
      ['winners', 'losers', 'finals'].forEach(side => {
        (phase[side] || []).forEach(round => {
          // Each round is { name, sets: [{a,b}] } — iterate round.sets, not round itself
          (round.sets || []).forEach(match => {
            const { a, b } = match || {};
            if (!a || !b || (!a.winner && !b.winner)) return;
            if (!a.name || !b.name || a.name === 'TBD' || b.name === 'TBD') return;
            completedMatches.push({ a, b });
          });
        });
      });
    });
    if (!completedMatches.length) return;

    // Resolve entrant names to Challonge participants once (tolerant of case/spacing/punctuation).
    completedMatches.forEach((cm) => {
      cm.pA = resolveChallongeParticipant(pm, cm.a.name);
      cm.pB = resolveChallongeParticipant(pm, cm.b.name);
      cm.consumed = false;
    });

    // Multi-pass: re-fetch Challonge's open matches after each push so that matches which become
    // open as a result (e.g. Grand Finals after Losers Finals) are picked up in the same cycle.
    // Dedup is keyed by the CHALLONGE match id (stable, and distinguishes a Grand-Finals rematch
    // of two teams from their earlier meeting — the old name-pair key blocked the rematch).
    let totalPushed = 0;
    for (let pass = 0; pass < 20; pass++) {
      const mData = await client.get(`/tournaments/${link.slug}/matches.json`);
      const openMatches = (mData || []).filter(m => (m.match || m).state === 'open');
      if (!openMatches.length) break;

      let pushedThisPass = 0;
      for (const m of openMatches) {
        const d = m.match || m;
        if (!d.player1_id || !d.player2_id) continue;
        if (link.pushedMatches[String(d.id)]) continue;
        const cm = completedMatches.find(c => !c.consumed && c.pA && c.pB &&
          ((d.player1_id === c.pA.id && d.player2_id === c.pB.id) ||
           (d.player1_id === c.pB.id && d.player2_id === c.pA.id)));
        if (!cm) continue;
        const winnerId = cm.a.winner ? cm.pA.id : cm.pB.id;
        const isAp1 = d.player1_id === cm.pA.id;
        const sA = cm.a.score != null ? cm.a.score : 0;
        const sB = cm.b.score != null ? cm.b.score : 0;
        const scoresCSV = isAp1 ? `${sA}-${sB}` : `${sB}-${sA}`;
        try {
          await client.put(`/tournaments/${link.slug}/matches/${d.id}.json`, {
            match: { winner_id: winnerId, scores_csv: scoresCSV }
          });
          link.pushedMatches[String(d.id)] = true;
          cm.consumed = true;
          pushedThisPass++;
          totalPushed++;
        } catch (err) {
          cm.consumed = true;   // skip a rejected set instead of spinning the cascade
          console.error(`[challonge-sync] Match ${cm.a.name} vs ${cm.b.name}:`, err.message);
        }
      }
      if (pushedThisPass === 0) break; // no progress this pass, stop
    }
    if (totalPushed > 0) {
      link.lastSyncAt = new Date().toISOString();
      link.lastError = null;
      touchMyEvents();
      saveAppState();
      broadcastFullState();
      console.log(`[challonge-sync] Pushed ${totalPushed} result(s) to ${link.slug}`);
    }
  } catch (e) {
    if (ev.challongeSync) { ev.challongeSync.lastError = e.message; touchMyEvents(); broadcastFullState(); }
    console.error('[challonge-sync]', e.message);
  }
}

async function syncAllLinkedChallongeTournaments() {
  if (!ctx.challongeApiKey) return;
  for (const ev of (Array.isArray(state.myEvents) ? state.myEvents : [])) {
    if (ev.challongeSync && ev.challongeSync.enabled && ev.challongeSync.slug) {
      await syncLinkedChallongeTournament(ev).catch(() => {});
    }
  }
}


  return { syncAllLinkedChallongeTournaments, buildChallongeParticipantMap, syncLinkedChallongeTournament, resolveChallongeParticipant };
};
