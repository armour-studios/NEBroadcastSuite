// Control panel, part 14 of 17: Quick rail panels, talent list, transitions, clip editor, replays, playout, capture.
// Built into control-panel/app.js with the other parts (scripts/build-panel-app.js): one script, one scope.

// ── Qrail panels: Run of Show · Flows · Talent (the live command rail) ─────
// Badge colors per segment type
const RD_BADGE = {
  section:   { color: '#a78bfa', bg: 'rgba(167,139,250,.15)' },
  manual:    { color: '#fbbf24', bg: 'rgba(251,191,36,.14)' },
  flow:      { color: '#22d3ee', bg: 'rgba(34,211,238,.14)' },
  trigger:   { color: '#4ade80', bg: 'rgba(74,222,128,.14)' },
  scene:     { color: '#60a5fa', bg: 'rgba(96,165,250,.14)' },
  playout:   { color: '#f472b6', bg: 'rgba(244,114,182,.14)' },
  view:      { color: '#34d399', bg: 'rgba(52,211,153,.14)' },
  countdown: { color: '#fb923c', bg: 'rgba(251,146,60,.14)' },
};
function renderQros() {
  const list = el('qros-list'); if (!list) return;
  const st = el('qros-status');
  const cancelBtn = el('qros-cancel');
  const curSeg = _rdRunning && _rdSegs[_rdIdx];
  const sum = rdSummary();
  // Status: one plain sentence for where the show is.
  if (st) {
    if (curSeg) {
      st.innerHTML = `<span class="qros-live">On air ${sum.pos}/${sum.total}</span>`
        + `<span class="qros-cur-lbl">${poEsc(curSeg.label || rdTargetLabel(curSeg))}</span>`
        + (_rdTimer ? '<span class="qros-auto" title="Auto-advancing when the hold ends">auto</span>' : '')
        + (sum.next ? `<span class="qros-then">Next: ${poEsc(sum.next)}</span>` : '<span class="qros-then">Last segment</span>');
    } else if (_rdSegs.length) {
      st.innerHTML = `<span class="qros-idle">${sum.total} segment${sum.total === 1 ? '' : 's'} ready</span>`;
    } else {
      st.innerHTML = '<span class="qros-idle">No rundown yet.</span>'
        + '<button type="button" class="btn btn-sm qnext-quiet qros-build js-goto-rundown">Build a rundown</button>';
    }
  }
  // Only show the buttons that apply right now.
  const show = (id, on) => { const b = el(id); if (b) b.style.display = on ? '' : 'none'; };
  show('qros-start', !_rdRunning && _rdSegs.length > 0);
  show('qros-next', _rdRunning);
  show('qros-stop', _rdRunning);
  const nextBtn = el('qros-next'); if (nextBtn) nextBtn.textContent = sum.atEnd ? 'Finish show' : 'Next segment';
  // Hold: only while an auto-advance countdown is running
  if (cancelBtn) cancelBtn.style.display = (_rdRunning && _rdTimer) ? '' : 'none';
  const dot = el('qrail-ros-dot'); if (dot) dot.style.display = _rdRunning ? '' : 'none';

  list.innerHTML = '';
  _rdSegs.forEach((seg, i) => {
    const cur = _rdRunning && i === _rdIdx;
    const badge = RD_BADGE[seg.type] || { color: '#c4b5fd', bg: 'rgba(196,181,253,.12)' };
    const typeLabel = RD_TYPE_LABEL[seg.type] || seg.type;
    const segLabel = poEsc(seg.label || rdTargetLabel(seg));

    if (seg.type === 'section') {
      const hdr = document.createElement('div');
      hdr.className = 'qros-section-hdr';
      hdr.innerHTML = `<span class="qros-section-label">${segLabel}</span><div class="qros-section-line"></div><span style="font-size:9px;color:var(--muted);">${i + 1}</span>`;
      list.appendChild(hdr);
    } else {
      const row = document.createElement('button');
      row.className = 'qros-row' + (cur ? ' qros-cur' : '');
      row.innerHTML = `<span class="qros-num">${i + 1}</span>`
        + `<span class="qros-badge" style="color:${badge.color};background:${badge.bg};">${typeLabel}</span>`
        + `<span class="qros-seg-label">${segLabel}</span>`
        + (cur && _rdTimer ? '<span class="qros-hold-dot" title="Auto-advancing…">&#8987;</span>' : '');
      row.addEventListener('click', () => { _rdRunning = true; _rdIdx = i; clearTimeout(_rdTimer); _rdTimer = null; rdRunCurrent(); });
      list.appendChild(row);
    }
  });
}
function rdCancelHold() {
  clearTimeout(_rdTimer); _rdTimer = null;
  renderRundown();
  if (typeof renderQros === 'function') renderQros();
}
function renderQflows() {
  const list = el('qflows-list'); if (!list) return;
  if (!_flows.length) { list.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px;">No flows yet — build them on Production.</div>'; return; }
  list.innerHTML = '';
  _flows.forEach((f) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 9px;border:1px solid var(--border);border-radius:7px;background:var(--surface2);';
    row.innerHTML = `<span style="flex:1;font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${poEsc(f.name)}${f.enabled === false ? ' <span style="color:var(--muted);font-weight:400;">(off)</span>' : ''}</span>`;
    const fire = document.createElement('button'); fire.className = 'btn btn-warning btn-sm'; fire.textContent = 'Fire';
    fire.addEventListener('click', () => flowFire(f));
    row.appendChild(fire);
    list.appendChild(row);
  });
}
// Fetch teams + group-room links into the Director cache so the rail can show invite/view links
// even when the user hasn't opened the Talent page yet.
let _qtFetching = false;
function cfEnsureTalentData() {
  if (_qtFetching) return; _qtFetching = true;
  fetch(`${VDO_API}/api/vdo/links`).then((r) => r.json()).then((d) => { _cfDirectorData = d; _qtFetching = false; renderQtalent(); }).catch(() => { _qtFetching = false; });
}
// Every monitored VDO room we could move a person into (team rooms, desk/interview, group rooms).
function cfRoomTargets() {
  const d = _cfDirectorData || {};
  const out = [];
  if (d.teams) ['blue', 'orange'].forEach((s) => { const t = d.teams[s]; if (t && t.room) out.push({ label: t.name || s, roomId: t.room }); });
  if (d.casterRoom && d.casterRoom.room) out.push({ label: 'Interview / Desk', roomId: d.casterRoom.room });
  if (d.groups) ['casters', 'guests', 'observers'].forEach((k) => { const g = d.groups[k]; if (g && g.room) out.push({ label: g.name || k, roomId: g.room }); });
  const seen = new Set();
  return out.filter((t) => (seen.has(t.roomId) ? false : seen.add(t.roomId)));
}

// One rail row: a clickable bar (connection · camera · name [· listen]) that expands to the
// person's VDO settings — preview cam, invite/view links, audio (vol/mute/mono) and move-to-room.
function qtalentRow(r) {
  const row = document.createElement('div');
  row.className = 'qtalent-row'; row.dataset.expanded = '0';
  if (r.sid) row.dataset.stream = r.sid;
  row._qt = r;
  const camLive = _directorOn && r.sid && _videoStreams.has(r.sid);
  // Single line carries the common actions; the chevron expands the in-depth VDO panel.
  // Only the BAR is draggable (not the row) so sliders in the expanded panel still work.
  const isMuted = r.audio && r.audio.volume === 0;
  let bar = `<div class="qt-bar" draggable="true" title="Click to expand · drag onto a group / room to move">`
    + `<span class="qt-grip" title="Drag to move rooms">${svgIcon('grip')}</span>`
    + `<span class="mc-stat mc-stat-conn qtalent-conn" data-conn="0"${r.sid ? ` data-stream="${poEsc(r.sid)}"` : ''} title="Connection — Director monitoring detects this"></span>`
    + `<span class="mc-stat mc-stat-cam qtalent-cam${camLive ? ' live' : ''}"${r.sid ? ` data-stream="${poEsc(r.sid)}"` : ''} title="Camera — pulses when monitoring sees video">${svgIcon('camera')}</span>`
    + `<span class="qtalent-name" title="${poEsc(r.name || '')}">${poEsc(r.name || '—')}</span>`
    + `<button class="cf-ico-btn qt-copy" data-url="${poEsc(r.join || '')}" title="Copy invite / join link"${r.join ? '' : ' disabled'}>${svgIcon('userplus')}</button>`
    + `<button class="cf-ico-btn qt-copy" data-url="${poEsc(r.obs || '')}" title="Copy OBS view link"${r.obs ? '' : ' disabled'}>${svgIcon('copy')}</button>`;
  // Headphones = LISTEN: team players → listen-in; everyone else → monitor (open their cam/audio).
  if (r.listen) {
    const liR = currentState.listenIn || {};
    const on = liR.active && liR.scope === 'player' && liR.side === r.listen.side && liR.playerId === r.listen.playerId;
    bar += `<button class="cf-ico-btn qt-listen${on ? ' is-on' : ''}" data-side="${poEsc(r.listen.side)}" data-pid="${poEsc(r.listen.playerId)}" title="${on ? 'Stop listen-in' : 'Listen in'}">${svgIcon('headphones')}</button>`;
  } else {
    bar += `<button class="cf-ico-btn qt-monitor" title="Monitor — open their cam &amp; audio">${svgIcon('headphones')}</button>`;
  }
  // Mic = mute/unmute their mic (their audio into the room).
  bar += `<button class="cf-ico-btn qt-mic${isMuted ? ' is-on' : ''}" title="${isMuted ? 'Unmute in the program (their OBS feed)' : 'Mute in the program (their OBS feed; their mic stays on in the room)'}"${r.audioRef ? '' : ' disabled'}>${svgIcon('mic')}</button>`
    + `<span class="qt-expand-ico" title="In-depth VDO settings">${svgIcon('chevdown')}</span></div>`;
  row.innerHTML = bar + `<div class="qt-detail" hidden></div>`;
  return row;
}

// Build the expanded VDO panel for a row (lazy — only when opened).
function qtalentBuildDetail(row) {
  const r = row._qt || {}; const host = row.querySelector('.qt-detail'); if (!host) return;
  const a = r.audio || {};
  const muted = a.volume === 0;
  host.innerHTML =
    `<div class="qt-prev">${r.obs ? `<iframe src="${poEsc(r.obs)}" allow="autoplay; encrypted-media; microphone; camera" referrerpolicy="no-referrer"></iframe>` : '<div class="qt-prev-empty">No preview link</div>'}`
    + `<a class="cf-ico-btn qt-prev-pop" href="${poEsc(r.obs || '#')}" target="_blank" title="Open preview in a window"${r.obs ? '' : ' style="pointer-events:none;opacity:.4"'}>${svgIcon('external')}</a></div>`
    + (r.audioRef
      ? `<div class="qt-audio-panel">`
        + `<div class="qt-audio-hd"><span class="qt-audio-ttl">VDO audio</span><button class="cf-ico-btn qt-mute${muted ? ' is-on' : ''}" title="${muted ? 'Unmute' : 'Mute'}">${svgIcon('headphones')}</button></div>`
        + `<label class="qt-ar"><span>Volume</span><input type="range" class="qt-vol" min="0" max="200" step="5" value="${a.volume != null ? a.volume : 100}"><b class="qt-vol-v">${a.volume != null ? a.volume : 100}</b></label>`
        + `<label class="qt-ar"><span>Pan</span><input type="range" class="qt-pan" min="-100" max="100" step="10" value="${a.pan != null ? a.pan : 0}"><b class="qt-pan-v">${a.pan != null ? a.pan : 0}</b></label>`
        + `<div class="qt-ar2">`
        + `<label class="qt-mono-lbl"><input type="checkbox" class="qt-mono"${a.mono ? ' checked' : ''}> mono</label>`
        + `<label class="qt-ab-lbl">bitrate <input type="number" class="qt-ab" min="0" max="256" step="8" placeholder="auto" value="${a.ab != null && a.ab !== '' ? a.ab : ''}"> kbps</label>`
        + `</div>`
        + `</div>`
      : `<div class="qt-audio-note">Link this person to a player/member for audio control.</div>`)
    + `<div class="qt-move-hint">Drag this person onto a group / room header to move them.</div>`;
}

// Push the row's in-depth VDO audio controls to the right handler (team player vs library member).
function qtalentSendAudio(row) {
  const r = row._qt || {}; if (!r.audioRef) return;
  const vol = parseInt(row.querySelector('.qt-vol')?.value, 10);
  const pan = parseInt(row.querySelector('.qt-pan')?.value, 10) || 0;
  const mono = !!row.querySelector('.qt-mono')?.checked;
  const abRaw = row.querySelector('.qt-ab')?.value;
  const ab = abRaw != null && abRaw !== '' ? (parseInt(abRaw, 10) || 0) : '';
  const audio = {};
  if (Number.isFinite(vol)) audio.volume = vol;
  if (pan) audio.pan = pan;
  if (mono) audio.mono = true;
  if (ab !== '') audio.ab = ab;
  if (r.audioRef.kind === 'player') send('set_player_audio', { side: r.audioRef.side, playerId: r.audioRef.playerId, audio });
  else if (r.audioRef.kind === 'lib' && r.audioRef.id) send('set_library_audio', { id: r.audioRef.id, audio });
  r.audio = { ...(r.audio || {}), volume: Number.isFinite(vol) ? vol : r.audio?.volume, pan, mono, ab };
  // live value labels
  const vv = row.querySelector('.qt-vol-v'); if (vv && Number.isFinite(vol)) vv.textContent = vol;
  const pv = row.querySelector('.qt-pan-v'); if (pv) pv.textContent = pan;
}

// Toggle mute on a person's mic from the single-line mic button (mirrors the expanded mute).
function qtalentToggleMute(row) {
  const r = row._qt || {}; if (!r.audioRef) return;
  const a = { ...(r.audio || {}) };
  const becomingMuted = !(a.volume === 0);
  if (becomingMuted) { a._lastVol = a.volume != null ? a.volume : 100; a.volume = 0; }
  else { a.volume = a._lastVol != null ? a._lastVol : 100; }
  const audio = { volume: a.volume };
  if (a.pan) audio.pan = a.pan;
  if (a.mono) audio.mono = true;
  if (a.ab != null && a.ab !== '') audio.ab = a.ab;
  if (r.audioRef.kind === 'player') send('set_player_audio', { side: r.audioRef.side, playerId: r.audioRef.playerId, audio });
  else if (r.audioRef.kind === 'lib' && r.audioRef.id) send('set_library_audio', { id: r.audioRef.id, audio });
  r.audio = a;
  const mic = row.querySelector('.qt-mic'); if (mic) { mic.classList.toggle('is-on', becomingMuted); mic.title = becomingMuted ? 'Unmute in the program (their OBS feed)' : 'Mute in the program (their OBS feed; their mic stays on in the room)'; }
  const exV = row.querySelector('.qt-vol'); if (exV) exV.value = a.volume;
  const exMute = row.querySelector('.qt-mute'); if (exMute) exMute.classList.toggle('is-on', becomingMuted);
  const exVv = row.querySelector('.qt-vol-v'); if (exVv) exVv.textContent = a.volume;
}

// Refresh the rail's talent data + connection/camera statuses.
function cfTalentRefresh(btn) {
  if (btn) { btn.disabled = true; btn.classList.add('spinning'); }
  const done = () => { if (btn) { btn.disabled = false; btn.classList.remove('spinning'); } };
  fetch(`${VDO_API}/api/vdo/links`).then((r) => r.json()).then((d) => {
    _cfDirectorData = d;
    if (_directorOn && typeof cfPollGuests === 'function') cfPollGuests();
    renderQtalent();
    done();
  }).catch(() => { renderQtalent(); done(); });
}

// Re-pull /api/vdo/links and re-render every mounted talent surface (rail, Match Control,
// caster quick tool) WITHOUT restarting the director consoles (cfLoadTalent only re-renders
// tabs/occupants/mixer, never the monitoring iframes).
function cfRefreshTalentSurfaces() {
  if (typeof cfTalentRefresh === 'function') cfTalentRefresh();                                 // rail (pulls links → renderQtalent)
  if (typeof cfLoadTalent === 'function' && el('cf-talent-teams')) cfLoadTalent();              // Talent page Match Control + library
}
// Signature of the talent-relevant state — teams/sides/rosters/casters/desk/vdo-room. When it
// changes (e.g. switching team sides), the cached links are stale, so re-pull + re-render.
let _talentStateSig = '';
let _talentRefreshTimer = null;
function cfTalentStateSig(data) {
  data = data || {};
  const t = data.teams || {};
  const sideSig = (s) => { const tm = t[s] || {}; return [tm.name || '', tm.color || '', (tm.players || []).map((p) => (p.name || '') + '|' + (p.vdoStreamId || p.streamId || '') + '|' + (p.id || '')).join(',')]; };
  const cz = data.casters || {};
  const casters = (cz.list || []).map((c) => (c.name || '') + '|' + (c.streamId || '') + '|' + (c.slot || '') + '|' + (c.room || '') + '|' + (c.kind || '')).join(',');
  const v = data.vdo || {};
  return JSON.stringify({ b: sideSig('blue'), o: sideSig('orange'), c: casters, desk: cz.deskRoomId || '', vroom: v.room || '', vbase: v.base || '' });
}
function cfMaybeRefreshTalent(data) {
  const sig = cfTalentStateSig(data);
  if (sig === _talentStateSig) return;
  const first = _talentStateSig === '';
  _talentStateSig = sig;
  if (first) return;   // initial load is handled by the normal loaders / tab-open
  if (_talentRefreshTimer) clearTimeout(_talentRefreshTimer);
  _talentRefreshTimer = setTimeout(cfRefreshTalentSurfaces, 350);   // debounce bursts of full_state
}

