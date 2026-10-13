// Control panel, part 10 of 17: Dashboard: stream queue, desk show, brackets, connected event, upcoming and standings, presets.
// Built into control-panel/app.js with the other parts (scripts/build-panel-app.js): one script, one scope.

// ── Dashboard: start.gg stream queue ────────────────────────────────────────
let _sggQueueSig = '';
let _sggStreamHintKey = '';   // event the hint currently refers to (used by the Follow-all button)
// Nudge the producer to pick which stream/station they're producing when a start.gg event runs several.
// This used to be a modal that popped over the whole app on load; it's now an inline line inside the
// event panel, right under the #sgg-stream selector, so loading an event never interrupts anything.
// Picking a station scopes the queue/ticker/schedule + auto-follow to it; "Follow all" is an explicit
// choice, localStorage-gated per event so it stays dismissed on later launches.
function renderStreamFollowHint(streams, evKey, picked) {
  const hint = el('sgg-stream-hint'); if (!hint) return;
  let dismissed = false;
  try { dismissed = !!(evKey && localStorage.getItem('sgg_stream_picked::' + evKey)); } catch (_) {}
  if (picked || dismissed || !evKey || (streams || []).length < 2) { hint.style.display = 'none'; return; }
  hint.style.display = '';
  const msg = el('sgg-stream-hint-msg');
  if (msg) msg.textContent = `This event runs ${streams.length} streams — pick yours above so the queue, ticker, schedule and auto-follow only use that station.`;
}
// "Follow all" is the one action the hint offers; the stations themselves are picked in the selector.
el('sgg-stream-hint-all')?.addEventListener('click', () => {
  const evKey = _sggStreamHintKey;
  try { if (evKey) localStorage.setItem('sgg_stream_picked::' + evKey, '1'); } catch (_) {}
  const sel = el('sgg-stream'); if (sel) sel.value = '';
  const hint = el('sgg-stream-hint'); if (hint) hint.style.display = 'none';
  send('startgg_set_autofollow', { enabled: !!el('sgg-autofollow')?.checked, streamName: '' });
  if (typeof showToast === 'function') showToast('Following all streams');
});
// Two "you are not being moved" states, both deliberately visible: the producer's station has
// dropped off start.gg's queue and is being held from cache (never swapped for another station),
// and auto-follow parking on the match that is already on air instead of jumping to the next one.
function renderStationNote(sg) {
  const note = el('sgg-stream-note'); if (!note) return;
  const hold = sg.autoFollowHold;
  const lines = [];
  if (sg.streamOffQueue && sg.streamName) {
    lines.push(`No sets on "${sg.streamName}" right now — holding your station. Nothing from another stream will be pushed.`);
  }
  if (hold && hold.setId) {
    const q = (sg.queue || []);
    const nxt = q.find((x) => String(x.setId) === String(hold.nextSetId));
    const who = nxt ? `${nxt.teamA || 'TBD'} vs ${nxt.teamB || 'TBD'}` : 'the next match';
    lines.push(`Auto-follow is holding the match on air — ${who} is waiting. Push it yourself to switch now.`);
  }
  note.textContent = lines.join(' ');
  note.style.display = lines.length ? '' : 'none';
}
function renderStreamQueue(data) {
  const sg = data.startgg || {};
  const tEl = el('sgg-tournament');
  if (tEl && document.activeElement !== tEl) {
    tEl.value = sg.tournamentSlug || el('input-startgg-tournament')?.value || '';
  }
  const qOn = el('sgg-queue-enabled');
  if (qOn && document.activeElement !== qOn) qOn.checked = !!sg.queueEnabled;
  const af = el('sgg-autofollow'); if (af && document.activeElement !== af) af.checked = !!sg.autoFollow;
  // Once the event is connected the queue polls automatically — the manual Queue toggle is redundant,
  // so hide it (leaving just Auto-follow). Still shown pre-connection as an escape hatch.
  const qToggle = el('sgg-queue-toggle');
  if (qToggle) qToggle.style.display = sg.connected ? 'none' : '';
  // Same for the slug box + Load Queue button: once connected the slug is already known and
  // the queue refreshes on its own, so the row is dead space. Shown again if we disconnect.
  const slugRow = el('sgg-slug-row');
  if (slugRow) slugRow.style.display = sg.connected ? 'none' : 'flex';
  const status = el('sgg-status');
  if (status) {
    if (sg.connected && sg.queueFetchedAt) {
      status.textContent = `Connected · ${(sg.queue || []).length} queued set(s) · updated ${new Date(sg.queueFetchedAt).toLocaleTimeString()}`;
      status.style.color = '#9ae6b4';
    } else if (sg.lastError) {
      status.textContent = sg.lastError;
      status.style.color = '#f56565';
    } else if (sg.queueEnabled) {
      status.textContent = 'Polling stream queue…';
      status.style.color = 'var(--muted)';
    } else {
      status.textContent = 'Stream queue off. Add your token and tournament under Apps > start.gg, then turn it on.';
      status.style.color = 'var(--muted)';
    }
  }

  const streams = sg.streams || [];
  const streamRow = el('sgg-stream-row');
  const streamSel = el('sgg-stream');
  // Show the picker as soon as the tournament has ANY stream, not just when it has several. On a
  // multi-station championship the producer needs to pin their station before their stream has a
  // set queued on it — waiting until streams.length > 1 hid the control exactly when it mattered.
  if (streamRow) streamRow.style.display = (streams.length || sg.streamName) ? '' : 'none';

  const queue = sg.queue || [];
  const sig = JSON.stringify({ queue, streams, sel: streamSel && streamSel.value, pushed: sg.lastPushedSetId, off: !!sg.streamOffQueue, hold: sg.autoFollowHold || null });
  if (sig === _sggQueueSig) return;
  _sggQueueSig = sig;

  if (streamSel) {
    const cur = streamSel.value;
    // An explicit "All streams" entry: following every station is a deliberate choice, not the
    // accident you get when a station name fails to match. And the station we're ON is always an
    // option, even if this poll's queue didn't list it (the server pins it too — belt and braces):
    // rebuilding the list without it silently reset the selector to "All streams" the moment a
    // station ran out of queued sets, which is exactly when a producer must NOT be moved off it.
    const pinned = cur || sg.streamName || '';
    const opts = pinned && !streams.includes(pinned) ? [...streams, pinned] : streams;
    streamSel.innerHTML = '<option value="">All streams</option>'
      + opts.map((s) => `<option value="${_stEsc(s)}">${_stEsc(s)}</option>`).join('');
    if (opts.includes(cur)) streamSel.value = cur;
    else if (sg.streamName && opts.includes(sg.streamName)) streamSel.value = sg.streamName;
    else if (!cur) streamSel.value = '';
  }
  // Nudge the producer to pick their stream when the event runs several and none is chosen — inline
  // in this panel, never a popup (localStorage stops "Follow all" nagging every launch).
  const _evKey = (sg.tournamentSlug || '') + '|' + (sg.eventSlug || '');
  _sggStreamHintKey = _evKey;
  renderStreamFollowHint(streams, _evKey, !!sg.streamName);
  renderStationNote(sg);
  const wantStream = (streamSel && streamSel.value) || '';
  const wrap = el('sgg-queue'); if (!wrap) return;
  // Once a station is picked the list shows THAT station only — previously a single-stream
  // tournament ignored the filter entirely (streams.length <= 1), which was fine, but the same
  // clause meant the filter silently did nothing in the case it was written for.
  const rows = queue.filter((s) => !wantStream || s.stream === wantStream);
  wrap.innerHTML = '';
  const teamLogos = {};
  (data.savedTeams || []).forEach((t) => { if (t && t.name && t.logo) teamLogos[t.name.toLowerCase()] = t.logo; });
  const logoFor = (name, fallback) => fallback || teamLogos[(name || '').toLowerCase()] || '';
  const sideHtml = (name, logo) => {
    const l = logoFor(name, logo);
    return `<span class="sgg-team">${l ? `<img class="sgg-logo" src="${l}" onerror="this.style.display='none'">` : ''}<b></b></span>`;
  };
  rows.forEach((s) => {
    const row = document.createElement('div');
    // Green = start.gg has the set IN PROGRESS. The set merely sitting at the head of the stream
    // queue is "ON DECK" — cued up, not called. (Before, head-of-queue was painted LIVE, so a
    // semi-final showed green the moment the quarter-finals cleared off the queue.)
    const onDeck = !s.live && s.state !== 3 && s.onStream;
    row.className = 'sgg-row' + (s.live ? ' live' : (onDeck ? ' ondeck' : ''));
    const badge = s.live ? 'LIVE' : (s.state === 3 ? 'DONE' : (onDeck ? 'ON DECK' : 'NEXT'));
    const onOverlay = s.setId === sg.lastPushedSetId;
    const score = (s.scoreA != null || s.scoreB != null) ? `<span class="sgg-score">${s.scoreA ?? 0}–${s.scoreB ?? 0}</span>` : '';
    row.innerHTML = `
      <span class="sgg-badge">${badge}</span>
      <span class="sgg-match">${sideHtml(s.teamA, s.logoA)} <span class="sgg-vs">vs</span> ${sideHtml(s.teamB, s.logoB)}${score}<span class="sgg-round"></span></span>
      <button class="btn btn-secondary btn-sm sgg-push"></button>`;
    const bolds = row.querySelectorAll('.sgg-team b');
    bolds[0].textContent = s.teamA; bolds[1].textContent = s.teamB;
    row.querySelector('.sgg-round').textContent = s.round || '';
    const btn = row.querySelector('.sgg-push');
    btn.textContent = onOverlay ? 'On overlay' : 'Push';
    btn.addEventListener('click', async () => { if (await confirmQueuePush()) send('startgg_push_set', { setId: s.setId }); });
    wrap.appendChild(row);
  });
}
function _sggShowTab(which) {
  const tabs = { queue: 'sgg-tab-queue', team: 'sgg-tab-team', archive: 'sgg-tab-archive' };
  Object.entries(tabs).forEach(([k, id]) => el(id)?.classList.toggle('is-on', k === which));
  if (el('sgg-queue-wrap')) el('sgg-queue-wrap').style.display = which === 'queue' ? '' : 'none';
  if (el('sgg-team-wrap')) el('sgg-team-wrap').style.display = which === 'team' ? '' : 'none';
  if (el('sgg-archive-wrap')) el('sgg-archive-wrap').style.display = which === 'archive' ? '' : 'none';
  // Auto-follow / Queue toggles drive the LIVE queue — hide them on the read-only Archive.
  if (el('sgg-queue-toggles')) el('sgg-queue-toggles').style.display = which === 'archive' ? 'none' : '';
}
el('sgg-tab-queue')?.addEventListener('click', () => {
  _sggShowTab('queue');
  send('startgg_set_upcoming_mode', { mode: 'event' });   // upcoming/schedule board follows the stream queue
});
el('sgg-tab-team')?.addEventListener('click', () => {
  _sggShowTab('team');
  send('startgg_set_upcoming_mode', { mode: 'team' });   // upcoming/schedule board follows the searched team
  refreshSggTeamPicker();
});
el('sgg-tab-archive')?.addEventListener('click', () => {
  _sggShowTab('archive');
  renderStreamArchive(currentState || {});
});
// Post-event review: the matches that played / were on air on the followed stream this event, newest
// first. Read-only apart from a Re-push button to put one back on the scoreboard.
function renderStreamArchive(data) {
  const wrap = el('sgg-archive'); if (!wrap) return;
  const sg = (data || currentState || {}).startgg || {};
  const arch = (Array.isArray(sg.queueArchive) ? sg.queueArchive.slice() : []).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (!arch.length) {
    wrap.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px 2px;">No matches archived yet — sets you broadcast this event collect here.</div>';
    return;
  }
  const teamLogos = {};
  ((data || {}).savedTeams || (currentState || {}).savedTeams || []).forEach((t) => { if (t && t.name && t.logo) teamLogos[t.name.toLowerCase()] = t.logo; });
  const logoFor = (name) => teamLogos[(name || '').toLowerCase()] || '';
  const sideHtml = (name) => { const l = logoFor(name); return `<span class="sgg-team">${l ? `<img class="sgg-logo" src="${l}" onerror="this.style.display='none'">` : ''}<b></b></span>`; };
  wrap.innerHTML = '';
  arch.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'sgg-row' + (s.done ? '' : ' ondeck');
    const badge = s.done ? 'DONE' : 'ON AIR';
    const score = (s.scoreA != null || s.scoreB != null) ? `<span class="sgg-score">${s.scoreA ?? 0}–${s.scoreB ?? 0}</span>` : '';
    const when = s.ts ? new Date(s.ts).toLocaleTimeString() : '';
    row.innerHTML = `
      <span class="sgg-badge">${badge}</span>
      <span class="sgg-match">${sideHtml(s.teamA)} <span class="sgg-vs">vs</span> ${sideHtml(s.teamB)}${score}<span class="sgg-round"></span></span>
      <button class="btn btn-secondary btn-sm sgg-push">Re-push</button>`;
    const bolds = row.querySelectorAll('.sgg-team b');
    bolds[0].textContent = s.teamA; bolds[1].textContent = s.teamB;
    row.querySelector('.sgg-round').textContent = [s.round, s.stream, when].filter(Boolean).join(' · ');
    row.querySelector('.sgg-push').addEventListener('click', async () => { if (await confirmQueuePush()) send('startgg_push_set', { setId: s.setId }); });
    wrap.appendChild(row);
  });
}

