/* ─── camera-feeds.js — Camera Feeds / VDO talent domain (cf*, vdo*: Talent ────
   Rooms, VDO rooms manager, Director Control Center consoles + room moves,
   Match Control team cards, listen-in pill, VDO.ninja settings + view/push
   link builders, talent group cards, gameplay screenshare + stream stations).
   Extracted verbatim from app.js (2026-07). Loads after app.js; inbound calls
   (cfShowSubtab/cfUpdateListenPill/cfLoadGroups/cfLoadTalent/renderCfStreamStations/
   …) are all runtime, typeof-guarded at the prominent sites. tlEsc stays in
   app.js (shared alias used by app.js + spotlight.js). */

// ══════════════ Camera Feeds tab — Players / Casters / Gameplay / Settings ══════════════
const CF_OVERLAY_BASE = 'http://localhost:3000';
function cfShowSubtab(cf) {
  // Players sub-tab retired — player cam assignment lives in Match — Teams (gear) and the
  // Talent Monitor's Players tab. Old saved subtab values / deep links land on Talent Rooms.
  if (cf === 'players') cf = 'talent';
  document.querySelectorAll('#cf-subnav .cf-tab').forEach((b) => b.classList.toggle('active', b.dataset.cf === cf));
  document.querySelectorAll('#tab-facecams-content .cf-panel').forEach((p) => p.classList.toggle('active', p.id === 'cf-panel-' + cf));
  if (cf === 'talent') cfLoadTalent();
  if (cf === 'gameplay') { renderCfShares(); renderCfStreamStations(currentState); }
  if (cf === 'stations') cfLoadStations();
  try { localStorage.setItem('cf_active_subtab', cf); } catch (_) {}
}
document.querySelectorAll('#cf-subnav .cf-tab').forEach((btn) => {
  btn.addEventListener('click', () => cfShowSubtab(btn.dataset.cf));
});
// Reopen whichever Camera Feeds sub-tab was last active — survives refresh. Deferred to a
// macrotask: cfLoadTalent()/fetchVdoLinksForFacecam() reference VDO_API, a `const` declared just
// below this block — calling them synchronously here would hit the same TDZ crash documented for
// the old switchRole('monitor') bug, so setTimeout(...,0) waits for the script to finish once first.
setTimeout(() => {
  let saved; try { saved = localStorage.getItem('cf_active_subtab'); } catch (_) {}
  if (saved && document.querySelector(`#cf-subnav .cf-tab[data-cf="${saved}"]`)) cfShowSubtab(saved);
}, 0);

// ── Talent Rooms (VDO.ninja automation) ─────────────────────────────────────
// VDO_API / _vdoLinks are declared in app.js (shared with the qrail talent + DCC code
// that stayed there — app.js loads first, so the declarations must live with it).

async function fetchVdoLinksForFacecam() {
  try { _vdoLinks = await (await fetch(`${VDO_API}/api/vdo/links`)).json(); } catch (e) {}
}

async function cfLoadTalent() {
  const wrap = el('cf-talent-teams'); if (!wrap) return;
  wrap.innerHTML = '<p class="section-desc">Loading…</p>';
  try {
    const d = await (await fetch(`${VDO_API}/api/vdo/links`)).json();
    _vdoLinks = d; // keep cache warm for facecam auto-fill
    let html = '';

    // ── Broadcast Teams — compact side-by-side Match Control ───────────────
    let anyMatchPlayers = false;
    const matchCards = ['blue', 'orange'].map((side) => {
      const t = d.teams && d.teams[side]; if (!t) return '';
      if (t.players && t.players.length) anyMatchPlayers = true;
      return mcTeamCard(side, t);
    }).join('');
    html += `<div class="talent-section-head">Broadcast Teams · Match Control</div><div class="mc-grid">${matchCards || '<div class="talent-empty">No active match teams.</div>'}</div>`;

    // ── Team Library (all saved teams) ────────────────────────────────────
    const allTeams = d.allTeams || [];
    html += `<details class="tl-library"${allTeams.length > 4 ? '' : ' open'}>
      <summary class="talent-section-head tl-lib-summary">${svgIcon('chevdown')} Team Library <span class="tl-lib-count">${allTeams.length}</span></summary>
      <div class="tl-lib-tools"><button class="btn btn-primary btn-xs" id="talent-gen-all-btn" title="Generate rooms for every team that doesn't have one yet">${svgIcon('zap')} Generate all rooms</button></div>
      <div class="talent-grid">`;
    if (!allTeams.length) {
      html += '<div class="talent-empty">No saved teams yet. Add teams on the <b>Teams</b> page.</div>';
    } else {
      allTeams.forEach((t) => {
        const players = t.players || [];
        let rows;
        if (!t.hasRoom) {
          rows = `<div class="talent-empty" style="display:flex;align-items:center;gap:10px">No room yet.
            <button class="btn btn-primary btn-xs talent-gen-saved" data-team-name="${tlEsc(t.name)}">${svgIcon('zap')} Generate room</button></div>`;
        } else if (!players.length) {
          rows = '<div class="talent-empty">No players on this team.</div>';
        } else {
          rows = players.map((p) => talentRow(null, p, t.name, t.room)).join('');
        }
        html += `<div class="talent-team" style="--tc:${tlEsc(t.color) || '#555'}">
          <div class="talent-team-head">
            <span class="talent-dot"></span>
            <span class="talent-team-name">${tlEsc(t.name)}</span>
            ${t.room ? `<span class="talent-room">${tlEsc(t.room)}</span>` : ''}
            ${t.hasRoom ? `<button class="btn btn-ghost btn-sm talent-regen-saved" data-team-name="${tlEsc(t.name)}" title="New room (invalidates old links)">${svgIcon('refresh')} New room</button>` : ''}
          </div>
          <div class="talent-rows">${rows}</div>
        </div>`;
      });
    }
    html += '</div></details>';

    wrap.innerHTML = html;
    const hint = el('cf-talent-hint');
    if (hint) hint.innerHTML = (anyMatchPlayers || allTeams.some(t => t.hasRoom && t.players.length))
      ? '' : '<div class="talent-note">Set up teams + rosters on the <b>Teams</b> page, then hit <b>Generate rooms</b> to create private VDO rooms for every player.</div>';
    cfUpdateListenPill(currentState);
    renderVdoRooms();             // rooms manager reads currentState + this fresh fetch
    _cfDirectorData = d;          // cache for the Director Control Center
    cfRenderDirectorCenter();
    cfWireTalentDrag();
    cfUpdateMoveButtons();        // restore move-button states from tracked occupants
    cfUpdateConnStatus();         // restore connection dots
    cfFilterTalent();             // re-apply any active search filter
    // Auto-start the (media-free) director presence so connection status updates the moment a
    // player joins — no need to manually open the Director Control Center.
    if (!_directorOn) { cfStartDirectorConsoles(); renderQtalent(); }
    else if (typeof cfSyncDirectorConsoles === 'function') cfSyncDirectorConsoles();   // add any new rooms
  } catch (e) { wrap.innerHTML = `<p style="color:#f56565;">Error: ${tlEsc(e.message)}</p>`; }
}

// ── VDO Rooms manager — every room in one list; generate or link an existing room ──
function vdoRoomJoinUrl(vdo) {
  if (!vdo || !vdo.room) return '';
  const base = (currentState?.vdo?.base) || 'https://vdo.ninja';
  const lang = (currentState?.vdo?.lang) || '';
  return `${base}/?room=${encodeURIComponent(vdo.room)}${lang ? '&transcribe=' + encodeURIComponent(lang) : ''}&webcam&autostart${vdo.password ? '#p=' + encodeURIComponent(vdo.password) : ''}`;
}
function _vdoRoomRows() {
  const st = currentState || {};
  const rows = [];
  ['blue', 'orange'].forEach((side) => {
    const t = st.teams?.[side]; if (!t) return;
    rows.push({ kind: 'team', key: side, label: t.name || (side.toUpperCase() + ' TEAM'),
      badge: side === 'blue' ? 'TEAM A' : 'TEAM B', color: t.color || (side === 'blue' ? '#3b82f6' : '#f97316'),
      vdo: t.vdo || null });
  });
  const c = st.casters || {};
  rows.push({ kind: 'group', key: 'casters',   label: 'Hosts / Casters desk', badge: 'HOSTS',     color: '#e83a8b', vdo: c.vdo });
  rows.push({ kind: 'group', key: 'guests',    label: 'Guest lobby',          badge: 'LOBBY',     color: '#a855f7', vdo: c.guestsVdo });
  rows.push({ kind: 'group', key: 'observers', label: 'In-game observers',    badge: 'OBSERVERS', color: '#2dd4bf', vdo: c.observersVdo });
  rows.push({ kind: 'group', key: 'interview', label: 'Interview room',       badge: 'INTERVIEW', color: '#fbbf24', vdo: c.interview });
  (c.rooms || []).forEach((r) => rows.push({ kind: 'named', key: r.id, label: r.name || 'Talent room',
    badge: 'ROOM', color: '#8b5cf6', vdo: r.vdo, isDesk: c.deskRoomId === r.id }));
  return rows;
}
function renderVdoRooms() {
  const list = el('cf-rooms-list'); if (!list) return;
  const rows = _vdoRoomRows();
  list.innerHTML = rows.map((r) => {
    const has = !!(r.vdo && r.vdo.room);
    const rid = `${r.kind}:${r.key}`;
    const join = has ? vdoRoomJoinUrl(r.vdo) : '';
    return `<div class="cf-room-row" data-room="${tlEsc(rid)}" style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:8px 12px; background:var(--surface-2,#191c23); border:1px solid var(--border,#2e3340); border-radius:9px;">
      <span style="flex:0 0 76px; text-align:center; font-size:9px; font-weight:800; letter-spacing:.08em; padding:3px 0; border-radius:99px; background:${tlEsc(r.color)}22; color:${tlEsc(r.color)};">${tlEsc(r.badge)}</span>
      <span style="flex:1 1 150px; min-width:0; font-size:13px; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${tlEsc(r.label)}${r.isDesk ? ' <span style="font-size:9px;font-weight:800;color:#fbbf24;letter-spacing:.08em;">DESK</span>' : ''}</span>
      ${has ? `<span class="talent-room" title="Room name — click to copy" data-copy="${tlEsc(r.vdo.room)}" style="cursor:pointer;">${tlEsc(r.vdo.room)}</span>
        <span class="talent-room cf-room-pw" title="Password — click to reveal / copy" data-pw="${tlEsc(r.vdo.password || '')}" style="cursor:pointer;">${r.vdo.password ? '••••••' : 'no password'}</span>
        <button class="cf-ico-btn" data-copy="${tlEsc(join)}" title="Copy the room-level join link (anyone with it joins this room)"><span class="cf-ico-lbl">Join link</span></button>`
      : '<span class="talent-room" style="opacity:.6;">no room yet</span>'}
      <button class="btn btn-ghost btn-xs cf-room-link" title="Use a VDO.ninja room you already have — paste its room name + password">Link existing</button>
      <button class="btn btn-ghost btn-xs cf-room-gen" title="${has ? 'Generate NEW credentials (old links stop working)' : 'Generate room credentials'}">${has ? 'New room' : 'Generate'}</button>
      ${r.kind === 'named' ? `${r.isDesk ? '' : '<button class="btn btn-ghost btn-xs cf-room-desk" title="Make this the desk/interview room (casters + interviews resolve here)">Set desk</button>'}
        <button class="btn btn-ghost btn-xs cf-room-del" title="Delete this room" style="color:#f56565;">Del</button>` : ''}
      <div class="cf-room-linkform" style="display:none; flex-basis:100%; gap:8px; align-items:center; padding-top:6px;">
        <input type="text" class="input-text cf-room-linkname" placeholder="existing room name" style="flex:1; min-width:140px;" maxlength="100">
        <input type="text" class="input-text cf-room-linkpw" placeholder="room password" style="flex:1; min-width:120px;" maxlength="100">
        <button class="btn btn-primary btn-xs cf-room-linksave">Use this room</button>
        <button class="btn btn-ghost btn-xs cf-room-linkcancel">Cancel</button>
      </div>
    </div>`;
  }).join('');
}
;(function wireVdoRooms() {
  const list = el('cf-rooms-list'); if (!list) return;
  const parseRow = (node) => {
    const row = node.closest('.cf-room-row'); if (!row) return null;
    const [kind, ...rest] = (row.dataset.room || '').split(':');
    return { row, kind, key: rest.join(':') };
  };
  const roomMsg = (kind, key, creds) => {
    if (kind === 'team')  return ['set_team_vdo_creds',   { side: key, ...creds }];
    if (kind === 'group') return ['set_group_room_creds', { group: key, ...creds }];
    return ['set_caster_room_creds', { id: key, ...creds }];
  };
  list.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn && !e.target.closest('.cf-room-linkform')) {
      navigator.clipboard?.writeText(copyBtn.dataset.copy || '');
      showToast('Copied!', '#22c55e');
      return;
    }
    const pw = e.target.closest('.cf-room-pw');
    if (pw) {
      if (pw.textContent === '••••••') { pw.textContent = pw.dataset.pw || ''; }
      else { navigator.clipboard?.writeText(pw.dataset.pw || ''); showToast('Password copied', '#22c55e'); }
      return;
    }
    const ctx = parseRow(e.target); if (!ctx) return;
    if (e.target.closest('.cf-room-link')) {
      const form = ctx.row.querySelector('.cf-room-linkform');
      if (form) { form.style.display = form.style.display === 'none' ? 'flex' : 'none'; form.querySelector('.cf-room-linkname')?.focus(); }
    } else if (e.target.closest('.cf-room-linkcancel')) {
      const form = ctx.row.querySelector('.cf-room-linkform');
      if (form) form.style.display = 'none';
    } else if (e.target.closest('.cf-room-linksave')) {
      const name = ctx.row.querySelector('.cf-room-linkname')?.value.trim();
      const pass = ctx.row.querySelector('.cf-room-linkpw')?.value.trim();
      if (!name) { showToast('Enter the existing room name', '#fbbf24'); return; }
      const [type, data] = roomMsg(ctx.kind, ctx.key, { room: name, password: pass || '' });
      send(type, data);
      showToast('Room linked — join links now point at your room', '#22c55e');
      setTimeout(() => { renderVdoRooms(); if (typeof cfLoadTalent === 'function') cfLoadTalent(); }, 450);
    } else if (e.target.closest('.cf-room-gen')) {
      (async () => {
        // A new room invalidates every join/view link already handed out — on a live show that
        // drops talent off air until they get the new link, so it needs a yes.
        if (!await customConfirm('New room', 'Generate a new room? Every link already sent for this room stops working, and talent will need the new one.', 'Generate new room')) return;
        if (ctx.kind === 'team') send('generate_team_vdo', { side: ctx.key, regenerate: true });
        else if (ctx.kind === 'group') send('regenerate_group_room', { group: ctx.key });
        else send('generate_caster_room_vdo', { id: ctx.key, regenerate: true });
        showToast('Generating room… old links stop working', '#8b5cf6');
        setTimeout(() => { renderVdoRooms(); if (typeof cfLoadTalent === 'function') cfLoadTalent(); }, 500);
      })();
    } else if (e.target.closest('.cf-room-desk')) {
      send('set_desk_room', { roomId: ctx.key });
      setTimeout(renderVdoRooms, 400);
    } else if (e.target.closest('.cf-room-del')) {
      const btn = e.target.closest('.cf-room-del');
      if (btn.dataset.armed) { send('delete_caster_room', { id: ctx.key }); setTimeout(renderVdoRooms, 400); }
      else {
        btn.dataset.armed = '1'; btn.textContent = 'Sure?';
        setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = 'Del'; } }, 3000);
      }
    }
  });
  const add = el('cf-room-add');
  if (add) add.addEventListener('click', () => {
    const name = prompt('Name for the new talent room (e.g. "Analyst desk 2", "Green room")');
    if (!name || !name.trim()) return;
    send('save_caster_room', { name: name.trim() });
    showToast('Room created', '#22c55e');
    setTimeout(renderVdoRooms, 450);
  });
  // LISTEN IN → one-click OBS browser source (created on the current program scene).
  const listenObs = el('cf-listen-obs');
  if (listenObs) listenObs.addEventListener('click', () => {
    send('obs_ensure_browser_source', { sourceName: '[NE] Listen-In', url: 'http://localhost:3000/listen-in.html' });
    showToast('Adding Listen-In to OBS…', '#8b5cf6');
  });
})();

