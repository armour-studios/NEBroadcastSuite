'use strict';
// Nameless cloud: profiles, org library, seats, rooms, stations — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly; values server.js reassigns are
// read and written through ctx (leaguesVer).
let
  AdmZip, applyProfileBundle, broadcastFullState, buildLeaguePushPayload, buildProfileBundle,
  cloud, deskRoomVdo, dialog, extractAssetsToZip, fsp, inflateAssetsFromZip, mergePulledLeague,
  pullOrgLibrary, pushProfileNow, saveAppState, saveDiscordUser, sendImportExportResult,
  sendStationsFull, state, syncCrewRosterToCloud, syncProfileToCloud, vdoRandom;
let ctx;

const handlers = {
  // Station list for the binding picker (Camera Feeds ▸ Cloud Stations) — plus the FULL
  // cockpit for the bound (or only) station, with all its invite links pre-built, so the
  // producer can hand out caster/observer/player/match links without opening the website.
  cloud_list_stations(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { ws.send(JSON.stringify({ type: 'cloud_stations', data: { ok: false, stations: [] } })); return; }
        const orgId = msg.data && msg.data.orgId;
        if (!orgId) { ws.send(JSON.stringify({ type: 'cloud_stations', data: { ok: false, stations: [] } })); return; }
        const all = await cloud.listStations(orgId);
        const stations = all.filter((s) => s.status === 'active');
        const SITE = (process.env.BROADCAST_REMOTE_URL || 'https://studio.namelessesports.com').replace(/\/+$/, '');
        const detailId = (state.casters && state.casters.stationId) || (stations.length === 1 ? stations[0].id : '');
        let detail = null;
        if (detailId && stations.some((s) => s.id === detailId)) {
          try {
            const d = await cloud.getStation(orgId, detailId);
            const st = d.station || {};
            detail = {
              stationId: detailId,
              stationName: st.name || '',
              rooms: (st.rooms || []).filter((r) => r && r.status === 'active').map((r) => ({
                id: r.id, kind: r.kind, name: r.name,
                // The real VDO room name, so the panel's director consoles (and drag-to-room
                // transfers) target the room the casters actually joined.
                vdoRoom: r.roomBase || '',
                slots: (r.slots || []).length,
                connected: (r.slots || []).filter((x) => x && x.enabled && x.connectedAt).length,
                inviteUrl: `${SITE}/station/${r.shareToken}`,
                talkbackUrl: `${SITE}/station/${r.shareToken}?producer=1`,
                // Director console for the WEBSITE's shared room — lets the app's Show Deck
                // monitor and adjust (mute/kick/volume) the room the casters actually joined.
                monitorUrl: r.roomBase ? `https://vdo.ninja/?director=${encodeURIComponent(r.roomBase)}${r.password ? `#p=${encodeURIComponent(r.password)}` : ''}` : '',
              })),
              cameras: (d.cameraSessions || []).filter((c) => c && c.status === 'active').map((c) => ({
                id: c.id, name: c.name,
                slots: (c._count && c._count.slots) || 0,
                shareUrl: `${SITE}/cameras/${c.shareToken}`,
              })),
              matches: (d.matches || []).map((m) => ({
                id: m.id,
                label: `${(m.teamA && m.teamA.name) || 'Team A'} vs ${(m.teamB && m.teamB.name) || 'Team B'}`,
                joinUrl: `${SITE}/join/${m.id}`,
                matchUrl: `${SITE}/match/${m.id}`,
              })),
            };
          } catch (_) { /* detail is a nicety — the list alone still renders */ }
        }
        ws.send(JSON.stringify({ type: 'cloud_stations', data: { ok: true, stations, detail } }));
      } catch (e) { ws.send(JSON.stringify({ type: 'cloud_stations', data: { ok: false, stations: [], message: e.message } })); }
    })();
  },

  // ── Producer profile (portable .zip — teams/brands/facecams/presets/leagues/casters/settings) ──
  // The one consolidated export/import for everything non-game-specific. Packaged as a zip
  // (manifest.json + real image files under assets/) via extractAssetsToZip/inflateAssetsFromZip
  // so images and data travel together in one shareable file — supersedes the old separate
  // teams+facecams-only export_data/import_data zip, which has been retired.
  export_profile(msg, ws) {
    const zip = new AdmZip();
    const manifest = extractAssetsToZip(buildProfileBundle(), zip);
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
    dialog.showSaveDialog({
      title: 'Export Producer Profile',
      defaultPath: 'NE-Broadcast-Profile.zip',
      filters: [{ name: 'NE Broadcast Profile', extensions: ['zip'] }]
    }).then(({ canceled, filePath }) => {
      if (canceled || !filePath) { sendImportExportResult(ws, false, 'Export cancelled.'); return; }
      try { zip.writeZip(filePath); sendImportExportResult(ws, true, 'Profile exported — safe to share (no passwords or tokens included).'); }
      catch (e) { sendImportExportResult(ws, false, 'Export failed: ' + e.message); }
    });
  },

  import_profile(msg, ws) {
    (async () => {
      try {
        let filePath = msg.data && msg.data.path;
        if (!filePath) {
          const r = await dialog.showOpenDialog({
            title: 'Import Producer Profile',
            filters: [{ name: 'NE Broadcast Profile', extensions: ['zip', 'json'] }],
            properties: ['openFile']
          });
          if (r.canceled || !r.filePaths || !r.filePaths[0]) { sendImportExportResult(ws, false, 'Import cancelled.'); return; }
          filePath = r.filePaths[0];
        }
        const raw = await fsp.readFile(filePath);
        let bundle;
        if (filePath.toLowerCase().endsWith('.json')) {
          // Legacy pre-zip export — plain JSON with images already inline as base64.
          bundle = JSON.parse(raw.toString('utf8'));
        } else {
          const zip = new AdmZip(raw);
          const manifestEntry = zip.getEntry('manifest.json');
          if (!manifestEntry) throw new Error('Not a valid NE Broadcast Profile file (missing manifest.json).');
          bundle = inflateAssetsFromZip(JSON.parse(manifestEntry.getData().toString('utf8')), zip);
        }
        const summary = applyProfileBundle(bundle, msg.data && msg.data.options);
        sendImportExportResult(ws, true, summary + '.');
        broadcastFullState();
      } catch (e) {
        sendImportExportResult(ws, false, 'Import failed: ' + e.message);
      }
    })();
  },

  // ── Cloud profile sync (Nameless backend) — dormant until BROADCAST_REMOTE_URL is set ──
  cloud_status(msg, ws) {
    ws.send(JSON.stringify({ type: 'cloud_status', data: cloud.getSession() }));
  },

  cloud_list_profiles(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { ws.send(JSON.stringify({ type: 'cloud_profiles', data: { ok: false, message: cloud.configured() ? 'Sign in to the cloud first.' : 'Cloud sync not available yet.', profiles: [] } })); return; }
        ws.send(JSON.stringify({ type: 'cloud_profiles', data: { ok: true, profiles: await cloud.listProfiles() } }));
      } catch (e) { ws.send(JSON.stringify({ type: 'cloud_profiles', data: { ok: false, message: e.message, profiles: [] } })); }
    })();
  },

  cloud_push_profile(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { sendImportExportResult(ws, false, cloud.configured() ? 'Sign in to the cloud first.' : 'Cloud sync not available yet.'); return; }
        const saved = await cloud.saveProfile(buildProfileBundle(), { id: msg.data && msg.data.id, name: (msg.data && msg.data.name) || 'My Profile' });
        sendImportExportResult(ws, true, 'Profile synced to cloud.');
        ws.send(JSON.stringify({ type: 'cloud_profile_saved', data: saved }));
      } catch (e) { sendImportExportResult(ws, false, 'Cloud sync failed: ' + e.message); }
    })();
  },

  cloud_pull_profile(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { sendImportExportResult(ws, false, cloud.configured() ? 'Sign in to the cloud first.' : 'Cloud sync not available yet.'); return; }
        const res = await cloud.getProfile(msg.data && msg.data.id);
        const summary = applyProfileBundle(res.bundle || res, msg.data && msg.data.options);
        sendImportExportResult(ws, true, summary + ' (from cloud).');
        broadcastFullState();
      } catch (e) { sendImportExportResult(ws, false, 'Cloud load failed: ' + e.message); }
    })();
  },

  // Share/unshare a pushed profile (teams, brand kits, presets, etc.) with the producer's
  // whole broadcast org — cloud.shareProfile already existed (built for the website's own
  // "Share with my team" toggle) but was never wired to a WS handler, so the desktop app had
  // no way to do this itself; a producer had to go to the website separately.
  cloud_share_profile(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { sendImportExportResult(ws, false, 'Sign in to the cloud first.', 'profile-share'); return; }
        const id = msg.data && msg.data.id;
        const scope = (msg.data && msg.data.scope === 'workspace') ? 'workspace' : 'private';
        if (!id) { sendImportExportResult(ws, false, 'Sync to cloud first, then share.', 'profile-share'); return; }
        const res = await cloud.shareProfile(id, scope);
        sendImportExportResult(ws, true, scope === 'workspace' ? 'Shared with your organization.' : 'No longer shared with your organization.', 'profile-share');
        ws.send(JSON.stringify({ type: 'cloud_profile_shared', data: res }));
        ws.send(JSON.stringify({ type: 'cloud_profiles', data: { ok: true, profiles: await cloud.listProfiles() } }));
      } catch (e) { sendImportExportResult(ws, false, 'Share failed: ' + e.message, 'profile-share'); }
    })();
  },

  // ── Org broadcast-seat management (licensing) — owner/admin only, server-side
  // gated by the backend's canManageStaff() check; these are thin passthroughs. ──
  cloud_list_org_seats(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { ws.send(JSON.stringify({ type: 'cloud_org_seats', data: { ok: false, message: 'Sign in to the cloud first.', seats: [] } })); return; }
        const orgId = msg.data && msg.data.orgId;
        if (!orgId) { ws.send(JSON.stringify({ type: 'cloud_org_seats', data: { ok: false, message: 'No organization workspace.', seats: [] } })); return; }
        const res = await cloud.listOrgSeats(orgId);
        ws.send(JSON.stringify({ type: 'cloud_org_seats', data: { ok: true, ...res } }));
      } catch (e) { ws.send(JSON.stringify({ type: 'cloud_org_seats', data: { ok: false, message: e.message, seats: [] } })); }
    })();
  },

  cloud_add_org_seat(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { sendImportExportResult(ws, false, 'Sign in to the cloud first.', 'org-seats'); return; }
        const d = msg.data || {};
        if (!d.orgId || !d.userId || !d.role) { sendImportExportResult(ws, false, 'orgId, userId, and role are required.', 'org-seats'); return; }
        await cloud.addOrgSeat(d.orgId, { userId: d.userId, role: d.role });
        sendImportExportResult(ws, true, 'Seat granted.', 'org-seats');
      } catch (e) { sendImportExportResult(ws, false, 'Add seat failed: ' + e.message, 'org-seats'); }
    })();
  },

  cloud_remove_org_seat(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { sendImportExportResult(ws, false, 'Sign in to the cloud first.', 'org-seats'); return; }
        const d = msg.data || {};
        if (!d.orgId || !d.seatId) { sendImportExportResult(ws, false, 'orgId and seatId are required.', 'org-seats'); return; }
        await cloud.removeOrgSeat(d.orgId, d.seatId);
        sendImportExportResult(ws, true, 'Seat revoked.', 'org-seats');
      } catch (e) { sendImportExportResult(ws, false, 'Revoke seat failed: ' + e.message, 'org-seats'); }
    })();
  },

  // Website-hosted camera-session feeds (masked VDO join links, see /cameras/[token]
  // on the website) — thin passthrough so _pcamSources() can add them as a facecam group.
  cloud_list_camera_feeds(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { ws.send(JSON.stringify({ type: 'cloud_camera_feeds', data: { ok: false, message: 'Sign in to the cloud first.', feeds: [] } })); return; }
        const orgId = msg.data && msg.data.orgId;
        if (!orgId) { ws.send(JSON.stringify({ type: 'cloud_camera_feeds', data: { ok: false, message: 'No organization workspace.', feeds: [] } })); return; }
        const feeds = await cloud.listCameraFeeds(orgId);
        ws.send(JSON.stringify({ type: 'cloud_camera_feeds', data: { ok: true, feeds } }));
      } catch (e) { ws.send(JSON.stringify({ type: 'cloud_camera_feeds', data: { ok: false, message: e.message, feeds: [] } })); }
    })();
  },

  // Website-hosted Stations caster/observer VDO feeds (see /studio/access/stations on the
  // website) — thin passthrough so Camera Feeds can list them and the caster lineup can pull
  // caster-kind ones into the library, same pattern as cloud_list_camera_feeds above.
  cloud_list_station_feeds(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { ws.send(JSON.stringify({ type: 'cloud_station_feeds', data: { ok: false, message: 'Sign in to the cloud first.', feeds: [], shared: [] } })); return; }
        const orgId = msg.data && msg.data.orgId;
        if (!orgId) { ws.send(JSON.stringify({ type: 'cloud_station_feeds', data: { ok: false, message: 'No organization workspace.', feeds: [], shared: [] } })); return; }
        const { feeds, shared } = await cloud.listStationFeeds(orgId);
        ws.send(JSON.stringify({ type: 'cloud_station_feeds', data: { ok: true, feeds, shared } }));
        // Producer is working with stations → make sure the org's join pages have the current
        // crew roster to offer, even if no crew edit happened since sign-in.
        syncCrewRosterToCloud();
      } catch (e) { ws.send(JSON.stringify({ type: 'cloud_station_feeds', data: { ok: false, message: e.message, feeds: [], shared: [] } })); }
    })();
  },

  // Website league sync (bidirectional, opt-in per league — see CompeteLeague on the website).
  // Push is producer-triggered and full-replace (mirrors saveProfile's id-absent/id-present
  // branch); pull is additive/non-destructive (mergePulledLeague, mergeAtTop philosophy).
  cloud_push_league(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { sendImportExportResult(ws, false, cloud.configured() ? 'Sign in to the cloud first.' : 'Cloud sync not available yet.', 'league'); return; }
        const orgId = msg.data && msg.data.orgId;
        const leagueId = msg.data && msg.data.leagueId;
        if (!orgId) { sendImportExportResult(ws, false, 'No organization workspace — leagues can only sync from an org.', 'league'); return; }
        const lg = (state.leagues || []).find((l) => l.id === leagueId);
        if (!lg) { sendImportExportResult(ws, false, 'League not found.', 'league'); return; }
        const payload = buildLeaguePushPayload(lg);
        if (!payload) { sendImportExportResult(ws, false, `"${lg.name}" comes from the Nameless website — it is read-only here, so there is nothing to push.`, 'league'); return; }
        const saved = await cloud.pushLeague(orgId, payload);
        if (saved && saved.id) { lg.cloudLeagueId = saved.id; ctx.leaguesVer++; saveAppState(); broadcastFullState(); }
        sendImportExportResult(ws, true, `"${lg.name}" synced to the website.`, 'league');
      } catch (e) { sendImportExportResult(ws, false, 'Sync failed: ' + e.message, 'league'); }
    })();
  },

  cloud_list_leagues(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { ws.send(JSON.stringify({ type: 'cloud_leagues', data: { ok: false, message: 'Sign in to the cloud first.', leagues: [] } })); return; }
        const orgId = msg.data && msg.data.orgId;
        if (!orgId) { ws.send(JSON.stringify({ type: 'cloud_leagues', data: { ok: false, message: 'No organization workspace.', leagues: [] } })); return; }
        const leagues = await cloud.listCloudLeagues(orgId);
        ws.send(JSON.stringify({ type: 'cloud_leagues', data: { ok: true, leagues } }));
      } catch (e) { ws.send(JSON.stringify({ type: 'cloud_leagues', data: { ok: false, message: e.message, leagues: [] } })); }
    })();
  },

  cloud_pull_league(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { sendImportExportResult(ws, false, 'Sign in to the cloud first.', 'league'); return; }
        const orgId = msg.data && msg.data.orgId;
        const leagueId = msg.data && msg.data.leagueId;
        if (!orgId || !leagueId) { sendImportExportResult(ws, false, 'orgId and leagueId are required.', 'league'); return; }
        const cloudLg = await cloud.pullLeague(orgId, leagueId);
        const summary = mergePulledLeague(cloudLg);
        sendImportExportResult(ws, true, summary + ' (from the website).', 'league');
        broadcastFullState();
      } catch (e) { sendImportExportResult(ws, false, 'Pull failed: ' + e.message, 'league'); }
    })();
  },

  // ── Org Library two-way sync controls ────────────────────────────────────
  cloud_set_autosync(msg, ws) {
    state.orgLibrary.autoSync = !!(msg.data && msg.data.on);
    saveAppState();
    broadcastFullState();
    if (state.orgLibrary.autoSync) syncProfileToCloud();
  },

  cloud_pull_org_library(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { sendImportExportResult(ws, false, 'Sign in to the cloud first.', 'org-library'); return; }
        // force: a producer clicking Pull Now is usually doing it BECAUSE something looks wrong,
        // so bypass the rev cache entirely rather than answering "nothing changed".
        const res = await pullOrgLibrary({ force: true });
        if (res.error) { sendImportExportResult(ws, false, 'Pull failed: ' + res.error, 'org-library'); return; }
        sendImportExportResult(ws, true, `Org library synced — ${res.orgTeams || 0} teams, ${res.orgKits || 0} brand kits from your organization.`, 'org-library');
      } catch (e) { sendImportExportResult(ws, false, 'Pull failed: ' + e.message, 'org-library'); }
    })();
  },

  cloud_push_org_library(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { sendImportExportResult(ws, false, 'Sign in to the cloud first.', 'org-library'); return; }
        const res = await pushProfileNow();
        broadcastFullState();
        sendImportExportResult(ws, true, res.isOrg ? 'Your teams & brand kits are shared with the organization.' : 'Your teams & brand kits are synced to the cloud (join an organization to share them with other producers).', 'org-library');
      } catch (e) { sendImportExportResult(ws, false, 'Push failed: ' + e.message, 'org-library'); }
    })();
  },

  // ── In-app invite-link minting (the website's create routes, driven from the app) ─────
  // Every handler needs a real org workspace; each replies with a `cloud_invite_created` carrying
  // the ready-to-share public URL so the panel can show it with copy + QR.
  cloud_create_room(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { sendImportExportResult(ws, false, 'Sign in to the cloud first.', 'invite'); return; }
        const s = cloud.getSession() || {};
        const orgId = s.workspaceId;
        if (!orgId || String(orgId).startsWith('user:')) { sendImportExportResult(ws, false, 'Invite links need an organization workspace.', 'invite'); return; }
        const d = msg.data || {};
        const kind = d.kind === 'observer' ? 'observer' : 'caster';
        const station = await cloud.ensureStation(orgId, d.stationName);
        if (!station || !station.id) { sendImportExportResult(ws, false, 'Could not resolve a station for the room.', 'invite'); return; }
        const room = await cloud.createStationRoom(orgId, station.id, { kind, name: d.name, slotCount: d.slotCount });
        sendImportExportResult(ws, true, (kind === 'caster' ? 'Caster room' : 'Observer feeds') + ' link ready.', 'invite');
        ws.send(JSON.stringify({ type: 'cloud_invite_created', data: { ok: true, kind: 'room', roomKind: kind, url: room.url, name: room.name || '', shareToken: room.shareToken, slots: (room.slots || []).length } }));
      } catch (e) { sendImportExportResult(ws, false, 'Link failed: ' + e.message, 'invite'); }
    })();
  },

  cloud_create_camera_session(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { sendImportExportResult(ws, false, 'Sign in to the cloud first.', 'invite'); return; }
        const s = cloud.getSession() || {};
        const orgId = s.workspaceId;
        if (!orgId || String(orgId).startsWith('user:')) { sendImportExportResult(ws, false, 'Invite links need an organization workspace.', 'invite'); return; }
        const d = msg.data || {};
        const session = await cloud.createCameraSession(orgId, { name: d.name || state.eventName || 'Camera assignments', startggSlug: d.startggSlug });
        sendImportExportResult(ws, true, 'Camera-assignment link ready.', 'invite');
        ws.send(JSON.stringify({ type: 'cloud_invite_created', data: { ok: true, kind: 'camera', url: session.url, name: session.name || '', shareToken: session.shareToken, slots: (session.slots || []).length } }));
      } catch (e) { sendImportExportResult(ws, false, 'Link failed: ' + e.message, 'invite'); }
    })();
  },

  cloud_create_match(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { sendImportExportResult(ws, false, 'Sign in to the cloud first.', 'invite'); return; }
        const d = msg.data || {};
        const pick = (t, fallback) => {
          if (t && (t.name || t.players)) return { name: t.name || fallback, logo: t.logo || null, color: t.color || null, players: Array.isArray(t.players) ? t.players.map((p) => ({ name: p.name || p.gamertag || '' })).filter((p) => p.name) : [] };
          return { name: fallback, logo: null, color: null, players: [] };
        };
        const teamA = pick(d.teamA || (state.teams && state.teams.blue), 'Team A');
        const teamB = pick(d.teamB || (state.teams && state.teams.orange), 'Team B');
        const match = await cloud.createMatch({ teamA, teamB, game: d.game || state.activeGame || '' });
        sendImportExportResult(ws, true, 'Team match join link ready — one link for both teams.', 'invite');
        ws.send(JSON.stringify({ type: 'cloud_invite_created', data: { ok: true, kind: 'match', url: match.url, matchUrl: match.matchUrl, id: match.id, expiresAt: match.expiresAt, teamA: teamA.name, teamB: teamB.name } }));
      } catch (e) { sendImportExportResult(ws, false, 'Link failed: ' + e.message, 'invite'); }
    })();
  },

  cloud_create_talent_invite(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { sendImportExportResult(ws, false, 'Sign in to the cloud first.', 'invite'); return; }
        const d = msg.data || {};
        // No room given: the caster DESK room (with its password), which the app monitors and the
        // desk overlays view. A random room used to be minted here that nothing ever watched.
        const desk = (!d.room && typeof deskRoomVdo === 'function') ? (deskRoomVdo() || {}) : {};
        const room = d.room || desk.room || ('ne' + vdoRandom(9));
        const password = d.password || (!d.room ? desk.password : '') || '';
        const invite = await cloud.createTalentInvite({ room, password, role: d.role || 'talent', roomTitle: d.roomTitle || state.eventName || '', name: d.name || '', teamLabel: d.teamLabel || '', ttlHours: d.ttlHours });
        sendImportExportResult(ws, true, 'Talent invite link ready.', 'invite');
        ws.send(JSON.stringify({ type: 'cloud_invite_created', data: { ok: true, kind: 'talent', url: invite.url, token: invite.token, expiresAt: invite.expiresAt, role: d.role || 'talent' } }));
      } catch (e) { sendImportExportResult(ws, false, 'Link failed: ' + e.message, 'invite'); }
    })();
  },

  // ── Stations manager (full CRUD on the org's website stations) ────────────
  // Each mutation runs the website route via cloud-client, toasts, then re-pushes the full nested
  // list so the panel re-renders. orgId comes from the session; the panel never sends it.
  cloud_stations_full(msg, ws) {
    (async () => { await sendStationsFull(ws, msg); })();
  },

  cloud_station_create(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { sendImportExportResult(ws, false, 'Sign in to the cloud first.', 'station'); return; }
        const orgId = (cloud.getSession() || {}).workspaceId;
        if (!orgId || String(orgId).startsWith('user:')) { sendImportExportResult(ws, false, 'Stations need an organization workspace.', 'station'); return; }
        await cloud.createStation(orgId, { name: (msg.data && msg.data.name) || 'Untitled station' });
        sendImportExportResult(ws, true, 'Station created.', 'station');
        await sendStationsFull(ws, msg);
      } catch (e) { sendImportExportResult(ws, false, 'Create failed: ' + e.message, 'station'); }
    })();
  },

  cloud_station_patch(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { sendImportExportResult(ws, false, 'Sign in to the cloud first.', 'station'); return; }
        const orgId = (cloud.getSession() || {}).workspaceId; const d = msg.data || {};
        if (!d.stationId) { sendImportExportResult(ws, false, 'stationId required.', 'station'); return; }
        await cloud.patchStation(orgId, d.stationId, d.patch || {});
        sendImportExportResult(ws, true, 'Station updated.', 'station');
        await sendStationsFull(ws, msg);
      } catch (e) { sendImportExportResult(ws, false, 'Update failed: ' + e.message, 'station'); }
    })();
  },

  cloud_station_delete(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { sendImportExportResult(ws, false, 'Sign in to the cloud first.', 'station'); return; }
        const orgId = (cloud.getSession() || {}).workspaceId; const d = msg.data || {};
        if (!d.stationId) { sendImportExportResult(ws, false, 'stationId required.', 'station'); return; }
        await cloud.deleteStation(orgId, d.stationId);
        sendImportExportResult(ws, true, 'Station deleted.', 'station');
        await sendStationsFull(ws, msg);
      } catch (e) { sendImportExportResult(ws, false, 'Delete failed: ' + e.message, 'station'); }
    })();
  },

  cloud_room_create(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { sendImportExportResult(ws, false, 'Sign in to the cloud first.', 'station'); return; }
        const orgId = (cloud.getSession() || {}).workspaceId; const d = msg.data || {};
        if (!d.stationId) { sendImportExportResult(ws, false, 'stationId required.', 'station'); return; }
        await cloud.createStationRoom(orgId, d.stationId, { kind: d.kind === 'observer' ? 'observer' : 'caster', name: d.name, slotCount: d.slotCount });
        sendImportExportResult(ws, true, (d.kind === 'observer' ? 'Observer' : 'Caster') + ' room added.', 'station');
        await sendStationsFull(ws, msg);
      } catch (e) { sendImportExportResult(ws, false, 'Add room failed: ' + e.message, 'station'); }
    })();
  },

  cloud_room_patch(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { sendImportExportResult(ws, false, 'Sign in to the cloud first.', 'station'); return; }
        const orgId = (cloud.getSession() || {}).workspaceId; const d = msg.data || {};
        if (!d.stationId || !d.roomId) { sendImportExportResult(ws, false, 'stationId and roomId required.', 'station'); return; }
        await cloud.patchRoom(orgId, d.stationId, d.roomId, d.patch || {});
        sendImportExportResult(ws, true, 'Room updated.', 'station');
        await sendStationsFull(ws, msg);
      } catch (e) { sendImportExportResult(ws, false, 'Update failed: ' + e.message, 'station'); }
    })();
  },

  cloud_room_delete(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { sendImportExportResult(ws, false, 'Sign in to the cloud first.', 'station'); return; }
        const orgId = (cloud.getSession() || {}).workspaceId; const d = msg.data || {};
        if (!d.stationId || !d.roomId) { sendImportExportResult(ws, false, 'stationId and roomId required.', 'station'); return; }
        await cloud.deleteRoom(orgId, d.stationId, d.roomId);
        sendImportExportResult(ws, true, 'Room deleted.', 'station');
        await sendStationsFull(ws, msg);
      } catch (e) { sendImportExportResult(ws, false, 'Delete failed: ' + e.message, 'station'); }
    })();
  },

  cloud_slot_add(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { sendImportExportResult(ws, false, 'Sign in to the cloud first.', 'station'); return; }
        const orgId = (cloud.getSession() || {}).workspaceId; const d = msg.data || {};
        if (!d.stationId || !d.roomId) { sendImportExportResult(ws, false, 'stationId and roomId required.', 'station'); return; }
        await cloud.addRoomSlot(orgId, d.stationId, d.roomId);
        sendImportExportResult(ws, true, 'Slot added.', 'station');
        await sendStationsFull(ws, msg);
      } catch (e) { sendImportExportResult(ws, false, 'Add slot failed: ' + e.message, 'station'); }
    })();
  },

  cloud_slot_patch(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { sendImportExportResult(ws, false, 'Sign in to the cloud first.', 'station'); return; }
        const orgId = (cloud.getSession() || {}).workspaceId; const d = msg.data || {};
        if (!d.stationId || !d.roomId || !d.slotId) { sendImportExportResult(ws, false, 'stationId, roomId and slotId required.', 'station'); return; }
        await cloud.patchRoomSlot(orgId, d.stationId, d.roomId, d.slotId, d.patch || {});
        sendImportExportResult(ws, true, 'Placement updated.', 'station');
        await sendStationsFull(ws, msg);
      } catch (e) { sendImportExportResult(ws, false, 'Update failed: ' + e.message, 'station'); }
    })();
  },

  cloud_slot_delete(msg, ws) {
    (async () => {
      try {
        if (!cloud.authed()) { sendImportExportResult(ws, false, 'Sign in to the cloud first.', 'station'); return; }
        const orgId = (cloud.getSession() || {}).workspaceId; const d = msg.data || {};
        if (!d.stationId || !d.roomId || !d.slotId) { sendImportExportResult(ws, false, 'stationId, roomId and slotId required.', 'station'); return; }
        await cloud.deleteRoomSlot(orgId, d.stationId, d.roomId, d.slotId);
        sendImportExportResult(ws, true, 'Placement removed.', 'station');
        await sendStationsFull(ws, msg);
      } catch (e) { sendImportExportResult(ws, false, 'Remove failed: ' + e.message, 'station'); }
    })();
  },

  cloud_email_login(msg, ws) {
    (async () => {
      try {
        const d = msg.data || {};
        const data = await cloud.loginWithEmail({ email: (d.email || '').trim(), password: d.password || '' });
        const cu = (data && data.user) || {};
        state.discord.connected = true;
        state.discord.userId = cu.discordId || '';
        state.discord.username = cu.username || (d.email || '').split('@')[0];
        state.discord.discriminator = '0';
        state.discord.globalName = cu.globalName || cu.username || (d.email || '').split('@')[0];
        state.discord.avatarUrl = cu.avatarUrl || 'https://cdn.discordapp.com/embed/avatars/0.png';
        saveDiscordUser();
        broadcastFullState();
        setTimeout(() => { syncProfileToCloud(); pullOrgLibrary().catch(() => {}); }, 1500);   // sync existing library up + pull org library down on sign-in
        ws.send(JSON.stringify({ type: 'cloud-email-login', data: { ok: true, message: 'Signed in as ' + state.discord.globalName } }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'cloud-email-login', data: { ok: false, message: (e && e.message) || 'Login failed' } }));
      }
    })();
  },
};

module.exports = function createCloudHandlers(c) {
  ctx = c;
  ({
    AdmZip, applyProfileBundle, broadcastFullState, buildLeaguePushPayload, buildProfileBundle,
    cloud, deskRoomVdo, dialog, extractAssetsToZip, fsp, inflateAssetsFromZip,
    mergePulledLeague, pullOrgLibrary, pushProfileNow, saveAppState, saveDiscordUser,
    sendImportExportResult, sendStationsFull, state, syncCrewRosterToCloud, syncProfileToCloud,
    vdoRandom
  } = c);
  return handlers;
};