// Logo-carrying team picker for the Stream Queue → Team search (same searchable component as the
// Match team / brand-kit pickers, so producers see logos instead of a plain text datalist).
let _sggPickedTeam = '';
let _sggPickerSig = '';
function refreshSggTeamPicker(force) {
  const mount = el('sgg-team-pick');
  if (!mount || typeof buildSearchPicker !== 'function') return;
  const teams = allMatchTeams();
  const sig = teams.map((t) => (t.name || '') + '|' + (t.logo ? '1' : '0')).join('~');
  if (!force && sig === _sggPickerSig && mount.firstChild) return;
  _sggPickerSig = sig;
  const items = teams.map((t) => ({ value: t.name, label: t.name, img: t.logo || '../assets/rl.png' }));
  mount.innerHTML = '';
  mount.appendChild(buildSearchPicker({
    items, value: _sggPickedTeam, placeholder: 'Search team…', emptyLabel: '— Clear —',
    className: 'sgg-team-pick',
    onPick: (name) => {
      _sggPickedTeam = name || '';
      if (!name) return;
      const st = el('sgg-status');
      if (st) { st.textContent = 'Searching…'; st.style.color = 'var(--muted)'; }
      send('startgg_fetch_team_queue', { teamName: name });
    },
  }));
}
el('sgg-team-search')?.addEventListener('click', () => {
  const name = (_sggPickedTeam || '').trim();
  const st = el('sgg-status');
  if (!name) { if (st) { st.textContent = 'Pick a team first.'; st.style.color = '#f56565'; } return; }
  if (st) { st.textContent = 'Searching...'; st.style.color = 'var(--muted)'; }
  send('startgg_fetch_team_queue', { teamName: name });
});
el('sgg-load')?.addEventListener('click', () => send('startgg_fetch_queue', { tournamentSlug: (el('sgg-tournament')?.value || '').trim() }));
el('sgg-queue-enabled')?.addEventListener('change', function () {
  send('startgg_set_queue', { enabled: this.checked });
});
el('sgg-autofollow')?.addEventListener('change', function () {
  send('startgg_set_autofollow', { enabled: this.checked, streamName: el('sgg-stream')?.value || '' });
});
el('sgg-stream')?.addEventListener('change', function () {
  _sggQueueSig = '';
  // Picking from the selector IS the answer to the inline nudge — dismiss it now (and for good on
  // this event) rather than waiting for the next state round-trip.
  try { if (_sggStreamHintKey) localStorage.setItem('sgg_stream_picked::' + _sggStreamHintKey, '1'); } catch (_) {}
  const _hint = el('sgg-stream-hint'); if (_hint) _hint.style.display = 'none';
  // ALWAYS tell the server which station we're on — not only while auto-follow is armed. The
  // server uses streamName for the ticker scope and for Autofill Teams too, and producers pick
  // their station during setup, before arming auto-follow. Passing the switch's current value
  // keeps this a stream change, not an auto-follow change.
  send('startgg_set_autofollow', { enabled: !!el('sgg-autofollow')?.checked, streamName: this.value });
  const st = el('sgg-status');
  if (st) {
    st.textContent = this.value ? `Following "${this.value}" — queue and auto-follow ignore other streams.` : 'Following all streams.';
    st.style.color = 'var(--muted)';
  }
});

const CASTER_DESK_LAYOUTS = [
  { name: 'Casters (grid)', path: '/casters.html', desc: 'Flexible 1–4 cam grid' },
  { name: 'Single Cam', path: '/singlecam.html', desc: 'Solo caster + scorebar' },
  { name: 'Duo Row', path: '/duorow.html', desc: '2 cams + scorebar' },
  { name: 'Duo Row — No Scorebar', path: '/duorow-noscore.html', desc: '2 cams, no scorebar (podcast/panel)' },
  { name: 'Quad Desk — No Scorebar', path: '/quaddesk-noscore.html', desc: '4 cams 2×2, no scorebar (podcast/panel)' },
  { name: 'Desk Show', path: '/preshow.html', desc: '2 cams + topics rail + kickoff countdown' },
  { name: 'Trio Row', path: '/triorow.html', desc: '3 cams + scorebar' },
  { name: 'Duo (single cam)', path: '/duosinglecam.html', desc: '2 casters, 1 cam' },
  { name: 'Analyst Desk', path: '/analystspecial.html', desc: 'Analyst layout' },
  { name: 'Cam Over Game (PiP)', path: '/campip.html', desc: 'Cam(s) in a corner over gameplay' },
  { name: 'Talent Bar', path: '/talentbar.html', desc: 'Lower-third caster bar' }
];

function renderCasterDeskSponsors(data) {
  const override = (data.deskFooter && Array.isArray(data.deskFooter.logos)) ? data.deskFooter.logos.filter(Boolean) : [];
  // "What airs" preview = override logos if any, else the active brand's desk sponsors.
  const wrap = el('caster-desk-sponsors');
  if (wrap) {
    wrap.innerHTML = '';
    const effective = override.length
      ? override.map(l => ({ logo: l, name: '' }))
      : ((data.brand && (data.brand.deskSponsors || data.brand.sponsors)) || []).filter(s => s && s.logo);
    if (!effective.length) {
      wrap.innerHTML = '<span class="field-hint">No desk logos yet — tag sponsors as “desk” on the active brand, or add override logos below.</span>';
    } else {
      effective.forEach(s => {
        const img = document.createElement('img');
        img.className = 'caster-sponsor-thumb'; img.src = s.logo; img.alt = s.name || 'Sponsor'; img.title = s.name || '';
        wrap.appendChild(img);
      });
    }
  }
  // Override management (remove individual logos).
  const ov = el('desk-footer-override');
  const badge = el('desk-footer-ov-badge');
  if (badge) badge.style.display = override.length ? '' : 'none';
  if (ov) {
    ov.innerHTML = '';
    if (!override.length) {
      ov.innerHTML = '<span class="field-hint" style="font-size:11px;">No override — using the active brand\'s desk sponsors.</span>';
    } else {
      override.forEach((logo, i) => {
        const cell = document.createElement('div'); cell.className = 'desk-ov-cell';
        const img = document.createElement('img'); img.className = 'caster-sponsor-thumb'; img.src = logo; img.alt = '';
        const del = document.createElement('button'); del.className = 'desk-ov-del'; del.type = 'button'; del.textContent = '×'; del.title = 'Remove logo';
        del.addEventListener('click', () => { const next = override.slice(); next.splice(i, 1); send('set_desk_footer', { logos: next }); });
        cell.appendChild(img); cell.appendChild(del); ov.appendChild(cell);
      });
    }
  }
}
el('input-desk-footer-logo')?.addEventListener('change', async function () {
  const f = this.files && this.files[0]; if (!f) return;
  const b64 = await fileToBase64(f); this.value = '';
  const cur = (currentState.deskFooter && currentState.deskFooter.logos) || [];
  send('set_desk_footer', { logos: cur.concat([b64]) });
});
el('btn-desk-footer-clear')?.addEventListener('click', () => send('set_desk_footer', { logos: [] }));

// ── Desk Show settings (Graphics ▸ Show ▸ Desk Show): topics + headline + return scene ──
let _preshowTopicsSig = '';
let _preshowPresetSig = '';
function renderPreshowGfxPanel(data) {
  const headline = el('preshow-headline');
  const pre = data.preshow || {};
  if (headline && document.activeElement !== headline) headline.value = pre.headline || '';

  // Named topic presets (saved rundowns — pre-show / halftime / post-show…)
  const psel = el('preshow-preset-sel');
  if (psel) {
    const presets = data.preshowPresets || [];
    const psig = JSON.stringify(presets.map((p) => p.id + p.name + (p.topics || []).length));
    if (psig !== _preshowPresetSig && document.activeElement !== psel) {
      _preshowPresetSig = psig;
      const keep = psel.value;
      psel.innerHTML = '<option value="">— presets —</option>' +
        presets.map((p) => `<option value="${p.id}">${poEsc(p.name)} (${(p.topics || []).length})</option>`).join('');
      if (keep && presets.some((p) => p.id === keep)) psel.value = keep;
    }
  }

  const scenes = (data.obs && data.obs.availableScenes) || [];
  const homeSel = el('preshow-home-scene');
  if (homeSel) {
    const homeSig = JSON.stringify(scenes) + '::' + (pre.homeScene || '');
    if (homeSel.dataset.sig !== homeSig && document.activeElement !== homeSel) {
      homeSel.dataset.sig = homeSig;
      fillSceneSelect(homeSel, scenes, pre.homeScene || '');
    }
  }

  // Caster Predictions — one row per desk cam slot (1/2). Each caster predicts the WHOLE
  // tournament's winner, so the pick is searched from the full team library (savedTeams), not
  // limited to whichever two teams the current match happens to be. NOTE: this must stay ABOVE
  // the topics sig-check/early-return below, or a prediction click (which doesn't touch topics)
  // would never get reflected here on its own broadcast.
  const predWrap = el('preshow-predictions');
  if (predWrap) {
    const predictions = [0, 1].map((i) => (Array.isArray(pre.predictions) && pre.predictions[i]) || '');
    const casters = (data.casters && Array.isArray(data.casters.list)) ? data.casters.list : [];
    const anySlotted = casters.some((c) => c && Number(c.slot) >= 1);
    const casterAt = (n) => {
      const hit = casters.find((c) => c && Number(c.slot) === n);
      if (hit) return hit;
      return anySlotted ? null : (casters[n - 1] || null);
    };
    const predSig = JSON.stringify(predictions) + '::'
      + casters.map((c) => (c && c.slot) + ':' + (c && c.name)).join(',');
    // Don't rebuild while a caster's search box is mid-type — that'd yank focus and lose the query.
    const predFocused = document.activeElement;
    const predTyping = !!(predFocused && predFocused.classList && predFocused.classList.contains('ps-pred-search') && predWrap.contains(predFocused));
    if (predWrap.dataset.sig !== predSig && !predTyping) {
      predWrap.dataset.sig = predSig;
      predWrap.innerHTML = [1, 2].map((slot) => {
        const c = casterAt(slot);
        const nameHtml = c ? esc(c.name || ('Caster ' + slot)) : `<span class="ps-pred-empty">Slot ${slot} — unassigned</span>`;
        const pick = predictions[slot - 1];
        // The pick's own logo snapshot is stripped from the live broadcast (it's 50KB+ of base64
        // that no overlay draws) — resolve it from the team library instead, falling back to any
        // logo that did travel, then the game mark.
        // Same pool the search uses — resolving against savedTeams alone meant a picked EVENT team
        // (never saved to the library) fell back to the bare game mark.
        const teamLogo = pick
          ? ((psPredTeamPool().find((t) => t && (t.name || '').toLowerCase() === (pick.name || '').toLowerCase()) || {}).logo || pick.logo || '')
          : '';
        // Game marks are mono/dark, so a fallback needs the same whitening the dropdown gives it.
        const pickLogo = teamLogo || gameLogo();
        const pickArea = pick
          ? `<div class="ps-pred-chip">`
            + `<img class="ps-pred-chip-logo${teamLogo ? '' : ' game-logo-white'}" src="${esc(pickLogo)}" alt="" onerror="this.style.visibility='hidden'">`
            + `<span class="ps-pred-chip-name">${esc((pick.name || '').toUpperCase())}</span>`
            + `<button type="button" class="ps-pred-chip-clear" data-slot="${slot}" title="Clear pick">✕</button>`
            + `</div>`
          : `<div class="team-typeahead ps-pred-typeahead">`
            + `<input type="text" class="input-text ps-pred-search" data-slot="${slot}" placeholder="Search teams — who wins the tournament?" autocomplete="off">`
            + `<div class="team-dd ps-pred-dd" data-slot="${slot}" role="listbox"></div>`
            + `</div>`;
        return `<div class="ps-pred-row" data-slot="${slot}">`
          + `<span class="ps-pred-name">${nameHtml}</span>`
          + `<div class="ps-pred-pickarea">${pickArea}</div>`
          + `</div>`;
      }).join('');
      // (Re)wire the search box for whichever slot doesn't have a pick yet.
      [1, 2].forEach((slot) => { if (!predictions[slot - 1]) wirePreshowPredictionSearch(slot); });
    }
  }

  const list = el('preshow-topics-list');
  if (!list) return;
  const topics = Array.isArray(pre.topics) ? pre.topics : [];
  const activeIdx = pre.activeTopicIndex || 0;
  const sig = JSON.stringify(topics) + '::' + activeIdx + '::' + JSON.stringify(scenes);
  if (sig === _preshowTopicsSig) return;
  // Don't rebuild while a topic's own text input is focused — that'd yank the cursor mid-type.
  const focused = document.activeElement;
  if (focused && focused.tagName === 'INPUT' && list.contains(focused)) return;
  _preshowTopicsSig = sig;

  list.innerHTML = '';
  if (!topics.length) {
    const empty = document.createElement('p');
    empty.className = 'field-hint';
    empty.style.margin = '0';
    empty.textContent = 'No topics yet — add one below.';
    list.appendChild(empty);
    return;
  }
  topics.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'ps-topic-row';
    const activeBtn = document.createElement('button');
    activeBtn.type = 'button'; activeBtn.className = 'btn btn-ghost btn-sm';
    activeBtn.title = 'Set as active topic — also cuts OBS to its Scene, if set';
    activeBtn.textContent = i === activeIdx ? '●' : '○';
    activeBtn.style.color = i === activeIdx ? '#4ade80' : '';
    activeBtn.addEventListener('click', () => {
      send('set_preshow', { activeTopicIndex: i });
      const sceneName = (t && t.sceneName) || '';
      if (sceneName) send('obs_switch_scene', { sceneName });
    });
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'input-text ps-topic-text';
    input.maxLength = 60; input.placeholder = 'Topic…'; input.value = (t && t.text) || '';
    input.addEventListener('input', function () {
      const cur = (currentState.preshow && currentState.preshow.topics) || [];
      const next = cur.map((x) => ({ ...x }));
      next[i] = { ...(next[i] || {}), text: this.value };
      sendPreshowSoon({ topics: next });
    });
    input.addEventListener('blur', flushPreshowSend);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') flushPreshowSend(); });
    const sceneSel = document.createElement('select');
    sceneSel.className = 'input-select ps-topic-scene';
    sceneSel.title = 'Optional — cut OBS to this scene when this topic goes active';
    fillSceneSelect(sceneSel, scenes, (t && t.sceneName) || '');
    sceneSel.addEventListener('change', function () {
      flushPreshowSend();   // land any half-typed text first, so this doesn't overwrite it
      const cur = (currentState.preshow && currentState.preshow.topics) || [];
      const next = cur.map((x) => ({ ...x }));
      next[i] = { ...(next[i] || {}), sceneName: this.value };
      send('set_preshow', { topics: next });
    });
    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.className = 'btn btn-ghost btn-sm'; delBtn.title = 'Remove topic';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', () => {
      flushPreshowSend();
      const cur = (currentState.preshow && currentState.preshow.topics) || [];
      const next = cur.slice(); next.splice(i, 1);
      let nextActive = (currentState.preshow && currentState.preshow.activeTopicIndex) || 0;
      if (nextActive >= next.length) nextActive = Math.max(0, next.length - 1);
      send('set_preshow', { topics: next, activeTopicIndex: nextActive });
    });
    row.append(activeBtn, input, sceneSel, delBtn);
    list.appendChild(row);
  });
}
// Desk Show text fields (topic rows + headline) fire on every keystroke, and each send makes the
// server re-broadcast state and persist the active brand package. Coalesce a burst of typing into
// one send after a short pause; blur/Enter flush immediately so nothing is lost on a fast tab-away.
let _preshowSendTimer = null, _preshowSendPending = null;
function sendPreshowSoon(patch) {
  _preshowSendPending = { ..._preshowSendPending, ...patch };
  clearTimeout(_preshowSendTimer);
  _preshowSendTimer = setTimeout(flushPreshowSend, 300);
}
function flushPreshowSend() {
  clearTimeout(_preshowSendTimer); _preshowSendTimer = null;
  if (!_preshowSendPending) return;
  const patch = _preshowSendPending; _preshowSendPending = null;
  send('set_preshow', patch);
}
el('btn-preshow-add-topic')?.addEventListener('click', () => {
  const cur = (currentState.preshow && currentState.preshow.topics) || [];
  if (cur.length >= 12) return;
  send('set_preshow', { topics: cur.concat([{ text: 'New topic', sceneName: '' }]) });
});
el('preshow-headline')?.addEventListener('input', function () {
  sendPreshowSoon({ headline: this.value });
});
el('preshow-headline')?.addEventListener('blur', flushPreshowSend);
el('preshow-home-scene')?.addEventListener('change', function () {
  send('set_preshow', { homeScene: this.value });
});
// Caster Predictions — search-and-pick ANY team from the library (tournament-winner pick, not
// tied to the active match). Same logo-capable typeahead pattern as Match > Teams
// (setupTeamTypeahead) and Spotlight's add-team search (setupSpotlightTeamSearch).
// Teams a caster can pick from: the saved library PLUS everyone actually in the loaded event.
// It used to be savedTeams only, so a team that came in with the bracket but was never saved to
// the library simply couldn't be picked — which is most of the field at a fresh event.
// Harvested from the bracket's own SETS as well as its roster, because that works the same for
// start.gg, Challonge, NXGEN and FACEIT without caring how each one shapes its entrant list.
function psPredTeamPool() {
  const out = [];
  const byName = new Map();
  const add = (name, logo, players) => {
    const n = String(name || '').trim();
    if (!n || n.toUpperCase() === 'TBD' || /^bye$/i.test(n)) return;
    const k = n.toLowerCase();
    const prev = byName.get(k);
    if (prev) {
      // First one in wins on identity; fill blanks from later sources (a bracket entry can supply
      // a logo the library row lacks, and vice versa).
      if (!prev.logo && logo) prev.logo = logo;
      if ((!prev.players || !prev.players.length) && players && players.length) prev.players = players;
      return;
    }
    const rec = { name: n, logo: logo || '', players: players || [] };
    byName.set(k, rec); out.push(rec);
  };

  (currentState.savedTeams || []).forEach((t) => t && add(t.name, t.logo, t.players));
  const sg = currentState.startgg || {};
  (sg.eventTeams || []).forEach((t) => t && add(t.name, t.logo, t.players));

  const b = currentState.bracket || {};
  (b.teams || []).forEach((t) => t && add(t.name, t.logo));
  (b.roster || []).forEach((r) => add(typeof r === 'string' ? r : (r && r.name), r && r.logo));
  const bands = [].concat(b.winners || [], b.losers || [], b.finals || [], b.schedule || []);
  bands.forEach((rd) => ((rd && rd.sets) || []).forEach((set) => {
    if (!set) return;
    [set.a, set.b].forEach((sl) => { if (sl) add(sl.name, sl.logo); });
  }));
  (b.pools || []).forEach((pl) => {
    [].concat(pl.winners || [], pl.losers || [], pl.finals || [], pl.schedule || [])
      .forEach((rd) => ((rd && rd.sets) || []).forEach((set) => {
        if (!set) return;
        [set.a, set.b].forEach((sl) => { if (sl) add(sl.name, sl.logo); });
      }));
  });
  return out;
}