// Live filter of the talent teams/players by name or gamertag.
function cfFilterTalent() {
  const q = (el('cf-talent-search')?.value || '').trim();
  const clear = el('cf-talent-search-clear'); if (clear) clear.style.display = q ? '' : 'none';
  if (q) { const lib = document.querySelector('#cf-talent-teams .tl-library'); if (lib) lib.open = true; }   // reveal library matches
  document.querySelectorAll('#cf-talent-teams .talent-team, #cf-talent-teams .mc-team').forEach((team) => {
    // Prefer the row's own data-team-name over the header's textContent — the header carries badges
    // and counts that leak into a textContent read and skew the match.
    const nameNode = team.querySelector('.talent-team-name, .mc-team-name');
    const teamName = (team.dataset.teamName || nameNode?.dataset.name || nameNode?.textContent || '').trim();
    const teamMatch = !q || NESearch.matches(q, [teamName]);
    let anyVisible = false;
    team.querySelectorAll('.talent-row, .mc-player').forEach((r) => {
      const show = !q || teamMatch || NESearch.matches(q, [
        { text: r.dataset.name || '', weight: 2 }, r.dataset.search || ''
      ]);
      r.classList.toggle('tl-hidden', !show);
      if (show) anyVisible = true;
    });
    team.classList.toggle('tl-hidden', !(teamMatch || anyVisible));
  });
}
el('cf-talent-search')?.addEventListener('input', cfFilterTalent);
el('cf-talent-search-clear')?.addEventListener('click', () => {
  const s = el('cf-talent-search'); if (s) s.value = '';
  cfFilterTalent(); s?.focus();
});

// ── Director Control Center ──────────────────────────────────────────────────
// One producer joins every active room as VDO director (embedded consoles) and can drag a player
// onto the Interview room to transfer them with the IFrame-API "forward" command — no action on
// the player's end. Source room's console must be live for the transfer to fire.
// _cfDirectorData / _directorOn are declared in app.js (read by the DCC status renderers there).
const _directorFrames = {};           // roomId -> { iframe, ready }
let _roomOccupants = {};              // streamId -> { name, homeRoom, currentRoom, side } (players pulled out of their team room)
let _dcActiveRoom = '';

// The rooms we mount consoles for: both match teams + caster desk + interview room.
function cfDirectorConsoles() {
  const d = _cfDirectorData; if (!d) return [];
  const out = [];
  ['blue', 'orange'].forEach((side) => {
    const t = d.teams && d.teams[side];
    if (t && t.room && t.directorUrl) out.push({ key: side, label: t.name || side.toUpperCase(), color: t.color || '#888', room: t.room, url: t.directorUrl, kind: 'team' });
  });
  // Hosts (casters desk) · Guests · Observers — each its own room. No separate interview/desk console.
  const G = d.groups || {};
  [['casters', 'HOSTS', '#e83a8b'], ['observers', 'OBSERVERS', '#2dd4bf'], ['guests', 'LOBBY', '#a855f7']].forEach(([k, label, color]) => {
    const g = G[k];
    if (g && g.room && g.directorUrl) out.push({ key: k, label, color, room: g.room, url: g.directorUrl, kind: 'group' });
  });
  // WEBSITE station rooms — the rooms the invite system actually fills. First-class console
  // tabs (full-width, same top toggles, same talent sidebar) pointed at the bound station.
  const stRooms = (window._cfStationDetail && window._cfStationDetail.rooms) || [];
  stRooms.forEach((r) => {
    if (r && r.monitorUrl) out.push({
      key: 'station_' + r.id,
      label: (r.name || (r.kind === 'observer' ? 'Observer feeds' : 'Caster room')).toUpperCase(),
      color: r.kind === 'observer' ? '#2dd4bf' : '#8b5cf6',
      room: 'st_' + r.id,
      url: r.monitorUrl,
      kind: 'station'
    });
  });
  // Deduplicate by room ID — casterRoom and groups.casters often share the same VDO room.
  const seen = new Set();
  return out.filter((c) => { if (!c.room || seen.has(c.room)) return false; seen.add(c.room); return true; });
}
function cfPostToRoom(roomId, msg) {
  const f = _directorFrames[roomId];
  if (!f || !f.iframe || !f.iframe.contentWindow) return false;
  try { f.iframe.contentWindow.postMessage(msg, '*'); return true; } catch (e) { return false; }
}

function cfRenderDirectorCenter() {
  const idle = el('cf-dc-idle'), armed = el('cf-dc-armed');
  if (!idle || !armed) return;
  const ivRoom = _cfDirectorData && _cfDirectorData.interview ? _cfDirectorData.interview.room : '';
  const ivRoomEl = el('cf-dc-interview-room'); if (ivRoomEl) ivRoomEl.textContent = ivRoom ? ('room: ' + ivRoom) : '(no interview room yet)';
  idle.style.display = _directorOn ? 'none' : '';
  armed.style.display = _directorOn ? '' : 'none';
  el('cf-dc-start').style.display = _directorOn ? 'none' : '';
  el('cf-dc-stop').style.display = _directorOn ? '' : 'none';
  if (_directorOn) { cfRenderConsoleTabs(); cfRenderOccupants(); }
  if (typeof window._dccUpdateMonDot === 'function') window._dccUpdateMonDot();
}

// Unified audio mixer — every live feed (team players + casters/guests/observers) in one strip.
// Routes each change to the right handler: set_player_audio for team players, set_library_audio
// for group members. Mirrors the same values the per-card audio controls write.
function cfRenderMixer() {
  const wrap = el('cf-dc-mixer'); if (!wrap || _editingInside(wrap)) return;
  const rows = [];
  ['blue', 'orange'].forEach((side) => {
    const t = (typeof currentState !== 'undefined' && currentState.teams) ? currentState.teams[side] : null;
    if (!t) return;
    (t.players || []).forEach((p) => rows.push({ label: p.name || '—', group: t.name || side, color: t.color || '#888', audio: p.vdoAudio || {}, kind: 'player', side, playerId: p.id }));
  });
  const G = (_cfDirectorData && _cfDirectorData.groups) || {};
  // Live audio comes from the broadcast library (set_library_audio updates it), so the mixer
  // stays in sync after edits even though the member list itself comes from the cached groups.
  const libById = {};
  ((typeof currentState !== 'undefined' && currentState.casters && currentState.casters.library) || []).forEach((p) => { if (p.id) libById[p.id] = p; });
  [['casters', '#e83a8b'], ['guests', '#a855f7'], ['observers', '#2dd4bf']].forEach(([k, color]) => {
    const g = G[k]; if (!g) return;
    (g.members || []).forEach((m) => {
      const live = libById[m.libraryId];
      rows.push({ label: m.name || m.handle || '—', group: g.name || k, color, audio: (live && live.audio) || m.audio || {}, kind: 'lib', id: m.libraryId });
    });
  });
  wrap._rows = rows;
  if (!rows.length) { wrap.innerHTML = '<div class="dc-mixer-empty">No feeds yet — add teams, casters, guests or observers.</div>'; return; }
  wrap.innerHTML = '<div class="dc-mixer-head">Audio mixer · every feed</div>' + rows.map((r, i) =>
    `<div class="dc-mix-row" data-i="${i}" style="--tc:${r.color}">
      <span class="dc-mix-dot"></span>
      <span class="dc-mix-name">${tlEsc(r.label)} <span class="dc-mix-grp">${tlEsc(r.group)}</span></span>
      <label class="dc-mix-ctl" title="Volume 0–200">vol<input type="number" class="dc-mix-vol" min="0" max="200" step="5" value="${r.audio.volume != null ? r.audio.volume : 100}"></label>
      <label class="dc-mix-ctl" title="Stereo pan">pan<input type="range" class="dc-mix-pan" min="-100" max="100" step="5" value="${r.audio.pan != null ? r.audio.pan : 0}"></label>
      <label class="dc-mix-ctl"><input type="checkbox" class="dc-mix-mono"${r.audio.mono ? ' checked' : ''}>mono</label>
    </div>`).join('');
}

function cfRenderConsoleTabs() {
  const tabs = el('cf-dc-tabs'); if (!tabs) return;
  const consoles = cfDirectorConsoles();
  tabs.innerHTML = '';
  consoles.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'dc-tab' + (c.room === _dcActiveRoom ? ' active' : '');
    b.style.setProperty('--dc-tc', c.color);
    const ready = _directorFrames[c.room] && _directorFrames[c.room].ready;
    b.innerHTML = `<span class="dc-tab-dot"></span>${tlEsc(c.label)}${ready ? '' : ' <span class="dc-tab-load">…</span>'}`;
    b.addEventListener('click', () => cfSwitchConsole(c.room));
    // Drop a dragged talent/member row onto a tab to transfer that person into this room.
    b.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; b.classList.add('dc-tab-drop'); });
    b.addEventListener('dragleave', () => b.classList.remove('dc-tab-drop'));
    b.addEventListener('drop', (e) => {
      e.preventDefault(); b.classList.remove('dc-tab-drop');
      let p; try { p = JSON.parse(e.dataTransfer.getData('text/plain')); } catch (_) { return; }
      if (p && p.stream) cfMovePlayerToRoom({ stream: p.stream, name: p.name, side: p.side || '', homeRoom: p.homeRoom || '' }, c.room, c.label);
    });
    tabs.appendChild(b);
  });
}
function cfSwitchConsole(roomId) {
  _dcActiveRoom = roomId;
  // Keep ALL consoles rendered (display:none suspends iframes → no guest-list updates). Just
  // bring the chosen one to the front with .is-active; the rest stay live but invisible.
  Object.entries(_directorFrames).forEach(([rid, f]) => { if (f.iframe) f.iframe.classList.toggle('is-active', rid === roomId); });
  cfRenderConsoleTabs();
}

function cfStartDirectorConsoles() {
  const consoles = cfDirectorConsoles();
  if (!consoles.length) { const n = el('cf-dc-note'); if (n) n.textContent = 'No rooms to manage yet — generate team/caster rooms first.'; }
  _directorOn = true;
  cfRenderDirectorCenter();
  const host = el('cf-dc-consoles'); if (!host) return;
  host.innerHTML = '';
  consoles.forEach((c, idx) => {
    const f = document.createElement('iframe');
    f.className = 'dc-frame' + (idx === 0 ? ' is-active' : '');
    f.src = c.url;
    f.allow = 'camera;microphone;fullscreen;display-capture;autoplay';
    f.setAttribute('referrerpolicy', 'no-referrer');
    host.appendChild(f);
    _directorFrames[c.room] = { iframe: f, ready: false, kind: c.kind };
    if (idx === 0) _dcActiveRoom = c.room;
  });
  cfRenderConsoleTabs();
  clearInterval(_connPoll); _connPoll = setInterval(cfPollGuests, 3000); setTimeout(cfPollGuests, 1200);
  cfUpdateConnStatus();
  const n = el('cf-dc-note'); if (n) n.textContent = 'Monitoring rooms as director (no camera/mic). Connection dots update as players join. Use the per-player buttons or drag onto the Interview room to transfer.';
}
// Mount consoles for any rooms that appeared after the director started (e.g. the Casters / Guests /
// Observers rooms get provisioned when you open those tabs). Adds them live without a restart, so
// moving/monitoring works on every group page — not just Teams.
function cfSyncDirectorConsoles() {
  if (!_directorOn) return;
  const host = el('cf-dc-consoles'); if (!host) return;
  let added = false;
  cfDirectorConsoles().forEach((c) => {
    if (!c.room || _directorFrames[c.room]) return;   // already mounted
    const f = document.createElement('iframe');
    f.className = 'dc-frame';
    f.src = c.url;
    f.allow = 'camera;microphone;fullscreen;display-capture;autoplay';
    f.setAttribute('referrerpolicy', 'no-referrer');
    host.appendChild(f);
    _directorFrames[c.room] = { iframe: f, ready: false, kind: c.kind };
    added = true;
  });
  if (added) { cfRenderConsoleTabs(); setTimeout(cfPollGuests, 800); }
}
function cfStopDirectorConsoles() {
  _directorOn = false;
  clearInterval(_connPoll); _connPoll = null; _connectedStreams = new Set(); _videoStreams = new Set();
  Object.values(_directorFrames).forEach((f) => { if (f.iframe) f.iframe.remove(); });
  Object.keys(_directorFrames).forEach((k) => delete _directorFrames[k]);
  const host = el('cf-dc-consoles'); if (host) host.innerHTML = '';
  cfRenderDirectorCenter();
  cfUpdateConnStatus();
}