// Opening the rail's Talent tab auto-pulls links and starts (media-free) monitoring so the
// connection / camera statuses populate without the producer clicking Start or Refresh.
function cfTalentAutoOpen() {
  // peek=1: a refresh must never provision rooms or API keys as a side effect; only the producer's
  // own actions (Talent Rooms tab, Generate, Link existing) create anything.
  fetch(`${VDO_API}/api/vdo/links?peek=1`).then((r) => r.json()).then((d) => {
    _cfDirectorData = d;
    // The producer's Stop is final until they press Start again (window._directorUserStopped).
    if (!_directorOn && !window._directorUserStopped && typeof cfStartDirectorConsoles === 'function') cfStartDirectorConsoles();
    else if (_directorOn && typeof cfPollGuests === 'function') cfPollGuests();
    renderQtalent();
  }).catch(() => { renderQtalent(); });
}
// Render the talent list into ANY host container (the qrail rail + the Dashboard both use this).
function renderTalentList(list) {
  if (!list) return;
  const li = currentState.listenIn || {};
  const pillHtml = (li.active && li.name) ? `<a href="#" class="js-qtalent-clear" style="color:#4ade80;text-decoration:none;font-weight:600;">● ${poEsc(li.name)} — stop</a>` : '';
  ['qtalent-listen', 'dash-talent-listen', 'dcc-talent-listen'].forEach((id) => { const lp = el(id); if (lp) lp.innerHTML = pillHtml; });
  const d = _cfDirectorData || {};
  if (!d.teams && !d.groups) cfEnsureTalentData();

  // Collect every group into a uniform { label, color, rows } shape.
  const sections = [];
  ['blue', 'orange'].forEach((side) => {
    // Source WHO from the live roster so assigned players show even before they connect / a room
    // exists, then enrich each with VDO link data (join/obs/streamId/audio) from /api/vdo/links.
    const ct = (currentState.teams && currentState.teams[side]) || {};
    const roster = ct.players || [];
    if (!roster.length) return;
    const dt = (d.teams && d.teams[side]) || {};
    const vByPid = {}; (dt.players || []).forEach((vp) => { vByPid[String(vp.playerId)] = vp; });
    const color = ct.color || '#7c8597';
    const rows = roster.map((p) => {
      const vp = vByPid[String(p.id)] || {};
      return {
        name: p.name || vp.name || '—', sid: vp.streamId || '', join: vp.joinUrl || '', obs: vp.obsUrl || '',
        listen: { side, playerId: p.id }, audio: vp.audio || p.vdoAudio || null,
        audioRef: { kind: 'player', side, playerId: p.id }, homeRoom: dt.room || '', side,
      };
    });
    sections.push({ label: ct.name || side, color, roomId: dt.room || '', side, rows });
  });
  // Talent groups: Hosts (casters) · Guests · Observers — always rendered (even empty) so they're
  // drop targets for re-grouping.
  // Talent: ON THE DESK is tonight only (desk slots, Host, Observer, station check-ins), not the
  // whole caster library: that listed every crew member ever saved (producers and socials too) as
  // 22 offline "hosts". A desk person's stream id comes from casters.list (what the castercam and a
  // website station actually use), so their connection dot can light. The full library stays on
  // the Talent page.
  const cst = currentState.casters || {};
  const onDesk = Array.isArray(cst.list) ? cst.list : [];
  const roles = cst.showRoles || {};
  const lineupIds = new Set((cst.lineup || []).map((l) => String(l.libraryId)));
  const nameKey = (n) => String(n || '').trim().toLowerCase();
  const deskNames = new Set(onDesk.map((c) => nameKey(c.name)).concat([nameKey(roles.host), nameKey(roles.observer)]).filter(Boolean));
  const deskByName = {}; onDesk.forEach((c) => { deskByName[nameKey(c.name)] = c; });
  [['casters', 'ON THE DESK', '#e83a8b'], ['observers', 'OBSERVERS', '#2dd4bf'], ['guests', 'LOBBY', '#a855f7']].forEach(([key, label, color]) => {
    const g = (d.groups && d.groups[key]) || {};
    let members = (typeof cfGroupMembersFor === 'function') ? cfGroupMembersFor(key, g) : [];
    if (key === 'casters') {
      members = members.filter((m) => lineupIds.has(String(m.libraryId)) || deskNames.has(nameKey(m.name)));
      // Desk people who have no library entry (a name typed as Host, a station check-in).
      const have = new Set(members.map((m) => nameKey(m.name)));
      onDesk.concat([roles.host, roles.observer].filter(Boolean).map((n) => ({ name: n })))
        .filter((c) => c && c.name && !have.has(nameKey(c.name)))
        .forEach((c) => { have.add(nameKey(c.name)); members.push({ name: c.name, streamId: c.streamId || '', joinUrl: '', obsUrl: c.camUrl || '' }); });
      // Desk people read by their gamertag, the same name the desk lineup and the overlay show.
      members = members.map((m) => { const c = deskByName[nameKey(m.name)]; if (!c) return m; return Object.assign({}, m, c.streamId ? { streamId: c.streamId, obsUrl: c.camUrl || m.obsUrl } : {}, c.gamertag ? { displayName: c.gamertag } : {}); });
    }
    sections.push({ label, color, roomId: g.room || '', groupKey: key, emptyHint: key === 'casters' ? 'Nobody on the desk yet. Pick tonight’s casters on Talent › Desk lineup.' : '', rows: members.map((m) => ({
      name: m.displayName || m.name || m.handle, sid: m.streamId, join: m.joinUrl, obs: m.obsUrl, listen: null,
      audio: m.audio || null, audioRef: m.libraryId ? { kind: 'lib', id: m.libraryId } : null, homeRoom: g.room || '', side: ''
    })) });
  });

  const connOf = (rows) => rows.filter((r) => r.sid && _connectedStreams.has(r.sid)).length;
  const total = sections.reduce((n, s) => n + s.rows.length, 0);

  // Structural signature — only rebuild when the talent/rooms actually change, NOT on every
  // full_state tick (rebuilding would tear down an open preview iframe + collapse the panel).
  // Connection/camera counts update live via cfUpdateConnStatus without a rebuild.
  const sig = JSON.stringify({
    on: _directorOn,
    li: li.active ? `${li.scope}:${li.side}:${li.playerId}` : '',
    s: sections.map((s) => [s.label, s.color, s.rows.map((r) => [r.name, r.sid, r.audioRef ? 1 : 0, r.homeRoom])]),
  });
  if (sig === list._qtSig && list.querySelector('.qtalent-row')) {
    if (typeof cfUpdateConnStatus === 'function') cfUpdateConnStatus();
    return;
  }
  list._qtSig = sig;
  const wasExpanded = new Set([...list.querySelectorAll('.qtalent-row[data-expanded="1"]')].map((r) => r.dataset.stream).filter(Boolean));

  list.innerHTML = '';

  // Monitoring bar — connection status only exists while the Director is monitoring rooms.
  const bar = document.createElement('div'); bar.className = 'qtalent-mon';
  if (_directorOn) {
    bar.innerHTML = `<span class="qt-mon-dot live"></span><span class="qt-mon-txt">Monitoring · ${sections.reduce((n, s) => n + connOf(s.rows), 0)}/${total} connected</span>`;
  } else {
    bar.innerHTML = `<span class="qt-mon-dot"></span><span class="qt-mon-txt">Monitoring off</span>`;
  }
  list.appendChild(bar);

  if (!total) {
    const e = document.createElement('div'); e.style.cssText = 'font-size:12px;color:var(--muted);padding:8px;';
    e.textContent = 'No talent yet — set teams on the Dashboard, add casters/guests on the Talent page.';
    list.appendChild(e); return;
  }
  sections.forEach((s) => {
    const hdr = document.createElement('div'); hdr.className = 'qtalent-hdr'; hdr.style.setProperty('--qc', s.color);
    if (s.roomId) { hdr.dataset.room = s.roomId; }                 // live room (transfer target)
    if (s.groupKey) { hdr.dataset.group = s.groupKey; hdr.classList.add('qt-hdr-group'); }   // re-group target (kind change)
    hdr.dataset.label = s.label;
    if (s.side) { hdr.dataset.side = s.side; }   // team sections carry a side for listen-in
    const cnt = _directorOn ? `${connOf(s.rows)}/${s.rows.length}` : String(s.rows.length);
    const li = currentState.listenIn || {};
    const listenOn = li.active && li.scope === 'room' && li.side === s.side;
    const listenBtn = s.side ? `<button class="cf-ico-btn qt-hdr-listen${listenOn ? ' is-on' : ''}" data-side="${poEsc(s.side)}" title="${listenOn ? 'Stop listen-in' : 'Listen in to room'}">${svgIcon('headphones')}</button>` : '';
    const intvBtn = s.side ? `<button class="cf-ico-btn qt-hdr-interview" data-side="${poEsc(s.side)}" title="Move the whole team to Interview / Desk">${svgIcon('mic')}</button>` : '';
    const inviteUrl = s.side ? ((d.teams && d.teams[s.side] && d.teams[s.side].roomJoinUrl) || '') : '';
    const inviteBtn = inviteUrl ? `<button class="cf-ico-btn qt-hdr-invite" data-url="${poEsc(inviteUrl)}" title="Copy VDO room invite link">${svgIcon('link')}</button>` : '';
    hdr.innerHTML = `<span class="qt-hdr-bar"></span><span class="qt-hdr-lbl">${poEsc(s.label)}</span><span class="qt-hdr-count">${cnt}</span>${listenBtn}${intvBtn}${inviteBtn}<span class="qt-hdr-drop">drop to move</span>`;
    list.appendChild(hdr);
    if (!s.rows.length && s.emptyHint) {
      const e = document.createElement('div'); e.className = 'qtalent-empty'; e.textContent = s.emptyHint;
      list.appendChild(e);
    }
    s.rows.forEach((r) => {
      const row = qtalentRow(r); row.style.setProperty('--qc', s.color); list.appendChild(row);
      if (r.sid && wasExpanded.has(r.sid)) { row.dataset.expanded = '1'; qtalentBuildDetail(row); const det = row.querySelector('.qt-detail'); if (det) det.hidden = false; }
    });
  });
  if (typeof cfUpdateConnStatus === 'function') cfUpdateConnStatus();
}
// Render every mounted talent host (qrail rail + Dashboard panel).
function renderQtalent() {
  document.querySelectorAll('.qtalent-host').forEach((host) => renderTalentList(host));
  if (typeof renderDcTalentStatus === 'function') renderDcTalentStatus();
}
// Control-center status button above "On-Air Talent" — shows what the producer is doing right now
// (listening in on a player/room, or someone on the interview desk), styled like the listen-in status.
function renderDcTalentStatus() {
  const b = el('dc-talent-status'); if (!b) return;
  const data = (typeof currentState !== 'undefined' && currentState) || {};
  const li = data.listenIn || {};
  const iv = data.casters && data.casters.interviewee;
  if (li.active && li.name) {
    b.className = 'dc-talent-status is-live';
    b.dataset.action = 'stop-listen';
    b.innerHTML = `<span class="live-dot"></span><span>Listening in · <b>${poEsc(li.name)}</b>${li.scope === 'room' ? ' (room)' : ''}</span><span class="dc-status-x">stop</span>`;
  } else if (iv && iv.name) {
    b.className = 'dc-talent-status is-desk';
    b.dataset.action = 'clear-interview';
    b.innerHTML = `<span class="live-dot"></span><span>On desk · <b>${poEsc(iv.name)}</b></span><span class="dc-status-x">return</span>`;
  } else {
    b.className = 'dc-talent-status is-idle';
    b.dataset.action = '';
    b.innerHTML = `<span class="dc-status-dot"></span><span>${_directorOn ? 'Monitoring live — no active feed' : 'Monitoring off'}</span>`;
  }
}
el('dc-talent-status')?.addEventListener('click', function () {
  if (this.dataset.action === 'stop-listen') send('clear_listen_in');
  else if (this.dataset.action === 'clear-interview') send('clear_interviewee');
});
function renderQrailLive() { renderQros(); renderQflows(); renderQtalent(); }
el('qros-start')?.addEventListener('click', () => { rdStart(); renderQros(); });
el('qros-next')?.addEventListener('click', () => { rdNext(); renderQros(); });
el('qros-stop')?.addEventListener('click', () => { rdStop(); renderQros(); });
el('qros-cancel')?.addEventListener('click', rdCancelHold);
document.querySelectorAll('.js-goto-ros').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); document.querySelector('.tab-btn[data-tab="produccion"]')?.click(); }));
document.querySelectorAll('.js-goto-flows').forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault();
  document.querySelector('.tab-btn[data-tab="produccion"]')?.click();
  if (typeof window._pdShow === 'function') window._pdShow('flows');
}));
// Rail "Edit" / "Build a rundown" -> Production ▸ Rundown. Delegated: the Build button is re-rendered.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.js-goto-rundown')) return;
  e.preventDefault();
  document.querySelector('.tab-btn[data-tab="produccion"]')?.click();
  if (typeof window._pdShow === 'function') window._pdShow('rundown');
});
document.querySelectorAll('.js-goto-dashboard').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); document.querySelector('.tab-btn[data-tab="principal"]')?.click(); }));

// ── Qrail panel: start.gg stream queue ──────────────────────────────────────
let _qsggSig = '';
let _qsggDemoQueue = null;
let _qsggPrevSetMap = {};          // setId → { state, live } — for activity tracking
let _qsggActivity = [];            // [{ts, icon, text, cls}] — live activity log

function _qsggTrackChanges(queue) {
  const now = Date.now();
  let dirty = false;
  const hasPrev = Object.keys(_qsggPrevSetMap).length > 0;

  queue.forEach((q) => {
    const id = String(q.setId);
    const prev = _qsggPrevSetMap[id];
    if (!prev) {
      if (hasPrev) {
        _qsggActivity.unshift({ ts: now, icon: '+', text: (q.teamA||'TBD') + ' vs ' + (q.teamB||'TBD') + ' added to queue', cls: 'new' });
        dirty = true;
      }
    } else {
      if (q.live && q.state !== 3 && !prev.live) {
        const txt = (q.teamA||'TBD') + ' vs ' + (q.teamB||'TBD') + ' — now LIVE' + (q.round ? ' (' + q.round + ')' : '');
        _qsggActivity.unshift({ ts: now, icon: '▶', text: txt, cls: 'live' });
        if (typeof addNotification === 'function') addNotification(txt, '#22c55e', { title: 'Start.gg Live', level: 'success' });
        dirty = true;
      }
      if (q.state === 3 && prev.state !== 3) {
        const sa = q.scoreA, sb = q.scoreB;
        const hasScore = sa != null && sb != null;
        const winner = hasScore ? (sa > sb ? q.teamA : q.teamB) : null;
        const scoreStr = hasScore ? Math.max(sa,sb) + '–' + Math.min(sa,sb) : '';
        const txt = (winner || (q.teamA||'TBD')) + (scoreStr ? ' wins ' + scoreStr : ' — match complete') + ' vs ' + (q.teamB||'TBD');
        _qsggActivity.unshift({ ts: now, icon: '✓', text: txt, cls: 'done' });
        if (typeof addNotification === 'function') addNotification(txt, '#4ade80', { title: 'Match Complete', level: 'success' });
        dirty = true;
      }
    }
    _qsggPrevSetMap[id] = { state: q.state, live: !!q.live };
  });

  if (dirty) _qsggActivity = _qsggActivity.slice(0, 25);
  return dirty;
}

function _qsggRelTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
}

function _renderQsggActivity() {
  const wrap = el('qsgg-activity');
  const header = el('qsgg-activity-header');
  if (!wrap) return;
  if (!_qsggActivity.length) { wrap.innerHTML = ''; if (header) header.style.display = 'none'; return; }
  if (header) header.style.display = 'flex';
  wrap.innerHTML = _qsggActivity.map((a) =>
    '<div class="qsgg-act-row qsgg-act-' + a.cls + '">' +
      '<span class="qsgg-act-ico">' + a.icon + '</span>' +
      '<span class="qsgg-act-txt">' + escapeHtml(a.text) + '</span>' +
      '<span class="qsgg-act-time">' + _qsggRelTime(a.ts) + '</span>' +
    '</div>'
  ).join('');
}

async function _qsggFlagMatch(item) {
  const note = await customPrompt('Flag this match', (item.teamA||'TBD') + ' vs ' + (item.teamB||'TBD') + '\nWhat is wrong? For example: score dispute, team not here.', '', 'Flag');
  if (!note || !note.trim()) return;
  const txt = (item.teamA||'TBD') + ' vs ' + (item.teamB||'TBD') + ': ' + note.trim();
  if (typeof addNotification === 'function') addNotification(txt, '#f59e0b', { title: 'Producer Flag', level: 'warning' });
  _qsggActivity.unshift({ ts: Date.now(), icon: '!', text: txt, cls: 'flag' });
  _qsggActivity = _qsggActivity.slice(0, 25);
  _renderQsggActivity();
}

el('qsgg-clear-activity')?.addEventListener('click', () => { _qsggActivity = []; _renderQsggActivity(); });

function _qsggFormatRound(match, index, total) {
  const win = Math.ceil((match.best_of || 5) / 2);
  const sa = match.score_a || 0, sb = match.score_b || 0;
  if (sa >= win || sb >= win) {
    if (total <= 2) return index === 0 ? 'Grand Finals' : 'Losers Finals';
    if (index === 0) return 'Grand Finals';
    if (index === 1) return 'Losers Finals';
    if (index === 2) return 'Winners Finals';
    return 'Top ' + (total - index + 1);
  }
  return 'Bracket Match';
}

async function qsggLoadDemo() {
  const btn = el('qsgg-demo-btn');
  const clr = el('qsgg-clear-btn');
  if (btn) { btn.textContent = 'Loading…'; btn.disabled = true; }
  try {
    const res = await fetch('http://127.0.0.1:3000/api/stats/matches?limit=60');
    if (!res.ok) throw new Error(res.statusText);
    const json = await res.json();
    const matches = json.matches || json;
    if (!Array.isArray(matches) || !matches.length) { if (btn) { btn.textContent = 'No data'; btn.disabled = false; } return; }

    // Group by tournament, take the most populous one
    const byTournament = {};
    matches.forEach((m) => { const t = m.tournament || 'Unknown'; (byTournament[t] = byTournament[t] || []).push(m); });
    const topTournament = Object.entries(byTournament).sort((a, b) => b[1].length - a[1].length)[0];
    const tournamentName = topTournament[0];
    const sets = topTournament[1].sort((a, b) => (b.started_at || 0) - (a.started_at || 0)).slice(0, 12);

    // Map to queue items — first is "LIVE", next few are "NEXT", rest are "DONE"
    _qsggDemoQueue = sets.map((m, i) => ({
      setId: m.startgg_set_id || String(m.id),
      stream: 'Stream 1',
      round: _qsggFormatRound(m, i, sets.length),
      state: i === 0 ? 2 : i < 4 ? 1 : 3,
      teamA: m.team_a || 'Team A',
      teamB: m.team_b || 'Team B',
      logoA: m.logo_a || null,
      logoB: m.logo_b || null,
      scoreA: (i >= 4) ? (m.score_a || 0) : null,
      scoreB: (i >= 4) ? (m.score_b || 0) : null,
      live: i === 0,
      _tournamentName: tournamentName,
    }));

    if (btn) { btn.textContent = 'Preview'; btn.disabled = false; }
    if (clr) clr.style.display = '';
    _qsggSig = '';   // force redraw
    renderQrailStartgg(currentState);
  } catch (err) {
    console.error('[qsgg demo]', err);
    if (btn) { btn.textContent = 'Error'; btn.disabled = false; setTimeout(() => { if (btn) btn.textContent = 'Preview'; }, 2000); }
  }
}

function qsggClearDemo() {
  _qsggDemoQueue = null;
  _qsggSig = '';
  const clr = el('qsgg-clear-btn');
  if (clr) clr.style.display = 'none';
  renderQrailStartgg(currentState);
}

el('qsgg-demo-btn')?.addEventListener('click', qsggLoadDemo);
el('qsgg-clear-btn')?.addEventListener('click', qsggClearDemo);

// Replay Buffer switched off in OBS's own settings (state.obs.replayBufferAvailable === false).
// Every buffer pill/button uses this so they all say the same thing — and none of them keep
// offering a Start button that OBS will refuse.
const RB_OFF_HINT = 'Replay Buffer is turned off in OBS. In OBS: Settings > Output > Replay Buffer > Enable Replay Buffer, then Apply. (The suite never changes OBS settings for you.)';
function rbOffInObs(obs) { return !!(obs && obs.connected && obs.replayBufferAvailable === false); }
function rbPill(pill, obs) {
  if (!pill) return;
  const off = rbOffInObs(obs);
  pill.textContent = off ? 'Off in OBS' : obs.replayBufferActive ? 'Buffer On' : 'Buffer Off';
  pill.classList.toggle('on', !!obs.replayBufferActive);
  pill.classList.toggle('is-obs-off', off);
  pill.title = off ? RB_OFF_HINT : '';
}

