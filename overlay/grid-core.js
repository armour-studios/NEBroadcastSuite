/* grid-core.js — shared brain for the GRID multiview scenes.
 *
 * Two scenes use this, and they only differ in what they PAINT:
 *   · grid.html      — the whole scene: each producer's video tile + its bar + the NOW bar + ticker.
 *   · grid-bars.html — transparent: the same bars/NOW/ticker in the same places, with the tile
 *                      rectangles left empty so the producer can put real OBS sources behind them.
 *
 * Everything else — where the tiles go, what a tile knows, how the numbers arrive, the brand kit,
 * the ticker — lives here so the two scenes can never drift apart.
 *
 * REAL DATA ONLY. There is no demo slate: an empty wall means nobody is publishing, and the scene
 * says exactly that rather than inventing teams that could end up on air.
 *
 * TILES: GET /api/multiview (the desktop app's authenticated proxy of the org's live games — see
 * server.js pulseOrgId/publishObservedGame). Each remote producer heartbeats their own match every
 * 3s; rows older than 30s are dropped cloud-side, so a producer who closes their app leaves the
 * wall on their own. Every tile carries:
 *     a/b        team name, abbr, logo, colour
 *     sa/sb      LIVE map score (the number on that producer's own HUD)
 *     ma/mb      maps won this series  ← this is what the tile bar shows, GRID-style
 *     channel    their Twitch handle, captioned on the tile bar
 *     viewUrl    their VDO feed (grid.html embeds it; grid-bars.html ignores it)
 *
 * LOOK: entirely from the active brand kit over the WS bridge — brand.color/accent drive every
 * accent including the NOW-bar title gradient, brand.font the type, brand.logo the mark, and the
 * sponsors follow the kit's own cycle/static mode and interval. Nothing is hard-coded to a colour.
 *
 * TICKER: the app's real ticker (state.ticker) — start.gg live/final scorelines with team crests, or
 * the producer's manual messages, at their speed, with the kit's ticker sponsor pinned at the left.
 * The wall's own live matches always lead; the app ticker's content follows when the producer has
 * their ticker turned on. Nothing to show = the strip hides itself.
 */
