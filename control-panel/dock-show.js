/* ─── dock-show.js — the Live dock's "Show" tab ──────────────────────────────────────────────
   What is coming and what is captured, in place of the separate On air / Up next / Replay tabs:
     Up next       the stream queue's next matches; Load puts them on the scoreboard
     Run of show   now / next with Start, Back, Next, Stop
     Replay        buffer on/off, Capture, Stop / Return, the latest clips with To Air
     Stream        title (the category stays as set in Chat > Channel)
   The replay and stream parts press the real controls in the hidden Replay / Chat panes, so every
   rule those follow (replay scene, transition, return scene, Twitch auth) still applies. Loads after
   app.js; app.js calls window._dockShowRender() on every state update and when the tab opens. */
(function () {
  const root = () => document.getElementById('dock-show');
  const S = () => (typeof currentState !== 'undefined' && currentState) || {};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const txt = (id) => { const e = $(id); return e ? e.textContent.trim() : ''; };
  const shown = (e) => !!e && e.style.display !== 'none';
  let sig = '';

  function streamFilter() { return ($('sgg-stream') || {}).value || ''; }
  function queueRows(s) {
    const sg = s.startgg || {};
    const want = streamFilter();
    return (Array.isArray(sg.queue) ? sg.queue : []).filter((m) => m && (!want || m.stream === want)).slice(0, 4);
  }
  function rundown() {
    try { return typeof rdSummary === 'function' ? rdSummary() : { hasSegs: false }; } catch (e) { return { hasSegs: false }; }
  }
  function replayView() {
    const tog = $('qr-buffer-toggle'), cap = $('qr-save-replay'), stop = $('qr-replay-stop');
    return {
      pill: txt('qr-buffer-pill') || 'Buffer off',
      toggle: tog ? tog.textContent.trim() : 'Start buffer', toggleOff: !tog || tog.disabled,
      capOff: !cap || cap.disabled, stopOff: !stop || stop.disabled, stopShown: !stop || shown(stop),
      status: txt('qr-replay-status'),
      clips: Array.from(document.querySelectorAll('#qr-clip-list .qr-clip-row')).slice(0, 4).map((r) => ({
        name: ((r.querySelector('.qr-clip-name') || {}).textContent || 'Clip').trim(),
        dur: ((r.querySelector('.qr-clip-dur') || {}).textContent || '').trim(),
      })),
    };
  }
  function streamView() {
    const pill = $('flows-live-pill');
    return { live: shown(pill) ? pill.textContent.trim() : '', viewers: txt('flows-viewer-count'), game: ($('flows-game-search') || {}).value || '' };
  }

  function matchRow(m, i, pushed) {
    const onAir = m.setId === pushed;
    const badge = m.live ? 'Live' : (m.state === 3 ? 'Finished' : (i === 0 ? 'Next' : 'Later'));
    const score = (m.scoreA != null || m.scoreB != null)
      ? `<span class="dks-score">${esc(m.scoreA == null ? 0 : m.scoreA)} - ${esc(m.scoreB == null ? 0 : m.scoreB)}</span>` : '';
    return `<div class="dks-match${onAir ? ' is-onair' : ''}">
        <div class="dks-match-main">
          <div class="dks-match-top"><span class="dks-badge${m.live ? ' is-live' : ''}">${badge}</span>${m.round ? `<span class="dks-round">${esc(m.round)}</span>` : ''}</div>
          <div class="dks-teams"><b>${esc(m.teamA || 'TBD')}</b><i>vs</i><b>${esc(m.teamB || 'TBD')}</b>${score}</div>
        </div>
        ${onAir ? '<span class="dks-loaded">Loaded</span>' : `<button type="button" class="dkc-btn" data-act="push" data-set="${esc(m.setId)}" title="Put these two teams on the scoreboard">Load</button>`}
      </div>`;
  }

  function render() {
    const el = root(); if (!el) return;
    const s = S(), sg = s.startgg || {};
    const rows = queueRows(s);
    const queueOn = !!($('sgg-queue-enabled') || {}).checked;
    const hasEvent = !!(sg.selectedEvent || (s.activeEvent && s.activeEvent.slug));
    const rd = rundown(), rp = replayView(), st = streamView(), want = streamFilter();
    const nextSig = JSON.stringify([
      rows.map((m) => [m.setId, m.teamA, m.teamB, m.round, m.live, m.state, m.scoreA, m.scoreB]), sg.lastPushedSetId, queueOn, hasEvent, want,
      [rd.hasSegs, rd.running, rd.pos, rd.total, rd.current, rd.next], rp, st,
    ]);
    if (nextSig === sig) return;
    sig = nextSig;
    // The title box keeps whatever is being typed across repaints.
    const ae = document.activeElement;
    const typing = ae && ae.id === 'dks-title' ? ae.value : null;

    const queueBody = rows.length ? rows.map((m, i) => matchRow(m, i, sg.lastPushedSetId)).join('')
      : !hasEvent ? '<p class="dkc-empty">No event loaded. Load your tournament and its next matches show up here.</p><div class="dkc-row"><button type="button" class="dkc-btn" data-act="events">Load an event</button></div>'
      : !queueOn ? '<p class="dkc-empty">The stream queue is off.</p><div class="dkc-row"><button type="button" class="dkc-btn" data-act="queue-on">Turn on the queue</button></div>'
      : '<p class="dkc-empty">Nothing queued yet. Matches the tournament assigns to your stream appear here.</p>';

    const rdBody = !rd.hasSegs
      ? '<p class="dkc-empty">No run of show yet.</p><div class="dkc-row"><button type="button" class="dkc-btn js-goto-rundown">Build one</button></div>'
      : `<div class="dks-rd">
          <div class="dks-rd-line"><span>Now</span><b>${esc(rd.running ? (rd.current || 'Segment') : 'Not started')}</b></div>
          <div class="dks-rd-line dks-rd-next"><span>Next</span><b>${esc(rd.next || 'End of show')}</b></div>
        </div>
        <div class="dkc-row">
          ${rd.running ? '<button type="button" class="dkc-btn" data-act="rd-back" title="Back one segment">Back</button>' : ''}
          <button type="button" class="dkc-btn dkc-btn-live" data-act="rd-go">${rd.running ? (rd.next ? 'Next' : 'Finish') : 'Start show'}</button>
          <span class="dkc-gap"></span>
          ${rd.running ? '<button type="button" class="dkc-btn" data-act="rd-stop">Stop</button>' : ''}
        </div>`;

    const clips = rp.clips.length
      ? `<div class="dks-clips">${rp.clips.map((c, i) => `<div class="dks-clip"><span class="dks-clip-name" title="${esc(c.name)}">${esc(c.name)}</span>${c.dur ? `<span class="dks-clip-dur">${esc(c.dur)}</span>` : ''}<button type="button" class="dkc-btn" data-act="rp-air" data-i="${i}" title="Play this clip on air now">To Air</button></div>`).join('')}</div>`
      : '<p class="dkc-empty">No clips yet. Capture while the buffer is running.</p>';

    el.innerHTML = `
      <section class="dkc-card">
        <div class="dkc-head"><span>Up next</span><span class="dkc-sub">${want ? esc('Stream: ' + want) : ''}</span></div>
        ${queueBody}
      </section>

      <section class="dkc-card">
        <div class="dkc-head"><span>Run of show</span>${rd.hasSegs ? `<span class="dkc-sub">${esc(rd.running ? rd.pos + ' of ' + rd.total : rd.total + ' segments')}</span>` : ''}</div>
        ${rdBody}
      </section>

      <section class="dkc-card">
        <div class="dkc-head"><span>Replay</span><span class="dkc-sub">${esc(rp.pill)}</span></div>
        <div class="dkc-row">
          <button type="button" class="dkc-btn" data-act="rp-buffer" ${rp.toggleOff ? 'disabled' : ''}>${esc(rp.toggle)}</button>
          <button type="button" class="dkc-btn dkc-btn-live" data-act="rp-capture" ${rp.capOff ? 'disabled' : ''} title="Save the buffer as a clip">Capture</button>
          <span class="dkc-gap"></span>
          ${rp.stopShown ? `<button type="button" class="dkc-btn" data-act="rp-stop" ${rp.stopOff ? 'disabled' : ''} title="Stop the replay on air and go back">Stop / Return</button>` : ''}
        </div>
        ${rp.status ? `<p class="dkc-empty">${esc(rp.status)}</p>` : ''}
        ${clips}
      </section>

      <section class="dkc-card">
        <div class="dkc-head"><span>Stream</span><span class="dkc-sub">${esc([st.live, st.viewers].filter(Boolean).join(' · '))}</span></div>
        <input type="text" class="input-text dks-title" id="dks-title" placeholder="Stream title" maxlength="140">
        <div class="dkc-row">
          <span class="dkc-lbl dks-game" title="Change the category in Chat > Channel">${esc(st.game || 'No category set')}</span>
          <span class="dkc-gap"></span>
          <button type="button" class="dkc-btn dkc-btn-live" data-act="title-save">Update title</button>
        </div>
      </section>`;
    const ti = $('dks-title');
    if (ti) {
      ti.value = typing != null ? typing : (($('flows-stream-title') || {}).value || '');
      if (typing != null) { ti.focus(); ti.setSelectionRange(ti.value.length, ti.value.length); }
    }
  }

  function press(id) { const b = $(id); if (b && !b.disabled) b.click(); }
  function pushSet(setId) {
    if (!setId || typeof send !== 'function') return;
    const go = () => send('startgg_push_set', { setId });
    if (typeof confirmQueuePush === 'function') Promise.resolve(confirmQueuePush()).then((ok) => { if (ok) go(); });
    else go();
  }
  function saveTitle() {
    const mine = $('dks-title'), real = $('flows-stream-title'), btn = $('btn-flows-update-channel');
    if (!mine || !real || !btn) return;
    real.value = mine.value;
    real.dispatchEvent(new Event('input', { bubbles: true }));
    btn.click();
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('#dock-show [data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === 'push') pushSet(b.dataset.set);
    else if (act === 'events') press('tab-events');
    else if (act === 'queue-on') { const q = $('sgg-queue-enabled'); if (q && !q.checked) q.click(); }
    else if (act === 'rd-go') { if (typeof rdNext === 'function') rdNext(); }
    else if (act === 'rd-back') { if (typeof rdPrev === 'function') rdPrev(); }
    else if (act === 'rd-stop') { if (typeof rdStop === 'function') rdStop(); }
    else if (act === 'rp-buffer') press('qr-buffer-toggle');
    else if (act === 'rp-capture') press('qr-save-replay');
    else if (act === 'rp-stop') press('qr-replay-stop');
    else if (act === 'rp-air') {
      const real = document.querySelectorAll('#qr-clip-list .qr-clip-row .qr-toair')[Number(b.dataset.i)];
      if (real) real.click();
    }
    else if (act === 'title-save') saveTitle();
    if (act.indexOf('rd-') === 0 && typeof renderQros === 'function') renderQros();
    setTimeout(render, 250);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target && e.target.id === 'dks-title') { e.preventDefault(); saveTitle(); }
  });

  // The replay pane, rundown and stream info repaint outside full_state; a visible tab re-checks
  // its signature each second and only rebuilds when something it shows changed.
  setInterval(() => { const el = root(); if (el && el.offsetParent) render(); }, 1000);
  window._dockShowRender = render;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
})();