function renderQrailStartgg(data) {
  const list = el('qsgg-list'); if (!list) return;
  const sgg = data.startgg || {};
  const isDemo = !!_qsggDemoQueue;
  const queue = isDemo ? _qsggDemoQueue : (sgg.queue || []);
  const event = isDemo ? { name: (_qsggDemoQueue[0] && _qsggDemoQueue[0]._tournamentName) || 'Demo', tournamentSlug: null } : (sgg.selectedEvent || {});
  const queueEnabled = isDemo ? true : !!sgg.queueEnabled;
  const lastPushed = isDemo ? null : sgg.lastPushedSetId;
  const evName = event.name || event.slug || '';
  const adminUrl = (!isDemo && event.tournamentSlug)
    ? 'https://www.start.gg/admin/tournament/' + event.tournamentSlug + '/stream-queue'
    : null;

  // Track activity changes (always runs, before sig check)
  if (!isDemo) _qsggTrackChanges(queue);
  _renderQsggActivity();

  const sig = JSON.stringify([queue.map((q) => [q.setId, q.state, q.live, q.scoreA, q.scoreB, q.teamA, q.teamB, q.round, q.logoA, q.logoB]), queueEnabled, lastPushed, evName]);
  if (sig === _qsggSig) return;
  _qsggSig = sig;

  const evNameEl = el('qsgg-event-name');
  if (evNameEl) evNameEl.textContent = evName || 'No event loaded';

  const pollEl = el('qsgg-poll-status');
  if (pollEl) {
    pollEl.textContent = isDemo ? 'Preview' : queueEnabled ? 'Tracking' : 'Off';
    pollEl.title = isDemo ? 'Showing sample sets from your history' : queueEnabled ? 'Following the start.gg stream queue' : 'Queue tracking is off — turn it on from the Dashboard';
    pollEl.className = 'qsgg-poll-status ' + (isDemo ? 'preview' : queueEnabled ? 'enabled' : 'disabled');
  }

  // Preview is a testing aid — only offer it when there is nothing real to look at.
  const demoBtn = el('qsgg-demo-btn'); if (demoBtn) demoBtn.style.display = (!isDemo && !queue.length) ? '' : 'none';
  const changeLink = document.querySelector('#qsgg-event-name ~ .js-goto-dashboard'); if (changeLink) changeLink.style.display = evName && !isDemo ? '' : 'none';

  const badgeEl = el('qsgg-queue-badge');
  if (badgeEl) badgeEl.textContent = queue.length ? queue.length + ' set' + (queue.length > 1 ? 's' : '') : '';

  const dot = el('qrail-sgg-dot');
  const liveSet = queue.find((q) => q.live && q.state !== 3);
  if (dot) {
    const hasActivity = !!(evName || queue.length);
    dot.style.display = hasActivity ? '' : 'none';
    dot.className = 'qrail-tab-dot' + (hasActivity ? ' on' : '') + (liveSet ? ' is-live' : '');
  }

  if (!queue.length) {
    // The queue only contains sets the TO has ATTACHED TO A STREAM in start.gg admin —
    // a connected event with nothing marked shows empty forever. Say so, with the fix.
    const slug = (currentState?.startgg?.tournamentSlug || '').trim();
    const adminLink = slug
      ? `<a class="qnext-link qsgg-empty-link" href="https://www.start.gg/admin/tournament/${encodeURIComponent(slug)}/stream-queue" target="_blank">Open stream queue on start.gg</a>`
      : '';
    list.innerHTML = evName
      ? '<div class="qsgg-empty">' + (queueEnabled
          ? 'Nothing queued yet. Attach sets to your stream on start.gg and they show up here.' + adminLink
          : 'Queue tracking is off. Turn it on from the Dashboard.') + '</div>'
      : '<div class="qsgg-empty">Load an event on the Dashboard to see its stream queue.<button type="button" class="btn btn-sm qnext-quiet qsgg-goto-dash">Open Dashboard</button></div>';
    list.querySelector('.qsgg-goto-dash')?.addEventListener('click', () => { document.querySelector('.tab-btn[data-tab="principal"]')?.click(); });
    return;
  }

  list.innerHTML = '';
  queue.forEach((item) => {
    const isLive = item.live && item.state !== 3;
    const isDone = item.state === 3;
    // Cued up at the head of the stream queue but not called on start.gg — "ON DECK", not LIVE.
    const isOnDeck = !isLive && !isDone && item.onStream;
    const badge = isLive ? 'LIVE' : isDone ? 'DONE' : isOnDeck ? 'ON DECK' : 'NEXT';
    const badgeCls = isLive ? 'live' : isDone ? 'done' : isOnDeck ? 'ondeck' : 'next';
    const hasScore = item.scoreA != null && item.scoreB != null;
    const scoreText = hasScore ? (item.scoreA + ' – ' + item.scoreB) : 'vs';
    const isPushed = lastPushed && String(lastPushed) === String(item.setId);
    const logoA = item.logoA ? '<img class="qsgg-logo" src="' + escapeHtml(item.logoA) + '" alt="" loading="lazy">' : '<span class="qsgg-logo-ph"></span>';
    const logoB = item.logoB ? '<img class="qsgg-logo" src="' + escapeHtml(item.logoB) + '" alt="" loading="lazy">' : '<span class="qsgg-logo-ph"></span>';
    const extLinkHtml = adminUrl
      ? '<a class="qsgg-ext-link" href="' + escapeHtml(adminUrl) + '" target="_blank" title="View on start.gg">&#8599;</a>'
      : '';

    const row = document.createElement('div');
    row.className = 'qsgg-row' + (isLive ? ' is-live' : '') + (isOnDeck ? ' is-ondeck' : '') + (isDone ? ' is-done' : '');
    row.innerHTML = [
      '<div class="qsgg-top">',
        '<span class="qsgg-badge ' + badgeCls + '">' + badge + '</span>',
        '<span class="qsgg-round">' + escapeHtml(item.round || '') + '</span>',
        '<span class="qsgg-row-actions">',
          '<button class="btn btn-ghost btn-xs qsgg-flag-btn" title="Flag this match">!</button>',
          extLinkHtml,
          '<button class="btn btn-ghost btn-xs qsgg-push-btn' + (isPushed ? ' pushed' : '') + '">' + (isPushed ? 'On-air' : 'Push') + '</button>',
        '</span>',
      '</div>',
      '<div class="qsgg-teams">',
        '<span class="qsgg-team">' + logoA + '<span class="qsgg-tname">' + escapeHtml(item.teamA || 'TBD') + '</span></span>',
        '<span class="qsgg-sep">' + escapeHtml(scoreText) + '</span>',
        '<span class="qsgg-team qsgg-team-b"><span class="qsgg-tname">' + escapeHtml(item.teamB || 'TBD') + '</span>' + logoB + '</span>',
      '</div>',
    ].join('');

    row.querySelector('.qsgg-flag-btn').addEventListener('click', () => _qsggFlagMatch(item));
    if (isDemo) {
      row.querySelector('.qsgg-push-btn').disabled = true;
    } else {
      row.querySelector('.qsgg-push-btn').addEventListener('click', async () => {
        if (await confirmQueuePush()) send('startgg_push_set', { setId: item.setId });
      });
    }
    list.appendChild(row);
  });
}

// ── Talent list interactions — bound once per host (qrail rail + Dashboard panel) ──
let _qtDragRow = null;
function qtDropTarget(e) {
  // Dropping on a Casters/Observers/Guests header re-groups the person (a kind change — no
  // consoles needed). Dropping on a team/room header (or another room's row) is a live transfer.
  const ghdr = e.target.closest('.qtalent-hdr[data-group]');
  if (ghdr) return { group: ghdr.dataset.group, label: ghdr.dataset.label };
  const hdr = e.target.closest('.qtalent-hdr[data-room]');
  if (hdr) return { room: hdr.dataset.room, label: hdr.dataset.label };
  const row = e.target.closest('.qtalent-row[data-stream]');
  if (row && row._qt) { const rm = cfPlayerCurrentRoom(row._qt.sid, row._qt.homeRoom); if (rm) return { room: rm, label: cfRoomLabel(rm) }; }
  return null;
}
// Casters/Observers/Guests group → the caster-library `kind` value.
const QT_GROUP_KIND = { casters: 'caster', observers: 'observer', guests: 'host' };
function wireTalentList(list) {
  if (!list || list._qtWired) return; list._qtWired = true;

  list.parentElement?.addEventListener('click', (e) => { if (e.target.closest('.js-qtalent-clear')) { e.preventDefault(); send('clear_listen_in'); } });

  list.addEventListener('click', (e) => {
    const monStart = e.target.closest('.qt-mon-start');
    if (monStart) {
      monStart.disabled = true; monStart.textContent = 'Starting…';
      fetch(`${VDO_API}/api/vdo/links`).then((r) => r.json()).then((d) => {
        _cfDirectorData = d;
        if (typeof cfStartDirectorConsoles === 'function') cfStartDirectorConsoles();
        renderQtalent();
      }).catch(() => { renderQtalent(); });
      return;
    }
    const refresh = e.target.closest('.qt-mon-refresh');
    if (refresh) { cfTalentRefresh(refresh); return; }
    const copy = e.target.closest('.qt-copy');
    if (copy) { if (copy.dataset.url) tlCopy(copy.dataset.url, copy); return; }
    const listen = e.target.closest('.qt-listen');
    if (listen) {
      const liS = currentState.listenIn || {};
      const on = liS.active && liS.scope === 'player' && liS.side === listen.dataset.side && liS.playerId === listen.dataset.pid;
      if (on) send('clear_listen_in'); else send('set_listen_in', { side: listen.dataset.side, playerId: listen.dataset.pid });
      return;
    }
    const hdrListen = e.target.closest('.qt-hdr-listen');
    if (hdrListen) {
      const liS = currentState.listenIn || {};
      const on = liS.active && liS.scope === 'room' && liS.side === hdrListen.dataset.side;
      if (on) send('clear_listen_in'); else send('set_listen_in', { side: hdrListen.dataset.side });
      return;
    }
    // Team header mic = move the WHOLE team to the Interview / Desk room.
    const hdrIntv = e.target.closest('.qt-hdr-interview');
    if (hdrIntv) {
      const side = hdrIntv.dataset.side;
      if (typeof cfMoveTeam === 'function') {
        cfMoveTeam(side, 'interview');
        if (typeof showToast === 'function') showToast(`Moving ${side === 'blue' ? 'Blue' : 'Orange'} team to Interview / Desk…`, '#22c55e');
      }
      return;
    }
    // Team header link = copy the general VDO room invite URL to clipboard.
    const hdrInvite = e.target.closest('.qt-hdr-invite');
    if (hdrInvite) {
      const url = hdrInvite.dataset.url;
      if (url && typeof tlCopy === 'function') tlCopy(url, hdrInvite);
      return;
    }
    // Mic = mute / unmute their mic (their audio into the room).
    const micBtn = e.target.closest('.qt-mic');
    if (micBtn) {
      const row = micBtn.closest('.qtalent-row'); if (row) qtalentToggleMute(row);
      return;
    }
    // Headphones on a non-team row = monitor: open their cam/audio (expand the panel).
    const monitor = e.target.closest('.qt-monitor');
    if (monitor) {
      const row = monitor.closest('.qtalent-row'); if (!row) return;
      if (row.dataset.expanded !== '1') { row.dataset.expanded = '1'; qtalentBuildDetail(row); const det = row.querySelector('.qt-detail'); if (det) det.hidden = false; }
      return;
    }
    const mute = e.target.closest('.qt-mute');
    if (mute) {
      const row = mute.closest('.qtalent-row'); const volEl = row?.querySelector('.qt-vol'); if (!volEl) return;
      const muting = !mute.classList.contains('is-on');
      volEl.value = muting ? 0 : 100;
      mute.classList.toggle('is-on', muting); mute.title = muting ? 'Unmute' : 'Mute';
      qtalentSendAudio(row);
      return;
    }
    const barEl = e.target.closest('.qt-bar');
    if (barEl && !e.target.closest('button')) {
      const row = barEl.closest('.qtalent-row'); if (!row) return;
      const open = row.dataset.expanded === '1';
      const detail = row.querySelector('.qt-detail');
      if (open) { row.dataset.expanded = '0'; if (detail) { detail.hidden = true; detail.innerHTML = ''; } }   // tear down preview iframe
      else { row.dataset.expanded = '1'; qtalentBuildDetail(row); if (detail) detail.hidden = false; }
      return;
    }
  });

  list.addEventListener('change', (e) => {
    const row = e.target.closest('.qtalent-row'); if (!row) return;
    if (e.target.closest('.qt-vol') || e.target.closest('.qt-mono') || e.target.closest('.qt-pan') || e.target.closest('.qt-ab')) {
      const mute = row.querySelector('.qt-mute'); const vol = row.querySelector('.qt-vol');
      if (mute && vol) { const m = Number(vol.value) === 0; mute.classList.toggle('is-on', m); mute.title = m ? 'Unmute' : 'Mute'; }
      qtalentSendAudio(row);
      return;
    }
  });

  list.addEventListener('input', (e) => {
    const row = e.target.closest('.qtalent-row'); if (!row) return;
    if (e.target.closest('.qt-vol')) { const v = row.querySelector('.qt-vol-v'); if (v) v.textContent = e.target.value; }
    if (e.target.closest('.qt-pan')) { const v = row.querySelector('.qt-pan-v'); if (v) v.textContent = e.target.value; }
  });

  // Drag a person onto a group / room header (or another room's row) to move them.
  list.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.qtalent-row'); if (!row || !row._qt) return;
    _qtDragRow = row;
    row.classList.add('qt-dragging');
    list.classList.add('qt-dnd');
    try { e.dataTransfer.setData('text/plain', row._qt.sid || row._qt.name || '1'); e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
  });
  list.addEventListener('dragend', (e) => {
    const row = e.target.closest('.qtalent-row'); if (row) row.classList.remove('qt-dragging');
    list.classList.remove('qt-dnd');
    document.querySelectorAll('.qtalent-host .qt-drop-ok').forEach((n) => n.classList.remove('qt-drop-ok'));
    _qtDragRow = null;
  });
  list.addEventListener('dragover', (e) => {
    if (!_qtDragRow) return;
    const t = qtDropTarget(e); if (!t) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    const host = e.target.closest('.qtalent-hdr[data-group], .qtalent-hdr[data-room], .qtalent-row[data-stream]');
    document.querySelectorAll('.qtalent-host .qt-drop-ok').forEach((n) => { if (n !== host) n.classList.remove('qt-drop-ok'); });
    if (host) host.classList.add('qt-drop-ok');
  });
  list.addEventListener('drop', (e) => {
    if (!_qtDragRow) return;
    const t = qtDropTarget(e); if (!t) return;
    e.preventDefault();
    const r = _qtDragRow._qt;
    document.querySelectorAll('.qtalent-host .qt-drop-ok').forEach((n) => n.classList.remove('qt-drop-ok'));
    if (!r) return;
    // Re-group onto a Casters/Observers/Guests header → change role (kind). No consoles needed.
    if (t.group) {
      const kind = QT_GROUP_KIND[t.group]; if (!kind) return;
      if (r.audioRef && r.audioRef.kind === 'lib' && r.audioRef.id) send('save_caster_to_library', { id: r.audioRef.id, name: r.name, kind });
      else send('save_caster_to_library', { name: r.name, kind, camUrl: r.obs || '' });   // a team player joins the desk as this role
      if (typeof showToast === 'function') showToast(`${r.name} → ${t.label}`, '#22c55e');
      return;
    }
    const cur = r.sid ? cfPlayerCurrentRoom(r.sid, r.homeRoom) : r.homeRoom;
    if (t.room === cur) return;   // already there
    const ok = cfMovePlayerToRoom({ stream: r.sid, name: r.name, side: r.side, homeRoom: r.homeRoom }, t.room, t.label);
    if (typeof showToast === 'function') {
      if (ok) showToast(`Moving ${r.name} → ${t.label}…`, '#22c55e');
      else showToast((el('cf-dc-note') && el('cf-dc-note').textContent) || `Couldn't move ${r.name} — start the director consoles and make sure they're connected.`, '#c53030');
    }
  });
}
document.querySelectorAll('.qtalent-host').forEach(wireTalentList);
renderQrailLive();

// ── Live transitions, scene-return + time-remaining ────────────────────────
let _replayOrigin = '';     // the OBS scene that was live before the replay started
let _replayActive = false;
let _replayFallbackTimer = null;   // safety net for the return-to-scene if the player misses 'ended'
let _lastProgressRx = 0;           // last time the OBS overlay reported playback position
let _replayCountdownLive = false;  // the REPLAYS panel readout is counting (panel-local; the producer timer is never touched)
// Transition for a MANUAL push (editor To Air/Preview, qrail clip push, Take). This is the pool's
// always-visible Transition control — the one place a producer sets "how clips come on air".
// (It used to read the Playlists section's #rp-transition, which is a per-playlist saved setting
// living behind a collapsed section; now that Playlists is its own tab, that control was invisible
// for anyone pushing single clips.) Saved playlists still use their own transition via
// playlistTransitionOpts().
function liveTransitionOpts() {
  if (el('rp-pool-transition')) return poolTransitionOpts();
  const transition = el('rp-transition')?.value || 'cut';
  const transitionLogo = transition === 'logo'
    ? (_transitionLogo || (currentState.brand && currentState.brand.logo) || '')
    : '';
  return { transition, transitionLogo, stinger: '', stingerPoint: 0 };
}
// Capture the scene we're leaving (once per replay), then switch to the program scene.
// `trans` (optional) is the resolved transition opts: in "OBS transition" mode the cut itself
// carries the transition name so OBS performs it — armed server-side and awaited before the switch,
// which is why it rides ON this message rather than being armed by a separate one.
function beginReplayProgram(sceneOverride, trans) {
  if (!_replayActive) _replayOrigin = (currentState.obs && currentState.obs.currentScene) || '';
  _replayActive = true;
  clearTimeout(_replayFallbackTimer);
  // Cut OBS to the playback scene (the one holding the replay-player browser source): a per-playlist
  // override wins, else the global Program-scene dropdown.
  const scene = (sceneOverride || el('rp-program-scene')?.value || '').trim();
  if (!scene) return;
  const payload = { sceneName: scene };
  if (trans && trans.obsTransition) {
    payload.transitionName = trans.obsTransition;
    payload.transitionDurationMs = trans.obsDuration || 0;
  }
  send('obs_switch_scene', payload);
}
// Called when a non-looping replay finishes (or air is cleared): go back where we came from.
function endReplayProgram(silent) {
  if (!_replayActive) return;
  _replayActive = false;
  clearTimeout(_replayFallbackTimer);
  stopReplayCountdown();
  // Single shared source: single clips and encoded playlists all play on the program bus, so this
  // stops whatever's actually on air. (_plBus is reset back to 'program' below.)
  const bus = _plBus || 'program';
  const ret = el('rp-return-scene');
  if (!silent && ret && ret.checked && _replayOrigin) {
    send('replay_stop', { bus });
    send('obs_switch_scene', { sceneName: _replayOrigin });
    const st = el('rp-screen-status'); if (st) { st.textContent = 'Returned to ' + _replayOrigin; st.style.color = 'var(--muted)'; }
  } else if (!silent) {
    // Shared-source model: even when we're staying on the playback scene (Return off),
    // clear the program player so it doesn't freeze on the last frame in whatever scene
    // is still on air. The scene then shows its own background again.
    send('replay_stop', { bus });
  }
  _replayOrigin = '';
  _plBus = 'program';
  _plEncodedMode = false;
  _plLiveMontageId = null;
}