// Resolve a logical room key → actual VDO room id. The interview room IS the production/caster
// desk room, so 'interview' and 'production' both resolve to the caster room. 'home' = team room.
function cfRoomId(key, homeRoom) {
  const d = _cfDirectorData || {};
  if (key === 'production' || key === 'interview') return d.casterRoom ? d.casterRoom.room : '';
  if (key === 'home') return homeRoom || '';
  // Group rooms (Casters / Guests / Observers) can also be transfer targets.
  const g = d.groups && d.groups[key];
  if (g && g.room) return g.room;
  return '';
}
function cfRoomLabel(roomId) {
  const d = _cfDirectorData || {};
  if (d.casterRoom && roomId === d.casterRoom.room) return 'Interview';
  const G = d.groups || {};
  for (const k of ['casters', 'guests', 'observers']) { if (G[k] && G[k].room === roomId) return G[k].name || k; }
  return 'their team room';
}
function cfPlayerCurrentRoom(stream, homeRoom) {
  return (_roomOccupants[stream] && _roomOccupants[stream].currentRoom) || homeRoom;
}
// Director-side transfer a player to a target room (forward from whichever room they're in now).
// player = { stream, name, side, homeRoom }. targetKey ∈ 'production' | 'interview' | 'home'.
// Core transfer: move a tracked person to an explicit target room id (any monitored room).
function cfMovePlayerToRoom(player, target, label) {
  const note = el('cf-dc-note');
  if (!player || !player.stream) return false;
  if (!_directorOn) { if (note) note.textContent = 'Start the director consoles first (top of Director Control Center).'; return false; }
  if (!target) { if (note) note.textContent = "That room isn't provisioned yet — generate the room first."; return false; }
  const current = cfPlayerCurrentRoom(player.stream, player.homeRoom);
  if (current === target) { if (note) note.textContent = `${player.name} is already in ${cfRoomLabel(target)}.`; return false; }
  const f = _directorFrames[current];
  if (!f) { if (note) note.textContent = `No live console for ${player.name}'s current room — can't transfer from there.`; return false; }
  const ok = cfPostToRoom(current, { action: 'forward', target: player.stream, value: target });
  if (ok) {
    if (target === player.homeRoom) delete _roomOccupants[player.stream];
    else _roomOccupants[player.stream] = { name: player.name, homeRoom: player.homeRoom, currentRoom: target, side: player.side || '' };
    cfRenderOccupants(); if (typeof cfUpdateMoveButtons === 'function') cfUpdateMoveButtons();
    if (note) note.textContent = `Moved ${player.name} → ${label || cfRoomLabel(target)}.` + (f.ready ? '' : ' (console still connecting — retry if nothing moved)');
    return true;
  }
  if (note) note.textContent = 'Transfer command failed — console may still be loading.';
  return false;
}
function cfMovePlayer(player, targetKey) {
  return cfMovePlayerToRoom(player, cfRoomId(targetKey, player.homeRoom), cfRoomLabel(cfRoomId(targetKey, player.homeRoom)));
}
// Move every player on a team at once.
function cfMoveTeam(side, targetKey) {
  const d = _cfDirectorData; const t = d && d.teams && d.teams[side]; if (!t) return;
  (t.players || []).forEach((p) => cfMovePlayer({ stream: p.streamId, name: p.name || p.streamId, side, homeRoom: t.room }, targetKey));
}
// Interview-room drop zone occupants (drag target). Also lists anyone currently in production.
function cfRenderOccupants() {
  const host = el('cf-dc-occupants'); if (!host) return;
  const ids = Object.keys(_roomOccupants);
  host.innerHTML = '';
  if (!ids.length) { host.innerHTML = '<span class="dc-occ-empty">No players pulled out of their team room.</span>'; return; }
  ids.forEach((sid) => {
    const o = _roomOccupants[sid];
    const chip = document.createElement('div');
    chip.className = 'dc-occ';
    chip.innerHTML = `<span class="dc-occ-name">${tlEsc(o.name)}</span><span class="dc-occ-loc">${tlEsc(cfRoomLabel(o.currentRoom))}</span>`;
    const back = document.createElement('button');
    back.className = 'btn btn-ghost btn-xs'; back.textContent = 'Return';
    back.title = 'Send back to their team room';
    back.addEventListener('click', () => cfMovePlayer({ stream: sid, name: o.name, side: o.side, homeRoom: o.homeRoom }, 'home'));
    chip.appendChild(back);
    host.appendChild(chip);
  });
}
// Reflect each player's current location on the Match Control row (live, between refreshes):
// when a player is in the interview/desk room, swap their "→ Interview" button for "Return".
function cfUpdateMoveButtons() {
  const ivPid = currentState?.casters?.interviewee ? String(currentState.casters.interviewee.playerId) : '';
  document.querySelectorAll('.mc-player[data-stream]').forEach((row) => {
    const sid = row.dataset.stream;
    const isInterviewee = ivPid && String(row.dataset.pid) === ivPid;
    const loc = _roomOccupants[sid] ? cfRoomLabel(_roomOccupants[sid].currentRoom) : (isInterviewee ? 'Interview' : '');
    row.dataset.loc = loc;
    const intv = row.querySelector('.mc-intv'), ret = row.querySelector('.mc-return');
    if (intv) intv.style.display = loc ? 'none' : '';
    if (ret) ret.style.display = loc ? '' : 'none';
    row.classList.toggle('is-onair', !!loc);
    row.classList.toggle('is-interviewee', !!isInterviewee);
    const badge = row.querySelector('.mc-loc');
    if (badge) { badge.textContent = isInterviewee ? 'ON SPOTLIGHT' : (loc || ''); badge.style.display = loc ? '' : 'none'; }
  });
}

// Live connection status from the director consoles' guest lists (best-effort; needs consoles on).
// _connectedStreams / _videoStreams are declared in app.js (read by the DCC renderers there).
let _connPoll = null;
function cfPollGuests() {
  Object.values(_directorFrames).forEach((f) => {
    if (f.iframe && f.iframe.contentWindow) { try { f.iframe.contentWindow.postMessage({ action: 'getGuestList', cib: 'gl' }, '*'); } catch (e) {} }
  });
}
function cfUpdateConnStatus() {
  const live = _directorOn;
  document.querySelectorAll('.mc-player[data-stream]').forEach((row) => {
    const sid = row.dataset.stream;
    const on = _connectedStreams.has(sid);
    const dot = row.querySelector('.mc-stat-conn');
    if (dot) { dot.dataset.conn = !live ? '0' : (on ? '1' : '0'); dot.title = !live ? 'Start monitoring to detect connection' : (on ? 'Connected' : 'Not detected in any room'); }
    // Camera icon pulses green when the player is live in a room with their camera up.
    const camEl = row.querySelector('.mc-stat-cam');
    if (camEl) {
      const camLive = live && _videoStreams.has(sid);
      camEl.classList.toggle('live', camLive);
      camEl.title = camLive ? 'Camera live' : (camEl.dataset.camConfig === '1' ? 'Camera linked (not live yet)' : 'No camera');
    }
  });
  document.querySelectorAll('.mc-team[data-side]').forEach((team) => {
    const rows = [...team.querySelectorAll('.mc-player[data-stream]')];
    const any = rows.some((r) => _connectedStreams.has(r.dataset.stream));
    const all = rows.length && rows.every((r) => _connectedStreams.has(r.dataset.stream));
    const dot = team.querySelector('.mc-team-conn');
    if (dot) { dot.dataset.conn = !live ? '0' : (all ? '1' : (any ? 'partial' : '0')); dot.title = !live ? 'Start director consoles to detect connection' : (all ? 'All players connected' : (any ? 'Some players connected' : 'No players detected')); }
  });
  // Caster lineup cards — same live pulse, keyed by each slot's stream id.
  document.querySelectorAll('.cf-ln-conn[data-stream], .qtalent-conn[data-stream]').forEach((dot) => {
    const on = _connectedStreams.has(dot.dataset.stream);
    dot.dataset.conn = !live ? '0' : (on ? '1' : '0');
    dot.title = !live ? 'Start Director monitoring to detect connection' : (on ? 'Connected' : 'Not detected in the room');
  });
  // Talent camera dots (rail + dashboard) — pulse green when monitoring sees their video.
  document.querySelectorAll('.qtalent-host .qtalent-cam[data-stream]').forEach((cam) => {
    const camLive = live && _videoStreams.has(cam.dataset.stream);
    cam.classList.toggle('live', camLive);
    cam.title = camLive ? 'Camera live' : 'Camera not live';
  });
  // Live-update each talent host's connection count without a full re-render.
  if (live) {
    document.querySelectorAll('.qtalent-host').forEach((host) => {
      const monTxt = host.querySelector('.qtalent-mon .qt-mon-txt'); if (!monTxt) return;
      const dots = host.querySelectorAll('.qtalent-conn[data-stream]');
      const conn = Array.prototype.filter.call(dots, (dt) => dt.dataset.conn === '1').length;
      monTxt.textContent = `Monitoring · ${conn}/${dots.length} connected`;
    });
  }
}

// Drag a talent row → drop on the Interview room (still supported alongside the buttons).
function cfWireTalentDrag() {
  document.querySelectorAll('#cf-talent-teams [draggable="true"][data-stream]').forEach((row) => {
    if (row._dragWired) return; row._dragWired = true;
    row.addEventListener('dragstart', (e) => {
      const payload = JSON.stringify({ homeRoom: row.dataset.room || '', stream: row.dataset.stream || '', name: row.dataset.name || '', side: row.dataset.side || '' });
      e.dataTransfer.setData('text/plain', payload);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
  });
  const drop = el('cf-dc-drop');
  if (drop && !drop._dropWired) {
    drop._dropWired = true;
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag-over'); e.dataTransfer.dropEffect = 'move'; });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault(); drop.classList.remove('drag-over');
      let p; try { p = JSON.parse(e.dataTransfer.getData('text/plain')); } catch (_) { return; }
      if (!p || !p.stream) return;
      cfMovePlayer({ stream: p.stream, name: p.name, side: p.side, homeRoom: p.homeRoom }, 'interview');
    });
  }
}

// Mark a console ready + harvest its guest list (connection status) from VDO IFrame-API messages.
window.addEventListener('message', (e) => {
  if (!_directorOn) return;
  const fr = Object.values(_directorFrames).find((f) => f.iframe && f.iframe.contentWindow === e.source);
  if (!fr) return;
  if (!fr.ready) { fr.ready = true; cfRenderConsoleTabs(); cfPollGuests(); }
  const data = e.data;
  if (data && Array.isArray(data.guestList)) {
    fr.guests = new Set(); fr.video = new Set();
    data.guestList.forEach((g) => {
      if (!g) return;
      const id = g.streamID || g.streamId || g.id || g.UUID || g.label;
      if (!id) return;
      fr.guests.add(String(id));
      // Camera live unless VDO explicitly reports video as off/muted (fields vary by version; if
      // none are present we assume video, since players join with &webcam).
      const noVid = g.videoMuted === true || g.video === false || g.novideo === true || g.noVideo === true || g.hasVideo === false;
      if (!noVid) fr.video.add(String(id));
    });
    _connectedStreams = new Set(); _videoStreams = new Set();
    Object.values(_directorFrames).forEach((f) => {
      if (f.guests) f.guests.forEach((id) => _connectedStreams.add(id));
      if (f.video) f.video.forEach((id) => _videoStreams.add(id));
    });
    cfUpdateConnStatus();
  } else if (data && data.action === 'guest-connected' && (data.streamID || data.streamId)) {
    const id = String(data.streamID || data.streamId);
    _connectedStreams.add(id); _videoStreams.add(id); cfUpdateConnStatus();
  }
});

el('cf-dc-start')?.addEventListener('click', async () => {
  // Pull fresh room data (teams + caster/interview + the Casters/Guests/Observers group rooms)
  // before mounting consoles, so every provisioned room shows up — even started from the dock.
  try { const d = await (await fetch(`${VDO_API}/api/vdo/links`)).json(); _cfDirectorData = d; } catch (_) {}
  cfStartDirectorConsoles();
  renderQtalent();
});
el('cf-dc-stop')?.addEventListener('click', cfStopDirectorConsoles);

// Unified mixer — route each row's audio change to the right handler.
el('cf-dc-mixer')?.addEventListener('change', (e) => {
  const rowEl = e.target.closest('.dc-mix-row'); if (!rowEl) return;
  const wrap = el('cf-dc-mixer'); const r = (wrap._rows || [])[+rowEl.dataset.i]; if (!r) return;
  const vol = parseInt(rowEl.querySelector('.dc-mix-vol')?.value, 10);
  const pan = parseInt(rowEl.querySelector('.dc-mix-pan')?.value, 10) || 0;
  const mono = !!rowEl.querySelector('.dc-mix-mono')?.checked;
  const audio = {};
  if (Number.isFinite(vol) && vol !== 100) audio.volume = vol;
  if (pan) audio.pan = pan;
  if (mono) audio.mono = true;
  if (r.kind === 'player') send('set_player_audio', { side: r.side, playerId: r.playerId, audio });
  else if (r.kind === 'lib' && r.id) send('set_library_audio', { id: r.id, audio });
});

// Director settings popover — listening / transcript / OBS audio routing.
el('cf-dc-settings-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = el('cf-dc-settings'); if (!pop) return;
  const showing = pop.style.display !== 'none';
  pop.style.display = showing ? 'none' : '';
  if (!showing) {
    const v = (typeof currentState !== 'undefined' && currentState.vdo) || {};
    if (el('cf-dc-captions')) el('cf-dc-captions').checked = v.listenCaptions !== false;
    if (el('cf-dc-lang')) el('cf-dc-lang').value = v.lang || 'en-US';
  }
});
document.addEventListener('click', (e) => {
  const pop = el('cf-dc-settings');
  if (pop && pop.style.display !== 'none' && !pop.contains(e.target) && e.target.id !== 'cf-dc-settings-btn' && !e.target.closest('#cf-dc-settings-btn')) pop.style.display = 'none';
});
el('cf-dc-captions')?.addEventListener('change', function () { send('set_listen_captions', { on: this.checked }); });
el('cf-dc-lang')?.addEventListener('change', function () { send('set_vdo_config', { lang: this.value }); });
el('cf-dc-obs-apply')?.addEventListener('click', async () => {
  const btn = el('cf-dc-obs-apply'); const orig = btn ? btn.textContent : '';
  if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }
  try {
    const res = await fetch('http://127.0.0.1:3000/api/obs/install-collection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('Server error ' + res.status));
    if (data.canceled) { /* user backed out */ }
    else if (typeof showToast === 'function') showToast(data.message || 'OBS collection saved.', '#22c55e');
  } catch (err) {
    if (typeof showToast === 'function') showToast('OBS save failed: ' + err.message, '#c53030');
  } finally { if (btn) { btn.textContent = orig || 'Save…'; btn.disabled = false; } }
});

el('cf-dc-open-interview')?.addEventListener('click', () => {
  const d = _cfDirectorData; const u = d && d.interview ? d.interview.directorUrl : '';
  if (u) window.open(u, '_blank', 'noopener');
});

