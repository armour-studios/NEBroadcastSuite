/* ─── custom-render.js — draws a custom overlay (Overlays ▸ Custom) ────────────────────────────
   ONE renderer for both places a custom overlay appears, so the editor is exactly what airs:
     • overlay/custom.html?id=… — the OBS browser source (live state from SceneBase)
     • control-panel/overlay-builder.js — the editor canvas (state = the panel's currentState)

   A layout: { id, name, kind, game, w: 1920, h: 1080, bg, elements: [ … ] }, drawn bottom to top.
   Every element: { id, type, name, x, y, w, h, opacity, hidden, locked, show, fx, <type block> }
     type   text | image | shape | list | embed | ticker | bar | slides
     show   always | break | nobreak | hud | replay | board | casters | gfx:<key>
     fx     { rot, skew, shadow: ''|soft|hard|glow, blur, anim: ''|fade|up|down|left|right|zoom, animMs }
   Text/images can follow a live FIELD (bind); text may mix tokens: "{team.blue.name} vs {team.orange.name}".
   Styles needed for editor/OBS parity are set inline (or injected once by ensureCss), never left to a
   page stylesheet. Exposed as window.CustomOverlay. Plain ES5 for OBS's CEF and Electron 18 (Chromium 100). */
(function (global) {
  'use strict';

  // ── Helpers over the show state ────────────────────────────────────────────────────────────
  function side(s, k) { return (s && s.teams && s.teams[k]) || {}; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function secsLeft(s, now) {
    var b = (s && s.breakScreen) || {};
    return b.frozenSeconds != null ? b.frozenSeconds : (b.endsAt ? Math.max(0, Math.round((b.endsAt - now) / 1000)) : null);
  }
  function countdown(s, now) {
    var secs = secsLeft(s, now);
    if (secs == null) return '';
    var h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), x = secs % 60;
    return (h ? h + ':' + pad(m) : m) + ':' + pad(x);
  }
  function clock(s) {
    var g = (s && s.game) || {};
    var t = Math.max(0, Math.round(Number(g.time) || 0));
    var txt = Math.floor(t / 60) + ':' + pad(t % 60);
    return g.isOT ? '+' + txt : txt;
  }
  function gameLogo(s) { var g = s && s.games && s.activeGame && s.games[s.activeGame]; return g && g.logo ? '/assets/' + g.logo : ''; }
  function casterOf(s, n) {
    var list = (s && s.casters && s.casters.list) || [];
    return list.filter(function (x) { return x && Number(x.slot) === n; })[0] || null;
  }
  function casterName(s, n) { var c = casterOf(s, n); return c ? (c.gamertag || c.name || '') : ''; }
  function casterSocial(s, n) { var c = casterOf(s, n); return c && c.socialHandle ? '@' + String(c.socialHandle).replace(/^@/, '') : ''; }
  function casterCam(s, n) { var c = casterOf(s, n); return (c && c.camUrl) || ''; }
  function players(s, team) {
    var list = (s && Array.isArray(s.players)) ? s.players : [];
    if (team === 'blue') return list.filter(function (p) { return Number(p.team) === 0; });
    if (team === 'orange') return list.filter(function (p) { return Number(p.team) === 1; });
    return list.slice();
  }
  function spec(s) {
    var n = s && s.spectatedPlayer;
    if (!n) return null;
    return players(s, 'all').filter(function (p) { return p.name === n; })[0] || null;
  }
  function seriesPct(s, k) { var need = Math.ceil(((s && s.bestOf) || 5) / 2); return Math.min(100, Math.round(100 * (((s && s.series && s.series[k]) || 0) / need))); }

  var FIELDS = [
    { id: 'team.blue.name', group: 'Teams', label: 'Left team name', kind: 'text', get: function (s) { return side(s, 'blue').name || ''; } },
    { id: 'team.orange.name', group: 'Teams', label: 'Right team name', kind: 'text', get: function (s) { return side(s, 'orange').name || ''; } },
    { id: 'team.blue.abbr', group: 'Teams', label: 'Left team short name', kind: 'text', get: function (s) { var t = side(s, 'blue'); return t.abbr || (t.name || '').slice(0, 4); } },
    { id: 'team.orange.abbr', group: 'Teams', label: 'Right team short name', kind: 'text', get: function (s) { var t = side(s, 'orange'); return t.abbr || (t.name || '').slice(0, 4); } },
    { id: 'team.blue.series', group: 'Teams', label: 'Left team series wins', kind: 'text', get: function (s) { return String((s && s.series && s.series.blue) || 0); } },
    { id: 'team.orange.series', group: 'Teams', label: 'Right team series wins', kind: 'text', get: function (s) { return String((s && s.series && s.series.orange) || 0); } },
    { id: 'team.blue.score', group: 'Teams', label: 'Left team game score', kind: 'text', live: true, get: function (s) { return String((s && s.game && s.game.blueScore) || 0); } },
    { id: 'team.orange.score', group: 'Teams', label: 'Right team game score', kind: 'text', live: true, get: function (s) { return String((s && s.game && s.game.orangeScore) || 0); } },
    { id: 'team.blue.logo', group: 'Teams', label: 'Left team logo', kind: 'image', get: function (s) { return side(s, 'blue').logo || gameLogo(s); } },
    { id: 'team.orange.logo', group: 'Teams', label: 'Right team logo', kind: 'image', get: function (s) { return side(s, 'orange').logo || gameLogo(s); } },
    { id: 'team.blue.color', group: 'Teams', label: 'Left team colour', kind: 'color', get: function (s) { return side(s, 'blue').color || '#3d8bff'; } },
    { id: 'team.orange.color', group: 'Teams', label: 'Right team colour', kind: 'color', get: function (s) { return side(s, 'orange').color || '#ff8a3d'; } },
    { id: 'team.blue.seriesPct', group: 'Teams', label: 'Left team series progress', kind: 'number', get: function (s) { return seriesPct(s, 'blue'); } },
    { id: 'team.orange.seriesPct', group: 'Teams', label: 'Right team series progress', kind: 'number', get: function (s) { return seriesPct(s, 'orange'); } },
    { id: 'match.series', group: 'Match', label: 'Series score (2 - 1)', kind: 'text', get: function (s) { var x = (s && s.series) || {}; return (x.blue || 0) + ' - ' + (x.orange || 0); } },
    { id: 'match.score', group: 'Match', label: 'Game score (3 - 1)', kind: 'text', live: true, get: function (s) { var g = (s && s.game) || {}; return (g.blueScore || 0) + ' - ' + (g.orangeScore || 0); } },
    { id: 'match.bestOf', group: 'Match', label: 'Best of (BEST OF 5)', kind: 'text', get: function (s) { return 'BEST OF ' + ((s && s.bestOf) || 5); } },
    { id: 'match.game', group: 'Match', label: 'Game number (GAME 2)', kind: 'text', get: function (s) { return 'GAME ' + ((s && s.game && s.game.number) || 1); } },
    { id: 'match.round', group: 'Match', label: 'Round', kind: 'text', get: function (s) { return (s && s.roundLabel) || ''; } },
    { id: 'match.clock', group: 'Match', label: 'Game clock (4:32, +0:41 in OT)', kind: 'text', live: true, get: clock },
    { id: 'match.ot', group: 'Match', label: 'OVERTIME, only in overtime', kind: 'text', live: true, get: function (s) { return s && s.game && s.game.isOT ? 'OVERTIME' : ''; } },
    { id: 'spec.name', group: 'Spectated player', label: 'Spectated player', kind: 'text', live: true, get: function (s) { return (s && s.spectatedPlayer) || ''; } },
    { id: 'spec.goals', group: 'Spectated player', label: 'Spectated player goals', kind: 'text', live: true, get: function (s) { var p = spec(s); return p ? String(p.goals || 0) : ''; } },
    { id: 'spec.score', group: 'Spectated player', label: 'Spectated player score', kind: 'text', live: true, get: function (s) { var p = spec(s); return p ? String(p.score || 0) : ''; } },
    { id: 'spec.boostText', group: 'Spectated player', label: 'Spectated player boost (number)', kind: 'text', live: true, get: function (s) { var p = spec(s); return p && p.boost != null ? String(Math.round(p.boost)) : ''; } },
    { id: 'spec.boost', group: 'Spectated player', label: 'Spectated player boost', kind: 'number', live: true, get: function (s) { var p = spec(s); return p && p.boost != null ? Math.round(p.boost) : 0; } },
    { id: 'spec.color', group: 'Spectated player', label: 'Spectated player team colour', kind: 'color', live: true, get: function (s) { var p = spec(s); return p ? (Number(p.team) === 1 ? side(s, 'orange').color || '#ff8a3d' : side(s, 'blue').color || '#3d8bff') : '#3d8bff'; } },
    { id: 'event.name', group: 'Event', label: 'Event name', kind: 'text', get: function (s) { return (s && s.eventName) || ''; } },
    { id: 'game.name', group: 'Event', label: 'Game', kind: 'text', get: function (s) { var g = s && s.games && s.activeGame && s.games[s.activeGame]; return (g && g.name) || ''; } },
    { id: 'game.logo', group: 'Event', label: 'Game logo', kind: 'image', get: gameLogo },
    { id: 'break.timer', group: 'Break', label: 'Break countdown (4:59)', kind: 'text', live: true, get: function (s, now) { return countdown(s, now); } },
    { id: 'break.title', group: 'Break', label: 'Break title', kind: 'text', get: function (s) { return (s && s.breakScreen && s.breakScreen.title) || ''; } },
    { id: 'break.message', group: 'Break', label: 'Break message', kind: 'text', get: function (s) { return (s && s.breakScreen && s.breakScreen.message) || ''; } },
    { id: 'brand.logo', group: 'Brand', label: 'Brand logo', kind: 'image', get: function (s) { return (s && s.brand && s.brand.logo) || ''; } },
    { id: 'brand.name', group: 'Brand', label: 'Brand name', kind: 'text', get: function (s) { return (s && s.brand && s.brand.name) || ''; } },
    { id: 'brand.color', group: 'Brand', label: 'Brand colour', kind: 'color', get: function (s) { return (s && s.brand && s.brand.color) || '#3d8bff'; } },
    { id: 'brand.accent', group: 'Brand', label: 'Brand accent colour', kind: 'color', get: function (s) { return (s && s.brand && s.brand.accent) || '#ff8a3d'; } },
    { id: 'sponsor.title', group: 'Brand', label: 'Title sponsor logo', kind: 'image', get: function (s) { return (s && s.brand && s.brand.spots && s.brand.spots.title) || ''; } },
    { id: 'sponsor.rail', group: 'Brand', label: 'Rail sponsors (taking turns)', kind: 'image', live: true, get: function (s, now) {
      var list = (s && s.brand && s.brand.railSponsors) || []; if (!list.length) return '';
      var every = ((s && s.brand && s.brand.sponsorInterval) || 6) * 1000;
      return (list[Math.floor(now / every) % list.length] || {}).logo || '';
    } },
    { id: 'clock', group: 'Other', label: 'Clock (9:41 PM)', kind: 'text', live: true, get: function (s, now) { return new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } },
  ];
  [1, 2, 3, 4].forEach(function (n) {
    FIELDS.push({ id: 'caster.' + n, group: 'Casters', label: 'Caster ' + n + ' name', kind: 'text', get: function (s) { return casterName(s, n); } });
    FIELDS.push({ id: 'caster.' + n + '.social', group: 'Casters', label: 'Caster ' + n + ' social handle', kind: 'text', get: function (s) { return casterSocial(s, n); } });
    FIELDS.push({ id: 'caster.' + n + '.cam', group: 'Casters', label: 'Caster ' + n + ' camera', kind: 'embed', get: function (s) { return casterCam(s, n); } });
  });
  var BY_ID = {};
  FIELDS.forEach(function (f) { BY_ID[f.id] = f; });

  function value(bind, s, now) {
    var f = BY_ID[bind];
    if (!f) return '';
    try { var v = f.get(s || {}, now || Date.now()); return f.kind === 'number' ? (Number(v) || 0) : (v == null ? '' : String(v)); } catch (e) { return f.kind === 'number' ? 0 : ''; }
  }
  function fill(text, s, now) {
    return String(text == null ? '' : text).replace(/\{([a-z0-9.]+)\}/gi, function (m, id) { return BY_ID[id] ? value(id, s, now) : m; });
  }
  function usesLive(el) {
    if (!el) return false;
    if (el.type === 'ticker' || el.type === 'slides' || el.type === 'list' || el.type === 'bar') return true;
    var binds = [el.text && el.text.bind, el.image && el.image.bind];
    for (var i = 0; i < binds.length; i++) if (binds[i] && BY_ID[binds[i]] && BY_ID[binds[i]].live) return true;
    var c = el.text && el.text.content;
    return !!(c && /\{(break\.timer|clock|match\.clock|match\.score|spec\.)/.test(c));
  }

  // ── Show conditions ────────────────────────────────────────────────────────────────────────
  var SHOW = [
    ['always', 'Always'], ['break', 'Only when the break screen is up'], ['nobreak', 'Only when the break screen is down'],
    ['hud', 'Only during play (not on replays or the post-game board)'], ['replay', 'Only during a goal replay'],
    ['board', 'Only on the post-game scoreboard'], ['casters', 'Only when the casters are on'],
  ];
  function shown(el, s) {
    if (el.hidden) return false;
    s = s || {};
    var onBreak = !!(s.breakScreen && s.breakScreen.visible);
    var view = s.view || 'hud';
    var w = el.show || 'always';
    if (w === 'break') return onBreak;
    if (w === 'nobreak' || w === 'live') return !onBreak;
    if (w === 'hud') return view === 'hud' && !s.inReplay;
    if (w === 'replay') return view === 'goal' || !!s.inReplay;
    if (w === 'board') return view === 'scoreboard';
    if (w === 'casters') return !!(s.casters && s.casters.visible);
    if (w.indexOf('gfx:') === 0) return (typeof s.gfxActive === 'string' ? s.gfxActive : '') === w.slice(4);
    return true;
  }

  // ── Styles the renderer owns (animations, ticker), injected once per document ──────────────
  var FONTS = { inter: "'Inter', system-ui, sans-serif", montserrat: "'Montserrat', 'Inter', sans-serif", rajdhani: "'Rajdhani', 'Inter', sans-serif", mono: "ui-monospace, Consolas, monospace" };
  function ensureCss(doc) {
    if (!doc || doc.getElementById('co-css')) return;
    var st = doc.createElement('style');
    st.id = 'co-css';
    st.textContent = '@keyframes co-in-fade{from{opacity:0}to{opacity:1}}'
      + '@keyframes co-in-up{from{opacity:0;transform:translateY(40px)}to{opacity:1}}'
      + '@keyframes co-in-down{from{opacity:0;transform:translateY(-40px)}to{opacity:1}}'
      + '@keyframes co-in-left{from{opacity:0;transform:translateX(-60px)}to{opacity:1}}'
      + '@keyframes co-in-right{from{opacity:0;transform:translateX(60px)}to{opacity:1}}'
      + '@keyframes co-in-zoom{from{opacity:0;transform:scale(.85)}to{opacity:1}}'
      + '@keyframes co-tick{from{transform:translateX(0)}to{transform:translateX(-50%)}}'
      + '.co-inner{position:absolute;left:0;top:0;right:0;bottom:0;}'
      + '.co-tick-track{display:inline-flex;white-space:nowrap;will-change:transform;}';
    (doc.head || doc.documentElement).appendChild(st);
  }
  var SHADOWS = { soft: '0 8px 28px rgba(0,0,0,.45)', hard: '6px 6px 0 rgba(0,0,0,.6)', glow: '0 0 26px rgba(61,139,255,.75)' };

  function color(v, s, now, bind) { return bind ? (value(bind, s, now) || v) : v; }
  function textStyle(node, t, s, now) {
    node.style.color = color(t.color || '#ffffff', s, now, t.colorBind);
    node.style.fontFamily = FONTS[t.font] || FONTS.inter;
    node.style.fontSize = (t.size || 48) + 'px';
    node.style.fontWeight = String(t.weight || 700);
    node.style.letterSpacing = (t.spacing || 0) + 'px';
    node.style.textTransform = t.upper ? 'uppercase' : 'none';
    node.style.fontStyle = t.italic ? 'italic' : 'normal';
    node.style.textShadow = t.shadow ? '0 2px 10px rgba(0,0,0,.55)' : 'none';
    node.style.webkitTextStroke = t.strokeW ? t.strokeW + 'px ' + (t.strokeColor || '#000000') : '';
  }

  // ── Per-type drawing (into the element's .co-inner box) ────────────────────────────────────
  function drawText(inner, el, s, now) {
    var t = el.text || {};
    textStyle(inner, t, s, now);
    inner.style.display = 'flex';
    inner.style.alignItems = t.valign === 'top' ? 'flex-start' : t.valign === 'bottom' ? 'flex-end' : 'center';
    inner.style.justifyContent = t.align === 'left' ? 'flex-start' : t.align === 'right' ? 'flex-end' : 'center';
    inner.style.textAlign = t.align || 'center';
    inner.style.whiteSpace = t.wrap ? 'normal' : 'nowrap';
    inner.style.lineHeight = String(t.lineHeight || 1.1);
    inner.style.padding = '0 ' + (t.padX || 0) + 'px';
    inner.style.boxSizing = 'border-box';
    inner.style.background = t.bg ? color(t.bg, s, now, t.bgBind) : 'transparent';
    inner.style.borderRadius = (t.bgRadius || 0) + 'px';
    var txt = t.bind ? value(t.bind, s, now) : fill(t.content, s, now);
    var span = inner.firstChild;
    if (!span) { span = document.createElement('span'); inner.appendChild(span); }
    span.style.cssText = 'display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;';
    if (span.textContent !== txt) span.textContent = txt;
  }
  function setImg(img, src, fit) {
    img.style.objectFit = fit === 'cover' ? 'cover' : fit === 'fill' ? 'fill' : 'contain';
    if (!src) { img.removeAttribute('src'); img.style.visibility = 'hidden'; return; }
    img.style.visibility = '';
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);
  }
  function drawImage(inner, el, s, now) {
    var im = el.image || {};
    var img = inner.firstChild;
    if (!img) { img = document.createElement('img'); img.alt = ''; img.draggable = false; img.style.cssText = 'width:100%;height:100%;display:block;'; inner.appendChild(img); }
    setImg(img, im.bind ? value(im.bind, s, now) : (im.src || ''), im.fit);
    img.style.borderRadius = (im.radius || 0) + 'px';
    img.style.filter = im.gray ? 'grayscale(1)' : '';
  }
  function drawShape(inner, el, s, now) {
    var sh = el.shape || {};
    var f1 = color(sh.fill || '#111827', s, now, sh.fillBind);
    var ang = sh.angle == null ? 90 : sh.angle;
    inner.style.background = sh.fill2 ? 'linear-gradient(' + ang + 'deg, ' + f1 + ', ' + sh.fill2 + ')' : f1;
    inner.style.borderRadius = sh.circle ? '50%' : (sh.radius || 0) + 'px';
    inner.style.border = sh.borderW ? sh.borderW + 'px solid ' + color(sh.borderColor || '#ffffff', s, now, sh.borderBind) : 'none';
    inner.style.boxSizing = 'border-box';
  }
  var STAT_LABEL = { goals: 'G', score: '', assists: 'A', saves: 'SV', shots: 'SH', demos: 'D' };
  // Games that send no live players (everything but Rocket League) list the team roster instead.
  function rosterRows(s, team) {
    var sides = team === 'all' ? ['blue', 'orange'] : [team];
    var out = [];
    sides.forEach(function (k) {
      var t = s && s.teams && s.teams[k];
      ((t && Array.isArray(t.players)) ? t.players : []).forEach(function (p) {
        var n = typeof p === 'string' ? p : p && (p.gamertag || p.name);
        if (n) out.push({ name: String(n), team: k === 'orange' ? 1 : 0 });
      });
    });
    return out;
  }
  function drawList(inner, el, s, now, opts) {
    var L = el.list || {};
    var rows = players(s, L.side || 'blue');
    if (!rows.length) rows = rosterRows(s, L.side || 'blue');
    // The editor shows where the rows will go even before anyone is loaded.
    if (!rows.length && opts && opts.editor) rows = [1, 2, 3, 4, 5].map(function (i) { return { name: 'Player ' + i, boost: 100 - i * 17, goals: 0, score: 0 }; });
    if (L.sort && L.stat) rows.sort(function (a, b) { return (Number(b[L.stat]) || 0) - (Number(a[L.stat]) || 0); });
    rows = rows.slice(0, L.max || 3);
    var specName = s && s.spectatedPlayer;
    var teamColor = L.side === 'orange' ? (side(s, 'orange').color || '#ff8a3d') : (side(s, 'blue').color || '#3d8bff');
    var sig = JSON.stringify([rows.map(function (p) { return [p.name, p[L.stat], p.boost]; }), specName, L, el.w, el.h, teamColor]);
    if (inner._sig === sig) return;
    inner._sig = sig;
    inner.textContent = '';
    var gap = L.gap == null ? 6 : L.gap;
    var n = Math.max(1, L.max || 3);
    var rowH = Math.max(10, (el.h - gap * (n - 1)) / n);
    rows.forEach(function (p, i) {
      var row = document.createElement('div');
      var hl = L.highlight && specName && p.name === specName;
      row.style.cssText = 'position:absolute;left:0;right:0;top:' + (i * (rowH + gap)) + 'px;height:' + rowH + 'px;display:flex;align-items:center;gap:10px;padding:0 ' + (L.padX == null ? 12 : L.padX) + 'px;box-sizing:border-box;overflow:hidden;'
        + 'border-radius:' + (L.radius || 0) + 'px;background:' + (hl ? (L.hlBg || teamColor) : (L.bg || 'rgba(11,15,23,.82)')) + ';'
        + (L.accent ? 'border-left:4px solid ' + teamColor + ';' : '');
      var name = document.createElement('span');
      textStyle(name, L, s, now);
      name.style.flex = '1'; name.style.minWidth = '0'; name.style.overflow = 'hidden'; name.style.textOverflow = 'ellipsis'; name.style.whiteSpace = 'nowrap';
      name.textContent = p.name || '';
      row.appendChild(name);
      if (L.stat === 'boost') {
        var track = document.createElement('div');
        track.style.cssText = 'flex:0 0 ' + Math.round(el.w * 0.32) + 'px;height:' + Math.max(4, Math.round(rowH * 0.22)) + 'px;border-radius:99px;background:rgba(255,255,255,.12);overflow:hidden;';
        var bar = document.createElement('div');
        bar.style.cssText = 'height:100%;width:' + Math.max(0, Math.min(100, p.boost || 0)) + '%;background:' + (L.statColor || teamColor) + ';';
        track.appendChild(bar); row.appendChild(track);
      } else if (L.stat) {
        var st = document.createElement('b');
        textStyle(st, L, s, now);
        if (L.statColor) st.style.color = L.statColor;
        st.textContent = (p[L.stat] != null ? p[L.stat] : 0) + (STAT_LABEL[L.stat] ? ' ' + STAT_LABEL[L.stat] : '');
        row.appendChild(st);
      }
      inner.appendChild(row);
    });
  }
  function drawEmbed(inner, el, s, now, opts) {
    var e = el.embed || {};
    var src = e.bind ? value(e.bind, s, now) : (e.src || '');
    inner.style.borderRadius = (e.radius || 0) + 'px';
    inner.style.overflow = 'hidden';
    if (src && !/^(https?:\/\/|\/)/i.test(String(src).trim())) src = '';   // never a javascript:/data: frame
    if (!src || (opts.editor && (!opts.livePreview || opts.thumb))) {
      var key = (src ? 'ph:' : 'none:') + (e.bind || '');
      if (inner._ph !== key) {
        inner._ph = key;
        inner.textContent = '';
        if (opts.editor) {
          var ph = document.createElement('div');
          ph.style.cssText = 'position:absolute;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:8px;box-sizing:border-box;'
            + 'background:repeating-linear-gradient(45deg,rgba(255,255,255,.05) 0 14px,rgba(255,255,255,.09) 14px 28px);color:#cfd6e4;font:600 26px Inter,sans-serif;border:2px dashed rgba(255,255,255,.25);';
          ph.textContent = e.bind ? ((BY_ID[e.bind] || {}).label || 'Camera') + (src ? '' : ': nobody in that seat yet') : (src ? 'Web page' : 'Add a link');
          inner.appendChild(ph);
        }
      }
      return;
    }
    var fr = inner.querySelector('iframe');
    if (!fr) { inner.textContent = ''; inner._ph = ''; fr = document.createElement('iframe'); fr.setAttribute('allow', e.bind ? 'autoplay; camera; microphone' : 'autoplay'); fr.style.cssText = 'width:100%;height:100%;border:0;display:block;background:transparent;'; inner.appendChild(fr); }
    if (fr.getAttribute('src') !== src) fr.setAttribute('src', src);
  }
  function tickerItems(el, s) {
    var t = el.ticker || {};
    if (t.source === 'custom') return String(t.text || '').split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
    var msgs = (s && s.ticker && s.ticker.messages) || [];
    return msgs.map(function (m) { return typeof m === 'string' ? m : (m && (m.text || m.message)) || ''; }).filter(Boolean);
  }
  function drawTicker(inner, el, s, now) {
    var t = el.ticker || {};
    var items = tickerItems(el, s);
    inner.style.background = t.bg || 'rgba(11,15,23,.9)';
    inner.style.borderRadius = (t.radius || 0) + 'px';
    inner.style.overflow = 'hidden';
    inner.style.display = 'flex'; inner.style.alignItems = 'center';
    var sig = JSON.stringify([items, t, color(t.color || '#ffffff', s, now, t.colorBind)]);   // every style field, and the resolved colour
    if (inner._sig === sig) return;
    inner._sig = sig;
    inner.textContent = '';
    if (!items.length) return;
    var track = document.createElement('div');
    track.className = 'co-tick-track';
    var sep = t.sep == null ? '   •   ' : t.sep;
    var once = items.join(sep) + sep;
    for (var k = 0; k < 2; k++) { var sp = document.createElement('span'); textStyle(sp, t, s, now); sp.style.whiteSpace = 'pre'; sp.textContent = once; track.appendChild(sp); }
    inner.appendChild(track);
    var speed = Math.max(10, t.speed || 90);   // pixels per second
    var w = Math.max(200, once.length * (t.size || 32) * 0.55);
    track.style.animation = 'co-tick ' + (w / speed).toFixed(2) + 's linear infinite';
  }
  function drawBar(inner, el, s, now) {
    var b = el.bar || {};
    var max = b.max || 100;
    var v = b.bind ? value(b.bind, s, now) : (b.value || 0);
    var pct = Math.max(0, Math.min(100, (Number(v) || 0) / max * 100));
    inner.style.background = b.track || 'rgba(255,255,255,.12)';
    inner.style.borderRadius = (b.radius == null ? 999 : b.radius) + 'px';
    inner.style.overflow = 'hidden';
    var f = inner.firstChild;
    if (!f) { f = document.createElement('div'); f.style.cssText = 'position:absolute;transition:width .25s ease,height .25s ease;'; inner.appendChild(f); }
    var col = color(b.fill || '#3d8bff', s, now, b.fillBind);
    f.style.background = b.fill2 ? 'linear-gradient(90deg,' + col + ',' + b.fill2 + ')' : col;
    if (b.dir === 'v') { f.style.left = '0'; f.style.right = '0'; f.style.bottom = '0'; f.style.top = 'auto'; f.style.width = '100%'; f.style.height = pct + '%'; }
    else if (b.dir === 'rtl') { f.style.top = '0'; f.style.bottom = '0'; f.style.right = '0'; f.style.left = 'auto'; f.style.height = '100%'; f.style.width = pct + '%'; }
    else { f.style.top = '0'; f.style.bottom = '0'; f.style.left = '0'; f.style.right = 'auto'; f.style.height = '100%'; f.style.width = pct + '%'; }
  }
  function drawSlides(inner, el, s, now) {
    var sl = el.slides || {};
    var list = (sl.source === 'sponsors') ? ((s && s.brand && s.brand.railSponsors) || []).map(function (x) { return x && x.logo; }).filter(Boolean) : (sl.images || []).filter(Boolean);
    var img = inner.firstChild;
    if (!img) { img = document.createElement('img'); img.alt = ''; img.draggable = false; img.style.cssText = 'width:100%;height:100%;display:block;'; inner.appendChild(img); }
    if (!list.length) { setImg(img, '', sl.fit); return; }
    var every = Math.max(1, sl.interval || 6) * 1000;
    setImg(img, list[Math.floor(now / every) % list.length], sl.fit);
  }
  var DRAW = { text: drawText, image: drawImage, shape: drawShape, list: drawList, embed: drawEmbed, ticker: drawTicker, bar: drawBar, slides: drawSlides };

  function applyFx(node, el, firstShow) {
    var fx = el.fx || {};
    var tf = [];
    if (fx.rot) tf.push('rotate(' + fx.rot + 'deg)');
    if (fx.skew) tf.push('skewX(' + fx.skew + 'deg)');
    node.style.transform = tf.join(' ');
    node.style.boxShadow = SHADOWS[fx.shadow] || 'none';
    if (fx.blur) { node.style.backdropFilter = 'blur(' + fx.blur + 'px)'; node.style.webkitBackdropFilter = 'blur(' + fx.blur + 'px)'; }
    // Entry animation plays on the inner box (the outer box carries rotate/skew) each time it appears.
    var inner = node.firstChild;
    if (inner) {
      if (fx.anim && firstShow) { inner.style.animation = 'none'; void inner.offsetWidth; inner.style.animation = 'co-in-' + fx.anim + ' ' + (fx.animMs || 500) + 'ms cubic-bezier(.2,.8,.2,1) both'; }
      else if (!fx.anim) inner.style.animation = '';
    }
  }

  // Draw (or update in place) every element of a layout into `root`, a w × h box.
  //   opts.editor       draw hidden-by-condition pieces faintly instead of not at all
  //   opts.livePreview  load camera / web embeds in the editor (off by default: they are heavy)
  function render(root, layout, s, opts) {
    opts = opts || {};
    ensureCss(root.ownerDocument || document);
    var now = opts.now || Date.now();
    var els = (layout && Array.isArray(layout.elements)) ? layout.elements : [];
    var keep = {};
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el || !el.id || !DRAW[el.type]) continue;
      keep[el.id] = true;
      var node = root.querySelector('[data-el="' + el.id + '"]');
      if (!node) { node = document.createElement('div'); node.setAttribute('data-el', el.id); root.appendChild(node); }
      if (node.getAttribute('data-type') !== el.type) {
        node.textContent = ''; node.setAttribute('data-type', el.type); node.className = 'co-el co-' + el.type;
        var inn = document.createElement('div'); inn.className = 'co-inner'; node.appendChild(inn);
      }
      var inner = node.firstChild;
      var on = shown(el, s);
      var wasOn = node.getAttribute('data-on') === '1';
      var replayNow = node.getAttribute('data-replay') === '1';
      if (replayNow) node.removeAttribute('data-replay');
      var faint = !on && opts.editor && !opts.thumb && !el.hidden;   // thumbnails show only what is on, like air
      node.style.cssText = 'position:absolute;left:' + (el.x || 0) + 'px;top:' + (el.y || 0) + 'px;width:' + (el.w || 100) + 'px;height:' + (el.h || 100) + 'px;'
        + 'z-index:' + (i + 1) + ';box-sizing:border-box;opacity:' + (el.opacity == null ? 1 : el.opacity) + ';'
        + (!on ? (faint ? 'filter:grayscale(1);opacity:.25;' : 'display:none;') : '');
      if (on || faint) {
        // One piece failing on odd data must not stop every piece after it from drawing.
        try { DRAW[el.type](inner, el, s, now, opts); }
        catch (e) { if (global.console) console.error('[custom] ' + el.type + ' "' + (el.name || el.id) + '" failed to draw', e); }
        // On air an animation plays each time the piece appears; in the editor only on request.
        applyFx(node, el, on && (replayNow || (!wasOn && !opts.editor)));
      }
      node.setAttribute('data-on', on ? '1' : '0');
      if (root.children[i] !== node) root.insertBefore(node, root.children[i] || null);
    }
    Array.prototype.slice.call(root.querySelectorAll('[data-el]')).forEach(function (n) { if (!keep[n.getAttribute('data-el')]) n.parentNode.removeChild(n); });
  }
  // Replay an element's entry animation (the editor's "Preview animation" button).
  function replay(root, id) {
    var node = root.querySelector('[data-el="' + id + '"]');
    if (node) node.setAttribute('data-replay', '1');
  }

  global.CustomOverlay = { FIELDS: FIELDS, SHOW: SHOW, TYPES: Object.keys(DRAW), value: value, fill: fill, usesLive: usesLive, render: render, replay: replay, shown: shown, FONTS: FONTS };
})(window);