// Time-remaining readout, driven by the overlay's playback reports.
function fmtClock(s) {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}
function playlistRemainingAfterCurrent() {
  let s = 0;
  if (_plLiveActive) {
    for (let i = _plLiveIdx + 1; i < _plLiveItems.length; i++) {
      const c = _plLiveItems[i];
      s += Math.max(0, (c.trimOut ?? c.duration ?? 10) - (c.trimIn || 0));
    }
  }
  return s;
}
function showReplayCountdown(remaining) {
  const total = remaining + playlistRemainingAfterCurrent();
  const txt = fmtClock(total);
  const elT = el('rp-time-left');
  if (elT) {
    elT.textContent = txt;
    elT.classList.add('live');
    elT.classList.toggle('ending', total <= 5 && total > 0 && !_plLiveActive);
  }
  const mon = el('rp-mon-timer'); if (mon) mon.textContent = txt;
  _replayCountdownLive = true;
}
function stopReplayCountdown() {
  const elT = el('rp-time-left');
  if (elT) { elT.textContent = '--:--'; elT.classList.remove('live', 'ending'); }
  const mon = el('rp-mon-timer'); if (mon) mon.textContent = '';
  _replayCountdownLive = false;
}
// Watchdog: a single-clip replay that finished (or whose last frame is held) stops sending progress.
// If the panel readout is still counting but no report has arrived for ~2s, blank it. Playlists
// report continuously and end via finishPlayout(), so they're left alone.
setInterval(() => {
  if (_replayCountdownLive && !_plLiveActive && Date.now() - _lastProgressRx > 2000) stopReplayCountdown();
}, 700);

// PVW / PGM confidence monitors — mirror the two replay buses as muted in-panel video so
// the producer sees what's cued vs. live without an OBS multiview.
function applyReplayMonitors(replay) {
  replay = replay || {};
  setReplayMonitor('rp-mon-pvw', 'rp-mon-pvw-cell', replay.preview);
  setReplayMonitor('rp-mon-pgm', 'rp-mon-pgm-cell', replay.program);
  // Authoritative revert: if the server says nothing is on the program bus (and no playlist is
  // sequencing), blank the panel's own time-remaining readout.
  const onAir = (replay.program && replay.program.playing) || _plLiveActive || _replayActive;
  if (_replayCountdownLive && !(replay.program && replay.program.playing) && !_plLiveActive) stopReplayCountdown();
  // Show the on-air Stop button whenever something is live (covers a looping single clip, which
  // otherwise had no visible way to stop).
  const sb = el('rp-stop-program'); if (sb) sb.style.display = onAir ? '' : 'none';
  rpSyncOnAir(onAir);
}
function setReplayMonitor(vidId, cellId, bus) {
  const v = el(vidId); const cell = el(cellId); if (!v || !cell) return;
  const live = !!(bus && bus.playing && bus.url);
  if (live) {
    // Mirror the producer's trim so the monitor shows exactly what airs.
    v._trimIn = (typeof bus.trimIn === 'number' && bus.trimIn > 0) ? bus.trimIn : 0;
    v._trimOut = (typeof bus.trimOut === 'number' && bus.trimOut > v._trimIn) ? bus.trimOut : null;
    v._trimLoop = !!bus.loop;
    wireMonitorTrim(v);
    if (v.dataset.src !== bus.url) {
      v.dataset.src = bus.url; v.src = bus.url; v.loop = false;
      v.muted = true;            // monitors are silent; OBS carries the real audio
      const p = v.play(); if (p && p.catch) p.catch(() => {});
    }
    cell.classList.add('live');
  } else {
    if (v.dataset.src) { v.dataset.src = ''; v.pause(); v.removeAttribute('src'); v.load(); }
    cell.classList.remove('live');
  }
}
// Seek a monitor to its in-point and loop/hold at its out-point (matching the on-air player).
function wireMonitorTrim(v) {
  if (v._trimWired) return; v._trimWired = true;
  v.addEventListener('loadedmetadata', () => {
    if (v._trimIn > 0 && v.currentTime < v._trimIn - 0.05) { try { v.currentTime = v._trimIn; } catch (e) {} }
  });
  v.addEventListener('timeupdate', () => {
    if (v._trimOut != null && v.currentTime >= v._trimOut - 0.02) {
      if (v._trimLoop) { try { v.currentTime = v._trimIn || 0; } catch (e) {} }
      else v.pause();   // hold on the last frame, just like the program output
    }
  });
  v.addEventListener('ended', () => {
    if (v._trimLoop) { try { v.currentTime = v._trimIn || 0; } catch (e) {} const p = v.play(); if (p && p.catch) p.catch(() => {}); }
  });
}

// Prompt-mode pop-up: "Clip this highlight?" → accept sends clip_prompt_accept.
function showClipPrompt(p) {
  const wrap = el('clip-prompts'); if (!wrap || !p) return;
  const card = document.createElement('div');
  card.className = 'clip-prompt';
  card.innerHTML = `
    <div class="cp-body"><span class="cp-dot"></span>
      <div><div class="cp-title"></div><div class="cp-sub">Clip this?</div></div></div>
    <div class="cp-actions">
      <button class="btn btn-primary btn-sm cp-yes">Clip it</button>
      <button class="btn btn-ghost btn-sm cp-no">Dismiss</button>
    </div>`;
  card.querySelector('.cp-title').textContent = (p.label || 'Highlight') + (p.player ? ' · ' + p.player : '');
  const remove = () => { card.classList.add('out'); setTimeout(() => card.remove(), 200); };
  card.querySelector('.cp-yes').addEventListener('click', () => { send('clip_prompt_accept', { meta: p.meta }); remove(); });
  card.querySelector('.cp-no').addEventListener('click', remove);
  setTimeout(remove, 12000);  // auto-dismiss (replay buffer window)
  wrap.appendChild(card);
  while (wrap.children.length > 4) wrap.firstChild.remove();
}

let _lastReplayFolder;
function applyClipsState(c) {
  if (!c) return;
  const folder = el('input-replay-folder');
  if (folder && document.activeElement !== folder) folder.value = c.replayFolder || '';
  const folder2 = el('rp-staging-folder-input');
  if (folder2 && document.activeElement !== folder2) folder2.value = c.replayFolder || '';
  // Rescan staging when the replay folder changes (e.g. after the native Browse dialog picks one).
  if (_lastReplayFolder !== undefined && _lastReplayFolder !== (c.replayFolder || '')) setTimeout(() => scanStagingArea(), 200);
  _lastReplayFolder = c.replayFolder || '';

  const mode = c.captureMode || 'auto';
  document.querySelectorAll('#clip-mode-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  const am = el('check-auto-montage'); if (am && document.activeElement !== am) am.checked = !!c.autoMontage;
  const desc = el('clip-mode-desc');
  if (desc) desc.textContent = {
    auto: 'Highlights are clipped automatically as they happen.',
    prompt: 'When a highlight happens, a pop-up asks if you want to clip it.',
    manual: 'Nothing is clipped automatically — use "Capture now".'
  }[mode] || '';
  const rules = c.captureRules || {};
  [['goal', 'check-capture-goal'], ['ace', 'check-capture-ace'], ['clutch', 'check-capture-clutch'], ['save', 'check-capture-save'], ['demo', 'check-capture-demo'], ['shot', 'check-capture-shot']].forEach(([k, id]) => {
    const cb = el(id); if (cb) cb.checked = rules[k] !== false;
  });

  refreshStagingImportedFlags();
  renderStagingList();

  const montageListEl = el('montage-list');
  if (montageListEl) {
    const exps = (c.montages || []).filter((m) => m.outputPath);   // only encoded exports
    // Signature-guard: this rebuild fires on every full_state broadcast, but the encoded-export
    // list rarely changes. Skip the innerHTML + listener re-attach unless the exports actually differ
    // (id/name/clip-count/output-path — the last so a re-encode refreshes the click-handler closures).
    const _mSig = exps.map((m) => m.id + ':' + (m.name || '') + ':' + ((m.clipIds || []).length) + ':' + (m.outputPath || '')).join('|');
    if (montageListEl.dataset.sig !== _mSig) {
    montageListEl.dataset.sig = _mSig;
    montageListEl.classList.toggle('empty', !exps.length);
    montageListEl.innerHTML = exps.length ? exps.map((m) => {
      const n = (m.clipIds || []).length;
      return `<div class="montage-card">
        <div class="montage-card-name" title="${(m.name || 'Montage').replace(/"/g, '&quot;').replace(/</g, '&lt;')}">${(m.name || 'Montage').replace(/</g, '&lt;')}</div>
        <div class="montage-card-meta">${n} clip${n === 1 ? '' : 's'} &middot; encoded</div>
        <div class="montage-card-actions">
          <button class="btn btn-secondary btn-sm btn-montage-prev" data-mid="${m.id}" title="Watch this export in the player (off air)">Preview</button>
          <button class="btn btn-danger btn-sm btn-montage-screen" data-mid="${m.id}" title="Play this export on Program">To air</button>
          <button class="btn btn-secondary btn-sm btn-montage-save" data-mid="${m.id}" title="Save encoded file to disk">Save As&hellip;</button>
          <button class="rp-vi-del btn-montage-delx" data-mid="${m.id}" title="Delete this encoded file (the playlist stays)">&times;</button>
        </div>
      </div>`;
    }).join('') : '<div class="montage-list-empty">No exports yet — encode a playlist to create one.</div>';
    montageListEl.querySelectorAll('.btn-montage-screen').forEach((btn) => {
      btn.addEventListener('click', () => {
        const m = (c.montages || []).find((x) => x.id === btn.dataset.mid);
        const url = montageUrl(m); if (!url) return;
        beginReplayProgram();   // exported montages already have transitions baked in
        send('replay_play', { bus: 'program', url, name: m.name || 'Montage', loop: !!el('rp-loop')?.checked });
        const st = el('rp-screen-status'); if (st) { st.textContent = 'ON AIR: ' + (m.name || 'Montage'); st.style.color = 'var(--good, #48bb78)'; }
      });
    });
    montageListEl.querySelectorAll('.btn-montage-prev').forEach((btn) => {
      btn.addEventListener('click', () => {
        const m = (c.montages || []).find((x) => x.id === btn.dataset.mid);
        if (!m) return;
        rpPreviewExport(m);
      });
    });
    montageListEl.querySelectorAll('.btn-montage-save').forEach((btn) => {
      btn.addEventListener('click', () => send('montage_save_export', { montageId: btn.dataset.mid }));
    });
    montageListEl.querySelectorAll('.btn-montage-delx').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = await customConfirm('Delete Export', 'Delete this encoded file? The playlist stays and can be re-encoded.', 'Delete');
        if (ok) send('montage_delete_export', { montageId: btn.dataset.mid });
      });
    });
    }
  }

  renderClipPool(c);
  rpRenderQueue();
  rpSyncPlayerActions();
  renderPlaylistPane(c);
  // Keep social clip-prep dropdowns in sync when the library updates
  if (el('soc-panel-clipprep') && el('soc-panel-clipprep').style.display !== 'none') {
    if (typeof window._socHandleEncodeProgress !== 'undefined') {
      // socPopulateClipDropdowns is defined inside the Social IIFE — call via window bridge
      if (typeof window._socPopulateClipDropdowns === 'function') window._socPopulateClipDropdowns();
    }
  }
}

// ── Clip preview + visual trim bar ─────────────────────────────────────────
let _previewClip = null;
function clipUrl(clip) {
  if (!clip) return '';
  if (clip._url) return clip._url;
  if (clip.rawPath) return fileUrl(clip.rawPath);
  if (!clip.path) return '';
  const base = 'http://127.0.0.1:3000/data/clips/' + clip.path.split(/[\\/]/).pop();
  // A Highlights copy of a Replays clip (or vice versa — clip_copy_folder, see the clip pool) shares
  // the exact same underlying file/URL by design (no video is ever duplicated on disk). But
  // replay-player.html treats an unchanged URL as "already showing this, just resume" and skips the
  // reload/transition entirely (see its `sameUrl && wasLive` check) — so pushing a copy right after
  // its original silently produced no fade/cut at all. Tag the clip's own id on so two DIFFERENT
  // clip records never collide into one "same thing" URL; express.static ignores the query string.
  return clip.id ? base + '?cid=' + encodeURIComponent(clip.id) : base;
}

function updateTrimBar() {
  if (!_previewClip) return;
  const track = el('rp-trim-track'); if (!track) return;
  const v = el('clip-preview-video');
  const dur = v?.duration || 0;
  if (dur <= 0) return;
  const W = track.offsetWidth;
  const inPct  = ((_previewClip.trimIn || 0) / dur) * 100;
  const outPct = (_previewClip.trimOut != null ? _previewClip.trimOut : dur) / dur * 100;
  const nowPct = ((v?.currentTime || 0) / dur) * 100;

  const region = el('rp-trim-region');
  if (region) { region.style.left = inPct + '%'; region.style.width = (outPct - inPct) + '%'; }

  const hIn = el('rp-trim-handle-in');
  if (hIn) hIn.style.left = inPct + '%';

  const hOut = el('rp-trim-handle-out');
  if (hOut) hOut.style.right = (100 - outPct) + '%';

  const ph = el('rp-trim-playhead');
  if (ph) ph.style.left = nowPct + '%';

  const inVal  = el('clip-trim-in-val');
  const outVal = el('clip-trim-out-val');
  if (inVal)  inVal.textContent  = fmtTime(_previewClip.trimIn || 0);
  if (outVal) outVal.textContent = _previewClip.trimOut != null ? fmtTime(_previewClip.trimOut) : 'end';

  const durEl = el('rp-trim-dur');
  const effectiveDur = (_previewClip.trimOut ?? dur) - (_previewClip.trimIn || 0);
  if (durEl) durEl.textContent = fmtTime(effectiveDur);
}

function initTrimBar() {
  const track = el('rp-trim-track'); if (!track) return;
  const v = el('clip-preview-video'); if (!v) return;
  v.addEventListener('timeupdate', updateTrimBar);
  v.addEventListener('loadedmetadata', () => {
    const t0 = el('rp-trim-t0'); if (t0) t0.textContent = '0:00.0';
    const dur = el('rp-trim-dur'); if (dur) dur.textContent = fmtTime(v.duration);
    updateTrimBar();
    generateFilmstrip(v);
  });
  function timeFromX(clientX) {
    const rect = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * (v.duration || 0);
  }
  let dragTarget = null;
  function onPointerMove(e) {
    if (!dragTarget) return;
    const t = timeFromX(e.clientX);
    if (dragTarget === 'in') {
      _previewClip.trimIn = Math.min(t, _previewClip.trimOut != null ? _previewClip.trimOut - 0.1 : (v.duration || 0));
      v.currentTime = _previewClip.trimIn;
    } else if (dragTarget === 'out') {
      _previewClip.trimOut = Math.max(t, (_previewClip.trimIn || 0) + 0.1);
      v.currentTime = _previewClip.trimOut;
    } else {
      v.currentTime = t;
    }
    updateTrimBar();
    const tip = el('rp-trim-time-cur');
    if (tip) { tip.textContent = fmtTime(t); tip.style.left = Math.min(95, ((t / (v.duration || 1)) * 100)) + '%'; tip.style.opacity = '1'; }
  }
  function onPointerUp() {
    dragTarget = null;
    const tip = el('rp-trim-time-cur'); if (tip) tip.style.opacity = '0';
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
  }
  el('rp-trim-handle-in')?.addEventListener('pointerdown', (e) => {
    if (!_previewClip) return; e.preventDefault(); dragTarget = 'in';
    document.addEventListener('pointermove', onPointerMove); document.addEventListener('pointerup', onPointerUp);
  });
  el('rp-trim-handle-out')?.addEventListener('pointerdown', (e) => {
    if (!_previewClip) return; e.preventDefault(); dragTarget = 'out';
    document.addEventListener('pointermove', onPointerMove); document.addEventListener('pointerup', onPointerUp);
  });
  track.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.rp-trim-handle')) return;
    if (!_previewClip) return; e.preventDefault(); dragTarget = 'seek';
    v.currentTime = timeFromX(e.clientX); updateTrimBar();
    document.addEventListener('pointermove', onPointerMove); document.addEventListener('pointerup', onPointerUp);
  });
}