// side = 'blue'|'orange' for match players (enables Listen In); null for library players.
// teamName = saved team name for library players (used for stream-ID override persistence).
// room = the player's actual VDO room id (drives drag-to-interview director transfer).
function talentRow(side, p, teamName, room) {
  const join = encodeURIComponent(p.joinUrl);
  const listenBtn = side
    ? `<button class="btn btn-ghost btn-sm tl-listen" title="Put this player's mic + live captions on stream">${svgIcon('headphones')} Listen in</button>`
    : '';
  const casterList = (currentState?.casters?.list) || [];
  const playerCamUrl = (currentState?.casters?.playerCam?.camUrl) || '';
  const assignedSlot = p.obsUrl
    ? (playerCamUrl === p.obsUrl ? 5 : (casterList.find(c => c.camUrl === p.obsUrl)?.slot || 0))
    : 0;
  const camOpts = [1,2,3,4].map(n => `<option value="${n}"${assignedSlot===n?' selected':''}>CAM ${n}</option>`).join('')
    + `<option value="5"${assignedSlot===5?' selected':''}>Player Cam</option>`;
  const camSelect = p.obsUrl
    ? `<select class="input-select tl-cam-slot" title="Assign this player's feed to a camera slot in the desk overlay (Player Cam = Spotlight / Interview Desk)"><option value="0"${!assignedSlot?' selected':''}>Set as CAM…</option>${camOpts}</select>`
    : '';
  const a = p.audio || {};
  const audioBlock = p.obsUrl ? `
    <details class="talent-audio"${(a.volume!=null||a.pan||a.mono)?' open':''}>
      <summary>Audio</summary>
      <div class="talent-audio-line">
        <label title="Volume 0–200">vol<input type="number" class="tl-a-vol" min="0" max="200" step="5" value="${a.volume!=null?a.volume:100}"></label>
        <label title="Stereo pan (left ↔ right)">pan<input type="range" class="tl-a-pan" min="-100" max="100" step="5" value="${a.pan!=null?a.pan:0}"></label>
        <label title="Down-mix to mono"><input type="checkbox" class="tl-a-mono"${a.mono?' checked':''}> mono</label>
      </div>
    </details>` : '';
  const camGrp = (camSelect || listenBtn) ? `<div class="tl-grp">
        <span class="tl-grp-cap">On Desk</span>
        <div class="tl-grp-btns">${camSelect}${listenBtn}</div>
      </div>` : '';
  return `<div class="talent-row" draggable="true" data-side="${tlEsc(side || '')}" data-pid="${tlEsc(p.playerId)}" data-team-name="${tlEsc(teamName || '')}" data-stream="${tlEsc(p.streamId || '')}" data-room="${tlEsc(room || '')}" data-name="${tlEsc(p.name || '')}" data-search="${tlEsc((p.name || '') + ' ' + (p.streamId || ''))}">
    <div class="tl-id">
      <span class="talent-drag-grip" title="Drag into the Interview room (director consoles must be running)">${svgIcon('grip')}</span>
      <div class="tl-id-main">
        <span class="talent-gt-name" title="Gamertag — drives the feed ID">${tlEsc(p.name) || '(unnamed)'}</span>
        <input class="talent-sid" value="${tlEsc(p.streamId)}" spellcheck="false" title="Stream ID (defaults to the gamertag — edit to override)">
      </div>
    </div>
    <div class="tl-links">
      <div class="tl-grp">
        <span class="tl-grp-cap">Talent link</span>
        <div class="tl-grp-btns">
          <button class="cf-ico-btn tl-copy" data-url="${tlEsc(p.joinUrl)}" data-kind="join" title="Copy the player's join link">${svgIcon('copy')}<span class="cf-ico-lbl">Join link</span></button>
          <button class="cf-ico-btn tl-qr" title="Show join QR">${svgIcon('qr')}</button>
          <a class="cf-ico-btn" href="${tlEsc(p.joinUrl)}" target="_blank" rel="noopener" title="Open the join link">${svgIcon('external')}</a>
        </div>
      </div>
      <div class="tl-grp">
        <span class="tl-grp-cap">OBS feed</span>
        <div class="tl-grp-btns">
          <button class="cf-ico-btn tl-copy" data-url="${tlEsc(p.obsUrl)}" data-kind="obs" title="Copy the OBS browser-source view link">${svgIcon('copy')}<span class="cf-ico-lbl">View link</span></button>
        </div>
      </div>
      ${camGrp}
      ${p.interviewUrl ? `<div class="tl-grp">
        <span class="tl-grp-cap"><span class="tl-grp-cap-ico" title="Move this player into the interview room — best done by dragging onto the Interview room with director consoles running. These links are a fallback.">${svgIcon('mic')}</span> Interview</span>
        <div class="tl-grp-btns">
          <button class="cf-ico-btn tl-copy" data-url="${tlEsc(p.interviewUrl)}" data-kind="interview" title="Fallback: send the player this link to hop into the interview room">${svgIcon('copy')}<span class="cf-ico-lbl">Join link</span></button>
          <button class="cf-ico-btn tl-copy" data-url="${tlEsc(p.interviewViewUrl)}" data-kind="interview-view" title="Their solo desk feed from the interview room — paste into a caster slot's Custom View URL or Set as CAM">${svgIcon('copy')}<span class="cf-ico-lbl">Desk feed</span></button>
        </div>
      </div>` : ''}
    </div>
    ${audioBlock}
    <div class="talent-qr" hidden><img alt="Join QR for ${tlEsc(p.name)}" src="${VDO_API}/api/vdo/qr?text=${join}"><span class="talent-qr-cap">Scan to join as <b>${tlEsc(p.name) || p.streamId}</b></span></div>
  </div>`;
}

// ── Match Control: compact side-by-side broadcast-team cards ──────────────────
// Each player gets: in-game name (RL roster) · inline camera (facecam by name) · move-to-room
// buttons (Production / Interview / Return) · a collapsible block with all the VDO links.
function mcCamFor(p) {
  const cams = currentState.facecams || currentState.savedFacecams || [];
  const cam = cams.find((fc) => (p.primaryid && fc.platformId && String(fc.platformId) === String(p.primaryid))
    || (fc.name && p.name && fc.name.toLowerCase() === p.name.toLowerCase()));
  return cam ? (cam.link || '') : '';
}
// Persist a Match-Control camera input as a facecam keyed to the player's name/ID, and sync dots.
function mcSaveCamera(camInput) {
  const link = (camInput.value || '').trim();
  const name = camInput.dataset.pname || '';
  const pid = camInput.dataset.pid || '';
  if (!name && !pid) return;
  if (link) {
    const cams = currentState.facecams || currentState.savedFacecams || [];
    const existing = cams.find((fc) => (pid && fc.platformId && String(fc.platformId) === String(pid)) || (fc.name && name && fc.name.toLowerCase() === name.toLowerCase()));
    send('save_facecam', { name: name || pid, platform: (existing && existing.platform) || (pid ? 'steam' : 'bot'), platformId: pid || null, link });
  } else {
    send('delete_facecam', { name: name || pid });
  }
  const row = camInput.closest('.mc-player');
  camInput.closest('.mc-cam')?.querySelector('.mc-cam-dot')?.classList.toggle('on', !!link);
  const statCam = row?.querySelector('.mc-stat-cam');
  if (statCam) { statCam.classList.toggle('on', !!link); statCam.dataset.camConfig = link ? '1' : '0'; }
}
function mcTeamCard(side, t) {
  const players = (t.players || []).length
    ? (t.players || []).map((p) => mcPlayerRow(side, p, t)).join('')
    : '<div class="talent-empty">No players yet — add this team\'s roster on the <b>Teams</b> page.</div>';
  return `<div class="mc-team talent-team" style="--tc:${tlEsc(t.color) || '#888'}" data-side="${side}" data-room="${tlEsc(t.room || '')}">
    <div class="mc-team-head talent-team-head">
      <span class="mc-team-conn mc-stat" data-conn="0" title="Team connection — start director consoles to detect"></span>
      <span class="mc-team-name talent-team-name">${tlEsc(t.name) || side.toUpperCase()}</span>
      <span class="talent-room" title="Private team room">${tlEsc(t.room)}</span>
      <div class="mc-team-tools">
        <button class="cf-ico-btn mc-team-move-btn" data-team-move="interview" data-side="${side}" title="Pull the whole team into the Interview / Desk room">${svgIcon('mic')}<span class="cf-ico-lbl">Team → Interview</span></button>
        <button class="cf-ico-btn mc-team-move-btn cf-ico-del" data-team-move="home" data-side="${side}" title="Send the whole team back to their own room">${svgIcon('refresh')}<span class="cf-ico-lbl">Return all</span></button>
        <button class="cf-ico-btn tl-listen-room" data-side="${side}" title="Listen in on the whole team room">${svgIcon('headphones')}</button>
        <button class="cf-ico-btn mc-team-rlcam" data-side="${side}" title="Set every player's VDO feed as their Rocket League facecam">${svgIcon('camera')}<span class="cf-ico-lbl">All → RL cams</span></button>
        <button class="cf-ico-btn talent-regen" data-side="${side}" title="New room + password (invalidates old links)">${svgIcon('refresh')}</button>
      </div>
    </div>
    <div class="mc-players talent-rows">${players}</div>
  </div>`;
}
// One-line collapsible player row: status dots · name · quick actions (listen, copy view,
// interview/return, expand). Expanded body has stream-ID, camera (facecam), all VDO links + audio.
function mcPlayerRow(side, p, t) {
  const camSaved = mcCamFor(p);                 // saved facecam link (if any)
  const camVal = camSaved || (p.obsUrl || '');  // default to the auto-generated VDO view link
  const join = encodeURIComponent(p.joinUrl);
  // In-game players from the live Rocket League data (same source as the Players page). Show ALL of
  // them so a camera can be tied to any in-game player — grouped by side for clarity. The old filter
  // used a strict `pl.team === sideTeam` compare (number) which dropped every player whose team came
  // through as a STRING ("0"/"1"), and hid everyone when the talent-team↔RL-side mapping didn't line
  // up. Numeric coercion (Number(pl.team) === 1 → orange) matches the Players page.
  const allIngame = (currentState.players || []).filter((pl) => pl && pl.name);
  const optFor = (pl) => `<option value="${tlEsc(pl.name)}"${(pl.name && p.name && pl.name.toLowerCase() === p.name.toLowerCase()) ? ' selected' : ''}>${tlEsc(pl.name)}</option>`;
  const blueIn = allIngame.filter((pl) => Number(pl.team) !== 1);
  const orangeIn = allIngame.filter((pl) => Number(pl.team) === 1);
  const ingameOpts = (blueIn.length && orangeIn.length)
    ? `<optgroup label="Blue">${blueIn.map(optFor).join('')}</optgroup><optgroup label="Orange">${orangeIn.map(optFor).join('')}</optgroup>`
    : allIngame.map(optFor).join('');
  const ingameSelect = `<select class="input-select mc-ingame-sel" title="Link this camera to an in-game player → shows on their overlay statcard"><option value="">Link to in-game player…</option>${ingameOpts}</select>`;
  const a = p.audio || {};
  const audioBlock = p.obsUrl ? `<details class="talent-audio"${(a.volume != null || a.pan || a.mono) ? ' open' : ''}><summary>Audio</summary><div class="talent-audio-line"><label title="Volume 0–200">vol<input type="number" class="tl-a-vol" min="0" max="200" step="5" value="${a.volume != null ? a.volume : 100}"></label><label title="Stereo pan">pan<input type="range" class="tl-a-pan" min="-100" max="100" step="5" value="${a.pan != null ? a.pan : 0}"></label><label><input type="checkbox" class="tl-a-mono"${a.mono ? ' checked' : ''}> mono</label></div></details>` : '';
  return `<div class="talent-row mc-player" draggable="true" data-side="${tlEsc(side)}" data-pid="${tlEsc(p.playerId)}" data-stream="${tlEsc(p.streamId || '')}" data-room="${tlEsc(t.room || '')}" data-name="${tlEsc(p.name || '')}" data-search="${tlEsc((p.name || '') + ' ' + (p.streamId || ''))}">
    <div class="mc-p-line">
      <span class="talent-drag-grip" title="Drag to the Interview / Desk room">${svgIcon('grip')}</span>
      <span class="mc-stats">
        <span class="mc-stat mc-stat-conn" data-conn="0" title="Connection — monitoring detects this automatically"></span>
        <span class="mc-stat mc-stat-cam${camSaved ? ' on' : ''}" data-cam-config="${camSaved ? '1' : '0'}" title="${camSaved ? 'Camera linked' : 'No camera linked'}">${svgIcon('camera')}</span>
      </span>
      <span class="mc-p-name" title="In-game name (Rocket League roster)">${tlEsc(p.name) || '(unnamed)'}</span>
      <span class="mc-loc" style="display:none"></span>
      <span class="mc-p-quick">
        <button class="cf-ico-btn tl-listen" title="Listen in on this player">${svgIcon('headphones')}</button>
        <button class="cf-ico-btn tl-copy" data-url="${tlEsc(p.joinUrl)}" data-kind="join" title="Copy the invite / join link">${svgIcon('userplus')}</button>
        <button class="cf-ico-btn tl-copy" data-url="${tlEsc(p.obsUrl)}" data-kind="obs" title="Copy the OBS view link">${svgIcon('copy')}</button>
        <button class="cf-ico-btn mc-rlcam${camSaved ? ' is-on' : ''}" data-pname="${tlEsc(p.name || '')}" data-pid="${tlEsc(p.primaryid || '')}" data-obs="${tlEsc(p.obsUrl || '')}" title="${camSaved ? 'Linked as RL facecam — click to unlink' : 'Set this VDO feed as the Rocket League facecam'}">${svgIcon('camera')}</button>
        <button class="cf-ico-btn mc-move-btn mc-intv" data-move="interview" title="Pull into the Interview / Desk room (sets them as interviewee)">${svgIcon('mic')}</button>
        <button class="cf-ico-btn mc-move-btn cf-ico-del mc-return" data-move="home" title="Send back to their team room" style="display:none">${svgIcon('refresh')}</button>
        <button class="cf-ico-btn mc-expand" title="Details, camera & all links">${svgIcon('chevdown')}</button>
      </span>
    </div>
    <div class="mc-p-body" hidden>
      <div class="mc-field">
        <span class="mc-field-lbl">Camera</span>
        <div class="mc-cam">
          <span class="mc-cam-dot${camSaved ? ' on' : ''}" title="${camSaved ? 'Camera linked' : 'No camera linked'}">${svgIcon('camera')}</span>
          <input class="input-text mc-cam-input" data-pname="${tlEsc(p.name || '')}" data-pid="${tlEsc(p.primaryid || '')}" data-default="${tlEsc(p.obsUrl || '')}" placeholder="VDO view link (default) — paste a URL to overwrite" value="${tlEsc(camVal)}" spellcheck="false">
          <button class="cf-ico-btn mc-cam-reset" title="Reset to the auto-generated VDO view link">${svgIcon('refresh')}</button>
        </div>
      </div>
      <div class="mc-field"><span class="mc-field-lbl">Stream ID</span><input class="input-text talent-sid mc-p-sid" value="${tlEsc(p.streamId)}" spellcheck="false" title="Stream ID (defaults to gamertag — edit to override)"></div>
      <div class="mc-field">
        <span class="mc-field-lbl">In-game</span>
        <div class="mc-p-links">
          <div class="tl-grp"><span class="tl-grp-cap">Link camera to in-game player</span><div class="tl-grp-btns">
            ${ingameSelect}
          </div></div>
        </div>
      </div>
      <div class="mc-field">
        <span class="mc-field-lbl">Links</span>
        <div class="mc-p-links">
          <div class="tl-grp"><span class="tl-grp-cap">Talent link</span><div class="tl-grp-btns">
            <button class="cf-ico-btn tl-copy" data-url="${tlEsc(p.joinUrl)}" data-kind="join" title="Copy the player's invite/join link">${svgIcon('copy')}<span class="cf-ico-lbl">Invite</span></button>
            <button class="cf-ico-btn tl-qr" title="Show join QR">${svgIcon('qr')}</button>
            <a class="cf-ico-btn" href="${tlEsc(p.joinUrl)}" target="_blank" rel="noopener" title="Open join link">${svgIcon('external')}</a>
          </div></div>
          <div class="tl-grp"><span class="tl-grp-cap">OBS feed</span><div class="tl-grp-btns">
            <button class="cf-ico-btn tl-copy" data-url="${tlEsc(p.obsUrl)}" data-kind="obs" title="Copy the OBS browser-source view link">${svgIcon('copy')}<span class="cf-ico-lbl">View</span></button>
          </div></div>
          ${audioBlock}
          <div class="talent-qr" hidden><img alt="Join QR for ${tlEsc(p.name)}" src="${VDO_API}/api/vdo/qr?text=${join}"><span class="talent-qr-cap">Scan to join as <b>${tlEsc(p.name) || p.streamId}</b></span></div>
        </div>
      </div>
    </div>
  </div>`;
}
// Read a talent row's per-player audio controls and push them to the server.
function tlSendPlayerAudio(row) {
  if (!row) return;
  const vol = parseInt(row.querySelector('.tl-a-vol')?.value, 10);
  const pan = parseInt(row.querySelector('.tl-a-pan')?.value, 10) || 0;
  const mono = !!row.querySelector('.tl-a-mono')?.checked;
  const audio = {};
  if (Number.isFinite(vol) && vol !== 100) audio.volume = vol;
  if (pan) audio.pan = pan;
  if (mono) audio.mono = true;
  const payload = { playerId: row.dataset.pid, audio };
  if (row.dataset.side) payload.side = row.dataset.side;
  else if (row.dataset.teamName) payload.teamName = row.dataset.teamName;
  send('set_player_audio', payload);
  setTimeout(cfLoadTalent, 350);   // refresh OBS feed URLs with the new audio params
}

