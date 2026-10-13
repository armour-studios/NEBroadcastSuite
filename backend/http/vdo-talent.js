'use strict';
// VDO.Ninja talent links and QR codes — HTTP routes (moved out of server.js's startHttpServer; called at the same point, so
// route order is unchanged). Values server.js reassigns, or declares further down, are
// read and written through ctx (savedTeams).
let
  app, buildCasterJoinUrl, buildCasterObsUrl, buildDirectorUrl, buildListenInUrl,
  buildObsViewUrl, buildPlayerInterviewJoinUrl, buildPlayerInterviewViewUrl, buildRoomJoinUrl,
  buildRoomListenInUrl, buildTalentGroup, buildTalentJoinUrl, deskRoomVdo, ensureCasterVdo,
  ensureDirectorApiKey, ensureGuestsVdo, ensureObserversVdo, ensureTeamVdo, lanHost, lanSeats,
  playerStreamId, saveAppState, state, vdoBase, vdoSlug;
let ctx;

module.exports = function registerVdoTalentRoutes(c) {
  ctx = c;
  ({
    app, buildCasterJoinUrl, buildCasterObsUrl, buildDirectorUrl, buildListenInUrl,
    buildObsViewUrl, buildPlayerInterviewJoinUrl, buildPlayerInterviewViewUrl,
    buildRoomJoinUrl, buildRoomListenInUrl, buildTalentGroup, buildTalentJoinUrl, deskRoomVdo,
    ensureCasterVdo, ensureDirectorApiKey, ensureGuestsVdo, ensureObserversVdo, ensureTeamVdo,
    lanHost, lanSeats, playerStreamId, saveAppState, state, vdoBase, vdoSlug
  } = c);

  // ── VDO.Ninja talent links + local QR ────────────────────────────────────
  // Generate a QR locally (never sends the join URL — which carries the room password —
  // to any third-party service). <img src="/api/vdo/qr?text=<encoded join url>">
  app.get('/api/vdo/qr', (req, res) => {
    try {
      const text = req.query.text || '';
      if (!text) return res.status(400).send('text required');
      const QRCode = require('qrcode');
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'no-store');
      QRCode.toString(String(text), { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000ff', light: '#ffffffff' } },
        (err, svg) => { if (err) return res.status(500).send(err.message); res.send(svg); });
    } catch (e) { res.status(500).send(e.message); }
  });

  // Resolved talent links — active match teams (blue/orange) + all saved teams.
  app.get('/api/lan-seats/helper', (req, res) => {
    const ls = state.lanSeats || {};
    const seatId = String(req.query.seat || '');
    const seat = (ls.seats || []).find((x) => x.id === seatId);
    if (!seat || !ls.agent || !ls.agent.enabled || !ls.agent.token) return res.status(400).json({ ok: false, message: 'Turn on seat helpers first.' });
    const ps = lanSeats.helperScript({ producer: process.env.NE_LAN_AGENT_HOST || lanHost, port: ls.agent.port, token: ls.agent.token, seatId, seatLabel: seat.sideLabel + ' ' + seat.label, statsPort: 49123 });
    const enc = Buffer.from(ps, 'utf16le').toString('base64');
    const cmd = '@echo off\r\ntitle Seat helper\r\npowershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + enc + '\r\npause\r\n';
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="seat-helper-' + seatId + '.cmd"');
    res.send(cmd);
  });

  app.get('/api/vdo/links', (req, res) => {
    try {
      let mutated = false;
      // peek=1 (the panel's refresh pollers): read what exists, never create rooms or keys. Before
      // this, every 8s monitor tick could provision rooms the producer never asked for.
      const peek = String(req.query.peek || '') === '1';
      // Provision the production/interview (caster) room + director API key up front so the control
      // center always has a transfer target + IFrame-API key to work with. The interview room IS
      // the caster/production room.
      if (!peek && (!state.casters.vdo || !state.casters.vdo.room)) { ensureCasterVdo(); mutated = true; }
      if (!peek && !state.casters.apiKey) { ensureDirectorApiKey(); mutated = true; }
      const pack = (side) => {
        const team = state.teams[side];
        if (!team) return null;
        if (!peek && (!team.vdo || !team.vdo.room)) { ensureTeamVdo(team); mutated = true; }
        // peek with no room yet: say so instead of building links. The link builders below call
        // ensureTeamVdo themselves (provisioning a room behind peek's back), and with no players
        // team.vdo.room threw, 500-ing the whole response on a fresh install.
        if (peek && (!team.vdo || !team.vdo.room)) return { name: team.name, color: team.color, room: null, players: [], roomListenUrl: '', roomJoinUrl: '', directorUrl: '' };
        const players = (team.players || []).map((p) => ({
          playerId: p.id, name: p.name || '', primaryid: p.primaryid || '',
          streamId: playerStreamId(p),
          joinUrl: buildTalentJoinUrl(team, p),
          obsUrl:  buildObsViewUrl(team, p),
          listenUrl: buildListenInUrl(team, p),
          audio: p.vdoAudio || null,
          // Interview workflow: pushed into the dedicated interview room; view = solo desk feed.
          interviewUrl: buildPlayerInterviewJoinUrl(p),
          interviewViewUrl: buildPlayerInterviewViewUrl(p)
        }));
        return { name: team.name, color: team.color, room: team.vdo.room, players,
          roomListenUrl: buildRoomListenInUrl(team), roomJoinUrl: buildRoomJoinUrl(team), directorUrl: buildDirectorUrl(team.vdo) };
      };
      // All saved teams — only include per-player links if the team already has a VDO room
      // (don't auto-provision here; explicit "generate" action does that).
      const allTeams = ctx.savedTeams.map((team) => {
        const hasRoom = !!(team.vdo && team.vdo.room && team.vdo.password);
        if (!hasRoom) return { name: team.name, color: team.color || null, room: null, hasRoom: false, players: [] };
        const players = (team.players || []).map((p) => ({
          playerId: p.id, name: p.name || '', primaryid: p.primaryid || '',
          streamId: playerStreamId(p),
          joinUrl: buildTalentJoinUrl(team, p),
          obsUrl:  buildObsViewUrl(team, p),
          listenUrl: buildListenInUrl(team, p),
          audio: p.vdoAudio || null,
          // Interview workflow: join the caster room for an on-desk interview, view = desk feed.
          interviewUrl: buildPlayerInterviewJoinUrl(p),
          interviewViewUrl: buildPlayerInterviewViewUrl(p)
        }));
        return { name: team.name, color: team.color || null, room: team.vdo.room, hasRoom: true, players };
      });
      const deskVdo = deskRoomVdo() || { room: '', password: '' };
      const prodRoom = { room: deskVdo.room || '', directorUrl: (deskVdo.room && deskVdo.password) ? buildDirectorUrl(deskVdo) : '' };
      const out = { ok: true, base: vdoBase(), lang: state.vdo?.lang || 'en-US',
        teams: { blue: pack('blue'), orange: pack('orange') }, allTeams,
        // Director control center: one API key for every embedded console; per-room director URLs.
        apiKey: ensureDirectorApiKey(),
        // The interview room IS the production/caster room — expose both keys pointing at it so
        // older client refs keep working.
        casterRoom: prodRoom,
        interview: prodRoom,
        // Named caster rooms also get a director console.
        namedRooms: (state.casters.rooms || []).filter(r => r.vdo && r.vdo.room).map(r => ({
          id: r.id, name: r.name, room: r.vdo.room, directorUrl: buildDirectorUrl(r.vdo)
        })) };

      // Three shared talent-group rooms (Casters / Guests / Observers), members from the library by
      // kind. Auto-provision a group's room as soon as it has a member so the Director can see it.
      const lib = state.casters.library || [];
      const casterMembers = lib.filter(p => p.kind !== 'host' && p.kind !== 'observer');
      const guestMembers  = lib.filter(p => p.kind === 'host');
      const obsMembers    = lib.filter(p => p.kind === 'observer');
      if (!peek && casterMembers.length && (!state.casters.vdo || !state.casters.vdo.room)) { ensureCasterVdo(); mutated = true; }
      if (!peek && guestMembers.length  && (!state.casters.guestsVdo || !state.casters.guestsVdo.room)) { ensureGuestsVdo(); mutated = true; }
      if (!peek && obsMembers.length    && (!state.casters.observersVdo || !state.casters.observersVdo.room)) { ensureObserversVdo(); mutated = true; }
      // The casters group is the "Hosts" desk (room = state.casters.vdo, no separate interview/desk);
      // Guests and Observers each keep their own shared room.
      out.groups = {
        casters:   buildTalentGroup('HOSTS',     '#e83a8b', state.casters.vdo,           casterMembers),
        guests:    buildTalentGroup('LOBBY',     '#a855f7', state.casters.guestsVdo,      guestMembers),
        observers: buildTalentGroup('OBSERVERS', '#2dd4bf', state.casters.observersVdo,   obsMembers),
      };

      if (mutated) saveAppState();
      res.json(out);
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });

  // Resolved caster VDO links — shared caster room + per-caster join/obs URLs.
  app.get('/api/vdo/caster-links', (req, res) => {
    try {
      const vdo = state.casters?.vdo;
      const hasRoom = !!(vdo && vdo.room && vdo.password);
      const casters = (state.casters?.list || []).map((c) => {
        const sid = vdoSlug(c.streamId || c.handle || c.name || 'caster');
        return {
          id: c.id, name: c.name || '', handle: c.handle || '', streamId: sid,
          joinUrl: hasRoom ? buildCasterJoinUrl(c) : '',
          obsUrl:  hasRoom ? buildCasterObsUrl(c) : ''
        };
      });
      res.json({ ok: true, hasRoom, room: hasRoom ? vdo.room : null, casters });
    } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
  });
};