// ── Editor transport bar ──────────────────────────────────────────────────
// One consistent player for every clip. (The native `controls` bar changes shape based on what the
// browser has decoded — clips that had only loaded metadata got Chromium's compact audio-style bar,
// which is why the editor looked like it had two different players.)
function rpVtFmt(s) {
  s = Math.max(0, Math.floor(Number(s) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function rpVtSync() {
  const v = el('clip-preview-video'); if (!v) return;
  const playing = !v.paused && !v.ended;
  const btn = el('rp-vt-play');
  if (btn) {
    btn.querySelector('.rp-vt-i-play').style.display = playing ? 'none' : '';
    btn.querySelector('.rp-vt-i-pause').style.display = playing ? '' : 'none';
    btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }
  const dur = isFinite(v.duration) ? v.duration : 0;
  const t = el('rp-vt-time'); if (t) t.textContent = rpVtFmt(v.currentTime) + ' / ' + rpVtFmt(dur);
  const seek = el('rp-vt-seek');
  if (seek && document.activeElement !== seek && !seek.dataset.dragging) {
    seek.value = String(dur > 0 ? Math.round((v.currentTime / dur) * 1000) : 0);
  }
  const mute = el('rp-vt-mute');
  if (mute) {
    const off = v.muted || v.volume === 0;
    mute.querySelector('.rp-vt-i-vol').style.display = off ? 'none' : '';
    mute.querySelector('.rp-vt-i-muted').style.display = off ? '' : 'none';
  }
}
function rpVtTogglePlay() {
  const v = el('clip-preview-video'); if (!v || !v.src) return;
  if (v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); } else v.pause();
}
(function wireEditorTransport() {
  const v = el('clip-preview-video'); if (!v) return;
  ['play', 'pause', 'ended', 'timeupdate', 'loadedmetadata', 'volumechange', 'emptied'].forEach((ev) => v.addEventListener(ev, rpVtSync));
  el('rp-vt-play')?.addEventListener('click', rpVtTogglePlay);
  const seek = el('rp-vt-seek');
  if (seek) {
    const apply = () => {
      const dur = isFinite(v.duration) ? v.duration : 0;
      if (dur > 0) { try { v.currentTime = (Number(seek.value) / 1000) * dur; } catch (_) {} }
    };
    seek.addEventListener('pointerdown', () => { seek.dataset.dragging = '1'; });
    seek.addEventListener('input', apply);
    seek.addEventListener('change', () => { apply(); delete seek.dataset.dragging; });
    seek.addEventListener('pointerup', () => { delete seek.dataset.dragging; });
  }
  el('rp-vt-mute')?.addEventListener('click', () => { v.muted = !v.muted; rpVtSync(); });
  const vol = el('rp-vt-vol');
  if (vol) vol.addEventListener('input', () => { v.volume = Math.max(0, Math.min(1, Number(vol.value) / 100)); v.muted = v.volume === 0; });
  el('rp-vt-full')?.addEventListener('click', () => {
    if (document.fullscreenElement) { document.exitFullscreen?.(); return; }
    (v.requestFullscreen ? v.requestFullscreen() : v.webkitRequestFullscreen?.())?.catch?.(() => {});
  });
  rpVtSync();
})();

// Containers a browser will actually decode. Everything else (.mkv from OBS's default recorder,
// .mov, .avi, .ts, …) has to go through the server's transcode before the editor can show it.
const RP_BROWSER_PLAYABLE = /\.(mp4|m4v|webm|ogv|ogg)$/i;
const _rpPreparedPreview = new Map();   // source path -> playable url (per session; server caches the file)
async function rpUsePreparedPreview(srcPath, paint) {
  const v = el('clip-preview-video'); if (!v) return;
  const nm = el('clip-preview-name');
  const stillCurrent = () => _previewClip && ((_previewClip.path || _previewClip.rawPath) === srcPath);
  const apply = (url) => {
    if (!stillCurrent()) return;               // producer moved on to another clip
    v.src = url; v.load();
    if (v.readyState >= 1) paint(); else v.addEventListener('loadedmetadata', paint, { once: true });
    if (nm) { nm.textContent = _previewClip.name || 'Clip'; nm.style.color = ''; }
  };
  const cached = _rpPreparedPreview.get(srcPath);
  if (cached) { apply(cached); return; }
  const ext = (srcPath.match(/\.[^.]+$/) || [''])[0].toUpperCase();
  if (nm) { nm.textContent = `Converting ${ext} for preview… (it plays on air either way)`; nm.style.color = 'var(--muted)'; }
  try {
    const r = await fetch('http://127.0.0.1:3000/api/clips/preview-src?path=' + encodeURIComponent(srcPath));
    const d = await r.json();
    if (!d.ok || !d.url) throw new Error(d.message || 'convert failed');
    const url = 'http://127.0.0.1:3000' + d.url;
    _rpPreparedPreview.set(srcPath, url);
    apply(url);
  } catch (e) {
    if (stillCurrent() && nm) {
      nm.textContent = `Can't preview ${ext} in the editor — it still plays on air. (${e.message})`;
      nm.style.color = '#fbbf24';
    }
  }
}

function loadClipPreview(clip) {
  // Loading a single clip by hand (pool, staging, timeline row) leaves playlist-preview mode —
  // unless the preview engine itself is the one advancing to the next clip.
  if (!_plPreviewLoading && _plPreview) rpPreviewStop(false);
  const url = clipUrl(clip);
  _previewClip = {
    id: clip.id || null,
    rawPath: clip.rawPath || null,
    path: clip.path || null,
    name: clip.name || 'Clip',
    trimIn: clip.trimIn || 0,
    trimOut: clip.trimOut != null ? clip.trimOut : null,
    tags: Array.isArray(clip.tags) ? clip.tags.slice() : [],
    _url: url
  };
  selectedClipId = clip.id || null;
  const v = el('clip-preview-video');
  if (v) {
    // Show the clip, don't just mount it. The element was preload="metadata", so clicking a card
    // gave you a black rectangle that knew its duration but had never decoded a frame — it only
    // appeared once you pressed play. Now: the stored thumbnail is the poster (instant picture),
    // the file preloads, and we nudge to the in-point so a real frame paints and the producer can
    // scrub immediately. Playback still waits for the producer — auto-playing audio on every card
    // click mid-show is not something to do to someone.
    v.preload = 'auto';
    const srcPath = clip.path || clip.rawPath || '';
    const poster = srcPath ? thumbUrl(srcPath) : '';
    if (poster) v.setAttribute('poster', poster); else v.removeAttribute('poster');
    const sp = el('rp-speed'); v.playbackRate = sp ? Number(sp.value) || 1 : 1;
    const startAt = _previewClip.trimIn || 0;
    const paint = () => {
      // A tiny offset when there's no in-point: currentTime = 0 is where we already are, so it
      // wouldn't trigger the seek that forces the decode.
      try { v.currentTime = startAt > 0 ? startAt : Math.min(0.05, (v.duration || 1) / 2); } catch (_) {}
    };
    // Containers Chromium can't decode (OBS records .mkv by DEFAULT) mount and report a duration
    // but never paint a frame — the clip looks broken in the editor while playing fine on air.
    // Go straight to the server's prepared .mp4 for those instead of pulling the whole unplayable
    // file down first.
    if (srcPath && !RP_BROWSER_PLAYABLE.test(srcPath)) {
      v.removeAttribute('src'); v.load();
      rpUsePreparedPreview(srcPath, paint);
    } else {
      v.src = url;
      v.load();
      if (v.readyState >= 1) paint(); else v.addEventListener('loadedmetadata', paint, { once: true });
    }
  }
  const nm = el('clip-preview-name'); if (nm) nm.textContent = clip.name || 'Clip';
  const t = el('rp-title'); if (t) t.value = clip.name || '';
  const d = el('rp-desc'); if (d) d.value = clip.description || clip.note || '';
  const mp = el('rp-map'); if (mp) mp.value = clip.map || '';
  renderClipTags();
  updateTrimBar();
}

// Tag chips for the clip editor (training labels for the auto-clip model).
function renderClipTags() {
  const wrap = el('rp-tags'); if (!wrap) return;
  const tags = (_previewClip && _previewClip.tags) || [];
  wrap.innerHTML = '';
  tags.forEach((tag, i) => {
    const chip = document.createElement('span'); chip.className = 'rp-tag-chip';
    chip.textContent = tag;
    const x = document.createElement('button'); x.type = 'button'; x.className = 'rp-tag-x'; x.textContent = '×'; x.title = 'Remove';
    x.addEventListener('click', () => { _previewClip.tags.splice(i, 1); renderClipTags(); });
    chip.appendChild(x); wrap.appendChild(chip);
  });
}
function addClipTag(raw) {
  if (!_previewClip) return;
  if (!Array.isArray(_previewClip.tags)) _previewClip.tags = [];
  String(raw || '').split(',').forEach((part) => {
    const t = part.trim().toLowerCase();
    if (t && !_previewClip.tags.includes(t) && _previewClip.tags.length < 24) _previewClip.tags.push(t);
  });
  renderClipTags();
}
el('rp-tag-input')?.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addClipTag(this.value); this.value = ''; }
  else if (e.key === 'Backspace' && !this.value && _previewClip?.tags?.length) { _previewClip.tags.pop(); renderClipTags(); }
});
el('rp-tag-input')?.addEventListener('blur', function () { if (this.value.trim()) { addClipTag(this.value); this.value = ''; } });

initTrimBar();
// Surface a genuine video-load failure in the editor instead of spinning forever.
el('clip-preview-video')?.addEventListener('error', function () {
  const nm = el('clip-preview-name');
  if (nm) { nm.textContent = 'Could not load this video (format or file access).'; nm.style.color = '#f56565'; }
});

// Keyboard shortcuts for the video editor
document.addEventListener('keydown', (e) => {
  const v = el('clip-preview-video');
  const activeTag = document.activeElement?.tagName;
  if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return;
  if (!v || !_previewClip) return;
  const dur = v.duration || 0;
  const fps = 30;
  if (e.code === 'Space') { e.preventDefault(); v.paused ? v.play() : v.pause(); }
  else if (e.code === 'KeyI') { _previewClip.trimIn = Math.round(v.currentTime * 10) / 10; updateTrimBar(); }
  else if (e.code === 'KeyO') { _previewClip.trimOut = Math.round(v.currentTime * 10) / 10; updateTrimBar(); }
  else if (e.code === 'KeyC') { _previewClip.trimIn = 0; _previewClip.trimOut = null; updateTrimBar(); }
  else if (e.code === 'KeyJ') { v.currentTime = Math.max(0, v.currentTime - 2); }
  else if (e.code === 'KeyL') { v.currentTime = Math.min(dur, v.currentTime + 2); }
  else if (e.code === 'ArrowLeft') { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 1 / fps); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); v.currentTime = Math.min(dur, v.currentTime + 1 / fps); }
});

el('clip-set-in')?.addEventListener('click', () => {
  const v = el('clip-preview-video'); if (!v || !_previewClip) return;
  _previewClip.trimIn = Math.round(v.currentTime * 10) / 10;
  if (_previewClip.trimOut != null && _previewClip.trimOut <= _previewClip.trimIn) _previewClip.trimOut = null;
  updateTrimBar();
});
el('clip-set-out')?.addEventListener('click', () => {
  const v = el('clip-preview-video'); if (!v || !_previewClip) return;
  const t = Math.round(v.currentTime * 10) / 10;
  _previewClip.trimOut = t > (_previewClip.trimIn || 0) ? t : null;
  updateTrimBar();
});
el('clip-go-in')?.addEventListener('click', () => { const v = el('clip-preview-video'); if (v && _previewClip) v.currentTime = _previewClip.trimIn || 0; });
el('clip-go-out')?.addEventListener('click', () => { const v = el('clip-preview-video'); if (v && _previewClip && _previewClip.trimOut != null) v.currentTime = _previewClip.trimOut; });
el('clip-trim-clear')?.addEventListener('click', () => { if (_previewClip) { _previewClip.trimIn = 0; _previewClip.trimOut = null; updateTrimBar(); } });
el('clip-trim-save')?.addEventListener('click', async () => {
  if (!_previewClip) return;
  const st = el('clips-status');
  // Raw staging file — import first, then save trim
  if (!_previewClip.id && _previewClip.rawPath) {
    if (st) { st.textContent = 'Importing before save…'; st.style.color = ''; }
    try {
      const resp = await fetch('http://127.0.0.1:3000/api/clips/import-file', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: _previewClip.rawPath, label: el('rp-title')?.value || _previewClip.name })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || 'Import failed');
      _previewClip.id = data.clip?.id;
      // fall through to save trim
    } catch (err) {
      if (st) { st.textContent = 'Import failed: ' + err.message; st.style.color = '#f56565'; }
      return;
    }
  }
  // Fold any half-typed tag into the set before saving.
  const tagInput = el('rp-tag-input'); if (tagInput && tagInput.value.trim()) { addClipTag(tagInput.value); tagInput.value = ''; }
  send('clip_update', {
    id: _previewClip.id,
    name: el('rp-title')?.value ?? _previewClip.name,
    description: el('rp-desc')?.value || '',
    map: el('rp-map')?.value || '',
    trimIn: _previewClip.trimIn || 0,
    trimOut: _previewClip.trimOut,
    tags: (_previewClip.tags || []),
    note: el('rp-desc')?.value || ''
  });
  if (st) { st.textContent = 'Saved.'; st.style.color = 'var(--good, #48bb78)'; }
});
el('rp-speed')?.addEventListener('change', function () {
  const v = el('clip-preview-video'); if (v) v.playbackRate = Number(this.value) || 1;
});

// ── REPLAYS: buffer + send-to-screen (program / preview buses) ────────────
function montageUrl(m) {
  if (!m || !m.outputPath) return '';
  return 'http://127.0.0.1:3000/data/clips/exports/' + m.outputPath.split(/[\\/]/).pop();
}
// Status badge for a playlist row — one glance to answer "will Play Live be instant or does it
// need to encode first, and is this the thing currently on air?" `encodeActive` is c.encode?.active
// (already carries montageId — see montage-encoder.js summarize()), so this can attribute an
// in-progress encode to the exact row it belongs to, not just show a global spinner.
function montageBadgeInfo(m, encodeActive, encodeQueue) {
  if (!(m.clipIds || []).length) return { cls: 'empty', label: 'EMPTY' };
  if (_plLiveActive && _plLiveMontageId === m.id) return { cls: 'live', label: '● LIVE' };
  if (encodeActive && encodeActive.montageId === m.id && (encodeActive.status === 'encoding' || encodeActive.status === 'queued')) {
    return { cls: 'encoding', label: 'ENCODING ' + (encodeActive.progress || 0) + '%' };
  }
  // Enqueued but not yet the active job — enqueueMontage() marks the montage 'encoding' the moment
  // it's queued (so Play Live knows not to re-encode it), but without this check it'd fall through
  // to DRAFT here since it's neither the active job nor already exported.
  if ((encodeQueue || []).some((j) => j.montageId === m.id && j.status === 'queued')) {
    return { cls: 'encoding', label: 'QUEUED' };
  }
  if (m.status === 'error') return { cls: 'error', label: 'ERROR' };
  if (montageUrl(m)) return { cls: 'ready', label: 'READY' };
  return { cls: 'draft', label: 'DRAFT' };
}
// Fuller status line for the expanded card — same inputs, more words (bus/scene detail on LIVE).
function montageStatusLine(m, encodeActive, encodeQueue) {
  const b = montageBadgeInfo(m, encodeActive, encodeQueue);
  if (b.cls === 'live') {
    const via = _plEncodedMode ? ('file · bus ' + _plBus) : 'per-clip · program bus';
    return 'LIVE · ' + via + (_plScene ? (' · scene ' + _plScene) : '');
  }
  if (b.cls === 'encoding') return b.label === 'QUEUED' ? 'Queued — waiting on another encode to finish' : b.label + '…';
  if (b.cls === 'ready') return 'Encoded — Play Live plays the file instantly';
  if (b.cls === 'error') return 'Last encode failed — try again';
  if (b.cls === 'empty') return 'No clips yet';
  return 'Not encoded — Play Live will encode first';
}
// Resolve the URL + label for whatever the editor currently has loaded.
function currentEditorClip() {
  if (!_previewClip) return null;
  const url = _previewClip._url || clipUrl(_previewClip);
  return { url, name: el('rp-title')?.value || _previewClip.name || 'Replay' };
}
// When pushing to Program, optionally switch OBS to the scene the producer picked on this page.
const RP_PROGRAM_SCENE_KEY = 'ne_replay_program_scene';
function replaySwitchProgramScene() {
  const sc = el('rp-program-scene')?.value;
  if (sc) send('obs_switch_scene', { sceneName: sc });
}
// Playout-readiness state — declared before its first reader (syncReplayProgramScene) so a render
// during load can never hit a temporal-dead-zone ReferenceError.
const RP_PLAYER_SOURCE_NAME = '[NE] Replay Player';
let _rpPlayerScenes = [];        // [{ scene, source, enabled, url }] — scenes holding the player
let _rpPlayerChecked = false;    // have we heard back from OBS at least once?
let _rpPlayerCheckErr = '';
let _rpPlayerSig = '';           // re-check when OBS connects or the scene list changes

function syncReplayProgramScene(obs) {
  const sel = el('rp-program-scene'); if (!sel) return;
  const scenes = Array.isArray(obs && obs.availableScenes) ? obs.availableScenes : [];
  const saved = (() => { try { return localStorage.getItem(RP_PROGRAM_SCENE_KEY) || ''; } catch { return ''; } })();
  const want = sel.value || saved;
  // Ask OBS which scenes hold the player whenever the connection or the scene list changes.
  const csig = ((obs && obs.connected) ? '1' : '0') + '|' + JSON.stringify(scenes);
  if (csig !== _rpPlayerSig) {
    _rpPlayerSig = csig;
    _rpPlayerChecked = false;
    if (obs && obs.connected) rpCheckPlayerSource(); else _rpPlayerScenes = [];
  }
  // Scenes that hold the replay player are marked "✓ ready" right in the list, so picking a scene
  // that can actually show a clip doesn't require trial and error on air.
  const ready = new Set(_rpPlayerScenes.map((s) => s.scene));
  const sig = JSON.stringify(scenes) + '|' + JSON.stringify([...ready].sort());
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = '<option value="">OBS scene: none</option>' +
      scenes.map((s) => {
        const v = String(s).replace(/"/g, '&quot;');
        const t = String(s).replace(/</g, '&lt;') + (ready.has(s) ? '  ✓ ready' : '');
        return `<option value="${v}">${t}</option>`;
      }).join('');
  }
  if (want && scenes.includes(want) && document.activeElement !== sel) sel.value = want;
  rpRenderPlayoutReady();
  // Keep the OBS-transition picker filled once OBS connects (it's populated from the same state),
  // and read the selected transition's details the first time we're actually connected.
  if (el('rp-pool-transition')?.value === 'obs' && typeof rpSyncObsTransitions === 'function') {
    rpSyncObsTransitions();
    const nm = el('rp-pool-obstrans')?.value || '';
    if (nm && _rpObsTrans.name !== nm && obs && obs.connected) rpAskObsTransInfo();
  }
}
el('rp-program-scene')?.addEventListener('change', function () {
  try { localStorage.setItem(RP_PROGRAM_SCENE_KEY, this.value || ''); } catch {}
  rpRenderPlayoutReady();
});

// ── Playout readiness: is the replay player actually in the scene we cut to? ───────────────
// The whole To Air path (single clip, pool Play all, playlist) ends at ONE browser source —
// /replay-player.html — living in an OBS scene. If that source isn't there, every step still
// reports success and nothing reaches the stream, which is indistinguishable from "To Air is
// broken". The server reports which scenes hold it (obs_check_replay_source); this strip says so
// and can add the source for you.
let _rpCheckTimer = null;
function rpCheckPlayerSource() {
  clearTimeout(_rpCheckTimer);
  _rpCheckTimer = setTimeout(() => {
    if (currentState && currentState.obs && currentState.obs.connected) send('obs_check_replay_source', {});
  }, 250);
}
function rpRenderPlayoutReady() {
  const wrap = el('rp-ready'); if (!wrap) return;
  const obs = (currentState && currentState.obs) || {};
  const scene = (el('rp-program-scene')?.value || '').trim();
  const dot = el('rp-ready-dot'), text = el('rp-ready-text'), fix = el('rp-ready-fix');
  let level = 'warn', msg = '', showFix = false;
  if (!obs.enabled) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  const hit = _rpPlayerScenes.find((s) => s.scene === scene);
  if (!obs.connected) {
    msg = 'OBS is not connected, so clips cannot reach the stream. Connect it from the bar at the bottom.';
  } else if (!scene) {
    msg = _rpPlayerScenes.length
      ? `Pick a scene above — ${_rpPlayerScenes.map((s) => '"' + s.scene + '"').join(', ')} ${_rpPlayerScenes.length === 1 ? 'has' : 'have'} the replay player.`
      : 'Pick the OBS scene that shows replays, then add the player source to it.';
  } else if (!_rpPlayerChecked) {
    msg = _rpPlayerCheckErr || 'Checking OBS for the replay player…';
  } else if (!hit) {
    msg = `"${scene}" has no replay player source — clips will play to nothing.`;
    showFix = true;
  } else if (!hit.enabled) {
    msg = `"${hit.source}" is hidden in "${scene}" — unhide it in OBS or clips won't be visible.`;
  } else {
    level = 'ok';
    msg = `Ready — "${hit.source}" in "${scene}".`;
  }
  if (dot) dot.className = 'rp-ready-dot ' + level;
  if (text) text.textContent = msg;
  wrap.classList.toggle('ok', level === 'ok');
  if (fix) fix.style.display = showFix ? '' : 'none';
}
el('rp-ready-recheck')?.addEventListener('click', () => { _rpPlayerChecked = false; rpRenderPlayoutReady(); rpCheckPlayerSource(); });
el('rp-ready-fix')?.addEventListener('click', () => {
  const scene = (el('rp-program-scene')?.value || '').trim();
  if (!scene) { showToast('Pick the OBS scene first.', '#fbbf24', 3500); return; }
  // Same helper LISTEN IN's "Add to OBS" uses: creates the source (audio rerouted + monitored so
  // clip audio reaches the stream) or retargets it if a source by this name already exists.
  send('obs_ensure_browser_source', {
    sceneName: scene,
    sourceName: RP_PLAYER_SOURCE_NAME,
    url: (window.SCENE_BASE_URL || 'http://localhost:3000') + '/replay-player.html',
  });
  setTimeout(rpCheckPlayerSource, 900);   // let OBS settle, then confirm it landed
});