function wirePreshowPredictionSearch(slot) {
  const input = psPredInput(slot);
  const dd = psPredDd(slot);
  if (!input || !dd) return;
  let items = [], active = -1, open = false;
  const close = () => { dd.classList.remove('show'); open = false; active = -1; };
  const position = () => {
    const r = input.getBoundingClientRect();
    dd.style.left = r.left + 'px'; dd.style.width = r.width + 'px';
    const below = window.innerHeight - r.bottom;
    if (below < 220 && r.top > below) { dd.style.top = 'auto'; dd.style.bottom = (window.innerHeight - r.top + 4) + 'px'; }
    else { dd.style.bottom = 'auto'; dd.style.top = (r.bottom + 4) + 'px'; }
  };
  // Ranked before the cap, so the team being typed can't fall off the end of an unranked slice.
  const candidates = (q) => NESearch.filter(psPredTeamPool(), (q || '').trim(),
    (t) => [{ text: t.name, weight: 2 },
      { text: (t.players || []).map((p) => (typeof p === 'string' ? p : ((p && (p.name || p.gamertag)) || ''))).join(' '), bag: true }],
    { limit: 60 }).slice(0, 60);
  const render = () => {
    if (!items.length) {
      dd.innerHTML = `<div class="team-dd-empty">${psPredTeamPool().length ? 'No matching teams' : 'No teams yet — load an event or add them on the Teams page'}</div>`;
      position(); dd.classList.add('show'); open = true; return;
    }
    dd.innerHTML = items.map((t, i) => {
      const logo = t.logo || gameLogo();
      const nm = esc((t.name || '').toUpperCase());
      return `<div class="team-dd-item${i === active ? ' active' : ''}" data-i="${i}" role="option">`
        + `<img class="team-dd-logo${t.logo ? '' : ' game-logo-white'}" src="${logo}" alt="" onerror="this.style.visibility='hidden'">`
        + `<span class="team-dd-name">${nm}</span></div>`;
    }).join('');
    position(); dd.classList.add('show'); open = true;
    const act = dd.querySelector('.team-dd-item.active'); if (act) act.scrollIntoView({ block: 'nearest' });
  };
  const refresh = () => { items = candidates(input.value); active = -1; render(); };
  const pick = (t) => {
    if (!t) return;
    const cur = [0, 1].map((i) => (Array.isArray(currentState.preshow?.predictions) && currentState.preshow.predictions[i]) || '');
    cur[slot - 1] = { name: t.name, logo: t.logo || '' };
    send('set_preshow', { predictions: cur });
  };
  input.addEventListener('focus', refresh);
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (e) => {
    if (!open && e.key === 'ArrowDown') { refresh(); return; }
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (active >= 0 && items[active]) pick(items[active]); else if (items.length === 1) pick(items[0]); }
    else if (e.key === 'Escape') { close(); }
  });
  dd.addEventListener('mousedown', (e) => { const it = e.target.closest('.team-dd-item'); if (!it) return; e.preventDefault(); pick(items[Number(it.dataset.i)]); });
  input.addEventListener('blur', () => setTimeout(close, 150));
  window.addEventListener('scroll', () => { if (open) position(); }, true);
  window.addEventListener('resize', () => { if (open) close(); });
}
function psPredInput(slot) { return document.querySelector('#preshow-predictions .ps-pred-search[data-slot="' + slot + '"]'); }
function psPredDd(slot) { return document.querySelector('#preshow-predictions .ps-pred-dd[data-slot="' + slot + '"]'); }
// Clear ✕ on a made pick.
el('preshow-predictions')?.addEventListener('click', (e) => {
  const clearBtn = e.target.closest('.ps-pred-chip-clear'); if (!clearBtn) return;
  const slot = +clearBtn.dataset.slot; if (!slot) return;
  const cur = [0, 1].map((i) => (Array.isArray(currentState.preshow?.predictions) && currentState.preshow.predictions[i]) || '');
  cur[slot - 1] = '';
  send('set_preshow', { predictions: cur });
});
el('btn-preshow-clear-picks')?.addEventListener('click', () => send('set_preshow', { predictions: ['', ''] }));
// Topic presets — save/load/delete named rundowns.
el('preshow-preset-save')?.addEventListener('click', async () => {
  const cur = el('preshow-preset-sel');
  const curName = (currentState.preshowPresets || []).find((p) => p.id === cur?.value)?.name || '';
  const name = await customPrompt('Save Topic Preset', 'Preset name (same name overwrites)', curName, 'Save');
  if (!name || !name.trim()) return;
  send('save_preshow_preset', { name: name.trim() });
  showToast(`Topics saved as "${name.trim()}"`, '#22c55e');
});
function preshowLoadPreset(id) {
  if (!id) { showToast('Pick a preset to load.', '#fbbf24'); return; }
  send('apply_preshow_preset', { id });
  showToast('Topic preset loaded.', '#22c55e');
}
el('preshow-preset-load')?.addEventListener('click', () => preshowLoadPreset(el('preshow-preset-sel')?.value));
// Picking a preset from the dropdown loads it immediately — Load stays as an explicit re-load
// (useful to discard in-progress edits back to the selected preset, since re-picking the same
// already-selected option doesn't fire another 'change' event).
el('preshow-preset-sel')?.addEventListener('change', function () { if (this.value) preshowLoadPreset(this.value); });
el('preshow-preset-del')?.addEventListener('click', async () => {
  const sel = el('preshow-preset-sel');
  const id = sel?.value;
  if (!id) { showToast('Pick a preset to delete.', '#fbbf24'); return; }
  const p = (currentState.preshowPresets || []).find((x) => x.id === id);
  if (!await appConfirm(`Delete topic preset "${(p && p.name) || ''}"?`, 'Delete')) return;
  send('delete_preshow_preset', { id });
  if (sel) sel.value = '';
});
el('btn-preshow-return')?.addEventListener('click', () => {
  const home = (currentState.preshow && currentState.preshow.homeScene) || '';
  if (!home) { showToast('Pick a Return-to scene first.', '#fbbf24'); return; }
  const backend = typeof swBackend === 'function' ? swBackend(currentState) : 'obs';
  const ready = backend === 'vmix' ? !!(currentState.vmix && currentState.vmix.connected) : !!(currentState.obs && currentState.obs.connected);
  if (!ready) { showToast(`${backend === 'vmix' ? 'vMix' : 'OBS'} isn't connected — can't cut scenes.`, '#ef4444'); return; }
  send('obs_switch_scene', { sceneName: home });
  showToast(`Cutting to "${home}"…`, '#22c55e');
});

function buildCasterDeskLayouts() {
  const wrap = el('caster-desk-layouts');
  if (!wrap || wrap.dataset.built) return;
  wrap.dataset.built = '1';
  CASTER_DESK_LAYOUTS.forEach((it) => {
    const url = SCENE_BASE_URL + it.path;
    const row = document.createElement('div');
    row.className = 'caster-desk-layout-row';
    row.innerHTML = `
      <div class="cdl-info">
        <span class="cdl-name">${it.name}</span>
        <span class="cdl-desc">${it.desc}</span>
      </div>
      <span class="cdl-actions">
        <button type="button" class="btn btn-secondary btn-sm cdl-copy" title="Copy the real URL — use this one for OBS">Copy</button>
        <button type="button" class="btn btn-secondary btn-sm cdl-preview" title="Opens with sample data for a quick look — do NOT copy this tab's address into OBS, use Copy/Open instead">Preview</button>
        <button type="button" class="btn btn-blue btn-sm cdl-open" title="Open the real URL — same one OBS should use">Open</button>
      </span>`;
    row.querySelector('.cdl-open').addEventListener('click', () => window.open(url, '_blank'));
    row.querySelector('.cdl-preview').addEventListener('click', () => window.open(url + '?preview=1', '_blank'));
    const copyBtn = row.querySelector('.cdl-copy');
    copyBtn.addEventListener('click', () => {
      const done = () => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(done).catch(() => customPrompt('Copy link', 'Select the link and copy it.', url, 'Done'));
      else customPrompt('Copy link', 'Select the link and copy it.', url, 'Done');
    });
    wrap.appendChild(row);
  });
}

document.querySelectorAll('#btn-goto-brands, .js-goto-brands').forEach((b) => {
  b.addEventListener('click', () => { if (typeof openSettings === 'function') openSettings('brandkits'); });
});

buildOnAirGrid();
buildSceneSourceList();
buildCasterDeskLayouts();

// ── Connection signal tooltip hover ──────────────────────────────────────────
// Tooltip is moved to <body> and positioned with fixed coords to escape all
// stacking contexts and overflow:hidden parents in the header.
(function () {
  const sig = el('conn-signal');
  const tip = el('conn-tooltip');
  if (!sig || !tip) return;

  // Re-parent tooltip to body so z-index: 9999 + position: fixed actually works.
  document.body.appendChild(tip);

  let hideTimer = null;

  const reposition = () => {
    const r = sig.getBoundingClientRect();
    tip.style.top  = (r.bottom + 6) + 'px';
    tip.style.left = r.left + 'px';
  };

  const open = () => {
    clearTimeout(hideTimer);
    reposition();
    sig.classList.add('open');
    tip.classList.add('open');
  };
  const close = () => {
    sig.classList.remove('open');
    tip.classList.remove('open');
  };
  const scheduleClose = () => { hideTimer = setTimeout(close, 150); };

  sig.addEventListener('mouseenter', open);
  sig.addEventListener('mouseleave', scheduleClose);
  tip.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  tip.addEventListener('mouseleave', close);
})();

// ── Production: Player Spotlight ────────────────────────────────────────────
let _lastSpotlightPlayers = '';

function applySpotlightState(data) {
  const sp = data.spotlight || {};
  const cb = el('check-spotlight-visible');
  if (cb) cb.checked = !!sp.visible;

  const sel = el('select-spotlight-player');
  if (!sel) return;

  // Rebuild the player list only when it changes (keep the operator's choice)
  const players = (data.players || []).map(p => p.name).filter(Boolean);
  const key = players.join('|');
  if (key !== _lastSpotlightPlayers && document.activeElement !== sel) {
    _lastSpotlightPlayers = key;
    const current = sel.value || sp.playerName || '';
    sel.innerHTML = '<option value="">— Select player —</option>';
    players.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });
    if (current && players.includes(current)) sel.value = current;
    else if (sp.playerName) {
      // keep a chosen-but-offline player selectable
      const opt = document.createElement('option');
      opt.value = sp.playerName;
      opt.textContent = `${sp.playerName} (offline)`;
      sel.appendChild(opt);
      sel.value = sp.playerName;
    }
  }
}

el('btn-spotlight-apply')?.addEventListener('click', () => {
  send('set_spotlight', { visible: true, playerName: el('select-spotlight-player')?.value || '' });
  const cb = el('check-spotlight-visible');
  if (cb) cb.checked = true;
});

el('check-spotlight-visible')?.addEventListener('change', function() {
  send('set_spotlight', { visible: this.checked, playerName: el('select-spotlight-player')?.value || '' });
});

// ── Production: live status chips ───────────────────────────────────────────
function applyProdStatus(data) {
  const obs = data.obs || {};
  const bracket = data.bracket || {};

  const chipObs = el('chip-obs');
  if (chipObs) {
    const on = obs.enabled && obs.connected;
    chipObs.textContent = obs.enabled ? (on ? 'OBS: connected' : 'OBS: disconnected') : 'OBS: off';
    chipObs.className = 'prod-chip' + (on ? ' ok' : (obs.enabled ? ' warn' : ''));
  }

  const chipEvent = el('chip-event');
  if (chipEvent) {
    chipEvent.textContent = bracket.title ? `Event: ${bracket.title}` : 'No event loaded';
    chipEvent.className = 'prod-chip' + (bracket.title ? ' ok' : '');
  }

  const chipAir = el('chip-onair');
  if (chipAir) {
    let air = 'Game';
    if (data.breakScreen && data.breakScreen.visible) air = 'Break';
    else if (data.bracket && data.bracket.visible) air = 'Bracket';
    else if (data.casters && data.casters.visible) air = 'Casters';
    else if (data.view === 'scoreboard') air = 'Post-game';
    chipAir.textContent = `On air: ${air}`;
    chipAir.className = 'prod-chip';
  }
}

