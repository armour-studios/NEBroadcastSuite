'use strict';
// Teams and players — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly; values server.js reassigns are
// read and written through ctx (leaguesVer, savedTeams).
let
  abbrForTeamName, broadcastFullState, cleanTeamAbbr, findTeamPlayer, logoForTeamName,
  persistRosterToLibrary, pickAutoFollowSet, propagateVaultCrest, rebuildCombinedPlayers,
  refreshCompetitionFeed, retuneRoundLabel, saveAppState, saveTeams, state, teamDb, vaultTouch;
let ctx;

const handlers = {
  set_team_record_settings(msg, ws) {
    const d = msg.data || {};
    if (typeof d.enabled === 'boolean') state.teamRecord.enabled = d.enabled;
    if (typeof d.showSeed === 'boolean') state.teamRecord.showSeed = d.showSeed;
    if (typeof d.metric === 'string') {
      const allowed = ['season', 'week', 'pts', 'place', 'record-pts', 'games'];
      if (allowed.includes(d.metric)) state.teamRecord.metric = d.metric;
    }
    if (typeof d.source === 'string' && ['stats', 'startgg', 'manual'].includes(d.source)) state.teamRecord.source = d.source;
    if ('leagueId' in d) state.teamRecord.leagueId = (d.leagueId == null ? '' : String(d.leagueId));
    if ('week' in d) state.teamRecord.week = (d.week == null ? '' : String(d.week));
    saveAppState();
    broadcastFullState();
  },

  // Per-team manual record (W-L, optional pts/place) edited in the team boxes. Stored keyed by the
  // team NAME currently on that side, so the record is tied to the team profile — it follows the
  // team across side swaps and reassignments instead of staying pinned to Blue/Orange.
  set_team_record_manual(msg, ws) {
    const d = msg.data || {};
    const side = d.side === 'orange' ? 'orange' : (d.side === 'blue' ? 'blue' : null);
    if (!side) return;
    const key = ((state.teams[side] && state.teams[side].name) || '').trim().toLowerCase();
    if (!key) return;   // no team on that side — nothing to key the record to
    if (!state.teamRecord.manualByName) state.teamRecord.manualByName = {};
    const m = { ...(state.teamRecord.manualByName[key] || {}) };
    ['w', 'l', 'pts', 'place'].forEach((k) => {
      if (k in d) { const v = d[k]; m[k] = (v === '' || v == null) ? (k === 'w' || k === 'l' ? 0 : null) : Math.max(0, parseInt(v, 10) || 0); }
    });
    state.teamRecord.manualByName[key] = m;
    saveAppState();
    broadcastFullState();
  },

  // Toggle: match live-game team names to the saved-teams library (apply logo/colour).
  set_auto_teams_from_game(msg, ws) {
    state.autoTeamsFromGame = !!(msg.data && msg.data.enabled);
    saveAppState();
    broadcastFullState();
  },

  // Match ▸ Teams abbreviation field applies on change, like the colour picker. Blank = back to
  // the library/vault tag for the team on that side (or nothing, = initials on the overlays).
  set_team_abbr(msg, ws) {
    const d = msg.data || {};
    if (d.side === 'blue' || d.side === 'orange') {
      const t = state.teams[d.side] || (state.teams[d.side] = { name: '', logo: null, players: [] });
      t.abbr = cleanTeamAbbr(d.abbr) || abbrForTeamName(t.name);
      saveAppState();
      broadcastFullState();
    }
  },

  set_team_color(msg, ws) {
    if ((msg.data.side === 'blue' || msg.data.side === 'orange') && typeof msg.data.color === 'string') {
      const c = msg.data.color.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(c)) {
        state.teams[msg.data.side].color = c;
        // Keep the team LIBRARY in sync too — Schedule/standings/bracket/anything else that
        // resolves a team's color by NAME reads savedTeams, never the live match sides, so
        // without this a color picked here only ever showed up on the current match's own
        // HUD/scoreboard and nowhere else.
        const teamName = (state.teams[msg.data.side].name || '').trim().toLowerCase();
        if (teamName) {
          const saved = ctx.savedTeams.find((t) => t && (t.name || '').trim().toLowerCase() === teamName);
          if (saved && saved.color !== c) { saved.color = c; saveTeams(); }
        }
        saveAppState();
        broadcastFullState();
      }
    }
  },

  // Pull the two teams currently live on the start.gg stream into blue/orange,
  // with logos + player rosters (the rosters feed the facecam rows).
  autofill_stream_teams(msg, ws) {
    const q = state.startgg.queue || [];
    // Same stream scoping as auto-follow: never autofill from another station's match.
    const wantStream = state.startgg.streamName;
    const set = pickAutoFollowSet(q, wantStream) || (wantStream ? null : q[0]);
    if (!set) {
      state.startgg.lastError = 'Stream queue is empty — on start.gg, attach sets to your stream (Match Settings → Stream), then they appear here.';
      broadcastFullState();
      return;
    }
    const upper = (s) => (s || '').toString().trim().toUpperCase();
    // Match the exact entrant by start.gg id first (names collide across orgs), same as
    // syncStartggSet; fall back to name only when there's no id or no id-tagged match.
    const assign = (side, teamName, rawEntId) => {
      const nm = upper(teamName);
      // Logo, roster and org are reset with the name. Everything below is a conditional fill, so
      // spreading the old team forward left the PREVIOUS entrant's crest, players and sponsor on
      // the side whenever the new entrant had none of their own - an unsponsored player inherited
      // the last one's org and the board read "AGENCY DREDAWG". Same reset syncStartGgSet does.
      state.teams[side] = { ...state.teams[side], name: nm, logo: '', players: [], org: '' };
      const id = (rawEntId != null) ? String(rawEntId) : '';
      const byId = (arr) => id ? (arr || []).find((t) => t.startggId && String(t.startggId) === id) : null;
      const byName = (arr) => (arr || []).find((t) => upper(t.name) === nm);
      const et = byId(state.startgg.eventTeams) || byName(state.startgg.eventTeams);
      let saved = byId(ctx.savedTeams);
      if (!saved) { const m = byName(ctx.savedTeams); if (m && !(m.startggId && id && String(m.startggId) !== id)) saved = m; }
      const src = et || saved;
      if (src) {
        if (src.logo) state.teams[side].logo = src.logo;
        if (Array.isArray(src.players) && src.players.length) state.teams[side].players = src.players;
        if (src.org) state.teams[side].org = src.org;
      }
      // Nothing matched: keep the name-based crest lookup the push path also falls back to, so
      // clearing the stale logo above can't leave a branded team on air with no mark.
      if (!state.teams[side].logo) {
        const lg = logoForTeamName(nm);
        if (lg) state.teams[side].logo = lg;
      }
    };
    assign('blue', set.teamA, set.slots?.[0]?.entrant?.id);
    assign('orange', set.teamB, set.slots?.[1]?.entrant?.id);
    rebuildCombinedPlayers();
    retuneRoundLabel();   // autofill loads a set's teams but never wrote its round — do that now
    state.startgg.lastError = null;
    saveAppState();
    broadcastFullState();
  },

  save_team(msg, ws) {
    const { name, oldName } = msg.data;
    let { logo, color } = msg.data;
    let players = Array.isArray(msg.data.players) ? msg.data.players : null;
    const favorite = typeof msg.data.favorite === 'boolean' ? msg.data.favorite : undefined;
    // abbr: honour whenever the key is present (including null/'' = deliberately cleared);
    // it was silently dropped before, so the editor's Abbreviation field never saved.
    const hasAbbr = Object.prototype.hasOwnProperty.call(msg.data, 'abbr');
    const abbr = hasAbbr ? (String(msg.data.abbr || '').trim().toUpperCase().slice(0, 6) || null) : undefined;
    // Match the library entry by NORMALIZED name (trim + case-insensitive) so a quick-save of a
    // match team (whose name the panel uppercases) UPDATES the existing "Team Alpha" instead of
    // spawning a duplicate "TEAM ALPHA". Only an explicit rename (oldName present) changes the
    // stored casing; a plain re-save keeps the library entry's own name.
    const _tn = (s) => (s || '').trim().toLowerCase();
    let idx = -1;
    if (oldName) idx = ctx.savedTeams.findIndex(t => _tn(t.name) === _tn(oldName));
    if (idx === -1) idx = ctx.savedTeams.findIndex(t => _tn(t.name) === _tn(name));

    // Importers (teams CSV / JSON) send merge:true. A row that matches a team already in the
    // library ADDS to it: a blank logo / colour in the file means "the file doesn't say", never
    // "remove it", and the roster is merged by player name so existing ids, roles, cameras and
    // links survive. Without this a re-import of a names-only CSV wiped crests and rosters.
    if (msg.data.merge === true && idx >= 0) {
      const prevTeam = ctx.savedTeams[idx] || {};
      if (!logo) logo = undefined;
      if (!color) color = undefined;
      if (players !== null) {
        const merged = (Array.isArray(prevTeam.players) ? prevTeam.players : []).slice();
        const at = new Map(merged.map((p, i) => [_tn(p && p.name), i]));
        players.forEach((p) => {
          if (!p || !_tn(p.name)) return;
          const i = at.get(_tn(p.name));
          if (i === undefined) { at.set(_tn(p.name), merged.length); merged.push(p); return; }
          const add = {};
          Object.keys(p).forEach((k) => { if (k !== 'id' && p[k] !== '' && p[k] != null) add[k] = p[k]; });
          merged[i] = { ...merged[i], ...add };
        });
        players = merged;
      }
    }

    // Did the producer REMOVE a crest (as opposed to saving a team that simply has none)? Only a
    // genuine removal is passed to the vault as a clear - see upsertFromLibrary's clearLogo.
    // Requires an explicit roster in the payload, which is what separates a full save from the
    // team EDITOR (always sends players) from a partial quick-save off the match panel (never
    // does). A quick-save on a side that happens to show no crest is not a removal.
    let logoCleared = false;
    // Did this save CHANGE the crest at all? Only then is it written to the vault. Every save used
    // to send the library row's logo along, so a stale library copy (a favourite toggle, a roster
    // edit) quietly overwrote a newer crest set in the vault and re-pinned the old one.
    let logoChanged = idx < 0 && !!logo;

    if (idx >= 0) {
      const prev = ctx.savedTeams[idx] || {};
      // msg.data.logoChanged: the match panel's quick-save marks a crest the producer actually
      // reset there, since it never carries the roster that otherwise marks a full editor save.
      logoCleared = logo !== undefined && !logo && !!prev.logo && (players !== null || msg.data.logoChanged === true);
      logoChanged = logo !== undefined && (logo || null) !== (prev.logo || null);
      // A player's in-roster name can be edited directly (a new in-game tag) — the player-profile
      // registry (verified start.gg/6mans/tracker.gg links, photo, country) is keyed purely by
      // normalized gamertag, so without migrating the key here a rename silently orphaned all of
      // that previously-verified data under the old, now-invisible tag: the player shows up
      // "unverified" again under their new one, with the old profile still sitting in the
      // registry, unreachable. Matched by player id (stable across an edit) so only a genuine
      // rename of the SAME roster slot migrates — not a totally different new player.
      if (players !== null && Array.isArray(prev.players)) {
        const prevById = new Map(prev.players.filter((p) => p && p.id).map((p) => [p.id, p]));
        players.forEach((p) => {
          if (!p || !p.id) return;
          const before = prevById.get(p.id);
          if (!before || !before.name || !p.name) return;
          const oldKey = before.name.trim().toLowerCase();
          const newKey = p.name.trim().toLowerCase();
          if (!oldKey || !newKey || oldKey === newKey) return;
          if (state.playerProfiles && Object.prototype.hasOwnProperty.call(state.playerProfiles, oldKey) && !state.playerProfiles[newKey]) {
            state.playerProfiles[newKey] = { ...state.playerProfiles[oldKey], gamerTag: p.name };
            delete state.playerProfiles[oldKey];
          }
        });
      }
      ctx.savedTeams[idx] = {
        ...prev,
        name: oldName ? name : (prev.name || name),
        logo: logo !== undefined ? logo : prev.logo,
        color: color !== undefined ? color : prev.color,
        ...(hasAbbr && { abbr }),
        // Preserve the existing roster unless an explicit players array was sent.
        players: players !== null ? players : (prev.players || []),
        ...(favorite !== undefined && { favorite }),
        // Saving/editing a From-organization team ADOPTS it as your own — drop the org tag so the
        // next org pull won't wipe your edits (a local same-named team wins over the org copy).
        _org: undefined, _orgOwner: undefined
      };
    } else {
      ctx.savedTeams.push({ name, logo: logo || null, color: color || null, ...(hasAbbr && { abbr }), players: players || [], ...(favorite !== undefined && { favorite }) });
    }

    // Explicit rename (oldName present, differs from the new name): cascade into every league
    // team-reference ({id, teamName}) that pointed at the old name, so leagues stay linked
    // instead of silently falling into lgResolveTeam's "unlinked" fallback. Also move any manual
    // team-record, which is deliberately keyed by team name so it "follows the team."
    if (oldName && _tn(oldName) !== _tn(name) && Array.isArray(state.leagues) && state.leagues.length) {
      let leaguesTouched = false;
      for (const lg of state.leagues) {
        for (const t of (lg.teams || [])) {
          if (t && t.teamName != null && _tn(t.teamName) === _tn(oldName)) { t.teamName = name; leaguesTouched = true; }
        }
      }
      if (leaguesTouched) ctx.leaguesVer++;
      const mb = state.teamRecord && state.teamRecord.manualByName;
      if (mb && Object.prototype.hasOwnProperty.call(mb, _tn(oldName))) {
        mb[_tn(name)] = mb[_tn(oldName)];
        delete mb[_tn(oldName)];
      }
      if (leaguesTouched) { refreshCompetitionFeed(); saveAppState(); }
    }
    // Same rename cascade, extended to Teams to Watch and Team Spotlight — both resolve a team's
    // logo (and Spotlight's seed-rank enrichment) by matching this frozen name string against the
    // Team Library at render time, so without this a rename silently broke that lookup: the
    // overlay fell back to the default game logo and the seeding enrichment stopped matching,
    // with no indication anything was wrong.
    if (oldName && _tn(oldName) !== _tn(name)) {
      if (state.watchlist && Array.isArray(state.watchlist.teams)) {
        state.watchlist.teams.forEach((wt) => { if (wt && _tn(wt.name) === _tn(oldName)) wt.name = name; });
      }
      if (state.teamSpotlight && _tn(state.teamSpotlight.name) === _tn(oldName)) {
        state.teamSpotlight.name = name;
      }
    }

    // Write the edit through to the permanent team vault and PIN it. This is the half of
    // "edit once, works at every future event" that the library alone can't do: teams.json is
    // matched on a name string and gets churned by the next import, while the vault keys on the
    // start.gg team id / aliases / roster and refuses to let an import overwrite a pinned field.
    if (state.teamVault && state.teamVault.enabled) {
      try {
        const row = ctx.savedTeams[idx >= 0 ? idx : ctx.savedTeams.length - 1] || {};
        const rec = teamDb.upsertFromLibrary({
          name: row.name || name,
          logo: logoChanged ? row.logo : undefined, color: row.color, abbr: row.abbr, favorite: row.favorite,
          startggTeamId: row.startggTeamId, startggSlug: row.startggSlug,
          players: row.players || [],
        }, { rename: oldName || null, source: 'library', clearLogo: logoCleared });
        if (rec) {
          row.vaultId = rec.id;
          // The library row is already current; carry the crest to event teams, the logo map
          // and the side on air so nothing still holding the old one can put it back.
          if (logoChanged || logoCleared) { propagateVaultCrest(rec); saveAppState(); }
          vaultTouch();
        }
      } catch (e) { console.warn('[TeamVault] save_team write-through failed:', e.message); }
    }

    // A tag edited here follows the team onto the side it is on right now (the side's tag came
    // from the library unless the card carried its own, which arrives in this same payload).
    if (hasAbbr) {
      ['blue', 'orange'].forEach((sd) => {
        const t = state.teams[sd];
        if (t && _tn(t.name) === _tn(name)) t.abbr = abbr || abbrForTeamName(t.name);
      });
      saveAppState();
    }

    saveTeams();
    broadcastFullState();
  },

  apply_saved_team(msg, ws) {
    const d = msg.data || {};
    const side = d.side === 'orange' ? 'orange' : 'blue';
    const src  = ctx.savedTeams.find(t => t.name === d.name);
    if (src && state.teams[side]) {
      if (src.name)   state.teams[side].name   = src.name;
      if (src.color)  state.teams[side].color  = src.color;
      if (src.logo !== undefined) state.teams[side].logo = src.logo;
      state.teams[side].abbr = cleanTeamAbbr(src.abbr) || abbrForTeamName(src.name);
      if (Array.isArray(src.players)) {
        state.teams[side].players = src.players.map((p, i) => ({
          id: p.id || (Date.now() + i),
          name: p.name || '',
          realName: p.realName || '',
          role: p.role || '',
          country: p.country || '',
          platform: p.platform || '',
          platformId: p.platformId || '',
          camSlot: p.camSlot || p.assignedCamera || '',
          startgg: p.startgg || '',
          sixmans: p.sixmans || '',
          status: p.status || 'starter',
          photo: p.photo || '',
          discord: p.discord || '',
          twitter: p.twitter || '',
          twitch: p.twitch || '',
          instagram: p.instagram || '',
          tiktok: p.tiktok || '',
          youtube: p.youtube || '',
        }));
      }
      retuneRoundLabel();   // producer swapped a side — the pushed set's round may no longer apply
      saveAppState();
      broadcastFullState();
    }
  },

  delete_team(msg, ws) {
    ctx.savedTeams = ctx.savedTeams.filter(t => t.name !== msg.data.name);
    saveTeams();
    broadcastFullState();
  },

  update_teams_order(msg, ws) {
    ctx.savedTeams = msg.data.teams || [];
    saveTeams();
    broadcastFullState();
  },

  add_player(msg, ws) {
    const { side, player } = msg.data || {};
    if (side && state.teams[side]) {
      if (!state.teams[side].players) state.teams[side].players = [];
      const newPlayer = { id: Math.random().toString(36).substr(2, 9), ...player };
      state.teams[side].players.push(newPlayer);
      persistRosterToLibrary(side);   // mirror to the saved-team library (create/update by name)

      saveAppState();
      broadcastFullState();
    }
  },

  edit_player(msg, ws) {
    const { side, playerId, playerData } = msg.data || {};
    if (side && state.teams[side]) {
      const player = findTeamPlayer(state.teams[side], playerId);
      if (player) {
        Object.assign(player, playerData);
        persistRosterToLibrary(side);   // mirror the edit to the saved-team library

        saveAppState();
        broadcastFullState();
      }
    }
  },

  delete_player(msg, ws) {
    const { side, playerId } = msg.data || {};
    if (side && state.teams[side]) {
      state.teams[side].players = state.teams[side].players?.filter(p => String(p.id) !== String(playerId)) || [];   // bulk delete sends ids as strings
      persistRosterToLibrary(side);   // mirror the removal to the saved-team library

      saveAppState();
      broadcastFullState();
    }
  },
};

module.exports = function createTeamHandlers(c) {
  ctx = c;
  ({
    abbrForTeamName, broadcastFullState, cleanTeamAbbr, findTeamPlayer, logoForTeamName,
    persistRosterToLibrary, pickAutoFollowSet, propagateVaultCrest, rebuildCombinedPlayers,
    refreshCompetitionFeed, retuneRoundLabel, saveAppState, saveTeams, state, teamDb,
    vaultTouch
  } = c);
  return handlers;
};