// Graphics "Auto-cut OBS" (Production ▸ Graphics ▸ On air): keep the destination-scene dropdown filled
// from OBS's scene list and restore the producer's saved choice + toggle across reloads. On Push Live,
// doPush() reads these elements and cuts OBS to the chosen scene (see doPush).
const GFX_AUTOCUT_SCENE_KEY = 'ne_gfx_autocut_scene';
const GFX_AUTOCUT_ON_KEY = 'ne_gfx_autocut_on';
function syncGfxAutocutScene(obs) {
  const sel = el('gfx-autocut-scene'); if (!sel) return;
  const scenes = Array.isArray(obs && obs.availableScenes) ? obs.availableScenes : [];
  const saved = (() => { try { return localStorage.getItem(GFX_AUTOCUT_SCENE_KEY) || ''; } catch { return ''; } })();
  const want = sel.value || saved;
  const sig = JSON.stringify(scenes);
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = '<option value="">— scene —</option>' +
      scenes.map((s) => `<option value="${String(s).replace(/"/g, '&quot;')}">${String(s).replace(/</g, '&lt;')}</option>`).join('');
  }
  if (want && scenes.includes(want) && document.activeElement !== sel) sel.value = want;
  // Keep the GFX topbar's OBS chip + live badge in step with server state (runs per full_state).
  if (typeof window._gfxRefreshTopBar === 'function') window._gfxRefreshTopBar();
}
el('gfx-autocut-scene')?.addEventListener('change', function () {
  try { localStorage.setItem(GFX_AUTOCUT_SCENE_KEY, this.value || ''); } catch {}
  if (typeof window._gfxRefreshTopBar === 'function') window._gfxRefreshTopBar();
});
(function initGfxAutocutToggle() {
  const t = el('gfx-autocut-on'); if (!t) return;
  try { t.checked = localStorage.getItem(GFX_AUTOCUT_ON_KEY) === '1'; } catch {}
  t.addEventListener('change', function () {
    try { localStorage.setItem(GFX_AUTOCUT_ON_KEY, this.checked ? '1' : '0'); } catch {}
    if (typeof window._gfxRefreshTopBar === 'function') window._gfxRefreshTopBar();   // OBS chip warn state
  });
})();

function sendToScreen(bus, transitionOverride) {
  const sel = currentEditorClip();
  if (!sel || !sel.url) {
    const st = el('rp-screen-status'); if (st) { st.textContent = 'Load a clip first.'; st.style.color = '#f56565'; }
    return;
  }
  const loop = !!el('rp-loop')?.checked;
  const programScene = (el('rp-program-scene')?.value || '').trim();
  // Resolved BEFORE the cut: in "OBS transition" mode the transition name travels with the scene
  // switch (see beginReplayProgram) so OBS is holding it when the cut happens.
  const t = transitionOverride || liveTransitionOpts();
  if (bus === 'program') {
    stopOtherProgramSources('program');   // don't let a running playlist fight this single clip
    if (!programScene) showToast('No OBS scene selected — pick a scene next to "To Air" so OBS switches to the replay-player source.', '#fbbf24', 5000);
    beginReplayProgram(undefined, t);
  } else if (bus === 'preview') {
    _previewSentAt = Date.now();
  }
  // If OBS is about to sting the scene cut itself, the player cuts — otherwise the same sting plays
  // twice in a row (OBS's on the scene change, then the player's over the clip).
  const obsIsCutting = (bus === 'program' && t.obsTransition && willObsCutScene(programScene));
  send('replay_play', {
    bus, url: sel.url, name: sel.name, loop,
    trimIn: _previewClip.trimIn || 0,
    trimOut: _previewClip.trimOut ?? null,
    transition: obsIsCutting ? 'cut' : t.transition, transitionLogo: t.transitionLogo,
    stinger: t.stinger || '', stingerPoint: t.stingerPoint || 0,   // sent to buffer, used only on a stinger cut
    stingerDuration: t.stingerDuration || 0,
    // In OBS-transition mode the client already cut (with the transition armed); letting the server
    // fire its own switch too would race that and land the cut on the previous transition.
    scene: (t.obsTransition ? undefined : (programScene || undefined)),
  });
  const st = el('rp-screen-status');
  if (st) { st.textContent = (bus === 'preview' ? 'Preview: ' : 'ON AIR: ') + sel.name + (loop ? ' (loop)' : ''); st.style.color = bus === 'preview' ? 'var(--muted)' : 'var(--good, #48bb78)'; }
  // Safety net: return to the prior scene even if the player's 'ended' report is missed.
  clearTimeout(_replayFallbackTimer);
  if (bus === 'program' && !loop) {
    const d = (_previewClip.trimOut ?? _previewClip.duration ?? 0) - (_previewClip.trimIn || 0);
    if (d > 0) _replayFallbackTimer = setTimeout(() => { if (_replayActive && !_plLiveActive) endReplayProgram(); }, d * 1000 + 1500);
  }
}
el('rp-buffer-toggle')?.addEventListener('click', () => send('obs_toggle_replay_buffer'));
el('rp-capture')?.addEventListener('click', () => rpCaptureReplay('page'));

// ── Capture: one click saves the OBS replay buffer AND imports the clip (clip_capture_manual
// starts the buffer first if it's off). The reply carries the new clip's id; a capture fired
// from the Replays page opens that clip in Trim so the next step is just Show Now / Add.
let _rpCaptureOpenId = null;
let _rpCaptureBusy = false;
function rpCaptureReplay(source) {
  if (_rpCaptureBusy) return;
  const obs = (currentState && currentState.obs) || {};
  if (!obs.connected) { showToast('Connect to OBS first (Settings ▸ OBS).', '#f56565'); return; }
  _rpCaptureBusy = true;
  rpSyncCaptureUi();
  const t = new Date();
  const hhmmss = [t.getHours(), t.getMinutes(), t.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  const p = currentState.director?.primary;
  send('clip_capture_manual', {
    source,
    player: p?.name || '',
    label: 'Replay ' + hhmmss + (p?.name ? ' — ' + p.name : ''),
    reason: 'Producer capture',
  });
  // Never leave the button stuck if the reply is lost.
  setTimeout(() => { if (_rpCaptureBusy) { _rpCaptureBusy = false; rpSyncCaptureUi(); } }, 15000);
}
function rpOnCaptureResult(d) {
  _rpCaptureBusy = false;
  rpSyncCaptureUi();
  const msg = d.message || (d.ok ? 'Replay captured.' : 'Capture failed.');
  showToast(msg, d.ok ? '#22c55e' : '#f56565', d.ok ? 3000 : 7000);
  const st = el('rp-capture-status');
  if (st) { st.textContent = msg; st.style.color = d.ok ? 'var(--good, #48bb78)' : '#f56565'; }
  const qst = el('qr-replay-status');
  if (qst) { qst.textContent = msg; qst.style.color = d.ok ? '' : '#f56565'; setTimeout(() => { if (qst.textContent === msg) qst.textContent = ''; }, 5000); }
  if (!d.ok || !d.clipId) return;
  if (typeof scanStagingArea === 'function') scanStagingArea(true);   // show the new file as imported
  if (d.source === 'page') { _rpCaptureOpenId = d.clipId; rpOpenCapturedClip(); }
}
// clips_update (carrying the new clip) can land before or after clips-result — try on both.
function rpOpenCapturedClip() {
  if (!_rpCaptureOpenId) return;
  const lib = (currentState.clips && currentState.clips.library) || [];
  const clip = lib.find((c) => c.id === _rpCaptureOpenId);
  if (!clip) return;
  _rpCaptureOpenId = null;
  // New captures land on the Replays shelf — flip to it so the clip shows in the pool too.
  const shelfTab = document.querySelector('#rp-folder-tabs .rp-folder-tab[data-folder="replays"]');
  if (shelfTab && _rpFolder !== 'replays') shelfTab.click();
  loadClipPreview(clip);
}
function rpSyncCaptureUi(data) {
  const obs = (data || currentState || {}).obs || {};
  const pill = el('rp-buffer-pill');
  rbPill(pill, obs);
  const tb = el('rp-buffer-toggle');
  if (tb) {
    tb.textContent = obs.replayBufferActive ? 'Stop Buffer' : 'Start Buffer';
    tb.disabled = !obs.connected;
    tb.title = !obs.connected ? 'Connect OBS under Apps > Streaming software first'
      : rbOffInObs(obs) ? RB_OFF_HINT
      : (obs.replayBufferActive ? 'Stop the OBS replay buffer' : 'Start the OBS replay buffer (Capture also starts it automatically)');
  }
  ['rp-capture', 'qr-save-replay'].forEach((id) => {
    const b = el(id); if (!b) return;
    b.disabled = !obs.connected || _rpCaptureBusy;
    b.textContent = _rpCaptureBusy ? 'Capturing…' : (id === 'rp-capture' ? 'Capture Replay' : 'Capture');
  });
}
el('rp-to-program')?.addEventListener('click', () => sendToScreen('program'));
el('rp-to-preview')?.addEventListener('click', () => sendToScreen('preview'));

// ── Qrail REPLAY panel — buffer status/toggle + save + push the latest clips to air
// without leaving the cockpit. Reuses the Video Editor's program-bus machinery
// (beginReplayProgram / endReplayProgram / shared replay-player source) so the two
// surfaces can never fight; scene + transition + return-scene settings come from the
// REPLAYS page controls. "Edit" borrows the REPLAYS page's own Video Editor pane into
// a popup (see qrOpenClipEditor below) rather than building a second editor instance.
// Buffer status/toggle are driven off state.obs, which rides the small/frequent LIVE broadcast
// (every full_state). The clip list below rides the separate, heavier 'clips_update' message
// (clips.library is only re-sent on change — see perf-broadcast-payload). Splitting these apart
// so the pill/button track the real OBS buffer state immediately instead of only refreshing
// whenever a clip happens to be saved/imported.
function renderQrailBufferStatus(data) {
  rpSyncCaptureUi(data);
  const obs = (data || currentState || {}).obs || {};
  const pill = el('qr-buffer-pill');
  rbPill(pill, obs);
  const toggleBtn = el('qr-buffer-toggle');
  if (toggleBtn) {
    toggleBtn.textContent = obs.replayBufferActive ? 'Stop Buffer' : 'Start Buffer';
    toggleBtn.disabled = !obs.connected;
    toggleBtn.style.opacity = obs.connected ? '1' : '0.45';
    toggleBtn.title = !obs.connected ? 'Connect OBS under Apps > Streaming software first'
      : rbOffInObs(obs) ? RB_OFF_HINT
      : (obs.replayBufferActive ? 'Stop the OBS replay buffer' : 'Start the OBS replay buffer — required before Save Replay can capture anything');
  }
  const st = el('qr-replay-status');
  if (st) {
    if (rbOffInObs(obs)) { st.textContent = 'Replay Buffer is turned off in OBS — enable it in OBS: Settings > Output > Replay Buffer.'; st.dataset.rbOff = '1'; }
    else if (st.dataset.rbOff) { st.textContent = ''; delete st.dataset.rbOff; }
  }
}

let _qrClipsSig = '';
// Un-imported files sitting in the OBS replay folder (scan-folder), cached so the renderer
// stays synchronous; refreshed on tab open and clips_update.
let _qrFolderFiles = [];
let _qrScanBusy = false;
async function qrScanFolder() {
  if (_qrScanBusy) return;
  _qrScanBusy = true;
  try {
    const r = await fetch('http://127.0.0.1:3000/api/clips/scan-folder');
    const d = await r.json();
    _qrFolderFiles = (d.files || []).filter((f) => !f.imported);
  } catch (_) { /* folder not configured — library-only view */ }
  _qrScanBusy = false;
  renderQrailReplay(currentState);
}
function renderQrailReplay(data) {
  renderQrailBufferStatus(data);
  const st = (data || currentState || {});
  const list = el('qr-clip-list'); if (!list) return;
  // Merge the imported library (unshift = newest FIRST — slice(-5) used to show the OLDEST
  // five, which is why fresh Twitch imports never appeared) with un-imported files straight
  // from the OBS replay folder, newest first across both sources.
  const lib = (st.clips?.library || []).map((c) => ({ t: c.createdAt || 0, c }));
  const files = _qrFolderFiles.map((f) => ({ t: f.mtimeMs || 0, c: { name: f.name, rawPath: f.path, duration: null, _folderFile: true } }));
  const latest = lib.concat(files).sort((a, b) => b.t - a.t).slice(0, 8).map((x) => x.c);
  const sig = JSON.stringify(latest.map((c) => (c.id || c.rawPath) + ':' + (c.name || '') + ':' + (c.duration || 0)));
  if (sig === _qrClipsSig) return;
  _qrClipsSig = sig;
  list.innerHTML = '';
  if (!latest.length) {
    list.innerHTML = '<div class="field-hint" style="margin:0;">No clips yet — Save Replay while the OBS buffer is running, or set the replay folder on the REPLAYS page.</div>';
    return;
  }
  latest.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'qr-clip-row';
    const dur = c.duration ? (Math.round(c.duration) + 's') : '';
    const rawPath = c.path || c.rawPath || '';
    row.innerHTML = `
      <div class="qr-clip-info">
        <div class="qr-clip-thumb">
          <svg class="qr-clip-thumb-icon" viewBox="0 0 24 24" width="12" height="12" fill="rgba(255,255,255,0.28)"><path d="M8 5v14l11-7z"/></svg>
          ${rawPath ? `<img class="qr-clip-thumb-img" alt="" loading="lazy" src="${thumbUrl(rawPath)}">` : ''}
        </div>
        <span class="qr-clip-name" title="${esc(c.name || 'Clip')}">${esc(c.name || 'Clip')}</span>
        <span class="qr-clip-dur">${dur}</span>
      </div>
      <div class="qr-clip-btns">
        <button class="btn btn-secondary btn-sm qr-edit" title="Quick edit — opens Trim in a popup to trim and push live (raw folder files are imported into the library on save)">Edit</button>
        <button class="btn btn-primary btn-sm qr-toair" title="Play this clip on the program bus now (cuts OBS to the replay scene, returns when it ends)">To Air</button>
      </div>`;
    const thumbImg = row.querySelector('.qr-clip-thumb-img');
    if (thumbImg) {
      thumbImg.addEventListener('load', () => thumbImg.classList.add('loaded'));
      thumbImg.addEventListener('error', () => thumbImg.remove());
    }
    row.querySelector('.qr-edit')?.addEventListener('click', () => qrOpenClipEditor(c));
    row.querySelector('.qr-toair').addEventListener('click', () => qrailClipToAir(c));
    list.appendChild(row);
  });
}
el('qr-buffer-toggle')?.addEventListener('click', () => send('obs_toggle_replay_buffer'));

// Quick-edit popup: borrows the REPLAYS page's own Video Editor pane (#clip-preview-card)
// by physically relocating it into the modal (not cloning) — every id-based lookup inside
// it (loadClipPreview, trim bar, To Air/Preview, Save edit, Add to playlist…) keeps working
// unmodified regardless of which container currently holds it. Only one editor instance
// exists, so it's "checked out" to whichever surface has it open at a time.
let _qrEditHome = null;   // { parent, next } — where the editor pane lives when NOT popped out
function qrOpenClipEditor(clip) {
  const card = el('clip-preview-card');
  const body = el('qr-edit-body');
  const modal = el('qr-edit-modal');
  if (!card || !body || !modal) return;
  if (card.parentElement !== body) {
    _qrEditHome = { parent: card.parentElement, next: card.nextElementSibling };
    body.appendChild(card);
  }
  modal.style.display = '';
  if (typeof loadClipPreview === 'function') loadClipPreview(clip);
}
function qrCloseClipEditor() {
  const modal = el('qr-edit-modal');
  if (modal) modal.style.display = 'none';
  const card = el('clip-preview-card');
  if (card && _qrEditHome) {
    if (_qrEditHome.next) _qrEditHome.parent.insertBefore(card, _qrEditHome.next);
    else _qrEditHome.parent.appendChild(card);
    _qrEditHome = null;
  }
}
el('qr-edit-close')?.addEventListener('click', qrCloseClipEditor);
el('qr-edit-modal')?.addEventListener('click', (e) => { if (e.target.id === 'qr-edit-modal') qrCloseClipEditor(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && el('qr-edit-modal')?.style.display !== 'none') qrCloseClipEditor(); });
function qrailClipToAir(clip) {
  const url = clipUrl(clip);
  if (!url) { showToast('Clip file not found on disk', '#f56565'); return; }
  stopOtherProgramSources('program');   // a running playlist must not fight this clip
  const scene = (el('rp-program-scene')?.value || '').trim();
  if (!scene) showToast('No replay OBS scene set (REPLAYS page, next to "To Air") — OBS will not auto-switch.', '#fbbf24', 5000);
  beginReplayProgram();
  const t = liveTransitionOpts();
  send('replay_play', {
    bus: 'program', url, name: clip.name || 'Clip', loop: false,
    transition: t.transition, transitionLogo: t.transitionLogo,
    scene: scene || undefined,
  });
  showToast('ON AIR: ' + (clip.name || 'Clip'), '#22c55e');
  // Same safety net as the editor: return to the prior scene even if 'ended' is missed.
  clearTimeout(_replayFallbackTimer);
  const d = Number(clip.duration) || 0;
  if (d > 0) _replayFallbackTimer = setTimeout(() => { if (_replayActive && !_plLiveActive) endReplayProgram(); }, d * 1000 + 1500);
}
el('qr-save-replay')?.addEventListener('click', () => rpCaptureReplay('rail'));
el('qr-replay-stop')?.addEventListener('click', () => endReplayProgram());