// ── Production: Ticker ──────────────────────────────────────────────────────
function getTickerMessages() {
  return (el('input-ticker-messages')?.value || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Content only (no visibility) — reused by both the top-bar Push (adds visible:true) and the
// panel's Apply action (saves content live without forcing the scene on/off).
function tickerContentPayload() {
  return {
    source: el('select-ticker-source')?.value || 'manual',
    messages: getTickerMessages(),
    speed: parseInt(el('input-ticker-speed')?.value) || 10
  };
}
el('btn-ticker-apply')?.addEventListener('click', () => {
  send('set_ticker', { ...tickerContentPayload(), visible: true });
});
el('select-ticker-source')?.addEventListener('change', function() {
  send('set_ticker', { source: this.value });
});


function applyTickerState(data) {
  const ticker = data.ticker || {};

  const srcEl = el('select-ticker-source');
  if (srcEl && document.activeElement !== srcEl) srcEl.value = ticker.source || 'manual';
  // Either live-scores platform: the promo lines interleave the same way for both.
  const isSgg = ticker.source === 'startgg' || ticker.source === 'nxgen';
  // Promo lines are usable in BOTH modes now: the whole ticker in manual mode, and interleaved
  // between the live scores in start.gg mode (so a short match feed isn't the only thing looping).
  const msgRow = el('ticker-msg-row'); if (msgRow) msgRow.style.opacity = '';
  const msgEl = el('input-ticker-messages');
  if (msgEl) {
    msgEl.disabled = false;
    msgEl.placeholder = isSgg ? 'Optional promo lines shown between the live scores…' : 'Powered by ACME Energy';
    if (document.activeElement !== msgEl) msgEl.value = (ticker.messages || []).join('\n');
  }
  const speedEl = el('input-ticker-speed');
  if (speedEl && document.activeElement !== speedEl) {
    speedEl.value = ticker.speed || 10;
  }
  // Say what the live feed actually holds. A scores ticker whose platform has no matches scrolls
  // nothing at all, and there was no way to tell that from an empty ticker on air.
  const feedEl = el('ticker-feed-status');
  if (feedEl && ticker.source === 'competition') {
    const cf = data.compFeed;
    feedEl.textContent = !cf
      ? 'No competition is live — pick one on Events > Competitions, or nothing will scroll.'
      : `${cf.name || 'League'}: ${cf.live.length} live, ${cf.upcoming.length} upcoming, ${cf.results.length} recent final${cf.results.length === 1 ? '' : 's'}.`;
    feedEl.style.color = cf ? '' : '#f59e0b';
  } else if (feedEl) {
    const plat = ticker.source === 'startgg' ? 'start.gg' : ticker.source === 'nxgen' ? 'NXGEN' : '';
    const feed = !plat ? [] : ((ticker.source === 'nxgen' ? data.nxgen?.matchFeed : data.startgg?.matchFeed) || []);
    const live = feed.filter((m) => m && m.status === 'live').length;
    const done = feed.length - live;
    feedEl.textContent = !plat ? ''
      : feed.length ? `${plat} feed: ${live} live, ${done} recent final${done === 1 ? '' : 's'}.`
      : `${plat} feed is empty — nothing will scroll. Link and activate an event on that platform, or switch to Manual messages.`;
    feedEl.style.color = (plat && !feed.length) ? '#f59e0b' : '';
  }
}

// ── Production: Bracket (Start.gg) ──────────────────────────────────────────
el('btn-load-event')?.addEventListener('click', () => {
  const slug = (el('input-bracket-slug')?.value || '').trim();
  if (!slug) { showToast('Paste a Start.gg tournament or event URL/slug first.', '#ef4444'); return; }
  // Robust resolver: accepts ANY start.gg sub-URL — /events, /details, /event/x, /event/x/brackets,
  // or a bare slug. Resolves the event (auto-activates a single-event tournament, or returns a
  // picker), then imports teams + players + bracket and starts live polling. Same path as Dashboard.
  send('load_startgg_url', { url: slug });
  const statusEl = el('bracket-status');
  if (statusEl) { statusEl.textContent = 'Resolving event from Start.gg (teams, players, bracket)…'; statusEl.style.color = 'var(--muted)'; }
});

el('btn-bracket-fetch')?.addEventListener('click', () => {
  const slug = (el('input-bracket-slug')?.value || '').trim();
  send('set_bracket_settings', { eventSlug: slug });
  send('fetch_bracket', { eventSlug: slug });
  const statusEl = el('bracket-status');
  if (statusEl) { statusEl.textContent = 'Refreshing bracket from Start.gg…'; statusEl.style.color = 'var(--muted)'; }
});

el('btn-bracket-save')?.addEventListener('click', () => {
  send('set_bracket_settings', { eventSlug: (el('input-bracket-slug')?.value || '').trim() });
});

// Bracket view chips → set the live view (the single browser source + the preview update in real time).
document.querySelectorAll('#bracket-views .bk-view-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    send('set_bracket_settings', { view: chip.dataset.view || 'both' });
    document.querySelectorAll('#bracket-views .bk-view-chip').forEach((c) => c.classList.toggle('is-active', c === chip));
  });
});
// Force every connected OBS browser source to reload (busts OBS's in-memory cache of overlay code).
el('bk-reload-obs')?.addEventListener('click', function () {
  send('reload_overlays');
  const o = this.textContent; this.textContent = '↻ Reloading…';
  setTimeout(() => { this.textContent = o; }, 1500);
});

el('check-bracket-visible')?.addEventListener('change', function() {
  send('set_bracket_settings', { visible: this.checked });
});

// Swiss qualify/eliminate thresholds (also the group board's cut line). 0 hands it back to the
// overlay's round-count default rather than pinning a wrong number on air.
['bk-swiss-advance', 'bk-swiss-eliminate'].forEach((id) => {
  el(id)?.addEventListener('change', function () {
    const n = Math.max(0, Math.min(12, parseInt(this.value, 10) || 0));
    this.value = n;
    send('set_bracket_settings', id === 'bk-swiss-advance' ? { swissAdvance: n } : { swissEliminate: n });
  });
});

// Swiss tier palette on/off (blue opening / green undefeated / amber mid / red elimination).
el('bk-swiss-colors')?.addEventListener('change', function () {
  send('set_bracket_settings', { swissColors: !!this.checked });
});

el('btn-push-match')?.addEventListener('click', () => {
  const setId = el('select-current-match')?.value;
  if (!setId) { showToast('Select a match first.', '#ef4444'); return; }
  send('select_match', { setId });
});

let _lastMatchSig = '';
function populateMatchPicker(matches) {
  const wrap = el('match-picker-wrap');
  const sel = el('select-current-match');
  if (!wrap || !sel) return;

  const list = Array.isArray(matches) ? matches : [];
  wrap.style.display = list.length ? 'block' : 'none';

  // Only rebuild when the match list changes (avoids resetting the dropdown)
  const sig = JSON.stringify(list);
  if (sig === _lastMatchSig) return;
  _lastMatchSig = sig;

  const current = sel.value;
  const stateLabel = { 2: '● LIVE', 1: '○', 3: '✓' };
  sel.innerHTML = '<option value="">— Select match —</option>';
  list.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    const flag = stateLabel[m.state] || '';
    opt.textContent = `${flag ? flag + ' ' : ''}${m.round}:  ${m.a}  vs  ${m.b}`;
    sel.appendChild(opt);
  });
  if (current && list.some((m) => m.id === current)) sel.value = current;
}

// ── Phase / pool selector + import-mode bar (Group/pool stages, multi-phase events) ──
function renderBracketPhasePool(bracket) {
  const wrap = el('bracket-phasepool'); if (!wrap) return;
  const phases = Array.isArray(bracket.phases) ? bracket.phases : [];
  const phaseRow = el('bracket-phase-row'), phaseChips = el('bracket-phase-chips');
  const poolRow = el('bracket-pool-row'), poolChips = el('bracket-pool-chips');
  if (phases.length > 1 && phaseChips) {
    phaseChips.innerHTML = phases.map((p) =>
      `<button type="button" class="bk-view-chip${p.id === bracket.activePhaseId ? ' is-active' : ''}" data-phaseid="${_stEsc(p.id)}">${_stEsc(p.name || 'Phase')}</button>`
    ).join('');
    if (phaseRow) phaseRow.style.display = 'flex';
  } else if (phaseRow) phaseRow.style.display = 'none';
  const activePhase = phases.find((p) => p.id === bracket.activePhaseId) || phases[0];
  const pools = (activePhase && Array.isArray(activePhase.pools)) ? activePhase.pools : [];
  if (pools.length > 1 && poolChips) {
    poolChips.innerHTML = pools.map((pl) =>
      `<button type="button" class="bk-view-chip${pl.id === bracket.activePoolId ? ' is-active' : ''}" data-poolid="${_stEsc(pl.id)}">${_stEsc(pl.name || 'Pool')}</button>`
    ).join('');
    if (poolRow) poolRow.style.display = 'flex';
  } else if (poolRow) poolRow.style.display = 'none';
  wrap.style.display = (phases.length > 1 || pools.length > 1) ? 'block' : 'none';
}

function renderBracketModeBar(bracket) {
  const bar = el('bracket-mode-bar'), lbl = el('bracket-mode-label'), editBtn = el('bracket-edit-as-custom');
  if (!bar || !lbl) return;
  const hasData = !!(bracket.lastFetchAt || (bracket.phases || []).length || (bracket.winners || []).length);
  if (!hasData) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  if (bracket.mode === 'imported') {
    const src = ({ startgg: 'start.gg', challonge: 'Challonge', nxgen: 'NXGEN', faceit: 'FACEIT' })[bracket.source] || 'a platform';
    lbl.innerHTML = `<strong style="color:#60a5fa;">Imported</strong> from ${src} — auto-refreshing scores. Builder edits are held back so the feed isn't overwritten.`;
    if (editBtn) editBtn.style.display = '';
  } else if (bracket.mode === 'manual') {
    lbl.innerHTML = `<strong style="color:#4ade80;">Custom bracket</strong> — hand-built here. No external source will overwrite it.`;
    if (editBtn) editBtn.style.display = 'none';
  } else {
    lbl.textContent = 'Bracket loaded.';
    if (editBtn) editBtn.style.display = 'none';
  }
}

// One-time wiring for the phase/pool chips + "Edit as custom" takeover.
let _bracketPPWired = false;
function wireBracketPhasePool() {
  if (_bracketPPWired) return; _bracketPPWired = true;
  el('bracket-phase-chips')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-phaseid]'); if (!b) return;
    send('bracket_select_phase', { phaseId: b.dataset.phaseid });
  });
  el('bracket-pool-chips')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-poolid]'); if (!b) return;
    send('bracket_select_pool', { poolId: b.dataset.poolid });
  });
  el('bracket-edit-as-custom')?.addEventListener('click', async () => {
    const bracket = (currentState && currentState.bracket) || {};
    if (!(await appConfirm('Copy this imported bracket into the custom builder? The live platform import will stop auto-updating this bracket.', 'Copy', false))) return;
    _bbHydrated = false;
    bbHydrate({ ...bracket, mode: 'manual' });   // bypass the imported-skip guard, load into the builder
    bbSendPhases();                               // persists as manual mode server-side
  });
}
wireBracketPhasePool();

// ── Bracket team search — panel + mini control center. Server finds the team across all
// phases/pools, auto-selects their bracket view and highlights their whole run on the
// overlay (startgg.focusTeam → bracket.html focus mode). The inputs autocomplete from the
// loaded bracket's teams with their logos, Match — Teams style, so no blind typing.
(function wireBracketTeamSearch() {
  // Every team in the loaded bracket, with a logo when one is known: bracket.teams carries
  // [{name, logo}] from imports; names found only in rosters/standings/sets fall back to the
  // saved-teams library logo (the same source the overlay itself uses), else an initial.
  function bktCandidates() {
    const b = (currentState && currentState.bracket) || {};
    const byName = new Map();
    (b.teams || []).forEach((t) => { if (t && t.name) byName.set(t.name.toLowerCase(), { name: t.name, logo: t.logo || null }); });
    const addName = (n) => { if (n && n !== 'TBD' && !byName.has(n.toLowerCase())) byName.set(n.toLowerCase(), { name: n, logo: null }); };
    (b.phases || []).forEach((ph) => {
      (ph.pools || []).forEach((pl) => {
        (pl.roster || []).forEach(addName);
        (pl.standings || []).forEach((r) => addName(r && r.name));
        (pl.schedule || []).forEach((round) => (round.sets || []).forEach((s) => { addName(s.a && s.a.name); addName(s.b && s.b.name); }));
      });
      [...(ph.winners || []), ...(ph.losers || []), ...(ph.finals || []), ...(ph.schedule || [])].forEach((round) => {
        (round.sets || []).forEach((s) => { addName(s.a && s.a.name); addName(s.b && s.b.name); });
      });
    });
    const saved = (currentState && currentState.savedTeams) || [];
    byName.forEach((t) => {
      if (!t.logo) {
        const hit = saved.find((s) => s && s.name && s.name.toLowerCase() === t.name.toLowerCase());
        if (hit && hit.logo) t.logo = hit.logo;
      }
    });
    return [...byName.values()].sort((a, z) => a.name.localeCompare(z.name));
  }

  let dd = null;
  function closeDd() { if (dd) { dd.remove(); dd = null; } }
  function openDd(inp) {
    const q = (inp.value || '').trim();
    // Ranked before the 8-item cap so the team being typed can't fall off the end.
    const list = NESearch.filter(bktCandidates(), q, (t) => [t.name], { limit: 8 }).slice(0, 8);
    closeDd();
    if (!list.length) return;
    dd = document.createElement('div');
    dd.className = 'bkt-find-dd';
    const r = inp.getBoundingClientRect();
    dd.style.cssText = `position:fixed; left:${r.left}px; top:${r.bottom + 4}px; width:${Math.max(r.width, 240)}px; z-index:5000;`;
    list.forEach((t) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'bkt-find-row';
      row.innerHTML = (t.logo
        ? `<img class="bkt-find-logo" src="${esc(t.logo)}" alt="">`
        : `<span class="bkt-find-logo bkt-find-initial">${esc((t.name[0] || '?').toUpperCase())}</span>`)
        + `<span class="bkt-find-name">${esc(t.name)}</span>`;
      // mousedown (not click) so it fires before the input's blur removes the dropdown
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        inp.value = t.name;
        closeDd();
        send('bracket_focus_team', { name: t.name });
      });
      dd.appendChild(row);
    });
    document.body.appendChild(dd);
  }

  const doFind = (inputId) => {
    const v = (el(inputId)?.value || '').trim();
    if (!v) { showToast('Type a team name to find.', '#fbbf24'); return; }
    send('bracket_focus_team', { name: v });
  };
  [['bracket-team-search', 'bracket-team-find', 'bracket-team-clear'],
   ['gfx-bkt-cc-search', 'gfx-bkt-cc-find', 'gfx-bkt-cc-clearfocus']].forEach(([inp, find, clear]) => {
    const i = el(inp);
    el(find)?.addEventListener('click', () => { closeDd(); doFind(inp); });
    if (i) {
      i.addEventListener('input', () => openDd(i));
      i.addEventListener('focus', () => openDd(i));
      i.addEventListener('blur', () => setTimeout(closeDd, 150));
      i.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { closeDd(); doFind(inp); }
        else if (e.key === 'Escape') closeDd();
      });
    }
    el(clear)?.addEventListener('click', () => { const x = el(inp); if (x) x.value = ''; closeDd(); send('bracket_focus_team', { name: '' }); });
  });
})();


