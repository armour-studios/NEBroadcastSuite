/* ─── Shared scene bootstrap — connects ported broadcast scenes to the WS bridge ───
 *
 * Ported from the EsportsDashBoard HTML packs, which polled localhost:8080/getFullJson.
 * Here every scene instead subscribes to NE Broadcast Suite's WS bridge (:3001) and renders
 * from `full_state` — the same data model the HUD/bracket/caster scenes already use.
 *
 *   SceneBase.connect(state => { ...render... })
 *
 * Before the callback runs we apply the active Brand Kit (accent colours + font) to CSS
 * vars so every scene recolours per client with no extra code. Read helpers:
 *   SceneBase.brandColor(state)  -> primary accent (brand colour or --accent)
 *   SceneBase.brandAccent(state) -> secondary accent
 *   SceneBase.teamSide(state, 'blue'|'orange') -> { name, logo, color, players }
 *   SceneBase.qp(name)           -> URL query param (scenes accept ?team=, ?style=, etc.)
 */
(function (global) {
  // Host-aware: a source loaded from another machine (http://<host>:3000) keeps that host. But
  // 'localhost' is rewritten to 127.0.0.1, because server.js binds 127.0.0.1 ONLY while Windows
  // resolves 'localhost' to ::1 first — and the app's own OBS instructions hand out localhost URLs.
  // HTTP falls back from a refused ::1 to the IPv4 address; a WebSocket is not guaranteed to, so a
  // source could sit on its last render for a whole show with no error anywhere.
  const _host = location.hostname;
  const HOST = (!_host || _host === 'localhost') ? '127.0.0.1' : _host;
  const WS_URL = 'ws://' + HOST + ':3001';
  // HTTP must stay SAME-ORIGIN. A scene served from http://localhost:3000 that fetches
  // http://127.0.0.1:3000 is cross-origin (the host string is part of the origin), and only a few
  // routes send CORS headers — so the fetch is blocked. Only a file:// preview needs an absolute base.
  const HTTP_BASE = /^https?:$/.test(location.protocol) ? location.origin : 'http://127.0.0.1:3000';
  const FALLBACK_ACCENT = '#055fdb';
  const FALLBACK_ACCENT2 = '#e97139';

  function qp(name) {
    return new URLSearchParams(global.location.search).get(name);
  }

  // Preview mode: open any scene with ?preview=1 to render sample data, ignoring the
  // on-air visibility gate — for styling/positioning in OBS before going live.
  const PREVIEW = qp('preview') === '1' || qp('preview') === 'true';

  // Thumbnail mode (?thumb=1): scale the whole page to fill the iframe viewport.
  // Uses CSS zoom on <body> so layout collapses to the visual size — no overflow fights.
  if (qp('thumb') === '1') {
    var _applyThumb = function() {
      var w = global.innerWidth;
      if (!w || !document.body) return;
      document.body.style.zoom = (w / 1920);
      document.documentElement.style.overflow = 'hidden';
    };
    _applyThumb();
    global.addEventListener('resize', _applyThumb);
    document.addEventListener('DOMContentLoaded', _applyThumb);
  }

  // Two-line name plate (see applyNamePlate) — the gamertag with the org under it on head-to-head
  // games. Injected here rather than pasted into all ten camera scenes' <style> blocks: one
  // definition, and every rule is scoped to .has-sub so a plate showing a plain team name renders
  // exactly as before. Sizes are em-based so the second line tracks each scene's own plate size.
  (function injectPlateCss() {
    var css = '.match-name.has-sub{display:flex;flex-direction:column;justify-content:center;gap:.06em;overflow:visible;}'
      + '.match-name.has-sub .plate-main,.match-name.has-sub .plate-sub{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
      + '.match-name.has-sub .plate-sub{font-size:.42em;font-weight:700;letter-spacing:.12em;opacity:.6;text-shadow:none;}'
      + '.match-team--b .match-name.has-sub{align-items:flex-end;}';
    var mount = function () {
      if (document.getElementById('sb-plate-css')) return;
      var st = document.createElement('style');
      st.id = 'sb-plate-css';
      st.textContent = css;
      (document.head || document.documentElement).appendChild(st);
    };
    if (document.head) mount(); else document.addEventListener('DOMContentLoaded', mount);
  })();

  // The per-scene background wash (?bg=RRGGBB&bgop=0-100, plus live sceneBg updates) lives in
  // scene-bg.js, which the server injects into EVERY served overlay — including the many that never
  // load this file. When a scene is opened straight off disk (file://, e.g. a developer previewing
  // a layout) there is no server to inject it, so fall back to the URL-param pass here. Guarded on
  // SceneBg's absence so the injected script stays the single implementation in production.
  (function applyBgParamFallback() {
    if (global.SceneBg) return;
    var bg = qp('bg');
    var op = parseFloat(qp('bgop'));
    if (!bg || !(op > 0)) return;
    var hex = bg.replace(/^#/, '');
    if (!/^[0-9a-fA-F]{3,8}$/.test(hex)) return;
    var div = document.createElement('div');
    div.id = 'scene-bg-wash';
    div.style.cssText = 'position:fixed;inset:0;z-index:-9999;pointer-events:none;background:#' + hex + ';opacity:' + Math.min(1, op / 100) + ';';
    var mount = function () { var p = document.body || document.documentElement; if (p && !document.getElementById('scene-bg-wash')) p.insertBefore(div, p.firstChild); };
    if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  })();

  // Small valid placeholder logo so previews aren't broken images.
  function svgLogo(letter, color) {
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" rx="22" fill="${color}"/><text x="80" y="108" font-size="86" fill="#fff" text-anchor="middle" font-family="Arial,sans-serif" font-weight="bold">${letter}</text></svg>`);
  }

  // Sample full_state used by ?preview=1. Every visibility flag is on so each scene shows.
  function demoState() {
    return {
      theme: 'default', fontFamily: 'Rajdhani',
      eventName: 'PRO INVITATIONAL — GRAND FINAL',
      brand: { color: '#7c3aed', accent: '#22d3ee', font: 'Rajdhani', logo: svgLogo('J', '#7c3aed'),
        sponsors: [{ name: 'ACME', logo: svgLogo('A', '#0ea5e9'), tier: 'presenting' }], sponsorLabel: 'PARTNERS', sponsorInterval: 6 },
      game: { blueScore: 2, orangeScore: 1, time: 300, number: 3 },
      series: { blue: 2, orange: 1 }, bestOf: 5,
      seriesStats: { enabled: true, visible: true, design: 'table', liveBanked: false, games: [
        { number: 1, blueScore: 3, orangeScore: 2, endedAt: 0, players: [
          { name: 'Aqua', team: 0, score: 512, goals: 2, assists: 1, saves: 3, shots: 5, demos: 1 },
          { name: 'Nova', team: 0, score: 331, goals: 1, assists: 2, saves: 1, shots: 3, demos: 0 },
          { name: 'Rhythm', team: 0, score: 288, goals: 0, assists: 1, saves: 4, shots: 2, demos: 2 },
          { name: 'Blaze', team: 1, score: 402, goals: 1, assists: 1, saves: 2, shots: 4, demos: 0 },
          { name: 'Cinder', team: 1, score: 356, goals: 1, assists: 0, saves: 3, shots: 3, demos: 1 },
          { name: 'Ash', team: 1, score: 240, goals: 0, assists: 2, saves: 2, shots: 1, demos: 0 } ] },
        { number: 2, blueScore: 1, orangeScore: 4, endedAt: 0, players: [
          { name: 'Aqua', team: 0, score: 298, goals: 1, assists: 0, saves: 2, shots: 4, demos: 0 },
          { name: 'Nova', team: 0, score: 245, goals: 0, assists: 1, saves: 3, shots: 2, demos: 1 },
          { name: 'Rhythm', team: 0, score: 210, goals: 0, assists: 0, saves: 2, shots: 1, demos: 0 },
          { name: 'Blaze', team: 1, score: 588, goals: 3, assists: 1, saves: 1, shots: 6, demos: 2 },
          { name: 'Cinder', team: 1, score: 410, goals: 1, assists: 2, saves: 2, shots: 3, demos: 0 },
          { name: 'Ash', team: 1, score: 302, goals: 0, assists: 1, saves: 4, shots: 2, demos: 1 } ] }
      ] },
      teams: {
        blue:   { name: 'FROST ESPORTS', color: '#3b82f6', logo: svgLogo('F', '#3b82f6'),
          players: [{ name: 'Aqua', platformId: 'aqua' }, { name: 'Nova', platformId: 'nova' }, { name: 'Rhythm', platformId: 'rhythm' }] },
        orange: { name: 'EMBER GAMING', color: '#f97316', logo: svgLogo('E', '#f97316'),
          players: [{ name: 'Blaze', platformId: 'blaze' }, { name: 'Cinder', platformId: 'cinder' }, { name: 'Ash', platformId: 'ash' }] }
      },
      casters: { visible: true, lowerThird: 'Grand Final — Best of 5', list: [
        { id: '1', name: 'Jordan Reyes', handle: '@jreyescasts', camUrl: '', slot: 1, social: 'x' },
        { id: '2', name: 'Mia Tanaka', handle: 'miaplays', camUrl: '', slot: 2, social: 'twitch' },
        { id: '3', name: 'Sam Okoye', handle: '@samok', camUrl: '', slot: 3, social: 'youtube' } ] },
      breakScreen: { visible: true, title: 'STARTING SOON', message: 'Grand Final begins shortly', endsAt: Date.now() + 125000, finalMessage: "WE'RE LIVE!" },
      winner: { visible: true, side: 'blue', name: '', logo: null, color: '', subtitle: '2026 Spring Champions' },
      veto: { visible: true, title: 'Grand Final — Map Veto', maps: [
        { name: 'Mirage', mode: 'CS2', action: 'ban', by: 'a' },
        { name: 'Inferno', mode: 'CS2', action: 'ban', by: 'b' },
        { name: 'Nuke', mode: 'CS2', action: 'pick', by: 'a', winner: 'a', score: { a: 13, b: 9 } },
        { name: 'Ancient', mode: 'CS2', action: 'pick', by: 'b' },
        { name: 'Anubis', mode: 'CS2', action: 'decider' } ] },
      intro: { visible: true, side: 'blue', title: 'STARTING LINE-UP', style: 1 },
      owMatch: { visible: true, format: 'FT3', currentMapIdx: 1,
        bansByMap: [
          { a: { hero: 'Ana',    role: 'Support' }, b: { hero: 'Genji',   role: 'Damage' } },
          { a: { hero: 'Mercy',  role: 'Support' }, b: { hero: 'Tracer',  role: 'Damage' } }
        ] },
      veto: { visible: true, title: 'Grand Final — Map Veto', maps: [
        { name: "King's Row",    mode: 'Hybrid',  type: 'Hybrid',  action: 'pick', by: 'a', winner: 'a', score: { a: 2, b: 1 } },
        { name: 'Ilios',         mode: 'Control', type: 'Control', action: 'pick', by: 'b' },
        { name: 'Circuit Royal', mode: 'Escort',  type: 'Escort',  action: 'pick', by: 'a' },
        { name: 'Colosseo',      mode: 'Push',    type: 'Push',    action: 'pick', by: 'b' },
        { name: 'Suravasa',      mode: 'Flashpoint', type: 'Flashpoint', action: 'decider' } ] },
      // Bracket + upcoming + stream-queue demo data (for ?preview=1 / scene thumbnails).
      startgg: (function () {
        const L = (l, c) => svgLogo(l, c);
        const logoMap = {
          'frost esports': L('F', '#3b82f6'), 'ember gaming': L('E', '#f97316'),
          'apex titans': L('A', '#22d3ee'), 'void kings': L('V', '#7c3aed'),
          'storm riders': L('S', '#10b981'), 'neon wolves': L('N', '#ec4899'),
          'solar flare': L('S', '#eab308'), 'iron clad': L('I', '#64748b')
        };
        return {
          logoMap,
          queue: [
            { setId: '1', stream: 'Main Stage', round: 'Semifinal', state: 2, teamA: 'FROST ESPORTS', teamB: 'APEX TITANS', logoA: logoMap['frost esports'], logoB: logoMap['apex titans'], scoreA: 2, scoreB: 1, live: true },
            { setId: '2', stream: 'Main Stage', round: 'Semifinal', state: 1, teamA: 'VOID KINGS', teamB: 'STORM RIDERS', logoA: logoMap['void kings'], logoB: logoMap['storm riders'], scoreA: null, scoreB: null, live: false },
            { setId: '3', stream: 'Stream 2', round: 'Losers Round 2', state: 1, teamA: 'EMBER GAMING', teamB: 'IRON CLAD', logoA: logoMap['ember gaming'], logoB: logoMap['iron clad'], scoreA: null, scoreB: null, live: false },
            { setId: '4', stream: '', round: 'Losers Round 2', state: 1, teamA: 'NEON WOLVES', teamB: 'SOLAR FLARE', logoA: logoMap['neon wolves'], logoB: logoMap['solar flare'], scoreA: null, scoreB: null, live: false }
          ]
        };
      })(),
      upcoming: { visible: true, title: 'SCHEDULE', matches: [] },
      bracket: {
        // A tournament IN FLIGHT: quarterfinals done, one semifinal live (FROST vs EMBER —
        // the demo's on-air pair, so the LIVE badge shows), later rounds still TBD.
        // set.state mirrors start.gg (1=upcoming → dimmed, 2=live, 3=done).
        visible: true, title: 'PRO INVITATIONAL', type: 'DOUBLE_ELIMINATION', activePhaseId: 'p1',
        phases: [{ id: 'p1', name: 'Playoffs' }, { id: 'p2', name: 'Day 2' }],
        winners: [
          { name: 'Quarterfinals', round: 1, sets: [
            { a: { name: 'FROST ESPORTS', score: 3, winner: true },  b: { name: 'NEON WOLVES', score: 1, winner: false }, state: 3 },
            { a: { name: 'EMBER GAMING', score: 3, winner: true },   b: { name: 'APEX TITANS', score: 2, winner: false }, state: 3 },
            { a: { name: 'VOID KINGS', score: 3, winner: true },     b: { name: 'SOLAR FLARE', score: 0, winner: false }, state: 3 },
            { a: { name: 'STORM RIDERS', score: 3, winner: true },   b: { name: 'IRON CLAD', score: 1, winner: false }, state: 3 }
          ] },
          { name: 'Semifinals', round: 2, sets: [
            { a: { name: 'FROST ESPORTS', score: 2 },                b: { name: 'EMBER GAMING', score: 2 }, state: 2 },
            { a: { name: 'VOID KINGS', score: 3, winner: true },     b: { name: 'STORM RIDERS', score: 2, winner: false }, state: 3 }
          ] }
        ],
        losers: [
          { name: 'Losers Round 1', round: -1, sets: [
            { a: { name: 'NEON WOLVES', score: 3, winner: true },    b: { name: 'APEX TITANS', score: 2, winner: false }, state: 3 },
            { a: { name: 'SOLAR FLARE', score: 1, winner: false },   b: { name: 'IRON CLAD', score: 3, winner: true }, state: 3 }
          ] },
          { name: 'Losers Final', round: -2, sets: [
            { a: { name: 'STORM RIDERS', score: 0 },                 b: { name: 'TBD', score: 0 }, state: 1 }
          ] }
        ],
        finals: [
          { name: 'Grand Final', round: 3, sets: [
            { a: { name: 'VOID KINGS', score: 0 },                   b: { name: 'TBD', score: 0 }, state: 1 }
          ] }
        ],
        // Pool-play demo (schedule / standings / head-to-head grid views + ?part= overrides).
        schedule: [
          { name: 'Round 1', round: 1, sets: [
            { a: { name: 'FROST ESPORTS', score: 3, winner: true }, b: { name: 'SOLAR FLARE', score: 1, winner: false }, state: 3 },
            { a: { name: 'EMBER GAMING', score: 3, winner: true },  b: { name: 'IRON CLAD', score: 0, winner: false }, state: 3 },
            { a: { name: 'VOID KINGS', score: 2, winner: false },   b: { name: 'STORM RIDERS', score: 3, winner: true }, state: 3 }
          ] },
          { name: 'Round 2', round: 2, sets: [
            { a: { name: 'FROST ESPORTS', score: 2 },               b: { name: 'EMBER GAMING', score: 2 }, state: 2 },
            { a: { name: 'STORM RIDERS', score: 3, winner: true },  b: { name: 'IRON CLAD', score: 1, winner: false }, state: 3 },
            { a: { name: 'VOID KINGS', score: 0 },                  b: { name: 'SOLAR FLARE', score: 0 }, state: 1 }
          ] },
          { name: 'Round 3', round: 3, sets: [
            { a: { name: 'FROST ESPORTS', score: 0 },               b: { name: 'STORM RIDERS', score: 0 }, state: 1 },
            { a: { name: 'EMBER GAMING', score: 0 },                b: { name: 'VOID KINGS', score: 0 }, state: 1 },
            { a: { name: 'SOLAR FLARE', score: 0 },                 b: { name: 'IRON CLAD', score: 0 }, state: 1 }
          ] }
        ],
        standings: [
          { placement: 1, name: 'STORM RIDERS', wins: 2, losses: 0, played: true,  setsPlayed: 2, setsTotal: 3, gameWins: 6, gameLosses: 3 },
          { placement: 2, name: 'FROST ESPORTS', wins: 1, losses: 0, played: true,  setsPlayed: 1, setsTotal: 3, gameWins: 3, gameLosses: 1 },
          { placement: 3, name: 'EMBER GAMING', wins: 1, losses: 0, played: true,  setsPlayed: 1, setsTotal: 3, gameWins: 3, gameLosses: 0 },
          { placement: 4, name: 'VOID KINGS', wins: 0, losses: 1, played: true,   setsPlayed: 1, setsTotal: 3, gameWins: 2, gameLosses: 3 },
          { placement: 5, name: 'SOLAR FLARE', wins: 0, losses: 1, played: true,  setsPlayed: 1, setsTotal: 3, gameWins: 1, gameLosses: 3 },
          { placement: 6, name: 'IRON CLAD', wins: 0, losses: 2, played: true,    setsPlayed: 2, setsTotal: 3, gameWins: 1, gameLosses: 6 }
        ],
        roster: ['STORM RIDERS', 'FROST ESPORTS', 'EMBER GAMING', 'VOID KINGS', 'SOLAR FLARE', 'IRON CLAD'],
        matrix: {
          teams: [
            { id: 't1', name: 'FROST ESPORTS' }, { id: 't2', name: 'EMBER GAMING' },
            { id: 't3', name: 'VOID KINGS' }, { id: 't4', name: 'STORM RIDERS' },
            { id: 't5', name: 'SOLAR FLARE' }, { id: 't6', name: 'IRON CLAD' }
          ],
          cells: {
            't1_t5': { aScore: 3, bScore: 1, winner: 'a', played: true }, 't5_t1': { aScore: 1, bScore: 3, winner: 'b', played: true },
            't2_t6': { aScore: 3, bScore: 0, winner: 'a', played: true }, 't6_t2': { aScore: 0, bScore: 3, winner: 'b', played: true },
            't3_t4': { aScore: 2, bScore: 3, winner: 'b', played: true }, 't4_t3': { aScore: 3, bScore: 2, winner: 'a', played: true },
            't4_t6': { aScore: 3, bScore: 1, winner: 'a', played: true }, 't6_t4': { aScore: 1, bScore: 3, winner: 'b', played: true }
          }
        }
      }
    };
  }

  function applyBrand(data) {
    const root = document.documentElement;
    root.dataset.theme = data.theme || 'default';
    // Brand kit colours first, then Settings font wins for typography.
    const brand = data.brand;
    if (brand) {
      if (brand.color)  root.style.setProperty('--accent', brand.color);
      if (brand.accent) root.style.setProperty('--accent-2', brand.accent);
      if (brand.font)   root.style.setProperty('--main-font', `'${brand.font}', sans-serif`);
    }
    // Settings "Overlay Font" always wins — applied last so it can't be silently
    // overridden by a brand kit that has a stale or unwanted font set.
    if (data.fontFamily) {
      root.style.setProperty('--main-font', `'${data.fontFamily}', sans-serif`);
    }
  }

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  const STANDALONE_CASTER_RE = /\/(casters|duorow|duorow-noscore|triorow|duosinglecam|singlecam|analystspecial|campip|talentbar|interview|quaddesk|quaddesk-noscore|spotlightdesk|vertical|vertical-casters|preshow)\.html$/i;
  const standaloneCasterScene = STANDALONE_CASTER_RE.test(global.location.pathname);
  // State keys a scene has claimed via SceneBase.trustVisibility() — never force-shown (see there).
  const _trustVisible = new Set();
  // Keys a scene has claimed via SceneBase.liveUpdates() — see there. Null = opted out (default).
  let _liveKeys = null;
  let _lastFull = null;

  const SceneBase = {
    qp,
    standaloneCasterScene,
    /** Dedicated OBS caster scenes always render; visibility toggle is for layered overlays only. */
    casterStageVisible(casters) {
      if (PREVIEW || standaloneCasterScene) return true;
      return !!(casters && casters.visible);
    },
    /* ── Server-clock offset ────────────────────────────────────────────────
       The break countdown is an absolute epoch (breakScreen.endsAt) written by the server but
       evaluated by whichever machine is running this browser source. A second OBS box, a caster's
       laptop or a cloud browser whose clock is a few seconds (or minutes) off showed a countdown
       off by exactly that much — the classic "timer is desyncing". Sample /api/time and correct.
       Round-trip is halved out SNTP-style so the sample isn't biased by network latency. */
    _clockSkew: 0,
    async syncClock() {
      try {
        const t0 = Date.now();
        const r = await fetch(HTTP_BASE + '/api/time', { cache: 'no-store' });
        const t1 = Date.now();
        const { now } = await r.json();
        if (typeof now === 'number') this._clockSkew = now - (t0 + (t1 - t0) / 2);
      } catch (e) { /* keep whatever skew we had; a bad sample must not stop the clock */ }
    },
    /** Date.now() corrected to the SERVER's clock. Use this for anything comparing against an
        epoch the server authored (countdown targets, scheduled cuts) — never bare Date.now(). */
    now() { return Date.now() + this._clockSkew; },

    brandColor(data) {
      return (data && data.brand && data.brand.color) || cssVar('--accent', FALLBACK_ACCENT);
    },
    brandAccent(data) {
      return (data && data.brand && data.brand.accent) || cssVar('--accent-2', FALLBACK_ACCENT2);
    },
    brandLogo(data) {
      return (data && data.brand && data.brand.logo) || null;
    },
    /** Lift a colour until it reads against a DARK panel, preserving hue and saturation.
        Scenes with near-black furniture (the countdown bar, the replay desk) paint accent-coloured
        fills and kicker text; a dark brand kit made those vanish into the background. Scaling in
        LINEAR light rather than blending toward white is what keeps the brand identity — mixing
        white turns a deep purple into pale mauve, scaling turns it into a vivid purple.
        Returns the colour unchanged when it's already bright enough. */
    liftForDark(color, minLum) {
      const floor = (minLum == null) ? 0.20 : minLum;
      const c = String(color == null ? '' : color).trim();
      let r, g, b, m;
      if ((m = c.match(/^#([0-9a-f]{3})$/i))) { r = parseInt(m[1][0] + m[1][0], 16); g = parseInt(m[1][1] + m[1][1], 16); b = parseInt(m[1][2] + m[1][2], 16); }
      else if ((m = c.match(/^#([0-9a-f]{6})$/i))) { r = parseInt(m[1].slice(0, 2), 16); g = parseInt(m[1].slice(2, 4), 16); b = parseInt(m[1].slice(4, 6), 16); }
      else if ((m = c.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i))) { r = +m[1]; g = +m[2]; b = +m[3]; }
      else return c;
      const toLin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      const toSrgb = (v) => {
        v = Math.min(1, Math.max(0, v));
        const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
        return Math.round(s * 255);
      };
      const lr = toLin(r), lg = toLin(g), lb = toLin(b);
      const lum = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
      if (lum >= floor) return c;
      if (lum < 0.0008) return '#8b93a8';       // black/near-black has no hue to preserve
      const k = floor / lum;
      return 'rgb(' + toSrgb(lr * k) + ',' + toSrgb(lg * k) + ',' + toSrgb(lb * k) + ')';
    },
    /** Text colour that stays legible ON a filled brand colour. A white/pastel kit used to put
        white text on a white pill (invisible on air); anything mid-to-dark keeps white text, so
        the default palettes look exactly as before. Accepts #rgb, #rrggbb or rgb()/rgba(). */
    onColor(color, dark, light) {
      const c = String(color == null ? '' : color).trim();
      let r = 0, g = 0, b = 0;
      let m = c.match(/^#([0-9a-f]{3})$/i);
      if (m) { r = parseInt(m[1][0] + m[1][0], 16); g = parseInt(m[1][1] + m[1][1], 16); b = parseInt(m[1][2] + m[1][2], 16); }
      else if ((m = c.match(/^#([0-9a-f]{6})$/i))) { r = parseInt(m[1].slice(0, 2), 16); g = parseInt(m[1].slice(2, 4), 16); b = parseInt(m[1].slice(4, 6), 16); }
      else if ((m = c.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i))) { r = +m[1]; g = +m[2]; b = +m[3]; }
      else return light || '#fff';
      const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      return lum > 0.45 ? (dark || '#04121f') : (light || '#fff');
    },
    // Resolve one of the configured RL-style team slots into a normalised shape.
    /** Desk display name: the gamertag/handle by default (casters.nameMode 'gamertag'),
        the crew profile's real name only when the producer switches nameMode to 'name'.
        Applied here centrally so every desk scene inherits it; the original name stays
        available as .fullName for scenes that want both lines. */
    _casterDisplay(casters, c) {
      if (!c) return c;
      const mode = (casters && casters.nameMode) === 'name' ? 'name' : 'gamertag';
      // ONLY the crew gamertag qualifies as a display name — `handle` is the @social
      // username in the caster-card UIs and must never become the on-air first name.
      // No crew gamertag → keep the profile name.
      const tag = (c.gamertag || '').toString().replace(/^@/, '').trim();
      if (mode === 'gamertag' && tag) return Object.assign({}, c, { name: tag, fullName: c.name || '' });
      return c;
    },
    /** Resolve caster assigned to desk slot 1–4 (falls back to list order). */
    casterBySlot(casters, slot) {
      const list = (casters && Array.isArray(casters.list)) ? casters.list : [];
      const n = Number(slot);
      if (!n || n < 1) return null;
      const hit = list.find(c => c && Number(c.slot) === n);
      if (hit) return this._casterDisplay(casters, hit);
      // Positional fallback ONLY for legacy lists where NO caster carries an explicit slot.
      // Once any caster is slotted, resolution is strict so slot 2's caster never bleeds into
      // slot 1 (and an unassigned slot stays empty rather than borrowing the wrong feed).
      const anySlotted = list.some(c => c && Number(c.slot) >= 1);
      if (anySlotted) return null;
      return this._casterDisplay(casters, list[n - 1] || null);
    },
    castersBySlots(casters, count) {
      const out = [];
      for (let i = 1; i <= count; i++) out.push(this.casterBySlot(casters, i));
      return out;
    },
    socialPlatformClass(platform) {
      const p = (platform || 'none').toString().toLowerCase();
      if (p === 'x' || p === 'twitter') return 'x-twitter';
      if (p === 'twitch') return 'twitch';
      if (p === 'youtube') return 'youtube';
      if (p === 'instagram') return 'instagram';
      if (p === 'tiktok') return 'tiktok';
      if (p === 'discord') return 'discord';
      if (p === 'facebook') return 'facebook';
      if (p === 'kick') return 'kick';
      if (p === 'other') return 'link';
      return '';
    },
    formatCasterHandle(caster) {
      // The @-line prefers the dedicated social username (crew socialHandle); the gamertag
      // (`handle`) is only the fallback — the two often differ (gamertag "Jonzey", socials
      // "@ItzJonzey") and the gamertag is already the display name in nameMode 'gamertag'.
      const handle = ((caster && (caster.socialHandle || caster.handle)) || '').toString().trim();
      if (!handle) return '';
      const social = ((caster && caster.social) || 'none').toString().toLowerCase();
      if (social === 'x' && !handle.startsWith('@')) return '@' + handle.replace(/^@/, '');
      return handle;
    },
    /** True when the URL is a built-in game mark (dark on light — needs invert on overlays). */
    isDefaultGameLogo(src) {
      if (!src) return true;
      const s = src.toString();
      return /\/assets\/rl\.png(\?|$)/i.test(s)
        || /\/assets\/games\/[^/]+\.(svg|png)(\?|$)/i.test(s);
    },
    applyTeamLogo(img, src, fallback) {
      if (!img) return;
      const fb = (fallback || '/assets/rl.png').toString().trim();
      const custom = (src || '').toString().trim();
      const url = custom || fb;
      img.src = url;
      img.style.display = '';
      img.classList.toggle('logo-on-dark', !custom || this.isDefaultGameLogo(url));
    },
    /** Head-to-head titles (Smash SINGLES, the FGC games, EA FC) enter one PLAYER per side — the
        "team" record is just that entrant, so a name plate reading the team name prints the entry
        ("RIP TWO-EM, YOU WILL BE MISSED") where the broadcast needs the competitor. Returns
        { name, sub } for those games — the gamertag, with their org/team for the second line — and
        null for squad games so every other scene keeps its team name untouched.
        Smash runs three ways: a crew battle IS a team event (null), doubles prints the PAIR, and
        singles collapses to the one player. */
    soloIdentity(data, side, team) {
      const g = data && data.games && data.activeGame && data.games[data.activeGame];
      if (!g || g.format !== '1v1' || (Number(g.rosterSize) || 1) > 1) return null;
      if (data.activeGame === 'smash' && data.smash && data.smash.mode === 'team') return null;
      const str = (v) => (v == null ? '' : String(v)).trim();
      const roster = (team && Array.isArray(team.players)) ? team.players : [];
      // Smash DOUBLES: the competitors are the PAIR - print both tags ("DDOG / PIGGY"), with the
      // team's own name on the second line when it is a real name rather than the two tags again.
      if (data.activeGame === 'smash' && data.smash && data.smash.mode === 'doubles') {
        const tags = roster.slice(0, 2).map((x) => str(x && (x.gamertag || x.name))).filter(Boolean);
        if (tags.length < 2) return null;   // only one player known - fall back to the team name
        const name = tags.join(' / ');
        const tn = str(team && team.name);
        const same = tn.toLowerCase().replace(/[^a-z0-9]/g, '') === tags.join('').toLowerCase().replace(/[^a-z0-9]/g, '');
        return { name, sub: same ? '' : tn };
      }
      const activeId = (data.activePlayer && data.activePlayer[side]) || '';
      // activePlayer picks the competitor within a multi-entrant record; a stale id falls to the first.
      let p = activeId ? roster.find((x) => x && String(x.id) === String(activeId)) : null;
      if (!p) p = roster[0] || null;
      const name = str(p && (p.gamertag || p.name));
      if (!name) return null;   // no roster on the side — the team name is all we have
      // The org line. start.gg stores it as the player's PREFIX ("MVG") while the entrant name is
      // the two mashed together ("MVG | Zain"), so prefer the prefix, then the resolved team org,
      // and only then the team name with the "PREFIX | TAG" half that repeats the gamertag stripped.
      let sub = str(p && p.prefix) || str(team && team.org);
      if (!sub) {
        const cut = str(team && team.name).split(/\s*[|\uFF5C]\s*/).filter(Boolean);
        sub = cut.length > 1 ? (cut.filter((x) => x.toLowerCase() !== name.toLowerCase())[0] || '') : (cut[0] || '');
      }
      if (sub.toLowerCase() === name.toLowerCase()) sub = '';
      return { name, sub };
    },
    /** Fill a scoreboard name plate from a teamSide() result. On head-to-head games it prints the
        competitor's gamertag with their org underneath (see soloIdentity); everywhere else it is
        the plain team name it always was. Shared so all ten camera scenes stay identical. */
    applyNamePlate(node, team, fallback) {
      if (!node) return;
      const main = ((team && (team.soloName || team.name)) || fallback || '').toString().toUpperCase();
      const sub = ((team && team.soloSub) || '').toString().toUpperCase();
      node.textContent = '';
      const m = document.createElement('span');
      m.className = 'plate-main';
      m.textContent = main;
      node.appendChild(m);
      if (sub) {
        const s = document.createElement('span');
        s.className = 'plate-sub';
        s.textContent = sub;
        node.appendChild(s);
      }
      node.classList.toggle('has-sub', !!sub);
    },
    teamSide(data, side) {
      const t = (data && data.teams && data.teams[side]) || {};
      // Fall back to the active game's logo when the team has no custom logo.
      const g = data && data.games && data.activeGame && data.games[data.activeGame];
      const gLogo = g && g.logo ? `/assets/${g.logo}` : '/assets/rl.png';
      const customLogo = (t.logo || '').toString().trim();
      const logo = customLogo || gLogo;
      const solo = this.soloIdentity(data, side, t);
      return {
        name: t.name || (side === 'orange' ? 'ORANGE' : 'BLUE'),
        // Head-to-head games: the competitor's gamertag + their org, for scenes that print a plate.
        soloName: solo ? solo.name : '',
        soloSub: solo ? solo.sub : '',
        logo,
        customLogo,
        logoOnDark: !customLogo || this.isDefaultGameLogo(logo),
        color: t.color || (side === 'orange' ? FALLBACK_ACCENT2 : FALLBACK_ACCENT),
        players: Array.isArray(t.players) ? t.players : [],
        score: (data && data.game) ? (side === 'orange' ? data.game.orangeScore : data.game.blueScore) : 0,
        series: (data && data.series) ? (data.series[side] || 0) : 0
      };
    },
    /** Delegates to the injected scene-bg.js so one implementation owns #scene-bg-wash. Kept as a
        SceneBase method because scenes and older overrides call it directly. */
    applyBg(bg) {
      if (global.SceneBg) global.SceneBg.apply(bg);
    },
    preview: PREVIEW,
    standalone: !PREVIEW && (typeof window !== 'undefined') && (window.parent === window),
    demoState,
    /** Opt a state key OUT of the standalone/preview "force visible" rule below, so the scene sees
        the producer's REAL show/hide. For furniture scenes (a desk, a bar) that merely BORROW a
        triggered graphic's state — e.g. the break timer printed as one segment of a footer — the
        force made Hide a no-op: the scene is a standalone source, so visible was rewritten to true
        on every tick and the clock kept ticking after the producer took the countdown down.
        Call before connect(): SceneBase.trustVisibility('breakScreen'). */
    trustVisibility(...keys) { keys.flat().forEach((k) => k && _trustVisible.add(k)); return this; },
    /* Re-render on the LIVE tick, not just on full_state.
       The RL Stats API path broadcasts a PARTIAL `state_update` ({game, players, spectatedPlayer,
       facecams}) on every packet and only sends a full_state on producer-level changes — so a scene
       that renders live per-player numbers from full_state alone sits frozen through an entire game.
       Opt in with the keys you need merged, before connect():
         SceneBase.liveUpdates('players', 'game')
       Each named key present on a state_update is merged into the last full payload and the scene
       re-renders. Deliberately opt-in: every existing scene keeps full_state-only behaviour. */
    liveUpdates(...keys) { _liveKeys = new Set(keys.flat().filter(Boolean)); return this; },
    connect(onState) {
      this.syncClock();
      if (!this._clockTimer) this._clockTimer = setInterval(() => this.syncClock(), 5 * 60 * 1000);
      // Standalone: scene is the top-level frame, not embedded inside gfx.html's iframe system.
      // Standalone sources added directly to OBS always show their content — they don't participate
      // in the on-demand trigger/switch system (that's gfx.html's job).
      const standalone = !PREVIEW && (global.parent === global);

      // Preview: render sample data immediately (live WS data, if any, overrides it).
      if (PREVIEW) {
        document.documentElement.classList.add('preview');
        // Safety net: if a ?preview=1 URL ever ends up pasted into a real OBS Browser Source
        // (e.g. copied from the control panel's "Preview" button instead of "Copy"/"Open"), this
        // makes it obvious on sight instead of silently airing fabricated team names as if real.
        const _pwBadge = document.createElement('div');
        _pwBadge.textContent = 'PREVIEW — SAMPLE DATA';
        _pwBadge.style.cssText = 'position:fixed;top:10px;left:10px;z-index:999999;font:800 13px/1 ui-monospace,monospace;'
          + 'letter-spacing:.08em;color:#0b0d12;background:#ffcc00;padding:5px 10px;border-radius:5px;'
          + 'box-shadow:0 2px 10px rgba(0,0,0,.5);pointer-events:none;';
        const _mountBadge = () => { const p = document.body || document.documentElement; if (p) p.appendChild(_pwBadge); };
        if (document.body) _mountBadge(); else document.addEventListener('DOMContentLoaded', _mountBadge);
        const demo = demoState();
        applyBrand(demo);
        try { onState(demo); } catch (e) { console.error('[scene] preview render error', e); }
      }

      // NOTE: standalone sources used to render demoState() immediately here too ("so the scene is
      // never invisible while WS connects") — removed. That meant EVERY real OBS Browser Source
      // (i.e. every scene in actual production use, not just ?preview=1) briefly showed fake teams
      // ("FROST ESPORTS"/"EMBER GAMING") on load, and indefinitely if the :3001 WS never connected
      // (server not started yet, wrong host/IP, port blocked). A scene's own empty state while it
      // waits half a second for WS to connect is correct; fabricated data pretending to be real
      // never is. Preview mode (?preview=1, explicit opt-in above) is unaffected.

      let ws;
      // The server omits the heavy brand/banner blobs (base64 sponsor/banner images) from most
      // broadcasts and only re-sends them when they change — backfill from the last full payload
      // so every render still has them.
      const _cache = {};
      const BACKFILL_KEYS = ['brand', 'banner', 'mainBanner', 'brandKits', 'bracket', 'replay', 'playerProfiles', 'savedTeams'];
      // The bridge (:3001) requires a token on every connection (server.js getOrCreateWsToken/
      // verifyClient) — fetched once from the HTTP API this page was itself loaded from (same
      // trust boundary as the overlay HTML/CSS) and cached for reconnects.
      let _wsToken = null;
      const open = async () => {
        if (!_wsToken) {
          try {
            const r = await fetch(HTTP_BASE + '/api/ws-token');
            const j = await r.json();
            _wsToken = j.token || '';
          } catch (e) { _wsToken = ''; }
        }
        ws = new WebSocket(WS_URL + (_wsToken ? ('?token=' + encodeURIComponent(_wsToken)) : ''));
        ws.onopen = () => {
          // Identify as a live overlay browser source (feeds the pre-flight "overlays reachable" check).
          try { ws.send(JSON.stringify({ type: 'register', role: 'overlay', page: global.location.pathname })); } catch (e) {}
          ws.send(JSON.stringify({ type: 'request_state' }));
          // Re-sample the server clock on every (re)connect — a machine that slept, or one whose
          // clock drifts, would otherwise keep an hours-old skew for the rest of the broadcast.
          this.syncClock();
        };
        ws.onmessage = ({ data }) => {
          let msg;
          try { msg = JSON.parse(data); } catch { return; }
          // Overlay code changed on disk (or a producer hit "Reload OBS"). Reloading blanks the
          // browser source, which is jarring mid-broadcast — so keep it SMOOTH and SCOPED:
          //  • no file list (explicit "reload everything" button/editor) → hard reload.
          //  • a change to some OTHER overlay's file → ignore (don't blank this source).
          //  • a pure .css change to a stylesheet this page links → hot-swap it in place, no reload.
          //  • an .html / .js change affecting this page → reload (its code must re-execute).
          // Data/name edits never take this path at all — they arrive as `full_state` and
          // re-render in place, so updating a name is always seamless.
          if (msg.type === 'reload_overlays') {
            const files = Array.isArray(msg.files)
              ? msg.files.map((f) => String(f).replace(/\\/g, '/').toLowerCase().split('/').pop()).filter(Boolean)
              : null;
            if (!files || !files.length) { try { location.reload(); } catch (e) {} return; }
            const page = (location.pathname.split('/').pop() || '').toLowerCase();
            const relevant = files.filter((f) => f === 'scene-base.js' || f === 'scene.css' || f === page);
            if (!relevant.length) return;                          // change to a different overlay — leave this one alone
            if (relevant.every((f) => f.endsWith('.css'))) {       // stylesheet-only → hot-swap, no blank frame
              const bust = '?r=' + Date.now();
              document.querySelectorAll('link[rel="stylesheet"]').forEach((lnk) => {
                const href = lnk.getAttribute('href') || '';
                const base = href.split('?')[0].split('/').pop().toLowerCase();
                if (relevant.indexOf(base) === -1) return;
                const clone = lnk.cloneNode(false);
                clone.setAttribute('href', href.split('?')[0] + bust);
                clone.addEventListener('load', () => setTimeout(() => { try { lnk.remove(); } catch (e) {} }, 60));
                lnk.parentNode.insertBefore(clone, lnk.nextSibling);
              });
              return;
            }
            try { location.reload(); } catch (e) {}
            return;
          }
          if (msg.type === 'full_state') {
            for (const k of BACKFILL_KEYS) {
              if (k in msg.data) _cache[k] = msg.data[k];
              else if (k in _cache) msg.data[k] = _cache[k];
            }
            // Preview + standalone both force visibility flags on so the scene always renders
            // its content regardless of the on-air trigger state.
            if (PREVIEW || standalone) {
              const d = msg.data;
              const forceVisible = (obj) => obj && typeof obj === 'object' ? { ...obj, visible: true } : obj;
              ['breakScreen', 'winner', 'intro', 'veto', 'casters', 'ticker', 'owMatch', 'upcoming', 'spotlight', 'watchlist', 'draft', 'bracket', 'standings'].forEach((k) => {
                if (d[k] && !_trustVisible.has(k)) d[k] = forceVisible(d[k]);
              });
            }
            applyBrand(msg.data);
            // sceneBg is applied by the injected scene-bg.js, which observes this same socket for
            // every overlay (not just the ones loading this file) — nothing to do here.
            _lastFull = msg.data;
            try { onState(msg.data); } catch (e) { console.error('[scene] render error', e); }
          } else if (msg.type === 'state_update' && _liveKeys && _lastFull && msg.data) {
            // Partial live tick — merge only the keys this scene asked for, then re-render off the
            // last full payload so brand/teams/settings are all still present.
            let touched = false;
            _liveKeys.forEach((k) => { if (k in msg.data) { _lastFull[k] = msg.data[k]; touched = true; } });
            if (touched) { try { onState(_lastFull); } catch (e) { console.error('[scene] live render error', e); } }
          }
        };
        ws.onclose = () => setTimeout(open, 800);
        ws.onerror = () => { try { ws.close(); } catch {} };
      };
      open();
    }
  };

  // Apply per-scene color/font preset config to :root CSS vars.
  // Call this in each overlay's onState after applyBrand so it takes priority.
  SceneBase.applySceneConfig = function(sceneKey, data) {
    if (!((data.sceneConfig || {})[sceneKey])) return;
    const cfg = data.sceneConfig[sceneKey];
    const root = document.documentElement;
    if (cfg.accent) {
      root.style.setProperty('--duo-accent',  cfg.accent);
      root.style.setProperty('--accent',       cfg.accent);
    } else {
      root.style.removeProperty('--duo-accent');
      root.style.removeProperty('--accent');
    }
    if (cfg.accent2) {
      root.style.setProperty('--duo-accent2', cfg.accent2);
      root.style.setProperty('--accent-2',    cfg.accent2);
    } else {
      root.style.removeProperty('--duo-accent2');
      root.style.removeProperty('--accent-2');
    }
    if (cfg.font) {
      const fv = `'${cfg.font}', sans-serif`;
      root.style.setProperty('--main-font',  fv);
      root.style.setProperty('--scene-font', fv);
    } else {
      root.style.removeProperty('--main-font');
      root.style.removeProperty('--scene-font');
    }
  };

  global.SceneBase = SceneBase;

  // ── Frame guide ────────────────────────────────────────────────────────────
  // Open any desk overlay with ?cams=off&guide=1 to outline every cam-hole and print its
  // exact 1920×1080 rectangle (on-screen + console). Use those numbers to set the separated-mode
  // OBS cam frame positions so they line up perfectly with the holes.
  (function frameGuide() {
    try {
      const q = new URLSearchParams(global.location.search);
      if (q.get('cams') !== 'off' || q.get('guide') !== '1') return;
      let tries = 0;
      const report = () => {
        const holes = Array.prototype.slice.call(document.querySelectorAll('.cam-hole'));
        if (!holes.length && tries++ < 20) { setTimeout(report, 250); return; }
        const rects = holes.map((h, i) => {
          const r = h.getBoundingClientRect();
          const rect = { i: i + 1, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
          h.style.outline = '3px solid #ff2fd6';
          h.style.background = 'rgba(255,47,214,.14)';
          const lbl = document.createElement('div');
          lbl.style.cssText = 'position:absolute;top:4px;left:4px;z-index:9999;font:800 16px ui-monospace,monospace;color:#ff7fe6;background:rgba(0,0,0,.78);padding:3px 7px;border-radius:5px;pointer-events:none;';
          lbl.textContent = `#${rect.i}  x:${rect.x} y:${rect.y}  ${rect.w}×${rect.h}`;
          h.appendChild(lbl);
          return rect;
        });
        console.log('[FRAME GUIDE]', global.location.pathname, JSON.stringify(rects));
      };
      global.addEventListener('load', () => setTimeout(report, 700));
    } catch (e) {}
  })();
})(window);
