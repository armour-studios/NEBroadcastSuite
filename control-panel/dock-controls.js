/* ─── dock-controls.js — the Live dock's "Controls" tab ──────────────────────────────────────
   The things a producer changes mid-show, in one place, each one press:
     Match       tap a team's tile to give it a map (−1 under it), pick the game, swap sides
     Break       the Countdown Timer popover's clock, presets, nudges, title and Show / Hide
     On screen   the producer's own pick of On Air switches (Customize)
     Graphics    every graphic from On Air as an on/off chip, Hide all
     OBS         program scene buttons, save replay, ad break
     Automation  AI Shield, auto-director, run a flow
   Everything uses the same messages / buttons as the rest of the app (no new server code), and the
   panel only rebuilds when what it shows changes. Loads after app.js; app.js calls
   window._dockControlsRender() on every state update. */
(function () {
  const root = () => document.getElementById('dock-controls');
  const S = () => (typeof currentState !== 'undefined' && currentState) || {};
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const tx = (type, data) => { if (typeof send === 'function') send(type, data); };
  let sig = '';

  // First run after this change: open the dock on Controls rather than the old last-used tab.
  try {
    if (!localStorage.getItem('ne_dock_controls_v1')) { localStorage.setItem('ne_mx_dock', 'controls'); localStorage.setItem('ne_dock_controls_v1', '1'); }
  } catch (e) {}

  // The team mark: the panel's own logo preview (#preview-logo-<side>) already resolves the team
  // logo, or the game logo in white when the team has none, so mirror it rather than re-resolve.
  function teamMark(side) {
    const img = document.getElementById('preview-logo-' + side);
    if (!img || !img.src) return '';
    return `<img class="dkc-tile-logo${img.classList.contains('game-logo-white') ? ' is-game' : ''}" src="${esc(img.src)}" alt="">`;
  }
  function teamTag(t, fallback) {
    t = t || {};
    if (t.abbr) return String(t.abbr).toUpperCase().slice(0, 6);
    const w = String(t.name || fallback).trim().split(/\s+/).filter(Boolean);
    return (w.length > 1 ? w.map((x) => x[0]).join('').slice(0, 4) : (w[0] || fallback).slice(0, 6)).toUpperCase();
  }
  function breakLeft(b) {
    if (!b) return null;
    if (b.endsAt) return Math.max(0, Math.round((b.endsAt - Date.now()) / 1000));
    if (b.frozenSeconds != null) return b.frozenSeconds;
    return null;
  }
  const mmss = (n) => n == null ? '--:--' : String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');

  // The On Air pane's graphics chips are the single source of truth for "what can go on air"; the
  // Controls tab mirrors them and presses the real chip.
  function graphicChips() {
    return Array.from(document.querySelectorAll('#qk-put .qk-chip[data-id]:not(.qk-chip--scene)')).map((c) => ({
      id: c.dataset.id, label: ((c.querySelector('.qk-chip-main') || {}).textContent || '').trim(), on: c.classList.contains('on'),
    })).filter((c) => c.label);
  }

  function computeSig(s) {
    const b = s.breakScreen || {};
    const obs = s.obs || {};
    return JSON.stringify([
      (s.teams && s.teams.blue && [s.teams.blue.name, s.teams.blue.abbr, s.teams.blue.color]) || 0,
      (s.teams && s.teams.orange && [s.teams.orange.name, s.teams.orange.abbr, s.teams.orange.color]) || 0,
      s.series, s.game && s.game.number, s.bestOf,
      !!b.visible, b.endsAt || 0, b.frozenSeconds, b.title,
      !!(s.ticker && s.ticker.visible), !!(s.casters && s.casters.visible), !!((s.mainBanner || s.banner || {}).visible),
      graphicChips().map((c) => c.id + (c.on ? '+' : '-')).join(','),
      !!obs.connected, obs.currentScene, (obs.availableScenes || []).join('|'),
      !!(s.commercial && s.commercial.active),
      !!(s.ai && s.ai.shield), (s.director || {}).enabled !== false,
      flowList(s).map((f) => f.id + ':' + f.name).join('|'),
      osEditing, osChosen().join(','), osAll().map((x) => x.key + (osOn(x, s) ? '+' : '-')).join(','),
      btCurrentTitle(b),
      ['blue', 'orange'].map((sd) => { const i = document.getElementById('preview-logo-' + sd); return i ? i.src + (i.classList.contains('game-logo-white') ? '!' : '') : ''; }).join('|'),
    ]);
  }

  function flowList(s) {
    return (Array.isArray(s.flows) ? s.flows : []).filter((f) => f && f.id).map((f) => ({ id: f.id, name: f.name || 'Flow' }));
  }

  // ── On screen: which overlay switches the card shows is the producer's choice ──────────────
  // The list comes from app.js's ONAIR_SCENES (the On Air grid), so every switch here is the same
  // flag the rest of the app toggles. The break screen has its own card, so it is not offered.
  const OS_KEY = 'ne_dkc_onscreen';
  const OS_DEFAULT = ['ticker', 'casters', 'banner'];
  let osEditing = false;
  function osAll() { return (window.ONAIR_SCENES || []).filter((x) => x && x.key && x.key !== 'break'); }
  function osChosen() {
    try { const a = JSON.parse(localStorage.getItem(OS_KEY) || 'null'); if (Array.isArray(a)) return a.filter((k) => typeof k === 'string'); } catch (e) {}
    return OS_DEFAULT.slice();
  }
  function osSave(a) { try { localStorage.setItem(OS_KEY, JSON.stringify(a)); } catch (e) {} }
  function osOn(sc, s) {
    if (typeof onairIsOn === 'function') return !!onairIsOn(sc, s);
    if (sc.check) return !!sc.check(s);
    return !!(typeof getPath === 'function' ? getPath(s, sc.path) : String(sc.path || '').split('.').reduce((o, k) => (o == null ? o : o[k]), s));
  }

  // ── Break timer: the dock mirrors the Countdown Timer popover (same clock, presets, nudges) ──
  // app.js owns the producer timer (_timer / toggleTimer / setTimerSecs / adjustTimer); the dock
  // drives those so the top bar, the popover and this card always agree.
  const T = () => (typeof _timer !== 'undefined' && _timer) || null;
  const fmtT = (n) => (typeof fmtTimer === 'function' ? fmtTimer(n) : mmss(n));
  const BT_PRESETS = [60, 120, 300, 600, 900];
  const BT_NUDGE = [-60, -30, -15, 15, 30, 60];
  const btLabel = (n) => { const a = Math.abs(n); return (n < 0 ? '−' : '+') + (a >= 60 ? (a / 60) + ':00' : String(a)); };
  function btTitleOptions() {
    const sel = document.getElementById('ptp-break-title');
    if (sel) return Array.from(sel.options).map((o) => [o.value, o.textContent]);
    return [['', 'None (timer only)'], ['STARTING SOON', 'STARTING SOON'], ['BE RIGHT BACK', 'BE RIGHT BACK'], ['INTERMISSION', 'INTERMISSION'], ['UP NEXT', 'UP NEXT'], ['TECHNICAL DIFFICULTIES', 'TECH DIFFICULTIES']];
  }
  function btCurrentTitle(b) {
    const sel = document.getElementById('ptp-break-title');
    return sel ? sel.value : (b.title || '');
  }

  function render() {
    const el = root(); if (!el) return;
    const s = S();
    const nextSig = computeSig(s);
    if (nextSig === sig) { tick(); return; }
    sig = nextSig;
    const tb = (s.teams && s.teams.blue) || {}, to = (s.teams && s.teams.orange) || {};
    const ser = s.series || {};
    const gnum = (s.game && s.game.number) || 1;
    const b = s.breakScreen || {};
    const obs = s.obs || {};
    const chips = graphicChips();
    const flows = flowList(s);
    const shield = !!(s.ai && s.ai.shield);
    const scenes = (obs.availableScenes || []).filter((n) => !/^═/.test(n));
    const sw = (key, label, on, sub) => `<button type="button" class="dkc-switch${on ? ' is-on' : ''}" data-act="${key}" aria-pressed="${on}">
        <span class="dkc-switch-txt">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span><span class="dkc-switch-knob"></span></button>`;

    const bestOf = Math.max(1, Number(s.bestOf) || 5);
    const t0 = T();
    const chosen = osChosen();
    const osList = osAll();
    const osShown = chosen.map((k) => osList.find((x) => x.key === k)).filter(Boolean);
    const curTitle = btCurrentTitle(b);

    el.innerHTML = `
      <section class="dkc-card dkc-match">
        <div class="dkc-head dkc-head-center"><span>Match</span><span class="dkc-sub">Best of ${esc(bestOf)}</span><span class="dkc-head-pad" aria-hidden="true">Match</span></div>
        <div class="dkc-board">
          ${[['blue', tb, 'Blue'], ['orange', to, 'Orange']].map(([side, t, fb]) => `
            <div class="dkc-team" style="--team:${esc(t.color || (side === 'blue' ? '#3b82f6' : '#f97316'))}">
              <button type="button" class="dkc-tile" data-act="score" data-side="${side}" data-d="1" title="Tap to give ${esc(t.name || fb)} a map">
                <span class="dkc-tile-id">${teamMark(side)}<span class="dkc-tile-tag">${esc(teamTag(t, fb))}</span></span>
                <span class="dkc-tile-num">${esc(ser[side] || 0)}</span>
              </button>
              <button type="button" class="dkc-undo" data-act="score" data-side="${side}" data-d="-1" ${(ser[side] || 0) > 0 ? '' : 'disabled'} title="Take a map off ${esc(t.name || fb)}">− 1</button>
            </div>`).join(`<div class="dkc-mid"><span class="dkc-vs">vs</span>
              <button type="button" class="dkc-swap" data-act="swap" title="Swap which side each team is on">Swap</button></div>`)}
        </div>
        <div class="dkc-games">
          <span class="dkc-lbl">Game</span>
          <div class="dkc-seg" role="radiogroup" aria-label="Game of the series">
            ${Array.from({ length: bestOf }, (_, i) => i + 1).map((n) => `<button type="button" class="dkc-seg-btn${n === gnum ? ' is-on' : ''}" data-act="game-set" data-n="${n}" aria-pressed="${n === gnum}" title="Game ${n} of ${bestOf}">${n}</button>`).join('')}
          </div>
        </div>
      </section>

      <section class="dkc-card dkc-break">
        <div class="dkc-head"><span>Break timer</span><span class="dkc-sub">${b.visible ? '<span class="dkc-live">Live</span>' : 'Hidden'}</span></div>
        <div class="dkc-bt-clock" id="dkc-clock">${esc(fmtT(t0 ? t0.secs : breakLeft(b) || 0))}</div>
        <div class="dkc-bt-status" id="dkc-bt-status"><span class="dkc-bt-dot"></span><span id="dkc-bt-txt"></span></div>
        <div class="dkc-row dkc-bt-presets">
          ${BT_PRESETS.map((n) => `<button type="button" class="dkc-bt-preset" data-act="bt-set" data-n="${n}" title="Set the clock to ${fmtT(n)}">${fmtT(n)}</button>`).join('')}
        </div>
        <div class="dkc-row dkc-bt-nudge">
          ${BT_NUDGE.map((n, i) => (i === 3 ? '<span class="dkc-bt-mid" aria-hidden="true"></span>' : '') + `<button type="button" class="dkc-bt-adj${n < 0 ? ' is-neg' : ''}" data-act="bt-adj" data-n="${n}">${btLabel(n)}</button>`).join('')}
        </div>
        <div class="dkc-row">
          <select class="dkc-select" data-act="bt-title" title="Title shown above the countdown">
            ${btTitleOptions().map(([v, l]) => `<option value="${esc(v)}"${v === curTitle ? ' selected' : ''}>${esc(l)}</option>`).join('')}
          </select>
        </div>
        <div class="dkc-row">
          <button type="button" class="dkc-btn dkc-bt-transport" data-act="bt-toggle" id="dkc-bt-toggle">Start</button>
          <button type="button" class="dkc-btn" data-act="bt-reset" title="Back to the last length you set">Reset</button>
          <span class="dkc-gap"></span>
          ${b.visible
            ? '<button type="button" class="dkc-btn dkc-btn-off" data-act="bt-hide" title="Take the countdown off the overlay">Hide</button>'
            : '<button type="button" class="dkc-btn dkc-btn-live" data-act="bt-show" title="Show the countdown on the overlay and start the clock">Show countdown</button>'}
        </div>
      </section>

      <section class="dkc-card dkc-onscreen">
        <div class="dkc-head"><span>On screen</span>
          <button type="button" class="dkc-link dkc-link-quiet" data-act="os-edit">${osEditing ? 'Done' : 'Customize'}</button></div>
        ${osEditing ? `
          <p class="dkc-empty">Pick the switches you want on this card.</p>
          <div class="dkc-chips">${osList.map((x) => `<button type="button" class="dkc-chip dkc-chip-pick${chosen.includes(x.key) ? ' is-on' : ''}" data-act="os-pick" data-key="${esc(x.key)}" aria-pressed="${chosen.includes(x.key)}">${esc(x.label)}</button>`).join('')}</div>
          <div class="dkc-row dkc-row-end"><button type="button" class="dkc-link dkc-link-quiet" data-act="os-reset">Reset to default</button></div>`
        : (osShown.length ? `<div class="dkc-switches">${osShown.map((x) => sw('os:' + x.key, x.label, osOn(x, s))).join('')}</div>`
          : '<p class="dkc-empty">Nothing picked yet. Customize to choose what goes here.</p>')}
      </section>

      <section class="dkc-card">
        <div class="dkc-head"><span>Graphics</span>${chips.some((c) => c.on) ? '<button type="button" class="dkc-link" data-act="gfx-clear">Hide all</button>' : ''}</div>
        ${chips.length ? `<div class="dkc-chips">${chips.map((c) => `<button type="button" class="dkc-chip${c.on ? ' is-on' : ''}" data-act="gfx" data-id="${esc(c.id)}" title="${c.on ? 'Take off air' : 'Put on air'}">${esc(c.label)}</button>`).join('')}</div>`
          : '<p class="dkc-empty">No graphics set up yet.</p>'}
      </section>

      <section class="dkc-card">
        <div class="dkc-head"><span>OBS</span><span class="dkc-sub">${obs.connected ? 'Connected' : 'Not connected'}</span></div>
        ${obs.connected ? (scenes.length ? `<div class="dkc-chips">${scenes.map((n) => `<button type="button" class="dkc-chip dkc-scene${n === obs.currentScene ? ' is-live' : ''}" data-act="scene" data-scene="${esc(n)}" title="Cut to ${esc(n)}">${esc(n)}</button>`).join('')}</div>` : '<p class="dkc-empty">No scenes in OBS.</p>')
          : '<p class="dkc-empty">Connect OBS to cut scenes from here.</p>'}
        <div class="dkc-row">
          <button type="button" class="dkc-btn" data-act="replay" ${obs.connected ? '' : 'disabled'} title="Save the last moments from the replay buffer">Save replay</button>
          <span class="dkc-gap"></span>
          <button type="button" class="dkc-btn ${s.commercial && s.commercial.active ? 'dkc-btn-live' : ''}" data-act="ad" ${obs.connected ? '' : 'disabled'} title="Cut to your ad scene, press again to come back">${s.commercial && s.commercial.active ? 'End ad break' : 'Ad break'}</button>
        </div>
      </section>

      <section class="dkc-card">
        <div class="dkc-head"><span>Automation</span><button type="button" class="dkc-link dkc-link-quiet" data-act="flows-edit">Edit flows</button></div>
        <div class="dkc-switches">
          ${sw('shield', 'AI Shield', shield, shield ? 'Every automation is paused' : 'Pause every automation at once')}
          ${sw('director', 'Auto-director', (s.director || {}).enabled !== false, 'Picks the camera for you')}
        </div>
        ${flows.length ? `<div class="dkc-chips">${flows.slice(0, 12).map((f) => `<button type="button" class="dkc-chip" data-act="flow" data-id="${esc(f.id)}" title="Run ${esc(f.name)} now">${esc(f.name)}</button>`).join('')}</div>`
          : '<p class="dkc-empty">No flows yet. A flow runs a set of actions with one press.</p>'}
      </section>`;
    tick();
  }

  // Ticks the break clock once a second without rebuilding the panel.
  function tick() {
    const c = document.getElementById('dkc-clock'); if (!c) return;
    const t0 = T();
    const secs = t0 ? t0.secs : (breakLeft((S().breakScreen) || {}) || 0);
    const running = !!(t0 && t0.running);
    const t = fmtT(secs);
    if (c.textContent !== t) c.textContent = t;
    // Same colour rule as the popover: green, amber under a minute, red under thirty seconds.
    c.style.color = secs <= 30 ? '#f56565' : (secs <= 60 ? '#fbbf24' : '#4ade80');
    const box = document.getElementById('dkc-bt-status'), txt = document.getElementById('dkc-bt-txt');
    if (box && txt) {
      box.classList.toggle('is-running', running && secs > 0);
      box.classList.toggle('is-paused', !running && secs > 0);
      box.classList.toggle('is-done', secs === 0);
      let str;
      if (secs === 0) str = 'At zero';
      else if (running) str = 'Ends ' + new Date(Date.now() + secs * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      else str = 'Paused';
      if (txt.textContent !== str) txt.textContent = str;
    }
    const tg = document.getElementById('dkc-bt-toggle');
    if (tg) { const l = running ? 'Pause' : (secs === 0 ? 'Reset' : 'Start'); if (tg.textContent !== l) tg.textContent = l; }
    const base = t0 ? (running ? t0.base : t0.secs) : secs;
    document.querySelectorAll('#dock-controls .dkc-bt-preset').forEach((p) => p.classList.toggle('is-on', Number(p.dataset.n) === base));
  }
  // Some of what the panel shows arrives outside full_state (director updates, the On Air chips
  // repainting), so a visible panel re-checks its signature each second; unchanged = just the clock.
  setInterval(() => { const el = root(); if (el && el.offsetParent) render(); }, 1000);

  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('#dock-controls [data-act]');
    if (!b || b.disabled) return;
    const s = S(), act = b.dataset.act;
    if (act === 'score') tx('adjust_series', { side: b.dataset.side, delta: Number(b.dataset.d) });
    else if (act === 'game-set') { const d = Number(b.dataset.n) - ((s.game && s.game.number) || 1); if (d) tx('adjust_game_number', { delta: d }); }
    else if (act === 'swap') tx('swap_teams', {});
    // Break timer: drive app.js's producer timer so the top bar and the popover stay in step.
    else if (act === 'bt-set') { if (typeof setTimerSecs === 'function') setTimerSecs(Number(b.dataset.n)); else tx('set_break', { seconds: Number(b.dataset.n) }); tick(); }
    else if (act === 'bt-adj') {
      if (typeof adjustTimer === 'function') adjustTimer(Number(b.dataset.n));
      else { const left = breakLeft(s.breakScreen || {}); if (left != null) tx('set_break', { seconds: Math.max(0, left + Number(b.dataset.n)) }); }
      tick();
    }
    else if (act === 'bt-toggle') { if (typeof toggleTimer === 'function') toggleTimer(); tick(); }
    else if (act === 'bt-reset') { const t0 = T(); if (t0 && typeof setTimerSecs === 'function') setTimerSecs(t0.base || 300); tick(); }
    else if (act === 'bt-show') {
      const real = document.getElementById('ptp-show');
      if (real) real.click();
      else { const t0 = T(); tx('set_break', { visible: true, seconds: (t0 && t0.secs) || 300, title: btCurrentTitle(s.breakScreen || {}) }); }
    }
    else if (act === 'bt-hide') { const real = document.getElementById('ptp-hide'); if (real) real.click(); else tx('set_break', { visible: false }); }
    // On screen: the switches are whatever the producer picked from the On Air list.
    else if (act.startsWith('os:')) {
      const sc = osAll().find((x) => x.key === act.slice(3)); if (!sc) return;
      const on = osOn(sc, s);
      tx(sc.msg, on ? (sc.hideData || { visible: false }) : (sc.showData || { visible: true }));
    }
    else if (act === 'os-edit') { osEditing = !osEditing; sig = ''; render(); return; }
    else if (act === 'os-pick') {
      const k = b.dataset.key, a = osChosen();
      const i = a.indexOf(k); if (i >= 0) a.splice(i, 1); else a.push(k);
      // Keep the On Air order so the card reads the same way the grid does.
      const order = osAll().map((x) => x.key);
      osSave(a.sort((x, y) => order.indexOf(x) - order.indexOf(y)));
      sig = ''; render(); return;
    }
    else if (act === 'os-reset') { osSave(OS_DEFAULT.slice()); sig = ''; render(); return; }
    else if (act === 'gfx') {
      const real = document.querySelector('#qk-put .qk-chip[data-id="' + CSS.escape(b.dataset.id) + '"] .qk-chip-main');
      if (real) real.click();
    }
    else if (act === 'gfx-clear') { const c = document.getElementById('gfx-top-clear'); if (c) c.click(); }
    else if (act === 'scene') tx('obs_switch_scene', { sceneName: b.dataset.scene });
    else if (act === 'replay') tx('obs_save_replay', {});
    else if (act === 'shield') tx('set_ai_shield', { on: !(s.ai && s.ai.shield) });
    else if (act === 'director') tx('set_director', { enabled: (s.director || {}).enabled === false });
    else if (act === 'flow') {
      const f = (s.flows || []).find((x) => x.id === b.dataset.id);
      if (f && typeof flowFire === 'function') flowFire(f); else if (f) tx('fire_flow_manual', { id: f.id });
    }
    else if (act === 'flows-edit') { const a = document.querySelector('.js-goto-flows'); if (a) a.click(); }
    else if (act === 'ad') {
      // Ads never start on their own; going INTO an ad break asks once, coming out does not.
      if (s.commercial && s.commercial.active) { tx('obs_toggle_commercial', {}); return; }
      const go = () => tx('obs_toggle_commercial', {});
      if (typeof appConfirm === 'function') appConfirm('Start an ad break now? OBS cuts to your ad scene.', 'Start ad break').then((ok) => { if (ok) go(); });
      else go();
    }
    // The panel repaints from the next state update; the On Air chip mirror needs a beat.
    setTimeout(render, 250);
  });

  // The break title select mirrors the popover's; changing it here changes it there (which sends it).
  document.addEventListener('change', (e) => {
    const sel = e.target.closest && e.target.closest('#dock-controls [data-act="bt-title"]');
    if (!sel) return;
    const real = document.getElementById('ptp-break-title');
    if (real) { real.value = sel.value; real.dispatchEvent(new Event('change', { bubbles: true })); }
    else tx('set_break', { title: sel.value });
  });

  window._dockControlsRender = render;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
})();