function cfUpdateListenPill(state) {
  const li = state && state.listenIn;
  const pill = el('cf-listen-active');
  if (pill) {
    if (li && li.active && li.name) {
      pill.innerHTML = svgIcon('headphones') + ' ' + tlEsc(li.name) + (li.scope === 'room' ? ' — ROOM' : '');
      pill.classList.add('ok');
    } else { pill.textContent = 'Nobody on listen-in'; pill.classList.remove('ok'); }
  }
  // Open-feed (debug): let the producer open the exact VDO listen URL to verify what's playing.
  const open = el('cf-listen-open');
  if (open) { open.style.display = (li && li.active && li.url) ? 'block' : 'none'; open.dataset.url = (li && li.url) || ''; }
  // Show-transcription toggle reflects the live state (skip while the producer is interacting with it).
  const capToggle = el('cf-listen-captions');
  if (capToggle && document.activeElement !== capToggle) {
    capToggle.checked = !(state && state.vdo && state.vdo.listenCaptions === false);
  }
  // Green LISTENING state on whichever room/player button is the active feed.
  const activeRoomSide = (li && li.active && li.scope === 'room') ? li.side : null;
  document.querySelectorAll('.tl-listen-room').forEach((b) => {
    const on = !!activeRoomSide && b.dataset.side === activeRoomSide;
    b.classList.toggle('tl-listening', on);
    b.innerHTML = on ? '<span class="live-dot"></span> LISTENING' : svgIcon('headphones') + ' Listen to room';
    b.title = on ? 'Click to stop listening and hide the overlay' : 'Listen to the whole team room';
  });
  const activePid = (li && li.active && li.scope === 'player') ? li.playerId : null;
  const activeSide = li && li.active ? li.side : null;
  document.querySelectorAll('.tl-listen').forEach((b) => {
    const r = b.closest('.talent-row');
    const on = !!activePid && r && r.dataset.pid === activePid && r.dataset.side === activeSide;
    b.classList.toggle('tl-listening', on);
    b.innerHTML = on ? '<span class="live-dot"></span> LISTENING' : svgIcon('headphones') + ' Listen in';
    b.title = on ? 'Click to stop listening and hide the overlay' : 'Listen in on this player';
  });
}
async function tlCopy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const o = btn.innerHTML; btn.classList.add('is-copied');
      btn.innerHTML = svgIcon('check') + '<span class="cf-ico-lbl">Copied</span>';
      setTimeout(() => { btn.innerHTML = o; btn.classList.remove('is-copied'); }, 1200);
    }
  } catch { /* clipboard blocked */ }
}

// Delegated actions inside the talent grid
el('cf-talent-teams')?.addEventListener('click', (e) => {
  const row = e.target.closest('.talent-row');
  // Match Control: move a single player / whole team between rooms (director transfer).
  const moveBtn = e.target.closest('.mc-move-btn');
  if (moveBtn) {
    const mrow = e.target.closest('.mc-player');
    if (mrow) {
      const key = moveBtn.dataset.move;
      cfMovePlayer({ stream: mrow.dataset.stream, name: mrow.dataset.name, side: mrow.dataset.side, homeRoom: mrow.dataset.room }, key);
      // Interview → also set this player as the spotlight-desk interviewee (right cam); Return clears it.
      if (key === 'interview') send('set_interviewee', { side: mrow.dataset.side, playerId: mrow.dataset.pid });
      else if (key === 'home') send('clear_interviewee', { side: mrow.dataset.side, playerId: mrow.dataset.pid });
    }
    return;
  }
  const teamMoveBtn = e.target.closest('.mc-team-move-btn');
  if (teamMoveBtn) { cfMoveTeam(teamMoveBtn.dataset.side, teamMoveBtn.dataset.teamMove); return; }
  const expandBtn = e.target.closest('.mc-expand');
  if (expandBtn) { const mrow = e.target.closest('.mc-player'); const body = mrow && mrow.querySelector('.mc-p-body'); if (body) { body.hidden = !body.hidden; mrow.classList.toggle('is-open', !body.hidden); } return; }
  // Reset camera to the auto-generated VDO view link (and persist it).
  const camReset = e.target.closest('.mc-cam-reset');
  if (camReset) {
    const inp = camReset.closest('.mc-cam')?.querySelector('.mc-cam-input');
    if (inp) {
      inp.value = inp.dataset.default || '';
      mcSaveCamera(inp);
      const mrow = e.target.closest('.mc-player');
      mrow?.querySelector('.mc-stat-cam')?.classList.toggle('on', !!inp.value.trim());
    }
    return;
  }
  // One-click: use this player's VDO feed as their Rocket League facecam (toggle on/off).
  // Reuses the existing facecam pipeline (save_facecam keyed by name/primaryid) so the RL
  // overlay shows the cam — no trip to the manual facecam grid.
  const rlcam = e.target.closest('.mc-rlcam');
  if (rlcam) {
    const name = rlcam.dataset.pname || '', pid = rlcam.dataset.pid || '', obs = rlcam.dataset.obs || '';
    const on = rlcam.classList.contains('is-on');
    if (on) {
      send('delete_facecam', { name: name || pid });
    } else {
      if (!obs) { if (typeof showToast === 'function') showToast('No VDO feed yet — generate the team room first.', '#c53030'); return; }
      send('save_facecam', { name: name || pid, platform: pid ? 'steam' : 'bot', platformId: pid || null, link: obs });
    }
    rlcam.classList.toggle('is-on', !on);
    rlcam.closest('.mc-player')?.querySelector('.mc-stat-cam')?.classList.toggle('on', !on);
    return;
  }
  // Team-level: link every player's VDO feed as their RL facecam at once.
  const teamRlcam = e.target.closest('.mc-team-rlcam');
  if (teamRlcam) {
    const card = teamRlcam.closest('.mc-team'); let n = 0;
    card?.querySelectorAll('.mc-rlcam').forEach((b) => {
      const obs = b.dataset.obs || ''; if (!obs) return;
      const nm = b.dataset.pname || '', pd = b.dataset.pid || '';
      send('save_facecam', { name: nm || pd, platform: pd ? 'steam' : 'bot', platformId: pd || null, link: obs });
      b.classList.add('is-on');
      b.closest('.mc-player')?.querySelector('.mc-stat-cam')?.classList.add('on'); n++;
    });
    if (typeof showToast === 'function') showToast(n ? `Linked ${n} player cam${n > 1 ? 's' : ''} to RL facecams.` : 'No VDO feeds yet — generate the team room first.', n ? '#22c55e' : '#c53030');
    return;
  }
  const copyBtn = e.target.closest('.tl-copy');
  if (copyBtn) { tlCopy(copyBtn.dataset.url, copyBtn); return; }
  if (e.target.closest('.tl-qr') && row) { const qr = row.querySelector('.talent-qr'); if (qr) qr.hidden = !qr.hidden; return; }
  const listenRoom = e.target.closest('.tl-listen-room');
  if (listenRoom) {
    const li = currentState && currentState.listenIn;
    if (li && li.active && li.scope === 'room' && li.side === listenRoom.dataset.side) send('clear_listen_in');
    else send('set_listen_in', { side: listenRoom.dataset.side, scope: 'room' });
    return;
  }
  const listenPlayer = e.target.closest('.tl-listen');
  if (listenPlayer && row && row.dataset.side) {
    const li = currentState && currentState.listenIn;
    if (li && li.active && li.scope === 'player' && li.side === row.dataset.side && li.playerId === row.dataset.pid) send('clear_listen_in');
    else send('set_listen_in', { side: row.dataset.side, playerId: row.dataset.pid });
    return;
  }
  const regen = e.target.closest('.talent-regen');
  if (regen) {
    appConfirm("Get a new room for this team? Anyone already connected with the current link — players or casters — will be cut off and need the new invite link to rejoin.", 'New room', true).then((ok) => {
      if (!ok) return;
      send('generate_team_vdo', { side: regen.dataset.side, regenerate: true });
      setTimeout(cfLoadTalent, 350);
    });
    return;
  }
  const genSaved = e.target.closest('.talent-gen-saved');
  if (genSaved) { send('generate_saved_team_vdo', { teamName: genSaved.dataset.teamName }); setTimeout(cfLoadTalent, 500); return; }
  const regenSaved = e.target.closest('.talent-regen-saved');
  if (regenSaved) {
    appConfirm("Get a new room for this team? Anyone already connected with the current link will be cut off and need the new invite link to rejoin.", 'New room', true).then((ok) => {
      if (!ok) return;
      send('generate_saved_team_vdo', { teamName: regenSaved.dataset.teamName, regenerate: true });
      setTimeout(cfLoadTalent, 500);
    });
    return;
  }
  if (e.target.id === 'talent-gen-all-btn' || e.target.closest('#talent-gen-all-btn')) {
    send('generate_saved_team_vdo', {}); setTimeout(cfLoadTalent, 600); return;
  }
});

// Stream-ID override → re-resolve that player's links
el('cf-talent-teams')?.addEventListener('change', (e) => {
  const row = e.target.closest('.talent-row'); if (!row) return;
  const sid = e.target.closest('.talent-sid');
  if (sid) {
    if (row.dataset.side) {
      send('set_player_stream_id', { side: row.dataset.side, playerId: row.dataset.pid, streamId: sid.value });
    } else if (row.dataset.teamName) {
      send('set_saved_team_player_stream_id', { teamName: row.dataset.teamName, playerId: row.dataset.pid, streamId: sid.value });
    }
    setTimeout(cfLoadTalent, 350);
    return;
  }
  // Match Control: inline camera URL — keyed to this player's name/ID (defaults to VDO view link).
  const camInput = e.target.closest('.mc-cam-input');
  if (camInput) { mcSaveCamera(camInput); return; }
  // Link the camera to a specific in-game player (RL roster) → that player's overlay statcard cam.
  const ingameSel = e.target.closest('.mc-ingame-sel');
  if (ingameSel) {
    const mrow = e.target.closest('.mc-player'); if (!mrow) return;
    const inName = ingameSel.value;
    const link = (mrow.querySelector('.mc-cam-input')?.value || '').trim();
    if (inName && link) {
      const pl = (currentState.players || []).find((x) => x && x.name === inName);
      const pid = pl ? (pl.primaryid || pl.id || '') : '';
      send('save_facecam', { name: inName, platform: (pid ? 'steam' : 'bot'), platformId: pid || null, link });
      mrow.querySelector('.mc-cam-dot')?.classList.add('on');
      const sc = mrow.querySelector('.mc-stat-cam'); if (sc) { sc.classList.add('on'); sc.dataset.camConfig = '1'; }
    }
    return;
  }
  const camSlot = e.target.closest('.tl-cam-slot');
  if (camSlot) {
    const slot = parseInt(camSlot.value, 10);
    if (slot >= 1 && slot <= 5) {
      if (row.dataset.side) {
        send('assign_talent_cam', { side: row.dataset.side, playerId: row.dataset.pid, slot });
      } else if (row.dataset.teamName) {
        send('assign_talent_cam', { teamName: row.dataset.teamName, playerId: row.dataset.pid, slot });
      }
      setTimeout(cfLoadTalent, 350);
    } else if (slot === 0) {
      // "Set as CAM…" re-selected: clear the player-cam assignment if this row held it.
      const pc = currentState?.casters?.playerCam;
      if (pc && pc.playerId === row.dataset.pid) send('clear_player_cam');
      setTimeout(cfLoadTalent, 350);
    }
    return;
  }
  // Per-player audio controls (volume / pan / mono).
  if (e.target.closest('.tl-a-vol, .tl-a-pan, .tl-a-mono')) { tlSendPlayerAudio(row); return; }
});
el('cf-talent-generate')?.addEventListener('click', () => { send('generate_team_vdo', {}); setTimeout(cfLoadTalent, 350); });
el('cf-talent-refresh')?.addEventListener('click', cfLoadTalent);
el('cf-listen-clear')?.addEventListener('click', () => send('clear_listen_in'));
el('cf-listen-open')?.addEventListener('click', () => { const u = el('cf-listen-open')?.dataset.url; if (u) window.open(u, '_blank', 'noopener'); });
el('cf-listen-captions')?.addEventListener('change', function () { send('set_listen_captions', { on: this.checked }); });

// VDO.ninja settings now live on the Integrations page — jump there from the Camera Feeds tab,
// and (re)load the saved settings whenever the VDO integration panel is opened.
el('cf-goto-vdo-settings')?.addEventListener('click', () => {
  // There is no global switchTab — navigation is clicking the sidebar tab button.
  document.querySelector('.tab-btn[data-tab="integrations"]')?.click();
  try { _intAppFilter = 'vdo'; } catch (_) {}   // back bar reads "VDO.Ninja"
  if (typeof window._intShowTab === 'function') window._intShowTab('cameras');
  if (typeof cfLoadVdoSettings === 'function') cfLoadVdoSettings();
});

// ── VDO.ninja settings (localStorage; feeds every link the page builds) ──
const CF_VDO_KEY = 'ne_vdo_settings';
const CF_VDO_DEFAULTS = { base: 'https://vdo.ninja', room: '', viewParams: '', pushParams: '', cleanOutput: true, transparent: false, cover: true, volume: 100, bitrate: '', codec: '', buffer: '',
  // Audio defaults applied to every view/OBS feed (per-caster / per-player can override).
  audioMono: false, audioBitrate: '', audioParams: '' };