// ── Qrail REPLAY sub-tabs: Clips | Twitch | Playlists ─────────────────────────
// Twitch: lists the channel's clips (existing /api/twitch/clips) and imports one into the
// local clip library via the Social page's download route — it then shows under Clips with
// its own To Air. Playlists: the montage/playlist library with one-click program playback.
document.querySelectorAll('.qr-tab[data-qrtab]').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.qr-tab[data-qrtab]').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.qr-sub[data-qrsub]').forEach((p) => { p.style.display = p.dataset.qrsub === b.dataset.qrtab ? '' : 'none'; });
    if (b.dataset.qrtab === 'twitch' && !el('qr-tw-list')?.children.length) qrTwLoad();
    if (b.dataset.qrtab === 'playlists') renderQrailPlaylists(currentState);
  });
});
el('qr-tw-load')?.addEventListener('click', () => qrTwLoad());
async function qrTwLoad() {
  const list = el('qr-tw-list'); if (!list) return;
  list.innerHTML = '<div class="field-hint" style="margin:0;">Loading Twitch clips…</div>';
  try {
    const r = await fetch('http://127.0.0.1:3000/api/twitch/clips?first=15');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Twitch not connected');
    const clips = data.clips || [];
    list.innerHTML = '';
    if (!clips.length) { list.innerHTML = '<div class="field-hint" style="margin:0;">No clips on the channel yet.</div>'; return; }
    clips.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'qr-clip-row';
      const dur = c.duration ? Math.round(c.duration) + 's' : '';
      row.innerHTML = `<div class="qr-clip-info">`
        + `<div class="qr-clip-thumb">${c.thumbnail_url ? `<img class="qr-clip-thumb-img loaded" alt="" loading="lazy" src="${esc(c.thumbnail_url)}">` : ''}</div>`
        + `<span class="qr-clip-name" title="${esc(c.title || 'Clip')}">${esc(c.title || 'Clip')}</span>`
        + `<span class="qr-clip-dur">${dur}</span></div>`
        + `<button class="btn btn-secondary btn-sm qr-tw-import" title="Download this Twitch clip into the local clip library">Import</button>`;
      const btn = row.querySelector('.qr-tw-import');
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = 'Downloading…';
        try {
          const dr = await fetch('http://127.0.0.1:3000/api/social/clip/download', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clipUrl: c.url, thumbnailUrl: c.thumbnail_url, title: c.title })
          });
          const dd = await dr.json();
          if (!dr.ok) throw new Error(dd.error || 'Download failed');
          btn.textContent = 'Imported';
          showToast('Twitch clip imported — it is in Clips now', '#22c55e');
          if (typeof qrScanFolder === 'function') qrScanFolder();   // refresh the merged Clips list
        } catch (e) {
          btn.disabled = false; btn.textContent = 'Import';
          showToast('Import failed: ' + e.message, '#f56565');
        }
      });
      list.appendChild(row);
    });
  } catch (e) {
    list.innerHTML = '<div class="field-hint" style="margin:0;">' + esc(e.message) + '. Connect Twitch under Apps > Twitch.</div>';
  }
}
let _qrPlSig = '';
function renderQrailPlaylists(data) {
  const list = el('qr-pl-list'); if (!list) return;
  if (typeof _editingInside === 'function' && _editingInside(list)) return;   // don't clobber an open scene select
  const st = (data || currentState || {});
  const montages = (st.clips || {}).montages || [];
  const scenes = (st.obs && st.obs.availableScenes) || [];
  const lib = (st.clips || {}).library || [];
  const sig = JSON.stringify(montages.map((m) => m.id + ':' + (m.name || '') + ':' + (m.outputPath ? 1 : 0) + ':' + ((m.clipIds || m.items || []).length) + ':' + (m.programScene || '')) + '|' + scenes.join(','));
  if (sig === _qrPlSig) return;
  _qrPlSig = sig;
  list.innerHTML = '';
  if (!montages.length) { list.innerHTML = '<div class="field-hint" style="margin:0;">No playlists yet — build one on the REPLAYS page.</div>'; return; }
  const sceneOpts = '<option value="">Scene: global Program scene</option>'
    + scenes.map((s) => `<option value="${esc(s)}">Scene: ${esc(s)}</option>`).join('');
  montages.forEach((m) => {
    const n = (m.clipIds || m.items || []).length;
    const ready = !!m.outputPath;
    // Thumbnail: first clip in the playlist, else the encoded output file's first frame.
    const firstClip = (m.clipIds || []).map((cid) => lib.find((c) => c.id === cid)).find(Boolean);
    const thumbPath = (firstClip && firstClip.path) || m.outputPath || '';
    const row = document.createElement('div');
    row.className = 'qr-clip-row qr-pl-row';
    row.innerHTML = `<div class="qr-clip-info">`
      + `<div class="qr-clip-thumb">${thumbPath ? `<img class="qr-clip-thumb-img" alt="" loading="lazy" src="${thumbUrl(thumbPath)}">` : ''}</div>`
      + `<span class="qr-clip-name" title="${esc(m.name || 'Playlist')}">${esc(m.name || 'Playlist')}</span>`
      + `<span class="qr-clip-dur">${n} clip${n === 1 ? '' : 's'}</span>`
      + `<span class="qr-pl-badge${ready ? ' is-ready' : ''}">${ready ? 'Ready' : 'Draft'}</span></div>`
      + `<div class="qr-clip-btns"><button class="btn btn-primary btn-sm qr-pl-air" title="Play this playlist on the program bus — cuts OBS to the scene below (or the global Program scene)">To Air</button></div>`
      + `<select class="input-select qr-pl-scene" title="OBS scene this playlist cuts to when it goes to air — saved on the playlist">${sceneOpts}</select>`;
    const thumbImg = row.querySelector('.qr-clip-thumb-img');
    if (thumbImg) {
      thumbImg.addEventListener('load', () => thumbImg.classList.add('loaded'));
      thumbImg.addEventListener('error', () => thumbImg.remove());
    }
    const sceneSel = row.querySelector('.qr-pl-scene');
    sceneSel.value = m.programScene || '';
    sceneSel.addEventListener('change', () => {
      m.programScene = sceneSel.value;   // optimistic — playMontageById reads currentState immediately
      send('montage_settings', { montageId: m.id, programScene: sceneSel.value });
    });
    row.querySelector('.qr-pl-air').addEventListener('click', () => {
      if (typeof playMontageById === 'function') { playMontageById(m.id); showToast('Playlist to air: ' + (m.name || 'Playlist'), '#22c55e'); }
    });
    list.appendChild(row);
  });
}
// Clear the program output. The visible "Clear" button was removed from the Video
// Editor, but the action stays available via the hotkey/Stream-Deck command.
function rpClearProgram() {
  _plLiveActive = false;
  send('replay_stop', { bus: _plBus || 'program' });   // one shared source → stop whatever's on air
  endReplayProgram(true);   // manual clear — just reset, don't auto-switch scenes
  const st = el('rp-screen-status'); if (st) { st.textContent = 'Program cleared.'; st.style.color = 'var(--muted)'; }
}
el('rp-screen-clear')?.addEventListener('click', rpClearProgram);
el('rp-screen-open')?.addEventListener('click', () => window.open('http://localhost:3000/replay-player.html', '_blank', 'noopener'));
function takeToProgram() {
  // Nothing cued? Tell the producer instead of taking black to air. currentState.replay.preview is
  // a replica that only updates once the server's replay_play echo arrives — a Take clicked right
  // after "To Preview" can beat that echo, so also trust a just-sent preview for a short grace
  // window (the server's own state.replay.preview, which replay_take actually reads, is already
  // set synchronously by the time the send above completes).
  const recentPreviewSend = Date.now() - _previewSentAt < 4000;
  if (!recentPreviewSend && !(currentState.replay && currentState.replay.preview && currentState.replay.preview.playing && currentState.replay.preview.url)) {
    const st = el('rp-screen-status'); if (st) { st.textContent = 'Nothing in Preview to take.'; st.style.color = '#f56565'; }
    return;
  }
  beginReplayProgram();
  const t = liveTransitionOpts();
  send('replay_take', { transition: t.transition, transitionLogo: t.transitionLogo });
  const st = el('rp-screen-status'); if (st) { st.textContent = 'Preview taken to Program.'; st.title = st.textContent; st.style.color = 'var(--good, #48bb78)'; }
}
el('rp-take')?.addEventListener('click', takeToProgram);
el('rp-mv-take')?.addEventListener('click', takeToProgram);
// Fallback countdown source: if the OBS overlay isn't open/reporting, drive the timer from
// the in-panel PROGRAM monitor instead so producers always see time remaining.
el('rp-mon-pgm')?.addEventListener('timeupdate', function () {
  if (!this.dataset.src || Date.now() - _lastProgressRx < 1500) return;
  const dur = this.duration || 0;
  showReplayCountdown(Math.max(0, dur - (this.currentTime || 0)));
});
// Video Editor settings moved to Settings ▸ Replays — the gear now deep-links there (modal removed).
el('rp-settings-toggle')?.addEventListener('click', () => { if (typeof openSettings === 'function') openSettings('replays'); });

// ── REPLAYS: playlist actions ──────────────────────────────────────────────
el('rp-save-playlist')?.addEventListener('click', async () => {
  if (!_previewClip) { const st = el('clips-status'); if (st) { st.textContent = 'Load a clip first.'; st.style.color = '#f56565'; } return; }
  // If this is a raw staging file (no library ID), import it first
  if (!_previewClip.id && _previewClip.rawPath) {
    const stagingFile = _stagingFiles.find(f => f.path === _previewClip.rawPath);
    if (stagingFile) {
      const st = el('clips-status');
      try {
        const clip = stagingFile.imported && stagingFile.importedId
          ? (currentState.clips?.library || []).find((cl) => cl.id === stagingFile.importedId)
          : await importStagingFile(stagingFile);
        if (clip) addClipToPlaylist(clip, currentState.clips);
      } catch (err) {
        if (st) { st.textContent = 'Import failed: ' + err.message; st.style.color = '#f56565'; }
      }
      return;
    }
  }
  const clip = (currentState.clips?.library || []).find((x) => x.id === _previewClip.id) || _previewClip;
  addClipToPlaylist(clip, currentState.clips);
});
el('rp-new-playlist')?.addEventListener('click', async () => {
  const n = ((currentState.clips && currentState.clips.montages) || []).length + 1;
  const name = await customPrompt('New playlist', 'Name this playlist', 'Playlist ' + n, 'Create');
  if (!name) return;
  _pendingNewMontage = true;   // auto-select the new playlist when it comes back
  send('montage_create', { name, clipIds: [], template: el('select-montage-template')?.value || 'highlights', folder: _rpFolder });
});
// Build a playlist from a whole FOLDER of clips — the server opens a folder picker, imports every
// video (name order), and drops them into a new playlist. Auto-selects it when it comes back.
el('rp-folder-playlist')?.addEventListener('click', () => {
  _pendingNewMontage = true;
  send('montage_from_folder', { template: el('select-montage-template')?.value || 'highlights', folder: _rpFolder });
  if (typeof showToast === 'function') showToast('Pick a folder of clips…', '#7c3aed');
});
el('rp-rename-playlist')?.addEventListener('click', () => {
  const mId = el('select-montage-edit')?.value; if (!mId) return;
  const name = el('rp-playlist-name')?.value?.trim(); if (!name) return;
  send('montage_rename', { montageId: mId, name });
});
el('rp-process')?.addEventListener('click', () => {
  const mId = el('select-montage-edit')?.value;
  if (!mId) {
    const rpWrap = el('rp-encode-progress'); const rpLabel = el('rp-encode-label');
    if (rpWrap && rpLabel) { rpWrap.style.display = 'flex'; rpLabel.textContent = 'Select a playlist first.'; rpLabel.style.color = '#f56565'; setTimeout(() => { rpWrap.style.display = 'none'; rpLabel.style.color = ''; }, 3000); }
    return;
  }
  // Show progress bar immediately (server will push updates)
  const rpWrap = el('rp-encode-progress'); const rpLabel = el('rp-encode-label');
  const rpFill = el('rp-encode-fill'); const rpPct = el('rp-encode-pct');
  if (rpWrap) { rpWrap.style.display = 'flex'; if (rpLabel) { rpLabel.textContent = 'Queued…'; rpLabel.style.color = ''; } if (rpFill) rpFill.style.width = '0%'; if (rpPct) rpPct.textContent = '0%'; }
  el('rp-process').disabled = true;
  const transition = el('rp-transition')?.value || 'cut';
  send('montage_encode', {
    montageId: mId,
    opts: {
      quality: el('rp-quality')?.value || 'medium',
      gpu: !!el('rp-gpu')?.checked,
      format: el('rp-format')?.value || '.mp4',
      transition,
      // Logo transition uses a picked image, falling back to the active brand logo.
      transitionLogo: transition === 'logo' ? (_transitionLogo || (currentState.brand && currentState.brand.logo) || null) : undefined
    }
  });
});
// Logo-transition picker — ONE shared image (_transitionLogo) with two entry points: the Playlists
// section's own row (#rp-translogo-*, persists onto the selected playlist) and the pool's always-
// visible row (#rp-pool-translogo-*, drives single/bulk pool pushes). Picking a logo from either
// updates the same variable, so both previews stay in sync with whichever was chosen last.
let _transitionLogo = null;
function refreshTransitionLogoPreviews() {
  const src = _transitionLogo || (currentState.brand && currentState.brand.logo) || '';
  const prev = el('rp-translogo-preview'); if (prev) prev.src = src;
  const poolPrev = el('rp-pool-translogo-preview'); if (poolPrev) poolPrev.src = src;
}
function updateTransLogoRow() {
  const sel = el('rp-transition'); const type = (sel && sel.value) || 'cut';
  const row = el('rp-translogo-row');
  if (row) row.style.display = type === 'logo' ? 'flex' : 'none';
  const stRow = el('rp-stinger-row');
  if (stRow) stRow.style.display = type === 'stinger' ? 'flex' : 'none';
  refreshTransitionLogoPreviews();
}
el('rp-transition')?.addEventListener('change', function () {
  updateTransLogoRow();
  // Persist the transition on the selected playlist (drives live playout + encode).
  const mId = el('select-montage-edit')?.value;
  if (mId) send('montage_settings', { montageId: mId, transition: { type: this.value } });
});
// Global stinger for manual pushes (pool To Air / Play all / the editor's To Air). A playlist can
// still carry its OWN stinger (montage.transition.stinger) which wins for that reel; this is the
// fallback everything else uses. The video is imported into the managed clip library so the overlay
// can stream it from the same file server as the clips.
const RP_STINGER_KEY = 'ne_rp_stinger_v1';
let _rpStinger = (() => {
  try { const s = JSON.parse(localStorage.getItem(RP_STINGER_KEY) || '{}'); return { url: s.url || '', name: s.name || '', point: Number(s.point) || 0 }; }
  catch (_) { return { url: '', name: '', point: 0 }; }
})();
function rpSaveStinger() { try { localStorage.setItem(RP_STINGER_KEY, JSON.stringify(_rpStinger)); } catch (_) {} }
function rpRenderStingerRow() {
  const nameEl = el('rp-pool-stinger-name');
  if (nameEl) nameEl.textContent = _rpStinger.url ? (_rpStinger.name || 'Stinger set') + ' ✓' : 'No stinger uploaded';
  const pt = el('rp-pool-stinger-point');
  if (pt && document.activeElement !== pt) pt.value = String(_rpStinger.point || 0);
}
// What OBS told us about the selected transition: its kind, and — for a stinger — the video file
// and transition point, so the player can run the same sting between clips (OBS itself only
// transitions on a scene change). Filled by the obs-transition-info reply.
let _rpObsTrans = { name: '', kind: '', hasVideo: false, point: 0, url: '', message: '' };
function rpAskObsTransInfo() {
  const name = el('rp-pool-obstrans')?.value || '';
  if (!name) { _rpObsTrans = { name: '', kind: '', hasVideo: false, point: 0, url: '', message: '' }; rpRenderObsTransHint(); return; }
  rpSeedObsTransFromState(name);   // usable immediately; the OBS query below refreshes it
  if (!(currentState && currentState.obs && currentState.obs.connected)) { rpRenderObsTransHint(); return; }
  send('obs_transition_info', { name });
}
// The server remembers the last inspected OBS stinger (path/point/length) across restarts, so the
// transition is armed the moment the page loads instead of only after OBS has been re-queried —
// otherwise the sting URL 404s on the first advance after a restart and the transition plays black.
function rpSeedObsTransFromState(name) {
  const s = (currentState && currentState.obsStinger) || null;
  if (!s || !s.path || s.name !== name) return false;
  if (_rpObsTrans.name === name && _rpObsTrans.hasVideo) return true;
  _rpObsTrans = {
    name, kind: 'obs_stinger_transition', hasVideo: true,
    point: Number(s.point) || 0, lengthMs: Number(s.lengthMs) || 0, duration: 0,
    url: 'http://127.0.0.1:3000/api/obs/transition-stinger?v=' + encodeURIComponent(String(s.lengthMs || 1)),
    message: ''
  };
  return true;
}
function rpRenderObsTransHint() {
  const h = el('rp-pool-obstrans-hint'); if (!h) return;
  const name = el('rp-pool-obstrans')?.value || '';
  if (!name) { h.textContent = 'Connect OBS to list its transitions.'; h.style.color = 'var(--muted)'; return; }
  if (_rpObsTrans.name !== name) { h.textContent = 'Reading "' + name + '" from OBS…'; h.style.color = 'var(--muted)'; return; }
  if (_rpObsTrans.hasVideo) {
    const len = _rpObsTrans.lengthMs || _rpObsTrans.duration;
    h.textContent = 'Stinger found — used for the OBS scene cut AND between clips. '
      + 'Swap at ' + (_rpObsTrans.point ? _rpObsTrans.point + 'ms' : 'midpoint')
      + (len ? ' of ' + len + 'ms' : '') + ', read from OBS.';
    h.style.color = 'var(--ok-2)';
    return;
  }
  if (_rpObsTrans.message) { h.textContent = _rpObsTrans.message; h.style.color = '#fbbf24'; return; }
  h.textContent = `"${name}" is a ${(_rpObsTrans.kind || 'scene').replace(/^obs_|_transition$/g, '') || 'scene'} transition — OBS runs it on the scene cut; clip-to-clip uses a crossfade.`;
  h.style.color = 'var(--muted)';
}
// OBS's own transition list (from the connected scene collection) for "OBS transition" mode.
function rpSyncObsTransitions() {
  const sel = el('rp-pool-obstrans'); if (!sel) return;
  const list = (currentState && currentState.obs && currentState.obs.availableTransitions) || [];
  const sig = JSON.stringify(list);
  if (sel.dataset.sig === sig) return;
  sel.dataset.sig = sig;
  const saved = (() => { try { return localStorage.getItem('ne_rp_obstrans') || ''; } catch { return ''; } })();
  sel.innerHTML = list.length
    ? list.map((t) => `<option value="${String(t).replace(/"/g, '&quot;')}">${String(t).replace(/</g, '&lt;')}</option>`).join('')
    : '<option value="">No OBS transitions — connect OBS</option>';
  if (saved && list.includes(saved)) sel.value = saved;
}
function updatePoolTransLogoRow() {
  const type = el('rp-pool-transition')?.value || 'fade';
  const row = el('rp-pool-translogo-row');
  if (row) row.style.display = type === 'logo' ? 'flex' : 'none';
  const stRow = el('rp-pool-stinger-row');
  if (stRow) stRow.style.display = type === 'stinger' ? 'flex' : 'none';
  const obsRow = el('rp-pool-obstrans-row');
  if (obsRow) obsRow.style.display = type === 'obs' ? 'flex' : 'none';
  if (type === 'stinger') rpRenderStingerRow();
  if (type === 'obs') { rpSyncObsTransitions(); rpAskObsTransInfo(); }
  refreshTransitionLogoPreviews();
}
el('rp-pool-transition')?.addEventListener('change', function () {
  try { localStorage.setItem('ne_rp_pool_transition', this.value || ''); } catch (_) {}
  updatePoolTransLogoRow();
});
el('rp-pool-stinger-point')?.addEventListener('change', function () {
  _rpStinger.point = Math.max(0, Number(this.value) || 0);
  rpSaveStinger();
});
el('rp-pool-obstrans')?.addEventListener('change', function () {
  try { localStorage.setItem('ne_rp_obstrans', this.value || ''); } catch (_) {}
  rpAskObsTransInfo();   // read its kind + stinger file so clip-to-clip can use the same sting
});
el('rp-pool-stinger-clear')?.addEventListener('click', () => {
  _rpStinger = { url: '', name: '', point: _rpStinger.point || 0 };
  rpSaveStinger(); rpRenderStingerRow();
});
el('rp-pool-stinger-file')?.addEventListener('change', async function () {
  const f = this.files && this.files[0]; if (!f) return;
  const nameEl = el('rp-pool-stinger-name'); if (nameEl) nameEl.textContent = 'Uploading stinger…';
  try {
    // Same managed-import route the per-playlist stinger uses — Electron gives us a real file path.
    const r = await fetch('http://127.0.0.1:3000/api/clips/import-file', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: f.path, label: (f.name || 'Stinger').replace(/\.[^.]+$/, '') })
    });
    const d = await r.json();
    if (d.ok && d.clip) {
      _rpStinger = { url: clipUrl(d.clip), name: f.name || 'Stinger', point: _rpStinger.point || 0 };
      rpSaveStinger();
      showToast('Stinger uploaded.', '#22c55e', 2400);
    } else {
      showToast('Could not import that stinger video.', '#f56565', 4000);
    }
  } catch (e) { showToast('Could not import that stinger video.', '#f56565', 4000); }
  rpRenderStingerRow();
  this.value = '';
});
// Restore the producer's last transition choice — a stinger you uploaded should still be armed
// after a reload, not silently reset to Fade.
(function initPoolTransition() {
  const sel = el('rp-pool-transition'); if (!sel) return;
  try { const saved = localStorage.getItem('ne_rp_pool_transition'); if (saved) sel.value = saved; } catch (_) {}
  rpRenderStingerRow();
})();
el('rp-pool-translogo-file')?.addEventListener('change', async function () {
  const f = this.files && this.files[0]; if (!f || !f.type.startsWith('image/')) return;
  try { _transitionLogo = await fileToBase64(f); } catch (_) {}
  refreshTransitionLogoPreviews();
});
updatePoolTransLogoRow();   // initial state on load (select defaults to 'fade' — row starts hidden)
el('rp-translogo-file')?.addEventListener('change', async function () {
  const f = this.files && this.files[0]; if (!f || !f.type.startsWith('image/')) return;
  try { _transitionLogo = await fileToBase64(f); } catch (_) {}
  updateTransLogoRow();
});
el('rp-clear-playlist')?.addEventListener('click', () => {
  const mId = el('select-montage-edit')?.value;
  if (mId) send('montage_reorder', { montageId: mId, clipIds: [] });
});
// "Encode options" (format/quality/GPU) — collapsed by default, set-once-per-playlist technicals
// that don't need to compete with the transition control or the clip timeline for space.
el('rp-pl-encode-opts-toggle')?.addEventListener('click', () => {
  const body = el('rp-pl-encode-opts-body'); const chev = el('rp-pl-encode-opts-chev');
  if (!body) return;
  const open = body.style.display === 'none';
  body.style.display = open ? 'flex' : 'none';
  if (chev) chev.innerHTML = open ? '&#9662;' : '&#9656;';
});

