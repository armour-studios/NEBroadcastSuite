/* navsearch.js — universal search for the suite (Ctrl+K).
 *
 * The suite has ~12 sidebar pages but well over a hundred panels behind sub-navs, and producers
 * were hunting for things they knew existed but not where they lived. This started as a panel
 * index; it now searches the CONTENT too — a producer typing a team name, a caster's handle, a
 * league, a flow, an OBS scene or a clip gets taken straight to it, because mid-show "where is
 * that team" is asked far more often than "where is the Teams panel".
 *
 * Two halves:
 *   FEATURES  — the hand-written panel index. `k` is extra search vocabulary, never displayed;
 *               it's what makes the word already in the producer's head ("brb", "veto", "lower
 *               third") land on the right panel.
 *   PROVIDERS — live rows read from currentState at query time, so nothing needs invalidating.
 *
 * Everything navigates by running the same clicks a human would, so there's no second navigation
 * path that can drift out of sync with the real one. Matching is delegated to NESearch
 * (search-core.js) so this box behaves exactly like every other search box in the app.
 *
 * Loaded last (after app.js and the page modules) so _pdShow / _talentShowPage / _assetsShow /
 * _dccSetRole / startEditTeam all exist by the time anything can call them.
 */
(function initFeatureSearch() {
  'use strict';

  const box = document.getElementById('navsearch');
  const input = document.getElementById('navsearch-input');
  const panel = document.getElementById('navsearch-results');
  if (!box || !input || !panel) return;

  const S = window.NESearch;
  if (!S) { console.error('[navsearch] search-core.js did not load — search is disabled'); return; }
  const esc = S.esc;

  /* ── Navigation ────────────────────────────────────────────────────────────────────────────
   * Destinations are DECLARATIVE (a small spec object), not hand-written closures, for two
   * reasons that both showed up as "search took me to the wrong place":
   *
   *  1. A spec has a checkable target selector, so `__navsearchAudit()` can walk the whole index
   *     and name every entry that points at a control which no longer exists. Written as closures,
   *     a renamed sub-nav key silently produced a result that landed on the page and clicked
   *     nothing — five overlay entries, the two quick-rail entries, Chat Games and Talent Monitor
   *     were all dead exactly that way.
   *  2. Every step WAITS for its target instead of guessing a render delay. The old code fired
   *     fixed 70/90/160ms timeouts after switching tabs; on a slow render the click landed on a
   *     sub-nav that had not been built yet and the producer ended up on the page's default pane.
   *
   * Spec keys (all optional, applied in order):
   *   tab, prod, gfx, ev, talent(+talentSub), assets, stats, integ, dash, replays, rail,
   *   flash (element id), filter {id,value}, text {sel,value}
   */

  // How long to keep polling for a lazily-rendered target before giving up and saying so.
  const NAV_TIMEOUT = 2000;

  // Poll rather than sleep. Tries immediately (the usual case: the DOM is already there), then
  // every 25ms. Warns on the console if it never appears, so a broken destination is visible
  // instead of silently doing nothing.
  function waitFor(find, use, label) {
    const deadline = Date.now() + NAV_TIMEOUT;
    (function tick() {
      let n = null;
      try { n = find(); } catch (e) { n = null; }
      if (n) { try { use(n); } catch (e) { console.error('[navsearch] ' + label + ': ', e); } return; }
      if (Date.now() < deadline) { setTimeout(tick, 25); return; }
      console.warn('[navsearch] could not find ' + label + ' — landed on the page but not the panel');
    })();
  }
  const clickWhenReady = (sel) => waitFor(() => document.querySelector(sel), (n) => n.click(), sel);
  const callWhenReady = (fnName, arg) =>
    waitFor(() => window[fnName], (f) => f(arg), fnName + '("' + arg + '")');

  // Ring a control so the producer's eye lands on the right row instead of the top of a long page.
  const flash = (node) => {
    if (!node) return;
    try { node.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { node.scrollIntoView(); }
    const host = node.closest('.section, .field-row, .tc-card, .flow-card, .scene-card, .crew-card, label') || node;
    const prev = host.style.boxShadow;
    host.style.transition = 'box-shadow .25s ease';
    host.style.boxShadow = '0 0 0 2px var(--accent, #6366f1)';
    setTimeout(() => { host.style.boxShadow = prev || ''; }, 1800);
  };

  // The one selector that proves a spec's destination exists. Audited without navigating.
  const STEP_SEL = {
    tab:       (v) => '.tab-btn[data-tab="' + v + '"]',
    prod:      (v) => '[data-pd="' + v + '"]',
    gfx:       (v) => '[data-gfxscene="' + v + '"]',
    ev:        (v) => '[data-evtab="' + v + '"]',
    talentSub: (v) => '[data-teamstab="' + v + '"]',
    assets:    (v) => '#assets-subnav [data-assettab="' + v + '"]',
    stats:     (v) => '[data-stab="' + v + '"]',
    integ:     (v) => '[data-inttab="' + v + '"]',
    dash:      (v) => '[data-role="' + v + '"]',
    replays:   (v) => '[data-rpmain="' + v + '"]',
    rail:      (v) => '.qrail-tab[data-qtab="' + v + '"]',
    settings:  (v) => '.set-rail-btn[data-stab="' + v + '"]',
    flash:     (v) => '#' + v
  };

  /* Run a destination spec. Each step waits for the one before it to have rendered. */
  function nav(spec) {
    if (!spec) return;
    if (spec.tab) clickWhenReady(STEP_SEL.tab(spec.tab));

    if (spec.prod) {
      clickWhenReady(STEP_SEL.tab('produccion'));
      callWhenReady('_pdShow', spec.prod);
    }
    // The Graphics hub is a Dashboard section now (Production dropped its Graphics pane).
    if (spec.gfx) {
      clickWhenReady(STEP_SEL.tab('principal'));
      clickWhenReady(STEP_SEL.gfx(spec.gfx));
    }
    if (spec.ev)      { clickWhenReady(STEP_SEL.tab('events')); clickWhenReady(STEP_SEL.ev(spec.ev)); }
    // A Modern page by its nav route (ui-style.js go); Classic falls back to the tab.
    if (spec.mx) { if (typeof window.__mxGo === 'function' && document.documentElement.getAttribute('data-ui') === 'modern') window.__mxGo(spec.mx); else if (spec.mx.tab) clickWhenReady(STEP_SEL.tab(spec.mx.tab)); }
    if (spec.talent)  {
      clickWhenReady(STEP_SEL.tab('equipos'));
      callWhenReady('_talentShowPage', spec.talent);
      if (spec.talentSub) clickWhenReady(STEP_SEL.talentSub(spec.talentSub));
    }
    if (spec.assets)  { clickWhenReady(STEP_SEL.tab('media')); callWhenReady('_assetsShow', spec.assets); }
    if (spec.stats)   { clickWhenReady(STEP_SEL.tab('stats')); clickWhenReady(STEP_SEL.stats(spec.stats)); }
    if (spec.integ)   { clickWhenReady(STEP_SEL.tab('integrations')); clickWhenReady(STEP_SEL.integ(spec.integ)); }
    if (spec.game)    { callWhenReady('_ghOpen', spec.game); }
    if (spec.dash)    { clickWhenReady(STEP_SEL.tab('principal')); callWhenReady('_dccSetRole', spec.dash); }
    if (spec.replays) { clickWhenReady(STEP_SEL.tab('replays')); clickWhenReady(STEP_SEL.replays(spec.replays)); }
    // The quick rail is always on screen — its tabs are destinations in their own right. But a
    // rail tab click TOGGLES: clicking the tab that's already open collapses the rail. Searching
    // for a panel that happened to be open therefore CLOSED it — the exact opposite of the ask.
    // qrailShowTab always opens; the click is only a fallback, and only when it can't toggle off.
    if (spec.rail) {
      waitFor(() => document.querySelector(STEP_SEL.rail(spec.rail)), (btn) => {
        if (typeof window.qrailShowTab === 'function') { window.qrailShowTab(spec.rail); return; }
        if (document.querySelector('.app-shell.qrail-collapsed') || !btn.classList.contains('active')) btn.click();
      }, STEP_SEL.rail(spec.rail));
    }

    // Settings is a MODAL now, and its left rail hides every category but the open one. Clicking
    // the nav tab alone reopened it on whatever category was last used — so a result pointing at,
    // say, Go Live (Broadcast) flashed a section that was display:none. Open the owning category.
    if (spec.settings) callWhenReady('openSettings', spec.settings);

    if (spec.flash === 'ev-platform-tabs' && window.__siteEvents && window.__siteEvents.openOther) window.__siteEvents.openOther();
    if (spec.flash)   waitFor(() => document.getElementById(spec.flash), flash, '#' + spec.flash);
    // Drive an existing filter box on the destination page, so a search for a team lands on that
    // page ALREADY filtered to it rather than dumping the producer into a 200-card grid.
    if (spec.filter && spec.filter.value) {
      waitFor(() => document.getElementById(spec.filter.id), (n) => {
        n.value = spec.filter.value;
        n.dispatchEvent(new Event('input', { bubbles: true }));
      }, '#' + spec.filter.id);
    }
    // Find the card carrying this text and flash it — for rows whose page has no addressable
    // "open item X" entry point. Fails soft: you still end up on the right page.
    if (spec.text && spec.text.value) {
      const want = S.norm(spec.text.value);
      waitFor(() => {
        const nodes = document.querySelectorAll(spec.text.sel);
        for (let i = 0; i < nodes.length; i++) {
          if (S.norm(nodes[i].textContent || '').indexOf(want) !== -1) return nodes[i];
        }
        return null;
      }, flash, spec.text.sel + ' containing "' + spec.text.value + '"');
    }
  }

  /* Which selectors a spec depends on — used by the audit, and by the index build to drop entries
   * whose panel this install does not have. */
  function specTargets(spec) {
    const out = [];
    Object.keys(STEP_SEL).forEach((k) => { if (spec && spec[k]) out.push(STEP_SEL[k](spec[k])); });
    if (spec && spec.filter) out.push('#' + spec.filter.id);
    return out;
  }

  const st = () => (typeof currentState !== 'undefined' && currentState) ? currentState : {};

  // The panel index. `k` is extra search vocabulary and is never displayed. `to` is the
  // destination spec (see nav()); entries whose target does not exist on this install are dropped
  // at build time rather than shipping a result that goes nowhere.
  const FEATURES = [
    // Graphics scenes (Dashboard ▸ Graphics hub)
    { n: 'Break / Starting Soon', w: 'Graphics', k: 'countdown timer standby intermission starting soon brb bottom bar replay', to: { gfx: 'break' } },
    { n: 'Team Intro / Line-up', w: 'Graphics', k: 'lineup line-up starting roster real names footer lower third', to: { gfx: 'intro' } },
    { n: 'Ticker', w: 'Graphics', k: 'crawl scores news bottom line lower third strap sponsor', to: { gfx: 'ticker' } },
    { n: 'Desk Show', w: 'Graphics', k: 'preshow panel casters desk hosts', to: { gfx: 'preshow' } },
    { n: 'Matchup', w: 'Graphics', k: 'head to head versus vs pre-match preview real names players', to: { gfx: 'matchup' } },
    { n: 'Map Pool / Veto', w: 'Graphics', k: 'veto ban pick maps mapscreen series', to: { gfx: 'veto' } },
    { n: 'Draft Board', w: 'Graphics', k: 'draft pick ban champion hero lol champselect', to: { gfx: 'draft' } },
    { n: 'Winner', w: 'Graphics', k: 'winner champion victory congratulations', to: { gfx: 'winner' } },
    { n: 'Bracket', w: 'Graphics', k: 'bracket tree elimination playoff swiss pools rounds', to: { gfx: 'bracket' } },
    { n: 'Standings', w: 'Graphics', k: 'standings table leaderboard points league placement record', to: { gfx: 'standings' } },
    { n: 'Schedule / Upcoming', w: 'Graphics', k: 'schedule upcoming next matches board', to: { gfx: 'schedule' } },
    { n: 'Spotlight', w: 'Graphics', k: 'spotlight player spotlight team spotlight watchlist teams to watch stat card', to: { gfx: 'spotlight' } },
    { n: 'Stream Credits', w: 'Graphics', k: 'credits roll thanks for watching staff supporters outro sponsors', to: { gfx: 'credits' } },
    // Production panes
    { n: 'Deck', w: 'Dashboard', k: 'deck buttons grid stream deck board triggers cockpit production', to: { tab: 'principal' } },
    { n: 'Match \u2014 Teams & Scorecard', w: 'Dashboard', k: 'match teams score series best of bo3 bo5 blue orange swap smash stocks scoreboard scorecard', to: { tab: 'principal' } },
    { n: 'Rundown / Run of Show', w: 'Production', k: 'rundown run of show segments order', to: { prod: 'rundown' } },
    { n: 'Flows', w: 'Production', k: 'flows automation macro actions triggers', to: { prod: 'flows' } },
    { n: 'Hotkeys', w: 'Production', k: 'hotkeys keyboard shortcuts keys bindings', to: { prod: 'hotkeys' } },
    { n: 'NEURAL AI / Director', w: 'Production', k: 'ai director auto switch shield neural', to: { prod: 'director' } },
    // Dashboard
    { n: 'Show Deck (tonight\u2019s desk)', w: 'Dashboard', k: 'show deck shift preset casters slots allocation handover roles rotation', to: { dash: 'showdeck' } },
    { n: 'Game Settings', w: 'Dashboard', k: 'game settings rocket league hud overlay style scoreboard style replay style overtime sponsor slots player cams smash stocks fighters tokon format layout', to: { tab: 'principal', flash: 'game-settings-section' } },
    { n: 'Sponsors (desk footer)', w: 'Dashboard', k: 'sponsors desk footer lower third logos active brand ad slots', to: { tab: 'principal', flash: 'adslot-footer' } },
    { n: 'On-Air Talent', w: 'Dashboard', k: 'hosts monitor talent connection status cams live on air', to: { dash: 'hosts' } },
    { n: 'Player Cams', w: 'Dashboard', k: 'players cams in-game player cam mapping', to: { dash: 'players' } },
    { n: 'Team Staging', w: 'Dashboard', k: 'staging teams hosts waiting', to: { dash: 'staging' } },
    { n: 'Lobby / Waiting Room', w: 'Dashboard', k: 'lobby waiting room guests green room', to: { dash: 'lobby' } },
    { n: 'Stream Queue', w: 'Dashboard', k: 'stream queue startgg live next sets push auto follow on deck order', to: { tab: 'principal', flash: 'ev-queue-block' } },
    // Esports
    // Leagues and tournaments are run on the Nameless website; the Event page lists them with your
    // start.gg tournaments (site-events.js). The old in-app Competitions / Leagues pages are retired.
    { n: 'Your events', w: 'Event', k: 'events leagues league tournaments tournament competitions season standings schedule fixtures website nameless startgg start.gg load event my events', to: { mx: { tab: 'principal', view: 'event' }, flash: 'sev-hub' } },
    { n: 'Other platforms (start.gg, Challonge, FACEIT, NXGEN, Sheets)', w: 'Event', k: 'startgg start.gg challonge faceit nxgen challengermode google sheet feed import platform', to: { mx: { tab: 'principal', view: 'event' }, flash: 'ev-platform-tabs' } },
    { n: 'Event Ops', w: 'Analytics', k: 'event ops checklist operations tasks check-in csv spreadsheet seeding challonge mirror', to: { stats: 'eventops' } },
    // Talent / cameras
    { n: 'Teams & Rosters', w: 'Talent', k: 'teams roster players logos import csv export library', to: { talent: 'teams', talentSub: 'saved' } },
    { n: 'Event Roster', w: 'Talent', k: 'event teams roster entrants', to: { talent: 'teams', talentSub: 'event' } },
    { n: 'Crew / Talent Profiles', w: 'Talent', k: 'crew casters host observer profiles staff country social gamertag', to: { talent: 'crew' } },
    { n: 'Camera Feeds', w: 'Production', k: 'cameras vdo ninja feeds rooms invite links talent rooms observers stations', to: { prod: 'cameras' } },
    // Video editor
    { n: 'Replay Studio', w: 'Replays', k: 'replays replay studio player capture clips trim video editor highlights playlists montage buffer instant replay', to: { replays: 'editor' } },
    { n: 'Exports', w: 'Replays', k: 'export render encode mp4', to: { replays: 'exports' } },
    // Assets
    { n: 'Media Library', w: 'Assets', k: 'media images assets uploads library stingers', to: { assets: 'media' } },
    { n: 'Scene / Overlay Sources', w: 'Assets', k: 'scenes overlays browser source url obs background fill opacity edit html preview', to: { assets: 'overlays' } },
    { n: 'Brand Kits & Producer Profiles', w: 'Assets', k: 'brand kit sponsors packages logo colours colors profile export zip', to: { assets: 'profiles' } },
    // Analytics
    { n: 'Analytics Overview', w: 'Analytics', k: 'analytics overview stats dashboard', to: { stats: 'overview' } },
    { n: 'Broadcasts', w: 'Analytics', k: 'broadcasts sessions history streams', to: { stats: 'broadcasts' } },
    { n: 'Audience', w: 'Analytics', k: 'audience viewers twitch followers chat', to: { stats: 'audience' } },
    { n: 'Event Stats', w: 'Analytics', k: 'event results stats records head to head', to: { stats: 'event' } },
    { n: 'Player Stats', w: 'Analytics', k: 'player stats search history goals assists saves', to: { stats: 'players' } },
    // Marketplace
    { n: 'Twitch', w: 'Marketplace', k: 'twitch chat predictions polls alerts clips ads commands bot', to: { integ: 'twitch' } },
    { n: 'Tournament Platforms', w: 'Marketplace', k: 'startgg challonge nxgen faceit api token connect', to: { integ: 'tournaments' } },
    { n: 'Cameras / VDO', w: 'Marketplace', k: 'vdo ninja cameras api key stations', to: { integ: 'cameras' } },
    { n: 'Switcher (OBS / vMix)', w: 'Marketplace', k: 'obs vmix websocket switcher connect scenes audio sources mute setup', to: { integ: 'switcher' } },
    { n: 'Game setup', w: 'Settings', k: 'games setup connection gsi stats api overlay layout browser source automation scoring maps roles characters custom content rl cs2 valorant league apex fortnite', to: { settings: 'games' } },
    { n: 'Integrations', w: 'Marketplace', k: 'integrations store apps connect platforms browse', to: { integ: 'store' } },
    { n: 'Plugins', w: 'Marketplace', k: 'plugins marketplace store buy sell extensions addons community packages', to: { integ: 'plugins' } },
    { n: 'API', w: 'Marketplace', k: 'api key developers websocket custom overlay build sdk rest endpoints feed format google sheet columns bot script', to: { integ: 'api' } },
    { n: 'Chat Games', w: 'Marketplace', k: 'chat games minigames wheel predictions viewers', to: { tab: 'integrations', flash: 'integration-chatgames' } },
    // Quick rail
    { n: 'Quick Rail \u2014 On Air', w: 'Quick rail', k: 'quick on air 2air cockpit put on air punch', to: { rail: 'quick' } },
    { n: 'Quick Rail \u2014 Next / Rundown', w: 'Quick rail', k: 'rundown segments run of show next', to: { rail: 'ros' } },
    { n: 'Quick Rail \u2014 Auto / Flows', w: 'Quick rail', k: 'auto flows automation macros', to: { rail: 'flows' } },
    { n: 'Quick Rail \u2014 Talent', w: 'Quick rail', k: 'talent casters desk lineup', to: { rail: 'talent' } },
    { n: 'Quick Rail \u2014 Replay', w: 'Quick rail', k: 'replay buffer instant clip', to: { rail: 'replay' } },
    { n: 'Quick Rail \u2014 Stream / Chat', w: 'Quick rail', k: 'stream twitch chat multichat highlight feature message', to: { rail: 'twitch' } },
    { n: 'Quick Rail \u2014 Notes', w: 'Quick rail', k: 'notes scratchpad reminders', to: { rail: 'notes' } },
    // Settings (scroll-to)
    { n: 'Walkthroughs', w: 'Settings', k: 'tour walkthrough help getting started tutorial guide onboarding quick start how to learn', to: { settings: 'general', flash: 'tour-section' } },
    { n: 'Diagnostics / show timeline', w: 'Settings', k: 'diagnostics timeline log logs what happened debug stuck scene frozen wrong score troubleshoot problems errors health status history', to: { settings: 'diagnostics' } },
    { n: 'Appearance & Accent', w: 'Settings', k: 'theme colour color accent appearance dark light mode skin brand look', to: { settings: 'appearance', flash: 'settings-appearance' } },
    { n: 'Broadcast Defaults', w: 'Settings', k: 'default best of series overlay font clock defaults auto reload', to: { settings: 'broadcast', flash: 'settings-broadcast-defaults' } },
    { n: 'Rocket League Automation', w: 'Settings', k: 'rl rocket league kickoff scene scoreboard replay transitions stats api pause auto save replay clip each goal post game cut casters after scoreboard', to: { game: 'rocket-league:automation' } },
    { n: 'Replays & Clips', w: 'Settings', k: 'replay buffer clips montage encoder folders staging', to: { settings: 'replays', flash: 'set-sec-replays' } },
    { n: 'Brand Kits', w: 'Settings', k: 'brand kit sponsors packages logo colours colors', to: { settings: 'brandkits', flash: 'set-sec-brandkits' } },
    { n: 'Settings', w: 'Settings', k: 'settings preferences options organization org cloud account update bug report tour getting started', to: { tab: 'ajustes' } },
    { n: 'Roles & Permissions', w: 'Roles', k: 'roles permissions seats org members access', to: { tab: 'roles' } }
  ];
  FEATURES.forEach((f) => { f.group = 'Panels'; f.go = function () { nav(f.to); }; });

  /* A result that goes nowhere is worse than no result, so the index is filtered against the DOM
   * once at startup: an entry whose destination control is missing (a pane this build doesn't
   * ship, a sub-nav key that got renamed) is dropped rather than offered. `filter` targets are
   * NOT checked here — a filter box is a nice-to-have refinement, and its page is verified by the
   * step before it. */
  function reachable(spec) {
    const sel = specTargets(spec).filter((x) => !spec.filter || x !== '#' + spec.filter.id);
    return sel.every((x) => !!document.querySelector(x));
  }
  const LIVE_FEATURES = FEATURES.filter((f) => reachable(f.to));
  // Graphics scenes the panel index already names — the overlays provider skips these.
  const FEATURE_GFX = new Set(LIVE_FEATURES.map((f) => f.to && f.to.gfx).filter(Boolean));

  /* Console diagnostic: `__navsearchAudit()` lists every index entry and whether its destination
   * resolves right now. This exists because the dead entries it finds are invisible otherwise —
   * they look like a working result until you click one. */
  window.__navsearchAudit = function () {
    const rows = FEATURES.map((f) => {
      const missing = specTargets(f.to).filter((sel) => !document.querySelector(sel));
      return { name: f.n, where: f.w, target: JSON.stringify(f.to), ok: !missing.length, missing: missing.join(' ') };
    });
    const bad = rows.filter((r) => !r.ok);
    console.table(rows);
    console.log('[navsearch] ' + (rows.length - bad.length) + '/' + rows.length + ' destinations resolve'
      + (bad.length ? '; unreachable: ' + bad.map((b) => b.name).join(', ') : ''));
    return rows;
  };


  /* ── Live content providers ───────────────────────────────────────────────────────────────
   * Each returns rows shaped like a FEATURE plus `sub` (the dim second line). They run per query
   * — the lists are hundreds of rows, not thousands, and reading state fresh is what keeps search
   * from ever showing a team that was deleted two minutes ago. `cap` bounds the per-source scan so
   * a pathological library can't stall a keystroke. */

  const PROVIDERS = [
    // Saved teams — the single most-searched thing in the app.
    function teams() {
      const list = st().savedTeams || [];
      return list.slice(0, 1200).map((t) => ({
        n: t.name || 'Team',
        sub: (t.players || []).length ? (t.players || []).length + ' players' : 'Team library',
        w: t._org ? 'Org team' : 'Team',
        group: 'Teams',
        k: (t.players || []).map((p) => (typeof p === 'string' ? p : (p && (p.name || p.gamertag)) || '')).join(' '),
        go: () => {
          // The editor is the real destination for a team; the filtered library is the fallback
          // when this build has no editor entry point.
          if (typeof startEditTeam === 'function') { startEditTeam(t); return; }
          nav({ talent: 'teams', talentSub: 'saved', filter: { id: 'teams-search', value: t.name || '' } });
        }
      }));
    },

    // Players, indexed individually so a gamertag finds the roster it sits on.
    function players() {
      const out = [];
      (st().savedTeams || []).forEach((t) => {
        (t.players || []).forEach((p) => {
          const name = typeof p === 'string' ? p : ((p && (p.name || p.gamertag)) || '');
          if (!name) return;
          out.push({
            n: name,
            sub: t.name || 'Unassigned',
            w: (p && p.role) || 'Player',
            group: 'Players',
            k: (t.name || '') + ' ' + ((p && p.gamertag) || '') + ' ' + ((p && p.role) || ''),
            go: () => {
              if (typeof startEditTeam === 'function') { startEditTeam(t); return; }
              nav({ talent: 'teams', talentSub: 'saved', filter: { id: 'teams-search', value: name } });
            }
          });
        });
      });
      return out.slice(0, 3000);
    },

    // Crew profiles + the caster library (two stores, one mental model: "people who work the show").
    function people() {
      const out = [];
      // The stored group is a raw key ('casters'); the chip needs the word a producer would use.
      const GROUP_LABEL = { casters: 'Caster', guests: 'Guest', observers: 'Observer', hosts: 'Host', crew: 'Crew' };
      (st().crew || []).forEach((c) => {
        if (!c || !c.name) return;
        out.push({
          n: c.name,
          sub: [c.handle, c.role, c.country].filter(Boolean).join(' · ') || 'Crew',
          w: GROUP_LABEL[c.group] || c.role || 'Crew',
          group: 'People',
          k: [c.handle, c.role, c.socialHandle, c.country, c.notes].filter(Boolean).join(' '),
          go: () => nav({ talent: 'crew', filter: { id: 'crew-search', value: c.name } })
        });
      });
      const lib = (st().casters && st().casters.library) || [];
      lib.forEach((p) => {
        if (!p || !p.name) return;
        out.push({
          n: p.name,
          sub: [p.handle, p.kind].filter(Boolean).join(' · ') || 'Caster library',
          w: p.kind || 'Caster',
          group: 'People',
          k: [p.handle, p.kind, p.country].filter(Boolean).join(' '),
          go: () => nav({ prod: 'cameras', filter: { id: 'caster-lib-search', value: p.name } })
        });
      });
      return out.slice(0, 2000);
    },

    function leagues() {
      return (st().leagues || []).map((l) => ({
        n: l.name || 'League',
        sub: ((l.teams || []).length) + ' teams' + (l.game ? ' · ' + l.game : ''),
        w: 'League',
        group: 'Events',
        k: (l.teams || []).map((t) => t.teamName || t.name || '').join(' ') + ' ' + (l.season || ''),
        // Leagues come from the website now: open the Event page, where it is listed and loaded.
        go: () => nav({ mx: { tab: 'principal', view: 'event' }, flash: 'sev-hub' })
      }));
    },

    // Whatever tournament/event is currently loaded, plus the saved event list.
    function events() {
      const sg = st().startgg || {};
      const out = [];
      const seen = new Set();
      const add = (name, slug, where) => {
        const key = S.norm(name) + '|' + S.norm(slug);
        if (!name || seen.has(key)) return;
        seen.add(key);
        out.push({ n: name, sub: slug || where, w: 'Event', group: 'Events', k: slug || '', go: () => nav({ ev: 'startgg' }) });
      };
      add(sg.eventName || sg.tournamentName, sg.eventSlug, 'Loaded event');
      (sg.savedEvents || sg.myEvents || []).forEach((e) => e && add(e.name || e.tournamentName, e.slug || e.eventSlug, 'Saved event'));
      return out;
    },

    function flows() {
      return (st().flows || []).map((f) => ({
        n: f.name || 'Flow',
        sub: (f.trigger ? 'on ' + f.trigger : '') + ((f.actions || []).length ? ' · ' + (f.actions || []).length + ' actions' : ''),
        w: f.enabled === false ? 'Off' : 'Flow',
        group: 'Automation',
        k: [f.trigger, (f.actions || []).map((a) => a && (a.type || a.action)).join(' ')].filter(Boolean).join(' '),
        go: () => nav({ prod: 'flows', filter: { id: 'flow-search', value: f.name || '' } })
      }));
    },

    // Clips and montages/playlists from the replay library.
    function clips() {
      const c = st().clips || {};
      const out = [];
      (c.library || []).slice(0, 1500).forEach((x) => {
        if (!x || !x.name) return;
        out.push({
          n: x.name,
          sub: [x.match, x.game, x.player, x.folder === 'highlights' ? 'Highlights' : 'Moments'].filter(Boolean).join(' · ') || 'Clip',
          w: 'Clip', group: 'Replays',
          k: [x.type, x.player, x.game, x.match, x.folder].filter(Boolean).join(' '),
          // Opens the clip in the Replays page player.
          go: () => { nav({ replays: 'editor' }); setTimeout(() => { if (typeof loadClipPreview === 'function') loadClipPreview(x); }, 250); }
        });
      });
      (c.montages || []).slice(0, 400).forEach((m) => {
        if (!m || !m.name) return;
        out.push({
          n: m.name,
          sub: ((m.clips || []).length) + ' clips' + (m.folder ? ' · ' + m.folder : ''),
          w: 'Playlist', group: 'Replays',
          k: m.folder || '',
          go: () => nav({ replays: 'editor', text: { sel: '.rp-pl-card, .playlist-card', value: m.name } })
        });
      });
      return out;
    },

    function brandKits() {
      return (st().brandKits || []).map((b) => ({
        n: b.name || 'Brand kit',
        sub: ((b.packages || []).length) + ' packages',
        w: 'Brand kit', group: 'Assets',
        k: (b.packages || []).map((p) => p && p.name).filter(Boolean).join(' '),
        go: () => nav({ assets: 'profiles', text: { sel: '.bk-card, .brandkit-card', value: b.name || '' } })
      }));
    },

    // Live OBS scenes, sources and audio inputs — searching "cam 2" should reach the source.
    // They land on the Dashboard deck, which is where scenes/audio/sources are driven from.
    function obs() {
      const o = st().obs || {};
      const out = [];
      (o.availableScenes || []).forEach((s) => out.push({
        n: s, sub: (o.currentScene === s ? 'On air' : 'OBS scene'), w: 'Scene', group: 'Dashboard',
        k: 'obs scene', go: () => nav({ tab: 'principal' })
      }));
      (o.audioInputs || []).forEach((a) => a && a.name && out.push({
        n: a.name, sub: a.muted ? 'Muted' : 'Audio input', w: 'Audio', group: 'Dashboard',
        k: 'obs audio volume mute', go: () => nav({ tab: 'principal' })
      }));
      (o.sources || []).slice(0, 800).forEach((s) => s && s.source && out.push({
        n: s.source, sub: s.scene || 'OBS source', w: 'Source', group: 'Dashboard',
        k: 'obs source show hide ' + (s.scene || ''), go: () => nav({ tab: 'principal' })
      }));
      return out;
    },

    // The on-air graphics registry, so every overlay is reachable by its real label even when it
    // was never hand-written into FEATURES.
    function overlays() {
      const ov = (typeof ONAIR_SCENES !== 'undefined' && ONAIR_SCENES) || window.ONAIR_SCENES || [];
      // Two filters:
      //  - ONAIR_SCENES is the on-air registry, which is WIDER than the Graphics board: casters,
      //    upcoming, watchlist, teamspot and banner have no [data-gfxscene] button. Indexing them
      //    shipped five results that switched to Production > Graphics and then clicked nothing.
      //    Checked against the live DOM, so a scene added to the board later appears by itself.
      //  - Anything the panel index already covers is skipped. Both lists name the same scenes
      //    slightly differently ("Break / Countdown" vs "Break / Starting Soon") and they go to
      //    the identical place, so indexing both put a near-duplicate above the real entry.
      return ov.filter((o) => document.querySelector(STEP_SEL.gfx(o.key)) && !FEATURE_GFX.has(o.key)).map((o) => ({
        n: o.label, sub: 'Overlay', w: 'On air', group: 'Graphics',
        k: 'overlay graphic ' + o.key,
        go: () => nav({ gfx: o.key })
      }));
    },

    // Webcam layers of the in-game HUD: the words producers use ("webcams", "facecams", "hide cams")
    // land on the game's Cameras settings with the switch flashed. The Control room's Live now card
    // has the same switches.
    function webcams() {
      const s = st();
      const layers = typeof window.hudLayersFor === 'function' ? window.hudLayersFor(s.activeGame) : [];
      return layers.map((l) => ({
        n: l.label, sub: (l.check(s) ? 'Showing' : 'Hidden') + ' · show / hide', w: 'Webcams', group: 'Graphics',
        k: 'webcam webcams web cam facecam facecams face cam cams camera cameras player cams hud overlay show hide turn off on ' + l.key,
        go: () => nav({ game: s.activeGame + ':' + (l.setup || 'cameras'), flash: l.key === 'replaycams' ? 'check-replay-cams' : 'check-facecams-enabled' })
      }));
    },

    function games() {
      const g = st().games || {};
      return Object.keys(g).map((id) => ({
        n: (g[id] && g[id].name) || id,
        sub: id === st().activeGame ? 'Active game' : 'Game setup',
        w: 'Game', group: 'Assets',
        k: id + ' setup connection overlay maps roles characters config',
        go: () => nav({ game: id })
      }));
    }
  ];

  // Group display order — Panels first because a bare word like "bracket" almost always means the
  // panel, then people/teams, then the bulkier libraries.
  const GROUP_ORDER = ['Panels', 'Graphics', 'Teams', 'People', 'Players', 'Events', 'Replays', 'Automation', 'Switcher', 'Assets'];
  const GROUP_CAP = { Players: 6, Replays: 6, Switcher: 6, Assets: 5 };
  const DEFAULT_CAP = 8;
  const TOTAL_CAP = 28;

  /* ── Recents: a small frecency table so the panels a producer actually uses float up.
   * Score decays by halving weekly, so last month's habit stops outranking this week's. ── */
  const RECENT_KEY = 'ne_navsearch_recent_v2';
  let recents = {};
  try { recents = JSON.parse(localStorage.getItem(RECENT_KEY) || '{}') || {}; } catch (e) { recents = {}; }

  const WEEK = 7 * 24 * 3600 * 1000;
  function recentScore(key) {
    const r = recents[key];
    if (!r) return 0;
    const age = Math.max(0, Date.now() - (r.t || 0));
    return (r.c || 0) * Math.pow(0.5, age / WEEK);
  }
  function noteUse(key) {
    const r = recents[key] || { c: 0, t: 0 };
    recents[key] = { c: recentScore(key) + 1, t: Date.now() };
    // Keep the table small — 60 entries is far more than anyone's working set.
    const keys = Object.keys(recents);
    if (keys.length > 60) {
      keys.sort((a, b) => recentScore(b) - recentScore(a)).slice(60).forEach((k) => delete recents[k]);
    }
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recents)); } catch (e) {}
  }
  const keyOf = (r) => r.group + '|' + r.n + '|' + (r.sub || '');

  // ── Query ──
  function collect() {
    const rows = LIVE_FEATURES.slice();
    for (let i = 0; i < PROVIDERS.length; i++) {
      try {
        const got = PROVIDERS[i]();
        for (let j = 0; j < got.length; j++) if (got[j] && got[j].n) rows.push(got[j]);
      } catch (e) { /* a malformed slice of state must never break the whole box */ }
    }
    return rows;
  }

  function fieldsOf(r) {
    return [
      { text: r.n, weight: 2 },        // the display name carries the query — fuzzy/typo allowed
      // Only the NAME gets fuzzy matching. The other three are context, not identity: the second
      // line, the chip and the keyword bag match on substrings only. Letting a subsequence run
      // over them made "veto" pull in the words "Video Editor", every keyword list in the index,
      // and one OBS scene's worth of child sources through their parent's name.
      { text: r.sub, weight: 1, fuzzy: false },
      { text: r.w, weight: 0.8, fuzzy: false },
      { text: r.k, weight: 0.75, bag: true }
    ];
  }

  function query(q) {
    const rows = collect();
    const rank = (opts) => {
      const hits = [];
      for (let i = 0; i < rows.length; i++) {
        const s = S.score(q, fieldsOf(rows[i]), opts);
        if (s < 0) continue;
        // Frecency is a nudge, not an override — it reorders near-ties without letting a stale
        // favourite outrank a much better textual match.
        hits.push({ r: rows[i], s: s + Math.min(60, recentScore(keyOf(rows[i])) * 12) });
      }
      return hits;
    };
    // Strict first (every word must land), and only if that finds nothing, retry accepting rows
    // that match some of the words. "dark mode" used to return an empty panel because nothing
    // contains the word "mode" — an empty result reads as "this app has no dark mode", which is
    // both wrong and the kind of thing a producer stops trusting the box over.
    let hits = rank(null);
    if (!hits.length) hits = rank({ any: true });
    hits.sort((a, b) => (b.s - a.s) || a.r.n.localeCompare(b.r.n));

    // Interleave by group so one huge library can't crowd everything else out of the panel.
    const byGroup = {};
    hits.forEach((h) => { (byGroup[h.r.group] || (byGroup[h.r.group] = [])).push(h); });
    const order = GROUP_ORDER.filter((g) => byGroup[g]).concat(
      Object.keys(byGroup).filter((g) => GROUP_ORDER.indexOf(g) === -1).sort()
    );
    // Groups whose best hit is stronger come first, so typing a team name doesn't bury Teams
    // under Panels just because Panels is listed first.
    order.sort((a, b) => byGroup[b][0].s - byGroup[a][0].s);

    const out = [];
    for (let g = 0; g < order.length && out.length < TOTAL_CAP; g++) {
      const cap = GROUP_CAP[order[g]] || DEFAULT_CAP;
      const take = byGroup[order[g]].slice(0, cap);
      out.push({ header: order[g], total: byGroup[order[g]].length, shown: take.length });
      for (let i = 0; i < take.length && out.length < TOTAL_CAP + order.length; i++) out.push(take[i].r);
    }
    return out;
  }

  // With an empty box, show what this producer reaches for most — an empty popover teaches nothing.
  function recentRows() {
    const rows = collect();
    const byKey = {};
    rows.forEach((r) => { byKey[keyOf(r)] = r; });
    const picks = Object.keys(recents)
      .filter((k) => byKey[k])
      .sort((a, b) => recentScore(b) - recentScore(a))
      .slice(0, 8)
      .map((k) => byKey[k]);
    if (!picks.length) return [];
    return [{ header: 'Recent', total: picks.length, shown: picks.length }].concat(picks);
  }

  // ── Render ──
  let rows = [];        // flat list of headers + results, in display order
  let items = [];       // indices into `rows` that are selectable
  let active = 0;

  function place() {
    const r = input.getBoundingClientRect();
    const w = panel.offsetWidth || 330;
    panel.style.top = (r.bottom + 6) + 'px';
    panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
  }

  function close() {
    panel.hidden = true;
    rows = []; items = []; active = 0;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function paint(q) {
    if (!rows.length) {
      panel.innerHTML = '<div class="navsearch-empty">Nothing matches that. Try a team, a caster, a scene or a panel name.</div>';
      return;
    }
    let html = '';
    items = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.header) {
        html += '<div class="navsearch-group" role="presentation">' + esc(r.header)
          + (r.total > r.shown ? '<span class="navsearch-more">' + r.shown + ' of ' + r.total + '</span>' : '')
          + '</div>';
        continue;
      }
      const idx = items.length;
      items.push(i);
      html += '<button type="button" role="option" id="navsearch-opt-' + idx + '"'
        + ' class="navsearch-item' + (idx === active ? ' is-active' : '') + '" data-i="' + idx + '"'
        + ' aria-selected="' + (idx === active) + '">'
        + '<span class="navsearch-main">'
          + '<b>' + S.highlight(r.n, q) + '</b>'
          + (r.sub ? '<i class="navsearch-sub">' + S.highlight(r.sub, q) + '</i>' : '')
        + '</span>'
        + '<span class="navsearch-where">' + esc(r.w) + '</span>'
        + '</button>';
    }
    panel.innerHTML = html;
    panel.querySelectorAll('.navsearch-item').forEach((b) => {
      // mousedown, not click: the input's blur handler closes the panel before a click would land.
      b.addEventListener('mousedown', (e) => { e.preventDefault(); run(Number(b.dataset.i)); });
      // Hovering moves the selection, so the mouse and the arrow keys never disagree about
      // what Enter will do.
      b.addEventListener('mouseenter', () => { active = Number(b.dataset.i); syncActive(); });
    });
    syncActive();
  }

  function syncActive() {
    const nodes = panel.querySelectorAll('.navsearch-item');
    nodes.forEach((n, i) => {
      const on = i === active;
      n.classList.toggle('is-active', on);
      n.setAttribute('aria-selected', String(on));
      if (on) {
        input.setAttribute('aria-activedescendant', n.id);
        // Keep the keyboard selection visible in a scrolled popover.
        const top = n.offsetTop, bot = top + n.offsetHeight;
        if (top < panel.scrollTop) panel.scrollTop = top - 4;
        else if (bot > panel.scrollTop + panel.clientHeight) panel.scrollTop = bot - panel.clientHeight + 4;
      }
    });
  }

  function run(i) {
    const r = rows[items[i]];
    if (!r) return;
    noteUse(keyOf(r));
    close();
    input.value = '';
    input.blur();
    try { r.go(); } catch (err) { console.error('[navsearch] navigation failed', err); }
  }

  function search() {
    const q = input.value.trim();
    rows = q ? query(q) : recentRows();
    active = 0;
    if (!q && !rows.length) { close(); return; }
    panel.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    paint(q);
    place();
  }

  // Content search scans a few thousand rows per keystroke — a short debounce keeps a big library
  // from making the box feel sticky while still reading as instant.
  let timer = null;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 70); });
  input.addEventListener('focus', search);
  input.addEventListener('blur', () => setTimeout(close, 140));
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', 'navsearch-results');
  panel.setAttribute('role', 'listbox');

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { clearTimeout(timer); input.value = ''; close(); input.blur(); return; }
    if (panel.hidden || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; syncActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; syncActive(); }
    else if (e.key === 'Home') { e.preventDefault(); active = 0; syncActive(); }
    else if (e.key === 'End') { e.preventDefault(); active = items.length - 1; syncActive(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); run(active); }
  });
  window.addEventListener('resize', () => { if (!panel.hidden) place(); });

  // Ctrl/Cmd+K from anywhere — except while typing in another field, where it would steal the key.
  document.addEventListener('keydown', (e) => {
    if (!(e.key === 'k' || e.key === 'K') || !(e.ctrlKey || e.metaKey)) return;
    const ae = document.activeElement;
    if (ae && ae !== input && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
    if (ae && ae !== input && ae.isContentEditable) return;
    e.preventDefault();
    // A collapsed rail leaves no room to type — expand it first so the box is usable.
    if (document.querySelector('.app-shell.collapsed')) {
      const c = document.getElementById('sidebar-collapse');
      if (c) c.click();
    }
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
})();