// ── Bracket mini control center (Graphics hub front panel) ──────────────────
// Live status + clickable phase/pool/view chips right on the scene's front panel, so
// switching what's on the overlay never requires opening the Full Board. Sends the
// same WS messages as the full editor; renders from state on every broadcast.
const BKT_SRC_LABEL = { startgg: 'start.gg', challonge: 'Challonge', nxgen: 'NXGEN', faceit: 'FACEIT' };
// How stale the loaded bracket is. A producer needs to know at a glance whether the scores
// about to go on air are eight seconds or forty minutes old — "lastFetchAt" as a raw
// timestamp (or nothing at all) never told them.
function bktAgo(ts) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts || '');
  if (!t || isNaN(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm ago';
}
let _bktSourceFoldAuto = false;   // collapse the Source fold ONCE — never fight a producer who opened it
let _bktSrcTabSynced = false;     // light the source tab that matches the bracket actually loaded

// ── Connected-event bar (Graphics hub header) ───────────────────────────────
// The bracket panel used to be the only place that showed which event the graphics follow, so a
// producer on Standings or Schedule had no idea what was feeding them. One bar, every scene.
function gfxRenderEventBar(data) {
  const bar = el('gfx-eventbar'); if (!bar) return;
  const d = data || {};
  const ae = d.activeEvent || {};
  const b = d.bracket || {};
  const isManualBkt = b.mode === 'manual';
  // Which event are the graphics following? In order: an imported platform event, the league that
  // is LIVE on Events > Competitions (run here / Google Sheet / feed — activeEvent never sees these),
  // a hand-built bracket, and finally the Event Name typed on the Dashboard.
  const liveId = d.competition && d.competition.leagueId;
  const league = liveId ? (d.leagues || (typeof currentState !== 'undefined' && currentState && currentState.leagues) || []).find((l) => l && l.id === liveId) : null;
  let kind = '', name = '', platLabel = '';
  if (ae.name) { kind = 'platform'; name = ae.name; platLabel = BKT_SRC_LABEL[ae.platform] || ae.platform || 'Event'; }
  else if (league) { kind = 'league'; name = league.name || 'League'; platLabel = 'League'; }
  else if (isManualBkt) { kind = 'manual'; name = b.title || 'Custom bracket'; platLabel = 'Custom'; }
  else if (d.eventName) { kind = 'named'; name = d.eventName; }
  bar.classList.toggle('is-empty', !name);

  const plat = el('gfx-ev-plat');
  if (plat) { plat.textContent = platLabel; plat.hidden = !platLabel; plat.dataset.plat = kind === 'platform' ? (ae.platform || '') : kind; }
  const nm = el('gfx-ev-name'); if (nm) nm.textContent = name || 'No event connected';

  // Badges + meta describe the SAME thing the name does — bracket facts only when the bracket
  // belongs to that event, so a league never shows an unrelated double-elim import.
  const badges = [], meta = [];
  const bktIsOurs = kind === 'platform' || kind === 'manual' || (kind === 'league' && b.source === 'league');
  if (kind === 'platform') {
    const fmt = (ae.format || b.type || '').replace(/_/g, ' ').trim(); if (fmt) badges.push(fmt);
    if (ae.gameName) meta.push(ae.gameName);
    if (ae.numEntrants) meta.push(ae.numEntrants + ' entrants');
  } else if (kind === 'league') {
    // Same facts, same sources as the live-league card on Events (competitions.js), so the two
    // panels can never disagree: where the data comes from, how fresh, and the next match.
    const src = (league.source && league.source.type) || 'manual';
    badges.push((typeof CMP_SRC_LABEL !== 'undefined' && CMP_SRC_LABEL[src]) || (src === 'manual' ? 'Entered here' : src));
    if (league.season) badges.push(String(league.season));
    const teams = (league.teams || []).length; if (teams) meta.push(teams + ' teams');
    const sync = (d.compSync || {})[league.id];
    if ((src === 'sheet' || src === 'feed') && sync) {
      meta.push(sync.lastError ? 'sync failed' : sync.lastOkAt ? 'synced ' + (bktAgo(sync.lastOkAt) || 'just now') : 'syncing');
    }
    const next = d.compFeed && d.compFeed.next && d.compFeed.next.id ? d.compFeed.next : null;
    if (next) meta.push((next.status === 'live' ? 'Live: ' : 'Next: ') + next.teamA + ' vs ' + next.teamB);
  } else if (kind === 'manual') {
    const fmt = (b.type || '').replace(/_/g, ' ').trim(); if (fmt) badges.push(fmt);
  }
  if (bktIsOurs) {
    const phases = (b.phases || []).length;
    if (phases && kind !== 'league') meta.push(phases === 1 ? '1 stage' : phases + ' stages');
    const ago = bktAgo(b.lastFetchAt);
    if (ago && kind !== 'league') meta.push((isManualBkt ? 'edited ' : 'synced ') + ago);
  }
  const bEl = el('gfx-ev-badges');
  if (bEl) bEl.innerHTML = badges.map((t) => `<span class="gfx-ev-badge">${tlEsc(t)}</span>`).join('');
  const mEl = el('gfx-ev-meta');
  if (mEl) mEl.innerHTML = meta.map(tlEsc).join(' <span class="gfx-ev-sep">·</span> ');

  const open = el('gfx-ev-open');
  if (open) {
    const url = kind === 'platform' ? ae.url : '';
    open.hidden = !url && kind !== 'league';
    open.textContent = kind === 'league' ? 'Open league' : 'Event \u2197';
    if (url) { open.href = url; open.target = '_blank'; }
    else if (kind === 'league') { open.href = '#'; open.removeAttribute('target'); }
    open.dataset.league = kind === 'league' ? league.id : '';
  }
  const sync = el('gfx-ev-sync'); if (sync) sync.hidden = kind !== 'platform';
  const conn = el('gfx-ev-connect'); if (conn) conn.hidden = !!name;
}
// "Open league" jumps to that league on Events > Leagues instead of leaving the app.
el('gfx-ev-open')?.addEventListener('click', (e) => {
  const id = e.currentTarget.dataset.league; if (!id) return;
  e.preventDefault();
  document.querySelector('.tab-btn[data-tab="events"]')?.click();
  if (typeof cmpOpenLeague === 'function') cmpOpenLeague(id, 'overview');
});
el('gfx-ev-sync')?.addEventListener('click', () => { if (typeof window._bktReloadActiveEvent === 'function') window._bktReloadActiveEvent(); });
el('gfx-ev-connect')?.addEventListener('click', () => document.querySelector('.tab-btn[data-tab="principal"]')?.click());

function renderBracketCC(bracket) {
  const cc = el('gfx-bkt-cc'); if (!cc) return;
  const b = bracket || {};
  const phases = b.phases || [], pools = b.pools || [];
  const hasElim = (b.winners || []).length || (b.losers || []).length;
  const hasSched = (b.schedule || []).length, hasStand = (b.standings || []).length;
  const hasData = !!(b.lastFetchAt || phases.length || hasElim || hasSched || hasStand);
  const isManual = b.mode === 'manual';
  const ae = (typeof currentState !== 'undefined' && currentState && currentState.activeEvent) || {};
  const aeName = ae.name || ae.slug || '';
  const activePhase = phases.find((p) => p.id === b.activePhaseId) || phases[0] || null;

  // ── Status header — what is on air, from where, how big, how fresh.
  const st = el('gfx-bkt-cc-status');
  if (st) {
    st.hidden = false;
    if (!hasData) {
      st.className = 'bkp-status is-empty';
      st.innerHTML = 'No bracket loaded yet — open Source below to connect an event or build one.';
    } else {
      st.className = 'bkp-status';
      const typeLabel = ((activePhase && activePhase.type) || b.type || '').replace(/_/g, ' ').toLowerCase();
      const meta = [];
      meta.push(!phases.length ? 'no stages' : phases.length === 1 ? '1 stage' : phases.length + ' stages');
      if (pools.length > 1) {
        const i = pools.findIndex((p) => p.id === b.activePoolId);
        meta.push('pool ' + (i >= 0 ? i + 1 : 1) + ' of ' + pools.length);
      }
      // Freshness + "Sync now" live on the hub's event bar now (gfxRenderEventBar) — this panel
      // keeps only what is specific to the bracket itself.
      const stale = !isManual && b.lastFetchAt && (Date.now() - (typeof b.lastFetchAt === 'number' ? b.lastFetchAt : Date.parse(b.lastFetchAt))) > 180000;
      // The hub's event bar already names the connected event — repeat the title here only when it
      // says something different (a custom bracket, or a title the producer overrode).
      const evName = ((typeof currentState !== 'undefined' && currentState && currentState.activeEvent) || {}).name || '';
      const title = b.title || 'Bracket';
      const showTitle = isManual || !evName || title.trim().toLowerCase() !== evName.trim().toLowerCase();
      st.innerHTML =
        `<div class="bkp-st-text">
           <div class="bkp-st-main">
             ${showTitle ? `<span class="bkp-st-name">${tlEsc(title)}</span>` : ''}
             ${isManual ? '<span class="bkp-badge is-custom">Custom</span>' : ''}
             ${(isManual && typeLabel) ? `<span class="bkp-badge">${tlEsc(typeLabel)}</span>` : ''}
             ${stale ? '<span class="bkp-badge is-stale">stale</span>' : ''}
             ${b.visible ? '<span class="bkp-badge is-onair">On air</span>' : ''}
           </div>
           <div class="bkp-st-meta">${meta.map(tlEsc).join(' <span class="bkp-sep">·</span> ')}</div>
         </div>
         `;
      // Nothing left to say that the hub's event bar doesn't already show — drop the card.
      st.hidden = !showTitle && !isManual && !stale && !b.visible && meta.length <= 1;
    }
  }

  // ── Truth bar — rendered ONLY when the rest of the panel would otherwise mislead.
  const alertEl = el('gfx-bkt-alert');
  if (alertEl) {
    let html = '', bad = false;
    const reload = (label) => `<button type="button" class="btn btn-blue btn-xs" data-bktact="reload">${label}</button>`;
    if (b.lastError) {
      bad = true;
      html = `<span><strong>Last import failed:</strong> ${tlEsc(b.lastError)}</span>` + (aeName ? reload('Try again') : '');
    } else if (isManual && aeName) {
      // The Source panel says "Following: <event>" whenever an event is active. In manual mode
      // that is a lie — syncBracketToActiveEvent() skips manual brackets entirely, so scores
      // silently stop updating and the phase list stays whatever was hand-built.
      html = `<span><strong>Custom bracket is on this scene.</strong> ${tlEsc(aeName)} is linked but is <strong>not</strong> being followed — its stages and scores will not update.</span>`
           + reload('Load the event');
    } else if (!isManual && hasData && !phases.length) {
      html = `<span>This bracket has no stages — the connected event returned nothing to draw.</span>` + (aeName ? reload('Reload') : '');
    } else if (!hasData && aeName) {
      html = `<span><strong>${tlEsc(aeName)}</strong> is linked, but no bracket has been pulled from it yet.</span>` + reload('Load the bracket');
    }
    alertEl.className = 'bkp-alert' + (bad ? ' is-bad' : '');
    alertEl.style.display = html ? 'flex' : 'none';
    alertEl.innerHTML = html;
  }

  const chip = (label, active, attrs, sub) =>
    `<button type="button" class="bk-view-chip${active ? ' is-active' : ''}" ${attrs}>${tlEsc(label)}`
    + (sub ? `<span class="bkp-chip-sub">${tlEsc(sub)}</span>` : '') + '</button>';

  // Stage row shows from ONE phase up. A single chip still answers "which stage is this?" —
  // hiding it below two meant a hand-built swiss bracket and a five-stage major looked
  // identical in the panel, which is exactly how a wiped import goes unnoticed.
  const phRow = el('gfx-bkt-cc-phases'), phWrap = el('gfx-bkt-cc-phase-chips');
  if (phRow && phWrap) {
    phRow.style.display = phases.length ? 'flex' : 'none';
    phWrap.innerHTML = phases.map((p) => {
      const fmt = (p.type || '').replace(/_/g, ' ').toLowerCase();
      const np = (p.pools || []).length;
      const sub = [fmt, np > 1 ? np + ' pools' : ''].filter(Boolean).join(' · ');
      return chip(p.name || 'Phase', p.id === b.activePhaseId, `data-ccphase="${tlEsc(p.id)}"`, sub);
    }).join('');
  }
  const plRow = el('gfx-bkt-cc-pools'), plWrap = el('gfx-bkt-cc-pool-chips');
  if (plRow && plWrap) {
    plRow.style.display = pools.length > 1 ? 'flex' : 'none';
    // Major-scale phases (e.g. 30 swiss pools) get a dropdown instead of chip soup.
    if (pools.length > 10) {
      plWrap.innerHTML = `<select class="input-select" data-ccpoolsel style="font-size:12px; max-width:220px;">` +
        pools.map((p, i) => `<option value="${tlEsc(p.id)}"${p.id === b.activePoolId ? ' selected' : ''}>${tlEsc(p.name || 'Pool ' + (i + 1))}</option>`).join('') + '</select>'
        + `<span class="field-hint" style="margin:0;">${pools.length} pools in this stage</span>`;
    } else {
      plWrap.innerHTML = pools.map((p, i) => chip(p.name || 'Pool ' + (i + 1), p.id === b.activePoolId, `data-ccpool="${tlEsc(p.id)}"`)).join('');
    }
  }
  const vRow = el('gfx-bkt-cc-views'), vWrap = el('gfx-bkt-cc-view-chips');
  if (vRow && vWrap) {
    // Pool-play boards were missing entirely, so a Swiss phase offered exactly one chip
    // ("Schedule") and the swiss chart / group board / pairings card were unreachable from the
    // panel even though the overlay could draw them.
    const VIEWS = [
      ['both', 'Full', hasElim],
      ['winners', 'Upper', hasElim && (b.losers || []).length],
      ['losers', 'Lower', (b.losers || []).length],
      ['finals', 'Finals', hasElim],
      ['swiss', 'Swiss', hasSched && !hasElim],
      ['group', 'Group board', hasStand && !hasElim],
      ['schedule', 'Schedule', hasSched],
      ['pairings', 'Pairings', hasSched || hasElim],
      ['standings', 'Table', hasStand && !hasElim],
      ['matrix', 'Grid', !!b.matrix],
    ].filter(([, , show]) => show);
    vRow.style.display = hasData && VIEWS.length ? 'flex' : 'none';
    vWrap.innerHTML = VIEWS.map(([v, label]) => chip(label, (b.view || 'both') === v, `data-ccview="${v}"`)).join('');
  }

  // ── Fold summaries, so a producer never has to open a section to know what is in it.
  const dSum = el('gfx-bkt-display-sum');
  if (dSum) {
    const on = [];
    if (b.ignoreReset) on.push('GF reset hidden');
    if (b.hideLogos) on.push('logos off');
    else if (b.logoWatermark === false) on.push('no watermark');
    if (b.ignoreRounds > 0) on.push('first ' + b.ignoreRounds + ' round' + (b.ignoreRounds > 1 ? 's' : '') + ' hidden');
    dSum.textContent = on.length ? on.join(', ') : 'everything shown';
  }
  const sSum = el('gfx-bkt-source-sum');
  if (sSum) {
    sSum.textContent = !hasData ? 'choose where the bracket comes from'
      : isManual ? 'custom bracket, built in this app'
      : (BKT_SRC_LABEL[b.source] || 'imported') + (b.eventSlug ? ' — ' + b.eventSlug.split('/').pop() : '');
  }
  // Import fields are a setup task; once a bracket exists the live rows should own the panel.
  const sFold = el('gfx-bkt-source-fold');
  if (sFold && hasData && !_bktSourceFoldAuto) { _bktSourceFoldAuto = true; sFold.open = false; }
  // Light the source tab that matches what is ACTUALLY loaded, so the panel does not open on
  // "Tournament Organizer" while a custom bracket is the thing on air.
  if (hasData && !_bktSrcTabSynced && typeof window._bktSetSrc === 'function') {
    _bktSrcTabSynced = true;
    window._bktSetSrc(isManual ? 'manual' : 'organizer');
  }
}
;(function wireBracketCC() {
  const cc = el('gfx-bkt-cc'); if (!cc) return;
  cc.addEventListener('click', (e) => {
    const ph = e.target.closest('[data-ccphase]');
    if (ph) { send('bracket_select_phase', { phaseId: ph.dataset.ccphase }); return; }
    const pl = e.target.closest('[data-ccpool]');
    if (pl) { send('bracket_select_pool', { poolId: pl.dataset.ccpool }); return; }
    const v = e.target.closest('[data-ccview]');
    if (v) send('set_bracket_settings', { view: v.dataset.ccview });
  });
  cc.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-ccpoolsel]');
    if (sel) send('bracket_select_pool', { poolId: sel.value });
  });
  // Status header + truth bar both offer "pull the connected event again" — one delegated
  // handler on the whole front panel covers every button either of them renders.
  el('gfx-front-bracket')?.addEventListener('click', (e) => {
    if (!e.target.closest('[data-bktact="reload"]')) return;
    if (typeof window._bktReloadActiveEvent === 'function') window._bktReloadActiveEvent();
  });
})();