(function (global) {
  'use strict';

  var P = new URLSearchParams(location.search);
  function num(v, d) { var n = Number(v); return Number.isFinite(n) ? n : (d || 0); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function $(id) { return document.getElementById(id); }

  // ── Layout ────────────────────────────────────────────────────────────────
  // Fixed grids only — a broadcast wall that reflows mid-show reads as a glitch, so the tile count
  // steps between these and nothing in between. Empty slots are padded with a standby card.
  var LAYOUTS = {
    '2': { cols: 2, rows: 1, cap: 2 },
    '3': { cols: 3, rows: 1, cap: 3 },
    '4': { cols: 2, rows: 2, cap: 4 },
    '6': { cols: 3, rows: 2, cap: 6 }
  };
  // ?tiles=2|3|4|6 pins a layout (what you want when the scene is a fixed OBS scene); the default
  // 'auto' grows the wall as producers come online.
  function layoutFor(n) {
    var forced = String(P.get('tiles') || 'auto');
    if (LAYOUTS[forced]) return Object.assign({ id: forced, forced: true }, LAYOUTS[forced]);
    var id = n <= 2 ? '2' : n === 3 ? '3' : n <= 4 ? '4' : '6';
    return Object.assign({ id: id, forced: false }, LAYOUTS[id]);
  }

  // ── Tiles ─────────────────────────────────────────────────────────────────
  var FILLER = { team: 1, the: 1, esports: 1, esport: 1, gaming: 1, gg: 1, club: 1, academy: 1 };
  function initials(name) {
    var raw = String(name || '').trim();
    if (!raw) return '';
    var words = raw.split(/[\s._-]+/).filter(Boolean);
    var core = words.filter(function (w) { return !FILLER[w.toLowerCase()]; });
    var use = core.length ? core : words;
    if (use.length >= 2) return use.map(function (w) { return w[0]; }).join('').slice(0, 4).toUpperCase();
    return use[0].slice(0, 3).toUpperCase();
  }
  function side(t, fallbackColor) {
    t = t || {};
    return {
      name: t.name || '', abbr: t.abbr || initials(t.name),
      logo: t.logo || null, color: t.color || fallbackColor
    };
  }
  function normalize(x, i) {
    var t = x.teams || {};
    return {
      key: x.key || x.id || ('g' + i),
      game: x.game || '',
      // A team with no colour of its own falls back to the BRAND accents — never to an invented one.
      a: side(t.a, 'var(--brand)'), b: side(t.b, 'var(--brand-2)'),
      sa: num(x.sa, num(t.a && t.a.score, 0)), sb: num(x.sb, num(t.b && t.b.score, 0)),
      ma: num(x.ma, 0), mb: num(x.mb, 0),
      bestOf: num(x.bestOf, 0),
      clk: num(x.clk != null ? x.clk : x.clock, 0),
      status: x.status || '', unit: x.unit || 'score',
      viewUrl: x.viewUrl || x.feedUrl || null,
      channel: (x.channel || '').replace(/^@/, ''),
      label: x.label || '',
      standby: false
    };
  }
  // A padded slot — the wall keeps its shape when fewer producers are live than the layout holds.
  function standbyTile(i) {
    return {
      key: '_standby' + i, game: '', a: side(null, 'transparent'), b: side(null, 'transparent'),
      sa: 0, sb: 0, ma: 0, mb: 0, bestOf: 0, clk: 0, status: '', unit: 'score',
      viewUrl: null, channel: '', label: '', standby: true
    };
  }

  // ── Poll ──────────────────────────────────────────────────────────────────
  // onTiles(tiles, meta) — tiles is ALWAYS exactly layout.cap long (padded with standby slots).
  // meta = { layout, live, scored:[keys] } where `scored` is the keys whose numbers just moved
  // (the scenes flash those, the same cue the Pulse rail uses).
  function poll(onTiles) {
    var prev = {}, last = [];

    function emit(raw) {
      var lay = layoutFor(raw.length || 1);
      var tiles = raw.slice(0, lay.cap).map(normalize);
      var scored = [];
      tiles.forEach(function (t) {
        var sig = t.ma + '/' + t.mb + '/' + t.sa + '/' + t.sb;
        if (prev[t.key] !== undefined && prev[t.key] !== sig) scored.push(t.key);
        prev[t.key] = sig;
      });
      while (tiles.length < lay.cap) tiles.push(standbyTile(tiles.length));
      onTiles(tiles, { layout: lay, live: raw.length, scored: scored });
    }

    async function tick() {
      try {
        var res = await fetch('/api/multiview', { cache: 'no-store' });
        if (res.ok) {
          var d = await res.json();
          last = Array.isArray(d.games) ? d.games : [];
        }
      } catch (e) { /* app unreachable — hold the last known wall rather than blanking mid-show */ }
      emit(last);
    }

    tick();
    setInterval(tick, 4000);
    return { refresh: tick };
  }

  // ── Brand kit ─────────────────────────────────────────────────────────────
  function rgbOf(hex) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (m) return parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16);
    var s = /^#?([a-f\d])([a-f\d])([a-f\d])$/i.exec(hex || '');
    if (s) return parseInt(s[1] + s[1], 16) + ',' + parseInt(s[2] + s[2], 16) + ',' + parseInt(s[3] + s[3], 16);
    return null;
  }
  // Every colour on the wall comes from here. brand.color is the primary; brand.accent is the far
  // end of the title gradient and the B-side tint. A kit with one colour uses it for both.
  function applyBrand(root, d) {
    var brand = (d && d.brand) || null;
    var c1 = (brand && brand.color) || '';
    var c2 = (brand && brand.accent) || c1;
    if (c1) { root.style.setProperty('--brand', c1); var r1 = rgbOf(c1); if (r1) root.style.setProperty('--brand-rgb', r1); }
    if (c2) { root.style.setProperty('--brand-2', c2); var r2 = rgbOf(c2); if (r2) root.style.setProperty('--brand2-rgb', r2); }
    var font = (brand && brand.font) || (d && d.fontFamily);      // the kit's type, else the app's
    if (font) root.style.setProperty('--main-font', "'" + font + "'");
    if (d && d.theme) root.dataset.theme = d.theme;
  }

  // Sponsors — the kit's own rules: 'static' shows the whole set at once, 'cycle' rotates at the
  // kit's interval. Source is railSponsors (the tagged rotating bug), else every sponsor in the kit.
  function sponsorStrip(mount) {
    var timer = null, sig = '';
    function paint(list) {
      if (!mount) return;
      mount.innerHTML = list.map(function (s) {
        return s.logo ? '<img src="' + esc(s.logo) + '" alt="' + esc(s.name || '') + '">'
                      : '<span class="sname">' + esc(s.name || '') + '</span>';
      }).join('');
      mount.hidden = !list.length;
    }
    return function (brand) {
      var rail = brand && brand.railSponsors;
      var sp = (rail && rail.length ? rail : (brand && brand.sponsors)) || [];
      var mode = (brand && brand.sponsorMode) === 'static' ? 'static' : 'cycle';
      var every = Math.max(2, (brand && brand.sponsorInterval) || 6) * 1000;
      var next = mode + '#' + every + '#' + sp.map(function (x) { return x.logo || x.name || ''; }).join('|');
      if (next === sig) return;            // unchanged → never restart a rotation mid-cycle
      sig = next;
      if (timer) { clearInterval(timer); timer = null; }
      if (!sp.length) { paint([]); return; }
      if (mode === 'static' || sp.length === 1) { paint(sp); return; }
      var i = 0;
      paint([sp[0]]);
      timer = setInterval(function () { i = (i + 1) % sp.length; paint([sp[i]]); }, every);
    };
  }

  // ── WS bridge (brand / event / ticker), the same socket every overlay uses ─
  function connectState(onState) {
    var token = null;
    async function connect() {
      if (token === null) {
        try { token = (await (await fetch('http://' + (location.hostname || 'localhost') + ':3000/api/ws-token')).json()).token || ''; }
        catch (e) { token = ''; }
      }
      var sock;
      try { sock = new WebSocket('ws://' + (location.hostname || 'localhost') + ':3001' + (token ? ('?token=' + encodeURIComponent(token)) : '')); }
      catch (e) { setTimeout(connect, 1500); return; }
      sock.onopen = function () {
        try {
          sock.send(JSON.stringify({ type: 'register', role: 'overlay', page: 'grid' }));
          sock.send(JSON.stringify({ type: 'request_state' }));
        } catch (e) { }
      };
      sock.onmessage = function (ev) {
        var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.type === 'full_state') onState(msg.data || {});
      };
      sock.onclose = function () { setTimeout(connect, 1000); };
      sock.onerror = function () { try { sock.close(); } catch (e) { } };
    }
    connect();
  }

  // ── Formatting ────────────────────────────────────────────────────────────
  function clockStr(sec) {
    sec = Math.max(0, Math.round(num(sec, 0)));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }
  // "19:32 CET" — the wall clock in the NOW bar. 24h follows the app's clock24h setting.
  function wallClock(use24) {
    var d = new Date();
    // hourCycle h23, not hour12:false — the latter renders midnight as "24:10" in several locales.
    var opts = use24 ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
                     : { hour: '2-digit', minute: '2-digit', hour12: true };
    var t = d.toLocaleTimeString([], opts);
    var tz = '';
    try { tz = new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(d).find(function (p) { return p.type === 'timeZoneName'; }).value; }
    catch (e) { tz = ''; }
    return { time: t.replace(/\s?[AP]M$/i, ''), suffix: /PM$/i.test(t) ? 'PM' : (/AM$/i.test(t) ? 'AM' : ''), tz: tz };
  }
  // The round/phase caption under NOW: whatever the live producers agree on, else the local label.
  function phaseLabel(tiles, fallback) {
    var counts = {}, best = '', bestN = 0;
    tiles.forEach(function (t) {
      if (t.standby || !t.status) return;
      counts[t.status] = (counts[t.status] || 0) + 1;
      if (counts[t.status] > bestN) { bestN = counts[t.status]; best = t.status; }
    });
    return best || fallback || '';
  }

  // ── Ticker ────────────────────────────────────────────────────────────────
  // Mirrors overlay/ticker.html's model so the wall says the same thing as the lower third:
  // start.gg live/final scorelines with crests, or the producer's manual messages. The wall's own
  // published matches lead, because those are the ones on screen above it.
  function crestImg(logo, name, color) {
    return logo ? '<img class="tkc" src="' + esc(logo) + '" alt="">'
                : '<span class="tkc tkc-txt" style="--tc:' + esc(color || 'var(--brand)') + '">' + esc(initials(name)) + '</span>';
  }
  function matchItem(o) {
    var tag = o.live ? '<span class="tkstat live"><i></i>Live</span>'
            : (o.final ? '<span class="tkstat final">Final</span>' : '');
    return '<span class="tkitem">' + tag +
      crestImg(o.logoA, o.a, o.ca) + '<b>' + esc(o.a) + '</b>' +
      '<span class="tksc">' + o.sa + ' - ' + o.sb + '</span>' +
      '<b>' + esc(o.b) + '</b>' + crestImg(o.logoB, o.b, o.cb) +
      (o.tail ? '<span class="tktail">' + esc(o.tail) + '</span>' : '') + '</span>';
  }
  // Returns { html, count, speed, sponsor } — html is ONE pass of the loop (the caller doubles it).
  function tickerContent(tiles, d) {
    d = d || {};
    var t = d.ticker || {};
    var items = [];

    // 1. The wall itself: every producer currently publishing, with their series score + channel.
    tiles.filter(function (x) { return !x.standby; }).forEach(function (x) {
      items.push(matchItem({
        live: true, a: x.a.name || 'Team A', b: x.b.name || 'Team B',
        sa: x.ma, sb: x.mb, logoA: x.a.logo, logoB: x.b.logo, ca: x.a.color, cb: x.b.color,
        tail: x.channel ? 'twitch.tv/' + x.channel : (x.label || '')
      }));
    });

    // 2. The producer's own ticker — only while they actually have it running.
    if (t.visible) {
      if (t.source === 'startgg') {
        ((d.startgg && d.startgg.matchFeed) || [])
          .filter(function (m) { return m && (m.status === 'live' || m.status === 'done'); })
          .forEach(function (m) {
            items.push(matchItem({
              live: m.status === 'live', final: m.status === 'done',
              a: m.teamA || '', b: m.teamB || '',
              sa: num(m.scoreA, 0), sb: num(m.scoreB, 0), logoA: m.logoA, logoB: m.logoB
            }));
          });
      }
      // Manual promo lines: the whole ticker in manual mode, after the scores in start.gg mode.
      (t.messages || []).filter(Boolean).forEach(function (m) {
        items.push('<span class="tkmsg">' + esc(m) + '</span>');
      });
    }

    return {
      html: items.join('<span class="tksep"></span>'),
      count: items.length,
      speed: num(t.speed, 0) > 0 ? num(t.speed, 0) : 40,
      sponsor: (d.brand && d.brand.spots && d.brand.spots.ticker) || t.sponsor || ''
    };
  }

  // ── The wall renderer ────────────────────────────────────────────────────
  // Shared by both scenes: identical fit math, identical bar markup. grid.html passes video:true so
  // each tile embeds its producer's feed; grid-bars.html passes video:false and leaves the tile
  // rectangle empty (transparent) for a real OBS source underneath.
  var TWITCH_GLYPH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3 3 6v13h4v3h3l3-3h3l5-5V3H4zm2 2h12v9l-3 3h-3l-3 3v-3H6V5zm5 3v5h2V8h-2zm5 0v5h2V8h-2z"/></svg>';
  // Bars/crests/numbers step down as the wall gets denser — a 6-up bar at 2-up scale is unreadable.
  var SCALE = { '2': 1, '3': .78, '4': .8, '6': .62 };
  var GAP = 14;   // must match --gap in grid.css

  function crestHTML(t) {
    var style = 'style="--tc:' + esc(t.color || 'var(--brand)') + '"';
    return t.logo ? '<span class="crest" ' + style + '><img src="' + esc(t.logo) + '" alt=""></span>'
                  : '<span class="crest" ' + style + '>' + esc(t.abbr || '') + '</span>';
  }
  // Everything that can change on a poll lives in the bar — nothing here touches the video element.
  function barHTML(t) {
    var handle = t.channel ? 'twitch.tv/' + t.channel : (t.label || (t.standby ? 'Standby' : (t.game || 'Feed')));
    var aWin = t.ma > t.mb, bWin = t.mb > t.ma;
    return '<span class="who">' + (t.channel ? TWITCH_GLYPH : '') +
        '<span class="h' + (t.channel ? '' : ' dim') + '">' + esc(handle) + '</span></span>' +
      (t.standby ? '' :
        '<span class="sc">' + crestHTML(t.a) +
          '<span class="n ' + (aWin ? 'win' : bWin ? 'lose' : '') + '">' + t.ma + '</span>' +
          '<span class="vs">vs</span>' +
          '<span class="n ' + (bWin ? 'win' : aWin ? 'lose' : '') + '">' + t.mb + '</span>' +
          crestHTML(t.b) + '</span>');
  }

  function mountWall(gridEl, opts) {
    opts = opts || {};
    var frames = {}, layoutId = '';
    return function renderWall(tiles, meta) {
      var lay = meta.layout, scale = SCALE[lay.id] || 1;
      document.documentElement.style.setProperty('--s', scale);
      gridEl.className = 'grid lay-' + lay.id;
      // Fit the grid into the space the wall actually has: how tall each tile may be → its 16:9
      // width → capped on the viewport. Both scenes run this, so their rectangles match to the pixel.
      var availH = Math.max(120, gridEl.parentElement.clientHeight - 38);   // .wall's vertical padding
      var tileH = (availH - (lay.rows - 1) * GAP) / lay.rows;
      var wTile = Math.max(160, (tileH - 46 * scale) * 16 / 9);
      gridEl.style.width = Math.min(window.innerWidth - 120, wTile * lay.cols + (lay.cols - 1) * GAP) + 'px';

      // A layout change rebuilds the wall (the tile count changed) — feeds restart, which only
      // happens when a producer joins or leaves.
      if (layoutId !== lay.id) { gridEl.innerHTML = ''; frames = {}; layoutId = lay.id; }

      tiles.forEach(function (t, i) {
        var el = gridEl.children[i];
        if (!el) {
          el = document.createElement('div'); el.className = 'tile';
          el.innerHTML = '<div class="vid"></div><div class="bar"></div>';
          gridEl.appendChild(el);
        }
        el.classList.toggle('standby', !!t.standby);
        var box = el.querySelector('.vid'), bar = el.querySelector('.bar');

        // Video is written only when THIS SLOT's feed URL changes, so a score update never restarts it.
        if (opts.video) {
          var f = frames[i];
          if (!f || f.url !== t.viewUrl) {
            box.innerHTML = t.viewUrl
              ? '<iframe allow="autoplay; fullscreen" src="' + esc(t.viewUrl) + '"></iframe>'
              : '<div class="slate"><span>' + esc(t.standby ? 'Waiting for a producer' : 'Scores only') + '</span></div>';
            frames[i] = { url: t.viewUrl };
          }
        }

        var html = barHTML(t);
        if (bar.dataset.sig !== html) { bar.innerHTML = html; bar.dataset.sig = html; }
        if (meta.scored.indexOf(t.key) >= 0) {
          bar.classList.remove('flash'); void bar.offsetWidth; bar.classList.add('flash');
        }
      });
      if (opts.onLayout) opts.onLayout(gridEl, lay, tiles);
    };
  }

  // ── The chrome (NOW bar + ticker + clock + brand), wired by element id ───
  // Both pages carry the same ids, so this is written once.
  function mountChrome() {
    var root = document.documentElement;
    var state = {}, tiles = [], meta = { live: 0 }, tickSig = '';
    var paintSponsors = sponsorStrip($('sponsors'));

    function tickClock() {
      var c = wallClock(state.clock24h !== false);
      $('clock').textContent = c.time;
      $('tz').textContent = [c.suffix, c.tz].filter(Boolean).join(' ');
    }
    tickClock(); setInterval(tickClock, 10000);

    function paint() {
      $('phase').textContent = phaseLabel(tiles, (state.roundLabel || '').trim());
      $('nowLabel').textContent = meta.live ? 'NOW' : 'STANDBY';
      // The title block is the event's, and stays empty rather than inventing a show name.
      var title = (state.eventName || '').trim() || (state.brand && state.brand.name) || '';
      $('eventName').textContent = title;
      $('title').hidden = !title;

      var strip = $('ticker');
      if (!strip || strip.dataset.off) return;
      var t = tickerContent(tiles, state);
      strip.hidden = !t.count;                 // nothing real to say → no empty bar scrolling
      var sig = t.html + '#' + t.speed + '#' + t.sponsor;
      if (sig === tickSig) return;
      tickSig = sig;
      var sp = $('tickerSponsor');
      if (sp) { sp.hidden = !t.sponsor; if (t.sponsor) sp.src = t.sponsor; }
      var track = $('track');
      // Two passes end to end make the scroll seamless (the loop translates by exactly half).
      track.innerHTML = t.count ? (t.html + '<span class="tksep"></span>' + t.html + '<span class="tksep"></span>') : '';
      track.style.animationDuration = t.speed + 's';
    }

    connectState(function (d) {
      state = d || {};
      applyBrand(root, state);
      var bl = $('brandLogo'), logo = (state.brand && state.brand.logo) || state.eventLogo;
      if (bl) { if (logo) { bl.src = logo; bl.hidden = false; } else bl.hidden = true; }
      paintSponsors(state.brand || null);
      tickClock();
      paint();
    });

    return function updateChrome(nextTiles, nextMeta) { tiles = nextTiles; meta = nextMeta; paint(); };
  }

  // One call boots a whole scene: wall + chrome + polling.
  function boot(opts) {
    opts = opts || {};
    if (P.get('ticker') === '0') { var tk = $('ticker'); if (tk) { tk.hidden = true; tk.dataset.off = '1'; } }
    if (P.get('nowbar') === '0') { var nb = $('nowbar'); if (nb) nb.hidden = true; }
    var wall = mountWall($('grid'), opts);
    var chrome = mountChrome();
    var lastTiles = null, lastMeta = null;
    poll(function (tiles, meta) {
      lastTiles = tiles; lastMeta = meta;
      wall(tiles, meta); chrome(tiles, meta);
    });
    // The chrome can resize the wall underneath us — the ticker strip appears the moment there is
    // something real to say, and hiding the NOW bar frees another 104px. Re-fit the tiles when the
    // wall's box changes, or the bottom row ends up behind the NOW bar.
    var wallEl = document.querySelector('.wall');
    if (wallEl && global.ResizeObserver) {
      var refitting = false;
      new global.ResizeObserver(function () {
        if (refitting || !lastTiles) return;
        refitting = true;
        requestAnimationFrame(function () { wall(lastTiles, lastMeta); refitting = false; });
      }).observe(wallEl);
    }
  }

  global.GridCore = {
    params: P, esc: esc, num: num, initials: initials,
    layoutFor: layoutFor, poll: poll, boot: boot, mountWall: mountWall, mountChrome: mountChrome,
    connectState: connectState, applyBrand: applyBrand, sponsorStrip: sponsorStrip,
    clockStr: clockStr, wallClock: wallClock, tickerContent: tickerContent, phaseLabel: phaseLabel
  };
})(window);
