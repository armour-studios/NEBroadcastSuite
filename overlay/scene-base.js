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
  const WS_URL = 'ws://localhost:3001';
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

  // Optional per-scene background wash (?bg=RRGGBB&bgop=0-100). Off unless requested —
  // lets a producer put a solid colour behind a graphic (e.g. to make a bracket readable
  // over busy gameplay). Fills the whole source whenever it's visible in OBS.
  (function applyBgParam() {
    var bg = qp('bg');
    var op = parseFloat(qp('bgop'));
    if (!bg || !(op > 0)) return;
    var hex = bg.replace(/^#/, '');
    if (!/^[0-9a-fA-F]{3,8}$/.test(hex)) return;
    var div = document.createElement('div');
    div.id = 'scene-bg-wash';
    div.style.cssText = 'position:fixed;inset:0;z-index:-9999;pointer-events:none;background:#' + hex + ';opacity:' + Math.min(1, op / 100) + ';';
    var mount = function () { var p = document.body || document.documentElement; if (p) p.insertBefore(div, p.firstChild); };
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
      upcoming: { visible: true, title: 'UPCOMING MATCHES', matches: [] },
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

  const STANDALONE_CASTER_RE = /\/(casters|duorow|triorow|duosinglecam|singlecam|analystspecial|campip|talentbar|interview|quaddesk|spotlightdesk|vertical|preshow)\.html$/i;
  const standaloneCasterScene = STANDALONE_CASTER_RE.test(global.location.pathname);

  const SceneBase = {
    qp,
    standaloneCasterScene,
    /** Dedicated OBS caster scenes always render; visibility toggle is for layered overlays only. */
    casterStageVisible(casters) {
      if (PREVIEW || standaloneCasterScene) return true;
      return !!(casters && casters.visible);
    },
    brandColor(data) {
      return (data && data.brand && data.brand.color) || cssVar('--accent', FALLBACK_ACCENT);
    },
    brandAccent(data) {
      return (data && data.brand && data.brand.accent) || cssVar('--accent-2', FALLBACK_ACCENT2);
    },
    brandLogo(data) {
      return (data && data.brand && data.brand.logo) || null;
    },
    // Resolve one of the configured RL-style team slots into a normalised shape.
    /** Resolve caster assigned to desk slot 1–4 (falls back to list order). */
    casterBySlot(casters, slot) {
      const list = (casters && Array.isArray(casters.list)) ? casters.list : [];
      const n = Number(slot);
      if (!n || n < 1) return null;
      const hit = list.find(c => c && Number(c.slot) === n);
      if (hit) return hit;
      // Positional fallback ONLY for legacy lists where NO caster carries an explicit slot.
      // Once any caster is slotted, resolution is strict so slot 2's caster never bleeds into
      // slot 1 (and an unassigned slot stays empty rather than borrowing the wrong feed).
      const anySlotted = list.some(c => c && Number(c.slot) >= 1);
      if (anySlotted) return null;
      return list[n - 1] || null;
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
      const handle = ((caster && caster.handle) || '').toString().trim();
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
    teamSide(data, side) {
      const t = (data && data.teams && data.teams[side]) || {};
      // Fall back to the active game's logo when the team has no custom logo.
      const g = data && data.games && data.activeGame && data.games[data.activeGame];
      const gLogo = g && g.logo ? `/assets/${g.logo}` : '/assets/rl.png';
      const customLogo = (t.logo || '').toString().trim();
      const logo = customLogo || gLogo;
      return {
        name: t.name || (side === 'orange' ? 'ORANGE' : 'BLUE'),
        logo,
        customLogo,
        logoOnDark: !customLogo || this.isDefaultGameLogo(logo),
        color: t.color || (side === 'orange' ? FALLBACK_ACCENT2 : FALLBACK_ACCENT),
        players: Array.isArray(t.players) ? t.players : [],
        score: (data && data.game) ? (side === 'orange' ? data.game.orangeScore : data.game.blueScore) : 0,
        series: (data && data.series) ? (data.series[side] || 0) : 0
      };
    },
    applyBg(bg) {
      let el = document.getElementById('scene-bg-wash');
      if (!bg || !bg.on) { if (el) el.remove(); return; }
      if (!el) {
        el = document.createElement('div');
        el.id = 'scene-bg-wash';
        el.style.cssText = 'position:fixed;inset:0;z-index:-9999;pointer-events:none;';
        const b = document.body || document.documentElement;
        if (b) b.insertBefore(el, b.firstChild);
      }
      const hex = (bg.color || '#000000').replace(/^#/, '');
      el.style.background = '#' + hex;
      el.style.opacity = Math.min(1, Math.max(0, (Number(bg.op) || 50) / 100));
    },
    preview: PREVIEW,
    standalone: !PREVIEW && (typeof window !== 'undefined') && (window.parent === window),
    demoState,
    connect(onState) {
      // Standalone: scene is the top-level frame, not embedded inside gfx.html's iframe system.
      // Standalone sources added directly to OBS always show their content — they don't participate
      // in the on-demand trigger/switch system (that's gfx.html's job).
      const standalone = !PREVIEW && (global.parent === global);

      // Preview: render sample data immediately (live WS data, if any, overrides it).
      if (PREVIEW) {
        document.documentElement.classList.add('preview');
        const demo = demoState();
        applyBrand(demo);
        try { onState(demo); } catch (e) { console.error('[scene] preview render error', e); }
      }

      // Standalone: render demo data immediately so the scene is never invisible while WS connects.
      // The real full_state from WS overwrites this as soon as the connection is established.
      if (standalone) {
        try { onState(demoState()); } catch (e) {}
      }

      let ws;
      // The server omits the heavy brand/banner blobs (base64 sponsor/banner images) from most
      // broadcasts and only re-sends them when they change — backfill from the last full payload
      // so every render still has them.
      const _cache = {};
      const BACKFILL_KEYS = ['brand', 'banner', 'mainBanner', 'brandKits', 'bracket', 'replay', 'playerProfiles', 'savedTeams'];
      const open = () => {
        ws = new WebSocket(WS_URL);
        ws.onopen = () => {
          // Identify as a live overlay browser source (feeds the pre-flight "overlays reachable" check).
          try { ws.send(JSON.stringify({ type: 'register', role: 'overlay', page: global.location.pathname })); } catch (e) {}
          ws.send(JSON.stringify({ type: 'request_state' }));
        };
        ws.onmessage = ({ data }) => {
          let msg;
          try { msg = JSON.parse(data); } catch { return; }
          // Producer-triggered hard reload — busts OBS/CEF's in-memory cache so every browser
          // source picks up freshly-served overlay code (server already sends no-store headers).
          if (msg.type === 'reload_overlays') { try { global.location.reload(); } catch (e) {} return; }
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
                if (d[k]) d[k] = forceVisible(d[k]);
              });
            }
            applyBrand(msg.data);
            // Only override URL-param bg when the server has an explicit entry for this
            // scene (including {on:false}). undefined = server has never been told about
            // this scene's bg → leave whatever ?bg= URL param applied untougged.
            const _sbEntry = (msg.data.sceneBg || {})[global.location.pathname];
            if (_sbEntry !== undefined) SceneBase.applyBg(_sbEntry);
            try { onState(msg.data); } catch (e) { console.error('[scene] render error', e); }
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
