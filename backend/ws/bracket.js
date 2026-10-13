'use strict';
// Brackets — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly.
let
  bracketNameScore, bracketNormName, broadcastFullState, fetchBracket, obsSwitch, saveAppState,
  sendWs, state, syncActiveBracketPhase, syncStartGgSet;
let ctx;

const handlers = {
  // Switch which phase is live on the overlay (works for manual OR start.gg phases).
  bracket_select_phase(msg, ws) {
    const p = msg.data || {};
    if (p.phaseId != null) state.bracket.activePhaseId = p.phaseId;
    if (p.poolId != null) state.bracket.activePoolId = p.poolId;   // reset to a specific pool when switching phase, if given
    syncActiveBracketPhase();
    if (typeof p.visible === 'boolean') state.bracket.visible = p.visible;
    saveAppState();
    broadcastFullState();
    if (typeof p.visible === 'boolean') obsSwitch(p.visible ? 'bracket' : 'inGame');
  },

  // Switch which pool (Start.gg phaseGroup, or a manually-built pool) is live
  // on the overlay, when the active phase has more than one running at once.
  bracket_select_pool(msg, ws) {
    const p = msg.data || {};
    const ph = (state.bracket.phases || []).find((x) => x.id === state.bracket.activePhaseId);
    const pools = (ph && ph.pools) || [];
    if (p.poolId != null && pools.some((pl) => pl.id === p.poolId)) state.bracket.activePoolId = p.poolId;
    syncActiveBracketPhase();
    saveAppState();
    broadcastFullState();
  },

  // Find a team anywhere in the loaded tournament: auto-select the phase + pool they play
  // in and highlight them on the overlay (startgg.focusTeam). Empty name clears the focus.
  // Built for major-scale events where hunting a team through 30 pool chips is hopeless.
  bracket_focus_team(msg, ws) {
    const q = (msg.data?.name || '').toString().trim().toLowerCase();
    if (!q) {
      state.startgg.focusTeam = '';
      broadcastFullState();
      sendWs(ws, { type: 'bracket-result', data: { ok: true, message: 'Team focus cleared.' } });
      return;
    }
    // Rank every candidate instead of taking the first substring hit: an exact name beats a
    // prefix, a prefix beats a whole-word match, and that beats a loose substring; shortest
    // name breaks ties. Searching "Tarnished" used to land on whichever Tarnished Academy
    // squad happened to appear first in the data — and highlight all of them on the overlay.
    const qn = bracketNormName(q);
    let found = null;   // { phaseId, poolId, name, score }
    const consider = (phaseId, poolId, name) => {
      const sc = bracketNameScore(name, qn);
      if (sc < 0) return;
      if (!found || sc > found.score || (sc === found.score && name.length < found.name.length)) {
        found = { phaseId, poolId, name, score: sc };
      }
    };
    for (const ph of (state.bracket.phases || [])) {
      for (const pl of (ph.pools || [])) {
        [...(pl.roster || []), ...((pl.standings || []).map((r) => r.name))].forEach((n) => consider(ph.id, pl.id, n));
        for (const round of (pl.schedule || [])) {
          for (const s of (round.sets || [])) {
            consider(ph.id, pl.id, s.a && s.a.name);
            consider(ph.id, pl.id, s.b && s.b.name);
          }
        }
      }
      // Elimination phases keep sets at phase level (winners/losers/finals).
      for (const round of [...(ph.winners || []), ...(ph.losers || []), ...(ph.finals || []), ...(ph.schedule || [])]) {
        for (const s of (round.sets || [])) {
          consider(ph.id, '', s.a && s.a.name);
          consider(ph.id, '', s.b && s.b.name);
        }
      }
      if (found && found.score === 100) break;   // exact name — nothing can beat it
    }
    if (found) {
      state.bracket.activePhaseId = found.phaseId;
      if (found.poolId) state.bracket.activePoolId = found.poolId;
      state.startgg.focusTeam = found.name;
      syncActiveBracketPhase();
      saveAppState();
      broadcastFullState();
      const ph = (state.bracket.phases || []).find((x) => x.id === found.phaseId);
      const pl = ph && (ph.pools || []).find((x) => x.id === found.poolId);
      sendWs(ws, { type: 'bracket-result', data: { ok: true,
        message: `Found ${found.name} — ${ph ? ph.name : 'phase'}${pl ? ' · ' + pl.name : ''}. Highlighted on the bracket.` } });
    } else {
      sendWs(ws, { type: 'bracket-result', data: { ok: false, message: `No team matching "${msg.data.name}" in this bracket.` } });
    }
  },

  // Legacy single-bracket path — wrap the payload into a one-phase model.
  set_manual_bracket(msg, ws) {
    const p = msg.data || {};
    state.bracket.phases = [{
      id: 'phase1', name: 'Bracket', type: p.type || 'SINGLE_ELIMINATION',
      winners: p.winners || [], losers: p.losers || [], finals: p.finals || [],
      standings: p.standings || [], schedule: p.schedule || [], roster: p.roster || [],
      pools: Array.isArray(p.pools) ? p.pools : [], matrix: p.matrix || null
    }];
    state.bracket.activePhaseId = 'phase1';
    if (typeof p.title === 'string') state.bracket.title = p.title;
    if (Array.isArray(p.teams)) state.bracket.teams = p.teams;
    state.bracket.matches = [];
    state.bracket.eventSlug = '';
    // Manual ownership — without this, a later eventSlug set would let the start.gg
    // poll silently overwrite the hand-built bracket (set_bracket_phases gets this right).
    state.bracket.mode = 'manual';
    state.bracket.source = '';
    state.bracket.lastFetchAt = Date.now();
    syncActiveBracketPhase();
    if (typeof p.visible === 'boolean') state.bracket.visible = p.visible;
    saveAppState();
    broadcastFullState();
    if (typeof p.visible === 'boolean') obsSwitch(p.visible ? 'bracket' : 'inGame');
  },

  fetch_bracket(msg, ws) {
    (async () => {
      try {
        const slug = (msg.data?.eventSlug || state.bracket.eventSlug || state.startgg.eventSlug || '').trim();
        // Immediate ack: a big import runs for a while — without this the panel's
        // request timed out with "No response from the server" while data was
        // actually loading fine in the background.
        sendWs(ws, {
          type: 'bracket-result',
          data: { ok: true, message: 'Importing bracket — large events load phase by phase…' }
        });
        const result = await fetchBracket(slug);
        const label = result.type ? result.type.replace(/_/g, ' ').toLowerCase() : 'bracket';
        // A capped phase is a PARTIAL bracket — say so, rather than reporting a clean load.
        const capped = (result.truncated || []).length
          ? ` — WARNING: ${result.truncated.join(', ')} exceeded the per-phase set limit, this bracket is incomplete`
          : '';
        sendWs(ws, {
          type: 'bracket-result',
          data: { ok: !capped, message: result.inProgress
            ? 'Import already running — phases appear as they load'
            : `Loaded ${result.sets} set(s) — ${label}${capped}` }
        });
      } catch (e) {
        state.bracket.lastError = e.message;
        broadcastFullState();
        sendWs(ws, { type: 'bracket-result', data: { ok: false, message: e.message } });
      }
    })();
  },

  select_match(msg, ws) {
    (async () => {
      try {
        const setId = (msg.data?.setId || '').trim();
        if (!setId) throw new Error('No match selected');
        const result = await syncStartGgSet(setId);
        if (result && result.superseded) { sendWs(ws, { type: 'event-result', data: { ok: false, message: 'A newer match was picked while this one loaded; it stands.' } }); return; }

        // New matchup → start a fresh series unless told to keep it
        if (msg.data?.keepSeries !== true) {
          state.series = { blue: 0, orange: 0 };
          state.game.number = 1;
        }
        saveAppState();
        broadcastFullState();

        sendWs(ws, {
          type: 'event-result',
          data: { ok: true, message: `Now playing: ${(result.entrants || []).join('  vs  ') || setId}` }
        });
      } catch (e) {
        sendWs(ws, { type: 'event-result', data: { ok: false, message: e.message } });
      }
    })();
  },
};

module.exports = function createBracketHandlers(c) {
  ctx = c;
  ({
    bracketNameScore, bracketNormName, broadcastFullState, fetchBracket, obsSwitch,
    saveAppState, sendWs, state, syncActiveBracketPhase, syncStartGgSet
  } = c);
  return handlers;
};