let _bracketAutoLoadDone = false;
function applyBracketState(data) {
  const bracket = data.bracket || {};
  renderBracketCC(bracket);   // mini control center on the Graphics front panel
  gfxRenderEventBar(data);    // connected-event bar in the Graphics hub header
  bbHydrate(bracket);   // restore a manual bracket into the builder once

  const slugEl = el('input-bracket-slug');
  if (slugEl && document.activeElement !== slugEl) {
    slugEl.value = bracket.eventSlug || data.startgg?.eventSlug || '';
  }

  // Auto-load bracket from the linked start.gg event on first state if there's no bracket yet.
  const linkedSlug = data.startgg?.eventSlug || '';
  const hasData = !!(bracket.lastFetchAt || (bracket.winners || []).length || (bracket.losers || []).length);
  if (!_bracketAutoLoadDone && linkedSlug && !hasData && !bracket.lastError) {
    _bracketAutoLoadDone = true;
    const statusEl = el('bracket-status');
    if (statusEl) { statusEl.textContent = 'Loading bracket from linked event…'; statusEl.style.color = 'var(--muted)'; }
    send('fetch_bracket', { eventSlug: linkedSlug });
  }

  const cbVisible = el('check-bracket-visible');
  if (cbVisible) cbVisible.checked = !!bracket.visible;

  // Front-card League source fields (title/subtitle/show-record) — only meaningful there, but
  // harmless to keep in sync regardless of which source tab is active.
  const bktTitleEl = el('gfx-bkt-title');
  if (bktTitleEl && document.activeElement !== bktTitleEl) bktTitleEl.value = bracket.title || '';
  const bktSubEl = el('gfx-bkt-subtitle');
  if (bktSubEl && document.activeElement !== bktSubEl) bktSubEl.value = bracket.subtitle || '';
  const bktRecEl = el('gfx-bkt-showrecord');
  if (bktRecEl && document.activeElement !== bktRecEl) bktRecEl.checked = bracket.showRecord !== false;
  const bktResEl = el('gfx-bkt-ignore-reset');
  if (bktResEl && document.activeElement !== bktResEl) bktResEl.checked = !!bracket.ignoreReset;
  const bktIgnEl = el('gfx-bkt-ignore-rounds');
  if (bktIgnEl && document.activeElement !== bktIgnEl) bktIgnEl.value = bracket.ignoreRounds || 0;
  const bktLogoEl = el('gfx-bkt-hide-logos');
  if (bktLogoEl && document.activeElement !== bktLogoEl) bktLogoEl.checked = !!bracket.hideLogos;
  const bktWmEl = el('gfx-bkt-logo-wm');
  if (bktWmEl && document.activeElement !== bktWmEl) bktWmEl.checked = bracket.logoWatermark !== false;
  const bktWmOp = el('gfx-bkt-wm-op');
  if (bktWmOp && document.activeElement !== bktWmOp) {
    const pct = Number.isFinite(bracket.watermarkOpacity) ? bracket.watermarkOpacity : 7;
    bktWmOp.value = pct;
    const v = el('gfx-bkt-wm-op-val'); if (v) v.textContent = pct + '%';
  }
  // The strength control is meaningless while the watermark itself is off.
  if (bktWmOp) bktWmOp.disabled = (bracket.logoWatermark === false) || !!bracket.hideLogos;

  // Reflect the active bracket view on the chips — and hide the chips whose view has no
  // data for this bracket (clicking Matrix on an elim bracket just blanks the overlay).
  const bview = bracket.view || 'both';
  const hasSchedule = !!(bracket.schedule && bracket.schedule.length);
  const hasMatrix = !!bracket.matrix;
  const hasLosers = !!(bracket.losers && bracket.losers.length);
  const hasStandings = !!(bracket.standings && bracket.standings.length);
  document.querySelectorAll('#bracket-views .bk-view-chip').forEach((c) => {
    const v = c.dataset.view || 'both';
    c.classList.toggle('is-active', v === bview);
    const show = v === 'schedule' ? hasSchedule
               : v === 'pairings' ? (hasSchedule || !!(bracket.winners && bracket.winners.length))
               : v === 'matrix'   ? hasMatrix
               : v === 'swiss'    ? hasSchedule
               : v === 'group'    ? hasStandings
               : (v === 'losers' || v === 'finals') ? hasLosers || v !== 'losers'
               : true;
    c.style.display = show ? '' : 'none';
  });
  // Thresholds only mean something for the two pool-play graphics.
  const swWrap = el('bracket-swiss-thresholds');
  if (swWrap) swWrap.style.display = (bview === 'swiss' || bview === 'group') ? 'flex' : 'none';
  const swColEl = el('bk-swiss-colors');
  if (swColEl && document.activeElement !== swColEl) swColEl.checked = bracket.swissColors !== false;
  const swAdvEl = el('bk-swiss-advance');
  if (swAdvEl && document.activeElement !== swAdvEl) swAdvEl.value = bracket.swissAdvance || 0;
  const swElimEl = el('bk-swiss-eliminate');
  if (swElimEl && document.activeElement !== swElimEl) swElimEl.value = bracket.swissEliminate || 0;

  renderBracketPhasePool(bracket);
  renderBracketModeBar(bracket);
  // Reflect the active team focus in the FIND inputs so it's visible + clearable. A Team-queue search
  // (or a FIND) sets startgg.focusTeam and zooms the bracket to that team; without this the FIND box
  // looked empty while the bracket stayed stuck on the team, with no obvious way to clear it.
  const _ft = (currentState.startgg && currentState.startgg.focusTeam) || '';
  ['bracket-team-search', 'gfx-bkt-cc-search'].forEach((id) => { const x = el(id); if (x && document.activeElement !== x && (x.value || '') !== _ft) x.value = _ft; });
  populateMatchPicker(bracket.matches);

  const statusEl = el('bracket-status');
  if (statusEl) {
    if (bracket.lastError) {
      statusEl.textContent = `Last error: ${bracket.lastError}`;
      statusEl.style.color = '#f56565';
    } else if (bracket.lastFetchAt) {
      const typeLabel = bracket.type ? bracket.type.replace(/_/g, ' ').toLowerCase() : 'bracket';
      const roundCount = (bracket.winners || []).length + (bracket.losers || []).length + (bracket.finals || []).length;
      const detail = (bracket.standings || []).length && !roundCount
        ? `${bracket.standings.length} team(s)`
        : `${roundCount} round(s)`;
      statusEl.textContent = `${bracket.title || 'Bracket'} (${typeLabel}) — ${detail}, updated ${new Date(bracket.lastFetchAt).toLocaleTimeString()}`;
      statusEl.style.color = '#9ae6b4';
    } else {
      statusEl.textContent = '';
    }
  }
}

// ─── Upcoming Matches overlay ─────────────────────────────────────────────────

let _upcomingMatches = [];

function renderUpcomingMatchList() {
  const list = el('upcoming-matches-list');
  const empty = el('upcoming-manual-empty');
  if (!list) return;
  list.innerHTML = '';
  if (_upcomingMatches.length === 0) {
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';
  _upcomingMatches.forEach((m, idx) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:8px;padding:8px 10px;flex-wrap:wrap;';
    row.innerHTML = `
      <input class="input-text up-in-round" data-idx="${idx}" placeholder="Round / Label" value="${m.round || ''}" style="width:160px;flex-shrink:0;">
      <input class="input-text up-in-a" data-idx="${idx}" placeholder="Team A" value="${m.teamA || ''}" style="width:180px;flex-shrink:0;">
      <span style="color:var(--muted);font-size:12px;">vs</span>
      <input class="input-text up-in-b" data-idx="${idx}" placeholder="Team B" value="${m.teamB || ''}" style="width:180px;flex-shrink:0;">
      <input class="input-text up-in-time" data-idx="${idx}" placeholder="Time (optional)" value="${m.scheduledTime || ''}" style="width:140px;flex-shrink:0;">
      <input class="input-text up-in-note" data-idx="${idx}" placeholder="Note (optional)" value="${m.note || ''}" style="width:150px;flex-shrink:0;">
      <button class="btn btn-danger btn-sm up-del" data-idx="${idx}" style="margin-left:auto;">✕</button>
    `;
    list.appendChild(row);
  });

  list.querySelectorAll('.up-in-round').forEach(inp => inp.addEventListener('input', e => { _upcomingMatches[+e.target.dataset.idx].round = e.target.value; }));
  list.querySelectorAll('.up-in-a').forEach(inp => inp.addEventListener('input', e => { _upcomingMatches[+e.target.dataset.idx].teamA = e.target.value; }));
  list.querySelectorAll('.up-in-b').forEach(inp => inp.addEventListener('input', e => { _upcomingMatches[+e.target.dataset.idx].teamB = e.target.value; }));
  list.querySelectorAll('.up-in-time').forEach(inp => inp.addEventListener('input', e => { _upcomingMatches[+e.target.dataset.idx].scheduledTime = e.target.value; }));
  list.querySelectorAll('.up-in-note').forEach(inp => inp.addEventListener('input', e => { _upcomingMatches[+e.target.dataset.idx].note = e.target.value; }));
  list.querySelectorAll('.up-del').forEach(btn => btn.addEventListener('click', e => {
    _upcomingMatches.splice(+e.target.dataset.idx, 1);
    renderUpcomingMatchList();
  }));
}

function applyUpcomingState(data) {
  const up = data.upcoming || {};
  const cb = el('check-upcoming-visible');
  if (cb && document.activeElement !== cb) cb.checked = !!up.visible;
  const titleEl = el('input-upcoming-title');
  if (titleEl && document.activeElement !== titleEl) titleEl.value = up.title || '';
  if (document.activeElement?.closest('#upcoming-matches-list') == null) {
    _upcomingMatches = Array.isArray(up.matches) ? up.matches.map(m => ({ ...m })) : [];
    renderUpcomingMatchList();
  }
}

el('check-upcoming-visible')?.addEventListener('change', function () {
  send('set_upcoming', { visible: this.checked });
});

el('btn-upcoming-add')?.addEventListener('click', () => {
  _upcomingMatches.push({ round: '', teamA: '', teamB: '', scheduledTime: '', note: '' });
  renderUpcomingMatchList();
  const empty = el('upcoming-manual-empty');
  if (empty) empty.style.display = 'none';
});

el('btn-upcoming-save')?.addEventListener('click', () => {
  const title = (el('input-upcoming-title')?.value || '').trim() || 'UPCOMING MATCHES';
  send('set_upcoming', { title, matches: _upcomingMatches });
  const st = el('upcoming-status');
  if (st) { st.textContent = 'Saved.'; st.style.color = '#9ae6b4'; setTimeout(() => { st.textContent = ''; }, 2500); }
});

// ─── Standings overlay ────────────────────────────────────────────────────────

let _standingsRows = [];

