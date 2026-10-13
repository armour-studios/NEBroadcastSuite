'use strict';
// Other tournament platforms and data sources (Challonge, Challengermode, NXGEN, FACEIT, Sheets, Riot, Liquipedia, website events) — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly; values server.js reassigns are
// read and written through ctx (challengermodeRefreshKey, challongeApiKey, faceitApiKey, liquipediaApiKey, nxgenApiKey, riotApiKey, savedTeams, sheetsServiceAccount).
let
  _logSerializeFailure, applySheetsAutoSync, broadcastFullState, buildChallongeParticipantMap,
  challengermodeClient, challongePartMap, createChallongeClient, faceit, getNxgenEvents,
  liquipedia, loadChallengermodeTournament, loadChalongeTournament, loadEvent,
  loadFaceitCompetition, loadNxgenEvent, loadSiteEvent, lpFetchRankings, lpFetchSquad,
  lpFetchStandings, lpFetchTournament, lpSyncBudget, parseChallengermodeId,
  pullOrgCompetitions, putSiteMatchOnAir, refreshAllMyEvents, refreshChallengermodeLive,
  refreshChallongeLive, refreshFaceitLive, refreshMyEvent, refreshNxgenLive, riot,
  saveAppState, saveTeams, sendWs, setActivePlatform, setChallengermodePolling,
  setChallongePolling, setFaceitPolling, setNxgenPolling, setStartggQueuePolling, sheets,
  sheetsConnect, siteEventFollow, siteEventLeague, siteEventState, state,
  syncLinkedChallongeTournament, syncSheets, touchMyEvents, wsSend;
let ctx;