function applyEncodeProgress(enc) {
  const active = enc && enc.active;
  const isEncoding = active && (active.status === 'encoding' || active.status === 'queued');
  const isDone     = active && active.status === 'done';
  const isError    = active && active.status === 'error';
  const pct  = isEncoding ? (active.progress || 0) : isDone ? 100 : 0;
  const name = isDone ? '✓ Done' : (active?.name || 'Encoding…');

  // Surface encode failures immediately — an 'error' status fell through every isEncoding/isDone
  // branch below, so the progress bar just silently vanished (Process button re-enabling) with no
  // indication anything went wrong, and the real ffmpeg error message was discarded entirely,
  // never reaching the UI at all — only visible later via the playlist row's own badge, and only
  // if the producer happened to still be looking at that specific row. De-duped per job so
  // repeated state broadcasts for the same still-failed job don't spam the toast.
  if (isError) {
    const errKey = (active.montageId || '') + '|' + (active.error || '');
    if (_lastNotifiedEncodeError !== errKey) {
      _lastNotifiedEncodeError = errKey;
      showToast(`Encode failed${active.name ? ' — "' + active.name + '"' : ''}: ${active.error || 'unknown error'}`, '#f56565', 8000);
    }
  } else if (active) {
    _lastNotifiedEncodeError = null;
  }

  // Global header bar
  const wrap  = el('qt-encode-wrap');
  const label = el('qt-encode-label');
  const fill  = el('qt-encode-fill');
  const pctEl = el('qt-encode-pct');
  if (wrap) {
    if (isEncoding || isDone) {
      wrap.style.display = 'flex';
      if (label) label.textContent = name;
      if (fill) fill.style.width = pct + '%';
      if (pctEl) pctEl.textContent = pct + '%';
      if (isDone) setTimeout(() => { if (wrap) wrap.style.display = 'none'; }, 4000);
    } else { wrap.style.display = 'none'; }
  }

  // Inline progress bar in the playlist pane
  const rpWrap  = el('rp-encode-progress');
  const rpLabel = el('rp-encode-label');
  const rpFill  = el('rp-encode-fill');
  const rpPct   = el('rp-encode-pct');
  const rpEnc   = el('rp-process');
  if (rpWrap) {
    if (isEncoding || isDone) {
      rpWrap.style.display = 'flex';
      if (rpLabel) rpLabel.textContent = name;
      if (rpFill)  rpFill.style.width  = pct + '%';
      if (rpPct)   rpPct.textContent   = pct + '%';
      if (rpEnc)   rpEnc.disabled = isEncoding;
      if (isDone)  setTimeout(() => { if (rpWrap) rpWrap.style.display = 'none'; if (rpEnc) rpEnc.disabled = false; }, 4000);
    } else {
      rpWrap.style.display = 'none';
      if (rpEnc) rpEnc.disabled = false;
    }
  }

  // Auto-play the encoded file if "Play Live" triggered the encode. Must be THIS specific
  // montage's completion, not just any completion — the encoder processes one job at a time, so
  // clicking Play Live on playlist A while playlist B (queued earlier, e.g. via a manual Process)
  // is still encoding meant B's completion satisfied this check first: it consumed/cleared the
  // flag with a misleading "click Play Live again" toast, and A's own later completion then found
  // nothing pending and never auto-aired at all.
  if (isDone && _plPendingEncodeAndPlay && active.montageId === _plPendingEncodeAndPlay) {
    const pendingId = _plPendingEncodeAndPlay;
    _plPendingEncodeAndPlay = null;
    setTimeout(() => {
      const m = (currentState.clips?.montages || []).find((x) => x.id === pendingId);
      const url = montageUrl(m);
      if (!url) { showToast('Encode done. Click Play Live to send to air.', '#48bb78'); return; }
      // Same unified model as pushPlaylistLive: play on the shared program source, not a pl_<id> bus.
      stopOtherProgramSources('program');
      _plBus = 'program';
      _plEncodedMode = true;
      _plLiveMontageId = pendingId;
      _plKind = m.kind || 'ad';
      _plScene = (m.programScene || '').trim();
      _plLoop = !!el('rp-pl-loop')?.checked;
      _plReturnEnabled = el('rp-pl-return') ? !!el('rp-pl-return').checked : true;
      _plReturnScene = '';
      const effScene = _plScene || (el('rp-program-scene')?.value || '').trim();
      beginReplayProgram(_plScene || undefined);
      _plLiveActive = true;
      if (typeof updatePlaylistLiveBtns === 'function') updatePlaylistLiveBtns();
      send('replay_play', { bus: _plBus, url, name: m.name || 'Playlist', loop: _plLoop, scene: effScene || undefined });
      showToast('Playlist live', '#48bb78');
    }, 800);
  }
}

let _twStreamSig = '';   // connection signature so we only re-fetch stream/chat state on (re)connect
function applyTwitchState(twitch) {
  if (!twitch) return;

  // Update connection status and UI
  const statusEl = el('twitch-status');
  const loginPanel = el('twitch-login-panel');
  const tokenDisplay = el('twitch-token-display');
  const userDisplay = el('twitch-user-display');

  // Update integration store card regardless of view
  const cardBadge     = el('twitch-status-badge');
  const cardBtn       = el('twitch-card-btn');
  const cardName      = el('twitch-card-name');
  const cardIcon      = el('twitch-card-icon');
  const cardAvatar    = el('twitch-card-avatar');
  const cardLogoBadge = el('twitch-card-logo-badge');
  if (twitch.connected && twitch.displayName) {
    if (cardBadge)  { cardBadge.textContent = 'Connected'; cardBadge.style.color = '#4ade80'; cardBadge.style.background = 'rgba(74,222,128,0.1)'; }
    if (cardBtn)    { cardBtn.textContent = 'Settings'; cardBtn.className = 'btn btn-sm btn-secondary'; }
    if (cardName)   cardName.textContent = twitch.displayName;
    if (twitch.profilePicture) {
      if (cardIcon)      cardIcon.style.display = 'none';
      if (cardAvatar)    { cardAvatar.src = twitch.profilePicture; cardAvatar.style.display = 'block'; }
      if (cardLogoBadge) cardLogoBadge.style.display = 'block';
    }
  } else {
    if (cardBadge)     { cardBadge.textContent = 'Not Connected'; cardBadge.style.color = '#9146ff'; cardBadge.style.background = 'rgba(145,70,255,0.2)'; }
    if (cardBtn)       { cardBtn.textContent = 'Connect'; cardBtn.className = 'btn btn-sm btn-primary'; }
    if (cardName)      cardName.textContent = 'Twitch';
    if (cardIcon)      cardIcon.style.display = '';
    if (cardAvatar)    cardAvatar.style.display = 'none';
    if (cardLogoBadge) cardLogoBadge.style.display = 'none';
  }

  if (twitch.connected && twitch.displayName) {
    // Logged in
    if (statusEl) statusEl.innerHTML = '<svg viewBox="0 0 24 24" width="9" height="9" style="vertical-align:middle"><circle cx="12" cy="12" r="12" fill="#4ade80"/></svg> Connected';
    if (loginPanel) loginPanel.style.display = 'none';
    if (tokenDisplay) tokenDisplay.style.display = 'block';
    if (userDisplay) userDisplay.textContent = twitch.displayName;

    // Display profile picture if available
    const avatarImg = el('twitch-user-avatar');
    const avatarFallback = el('twitch-user-avatar-fallback');
    if (twitch.profilePicture && avatarImg) {
      avatarImg.src = twitch.profilePicture;
      avatarImg.style.display = 'block';
      if (avatarFallback) avatarFallback.style.display = 'none';
    }

    // Display channel ID
    const channelIdEl = el('twitch-channel-id');
    if (channelIdEl && twitch.channelId) {
      channelIdEl.textContent = `Channel ID: ${twitch.channelId}`;
    }

    // Show connected sections
    ['twitch-eventsub-section', 'twitch-chat-section', 'twitch-stream-section'].forEach(id => {
      const s = el(id); if (s) s.style.display = 'block';
    });

    // Twitch embed — init once per connection
    initTwitchEmbed((twitch.displayName || '').toLowerCase());

    // Sidebar chat status — sync from state so it's correct even if we missed the one-shot event
    const sidebarChatStatus  = el('chat-connection-status');
    const sidebarChatLoading = el('chat-loading');
    if (twitch.chatConnected) {
      if (sidebarChatStatus)  { sidebarChatStatus.style.display = 'inline'; sidebarChatStatus.innerHTML = '<span class="live-dot" style="background:#4ade80"></span> #' + (twitch.chatChannel || 'connected'); }
      if (sidebarChatLoading) sidebarChatLoading.style.display = 'none';
    } else {
      if (sidebarChatStatus)  sidebarChatStatus.style.display = 'none';
      if (sidebarChatLoading) { sidebarChatLoading.style.display = 'inline'; sidebarChatLoading.textContent = 'Connecting to chat…'; sidebarChatLoading.style.color = '#888'; }
    }

    // Stream state — fetch and populate. These three are NETWORK calls (HTTP GETs to the
    // local server); firing them on EVERY full_state broadcast hammered the server during
    // live shows (full_state fires constantly). Run the one-shot fetches only when the
    // connection is newly established/changed — the polling interval below keeps stream
    // state fresh thereafter, and the sidebar chat status is already synced from state above.
    const _twSig = (twitch.displayName || '') + '|' + (twitch.channelId || '');
    if (_twStreamSig !== _twSig) {
      _twStreamSig = _twSig;
      fetchAndRenderStreamState();
      loadChatAutomations();
      updateChatStatus();
    }
    startStreamStatePolling();   // idempotent — guards its own interval
  } else {
    _twStreamSig = '';   // reset so a reconnect re-fires the one-shot fetches
    // Not connected
    if (statusEl) statusEl.innerHTML = '<svg viewBox="0 0 24 24" width="9" height="9" style="vertical-align:middle"><circle cx="12" cy="12" r="12" fill="#f56565"/></svg> Not Connected';
    if (loginPanel) loginPanel.style.display = 'block';
    if (tokenDisplay) tokenDisplay.style.display = 'none';

    ['twitch-eventsub-section', 'twitch-chat-section', 'twitch-stream-section'].forEach(id => {
      const s = el(id); if (s) s.style.display = 'none';
    });
    stopStreamStatePolling();
  }

  // Update prediction display
  const predDisplay = el('active-prediction-display');
  const predStatus = el('prediction-status');

  if (twitch.predictions?.current) {
    const pred = twitch.predictions.current;

    if (predDisplay) predDisplay.style.display = 'block';

    const titleEl = el('pred-title-display');
    if (titleEl) titleEl.textContent = pred.title;

    const outcomesEl = el('pred-outcomes-display');
    if (outcomesEl && pred.outcomes) {
      const totalVotes = pred.outcomes.reduce((sum, o) => sum + (o.votes || 0), 0);
      outcomesEl.innerHTML = pred.outcomes.map(outcome => {
        const pct = totalVotes > 0 ? Math.round((outcome.votes || 0) / totalVotes * 100) : 0;
        return `<div style="background:rgba(255,255,255,0.04);border-radius:6px;padding:10px 12px;position:relative;overflow:hidden;">
          <div style="position:absolute;top:0;left:0;height:100%;width:${pct}%;background:rgba(145,70,255,0.18);transition:width 0.4s;"></div>
          <div style="position:relative;display:flex;align-items:center;gap:8px;">
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(outcome.title)}</div>
              <div style="font-size:11px;color:var(--muted);">${outcome.votes || 0} votes · ${pct}%</div>
            </div>
            <button class="btn btn-xs btn-success pred-declare-winner-btn" style="font-size:11px;flex-shrink:0;padding:4px 10px;"
              data-outcome-id="${outcome.id}" data-outcome-title="${escapeHtml(outcome.title)}">Declare Winner</button>
          </div>
        </div>`;
      }).join('');
    }

    // Countdown timer
    _startPredCountdown(pred.endsAt);

    if (predStatus) {
      predStatus.textContent = `Active: ${pred.title}`;
      predStatus.style.color = '#9146ff';
    }
  } else {
    if (predDisplay) predDisplay.style.display = 'none';
    _stopPredCountdown();
    if (predStatus) {
      predStatus.textContent = 'No active prediction';
      predStatus.style.color = 'var(--muted)';
    }
  }

  // Update wheel display
  if (twitch.wheel) {
    const wheelStatus = el('wheel-status');
    if (wheelStatus) {
      const participants = twitch.wheel.participants?.length || 0;
      const spins = twitch.wheel.history?.length || 0;
      wheelStatus.textContent = `${participants} participants • ${spins} spins`;
      wheelStatus.style.color = participants > 0 ? '#4ECDC4' : 'var(--muted)';
    }
  }

  // Update minigame display and settings
  if (twitch.minigame) {
    const gameStatus = el('minigame-status');
    const autoStartCheck = el('minigame-auto-start');
    const autoTypeSelect = el('minigame-auto-type');

    const activeControls = el('minigame-active-controls');
    const scoreEntry = el('minigame-score-entry');
    if (gameStatus) {
      const isActive = twitch.minigame.current && twitch.minigame.current.state === 'active';
      const isFinished = twitch.minigame.current && twitch.minigame.current.state === 'finished';
      if (isActive) {
        const game = twitch.minigame.current;
        const count = (game.responses && Object.keys(game.responses).length) ||
          (game.entries && game.entries.length) ||
          (game.guesses && Object.keys(game.guesses).length) ||
          (game.options && game.options.reduce((s, o) => s + (o.votes || 0), 0)) ||
          (game.attempts || 0) || 0;
        const typeLabel = { trivia: 'Trivia', prediction: 'Prediction', vote: 'Vote', spin: 'Raffle',
          number_guess: 'Guess #', fastest_finger: 'Fastest', score_prediction: 'Score Predict' }[game.type] || game.type;
        gameStatus.innerHTML = `<strong>${typeLabel}</strong> active · ${count} participating`;
        gameStatus.style.color = '#FFE66D';
        if (activeControls) activeControls.style.display = 'flex';
        if (scoreEntry) scoreEntry.style.display = game.type === 'score_prediction' ? 'flex' : 'none';
      } else if (isFinished) {
        const game = twitch.minigame.current;
        gameStatus.textContent = `${game.type} finished — results showing`;
        gameStatus.style.color = '#4ECDC4';
        if (activeControls) activeControls.style.display = 'none';
        if (scoreEntry) scoreEntry.style.display = 'none';
      } else {
        gameStatus.textContent = 'No active game';
        gameStatus.style.color = 'var(--muted)';
        if (activeControls) activeControls.style.display = 'none';
        if (scoreEntry) scoreEntry.style.display = 'none';
      }
    }

    // Update settings UI (legacy inline — full populate done below)
    if (autoStartCheck) {
      autoStartCheck.checked = twitch.minigame.settings?.enabled !== false;
    }
    if (autoTypeSelect) {
      autoTypeSelect.value = twitch.minigame.settings?.breakScreenGameType || 'trivia';
    }
  }

  // Populate all settings panels (predictions/wheel/minigame) from state
  populateTwitchGameSettings(twitch);

  // Sidebar predictions quick bar
  renderPredQuickBar(twitch);
}