function cfVdo() {
  try { return Object.assign({}, CF_VDO_DEFAULTS, JSON.parse(localStorage.getItem(CF_VDO_KEY) || '{}')); }
  catch { return Object.assign({}, CF_VDO_DEFAULTS); }
}
// Turn a normalized audio object into a VDO.ninja URL param string (no leading '&').
// Fields: volume 0–200, pan −100..+100 (0 = centre → &panning 0–180), mono, noaudio, ab (kbps),
// params (free-text extra VDO audio params, e.g. "&compressor&limiter").
function vdoAudioParams(a) {
  a = a || {};
  const out = [];
  const vol = a.volume;
  if (vol != null && vol !== '' && +vol !== 100) out.push('volume=' + Math.max(0, Math.min(200, parseInt(vol, 10) || 0)));
  if (a.mono) out.push('mono');
  if (a.noaudio) out.push('noaudio');
  if (a.ab !== undefined && a.ab !== null && a.ab !== '') out.push('ab=' + (parseInt(a.ab, 10) || 0));
  if (a.pan != null && a.pan !== '' && +a.pan !== 0) {
    const deg = Math.round((Math.max(-100, Math.min(100, +a.pan)) + 100) / 200 * 180);   // −100→0(L) … 0→90(C) … 100→180(R)
    out.push('panning=' + deg);
  }
  if (a.params) out.push(String(a.params).replace(/^&+/, '').trim());
  return out.filter(Boolean).join('&');
}
// Global audio defaults from the saved VDO settings.
function cfVdoAudioDefaults() {
  const v = cfVdo();
  return { volume: v.volume, mono: !!v.audioMono, ab: v.audioBitrate || '', pan: 0, params: v.audioParams || '' };
}
function cfLoadVdoSettings() {
  const v = cfVdo();
  const set = (id, val) => { const e = el(id); if (e && e.type !== 'checkbox') e.value = val; };
  set('cf-vdo-base', v.base); set('cf-vdo-room', v.room); set('cf-vdo-params', v.viewParams); set('cf-vdo-push', v.pushParams);
  if (el('cf-vdo-clean')) el('cf-vdo-clean').checked = v.cleanOutput !== false;
  if (el('cf-vdo-transparent')) el('cf-vdo-transparent').checked = !!v.transparent;
  if (el('cf-vdo-cover')) el('cf-vdo-cover').checked = v.cover !== false;
  if (el('cf-vdo-volume')) { el('cf-vdo-volume').value = v.volume ?? 100; const lab = el('cf-vdo-volume-val'); if (lab) lab.textContent = v.volume ?? 100; }
  set('cf-vdo-bitrate', v.bitrate || ''); set('cf-vdo-buffer', v.buffer || '');
  if (el('cf-vdo-codec')) el('cf-vdo-codec').value = v.codec || '';
  // Audio defaults
  set('cf-vdo-ab', v.audioBitrate || ''); set('cf-vdo-audioparams', v.audioParams || '');
  if (el('cf-vdo-mono')) el('cf-vdo-mono').checked = !!v.audioMono;
  // Caption language is server-side (Talent Rooms config), not localStorage.
  if (el('cf-vdo-lang')) el('cf-vdo-lang').value = (currentState?.vdo?.lang) || 'en-US';
}
el('cf-vdo-volume')?.addEventListener('input', function () { const lab = el('cf-vdo-volume-val'); if (lab) lab.textContent = this.value; });
el('cf-vdo-save')?.addEventListener('click', () => {
  const v = {
    base: (el('cf-vdo-base').value || 'https://vdo.ninja').trim().replace(/\/+$/, ''),
    room: el('cf-vdo-room').value.trim(),
    viewParams: el('cf-vdo-params').value.trim(),
    pushParams: el('cf-vdo-push').value.trim(),
    cleanOutput: !!el('cf-vdo-clean')?.checked,
    transparent: !!el('cf-vdo-transparent')?.checked,
    cover: !!el('cf-vdo-cover')?.checked,
    volume: parseInt(el('cf-vdo-volume')?.value, 10) || 0,
    bitrate: (el('cf-vdo-bitrate')?.value || '').trim(),
    codec: el('cf-vdo-codec')?.value || '',
    buffer: (el('cf-vdo-buffer')?.value || '').trim(),
    audioMono: !!el('cf-vdo-mono')?.checked,
    audioBitrate: (el('cf-vdo-ab')?.value || '').trim(),
    audioParams: (el('cf-vdo-audioparams')?.value || '').trim(),
  };
  try { localStorage.setItem(CF_VDO_KEY, JSON.stringify(v)); } catch {}
  // Mirror to the server-side config that powers the Talent Rooms workflow (rooms, join links,
  // OBS feeds, listen-in). The caption language field is talent-only, so preserve it.
  send('set_vdo_config', {
    base: v.base, cleanOutput: v.cleanOutput, transparent: v.transparent, cover: v.cover,
    volume: v.volume, bitrate: v.bitrate, codec: v.codec, buffer: v.buffer,
    audioMono: v.audioMono, audioBitrate: v.audioBitrate, audioParams: v.audioParams,
    viewParams: v.viewParams, pushParams: v.pushParams,
    lang: (el('cf-vdo-lang')?.value || currentState?.vdo?.lang || 'en-US')
  });
  const s = el('cf-vdo-status'); if (s) { s.textContent = 'Saved. Caster, share + talent-room links will use these settings.'; s.className = 'ev-status ev-ok'; }
  renderCfShares();
});

// Build a clean VDO.ninja VIEW url from a stream id (or pass a full URL through unchanged).
function buildVdoView(idOrUrl, opts) {
  opts = opts || {};
  const v = cfVdo();
  let s = (idOrUrl || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) {
    // Pasted full URL → keep it, but still ensure it fills the frame + autoplays.
    if (v.cover !== false && !/[?&]cover\b/i.test(s)) s += '&cover';
    if (!/[?&]autostart\b/i.test(s)) s += '&autostart';
    return s;
  }
  const room = (opts.room || '').trim() || v.room;
  let url = `${v.base}/?view=${encodeURIComponent(s)}`;
  if (room) url += `&room=${encodeURIComponent(room)}`;
  if (opts.solo) url += '&solo';             // isolate just this feed (one source = one OBS audio fader)
  if (v.cleanOutput !== false) url += '&cleanoutput';
  if (v.transparent) url += '&transparent';
  if (v.cover !== false) url += '&cover';   // fill the frame (crop to edges, no letterbox)
  url += '&autostart';                       // play immediately, no click needed
  // Audio: global defaults, with an optional per-feed override (opts.audio) or legacy opts.volume.
  const audio = Object.assign(cfVdoAudioDefaults(),
    (opts.volume != null && opts.volume !== '') ? { volume: opts.volume } : {},
    opts.audio || {});
  const aStr = vdoAudioParams(audio);
  if (aStr) url += '&' + aStr;
  if (v.codec) url += `&codec=${v.codec}`;
  if (v.bitrate) url += `&bitrate=${parseInt(v.bitrate, 10) || 0}`;
  if (v.buffer) url += `&buffer=${parseInt(v.buffer, 10) || 0}`;
  if (v.viewParams) url += (v.viewParams[0] === '&' ? '' : '&') + v.viewParams.replace(/^&/, '');
  return url;
}


