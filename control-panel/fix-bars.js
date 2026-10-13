// Fix bars: "this is off or broken, here is what it breaks, [fix it]". One shared bar, shown at the
// top of the pages a problem affects, plus a top-bar chip that lists every open problem in one place.
// Each check reads live state only; a fix presses the app's own control or sends the same message the
// app's own button sends, so nothing here has its own wiring to keep in sync.
//
// Hard rule: never change OBS settings. Problems that live in OBS Settings get text, not a button.
(function () {
  'use strict';
  const st = () => (typeof currentState === 'object' && currentState) || {};
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const switcherName = (s) => (s.obs && s.obs.app === 'streamlabs') ? 'Streamlabs' : 'OBS';

  // Open one app's settings in Integrations (same path as clicking its card).
  function openApp(key) {
    document.getElementById('tab-integrations')?.click();
    setTimeout(() => document.querySelector('.int-card[data-card="' + key + '"]')?.click(), 30);
  }
  function openRlSettings() {
    if (typeof openSettings === 'function') openSettings('games');
    setTimeout(() => document.querySelector('#integration-games .game-tab-btn[data-game="rl"]')?.click(), 50);
  }

  // id, level ('bad' | 'warn'), pages (tab keys the bar shows on; 'principal' is Home + Control
  // room, 'produccion' Rundown + Cameras; [] = top-bar list only, e.g. the Control room's program bar
  // or an existing panel banner already says it), grace (ms the problem must hold
  // before it shows: connections flap while the app starts), test(state) -> message or '',
  // fixes [{ label, run }].
  const CHECKS = [
    {
      id: 'switcher-down', level: 'bad', pages: [], grace: 8000,
      test: (s) => (s.obs && s.obs.enabled && !s.obs.connected && !(s.vmix && s.vmix.connected))
        ? switcherName(s) + ' is not connected, so scene cuts, replays and Add to OBS do nothing.' : '',
      fixes: [
        { label: 'Reconnect', run: () => { if (typeof send === 'function') send('obs_test_connection'); } },
        { label: 'Settings', ghost: true, run: () => openApp('obs') },
      ],
    },
    {
      id: 'replay-buffer-disabled', level: 'bad', pages: ['replays'], grace: 0,
      test: (s) => (s.obs && s.obs.connected && s.obs.replayBufferAvailable === false)
        ? 'Replay Buffer is switched off in ' + switcherName(s) + ' (Settings > Output > Replay Buffer), so no clips can be saved. Turn it on there; this app never changes ' + switcherName(s) + ' settings.' : '',
      fixes: [{ label: 'Check again', run: () => { if (typeof send === 'function') send('obs_test_connection'); } }],
    },
    {
      id: 'rl-stats', level: 'warn', pages: ['principal'], grace: 15000,
      test: (s) => (s.activeGame === 'rocket-league' && !s.rlConnected)
        ? 'Rocket League is not sending match data, so the HUD, scores and player cams stay empty. Start the game, and check its Stats API is on.' : '',
      fixes: [{ label: 'How to turn it on', run: openRlSettings }],
    },
    {
      // Connected but silent DURING a match (the socket is up, nothing arrives): the HUD is showing
      // frozen values as if live. Menus and the between-games lobby are quiet by design, so only a
      // match in play counts.
      id: 'rl-stale', level: 'bad', pages: [], grace: 5000,
      test: (s) => (s.activeGame === 'rocket-league' && s.rlConnected && s.rlStale && s.view === 'hud' && !s.awaitingKickoff && !s.rlPaused)
        ? 'Rocket League stopped sending match data mid-game, so scores and the clock on air are frozen. Check the game is still running; the feed reconnects by itself.' : '',
      fixes: [],
    },
    {
      // An integration that keeps failing (start.gg, Challonge, FACEIT, Sheets...). It backs off and
      // retries by itself; this says which one, why, and when it last worked, so stale bracket or
      // schedule data on air is never a surprise.
      id: 'poll-failing', level: 'warn', pages: [], grace: 0,
      test: (s) => {
        const bad = (s.pollFailures || []).filter((p) => p.fails >= 3);
        if (!bad.length) return '';
        const NAMES = { 'startgg-queue': 'start.gg', challonge: 'Challonge', challengermode: 'Challengermode', nxgen: 'NXGEN', faceit: 'FACEIT', sheets: 'Google Sheets', 'my-events': 'My events', 'team-spotlight': 'Team spotlight', 'twitch-prediction': 'Twitch prediction' };
        const p = bad[0];
        const ago = p.lastOkAt ? Math.max(1, Math.round((Date.now() - p.lastOkAt) / 60000)) : 0;
        return (NAMES[p.name] || p.name) + ' is not updating (' + (p.lastError || 'request failed') + ').'
          + (ago ? ' Last update ' + ago + ' min ago.' : ' No update yet this session.')
          + ' It keeps retrying by itself' + (bad.length > 1 ? '; ' + (bad.length - 1) + ' more integration' + (bad.length > 2 ? 's' : '') + ' failing too.' : '.');
      },
      fixes: [],
    },
    {
      id: 'player-cams-off', level: 'warn', pages: [], grace: 0,
      test: (s) => (s.facecamsEnabled === false && Array.isArray(s.facecams) && s.facecams.length && s.activeGame === 'rocket-league')
        ? 'Player cams are switched off, so the HUD shows no cameras (' + s.facecams.length + ' saved).' : '',
      fixes: [{ label: 'Turn on', run: () => document.getElementById('cf-facecams-enabled')?.click() }],
    },
    {
      id: 'twitch-title', level: 'bad', pages: ['principal'], grace: 0,
      test: (s) => {
        const mt = s.matchTitles || {};
        return (mt.twitch && mt.twitch.auto && mt.status && mt.status.twitchError) ? mt.status.twitchError : '';
      },
      fixes: [{ label: 'Reconnect Twitch', run: () => openApp('twitch') }],
    },
    {
      id: 'startgg', level: 'warn', pages: ['events'], grace: 0,
      test: (s) => (s.startgg && s.startgg.enabled && s.startgg.lastError) ? 'start.gg: ' + String(s.startgg.lastError).replace(/\s*\(Settings[^)]*\)/, '') : '',
      fixes: [{ label: 'Open start.gg', run: () => openApp('startgg') }],
    },
  ];

  const since = {};          // id -> when the problem was first seen (cleared when it passes)
  const hidden = new Set();  // ids hidden with "Not now" (until the problem clears)

  function evaluate() {
    const s = st(), now = Date.now(), open = [];
    CHECKS.forEach((c) => {
      let msg = '';
      try { msg = c.test(s) || ''; } catch (_) { msg = ''; }
      if (!msg) { delete since[c.id]; hidden.delete(c.id); return; }
      if (!since[c.id]) since[c.id] = now;
      if (now - since[c.id] < (c.grace || 0)) return;
      open.push({ c, msg });
    });
    return open;
  }

  const barHtml = (o, compact) => `<div class="fixbar fixbar-${o.c.level}" data-fix="${o.c.id}" role="status">
      <span class="fixbar-dot" aria-hidden="true"></span>
      <span class="fixbar-msg">${esc(o.msg)}</span>
      <span class="fixbar-acts">${o.c.fixes.map((f, i) => `<button type="button" class="btn btn-sm ${f.ghost ? 'btn-ghost' : 'fixbar-go'}" data-fix-run="${o.c.id}:${i}">${esc(f.label)}</button>`).join('')}${compact ? '' : `<button type="button" class="fixbar-x" data-fix-hide="${o.c.id}" title="Hide until this changes" aria-label="Hide">&times;</button>`}</span>
    </div>`;

  // One bar stack per page, placed under the page heading.
  function mountFor(page) {
    const root = document.getElementById('tab-' + page + '-content');
    if (!root) return null;
    let m = root.querySelector(':scope > .fixbar-stack') || root.querySelector('.fixbar-stack[data-page="' + page + '"]');
    if (m) return m;
    m = document.createElement('div');
    m.className = 'fixbar-stack'; m.dataset.page = page;
    const head = root.querySelector(':scope > .page-head');
    if (head) head.after(m); else root.prepend(m);
    return m;
  }

  // Top-bar chip: "2 need attention", opens a list of every open problem with its fixes.
  function chip() {
    let c = document.getElementById('topbar-fix-chip');
    if (c) return c;
    const anchor = document.getElementById('btn-tour-help');
    if (!anchor) return null;
    c = document.createElement('button');
    c.type = 'button'; c.id = 'topbar-fix-chip'; c.className = 'topbar-fix-chip'; c.style.display = 'none';
    c.title = 'Things that are off or not connected';
    anchor.before(c);
    const pop = document.createElement('div');
    pop.id = 'fixbar-pop'; pop.className = 'fixbar-pop'; pop.hidden = true;
    document.body.appendChild(pop);
    c.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!pop.hidden) { pop.hidden = true; return; }
      const r = c.getBoundingClientRect();
      pop.style.top = (r.bottom + 6) + 'px';
      pop.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
      pop.hidden = false; renderPop();
    });
    document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target) && e.target !== c) pop.hidden = true; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') pop.hidden = true; });
    return c;
  }
  function renderPop() {
    const pop = document.getElementById('fixbar-pop');
    if (!pop || pop.hidden) return;
    const open = evaluate();
    pop.innerHTML = '<div class="fixbar-pop-head">Needs attention</div>'
      + (open.length ? open.map((o) => barHtml(o, true)).join('') : '<div class="fixbar-pop-ok">Everything is connected.</div>');
  }

  let lastSig = '';
  function render() {
    const open = evaluate();
    const sig = open.map((o) => o.c.id + '|' + o.msg + '|' + (hidden.has(o.c.id) ? 1 : 0)).join('~');
    if (sig === lastSig) return;
    lastSig = sig;
    const pages = new Set(); CHECKS.forEach((c) => c.pages.forEach((p) => pages.add(p)));
    pages.forEach((p) => {
      const here = open.filter((o) => o.c.pages.includes(p) && !hidden.has(o.c.id));
      const m = here.length ? mountFor(p) : document.querySelector('.fixbar-stack[data-page="' + p + '"]');
      if (m) m.innerHTML = here.map((o) => barHtml(o, false)).join('');
    });
    const c = chip();
    if (c) {
      const bad = open.some((o) => o.c.level === 'bad');
      c.style.display = open.length ? '' : 'none';
      c.classList.toggle('is-bad', bad);
      c.innerHTML = '<span class="tfc-dot"></span>' + open.length + (open.length === 1 ? ' needs attention' : ' need attention');
    }
    renderPop();
  }

  document.addEventListener('click', (e) => {
    const run = e.target.closest && e.target.closest('[data-fix-run]');
    if (run) {
      const [id, i] = run.getAttribute('data-fix-run').split(':');
      const c = CHECKS.find((x) => x.id === id);
      const f = c && c.fixes[Number(i)];
      if (f) { try { f.run(); } catch (err) { console.warn('[fix-bars]', err); } }
      const pop = document.getElementById('fixbar-pop'); if (pop && pop.contains(run)) pop.hidden = true;
      return;
    }
    const hide = e.target.closest && e.target.closest('[data-fix-hide]');
    if (hide) { hidden.add(hide.getAttribute('data-fix-hide')); lastSig = ''; render(); }
  });

  setInterval(render, 1000);
  setTimeout(render, 300);
  window._fixBars = { CHECKS, evaluate, render };
})();