function renderStandingsRowList() {
  const list = el('standings-rows-list');
  const empty = el('standings-manual-empty');
  if (!list) return;
  list.innerHTML = '';
  if (_standingsRows.length === 0) {
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';
  _standingsRows.forEach((r, idx) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:8px;padding:8px 10px;flex-wrap:wrap;';
    row.innerHTML = `
      <input class="input-text st-in-rank" data-idx="${idx}" placeholder="#" value="${r.placement || idx + 1}" style="width:54px;flex-shrink:0;">
      <input class="input-text st-in-name" data-idx="${idx}" placeholder="Team name" value="${r.name || ''}" style="width:200px;flex-shrink:0;">
      <input class="input-text st-in-w" data-idx="${idx}" placeholder="W" value="${r.wins ?? ''}" style="width:54px;flex-shrink:0;">
      <input class="input-text st-in-l" data-idx="${idx}" placeholder="L" value="${r.losses ?? ''}" style="width:54px;flex-shrink:0;">
      <input class="input-text st-in-pts" data-idx="${idx}" placeholder="PTS" value="${r.points ?? ''}" style="width:70px;flex-shrink:0;">
      <button class="btn btn-danger btn-sm st-del" data-idx="${idx}" style="margin-left:auto;">✕</button>
    `;
    list.appendChild(row);
  });

  list.querySelectorAll('.st-in-rank').forEach(inp => inp.addEventListener('input', e => { _standingsRows[+e.target.dataset.idx].placement = e.target.value; }));
  list.querySelectorAll('.st-in-name').forEach(inp => inp.addEventListener('input', e => { _standingsRows[+e.target.dataset.idx].name = e.target.value; }));
  list.querySelectorAll('.st-in-w').forEach(inp => inp.addEventListener('input', e => { _standingsRows[+e.target.dataset.idx].wins = e.target.value === '' ? null : +e.target.value; }));
  list.querySelectorAll('.st-in-l').forEach(inp => inp.addEventListener('input', e => { _standingsRows[+e.target.dataset.idx].losses = e.target.value === '' ? null : +e.target.value; }));
  list.querySelectorAll('.st-in-pts').forEach(inp => inp.addEventListener('input', e => { _standingsRows[+e.target.dataset.idx].points = e.target.value === '' ? null : +e.target.value; }));
  list.querySelectorAll('.st-del').forEach(btn => btn.addEventListener('click', e => {
    _standingsRows.splice(+e.target.dataset.idx, 1);
    renderStandingsRowList();
  }));
}

function applyStandingsState(data) {
  const st = data.standings || {};
  const cb = el('check-standings-visible');
  if (cb && document.activeElement !== cb) cb.checked = !!st.visible;
  const titleEl = el('input-standings-title');
  if (titleEl && document.activeElement !== titleEl) titleEl.value = st.title || '';
  const subEl = el('input-standings-subtitle');
  if (subEl && document.activeElement !== subEl) subEl.value = st.subtitle || '';
  const recEl = el('check-standings-showrecord');
  if (recEl && document.activeElement !== recEl) recEl.checked = st.showRecord !== false;
  if (document.activeElement?.closest('#standings-rows-list') == null) {
    _standingsRows = Array.isArray(st.rows) ? st.rows.map(r => ({ ...r })) : [];
    renderStandingsRowList();
  }
  // Keep the league source dropdown in sync with available leagues
  if (typeof lgPopulateLeagueSelect === 'function') {
    lgPopulateLeagueSelect(el('standings-league-src'), (currentState && currentState.leagues) || [], { placeholder: null, emptyPlaceholder: 'No leagues yet' });
  }
}

function _stEsc(s) { return esc(s); }   // legacy alias — canonical esc() lives at the top of the file

// Build editable standings rows from the loaded start.gg event / bracket.
function standingsRowsFromBracket() {
  const src = (currentState && currentState.bracket && Array.isArray(currentState.bracket.standings)) ? currentState.bracket.standings : [];
  return src.map((r, i) => ({
    placement: Number(r.placement) || (i + 1),
    name: r.name || 'TBD',
    logo: r.logo || null,
    wins: r.wins ?? null,
    losses: r.losses ?? null,
    points: r.points ?? null
  }));
}

el('check-standings-visible')?.addEventListener('change', function () {
  send('set_standings', { visible: this.checked });
});

el('btn-standings-add')?.addEventListener('click', () => {
  _standingsRows.push({ placement: _standingsRows.length + 1, name: '', wins: null, losses: null, points: null });
  renderStandingsRowList();
  const empty = el('standings-manual-empty');
  if (empty) empty.style.display = 'none';
});

el('btn-standings-clear-manual')?.addEventListener('click', () => {
  _standingsRows = [];
  renderStandingsRowList();
});

el('check-standings-showrecord')?.addEventListener('change', function () {
  send('set_standings', { showRecord: this.checked });
});

el('btn-standings-load-bracket')?.addEventListener('click', () => {
  const rows = standingsRowsFromBracket();
  const st = el('standings-status');
  if (!rows.length) { if (st) { st.textContent = 'No start.gg / bracket standings loaded yet.'; st.style.color = '#f0a5a5'; } return; }
  _standingsRows = rows;
  renderStandingsRowList();
  const empty = el('standings-manual-empty'); if (empty) empty.style.display = 'none';
  if (st) { st.textContent = `Loaded ${rows.length} team(s) from start.gg / bracket — review, then Save.`; st.style.color = '#9ae6b4'; setTimeout(() => { st.textContent = ''; }, 4000); }
});

el('btn-standings-load-league')?.addEventListener('click', () => {
  const id = el('standings-league-src')?.value || '';
  const lg = ((currentState && currentState.leagues) || []).find(l => String(l.id) === String(id));
  const st = el('standings-status');
  if (!lg) { if (st) { st.textContent = 'Pick a league first.'; st.style.color = '#f0a5a5'; } return; }
  const rows = (typeof window.buildLeagueStandingsRows === 'function') ? (window.buildLeagueStandingsRows(lg.id) || []) : [];
  if (!rows.length) { if (st) { st.textContent = 'That league has no teams / standings yet.'; st.style.color = '#f0a5a5'; } return; }
  _standingsRows = rows;
  renderStandingsRowList();
  const empty = el('standings-manual-empty'); if (empty) empty.style.display = 'none';
  const titleEl = el('input-standings-title');
  if (titleEl && !titleEl.value.trim()) titleEl.value = [lg.name, lg.season].filter(Boolean).join(' — ');
  if (st) { st.textContent = `Loaded ${rows.length} team(s) from ${lg.name || 'league'} — review, then Save.`; st.style.color = '#9ae6b4'; setTimeout(() => { st.textContent = ''; }, 4000); }
});

el('btn-standings-save')?.addEventListener('click', () => {
  const title = (el('input-standings-title')?.value || '').trim();
  const subtitle = (el('input-standings-subtitle')?.value || '').trim();
  const showRecord = el('check-standings-showrecord') ? el('check-standings-showrecord').checked : true;
  send('set_standings', { title, subtitle, showRecord, rows: _standingsRows });
  const st = el('standings-status');
  if (st) { st.textContent = 'Saved.'; st.style.color = '#9ae6b4'; setTimeout(() => { st.textContent = ''; }, 2500); }
});

// ─── End of upcoming / standings controls ─────────────────────────────────────

function applyProductionState(data) {
  // Casters: only rebuild the editing buffer if the user isn't mid-edit on these rows
  const castersWrap = el('casters-rows');
  const editingCasters = castersWrap && castersWrap.contains(document.activeElement);
  // If dashboard is slimmed, old full caster rows may be absent — skip full rebuilds here (focused uses new dashboard module)
  if (!editingCasters) {
    castersDraft = (data.casters?.list || []).map((c, idx) => ({
      id: c.id || makeCasterId(),
      name: c.name || '',
      handle: c.handle || '',
      camUrl: c.camUrl || '',
      slot: Number(c.slot) >= 1 && Number(c.slot) <= 4 ? Number(c.slot) : idx + 1,
      social: c.social || 'none'
    }));
    if (castersDraft.length === 0 && !_castersInited) {
      castersDraft = [{ id: makeCasterId(), name: '', handle: '', camUrl: '', slot: 1, social: 'none' }];
    }
    renderCasterRows();
  }
  renderCasterLibrary(data.casters?.library);
  _castersInited = true;

  const ltInp = el('input-caster-lower-third');
  if (ltInp && document.activeElement !== ltInp) {
    castersLowerThirdDraft = data.casters?.lowerThird || '';
    ltInp.value = castersLowerThirdDraft;
  }

  const cbCasters = el('check-casters-visible');
  if (cbCasters) cbCasters.checked = !!data.casters?.visible;

  // Keep the Director mixer in sync with audio/roster changes while it's running.
  if (_directorOn && typeof cfRenderMixer === 'function') cfRenderMixer();
  if (typeof cfUpdateMoveButtons === 'function') cfUpdateMoveButtons();   // reflect interviewee/on-air state live

  // Break
  const brk = data.breakScreen || {};
  const presetSel = el('select-break-preset');
  const titleInput = el('input-break-title');
  const msgInput = el('input-break-message');
  if (presetSel && document.activeElement !== presetSel &&
      titleInput && document.activeElement !== titleInput) {
    const presets = Array.from(presetSel.options).map(o => o.value);
    if (brk.title === '') {
      // Explicit blank title → "No title (timer only)".
      presetSel.value = '__none__';
      el('break-custom-title-row').style.display = 'none';
    } else if (brk.title && presets.includes(brk.title)) {
      presetSel.value = brk.title;
      el('break-custom-title-row').style.display = 'none';
    } else if (brk.title) {
      presetSel.value = '__custom__';
      el('break-custom-title-row').style.display = '';
      titleInput.value = brk.title;
    }
  }
  if (msgInput && document.activeElement !== msgInput) {
    msgInput.value = brk.message || '';
  }
  // Populate the "after countdown" scene pickers (Production panel + rail trigger + topbar timer) from OBS scenes.
  const _obsScenes = (data.obs && Array.isArray(data.obs.availableScenes)) ? data.obs.availableScenes : [];
  fillSceneSelect(el('select-break-thenscene'), _obsScenes, brk.thenScene || '', '— Stay on break screen —');
  fillSceneSelect(el('ck-break-thenscene'), _obsScenes, brk.thenScene || '', 'After: stay');
  // The row is labelled "When it ends" now, so the option only has to name the outcome.
  fillSceneSelect(el('ptp-break-thenscene'), _obsScenes, brk.thenScene || '', 'Stay on break');
  // NOTE: the topbar timer's title <select> is intentionally NOT synced from global break state —
  // it defaults to "No title (timer only)" and only changes the title when the producer picks one.

  const statusEl = el('break-status');
  if (statusEl) {
    if (brk.visible) {
      let txt = `● LIVE — "${brk.title || ''}"`;
      if (brk.endsAt) {
        const remaining = Math.max(0, Math.round((brk.endsAt - Date.now()) / 1000));
        txt += ` · countdown ~${Math.ceil(remaining / 60)} min`;
      }
      statusEl.textContent = txt;
      statusEl.style.color = '#f56565';
    } else {
      statusEl.textContent = 'Break is hidden.';
      statusEl.style.color = 'var(--muted)';
    }
  }
  // Reconcile the producer timer widget (topbar/sidebar) from server state. It's normally a
  // self-contained local counter (_timer) that this widget's own Start/±/reset controls drive —
  // but a Flow's "Start countdown timer" action (or any other client) sets state.breakScreen
  // directly on the server, which this widget otherwise never learns about, so it looked frozen
  // even though the real overlay (which reads breakScreen.endsAt independently) was counting down fine.
  // Keyed on whether a timer is ARMED, not on whether the break graphic is on air. The top-bar
  // Start (and "count down to HH:MM") arms a clock without setting .visible, and the old
  // `!brk.visible` branch below then tore the widget's own mirror down on the very next broadcast.
  const _to = el('ptp-title-only');
  if (_to && document.activeElement !== _to) _to.checked = !!brk.titleOnly;
  if (!_timerEditing && (Date.now() - _timerLocalAt) > TIMER_LOCAL_MS) {
    if (brk.endsAt) {
      // Mirror the server's wall-clock target so the widget derives its remaining exactly like the
      // overlay (throttle-proof) instead of drifting on a local counter.
      _timer.endsAt = brk.endsAt;
      const remaining = Math.max(0, Math.round((brk.endsAt - Date.now()) / 1000));
      _timer.secs = remaining;
      _timer.base = remaining;
      if (!_timer.running) { _timer.running = true; if (!_timer.handle) _timer.handle = setInterval(tickTimer, 1000); }
      paintTimer();
    } else if (brk.frozenSeconds != null && (_timer.secs !== brk.frozenSeconds || _timer.endsAt)) {
      _timer.endsAt = null;                     // paused/frozen → no live target
      _timer.secs = brk.frozenSeconds;
      _timer.base = brk.frozenSeconds;
      if (_timer.running) { _timer.running = false; if (_timer.handle) { clearInterval(_timer.handle); _timer.handle = null; } }
      paintTimer();
    } else if (_timer.endsAt) {
      // The countdown was cleared (Hide disarms it server-side, or a flow cleared it, or it ran
      // out) → stop mirroring a target that no longer exists.
      _timer.endsAt = null;
      _timer.running = false; if (_timer.handle) { clearInterval(_timer.handle); _timer.handle = null; }
      paintTimer();
    }
  }
  // The ON AIR chip follows breakScreen.visible, which only changes on a broadcast — the widget's
  // 1s tick would never pick it up while the clock is paused, and none of the branches above run
  // when the timer state itself is unchanged.
  paintTimerStatus();

  // Intro panel — sync form fields from state (never override while user is editing)
  const _intr = data.intro || {};
  const intrSide = el('select-intro-side');
  if (intrSide && document.activeElement !== intrSide) intrSide.value = _intr.side || 'blue';
  const intrTitle = el('input-intro-title');
  if (intrTitle && document.activeElement !== intrTitle) intrTitle.value = _intr.title || '';
  const intrFoot = el('check-intro-footer');
  if (intrFoot) intrFoot.checked = !!_intr.showFooter;
  const intrRealName = el('check-intro-realname');
  if (intrRealName) intrRealName.checked = !!_intr.showRealName;
  // Same flag, mirrored into the Matchup panel so the producer can reach it from the graphic
  // they're actually setting up (Line-up, Bracket and Matchup all read intro.showRealName).
  const muRealName = el('check-matchup-realname');
  if (muRealName) muRealName.checked = !!_intr.showRealName;
}

// ── Game & overlay design ───────────────────────────────────────────────────
let _lastGamesSig = '';

function fillGameSelect(sel, games) {
  if (!sel) return;
  sel.innerHTML = '';
  Object.values(games).forEach((g) => {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.name + (g.comingSoon ? ' (preview)' : '');
    sel.appendChild(opt);
  });
}