// ── Unified talent-group cards (Casters · Guests · Observers) ────────────────
// Teams-style cards fed by the shared group rooms from /api/vdo/links. One renderer for all
// three so they match the Teams UI (room header + collapsible member rows, connection pulse,
// Join/View/QR links, audio). Members come from the caster library, filtered by kind.
const _CF_GROUP_META = {
  casters:   { label: 'HOSTS',     color: '#e83a8b', container: 'cf-casters-group' },
  guests:    { label: 'LOBBY',     color: '#a855f7', container: 'cf-guests-group' },
  observers: { label: 'OBSERVERS', color: '#2dd4bf', container: 'cf-observers-group' },
};
const _CF_SOCIAL_LABEL = { x: 'X', twitch: 'Twitch', youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok', discord: 'Discord', kick: 'Kick', facebook: 'Facebook', other: 'Link' };
const _cfGroupSearch = { casters: '', guests: '', observers: '' };
// Hide member rows that don't match the per-group search query (filters the library list).
function cfFilterGroup(key) {
  const meta = _CF_GROUP_META[key]; if (!meta) return;
  const wrap = el(meta.container); if (!wrap) return;
  const q = (_cfGroupSearch[key] || '').trim();
  NESearch.rankNodes(wrap.querySelectorAll('.cf-grp-row'), q,
    (row) => [{ text: row.dataset.name || '', weight: 2 }, { text: row.dataset.search || '', bag: true }]);
}

// The member LIST comes from the broadcast caster library (so adds/edits show instantly and don't
// depend on the /api/vdo/links round-trip), merged with the server group's per-member feed URLs.
function cfGroupMembersFor(key, serverGroup) {
  const lib = (typeof currentState !== 'undefined' && currentState.casters && currentState.casters.library) || [];
  const pred = key === 'guests' ? (p => p.kind === 'host')
            : key === 'observers' ? (p => p.kind === 'observer')
            : (p => p.kind !== 'host' && p.kind !== 'observer');
  const byId = {};
  ((serverGroup && serverGroup.members) || []).forEach((sm) => { if (sm.libraryId) byId[sm.libraryId] = sm; });
  return lib.filter(pred).map((p) => {
    const sm = byId[p.id] || {};
    return {
      libraryId: p.id, name: p.name || '', handle: p.handle || '', role: p.role || '', social: p.social || 'none',
      camUrl: p.camUrl || '', audio: p.audio || null,
      streamId: sm.streamId || '',
      joinUrl: sm.joinUrl || '',
      obsUrl: p.camUrl ? p.camUrl : (sm.obsUrl || ''),   // custom view link overrides the auto feed
    };
  }).sort((a, b) => (a.name || a.handle || '').localeCompare(b.name || b.handle || '', undefined, { sensitivity: 'base' }));   // Caster Desk: A–Z
}

async function cfLoadGroups() {
  let d = {};
  try { d = await (await fetch(`${VDO_API}/api/vdo/links`)).json(); } catch (e) { d = {}; }
  _cfDirectorData = d;   // keep Director data + the per-member "Move to" room options fresh
  if (typeof cfSyncDirectorConsoles === 'function') cfSyncDirectorConsoles();   // pick up group rooms live
  const groups = d.groups || {};
  Object.keys(_CF_GROUP_META).forEach((key) => {
    const meta = _CF_GROUP_META[key];
    const wrap = el(meta.container); if (!wrap || _editingInside(wrap)) return;
    const sg = groups[key] || {};
    const g = { name: meta.label, room: sg.room || '', members: cfGroupMembersFor(key, sg) };
    wrap.innerHTML = cfGroupCard(g, key, meta.color);
    cfFilterGroup(key);   // re-apply any active search filter after the re-render
  });
  cfWireGroupCards();
  if (typeof cfUpdateConnStatus === 'function') cfUpdateConnStatus();
}

function cfGroupCard(g, key, color) {
  const members = g.members || [];
  const addLbl = key === 'guests' ? 'guest' : (key === 'observers' ? 'observer' : 'caster');
  const rows = members.length
    ? members.map((m) => cfGroupMemberRow(m, g.room, key)).join('')
    : `<div class="talent-empty">No ${addLbl}s yet — click <b>+ Add</b> above. Their shared room is created automatically.</div>`;
  const roomTag = g.room
    ? `<span class="talent-room" title="Shared ${tlEsc(g.name)} room — everyone in this group joins it">${tlEsc(g.room)}</span>`
    : `<span class="talent-room" style="opacity:.55" title="The room is created automatically once a member is added">no room yet</span>`;
  return `<div class="mc-team talent-team cf-group-team" style="--tc:${color}" data-group="${key}" data-room="${tlEsc(g.room || '')}">
    <div class="mc-team-head talent-team-head">
      <span class="mc-team-conn mc-stat" data-conn="0" title="Room connection — start Director monitoring to detect"></span>
      <span class="mc-team-name talent-team-name">${tlEsc(g.name)}</span>
      ${roomTag}
      <div class="mc-team-tools">
        <input type="search" class="input-text cf-grp-search" data-group="${key}" placeholder="Search ${addLbl}s…" value="${tlEsc(_cfGroupSearch[key] || '')}" title="Filter the ${addLbl} library">
        <button class="cf-ico-btn cf-ico-add cf-grp-add" data-group="${key}" title="Add a ${addLbl}">${svgIcon('plus')}<span class="cf-ico-lbl">Add</span></button>
        <button class="cf-ico-btn cf-grp-regen" data-group="${key}" title="New room + password (invalidates old links)">${svgIcon('refresh')}</button>
      </div>
    </div>
    <!-- Fallback inline quick-add — the "+ Add" button opens the full crew dialog (openCrewAdd);
         this stays only as a no-JS fallback. -->
    <div class="cf-grp-add-form" data-group="${key}" hidden>
      <input class="input-text cf-ga-name" placeholder="Name" maxlength="40">
      <input class="input-text cf-ga-handle" placeholder="@handle (optional)" maxlength="80">
      <button class="btn btn-primary btn-xs cf-ga-save">Add ${addLbl}</button>
      <button class="btn btn-ghost btn-xs cf-ga-cancel">Cancel</button>
    </div>
    <div class="mc-players talent-rows">${rows}</div>
  </div>`;
}

// Room <option> list for the per-member "Move to" dropdown — every monitored room except the
// member's current one (Interview/Desk, team rooms, the three group rooms).
function cfRoomOptions(excludeRoom) {
  const d = _cfDirectorData || {};
  const opts = [];
  if (d.casterRoom && d.casterRoom.room) opts.push([d.casterRoom.room, 'Interview / Desk']);
  ['blue', 'orange'].forEach((s) => { const t = d.teams && d.teams[s]; if (t && t.room) opts.push([t.room, t.name || s]); });
  const G = d.groups || {};
  [['casters', 'HOSTS'], ['observers', 'OBSERVERS'], ['guests', 'LOBBY']].forEach(([k, lbl]) => { const g = G[k]; if (g && g.room) opts.push([g.room, g.name || lbl]); });
  return opts.filter(([room]) => room && room !== excludeRoom).map(([room, label]) => `<option value="${tlEsc(room)}">${tlEsc(label)}</option>`).join('');
}

function cfGroupMemberRow(m, groupRoom, key) {
  const a = m.audio || {};
  const sid = m.streamId || '';
  const join = encodeURIComponent(m.joinUrl || '');
  const socialTxt = (m.social && m.social !== 'none') ? (_CF_SOCIAL_LABEL[m.social] || 'Link') : '';
  const sub = [m.handle ? '@' + m.handle : '', socialTxt].filter(Boolean).join(' · ');
  const socialOpts = ['none'].concat(Object.keys(_CF_SOCIAL_LABEL)).map((v) => `<option value="${v}"${(m.social || 'none') === v ? ' selected' : ''}>${v === 'none' ? 'No social' : (_CF_SOCIAL_LABEL[v] || v)}</option>`).join('');
  const audioBlock = `<details class="talent-audio"${(a.volume != null || a.pan || a.mono) ? ' open' : ''}><summary>Audio</summary><div class="talent-audio-line"><label title="Volume 0–200">vol<input type="number" class="gm-a-vol" min="0" max="200" step="5" value="${a.volume != null ? a.volume : 100}"></label><label title="Stereo pan">pan<input type="range" class="gm-a-pan" min="-100" max="100" step="5" value="${a.pan != null ? a.pan : 0}"></label><label><input type="checkbox" class="gm-a-mono"${a.mono ? ' checked' : ''}> mono</label></div></details>`;
  // Casters get a spot selector (Off air / Caster 1–4) — the chosen spot maps directly to the
  // overlay position via state.casters.lineup (resolved to the overlay's caster list server-side).
  let slotSel = '';
  if (key === 'casters') {
    const lineup = (typeof currentState !== 'undefined' && currentState.casters && currentState.casters.lineup) || [];
    const ent = lineup.find((e) => e.libraryId === m.libraryId);
    const curSlot = ent ? (ent.slot || 0) : 0;
    slotSel = `<select class="input-select gm-slot" title="Assign this caster to an overlay spot">
      <option value="0"${curSlot === 0 ? ' selected' : ''}>Off air</option>
      ${[1, 2, 3, 4].map((n) => `<option value="${n}"${curSlot === n ? ' selected' : ''}>Caster ${n}</option>`).join('')}
    </select>`;
  }
  const searchHay = ((m.name || '') + ' ' + (m.handle || '') + ' ' + (m.role || '')).toLowerCase();
  return `<div class="talent-row mc-player cf-grp-row" draggable="true" data-stream="${tlEsc(sid)}" data-libid="${tlEsc(m.libraryId || '')}" data-name="${tlEsc(m.name || '')}" data-room="${tlEsc(groupRoom || '')}" data-search="${tlEsc(searchHay)}">
    <div class="mc-p-line">
      <span class="mc-stats">
        <span class="mc-stat mc-stat-conn" data-conn="0" title="Connection — Director monitoring detects this"></span>
        <span class="mc-stat mc-stat-cam" title="Camera — pulses when monitoring sees their video">${svgIcon('camera')}</span>
      </span>
      <span class="mc-p-name">${tlEsc(m.name || m.handle || '—')}${m.role ? ` <span class="cf-grp-role">${tlEsc(m.role)}</span>` : ''}</span>
      ${sub ? `<span class="cf-grp-sub">${tlEsc(sub)}</span>` : ''}
      <span class="mc-p-quick">
        ${slotSel}
        <button class="cf-ico-btn tl-copy" data-url="${tlEsc(m.joinUrl)}" title="Copy the invite / join link"${m.joinUrl ? '' : ' disabled'}>${svgIcon('userplus')}</button>
        <button class="cf-ico-btn tl-copy" data-url="${tlEsc(m.obsUrl)}" title="Copy the OBS view link"${m.obsUrl ? '' : ' disabled'}>${svgIcon('copy')}</button>
        <button class="cf-ico-btn gm-move-intv" title="Move into the Interview / Desk room">${svgIcon('mic')}</button>
        <button class="cf-ico-btn mc-expand" title="Edit profile · move to another room · audio">${svgIcon('chevdown')}</button>
      </span>
    </div>
    <div class="mc-p-body gm-body" hidden>
      <div class="gm-sect">
        <div class="gm-sect-row"><span class="gm-sect-lbl">Name</span><input class="input-text gm-e-name" placeholder="Display name" value="${tlEsc(m.name || '')}" maxlength="40"></div>
        <div class="gm-sect-row"><span class="gm-sect-lbl">Handle</span><input class="input-text gm-e-handle" placeholder="@handle" value="${tlEsc(m.handle || '')}" maxlength="80"></div>
        <div class="gm-sect-row"><span class="gm-sect-lbl">Social</span><select class="input-select gm-e-social">${socialOpts}</select></div>
        <div class="gm-sect-row"><span class="gm-sect-lbl">Role</span><input class="input-text gm-e-role" placeholder="Play-by-Play, Host, Analyst…" value="${tlEsc(m.role || '')}" maxlength="40" list="cf-role-dl"></div>
        <div class="gm-sect-row"><span class="gm-sect-lbl" title="Paste a VDO.ninja view link to override the auto-generated room feed (e.g. an external source)">Custom view</span><input class="input-text gm-e-cam" placeholder="Auto — paste a VDO view link to override" value="${tlEsc(m.camUrl || '')}" maxlength="1000" spellcheck="false">${m.camUrl ? '<span class="gm-override-tag">OVERRIDE</span>' : ''}</div>
        <div class="gm-sect-actions"><span class="gm-save-note">Changes save automatically.</span></div>
      </div>
      <div class="gm-sect">
        <div class="gm-sect-row"><span class="gm-sect-lbl">Move to</span><select class="input-select gm-move-sel"><option value="">Move to a room…</option>${cfRoomOptions(groupRoom)}</select><span class="gm-move-hint">Director must be running.</span></div>
        <div class="gm-sect-row"><span class="gm-sect-lbl">Links</span><span class="tl-grp-btns">
          <button class="cf-ico-btn tl-copy" data-url="${tlEsc(m.joinUrl)}"${m.joinUrl ? '' : ' disabled'} title="Copy invite/join link">${svgIcon('userplus')}<span class="cf-ico-lbl">Invite</span></button>
          <button class="cf-ico-btn tl-copy" data-url="${tlEsc(m.obsUrl)}"${m.obsUrl ? '' : ' disabled'} title="Copy OBS view link">${svgIcon('copy')}<span class="cf-ico-lbl">View</span></button>
          <button class="cf-ico-btn gm-qr"${m.joinUrl ? '' : ' disabled'} title="Show join QR">${svgIcon('qr')}</button>
          ${m.joinUrl ? `<a class="cf-ico-btn" href="${tlEsc(m.joinUrl)}" target="_blank" rel="noopener" title="Open join link">${svgIcon('external')}</a>` : ''}
        </span></div>
        <div class="gm-sect-row"><span class="gm-sect-lbl">Audio</span><div class="gm-audio-inline"><label title="Volume 0–200">vol<input type="number" class="gm-a-vol" min="0" max="200" step="5" value="${a.volume != null ? a.volume : 100}"></label><label title="Stereo pan">pan<input type="range" class="gm-a-pan" min="-100" max="100" step="5" value="${a.pan != null ? a.pan : 0}"></label><label><input type="checkbox" class="gm-a-mono"${a.mono ? ' checked' : ''}> mono</label></div></div>
        ${m.joinUrl ? `<div class="talent-qr" hidden><img alt="Join QR" src="${VDO_API}/api/vdo/qr?text=${join}"><span class="talent-qr-cap">Scan to join as <b>${tlEsc(m.name || m.handle)}</b></span></div>` : ''}
      </div>
    </div>
  </div>`;
}

// Delegated interactions for the three group cards (copy, expand, QR, audio, room regen).
function cfWireGroupCards() {
  Object.values(_CF_GROUP_META).forEach((meta) => {
    const wrap = el(meta.container);
    if (!wrap || wrap._grpWired) return; wrap._grpWired = true;
    wrap.addEventListener('click', (e) => {
      const copyBtn = e.target.closest('.tl-copy');
      if (copyBtn) { if (copyBtn.dataset.url) tlCopy(copyBtn.dataset.url, copyBtn); return; }
      const exp = e.target.closest('.mc-expand');
      if (exp) { const row = e.target.closest('.mc-player'); const b = row && row.querySelector('.mc-p-body'); if (b) { b.hidden = !b.hidden; row.classList.toggle('is-open', !b.hidden); } return; }
      const qr = e.target.closest('.gm-qr');
      if (qr) { const row = e.target.closest('.mc-player'); const box = row && row.querySelector('.talent-qr'); if (box) box.hidden = !box.hidden; return; }
      const regen = e.target.closest('.cf-grp-regen');
      if (regen) {
        appConfirm("Get a new room for this whole group? Anyone already connected with the current link will be cut off from the rest — they'll need the new invite link to rejoin.", 'New room', true).then((ok) => {
          if (!ok) return;
          send('regenerate_group_room', { group: regen.dataset.group });
          setTimeout(cfLoadGroups, 400);
        });
        return;
      }
      // Quick "→ Interview": move this member into the Interview / Desk room.
      const mvIntv = e.target.closest('.gm-move-intv');
      if (mvIntv) {
        const row = e.target.closest('.cf-grp-row'); if (!row) return;
        const target = (typeof cfRoomId === 'function') ? cfRoomId('interview', '') : '';
        const ok = cfMovePlayerToRoom({ stream: row.dataset.stream, name: row.dataset.name, side: '', homeRoom: row.dataset.room }, target, 'Interview / Desk');
        if (typeof showToast === 'function') showToast(ok ? `Moving ${row.dataset.name || 'them'} → Interview / Desk…` : 'Start Director monitoring first (Director Control Center below).', ok ? '#22c55e' : '#f59e0b');
        return;
      }
      // + Add: reveal the inline add form on this card.
      const addBtn = e.target.closest('.cf-grp-add');
      if (addBtn) {
        // Open the SAME full crew add form (country autofill + all questions) preset to this group,
        // instead of a separate minimal inline form — one identical form for casters/hosts/observers.
        const grp = addBtn.dataset.group || (e.target.closest('.cf-grp-add-form')?.dataset.group) || 'casters';
        if (typeof window.openCrewAdd === 'function') { window.openCrewAdd(grp); return; }
        const card = e.target.closest('.cf-group-team'); const form = card && card.querySelector('.cf-grp-add-form');
        if (form) { form.hidden = !form.hidden; if (!form.hidden) form.querySelector('.cf-ga-name')?.focus(); }
        return;
      }
      const gaCancel = e.target.closest('.cf-ga-cancel');
      if (gaCancel) { const f = e.target.closest('.cf-grp-add-form'); if (f) f.hidden = true; return; }
      const gaSave = e.target.closest('.cf-ga-save');
      if (gaSave) {
        const form = e.target.closest('.cf-grp-add-form'); if (!form) return;
        const grp = form.dataset.group;
        const name = (form.querySelector('.cf-ga-name')?.value || '').trim();
        const handle = (form.querySelector('.cf-ga-handle')?.value || '').trim();
        if (!name && !handle) { form.querySelector('.cf-ga-name')?.focus(); return; }
        const kind = grp === 'guests' ? 'host' : (grp === 'observers' ? 'observer' : 'caster');
        send('save_caster_to_library', { name, handle, kind });
        form.querySelector('.cf-ga-name').value = ''; form.querySelector('.cf-ga-handle').value = '';
        form.hidden = true;
        setTimeout(cfLoadGroups, 300);
        return;
      }
    });
    // Drag a member onto a Director console tab to transfer them into that room.
    wrap.addEventListener('dragstart', (e) => {
      // Don't start a drag when the user is using a control (slot select, inputs, buttons).
      if (e.target.closest('select, input, button, a, .mc-p-body')) { e.preventDefault(); return; }
      const row = e.target.closest('.cf-grp-row'); if (!row) return;
      e.dataTransfer.setData('text/plain', JSON.stringify({ stream: row.dataset.stream || '', name: row.dataset.name || '', side: '', homeRoom: row.dataset.room || '' }));
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    wrap.addEventListener('dragend', (e) => { const row = e.target.closest('.cf-grp-row'); if (row) row.classList.remove('dragging'); });
    // Search box — filter this group's library rows live (re-render is skipped while focused here).
    wrap.addEventListener('input', (e) => {
      const s = e.target.closest('.cf-grp-search'); if (!s) return;
      _cfGroupSearch[s.dataset.group] = s.value;
      cfFilterGroup(s.dataset.group);
    });
    wrap.addEventListener('change', (e) => {
      // Move-to-room: transfer this person into the chosen room (via the Director's IFrame API).
      const moveSel = e.target.closest('.gm-move-sel');
      if (moveSel) {
        const room = moveSel.value; const row = e.target.closest('.cf-grp-row');
        if (room && row) {
          const label = moveSel.options[moveSel.selectedIndex]?.text || 'room';
          const ok = cfMovePlayerToRoom({ stream: row.dataset.stream, name: row.dataset.name, side: '', homeRoom: row.dataset.room }, room, label);
          if (typeof showToast === 'function') showToast(ok ? `Moving ${row.dataset.name || 'them'} → ${label}…` : 'Start Director monitoring first (Director Control Center below).', ok ? '#22c55e' : '#f59e0b');
        }
        moveSel.value = '';
        return;
      }
      // Assign a caster to an overlay spot (Off air / Caster 1–4). Swaps if the spot is taken.
      const slotSel = e.target.closest('.gm-slot');
      if (slotSel) {
        const row = e.target.closest('.cf-grp-row'); const id = row && row.dataset.libid; if (!id) return;
        const newSlot = parseInt(slotSel.value, 10) || 0;
        let lineup = ((currentState.casters && currentState.casters.lineup) || []).map((x) => ({ ...x }));
        if (newSlot === 0) {
          lineup = lineup.filter((x) => x.libraryId !== id);
        } else {
          const occ = lineup.find((x) => x.slot === newSlot && x.libraryId !== id);
          let mine = lineup.find((x) => x.libraryId === id);
          const oldSlot = mine ? mine.slot : 0;
          if (mine) { mine.slot = newSlot; }
          else { lineup.push({ libraryId: id, slot: newSlot, roomId: '', streamId: row.dataset.stream || '' }); }
          if (occ) { if (oldSlot) occ.slot = oldSlot; else lineup = lineup.filter((x) => x !== occ); }   // swap, or bump off
        }
        send('set_caster_lineup', { lineup });
        return;
      }
      // Auto-save profile edits as they change (name / @handle / social / role / custom view link).
      if (e.target.closest('.gm-e-name, .gm-e-handle, .gm-e-social, .gm-e-role, .gm-e-cam')) {
        const row = e.target.closest('.cf-grp-row'); const id = row && row.dataset.libid; if (!id) return;
        send('save_caster_to_library', {
          id,
          name: (row.querySelector('.gm-e-name')?.value || '').trim(),
          handle: (row.querySelector('.gm-e-handle')?.value || '').trim(),
          social: row.querySelector('.gm-e-social')?.value || 'none',
          role: (row.querySelector('.gm-e-role')?.value || '').trim(),
          camUrl: (row.querySelector('.gm-e-cam')?.value || '').trim(),
        });
        return;
      }
      if (!e.target.closest('.gm-a-vol, .gm-a-pan, .gm-a-mono')) return;
      const row = e.target.closest('.cf-grp-row'); if (!row) return;
      const id = row.dataset.libid; if (!id) return;
      const vol = parseInt(row.querySelector('.gm-a-vol')?.value, 10);
      const pan = parseInt(row.querySelector('.gm-a-pan')?.value, 10) || 0;
      const mono = !!row.querySelector('.gm-a-mono')?.checked;
      const audio = {};
      if (Number.isFinite(vol) && vol !== 100) audio.volume = vol;
      if (pan) audio.pan = pan;
      if (mono) audio.mono = true;
      send('set_library_audio', { id, audio });
    });
  });
}

// ── Gameplay: screenshare / observer push links ──
const CF_SHARES_KEY = 'ne_cf_shares';
function cfShares() { try { return JSON.parse(localStorage.getItem(CF_SHARES_KEY) || '[]'); } catch { return []; } }
function cfSaveShares(l) { try { localStorage.setItem(CF_SHARES_KEY, JSON.stringify(l)); } catch {} }
function cfSlug(s) { return ((s || 'feed').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12)) || 'feed'; }
function renderCfShares() {
  const wrap = el('cf-share-list'); if (!wrap) return;
  const v = cfVdo(); const list = cfShares();
  wrap.innerHTML = '';
  if (!list.length) { wrap.innerHTML = '<div class="ev-empty">No share links yet — create one above and send it to the player / observer.</div>'; return; }
  list.forEach((sh, idx) => {
    const room = v.room ? `&room=${encodeURIComponent(v.room)}` : '';
    let pushUrl = `${v.base}/?push=${sh.streamId}${room}&${sh.screen ? 'screenshare' : 'webcam'}`;
    if (v.codec) pushUrl += `&codec=${v.codec}`;
    if (v.bitrate) pushUrl += `&bitrate=${parseInt(v.bitrate, 10) || 0}`;
    if (v.pushParams) pushUrl += (v.pushParams[0] === '&' ? '' : '&') + v.pushParams.replace(/^&/, '');
    const viewUrl = buildVdoView(sh.streamId, {});
    const card = document.createElement('div'); card.className = 'cf-share-card';
    card.innerHTML = `<div class="cf-share-head"><span class="cf-share-label"></span><span class="cf-share-tag"></span><button class="tp-del" title="Remove">×</button></div>
      <div class="cf-share-line"><span>Send to them</span><input class="input-text" readonly><button class="btn btn-secondary btn-sm">Copy</button></div>
      <div class="cf-share-line"><span>OBS view</span><input class="input-text" readonly><button class="btn btn-secondary btn-sm">Copy</button></div>`;
    card.querySelector('.cf-share-label').textContent = sh.label || 'Feed';
    card.querySelector('.cf-share-tag').textContent = sh.screen ? 'screen' : 'cam';
    const lines = card.querySelectorAll('.cf-share-line');
    lines[0].querySelector('input').value = pushUrl;
    lines[1].querySelector('input').value = viewUrl;
    lines[0].querySelector('button').addEventListener('click', () => { if (navigator.clipboard) navigator.clipboard.writeText(pushUrl); });
    lines[1].querySelector('button').addEventListener('click', () => { if (navigator.clipboard) navigator.clipboard.writeText(viewUrl); });
    card.querySelector('.tp-del').addEventListener('click', () => { const l = cfShares(); l.splice(idx, 1); cfSaveShares(l); renderCfShares(); });
    wrap.appendChild(card);
  });
}
el('cf-share-create')?.addEventListener('click', () => {
  const label = (el('cf-share-label').value || '').trim();
  const screen = !!el('cf-share-screen').checked;
  const streamId = 'ne' + cfSlug(label) + Math.floor(Math.random() * 9000 + 1000);
  const l = cfShares(); l.unshift({ id: streamId, label, screen, streamId }); cfSaveShares(l);
  el('cf-share-label').value = '';
  renderCfShares();
});

// ── Gameplay: stream stations (start.gg) + station mini-HUD links ──
let _cfStationsSig = '';
// start.gg STREAM stations (gameplay subtab). Renamed from renderCfStations to avoid colliding with
// app.js's renderCfStations (the website-Stations → Caster Library bridge, a different feature that
// the render loop calls no-arg — the collision crashed on `data.startgg` when called without data).
function renderCfStreamStations(data) {
  const wrap = el('cf-stations'); if (!wrap) return;
  data = data || (typeof currentState !== 'undefined' ? currentState : null) || {};
  const sg = data.startgg || {};
  const streams = sg.streams || [];
  const queue = sg.queue || [];
  const sub = el('cf-stations-sub'); if (sub) sub.textContent = streams.length ? String(streams.length) : '';
  const sig = JSON.stringify({ streams, q: queue.map((x) => [x.stream, x.teamA, x.teamB, x.live, x.scoreA, x.scoreB, x.round]) });
  if (sig === _cfStationsSig) return;
  _cfStationsSig = sig;
  wrap.innerHTML = '';
  if (!streams.length) { wrap.innerHTML = '<div class="ev-empty">No stream stations — enable the start.gg stream queue (Settings / Dashboard) to pull them.</div>'; return; }
  streams.forEach((name) => {
    const onIt = queue.filter((q) => q.stream === name);
    const liveSet = onIt.find((q) => q.live) || onIt[0];
    const hudUrl = `${CF_OVERLAY_BASE}/ministation.html?stream=${encodeURIComponent(name)}`;
    const card = document.createElement('div'); card.className = 'cf-station-card';
    card.innerHTML = `<div class="cf-station-head"><span class="cf-station-name"></span><span class="cf-station-live"></span></div>
      <div class="cf-station-match"></div>
      <div class="cf-station-acts"><button class="btn btn-secondary btn-sm">Open mini-HUD ↗</button><button class="btn btn-ghost btn-sm">Copy URL</button></div>`;
    card.querySelector('.cf-station-name').textContent = name;
    const liveTag = card.querySelector('.cf-station-live');
    if (liveSet && liveSet.live) { liveTag.textContent = 'LIVE'; liveTag.className = 'cf-station-live on'; }
    card.querySelector('.cf-station-match').textContent = liveSet
      ? `${liveSet.teamA || 'TBD'} vs ${liveSet.teamB || 'TBD'}` + ((liveSet.scoreA != null && liveSet.scoreB != null) ? `  (${liveSet.scoreA}–${liveSet.scoreB})` : '') + (liveSet.round ? '  · ' + liveSet.round : '')
      : 'No match queued';
    const [openBtn, copyBtn] = card.querySelectorAll('.cf-station-acts button');
    openBtn.addEventListener('click', () => window.open(hudUrl, '_blank'));
    copyBtn.addEventListener('click', () => { if (navigator.clipboard) navigator.clipboard.writeText(hudUrl); copyBtn.textContent = 'Copied'; setTimeout(() => { copyBtn.textContent = 'Copy URL'; }, 900); });
    wrap.appendChild(card);
  });
}

cfLoadVdoSettings();
renderCfShares();

// ══════════════ Stations manager — org broadcast desks, full CRUD from the app ══════════════
// Data comes from cloud_stations_full (the website's GET /stations, rooms→slots nested). Every
// mutation is a fire-and-forget WS message; the server re-fetches + re-pushes the list, so the UI
// always mirrors the org. Renames/toggles commit on blur (change event); Enter blurs.
let _cfStationsFull = null;
function cfLoadStations() {
  const wrap = el('cf-stations-list'); if (!wrap) return;
  const isOrg = !!(window._cloudWorkspaceId && !String(window._cloudWorkspaceId).startsWith('user:'));
  if (!isOrg) { wrap.innerHTML = '<p class="section-desc">Sign in to your organization (Settings ▸ Organization) to manage stations.</p>'; const cap = el('cf-stations-cap'); if (cap) cap.style.display = 'none'; return; }
  if (!_cfStationsFull) wrap.innerHTML = '<p class="section-desc">Loading stations…</p>';
  send('cloud_stations_full');
}
function cfApplyStationsFull(d) {
  const wrap = el('cf-stations-list'); if (!wrap) return;
  const status = el('cf-stations-status');
  if (!d || !d.ok) { wrap.innerHTML = `<p class="section-desc">${tlEsc((d && d.message) || 'Could not load stations.')}</p>`; return; }
  _cfStationsFull = d.stations || [];
  const cap = el('cf-stations-cap');
  if (cap) { if (d.seatCap != null) { cap.textContent = `${d.activeCount != null ? d.activeCount : 0} / ${d.seatCap} desks active`; cap.style.display = ''; } else cap.style.display = 'none'; }
  if (!_cfStationsFull.length) { wrap.innerHTML = '<p class="section-desc">No stations yet. Click <strong>+ New station</strong> to create your first broadcast desk.</p>'; if (status) status.textContent = ''; return; }
  wrap.innerHTML = _cfStationsFull.map(cfStationCard).join('');
  if (status) status.textContent = '';
}
function cfFindRoom(stationId, roomId) { const s = (_cfStationsFull || []).find((x) => x.id === stationId); return s && (s.rooms || []).find((r) => r.id === roomId); }
function cfStationCopy(text, btn) {
  if (!text) { showToast('No link available yet — the website mints it when the room is created.', '#c53030', 4000); return; }
  try { navigator.clipboard.writeText(text); } catch (_) {}
  const t = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = t; }, 1200);
  showToast('Link copied: ' + text, '#22c55e', 4000);
}
function cfStationCard(s) {
  const active = s.status === 'active';
  const rooms = (s.rooms || []).map(cfRoomBlock).join('');
  const nRooms = (s.rooms || []).length;
  return `<div class="cf-station-mgr ${active ? 'is-active' : 'is-closed'}" data-st="${tlEsc(s.id)}">
    <div class="cf-stm-head">
      <span class="cf-stm-dot" title="${active ? 'Active' : 'Closed'}"></span>
      <input class="cf-stm-name input-text" value="${tlEsc(s.name || '')}" data-act="station-name" placeholder="Station name" spellcheck="false">
      <span class="cf-stm-meta">${nRooms} room${nRooms === 1 ? '' : 's'}</span>
      <div class="cf-stm-tools">
        <label class="qt-toggle cf-stm-active" title="Active desks count against your organization's seat cap"><span>${active ? 'Active' : 'Closed'}</span><span class="switch"><input type="checkbox" data-act="station-active" ${active ? 'checked' : ''}><span class="slider"></span></span></label>
        <button class="btn btn-ghost btn-xs" data-act="room-add" data-kind="caster">+ Caster room</button>
        <button class="btn btn-ghost btn-xs" data-act="room-add" data-kind="observer">+ Observer room</button>
        <button class="btn btn-ghost btn-xs cf-danger" data-act="station-del" title="Delete this station">Delete</button>
      </div>
    </div>
    <div class="cf-stm-rooms">${rooms || '<p class="section-desc" style="margin:6px 0 0;">No rooms yet — add a caster or observer room.</p>'}</div>
  </div>`;
}
// Talkback panels — isolated sub-groups inside ONE room. A placement with no panel hears the whole
// room (how every room worked before panels), so this is opt-in per placement. Keep in step with
// the website's lib/stations.js STATION_PANELS.
const CF_PANELS = [['', 'Whole room'], ['booth', 'Booth'], ['desk', 'Desk']];
function cfPanelLabel(p) { const m = CF_PANELS.find((x) => x[0] === (p || '')); return m ? m[1] : (p || 'Whole room'); }