const handlers = {
  site_event_load(msg, ws) {
    const d = msg.data || {};
    loadSiteEvent(d.id, { goLive: d.goLive !== false })
      .then((r) => wsSend(ws, 'site-event-result', { ok: true, ...r }))
      .catch((e) => wsSend(ws, 'site-event-result', { ok: false, error: (e && e.message) || String(e) }));
  },

  site_event_match(msg, ws) {
    try { const m = putSiteMatchOnAir(String((msg.data && msg.data.matchId) || '')); wsSend(ws, 'site-event-result', { ok: true, match: m.id }); }
    catch (e) { wsSend(ws, 'site-event-result', { ok: false, error: e.message }); }
  },

  site_event_settings(msg, ws) {
    const d = msg.data || {}, se = siteEventState();
    if (typeof d.autoFollow === 'boolean') se.autoFollow = d.autoFollow;
    if (typeof d.autoReport === 'boolean') se.autoReport = d.autoReport;
    if (se.autoFollow) siteEventFollow(siteEventLeague());
    saveAppState(); broadcastFullState();
  },

  site_event_refresh(msg, ws) {
    pullOrgCompetitions().then(() => wsSend(ws, 'site-event-result', { ok: true, refreshed: true }))
      .catch((e) => wsSend(ws, 'site-event-result', { ok: false, error: (e && e.message) || String(e) }));
  },

  site_event_unload(msg, ws) {
    const se = siteEventState();
    se.id = ''; se.leagueId = ''; se.matchId = '';
    if (state.activeEvent && state.activeEvent.platform === 'nameless') state.activeEvent = { platform: null, slug: '', name: '', gameName: '', numEntrants: 0, format: '', url: '', logo: '', loadedAt: null };
    saveAppState(); broadcastFullState();
  },

  // ── MY EVENTS — add/remove an event to the app's saved list. Start.gg events auto-sync their
  // roster (see refreshMyEvent) every ~3 min; Challonge/NXGEN events are saved as a reference —
  // no recurring sync loop for them yet, so `eventSlug` is left blank for those (refreshMyEvent's
  // own `!ev.eventSlug` guard already skips them safely).
  add_my_event(msg, ws) {
    const d = msg.data || {};
    const platform = ['challonge', 'nxgen', 'faceit', 'manual'].includes(d.platform) ? d.platform : 'startgg';
    const eventSlug = platform === 'startgg' ? (d.eventSlug || '').toString().trim() : '';
    const platformSlug = platform === 'startgg' ? '' : (d.platformSlug || '').toString().trim();
    if (platform === 'startgg' ? !eventSlug : !platformSlug) return;
    if (!Array.isArray(state.myEvents)) state.myEvents = [];
    const dupe = platform === 'startgg'
      ? state.myEvents.some((e) => e.eventSlug === eventSlug)
      : state.myEvents.some((e) => e.platform === platform && e.platformSlug === platformSlug);
    if (dupe) { sendWs(ws, { type: 'event-result', data: { ok: true, message: 'Already in MY EVENTS.' } }); return; }
    state.myEvents.unshift({
      id: 'ev' + Math.random().toString(36).slice(2, 10),
      platform,
      tournamentSlug: platform === 'startgg' ? (d.tournamentSlug || eventSlug.replace(/\/event\/.*$/, '')).toString() : '',
      eventSlug,
      platformSlug,
      name: (d.name || '').toString().slice(0, 160),
      tournamentName: (d.tournamentName || '').toString().slice(0, 160),
      game: (d.game || '').toString().slice(0, 80),
      numEntrants: Number(d.numEntrants) || 0,
      startAt: d.startAt || null,
      // Platform logos are short URLs; a manually-uploaded logo is a full base64 data URI —
      // don't truncate either (a truncated data URI is just corrupt image data).
      image: (d.image || '').toString(),
      url: (d.url || '').toString().slice(0, 600),
      addedAt: Date.now(),
      // FACEIT identifies a competition by UUID + kind (championship vs hub); without the kind a
      // saved hub would reload as a championship and 404.
      ...(platform === 'faceit' ? { competitionType: d.competitionType === 'hub' ? 'hub' : 'championship' } : {}),
    });
    touchMyEvents();
    saveAppState();
    broadcastFullState();
    sendWs(ws, { type: 'event-result', data: { ok: true, message: `Added "${d.name || 'event'}" to MY EVENTS.` } });
    // Pull its roster (teams + players + seeds) right away so seeding has data immediately —
    // start.gg only; Challonge/NXGEN entries keep whatever summary info was saved above.
    if (platform === 'startgg') {
      const added = state.myEvents.find((e) => e.eventSlug === eventSlug);
      if (added) refreshMyEvent(added).then((ok) => { if (ok) { saveAppState(); broadcastFullState(); } }).catch(() => {});
    }
  },

  remove_my_event(msg, ws) {
    const id = (msg.data && msg.data.id) || '';
    if (Array.isArray(state.myEvents)) state.myEvents = state.myEvents.filter((e) => e.id !== id);
    touchMyEvents();
    saveAppState();
    broadcastFullState();
  },

  // Manual / on-open refresh of one (or all) My Events from start.gg.
  refresh_my_event(msg, ws) {
    const id = (msg.data && msg.data.id) || '';
    const all = !id;
    if (all) { refreshAllMyEvents({ force: true }).catch(() => {}); }
    else {
      const ev = Array.isArray(state.myEvents) ? state.myEvents.find((e) => e.id === id) : null;
      if (ev) refreshMyEvent(ev).then((ok) => { saveAppState(); broadcastFullState(); sendWs(ws, { type: 'event-result', data: { ok, message: ok ? `Refreshed "${ev.name || 'event'}".` : (ev.syncError || 'Refresh failed.') } }); }).catch(() => {});
    }
  },

  // ── Riot Games API ──────────────────────────────────────────────────────
  // The producer's own key from developer.riotgames.com. No polling: Riot's per-key limit is
  // small and a development key dies after 24 hours, so calls only happen on Test / Look up.
  set_riot_settings(msg, ws) {
    const d = msg.data || {};
    if (typeof d.region === 'string' && riot.REGIONS.includes(d.region)) state.riot.region = d.region;
    if (typeof d.platform === 'string' && riot.PLATFORMS[d.platform]) {
      state.riot.platform = d.platform;
      // Keep the two routings in step — a kr platform with an americas region is a 404 that
      // reads as "player not found", which is the hardest kind of wrong to debug on air.
      const reg = riot.PLATFORM_REGION[d.platform];
      if (reg && (typeof d.region !== 'string' || !riot.REGIONS.includes(d.region))) state.riot.region = reg;
    }
    // A blank key means "leave it alone" so the panel never has to echo the secret back.
    if (typeof d.apiKey === 'string' && d.apiKey.trim()) {
      ctx.riotApiKey = d.apiKey.trim();
      state.riot.lastError = null;
    }
    if (d.clearKey) { ctx.riotApiKey = ''; state.riot.lastError = null; state.riot.lastPlayer = null; state.riot.lastCheckAt = null; }
    state.riot.keyKind = riot.keyKind(ctx.riotApiKey);
    saveAppState();
    broadcastFullState();
    sendWs(ws, { type: 'riot-result', data: { ok: true, message: ctx.riotApiKey ? 'Riot API key saved.' : 'Riot settings saved.' } });
  },

  riot_test(msg, ws) {
    (async () => {
      if (!ctx.riotApiKey) {
        sendWs(ws, { type: 'riot-result', data: { ok: false, message: 'Paste your Riot API key first.' } });
        return;
      }
      const res = await riot.checkKey(ctx.riotApiKey, state.riot.platform);
      state.riot.lastCheckAt = new Date().toISOString();
      state.riot.lastError = res.ok ? null : res.error;
      state.riot.keyKind = riot.keyKind(ctx.riotApiKey);
      broadcastFullState();
      sendWs(ws, { type: 'riot-result', data: {
        ok: !!res.ok,
        message: res.ok
          ? 'Key works — ' + res.platformName + ' reachable.' +
            (res.keyKind === 'development' ? ' This is a development key, so it stops working 24 hours after you generated it.' : '')
          : res.error
      } });
    })();
  },

  riot_lookup(msg, ws) {
    (async () => {
      const d = msg.data || {};
      if (!ctx.riotApiKey) {
        sendWs(ws, { type: 'riot-result', data: { ok: false, message: 'Paste your Riot API key first.' } });
        return;
      }
      const out = await riot.lookupPlayer(ctx.riotApiKey, {
        region: state.riot.region, platform: state.riot.platform, riotId: d.riotId || ''
      });
      state.riot.lastCheckAt = new Date().toISOString();
      state.riot.lastError = out.ok ? null : out.error;
      if (out.ok) {
        const solo = (out.entries || []).find((e) => e.queue === 'Solo/Duo') || (out.entries || [])[0] || null;
        state.riot.lastPlayer = {
          riotId: out.riotId,
          level: out.summonerLevel,
          rank: solo ? (solo.tier + ' ' + solo.rank + ' · ' + solo.lp + ' LP (' + solo.wins + 'W ' + solo.losses + 'L)') : '',
          note: out.note || ''
        };
      }
      broadcastFullState();
      const p = state.riot.lastPlayer;
      sendWs(ws, { type: 'riot-result', data: {
        ok: !!out.ok,
        message: out.ok
          ? p.riotId + (p.level != null ? ' · level ' + p.level : '') + (p.rank ? ' · ' + p.rank : '') + (p.note ? ' — ' + p.note : '')
          : out.error
      } });
    })();
  },

  // ── Liquipedia (LPDB v3) ────────────────────────────────────────────────
  // Manual-only by design: 60 requests/hour is the whole allowance, so nothing here is
  // triggered by a poll or by an overlay — only by the producer.
  set_liquipedia_settings(msg, ws) {
    const d = msg.data || {};
    if (typeof d.enabled === 'boolean') state.liquipedia.enabled = d.enabled;
    if (typeof d.wiki === 'string' && d.wiki.trim()) state.liquipedia.wiki = d.wiki.trim().toLowerCase();
    if (typeof d.contact === 'string') state.liquipedia.contact = d.contact.trim().slice(0, 200);
    // A blank key means "leave it alone" so the panel never has to echo the secret back.
    if (typeof d.apiKey === 'string' && d.apiKey.trim()) ctx.liquipediaApiKey = d.apiKey.trim();
    if (d.clearKey) ctx.liquipediaApiKey = '';
    lpSyncBudget();
    saveAppState();
    broadcastFullState();
    sendWs(ws, { type: 'liquipedia-result', data: { ok: true, message: 'Liquipedia settings saved.' } });
  },

  liquipedia_fetch(msg, ws) {
    (async () => {
      const d = msg.data || {};
      const kind = String(d.kind || 'standings');
      const force = !!d.force;
      try {
        let out;
        if (kind === 'standings')       out = await lpFetchStandings(d.page || '', force);
        else if (kind === 'rankings')   out = await lpFetchRankings(force);
        else if (kind === 'squad')      out = await lpFetchSquad(d.page || '', force);
        else if (kind === 'tournament') out = await lpFetchTournament(d.page || '', force);
        else throw new Error('Unknown Liquipedia request: ' + kind);

        const n = out.rows ? out.rows.length : (out.row ? 1 : 0);
        const age = out.ageMs != null ? Math.round(out.ageMs / 60000) : null;
        const from = out.fromCache ? ('cache' + (age != null ? ', ' + age + ' min old' : '')) : 'Liquipedia';
        broadcastFullState();
        sendWs(ws, { type: 'liquipedia-result', data: {
          ok: true, kind,
          message: n + ' row(s) from ' + from + '. ' + state.liquipedia.budgetRemaining + ' request(s) left this hour.'
            + (out.stale ? ' (serving cached data — refresh unavailable right now)' : '')
        } });
      } catch (e) {
        state.liquipedia.lastError = e.message;
        lpSyncBudget();
        broadcastFullState();
        sendWs(ws, { type: 'liquipedia-result', data: { ok: false, kind, message: e.message } });
      }
    })();
  },

  // Push the last pulled standings onto the Standings graphic. Deliberately a SEPARATE step
  // from fetching: filling a graphic must never be able to spend the hourly budget.
  liquipedia_apply_standings(msg, ws) {
    const rows = Array.isArray(state.liquipedia.standings) ? state.liquipedia.standings : [];
    if (!rows.length) {
      sendWs(ws, { type: 'liquipedia-result', data: { ok: false, message: 'Nothing pulled yet — fetch standings first.' } });
      return;
    }
    state.standings.rows = rows.map((r) => ({
      placement: r.placement, name: r.name, wins: r.wins, losses: r.losses,
      points: r.points, played: r.played
    }));
    // CC BY-SA 3.0: the overlay must credit Liquipedia while showing its data.
    state.standings.source = 'liquipedia';
    state.standings.attribution = liquipedia.LIQUIPEDIA_ATTRIBUTION;
    saveAppState();
    broadcastFullState();
    sendWs(ws, { type: 'liquipedia-result', data: { ok: true, message: 'Standings graphic filled from Liquipedia (' + rows.length + ' rows).' } });
  },

  // ── Challonge ───────────────────────────────────────────────────────────

  // ── Challengermode (challengermode.com — NOT Challonge) ────────────────
  // Every case keeps its body in braces: a bare let/const between cases in this switch is a
  // silent TDZ ReferenceError for every case after it (test/switch-scope.test.js).
  set_challengermode_settings(msg, ws) {
    const p = msg.data || {};
    state.challengermode.enabled = !!p.enabled;
    if (typeof p.tournamentId === 'string') {
      state.challengermode.tournamentId = parseChallengermodeId(p.tournamentId) || p.tournamentId.trim();
    }
    if (typeof p.refreshKey === 'string' && p.refreshKey.trim()) ctx.challengermodeRefreshKey = p.refreshKey.trim();
    if (typeof p.spaceId === 'string') state.challengermode.spaceId = parseChallengermodeId(p.spaceId) || p.spaceId.trim();
    if (p.pollSec != null) state.challengermode.pollSec = Math.max(10, Math.min(600, Math.round(Number(p.pollSec) || 30)));
    saveAppState();
    broadcastFullState();
    if (state.challengermode.enabled && ctx.challengermodeRefreshKey && state.challengermode.tournamentId) {
      setChallengermodePolling(true);   // re-arms at the new interval
    }
  },

  challengermode_test_connection(msg, ws) {
    (async () => {
      try {
        await challengermodeClient().testConnection();
        state.challengermode.connected = true;
        state.challengermode.lastError = null;
        broadcastFullState();
        sendWs(ws, { type: 'challengermode-result', data: { ok: true, message: 'Connected to Challengermode.' } });
      } catch (e) {
        state.challengermode.connected = false;
        state.challengermode.lastError = e.message;
        broadcastFullState();
        sendWs(ws, { type: 'challengermode-result', data: { ok: false, message: e.message } });
      }
    })();
  },

  load_challengermode_tournament(msg, ws) {
    const raw = (msg.data?.id || state.challengermode.tournamentId || '').trim();
    if (!raw) { sendWs(ws, { type: 'challengermode-result', data: { ok: false, message: 'Paste a Challengermode tournament link or id.' } }); return; }
    if (!ctx.challengermodeRefreshKey) { sendWs(ws, { type: 'challengermode-result', data: { ok: false, message: 'Add your Challengermode refresh key under Apps > Challengermode first.' } }); return; }
    (async () => {
      try {
        sendWs(ws, { type: 'challengermode-result', data: { ok: true, message: 'Loading tournament…', loading: true } });
        const r = await loadChallengermodeTournament(raw);
        state.challengermode.enabled = true;
        setChallengermodePolling(true);
        sendWs(ws, { type: 'challengermode-result', data: { ok: true, loaded: true,
          message: `Loaded "${r.name}" — ${r.teamsCount} entrants, ${r.matchesCount} matches${r.stages > 1 ? `, ${r.stages} stages` : ''}${r.game ? ` (${r.game})` : ''}.` } });
      } catch (e) {
        state.challengermode.connected = false;
        state.challengermode.lastError = e.message;
        broadcastFullState();
        sendWs(ws, { type: 'challengermode-result', data: { ok: false, message: e.message } });
      }
    })();
  },

  challengermode_refresh(msg, ws) {
    (async () => {
      try {
        await refreshChallengermodeLive();
        sendWs(ws, { type: 'challengermode-result', data: { ok: true, message: 'Bracket refreshed.' } });
      } catch (e) {
        sendWs(ws, { type: 'challengermode-result', data: { ok: false, message: e.message } });
      }
    })();
  },

  set_challengermode_auto_follow(msg, ws) {
    state.challengermode.autoFollow = !!msg.data?.enabled;
    if (state.challengermode.autoFollow) {
      setActivePlatform('challengermode');   // silence the other platforms' follows
      setChallengermodePolling(true);
    }
    saveAppState();
    broadcastFullState();
  },

  // Put Challengermode's real finish order on the standings / top-8 board.
  // 'challengermode-placements' is what tells the poller to keep re-mirroring it.
  push_challengermode_placements(msg, ws) {
    const rows = (state.challengermodePlacements.rows || []).slice(0, Math.max(1, Math.min(32, Number(msg.data?.limit) || 8)));
    if (!rows.length) {
      sendWs(ws, { type: 'challengermode-result', data: { ok: false, message: 'No finish order yet — Challengermode only assigns a placement once an entrant is out.' } });
      return;
    }
    state.standings.rows = rows.map((r) => ({
      placement: r.placement, placementText: r.placementText, name: r.name, logo: r.logo || null
    }));
    state.standings.source = 'challengermode-placements';
    state.standings.attribution = '';
    saveAppState();
    broadcastFullState();
    sendWs(ws, { type: 'challengermode-result', data: { ok: true,
      message: `Top ${rows.length} pushed${state.challengermodePlacements.complete ? '' : ' (tournament still running — it will keep updating)'}.` } });
  },

  set_challonge_settings(msg, ws) {
    const p = msg.data || {};
    state.challonge.enabled = !!p.enabled;
    state.challonge.tournamentSlug = (p.tournamentSlug || '').trim();
    if (typeof p.apiKey === 'string' && p.apiKey.trim()) ctx.challongeApiKey = p.apiKey.trim();
    // Poll interval, floored at 15s. Challonge's free plan allows 500 requests a MONTH and each
    // poll costs three, so this is the dial a producer on a free key needs — see challongeSpend().
    if (p.pollSec != null) state.challonge.pollSec = Math.max(15, Math.min(600, Math.round(Number(p.pollSec) || 30)));
    saveAppState();
    broadcastFullState();
    if (state.challonge.enabled && ctx.challongeApiKey && state.challonge.tournamentSlug) {
      setChallongePolling(true);   // re-arms the timer at the new interval
    } else if (!state.challonge.enabled) {
      setChallongePolling(false);
    }
  },

  set_challonge_auto_follow(msg, ws) {
    state.challonge.autoFollow = !!msg.data?.enabled;
    if (state.challonge.autoFollow) setActivePlatform('challonge');   // silence start.gg / NXGEN follow
    saveAppState();
    broadcastFullState();
  },

  clear_active_event(msg, ws) {
    const clearedPlatform = state.activeEvent && state.activeEvent.platform;
    if (clearedPlatform === 'challonge') setChallongePolling(false);
    else if (clearedPlatform === 'nxgen') setNxgenPolling(false);
    else if (clearedPlatform === 'challengermode') setChallengermodePolling(false);
    state.activeEvent = { platform: null, slug: '', name: '', gameName: '', numEntrants: 0, format: '', url: '', logo: '', loadedAt: null };
    // The title itself stays on air (clearing the event shouldn't blank the overlay mid-show), but
    // it's no longer tied to an event — loading that same event again pulls its name fresh.
    state.eventNameSlug = '';
    // Clearing the event clears its DOWNSTREAM feeds too — the stream queue kept
    // polling and repopulating boards after the event was supposedly gone.
    state.startgg.queue = [];
    state.startgg.eventSlug = '';
    state.startgg.selectedEvent = null;
    state.startgg.matchFeed = [];
    if (state.ticker.source === 'startgg') state.ticker.feed = [];
    setStartggQueuePolling(false);   // stops the poll timer + persists queueEnabled=false
    // Same for FACEIT: a live poll left running after "Clear" keeps rewriting the bracket and
    // the queue for an event the producer just took off air.
    if (state.faceit.competitionId || state.faceit.queue.length) {
      setFaceitPolling(false);
      state.faceit.autoFollow = false;
      state.faceit.competitionId = '';
      state.faceit.selectedEvent = null;
      state.faceit.queue = [];
      state.faceit.eventTeams = [];
      state.faceit.lastAutoFollowMatchId = null;
    }
    saveAppState();
    broadcastFullState();
  },

  challonge_test_connection(msg, ws) {
    (async () => {
      try {
        const client = createChallongeClient(ctx.challongeApiKey);
        await client.get('/tournaments.json', { state: 'all', per_page: 1 });
        state.challonge.connected = true;
        state.challonge.lastError = null;
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: true, message: 'Connected to Challonge successfully.' } }));
      } catch (e) {
        state.challonge.connected = false;
        state.challonge.lastError = e.message;
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: false, message: e.message } }));
      }
    })();
  },

  load_challonge_tournament(msg, ws) {
    const slug = (msg.data?.slug || state.challonge.tournamentSlug || '').trim();
    if (!slug) { ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: false, message: 'No tournament slug provided.' } })); return; }
    if (!ctx.challongeApiKey) { ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: false, message: 'Challonge API key not configured.' } })); return; }
    (async () => {
      try {
        ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: true, message: 'Loading tournament…', loading: true } }));
        const result = await loadChalongeTournament(slug);
        saveAppState();
        setChallongePolling(true);
        ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: true, message: `Loaded "${result.name}" — ${result.teamsCount} teams, ${result.matchesCount} matches.`, loaded: true } }));
      } catch (e) {
        state.challonge.connected = false;
        state.challonge.lastError = e.message;
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: false, message: e.message } }));
      }
    })();
  },

  // Put Challonge's real finish order on the standings/top-8 board. 'challonge-placements' is
  // what tells refreshChallongeLive() to keep re-mirroring it as the bracket resolves.
  push_challonge_placements(msg, ws) {
    const rows = (state.challongePlacements.rows || []).slice(0, Math.max(1, Math.min(32, Number(msg.data?.limit) || 8)));
    if (!rows.length) {
      ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: false, message: 'No finish order yet — Challonge only fills a placement once a player is eliminated.' } }));
      return;
    }
    state.standings.rows = rows.map((r) => ({ placement: r.placement, name: r.name, logo: r.logo || null }));
    state.standings.source = 'challonge-placements';
    state.standings.attribution = '';
    saveAppState();
    broadcastFullState();
    ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: true, message: `Top ${rows.length} pushed${state.challongePlacements.complete ? '' : ' (bracket still running — it will keep updating)'}.` } }));
  },

  challonge_refresh(msg, ws) {
    (async () => {
      try {
        await refreshChallongeLive();
        ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: true, message: 'Bracket refreshed.' } }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: false, message: e.message } }));
      }
    })();
  },

  challonge_push_match(msg, ws) {
    const { matchId, scoreA, scoreB, winnerId } = msg.data || {};
    if (!matchId) { ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: false, message: 'matchId required.' } })); return; }
    if (!ctx.challongeApiKey) { ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: false, message: 'Challonge API key not configured.' } })); return; }
    const slug = state.challonge.tournamentSlug;
    if (!slug) { ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: false, message: 'No tournament loaded.' } })); return; }
    (async () => {
      try {
        const client = createChallongeClient(ctx.challongeApiKey);
        const body = { match: { scores_csv: `${scoreA || 0}-${scoreB || 0}` } };
        if (winnerId) body.match.winner_id = winnerId;
        await client.put(`/tournaments/${slug}/matches/${matchId}.json`, body);
        await refreshChallongeLive();
        ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: true, message: `Match ${matchId} updated.` } }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: false, message: e.message } }));
      }
    })();
  },

  import_challonge_teams(msg, ws) {
    const slug = (msg.data?.slug || state.challonge.tournamentSlug || '').trim();
    if (!slug || !ctx.challongeApiKey) { ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: false, message: 'API key and tournament slug required.' } })); return; }
    (async () => {
      try {
        const client = createChallongeClient(ctx.challongeApiKey);
        const pData = await client.get(`/tournaments/${slug}/participants.json`);
        const partMap = challongePartMap(pData);
        let added = 0;
        Object.values(partMap).forEach((p) => {
          const existing = ctx.savedTeams.find((t) => t.name.toLowerCase() === p.name.toLowerCase());
          if (!existing) { ctx.savedTeams.push({ name: p.name, logo: p.logo || null, players: [] }); added++; }
        });
        saveTeams();
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: true, message: `Imported ${added} new teams (${pData.length} total participants).` } }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'challonge-result', data: { ok: false, message: e.message } }));
      }
    })();
  },

  link_event_challonge(msg, ws) {
    const { eventId, challongeSlug, enabled = true } = msg.data || {};
    const evLink = (Array.isArray(state.myEvents) ? state.myEvents : []).find(e => e.id === eventId);
    if (!evLink) { ws.send(JSON.stringify({ type: 'link-result', data: { ok: false, message: 'Event not found.' } })); return; }
    if (!ctx.challongeApiKey) { ws.send(JSON.stringify({ type: 'link-result', data: { ok: false, message: 'Add your Challonge API key under Apps > Challonge first.' } })); return; }
    const lSlug = (challongeSlug || '').trim();
    if (!lSlug) { ws.send(JSON.stringify({ type: 'link-result', data: { ok: false, message: 'No tournament slug provided.' } })); return; }
    (async () => {
      try {
        ws.send(JSON.stringify({ type: 'link-result', data: { ok: true, message: 'Building participant map…', loading: true } }));
        const participantMap = await buildChallongeParticipantMap(lSlug);
        const count = Object.keys(participantMap).length;
        const prevPushed = (evLink.challongeSync && evLink.challongeSync.slug === lSlug) ? evLink.challongeSync.pushedMatches || {} : {};
        evLink.challongeSync = { slug: lSlug, enabled: !!enabled, participantMap, pushedMatches: prevPushed, lastSyncAt: null, lastError: null };
        touchMyEvents();
        saveAppState();
        broadcastFullState();
        syncLinkedChallongeTournament(evLink).catch(() => {});
        ws.send(JSON.stringify({ type: 'link-result', data: { ok: true, message: `Linked to challonge.com/${lSlug} — ${count} participants mapped.`, linked: true } }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'link-result', data: { ok: false, message: e.message } }));
      }
    })();
  },

  unlink_event_challonge(msg, ws) {
    const { eventId: ulEvId } = msg.data || {};
    const evUnlink = (Array.isArray(state.myEvents) ? state.myEvents : []).find(e => e.id === ulEvId);
    if (evUnlink) { delete evUnlink.challongeSync; touchMyEvents(); saveAppState(); broadcastFullState(); }
    ws.send(JSON.stringify({ type: 'link-result', data: { ok: true, message: 'Auto-sync unlinked.', unlinked: true } }));
  },

  toggle_challonge_sync(msg, ws) {
    const { eventId: tsEvId, enabled: tsEnabled } = msg.data || {};
    const evToggle = (Array.isArray(state.myEvents) ? state.myEvents : []).find(e => e.id === tsEvId);
    if (evToggle && evToggle.challongeSync) { evToggle.challongeSync.enabled = !!tsEnabled; touchMyEvents(); saveAppState(); broadcastFullState(); }
  },

  // ── NXGEN ────────────────────────────────────────────────────────────
  set_nxgen_settings(msg, ws) {
    const p = msg.data || {};
    state.nxgen.enabled = !!p.enabled;
    state.nxgen.eventSlug = (p.eventSlug || '').trim();
    if (typeof p.apiKey === 'string' && p.apiKey.trim()) ctx.nxgenApiKey = p.apiKey.trim();
    saveAppState();
    broadcastFullState();
    if (state.nxgen.enabled && ctx.nxgenApiKey && state.nxgen.eventSlug) setNxgenPolling(true);
    else if (!state.nxgen.enabled) setNxgenPolling(false);
  },

  set_nxgen_auto_follow(msg, ws) {
    state.nxgen.autoFollow = !!msg.data?.enabled;
    if (state.nxgen.autoFollow) setActivePlatform('nxgen');   // silence start.gg / Challonge follow
    saveAppState();
    broadcastFullState();
  },

  // ── Google Sheets ──
  set_sheets_config(msg, ws) {
    const p = msg.data || {};
    if (typeof p.serviceAccount === 'string' && p.serviceAccount.trim()) {
      try { const sa = sheets.parseServiceAccount(p.serviceAccount.trim()); ctx.sheetsServiceAccount = p.serviceAccount.trim(); state.sheets.saEmail = sa.client_email; }
      catch (e) { ws.send(JSON.stringify({ type: 'sheets-result', data: { ok: false, notify: true, message: e.message } })); return; }
    } else if (p.clearServiceAccount) { ctx.sheetsServiceAccount = ''; state.sheets.saEmail = ''; state.sheets.connected = false; }
    if (typeof p.enabled === 'boolean') state.sheets.enabled = p.enabled;
    if (typeof p.sheetUrl === 'string') { state.sheets.sheetUrl = p.sheetUrl.trim(); state.sheets.sheetId = sheets.extractSheetId(p.sheetUrl); }
    if (typeof p.autoSyncSec === 'number') state.sheets.autoSyncSec = Math.max(0, Math.min(3600, Math.round(p.autoSyncSec)));
    if (p.maps && typeof p.maps === 'object') {
      ['teams', 'schedule', 'standings', 'brResults', 'brPlayers'].forEach((k) => {
        if (!p.maps[k]) return;
        if (typeof p.maps[k].direction === 'string' && ['off', 'import', 'export', 'both'].includes(p.maps[k].direction)) state.sheets.maps[k].direction = p.maps[k].direction;
        if (typeof p.maps[k].tab === 'string') state.sheets.maps[k].tab = p.maps[k].tab;
      });
    }
    saveAppState();
    broadcastFullState();
    applySheetsAutoSync();
  },

  sheets_connect(msg, ws) {
    (async () => {
      try {
        const meta = await sheetsConnect();
        saveAppState();
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'sheets-result', data: { ok: true, notify: true, message: 'Connected to "' + (meta.title || 'sheet') + '" — ' + meta.tabs.length + ' tab(s) found.' } }));
      } catch (e) {
        state.sheets.connected = false; state.sheets.lastError = e.message; broadcastFullState();
        ws.send(JSON.stringify({ type: 'sheets-result', data: { ok: false, notify: true, message: e.message } }));
      }
    })();
  },

  sheets_sync(msg, ws) {
    (async () => {
      try {
        const r = await syncSheets('manual');
        ws.send(JSON.stringify({ type: 'sheets-result', data: { ok: !!r.ok, notify: true, message: r.message } }));
      } catch (e) {
        state.sheets.lastError = e.message; broadcastFullState();
        ws.send(JSON.stringify({ type: 'sheets-result', data: { ok: false, notify: true, message: 'Sync failed: ' + e.message } }));
      }
    })();
  },

  nxgen_test_connection(msg, ws) {
    (async () => {
      try {
        await getNxgenEvents(ctx.nxgenApiKey, { limit: 1 });
        state.nxgen.connected = true;
        state.nxgen.lastError = null;
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'nxgen-result', data: { ok: true, message: 'Connected to NXGEN successfully.' } }));
      } catch (e) {
        state.nxgen.connected = false;
        state.nxgen.lastError = e.message;
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'nxgen-result', data: { ok: false, message: e.message } }));
      }
    })();
  },

  load_nxgen_event(msg, ws) {
    const slug = (msg.data?.slug || state.nxgen.eventSlug || '').trim();
    if (!slug) { ws.send(JSON.stringify({ type: 'nxgen-result', data: { ok: false, message: 'No event slug provided.' } })); return; }
    if (!ctx.nxgenApiKey) { ws.send(JSON.stringify({ type: 'nxgen-result', data: { ok: false, message: 'No NXGEN API key yet. Add it under Apps > NXGEN.' } })); return; }
    (async () => {
      try {
        ws.send(JSON.stringify({ type: 'nxgen-result', data: { ok: true, message: 'Loading event…', loading: true } }));
        const result = await loadNxgenEvent(slug);
        saveAppState();
        broadcastFullState();
        setNxgenPolling(state.nxgen.enabled);
        ws.send(JSON.stringify({ type: 'nxgen-result', data: { ok: true, message: `Loaded "${result.name}" — ${result.teamsCount} participants, ${result.matchesCount} matches.${result.warning || ''}`, loaded: true } }));
      } catch (e) {
        state.nxgen.connected = false;
        state.nxgen.lastError = e.message;
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'nxgen-result', data: { ok: false, message: e.message } }));
      }
    })();
  },

  nxgen_refresh(msg, ws) {
    (async () => {
      try {
        await refreshNxgenLive();
        ws.send(JSON.stringify({ type: 'nxgen-result', data: { ok: true, message: 'Event refreshed.' } }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'nxgen-result', data: { ok: false, message: e.message } }));
      }
    })();
  },

  nxgen_import_teams(msg, ws) {
    (async () => {
      try {
        const teams = state.nxgen.eventTeams || [];
        if (!teams.length) throw new Error('No participants loaded — load an event first.');
        let added = 0;
        teams.forEach(t => {
          const existing = ctx.savedTeams.find(s => s.name.toLowerCase() === (t.name || '').toLowerCase());
          if (!existing) { ctx.savedTeams.push({ name: t.name, logo: t.logo || null, players: [] }); added++; }
        });
        saveTeams();
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'nxgen-result', data: { ok: true, message: `${added} new team${added !== 1 ? 's' : ''} added to library.` } }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'nxgen-result', data: { ok: false, message: e.message } }));
      }
    })();
  },

  // ── FACEIT ───────────────────────────────────────────────────────────
  set_faceit_settings(msg, ws) {
    const p = msg.data || {};
    state.faceit.enabled = !!p.enabled;
    // Accept a pasted browser URL as well as a bare UUID — the producer has the URL, not the id.
    if (typeof p.competitionId === 'string') {
      const parsed = faceit.parseFaceitCompetition(p.competitionId);
      if (parsed) {
        state.faceit.competitionId = parsed.id;
        // An explicit type from the panel wins; otherwise let the pasted URL decide.
        state.faceit.competitionType = (p.competitionType === 'hub' || p.competitionType === 'championship')
          ? p.competitionType : parsed.type;
      } else {
        state.faceit.competitionId = p.competitionId.trim();
        if (p.competitionType === 'hub' || p.competitionType === 'championship') state.faceit.competitionType = p.competitionType;
      }
    } else if (p.competitionType === 'hub' || p.competitionType === 'championship') {
      state.faceit.competitionType = p.competitionType;
    }
    if (typeof p.organizerName === 'string') state.faceit.organizerName = p.organizerName.trim();
    if (typeof p.apiKey === 'string' && p.apiKey.trim()) ctx.faceitApiKey = p.apiKey.trim();
    saveAppState();
    broadcastFullState();
    if (state.faceit.enabled && ctx.faceitApiKey && state.faceit.competitionId) setFaceitPolling(true);
    else if (!state.faceit.enabled) setFaceitPolling(false);
  },

  set_faceit_auto_follow(msg, ws) {
    state.faceit.autoFollow = !!msg.data?.enabled;
    if (state.faceit.autoFollow) setActivePlatform('faceit');   // silence the other platforms' follow
    saveAppState();
    broadcastFullState();
  },

  faceit_test_connection(msg, ws) {
    (async () => {
      try {
        // A cheap authenticated read that works for every key: search returns 200 + an empty
        // list for a nonsense name, so a failure here really is the key, not the query.
        await faceit.searchFaceitChampionships(ctx.faceitApiKey, { name: 'a', limit: 1 });
        state.faceit.connected = true;
        state.faceit.lastError = null;
        // Resolve the saved organiser name to an id so the Events tab can list their comps.
        if (state.faceit.organizerName && !state.faceit.organizerId) {
          try {
            const org = await faceit.getFaceitOrganizerByName(ctx.faceitApiKey, state.faceit.organizerName);
            if (org && org.organizer_id) { state.faceit.organizerId = org.organizer_id; state.faceit.organizerName = org.name || state.faceit.organizerName; }
          } catch {}
        }
        saveAppState();
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'faceit-result', data: { ok: true, message: 'Connected to FACEIT successfully.' } }));
      } catch (e) {
        state.faceit.connected = false;
        state.faceit.lastError = e.message;
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'faceit-result', data: { ok: false, message: e.message } }));
      }
    })();
  },

  load_faceit_event(msg, ws) {
    const raw = (msg.data?.id || msg.data?.slug || state.faceit.competitionId || '').trim();
    const parsed = faceit.parseFaceitCompetition(raw);
    const compId = parsed ? parsed.id : raw;
    const compType = msg.data?.competitionType || (parsed ? parsed.type : state.faceit.competitionType) || 'championship';
    if (!compId) { ws.send(JSON.stringify({ type: 'faceit-result', data: { ok: false, message: 'No FACEIT championship or hub provided.' } })); return; }
    if (!ctx.faceitApiKey) { ws.send(JSON.stringify({ type: 'faceit-result', data: { ok: false, message: 'No FACEIT API key yet. Add it under Apps > FACEIT.' } })); return; }
    (async () => {
      try {
        ws.send(JSON.stringify({ type: 'faceit-result', data: { ok: true, message: 'Loading competition…', loading: true } }));
        const result = await loadFaceitCompetition(compId, compType);
        saveAppState();
        broadcastFullState();
        setFaceitPolling(state.faceit.enabled);
        ws.send(JSON.stringify({ type: 'faceit-result', data: { ok: true, message: `Loaded "${result.name}" — ${result.teamsCount} teams, ${result.matchesCount} matches.`, loaded: true } }));
      } catch (e) {
        state.faceit.connected = false;
        state.faceit.lastError = e.message;
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'faceit-result', data: { ok: false, message: e.message } }));
      }
    })();
  },

  faceit_refresh(msg, ws) {
    (async () => {
      try {
        await refreshFaceitLive();
        ws.send(JSON.stringify({ type: 'faceit-result', data: { ok: !!state.faceit.connected, message: state.faceit.connected ? 'Competition refreshed.' : (state.faceit.lastError || 'Refresh failed.') } }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'faceit-result', data: { ok: false, message: e.message } }));
      }
    })();
  },

  faceit_import_teams(msg, ws) {
    (async () => {
      try {
        const teams = state.faceit.eventTeams || [];
        if (!teams.length) throw new Error('No teams loaded — load a competition first.');
        let added = 0;
        teams.forEach((t) => {
          const existing = ctx.savedTeams.find((s) => s.name.toLowerCase() === (t.name || '').toLowerCase());
          if (!existing) {
            ctx.savedTeams.push({ name: t.name, logo: t.logo || null, players: (t.players || []).slice() });
            added++;
          }
        });
        saveTeams();
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'faceit-result', data: { ok: true, message: `${added} new team${added !== 1 ? 's' : ''} added to library.` } }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'faceit-result', data: { ok: false, message: e.message } }));
      }
    })();
  },

  load_event(msg, ws) {
    (async () => {
      try {
        const slug = (msg.data?.eventSlug || state.bracket.eventSlug || '').trim();
        const r = await loadEvent(slug);
        sendWs(ws, {
          type: 'event-result',
          data: {
            ok: true,
            message: `Loaded "${r.title}" — ${r.teams} team(s), ${r.players} player(s), ${r.logos} logo(s), ${r.sets} set(s).`
          }
        });
      } catch (e) {
        // "Maximum call stack size exceeded" here means a runaway recursive function or a
        // pathologically deep chain in the freshly-fetched bracket — unlike the broadcast/save
        // paths (_flushFullState/_saveAppStateNow), nothing upstream of this catch logs it, so a
        // producer just sees the raw error with no trace to debug from. Capture the stack now.
        if (e && /call stack/i.test(e.message || '')) _logSerializeFailure(`load_event: ${e.message}`, e);
        state.bracket.lastError = e.message;
        broadcastFullState();
        sendWs(ws, { type: 'event-result', data: { ok: false, message: e.message } });
      }
    })();
  },
};

module.exports = function createTournamentHandlers(c) {
  ctx = c;
  ({
    _logSerializeFailure, applySheetsAutoSync, broadcastFullState,
    buildChallongeParticipantMap, challengermodeClient, challongePartMap,
    createChallongeClient, faceit, getNxgenEvents, liquipedia, loadChallengermodeTournament,
    loadChalongeTournament, loadEvent, loadFaceitCompetition, loadNxgenEvent, loadSiteEvent,
    lpFetchRankings, lpFetchSquad, lpFetchStandings, lpFetchTournament, lpSyncBudget,
    parseChallengermodeId, pullOrgCompetitions, putSiteMatchOnAir, refreshAllMyEvents,
    refreshChallengermodeLive, refreshChallongeLive, refreshFaceitLive, refreshMyEvent,
    refreshNxgenLive, riot, saveAppState, saveTeams, sendWs, setActivePlatform,
    setChallengermodePolling, setChallongePolling, setFaceitPolling, setNxgenPolling,
    setStartggQueuePolling, sheets, sheetsConnect, siteEventFollow, siteEventLeague,
    siteEventState, state, syncLinkedChallongeTournament, syncSheets, touchMyEvents, wsSend
  } = c);
  return handlers;
};