// Header game picker is a custom dropdown (native <select> can't show logos).
function gameLogoSrc(g) { return g && g.logo ? `../assets/${g.logo}` : '../assets/rl.png'; }
// The menu pins the most recently used games on top ("Recent") and has a name search, so switching
// between the handful of games a producer actually runs never means scrolling the whole registry.
const GAME_DD_RECENT_KEY = 'ne_recent_games_v1';
const GAME_DD_RECENT_MAX = 5;
let _gameDDGames = {}, _gameDDActive = '', _gameDDSig = '';
function gameDDRecent() {
  try { const v = JSON.parse(localStorage.getItem(GAME_DD_RECENT_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
// Recorded whenever the active game changes, whatever switched it (header, dashboard grid, Stream Deck).
function gameDDRemember(id) {
  if (!id) return;
  const list = [id, ...gameDDRecent().filter((x) => x !== id)].slice(0, GAME_DD_RECENT_MAX);
  try { localStorage.setItem(GAME_DD_RECENT_KEY, JSON.stringify(list)); } catch {}
}
const _gameDDNorm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
function renderGameHeaderDD(games, activeId) {
  const trig = el('game-dd-trigger'), menu = el('game-dd-menu');
  if (!trig || !menu) return;
  const active = games[activeId];
  const tLogo = el('game-dd-logo'), tName = el('game-dd-name');
  if (tLogo) tLogo.src = gameLogoSrc(active);
  if (tName) tName.textContent = active ? (active.name + (active.comingSoon ? ' (preview)' : '')) : '—';
  if (active && activeId !== _gameDDActive) gameDDRemember(activeId);
  _gameDDGames = games; _gameDDActive = activeId;
  const sig = JSON.stringify([Object.keys(games), activeId]);   // rebuild list only when it changes
  if (_gameDDSig === sig) return;
  _gameDDSig = sig;
  renderGameDDList();
}
function renderGameDDList() {
  const list = el('game-dd-list');
  if (!list) return;
  const games = _gameDDGames, activeId = _gameDDActive;
  const q = _gameDDNorm(el('game-dd-search')?.value);
  list.innerHTML = '';
  const addGroup = (label) => {
    const h = document.createElement('div');
    h.className = 'game-dd-group';
    h.textContent = label;
    list.appendChild(h);
  };
  const addItem = (g) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'game-dd-item' + (g.id === activeId ? ' active' : '');
    item.dataset.gameId = g.id;
    item.setAttribute('role', 'option');
    item.innerHTML = `<img class="game-dd-logo" src="${gameLogoSrc(g)}" alt=""><span>${g.name}${g.comingSoon ? ' (preview)' : ''}</span>`;
    item.addEventListener('click', () => pickGameDD(g.id));
    list.appendChild(item);
  };
  const all = Object.values(games).sort((a, b) => a.name.localeCompare(b.name));
  if (q) {
    const hits = all.filter((g) => _gameDDNorm(g.name).includes(q) || _gameDDNorm(g.id).includes(q));
    hits.forEach(addItem);
    if (!hits.length) {
      const empty = document.createElement('div');
      empty.className = 'game-dd-empty';
      empty.textContent = 'No games match.';
      list.appendChild(empty);
    }
  } else {
    const recent = gameDDRecent().map((id) => games[id]).filter(Boolean);
    if (recent.length) { addGroup('Recent'); recent.forEach(addItem); addGroup('All games'); }
    all.forEach(addItem);
  }
  gameDDHighlight(0);
}
function gameDDHighlight(idx) {
  const items = [...(el('game-dd-list')?.querySelectorAll('.game-dd-item') || [])];
  items.forEach((it) => it.classList.remove('kb'));
  if (!items.length) return null;
  const i = Math.max(0, Math.min(items.length - 1, idx));
  items[i].classList.add('kb');
  items[i].scrollIntoView({ block: 'nearest' });
  return items[i];
}
function pickGameDD(id) {
  closeGameHeaderDD();
  if (id && id !== currentState.activeGame) onGameSelectChange(id);
}
function openGameHeaderDD() {
  const m = el('game-dd-menu'); if (!m) return;
  m.hidden = false;
  el('game-dd-trigger')?.setAttribute('aria-expanded', 'true');
  el('game-header-dd')?.classList.add('open');
  const s = el('game-dd-search');
  if (s) s.value = '';
  renderGameDDList();
  // The first item is the highlight target; with no query that's the most recent game (the active one),
  // so start on the next item — the usual reason to open the menu is to go back to the previous game.
  const items = el('game-dd-list')?.querySelectorAll('.game-dd-item') || [];
  if (items.length > 1 && items[0].dataset.gameId === _gameDDActive) gameDDHighlight(1);
  s?.focus();
}
function closeGameHeaderDD() { const m = el('game-dd-menu'); if (!m) return; m.hidden = true; el('game-dd-trigger')?.setAttribute('aria-expanded', 'false'); el('game-header-dd')?.classList.remove('open'); }
el('game-dd-trigger')?.addEventListener('click', (e) => { e.stopPropagation(); const m = el('game-dd-menu'); if (m && m.hidden) openGameHeaderDD(); else closeGameHeaderDD(); });
el('game-dd-search')?.addEventListener('input', () => renderGameDDList());
el('game-dd-search')?.addEventListener('keydown', (e) => {
  const items = [...(el('game-dd-list')?.querySelectorAll('.game-dd-item') || [])];
  const cur = items.findIndex((it) => it.classList.contains('kb'));
  if (e.key === 'ArrowDown') { e.preventDefault(); gameDDHighlight(cur + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); gameDDHighlight(cur - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); const it = items[cur] || items[0]; if (it) pickGameDD(it.dataset.gameId); }
});
document.addEventListener('click', (e) => { if (!el('game-header-dd')?.contains(e.target)) closeGameHeaderDD(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeGameHeaderDD(); });

function fillDesignSelect(sel, designs, themeId) {
  if (!sel) return;
  sel.innerHTML = '';
  designs.forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    sel.appendChild(opt);
  });
  if (document.activeElement !== sel) sel.value = themeId || 'default';
}

function renderGameSwitcher(data) {
  const grid = el('game-switcher-grid');
  if (!grid) return;
  const games = data.games || {};
  const sig = JSON.stringify([Object.keys(games), data.activeGame]);
  if (grid.dataset.sig === sig) {
    grid.querySelectorAll('.game-card').forEach((c) => {
      c.classList.toggle('active', c.dataset.gameId === data.activeGame);
    });
    return;
  }
  grid.dataset.sig = sig;
  grid.innerHTML = '';
  Object.values(games).forEach((g) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'game-card' + (g.id === data.activeGame ? ' active' : '');
    card.dataset.gameId = g.id;
    card.title = g.name;                       // name lives in the tooltip — logos only on the card
    const logo = g.logo ? `../assets/${g.logo}` : '../assets/rl.png';
    card.innerHTML = `<img src="${logo}" alt="${g.name}">`;
    card.addEventListener('click', () => {
      if (g.id !== currentState.activeGame) send('set_active_game', { game: g.id });
    });
    grid.appendChild(card);
  });

  const active = games[data.activeGame];
  const feedNote = el('dash-game-feed-note');
  if (feedNote) {
    const layout = data.overlayLayout;
    const layoutName = layout && layout.name ? layout.name : '';
    const path = data.activeOverlay != null ? data.activeOverlay : '';
    const feats = (active && active.features) || [];
    const parts = [];
    if (layoutName) parts.push('HUD: ' + layoutName);
    if (path) parts.push('http://localhost:3000' + (path === '/' ? '' : path));
    if (feats.includes('stats-api')) parts.push('RL Stats API :49123');
    if (feats.includes('gsi')) parts.push('CS2 GSI');
    if (feats.includes('director')) parts.push('AI Director');
    feedNote.textContent = parts.join(' · ');
  }
  const dashLink = el('dash-overlay-link');
  if (dashLink) {
    const path = data.activeOverlay != null ? data.activeOverlay : (active && active.overlay) || '/';
    dashLink.href = 'http://localhost:3000' + (path === '/' ? '' : path);
  }
}

function applyGameDesignState(data) {
  const games = data.games || {};
  const gameSel = el('select-game');
  const designSel = el('select-design');
  const gameHeader = el('select-game-header');
  const designHeader = el('select-design-header');
  const gameDash = el('select-game-dashboard');
  const designDash = el('select-design-dashboard');
  const designMatch = el('select-design-match');   // Match — Teams gear (RL strip)

  const sig = JSON.stringify(Object.keys(games));
  if (sig !== _lastGamesSig) {
    _lastGamesSig = sig;
    [gameSel, gameHeader, gameDash].forEach((s) => fillGameSelect(s, games));
  }

  const activeId = data.activeGame || 'rocket-league';
  [gameSel, gameHeader, gameDash].forEach((s) => {
    if (s && document.activeElement !== s) s.value = activeId;
  });

  renderGameHeaderDD(games, activeId);

  const active = games[activeId];
  const designs = (active && active.themes) || [];
  const theme = data.theme || 'default';
  const designKey = JSON.stringify([activeId, designs.map((t) => t.id), theme]);

  [designSel, designHeader, designDash, designMatch].forEach((s) => {
    if (!s) return;
    if (s.dataset.key !== designKey) {
      s.dataset.key = designKey;
      fillDesignSelect(s, designs, theme);
    } else if (document.activeElement !== s) {
      s.value = theme;
    }
  });

  const note = el('game-overlay-note');
  if (note) {
    const layout = data.overlayLayout;
    const path = data.activeOverlay != null ? data.activeOverlay : (layout && layout.path) || (active && active.overlay) || '';
    if (path) {
      note.textContent = `OBS browser source: http://localhost:3000${path === '/' ? '' : path}` +
        (layout && layout.name ? ` (${layout.name})` : '');
    } else {
      note.textContent = 'No dedicated in-game HUD yet — use Production browser sources (countdown, casters, bracket).';
    }
  }

  const rlLinks = el('rl-layouts');
  if (rlLinks) rlLinks.style.display = activeId === 'rocket-league' ? '' : 'none';

  renderGameSwitcher(data);
}

function onGameSelectChange(gameId) {
  send('set_active_game', { game: gameId });
  ['select-game', 'select-game-header', 'select-game-dashboard'].forEach((id) => {
    const s = el(id);
    if (s && s.value !== gameId) s.value = gameId;
  });
}

function onDesignSelectChange(themeId) {
  send('set_theme', { theme: themeId });
  ['select-design', 'select-design-header', 'select-design-dashboard', 'select-design-match'].forEach((id) => {
    const s = el(id);
    if (s && s.value !== themeId) s.value = themeId;
  });
}

['select-game', 'select-game-header', 'select-game-dashboard'].forEach((id) => {
  el(id)?.addEventListener('change', function() { onGameSelectChange(this.value); });
});
['select-design', 'select-design-header', 'select-design-dashboard', 'select-design-match'].forEach((id) => {
  el(id)?.addEventListener('change', function() { onDesignSelectChange(this.value); });
});

// ── Custom overlay URL manager ──────────────────────────────────────────────
let _customOlGamesFilled = false;
function renderCustomOverlayManager(data) {
  const games = data.games || {};

  // Populate the game selector once
  const gameSel = el('custom-ol-game');
  if (gameSel && !_customOlGamesFilled) {
    _customOlGamesFilled = true;
    Object.values(games).sort((a, b) => a.name.localeCompare(b.name)).forEach((g) => {
      const o = document.createElement('option');
      o.value = g.id; o.textContent = g.name;
      gameSel.appendChild(o);
    });
  }

  const list = el('custom-overlays-list');
  const empty = el('custom-overlays-empty');
  if (!list) return;

  const customLayouts = data.customOverlayLayouts || {};
  const items = [];
  Object.keys(customLayouts).forEach((gameId) => {
    (customLayouts[gameId] || []).forEach((ol) => {
      items.push({ ...ol, gameId, gameName: (games[gameId] || {}).name || gameId });
    });
  });

  const sig = items.map((i) => i.id + '|' + i.name + '|' + i.path).join('~');
  if (list.dataset.cosig === sig) return;
  list.dataset.cosig = sig;
  list.querySelectorAll('.custom-ol-item').forEach((i) => i.remove());
  if (empty) empty.style.display = items.length ? 'none' : '';

  items.forEach((ol) => {
    const item = document.createElement('div');
    item.className = 'custom-ol-item preset-item';

    const label = document.createElement('div');
    label.className = 'preset-name';
    label.textContent = `${ol.gameName} — ${ol.name}`;
    const sub = document.createElement('span');
    sub.style.cssText = 'font-size:11px;color:var(--muted);display:block;margin-top:2px;';
    sub.textContent = ol.path;
    label.appendChild(sub);

    const actions = document.createElement('div');
    actions.className = 'preset-actions';

    const renBtn = document.createElement('button');
    renBtn.className = 'btn btn-secondary btn-sm';
    renBtn.textContent = 'Rename';
    renBtn.addEventListener('click', () => {
      const n = window.prompt('New name for this overlay:', ol.name);
      if (n && n.trim()) send('manage_custom_overlay', { action: 'rename', gameId: ol.gameId, overlayId: ol.id, name: n.trim() });
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger btn-sm';
    delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    delBtn.title = 'Remove overlay';
    delBtn.addEventListener('click', async () => {
      const ok = await customConfirm('Remove Overlay', `Remove "${ol.name}" (${ol.gameName})?`, 'Remove');
      if (ok) send('manage_custom_overlay', { action: 'remove', gameId: ol.gameId, overlayId: ol.id });
    });

    actions.append(renBtn, delBtn);
    item.append(label, actions);
    list.appendChild(item);
  });
}

el('btn-custom-ol-add')?.addEventListener('click', () => {
  const gameId = el('custom-ol-game')?.value?.trim();
  const name   = el('custom-ol-name')?.value?.trim();
  const path   = el('custom-ol-path')?.value?.trim();
  if (!gameId || !name || !path) return;
  send('manage_custom_overlay', { action: 'add', gameId, name, path });
  el('custom-ol-name').value = '';
  el('custom-ol-path').value = '';
});

// ── Config presets ──────────────────────────────────────────────────────────
function renderPresets(presets) {
  const list = el('presets-list');
  const empty = el('presets-empty');
  if (!list) return;
  const arr = presets || [];
  const sig = arr.map((p) => p.id + '|' + p.name + '|' + (p.game || '')).join('~');
  if (list.dataset.psig === sig) return;   // unchanged → skip rebuild
  list.dataset.psig = sig;
  list.querySelectorAll('.preset-item').forEach((i) => i.remove());
  if (empty) empty.style.display = arr.length ? 'none' : '';

  arr.forEach((p) => {
    const item = document.createElement('div');
    item.className = 'preset-item';

    const label = document.createElement('div');
    label.className = 'preset-name';
    label.textContent = p.name + (p.game ? `  ·  ${p.game.replace('-', ' ')}` : '');

    const actions = document.createElement('div');
    actions.className = 'preset-actions';

    const loadBtn = document.createElement('button');
    loadBtn.className = 'btn btn-primary btn-sm';
    loadBtn.textContent = 'Load';
    loadBtn.addEventListener('click', async () => {
      // Loading replaces the current show set-up; a mis-click mid-show used to wipe it silently.
      if (!await customConfirm('Load preset', `Load "${p.name}"? It replaces the current game, overlay layout, event name, best-of, banner, ticker and casters.`, 'Load')) return;
      send('load_preset', { id: p.id });
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger btn-sm';
    delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    delBtn.title = 'Delete preset';
    delBtn.addEventListener('click', async () => {
      const ok = await customConfirm('Delete Preset', `Delete preset "${p.name}"?`, 'Delete');
      if (ok) send('delete_preset', { id: p.id });
    });

    actions.appendChild(loadBtn);
    actions.appendChild(delBtn);
    item.appendChild(label);
    item.appendChild(actions);
    list.appendChild(item);
  });
}

el('btn-save-preset')?.addEventListener('click', () => {
  const name = (el('input-preset-name')?.value || '').trim();
  if (!name) { showToast('Enter a preset name.', '#ef4444'); return; }
  send('save_preset', { name });
  el('input-preset-name').value = '';
});