function cfRoomBlock(r) {
  const kind = r.kind === 'observer' ? 'observer' : 'caster';
  const slots = (r.slots || []).map((sl) => cfSlotRow(sl)).join('');
  const nSlots = (r.slots || []).length;
  // Which panels are actually in use here — the handoff only means anything with two or more,
  // since one panel (or none) already hears everyone.
  const panels = CF_PANELS.map((p) => p[0]).filter((v) => v && (r.slots || []).some((s) => (s.panel || '') === v));
  const panelMeta = panels.length
    ? `<span class="cf-rm-meta" title="How this room's talkback is split">${panels.map((p) => `${tlEsc(cfPanelLabel(p))} ${(r.slots || []).filter((s) => (s.panel || '') === p).length}`).join(' · ')}</span>`
    : '';
  const bridgeBtn = panels.length > 1
    ? `<button class="btn btn-xs cf-handoff ${r.bridged ? 'is-on' : 'btn-ghost'}" data-act="room-bridge" title="${r.bridged ? 'Close the handoff — each panel goes back to hearing only itself.' : `Open a handoff — ${panels.map(cfPanelLabel).join(' and ')} hear each other until you close it. Nobody has to rejoin.`}">${r.bridged ? 'HANDOFF OPEN' : 'Open handoff'}</button>`
    : '';
  return `<div class="cf-rm" data-rm="${tlEsc(r.id)}" data-kind="${kind}">
    <div class="cf-rm-head">
      <span class="cf-rm-badge ${kind}">${kind === 'observer' ? 'OBSERVER' : 'CASTER'}</span>
      <input class="cf-rm-name input-text" value="${tlEsc(r.name || '')}" data-act="room-name" placeholder="Room name" spellcheck="false">
      <span class="cf-rm-meta">${nSlots} slot${nSlots === 1 ? '' : 's'}</span>
      ${panelMeta}
      ${bridgeBtn}
      <button class="btn btn-ghost btn-xs" data-act="room-copy" title="Copy the join link your talent open to claim a slot">Copy invite</button>
      ${kind === 'observer' ? `<label class="qt-toggle cf-rm-share" title="Let other producers in the org pull these observer feeds"><span>Share to org</span><span class="switch"><input type="checkbox" data-act="room-share" ${r.shareToOrg ? 'checked' : ''}><span class="slider"></span></span></label>` : ''}
      <button class="btn btn-ghost btn-xs" data-act="slot-add" title="Add a placement slot">+ Slot</button>
      <button class="btn btn-ghost btn-xs cf-danger" data-act="room-del" title="Delete this room">Delete</button>
    </div>
    <div class="cf-rm-slots">${slots || '<span class="section-desc" style="padding:4px 0;">No slots — add one for a caster/observer to claim.</span>'}</div>
  </div>`;
}
function cfSlotRow(sl) {
  const who = sl.assignedName || sl.claimedLabel || '';
  const on = sl.enabled !== false;
  const connected = !!(sl.connected || sl.claimedLabel || sl.claimedById);
  const num = (sl.idx != null ? sl.idx + 1 : '') || sl.label || '';
  return `<div class="cf-slot ${on ? '' : 'is-off'} ${connected ? 'is-live' : ''}" data-slot="${tlEsc(sl.id)}">
    <span class="cf-slot-idx" title="${tlEsc(sl.label || '')}">${tlEsc(String(num))}</span>
    <input class="cf-slot-name input-text" value="${tlEsc(who)}" data-act="slot-name" placeholder="${tlEsc(sl.label || 'Unassigned')}" spellcheck="false">
    ${connected ? '<span class="cf-slot-live" title="Someone is connected on this placement">LIVE</span>' : ''}
    <select class="cf-slot-panel input-text ${sl.panel ? 'has-panel' : ''}" data-act="slot-panel" title="Which panel this person talks in. Panels don't hear each other until you open a handoff.">
      ${CF_PANELS.map(([v, lbl]) => `<option value="${v}" ${(sl.panel || '') === v ? 'selected' : ''}>${tlEsc(lbl)}</option>`).join('')}
    </select>
    <label class="cf-slot-en" title="${on ? 'Enabled' : 'Disabled'}"><span class="switch sw-xs"><input type="checkbox" data-act="slot-enabled" ${on ? 'checked' : ''}><span class="slider"></span></span></label>
    <button class="cf-ico-btn" data-act="slot-copy" title="Copy this placement's join link">\u{1F517}</button>
    <button class="cf-ico-btn cf-danger" data-act="slot-del" title="Remove this slot">×</button>
  </div>`;
}
el('cf-stations-refresh')?.addEventListener('click', () => cfLoadStations());
el('cf-stations-new')?.addEventListener('click', () => send('cloud_station_create', { name: 'New station' }));
// Talent rotated → force the desk to re-identify every slot (manual entries too) to the live feeds.
el('cf-resync-desk')?.addEventListener('click', () => {
  send('resync_stations');
  if (typeof showToast === 'function') showToast('Re-syncing desk to live station feeds…');
});
el('cf-stations-list')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  const act = btn.dataset.act;
  const stationId = btn.closest('[data-st]') && btn.closest('[data-st]').dataset.st;
  const roomId = btn.closest('[data-rm]') && btn.closest('[data-rm]').dataset.rm;
  const slotId = btn.closest('[data-slot]') && btn.closest('[data-slot]').dataset.slot;
  if (act === 'station-del') { if (await appConfirm('Delete this station and all its rooms? Any join links for it stop working immediately.', 'Delete Station', true)) send('cloud_station_delete', { stationId }); return; }
  if (act === 'room-add') { send('cloud_room_create', { stationId, kind: btn.dataset.kind }); return; }
  if (act === 'room-del') { if (await appConfirm('Delete this room and its placement slots?', 'Delete Room', true)) send('cloud_room_delete', { stationId, roomId }); return; }
  if (act === 'room-copy') { const r = cfFindRoom(stationId, roomId); cfStationCopy(r && r.url, btn); return; }
  if (act === 'room-bridge') {
    // HANDOFF: flip the room's bridge. Every talent page picks it up on its next poll and
    // re-groups itself live over the VDO iframe API — no rejoin, nobody drops off air.
    const r = cfFindRoom(stationId, roomId);
    send('cloud_room_patch', { stationId, roomId, patch: { bridged: !(r && r.bridged) } });
    return;
  }
  if (act === 'slot-add') { send('cloud_slot_add', { stationId, roomId }); return; }
  if (act === 'slot-del') { send('cloud_slot_delete', { stationId, roomId, slotId }); return; }
  if (act === 'slot-copy') { const r = cfFindRoom(stationId, roomId); const sl = r && (r.slots || []).find((x) => x.id === slotId); cfStationCopy((sl && sl.customJoinUrl) || (r && r.url), btn); return; }
});
el('cf-stations-list')?.addEventListener('change', (e) => {
  const ctl = e.target.closest('[data-act]'); if (!ctl) return;
  const act = ctl.dataset.act;
  const stationId = ctl.closest('[data-st]') && ctl.closest('[data-st]').dataset.st;
  const roomId = ctl.closest('[data-rm]') && ctl.closest('[data-rm]').dataset.rm;
  const slotId = ctl.closest('[data-slot]') && ctl.closest('[data-slot]').dataset.slot;
  if (act === 'station-name') { const v = ctl.value.trim(); if (v) send('cloud_station_patch', { stationId, patch: { name: v } }); return; }
  if (act === 'station-active') { send('cloud_station_patch', { stationId, patch: { status: ctl.checked ? 'active' : 'closed' } }); return; }
  if (act === 'room-name') { send('cloud_room_patch', { stationId, roomId, patch: { name: ctl.value.trim() } }); return; }
  if (act === 'room-share') { send('cloud_room_patch', { stationId, roomId, patch: { shareToOrg: ctl.checked } }); return; }
  if (act === 'slot-name') { send('cloud_slot_patch', { stationId, roomId, slotId, patch: { assignedName: ctl.value.trim() } }); return; }
  if (act === 'slot-enabled') { send('cloud_slot_patch', { stationId, roomId, slotId, patch: { enabled: ctl.checked } }); return; }
  if (act === 'slot-panel') { send('cloud_slot_patch', { stationId, roomId, slotId, patch: { panel: ctl.value } }); return; }
});
el('cf-stations-list')?.addEventListener('keydown', (e) => {
  if (e.target.matches && e.target.matches('input.input-text')) {
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    else if (e.key === 'Escape') { cfLoadStations(); }
  }
});

