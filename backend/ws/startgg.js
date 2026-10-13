'use strict';
// start.gg (events, queue, sets, teams) — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly; values server.js reassigns are
// read and written through ctx (leaguesVer, startggApiToken).
let
  _logSerializeFailure, activateStartggEvent, activePlatformSets, applyStartggAutomation,
  broadcastFullState, buildEventUpcomingExtras, createStartGgClient, ensureOnAirLiveInFeed,
  fetchAllEntrants, fetchStreamQueue, fetchTeamQueue, fetchTournamentEvents, formatTickerFeed,
  importStartggTeams, loadStartggEventTeams, mapEntrantsToTeams, parseEventSlug,
  parseStartggInput, platformRoundLabel, refreshAllMyEvents, resetAutoFollowHold,
  resolveStartggUrl, saveAppState, saveEventTeamToLibrary, saveTeams, sendWs,
  setActivePlatform, setStartggAutoFollow, setStartggQueuePolling, state,
  syncBracketToActiveEvent, syncStartGgSet, testStartGgConnection, touchAutoFollowHold;
let ctx;

const handlers = {
  use_startgg_round(msg, ws) {
    const { platform, sets } = activePlatformSets();
    const sg = state.startgg || {};
    const id = platform === 'startgg' ? (sg.setId || sg.lastPushedSetId || '') : '';
    const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
    const a = norm(state.teams.blue && state.teams.blue.name);
    const b = norm(state.teams.orange && state.teams.orange.name);
    let hit = null;
    if (id) hit = sets.find(x => String(x.setId) === String(id));
    if (!hit && a && b && a !== 'tbd' && b !== 'tbd') {
      hit = sets.find(x => {
        const nx = norm(x.teamA), ny = norm(x.teamB);
        return (nx === a && ny === b) || (nx === b && ny === a);
      });
    }
    if (!hit) hit = sets.find(x => x.live || x.status === 'in-progress');
    state.roundLabel = hit ? platformRoundLabel(platform, hit.round) : '';
    state.startgg.roundLabelAuto = true;    // explicitly pulled from the platform — keep it tracking
    state.startgg.roundLabelSetId = hit ? (hit.setId || hit.matchId || null) : null;
    saveAppState();
    broadcastFullState();
  },

  create_league_from_startgg(msg, ws) {
    (async () => {
      const input = (msg.data && (msg.data.input || msg.data.eventSlug || msg.data.url) || '').toString().trim();
      try {
        if (!ctx.startggApiToken) throw new Error('Add your start.gg API token under Apps > start.gg first.');
        // Resolve to a concrete event slug (auto-pick a single-event tournament).
        let evSlug = parseEventSlug(input);
        if (!/\/event\//i.test(evSlug)) {
          const { tournamentSlug } = parseStartggInput(input);
          const events = tournamentSlug ? await fetchTournamentEvents(ctx.startggApiToken, tournamentSlug) : [];
          if (events.length === 1) evSlug = events[0].slug;
          else if (events.length > 1) throw new Error(`That tournament has ${events.length} events — paste the specific event URL.`);
          else throw new Error('Could not find a start.gg event from that link.');
        }
        const client = createStartGgClient(ctx.startggApiToken);
        const entrants = await fetchAllEntrants(client, evSlug);
        const teams = mapEntrantsToTeams(entrants).filter(Boolean).map((t) => ({
          id: 'lt' + Math.random().toString(36).slice(2, 9),
          name: t.name, logo: t.logo || null,
          players: (t.players || []).map((p) => ({ id: 'lp' + Math.random().toString(36).slice(2, 9), name: p.name, role: '', salary: 0, stats: {} }))
        }));
        if (!teams.length) throw new Error('No entrants found on that event yet.');
        const league = {
          id: 'lg' + Math.random().toString(36).slice(2, 9),
          name: (msg.data && msg.data.name || '').toString().slice(0, 80) || 'Start.gg League',
          game: state.activeGame, type: 'team', season: '', salaryCap: 0,
          teams, freeAgents: [],
          standings: teams.map((t) => ({ teamId: t.id, w: 0, l: 0, t: 0, gf: 0, ga: 0, pts: 0, subW: 0, subL: 0 })),
          schedule: [], source: { startgg: evSlug }
        };
        if (!Array.isArray(state.leagues)) state.leagues = [];
        state.leagues.unshift(league);
        ctx.leaguesVer++;
        saveAppState();
        broadcastFullState();
        sendWs(ws, { type: 'event-result', data: { ok: true, leagueId: league.id, message: `Created league "${league.name}" with ${teams.length} team(s) from start.gg.` } });
      } catch (e) {
        sendWs(ws, { type: 'event-result', data: { ok: false, message: e.message } });
      }
    })();
  },

  // ── start.gg Event Teams (transient) management ─────────────────────────
  select_startgg_event(msg, ws) {
    const d = msg.data || {};
    state.startgg.selectedEvent = {
      tournamentSlug: (d.tournamentSlug || '').trim(),
      eventSlug: (d.eventSlug || '').trim(),
      name: (d.name || '').trim(),
      tournamentName: (d.tournamentName || '').trim()
    };
    // Also sync top level slugs for queue etc.
    if (d.tournamentSlug) state.startgg.tournamentSlug = d.tournamentSlug.trim();
    if (d.eventSlug) state.startgg.eventSlug = d.eventSlug.trim();
    // The Bracket scene's "Tournament Organizer" source follows this immediately — without this
    // it wouldn't notice the switch until the next ~20s poll tick.
    syncBracketToActiveEvent().then(() => { saveAppState(); broadcastFullState(); }).catch(() => {});
    saveAppState();
    broadcastFullState();
  },

  load_startgg_event_teams(msg, ws) {
    const d = msg.data || {};
    (async () => {
      try {
        await loadStartggEventTeams(d.tournamentSlug, d.eventSlug);
        // func already broadcasts + saves
      } catch (e) {
        state.startgg.lastError = 'Load teams: ' + e.message;
        broadcastFullState();
      }
    })();
  },

  clear_startgg_teams(msg, ws) {
    state.startgg.eventTeams = [];
    saveAppState();
    broadcastFullState();
  },

  delete_startgg_team(msg, ws) {
    const name = (msg.data && msg.data.name || '').trim();
    if (name) {
      state.startgg.eventTeams = (state.startgg.eventTeams || []).filter(t => t.name !== name);
      saveAppState();
      broadcastFullState();
    }
  },

  mass_delete_startgg_teams(msg, ws) {
    const names = (msg.data && msg.data.names) || null;
    if (Array.isArray(names) && names.length) {
      const set = new Set(names);
      state.startgg.eventTeams = (state.startgg.eventTeams || []).filter(t => !set.has(t.name));
    } else {
      state.startgg.eventTeams = [];
    }
    saveAppState();
    broadcastFullState();
  },

  save_startgg_team(msg, ws) {
    const name = (msg.data && msg.data.name || '').trim();
    const team = (state.startgg.eventTeams || []).find(t => t.name === name);
    if (team) {
      saveEventTeamToLibrary(team);
      saveTeams();
      broadcastFullState();
    }
  },

  save_startgg_teams_bulk(msg, ws) {
    const names = (msg.data && msg.data.names) || [];
    const toSave = Array.isArray(names) && names.length
      ? (state.startgg.eventTeams || []).filter(t => names.includes(t.name))
      : (state.startgg.eventTeams || []);
    toSave.forEach(saveEventTeamToLibrary);
    if (toSave.length) {
      saveTeams();
      broadcastFullState();
    }
  },

  set_startgg_settings(msg, ws) {
    const payload = msg.data || {};
    state.startgg.enabled = !!payload.enabled;
    state.startgg.tournamentSlug = (payload.tournamentSlug || '').trim();
    state.startgg.eventSlug = (payload.eventSlug || '').trim();
    state.startgg.setId = (payload.setId || '').trim();
    if (typeof payload.queueEnabled === 'boolean') state.startgg.queueEnabled = payload.queueEnabled;
    if (typeof payload.apiToken === 'string' && payload.apiToken.trim()) {
      ctx.startggApiToken = payload.apiToken.trim();
    }
    // Auto-enable queue polling when API is fully configured
    if (state.startgg.enabled && ctx.startggApiToken && state.startgg.tournamentSlug && payload.queueEnabled !== false) {
      state.startgg.queueEnabled = true;
    }
    saveAppState();
    broadcastFullState();
    applyStartggAutomation();
    if (ctx.startggApiToken) refreshAllMyEvents({ force: true }).catch(() => {});   // token just (re)set → sync My Events
  },

  startgg_set_queue(msg, ws) {
    setStartggQueuePolling(!!msg.data?.enabled);
  },

  // Fully disconnect start.gg — clear the saved API token and turn the integration off. The normal
  // settings save treats an empty token as "keep current" (so re-saving other fields never wipes it),
  // so this explicit action is the only way to actually remove the token.
  startgg_disconnect(msg, ws) {
    ctx.startggApiToken = '';
    state.startgg.enabled = false;
    state.startgg.connected = false;
    state.startgg.queueEnabled = false;
    state.startgg.lastError = '';
    if (typeof setStartggQueuePolling === 'function') setStartggQueuePolling(false);
    saveAppState();
    broadcastFullState();
    applyStartggAutomation();
  },

  startgg_test_connection(msg, ws) {
    (async () => {
      try {
        if (!ctx.startggApiToken) {
          throw new Error('No API token saved. Enter and save your token first.');
        }

        console.log('[Start.gg Test] Starting test with token length:', ctx.startggApiToken.length);
        const user = await testStartGgConnection();
        state.startgg.connected = true;
        state.startgg.lastError = null;
        saveAppState();
        broadcastFullState();

        console.log('[Start.gg Test] SUCCESS:', user);
        ws.send(JSON.stringify({
          type: 'startgg-result',
          data: {
            ok: true,
            message: `✓ Connected as ${user.slug || user.id}`
          }
        }));
      } catch (e) {
        console.error('[Start.gg Test] FAILED:', e.message);
        state.startgg.connected = false;
        state.startgg.lastError = e.message;
        saveAppState();
        broadcastFullState();
        ws.send(JSON.stringify({
          type: 'startgg-result',
          data: {
            ok: false,
            message: e.message
          }
        }));
      }
    })();
  },

  startgg_sync_set(msg, ws) {
    (async () => {
      try {
        const setId = (msg.data?.setId || state.startgg.setId || '').trim();
        const result = await syncStartGgSet(setId);
        if (result && result.superseded) { ws.send(JSON.stringify({ type: 'startgg-result', data: { ok: false, message: 'A newer set was pushed while this one loaded; it stands.' } })); return; }
        ws.send(JSON.stringify({
          type: 'startgg-result',
          data: {
            ok: true,
            message: `Synced set ${result.setId}`,
            details: result
          }
        }));
      } catch (e) {
        state.startgg.lastSyncStatus = 'error';
        state.startgg.lastError = e.message;
        saveAppState();
        broadcastFullState();
        ws.send(JSON.stringify({
          type: 'startgg-result',
          data: {
            ok: false,
            message: e.message
          }
        }));
      }
    })();
  },

  // Which source drives the upcoming/schedule board: 'event' (stream queue) or 'team' (team search).
  // Sent when the producer switches the Stream Queue tab.
  startgg_set_upcoming_mode(msg, ws) {
    const mode = ['team', 'manual'].includes(msg.data && msg.data.mode) ? msg.data.mode : 'event';
    state.upcoming.source = mode;
    // event → overlay shows the live stream queue (+ a couple non-stream extras, filled next poll).
    // team → clear until a team search populates it (so stale event extras don't show as "team").
    // manual → detached from start.gg entirely; the poll never touches the board (Clear uses this).
    state.upcoming.matches = (mode === 'event') ? buildEventUpcomingExtras(state.startgg.queue, []) : [];
    // Leaving team mode drops the single-team focus so the bracket overlay shows the FULL event again
    // (a team search sets startgg.focusTeam; nothing cleared it, so the bracket stayed stuck on that team).
    if (mode !== 'team') state.startgg.focusTeam = '';
    saveAppState();
    broadcastFullState();
  },

  // ── Start.gg stream queue (marked-for-stream matches) ────────────────
  startgg_fetch_queue(msg, ws) {
    (async () => {
      try {
        if (msg.data?.tournamentSlug) state.startgg.tournamentSlug = msg.data.tournamentSlug.trim();
        const r = await fetchStreamQueue(state.startgg.tournamentSlug);
        saveAppState();
        ws.send(JSON.stringify({ type: 'startgg-result', data: { ok: true, message: `Loaded ${r.count} queued set(s) across ${r.streams.length} stream(s).` } }));
      } catch (e) {
        state.startgg.lastError = e.message;
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'startgg-result', data: { ok: false, message: e.message } }));
      }
    })();
  },

  startgg_fetch_team_queue(msg, ws) {
    (async () => {
      try {
        const { teamName, tournamentSlug } = msg.data || {};
        if (tournamentSlug) state.startgg.tournamentSlug = tournamentSlug.trim();
        const r = await fetchTeamQueue(teamName, state.startgg.tournamentSlug);
        ws.send(JSON.stringify({ type: 'startgg-team-result', data: { ok: true, message: `Found ${r.count} match(es).` } }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'startgg-team-result', data: { ok: false, message: e.message } }));
      }
    })();
  },

  startgg_push_set(msg, ws) {
    (async () => {
      try {
        const setId = (msg.data?.setId || '').trim();
        if (!setId) throw new Error('No set selected');
        const result = await syncStartGgSet(setId);
        if (result && result.superseded) { ws.send(JSON.stringify({ type: 'startgg-result', data: { ok: false, message: 'A newer set was pushed while this one loaded; it stands.' } })); return; }
        state.startgg.lastPushedSetId = setId;
        touchAutoFollowHold();     // the producer's own pick gets the full hold — auto-follow must
                                   // not override the match they just chose on the next poll
        ensureOnAirLiveInFeed();   // show the just-pushed match as LIVE in the ticker right away
        if (state.ticker.source === 'startgg') state.ticker.feed = formatTickerFeed(state.startgg.matchFeed);
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'startgg-result', data: { ok: true, message: `Pushed ${result.entrants.join(' vs ') || setId} to overlay` } }));
      } catch (e) {
        state.startgg.lastError = e.message;
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'startgg-result', data: { ok: false, message: e.message } }));
      }
    })();
  },

  startgg_set_autofollow(msg, ws) {
    const _streamChanged = typeof msg.data?.streamName === 'string' && msg.data.streamName !== state.startgg.streamName;
    if (typeof msg.data?.streamName === 'string') state.startgg.streamName = msg.data.streamName;
    setStartggAutoFollow(!!msg.data?.enabled);
    if (state.startgg.autoFollow) setActivePlatform('startgg');   // silence Challonge / NXGEN follow
    if (state.startgg.autoFollow && !state.startgg.queueEnabled && ctx.startggApiToken && state.startgg.tournamentSlug) {
      setStartggQueuePolling(true);
    }
    // Switching the followed stream/station re-scopes the overlay feeds (ticker + schedule) + auto-
    // follow — re-poll now so it takes effect immediately instead of on the next interval.
    if (_streamChanged && ctx.startggApiToken && state.startgg.tournamentSlug) {
      // Deliberately changing station is the one move that SHOULD hand the scoreboard over
      // straight away — drop the hold protecting the old station's match.
      resetAutoFollowHold();
      fetchStreamQueue(state.startgg.tournamentSlug).catch(() => {});
    }
    broadcastFullState();
    ws.send(JSON.stringify({ type: 'startgg-result', data: { ok: true, message: state.startgg.autoFollow ? 'Auto-follow ON — pushing the live set automatically.' : 'Auto-follow off.' } }));
  },

  // Unified "make this the broadcast event": full import (teams→library + bracket
  // phases + eventTeams) AND mark it the selected start.gg event. The result tells
  // the panel to open the Events tab on this tournament for first-use.
  // Paste-a-link / one-click load. Accepts { url } (tournament OR event URL/slug)
  // or { eventSlug, tournamentSlug }. Resolves tournament→event (picker if >1),
  // then full-loads teams + bracket + queue.
  load_startgg_url(msg, ws) {
    (async () => {
      const d = msg.data || {};
      const input = (d.url || d.eventSlug || d.tournamentSlug || '').trim();
      try {
        // Immediate ack (same reason as fetch_bracket below): an RLCS/EU-scale event loads
        // entrants + every bracket phase before this resolves, which is minutes, not seconds.
        // Without the ack the panel's watchdog fired at 9s and told the producer to quit and
        // relaunch the app — mid-import, while it was actually working.
        sendWs(ws, { type: 'event-result', data: { ok: true, pending: true,
          message: 'Loading from start.gg — teams first, then the bracket stage by stage…' } });
        const r = await resolveStartggUrl(input);
        if (r.needsEventPick) {
          sendWs(ws, {
            type: 'event-result',
            data: { ok: true, needsEventPick: true, tournamentSlug: r.tournamentSlug, tournamentName: r.tournamentName, events: r.events,
              message: `Pick an event — ${r.events.length} found on ${r.tournamentName || 'this tournament'}.` }
          });
        } else {
          sendWs(ws, {
            type: 'event-result',
            data: { ok: true, activated: true, tournamentSlug: r.tournamentSlug, eventSlug: r.eventSlug,
              message: `Loaded "${r.eventName || r.title}" — ${r.teams} team(s), bracket + ${r.queued} queued set(s).` }
          });
        }
      } catch (e) {
        // See the load_event catch above — capture the actual runaway-recursion stack now,
        // instead of only relaying the bare "Maximum call stack size exceeded" text to the panel.
        if (e && /call stack/i.test(e.message || '')) _logSerializeFailure(`load_startgg_url: ${e.message}`, e);
        state.startgg.lastError = e.message;
        broadcastFullState();
        sendWs(ws, { type: 'event-result', data: { ok: false, message: e.message } });
      }
    })();
  },

  activate_startgg_event(msg, ws) {
    (async () => {
      const d = msg.data || {};
      const eventSlug = (d.eventSlug || '').trim();
      const tournamentSlug = (d.tournamentSlug || '').trim() || eventSlug.replace(/\/event\/.*$/, '');
      try {
        // Same immediate ack as load_startgg_url — picking an event off the picker runs the
        // identical full import, so the panel's watchdog needs disarming here too.
        sendWs(ws, { type: 'event-result', data: { ok: true, pending: true,
          message: 'Loading from start.gg — teams first, then the bracket stage by stage…' } });
        // If we weren't handed a proper /event/ slug (e.g. a tournament URL, an /events or
        // /details page, or a bare tournament slug), resolve it like a pasted link — fetch the
        // tournament's events and auto-activate a single one, or return a picker for several.
        if (!/\/event\//i.test(eventSlug)) {
          const r = await resolveStartggUrl(eventSlug || tournamentSlug);
          if (r.needsEventPick) {
            sendWs(ws, { type: 'event-result', data: { ok: true, needsEventPick: true, tournamentSlug: r.tournamentSlug, tournamentName: r.tournamentName, events: r.events, message: `Pick an event — ${r.events.length} found on ${r.tournamentName || 'this tournament'}.` } });
          } else {
            sendWs(ws, { type: 'event-result', data: { ok: true, activated: true, tournamentSlug: r.tournamentSlug, eventSlug: r.eventSlug, message: `Loaded "${r.eventName || r.title}" — ${r.teams} team(s), bracket + ${r.queued} queued set(s).` } });
          }
          return;
        }
        const r = await activateStartggEvent(tournamentSlug, eventSlug, { name: d.name, tournamentName: d.tournamentName });
        sendWs(ws, {
          type: 'event-result',
          data: {
            ok: true, activated: true, tournamentSlug: r.tournamentSlug, eventSlug: r.eventSlug,
            message: `Activated "${r.eventName || r.title}" — ${r.teams} team(s) imported, bracket + ${r.queued} queued set(s).`
          }
        });
      } catch (e) {
        // See the load_event catch above — capture the actual runaway-recursion stack now,
        // instead of only relaying the bare "Maximum call stack size exceeded" text to the panel.
        if (e && /call stack/i.test(e.message || '')) _logSerializeFailure(`activate_startgg_event: ${e.message}`, e);
        state.startgg.lastError = e.message;
        broadcastFullState();
        sendWs(ws, { type: 'event-result', data: { ok: false, message: e.message } });
      }
    })();
  },

  // Teams page "Pull from start.gg" — import entrants into the library only.
  import_startgg_teams(msg, ws) {
    (async () => {
      const d = msg.data || {};
      try {
        const r = await importStartggTeams((d.eventSlug || d.slug || '').trim());
        sendWs(ws, {
          type: 'event-result',
          data: { ok: true, message: `Imported ${r.teams} team(s), ${r.players} player(s) to your library (${r.teamsAdded} new).` }
        });
      } catch (e) {
        if (e && /call stack/i.test(e.message || '')) _logSerializeFailure(`import_startgg_teams: ${e.message}`, e);
        sendWs(ws, { type: 'event-result', data: { ok: false, message: e.message } });
      }
    })();
  },
};

module.exports = function createStartggHandlers(c) {
  ctx = c;
  ({
    _logSerializeFailure, activateStartggEvent, activePlatformSets, applyStartggAutomation,
    broadcastFullState, buildEventUpcomingExtras, createStartGgClient, ensureOnAirLiveInFeed,
    fetchAllEntrants, fetchStreamQueue, fetchTeamQueue, fetchTournamentEvents,
    formatTickerFeed, importStartggTeams, loadStartggEventTeams, mapEntrantsToTeams,
    parseEventSlug, parseStartggInput, platformRoundLabel, refreshAllMyEvents,
    resetAutoFollowHold, resolveStartggUrl, saveAppState, saveEventTeamToLibrary, saveTeams,
    sendWs, setActivePlatform, setStartggAutoFollow, setStartggQueuePolling, state,
    syncBracketToActiveEvent, syncStartGgSet, testStartGgConnection, touchAutoFollowHold
  } = c);
  return handlers;
};
