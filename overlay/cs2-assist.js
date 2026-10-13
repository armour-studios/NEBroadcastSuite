/* cs2-assist.js — CS2 Observer Assist, built into the CS2 HUDs (csgo.html, cs2-pro.html).
   Only ever shows when the HUD runs in the app's see-through window over the game (html.ne-over-game,
   added by the window's preload), so the observer sees the Director's pick and the key to press while
   OBS, which loads the same page, never does. Switched with Game Settings > CS2 > Observer
   ("Observer assist on the HUD over the game", state.csgo.observerAssist).

   cs2-observer.html (the old standalone window) sets window.CS2_ASSIST_STANDALONE = true and uses the
   same code, so there is one implementation.

   Self-contained: it opens its own socket, but only once it knows it is over the game. */
(function () {
  'use strict';
  var STANDALONE = !!window.CS2_ASSIST_STANDALONE;
  var root = document.documentElement;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var director = null, cs = null, teams = { blue: {}, orange: {} }, activeGame = '';
  var box = null, started = false;

  function overGame() { return root.classList.contains('ne-over-game'); }
  function inObs() { return !!window.obsstudio && !overGame() && !/[?&]preview=1\b/.test(location.search); }

  function css() {
    var st = document.createElement('style');
    st.textContent = ''
      + '#cs2-assist{position:absolute;right:24px;top:300px;width:360px;display:flex;flex-direction:column;gap:6px;z-index:9000;'
      + 'font-family:"Rajdhani","Inter",sans-serif;color:#fff;-webkit-font-smoothing:antialiased;transition:opacity .3s ease;pointer-events:none}'
      + '#cs2-assist[hidden]{display:none}'
      + '#cs2-assist.idle{opacity:.55}'
      + '#cs2-assist .hd{display:flex;align-items:center;gap:8px;padding:6px 12px;background:rgba(12,13,17,.88);font-weight:700;font-size:13px;letter-spacing:.16em;text-transform:uppercase;color:#aab0bb}'
      + '#cs2-assist .hd .mode{margin-left:auto;padding:2px 8px;border-radius:4px;font-size:11px;letter-spacing:.12em;background:#2b2f3a;color:#fff}'
      + '#cs2-assist .hd .mode.auto{background:#3c7a3c}'
      + '#cs2-assist .pick{display:flex;align-items:stretch;background:rgba(12,13,17,.9);border-left:5px solid var(--c,#ffd34d)}'
      + '#cs2-assist .pick .key{width:76px;display:grid;place-items:center;font-weight:700;font-size:48px;line-height:1;background:rgba(255,255,255,.06);color:var(--c,#ffd34d)}'
      + '#cs2-assist .pick .bd{flex:1;min-width:0;padding:8px 12px;display:flex;flex-direction:column;gap:2px}'
      + '#cs2-assist .pick .nm{font-weight:700;font-size:24px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + '#cs2-assist .pick .why{font-weight:500;font-size:15px;color:#d4d8e0;line-height:1.2}'
      + '#cs2-assist .pick .conf{margin-top:4px;height:4px;background:rgba(255,255,255,.1)}'
      + '#cs2-assist .pick .conf i{display:block;height:100%;background:var(--c,#ffd34d)}'
      + '#cs2-assist .pick.on .key{background:var(--c,#ffd34d);color:#111}'
      + '#cs2-assist .alt{display:flex;align-items:center;gap:10px;padding:6px 10px;background:rgba(12,13,17,.8);font-size:15px}'
      + '#cs2-assist .alt .key{width:30px;height:30px;display:grid;place-items:center;font-weight:700;font-size:18px;background:rgba(255,255,255,.08);border-left:3px solid var(--c,#888)}'
      + '#cs2-assist .alt .nm{font-weight:700;white-space:nowrap}'
      + '#cs2-assist .alt .why{color:#aab0bb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}'
      + '#cs2-assist .cine{padding:6px 12px;background:rgba(12,13,17,.8);font-weight:600;font-size:14px;color:#aab0bb}'
      + '#cs2-assist .cine b{color:#fff}#cs2-assist .cine.rec b{color:#ff6b6b}'
      + '#cs2-assist .empty{padding:10px 12px;background:rgba(12,13,17,.85);font-size:15px;color:#aab0bb}';
    document.head.appendChild(st);
  }

  function playerFor(target) {
    if (!target || target.kind !== 'player' || !cs) return null;
    return (cs.players || []).find(function (p) { return p.steamid === target.id || p.name === target.name; }) || null;
  }
  function keyOf(p) { return p && p.slot != null && p.slot <= 9 ? String((p.slot + 1) % 10) : ''; }
  function colorOf(p) { return p && p.team === 'T' ? (teams.orange.color || '#e8a23a') : (teams.blue.color || '#5b8cff'); }

  function render() {
    if (!box) return;
    var on = !inObs() && (STANDALONE || (overGame() && !(cs && cs.observerAssist === false)));
    box.hidden = !on;
    if (!on) return;
    if (activeGame && activeGame !== 'csgo') { set('<div class="empty">Observer Assist is for CS2. Switch the active game to CS2.</div>', false); return; }
    var d = director || {};
    var auto = !!d.autoSwitch;
    var html = '<div class="hd">Observer Assist<span class="mode' + (auto ? ' auto' : '') + '">' + (auto ? 'Auto-switch' : 'Suggest') + '</span></div>';
    var prim = d.primary;
    var pp = prim && playerFor(prim.target);
    var obsId = cs && cs.observed && cs.observed.steamid;
    if (!cs || !cs.connected) html += '<div class="empty">Waiting for CS2 game data.</div>';
    else if (d.enabled === false) html += '<div class="empty">The AI Director is off. Turn it on in Production &gt; Director.</div>';
    else if (!prim) html += '<div class="empty">No standout play right now. Stay on the action.</div>';
    else {
      var isOn = pp && pp.steamid === obsId;
      html += '<div class="pick' + (isOn ? ' on' : '') + '" style="--c:' + colorOf(pp) + '"><div class="key">' + (esc(keyOf(pp)) || '&middot;') + '</div>'
        + '<div class="bd"><div class="nm">' + esc(pp ? pp.name : prim.name) + (isOn ? ' &middot; on it' : '') + '</div>'
        + '<div class="why">' + esc(prim.reason || '') + '</div>'
        + '<div class="conf"><i style="width:' + Math.max(4, Math.min(100, prim.confidence || 0)) + '%"></i></div></div></div>';
      (d.alternates || []).slice(0, 2).forEach(function (a) {
        var ap = playerFor(a.target);
        html += '<div class="alt" style="--c:' + colorOf(ap) + '"><span class="key">' + (esc(keyOf(ap)) || '&middot;') + '</span>'
          + '<span class="nm">' + esc(ap ? ap.name : a.name) + '</span><span class="why">' + esc(a.reason || '') + '</span></div>';
      });
    }
    var c = cs && cs.cinematic;
    // Only while the console is actually connected: on CS2 builds that never open it, a permanent
    // 'not connected' line was noise the observer could do nothing about.
    if (c && c.enabled && c.status === 'connected') {
      var status = c.playing ? '<b>Camera: ' + esc(c.playing.name || 'shot') + '</b>' : 'Cinematic freezetime ready';
      html += '<div class="cine' + (c.playing ? ' rec' : '') + '">' + status + '</div>';
    }
    set(html, !!prim);
  }
  function set(html, active) {
    box.classList.toggle('idle', !active);
    if (box._h !== html) { box._h = html; box.innerHTML = html; }
  }

  var wsToken = null;
  function connect() {
    var host = location.hostname || 'localhost';
    var open = function () {
      var sock = new WebSocket('ws://' + host + ':3001' + (wsToken ? '?token=' + encodeURIComponent(wsToken) : ''));
      sock.onopen = function () {
        try { sock.send(JSON.stringify({ type: 'register', role: 'overlay', page: location.pathname + '#assist' })); } catch (e) {}
        sock.send(JSON.stringify({ type: 'request_state' }));
      };
      sock.onmessage = function (ev) {
        var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
        try {
          if (msg.type === 'full_state') {
            var d = msg.data || {};
            if (d.teams) teams = { blue: d.teams.blue || {}, orange: d.teams.orange || {} };
            if (d.activeGame) activeGame = d.activeGame;
            if ('director' in d) director = d.director;
            if ('csgo' in d) cs = d.csgo;
            render();
          } else if (msg.type === 'director_update') { director = msg.data; render(); }
          else if (msg.type === 'csgo_update') { cs = msg.data; render(); }
        } catch (e) { console.error('[cs2-assist]', e); }
      };
      sock.onclose = function () { setTimeout(open, 800); };
      sock.onerror = function () { try { sock.close(); } catch (e) {} };
    };
    if (wsToken != null) return open();
    fetch('http://' + host + ':3000/api/ws-token').then(function (r) { return r.json(); })
      .then(function (j) { wsToken = (j && j.token) || ''; open(); })
      .catch(function () { wsToken = ''; open(); });
  }

  function start() {
    if (started) return;
    started = true;
    css();
    box = document.createElement('div');
    box.id = 'cs2-assist'; box.className = 'idle'; box.hidden = true;
    document.body.appendChild(box);
    render();
    connect();
  }

  // The over-game class lands after load: look for it for a few seconds. In OBS it never comes, so
  // nothing is built and no socket is opened.
  var tries = 0;
  (function wait() {
    if (STANDALONE || overGame()) { start(); return; }
    if (++tries < 20) setTimeout(wait, 500);
  })();
})();
