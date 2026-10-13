/* ─── settings-diagnostics.js — Settings ▸ Diagnostics ────────────────────────────────────────
   The show timeline (backend/show-timeline.js) in the panel: what happened during the show, in order,
   so "the scene got stuck" or "the score was wrong" can be traced to the step that stopped, during
   the show or right after it. Reads GET /api/diagnostics/timeline (?since=<seq> for new events only)
   every 2s while the section is on screen. A health strip on top says what is wrong right now
   (switcher, game feed, failing integrations) from the live state. Copy puts the timeline on the
   clipboard as text for a bug report or a message. */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function cur() { try { return (typeof currentState !== 'undefined' && currentState) || {}; } catch (e) { return {}; } }
  var BASE = window.SCENE_BASE_URL || 'http://localhost:3000';

  // kind -> [filter group, plain-language label, level]. Unknown kinds still show, as "other".
  var KINDS = {
    'app.start': ['app', 'App started', 'info'],
    'scene.cut.request': ['scene', 'Cut asked for', 'info'],
    'scene.cut.refused': ['scene', 'Cut not made', 'warn'],
    'scene.cut.dropped': ['scene', 'Cut skipped (out of date)', 'info'],
    'scene.program': ['scene', 'On air', 'ok'],
    'commercial.repeat-ignored': ['scene', 'Commercial already running', 'info'],
    'flow.paused': ['scene', 'Flow paused (kept triggering itself)', 'bad'],
    'obs.connected': ['scene', 'Switcher connected', 'ok'],
    'obs.disconnected': ['scene', 'Switcher disconnected', 'bad'],
    'source.refresh': ['source', 'Browser source refreshed (it never loaded)', 'warn'],
    'rl.connected': ['game', 'Rocket League connected', 'ok'],
    'rl.disconnected': ['game', 'Rocket League disconnected', 'warn'],
    'rl.silent': ['game', 'Rocket League stopped sending data', 'bad'],
    'rl.flowing': ['game', 'Rocket League data flowing again', 'ok'],
    'rl.match.created': ['game', 'Match created', 'info'],
    'rl.match.ended': ['game', 'Match ended', 'info'],
    'rl.goal': ['game', 'Goal', 'info'],
    'rl.event.duplicate': ['game', 'Repeated game event ignored', 'info'],
    'rl.replay.abandoned': ['game', 'Feed lost during a replay: back to the HUD', 'warn'],
    'api.stale': ['api', 'Out-of-date reply ignored', 'info'],
    'poll.failing': ['api', 'Integration failing', 'bad'],
    'poll.recovered': ['api', 'Integration recovered', 'ok'],
  };
  var POLLS = { 'startgg-queue': 'start.gg', challonge: 'Challonge', challengermode: 'Challengermode', nxgen: 'NXGEN', faceit: 'FACEIT', sheets: 'Google Sheets', 'my-events': 'My events', 'team-spotlight': 'Team spotlight', 'twitch-prediction': 'Twitch prediction' };
  function pollName(n) { return POLLS[n] || n || ''; }
  var FILTERS = [['all', 'Everything'], ['problems', 'Problems'], ['scene', 'Scenes'], ['game', 'Game feed'], ['api', 'Integrations'], ['source', 'Browser sources']];

  var built = false, events = [], lastSeq = 0, filter = 'all', fetching = false, lastErr = '', listSig = '';
  function build() {
    if (built) return true;
    var rail = $('set-rail'), content = $('set-content');
    if (!rail || !content) return false;
    built = true;
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'set-rail-btn'; btn.setAttribute('data-stab', 'diagnostics'); btn.textContent = 'Diagnostics';
    var after = rail.querySelector('[data-stab="connections"]') || rail.querySelector('[data-stab="general"]');
    rail.insertBefore(btn, after ? after.nextSibling : null);
    var sec = document.createElement('section');
    sec.className = 'section'; sec.setAttribute('data-setcat', 'diagnostics'); sec.id = 'set-diagnostics';
    sec.style.display = 'none';
    sec.innerHTML = '<h3 class="section-title">Diagnostics</h3>'
      + '<p class="section-desc" style="max-width:720px;">What happened during the show, in order: scene cuts, the game feed, integrations and browser sources. When something goes wrong on air, this shows which step stopped. Bug reports include the last 300 entries automatically.</p>'
      + '<div class="dg-health"></div>'
      + '<div class="dg-tools"><div class="dg-chips">' + FILTERS.map(function (f) { return '<button type="button" data-dg="filter" data-f="' + f[0] + '">' + esc(f[1]) + '</button>'; }).join('') + '</div>'
      + '<span class="dg-sp"></span><button type="button" class="btn btn-ghost btn-sm" data-dg="copy">Copy</button>'
      + '<button type="button" class="btn btn-ghost btn-sm" data-dg="open">Open as text</button></div>'
      + '<div class="dg-list" role="log" aria-live="off"></div>';
    var conn = $('set-connections');
    content.insertBefore(sec, conn ? conn.nextSibling : content.firstChild);
    sec.addEventListener('click', onClick);
    return true;
  }
  function visible() { var sec = $('set-diagnostics'); return !!(sec && sec.style.display !== 'none' && sec.offsetParent); }

  function fetchNew() {
    if (fetching || !visible()) return;
    fetching = true;
    fetch(BASE + '/api/diagnostics/timeline?since=' + lastSeq + '&limit=2000', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        lastErr = '';
        var add = (d && d.events) || [];
        // The app restarted (numbering began again): start over.
        if (add.length && add[0].seq <= lastSeq) { events = []; }
        if (add.length) { events = events.concat(add); if (events.length > 2000) events = events.slice(-2000); lastSeq = events[events.length - 1].seq; }
        render();
      })
      .catch(function (e) { lastErr = 'Could not read the timeline: ' + ((e && e.message) || 'the app did not answer'); render(); })
      .then(function () { fetching = false; });
  }

  function info(e) { return KINDS[e.kind] || ['other', e.kind, 'info']; }
  function detail(e) {
    var d = e.data || {};
    switch (e.kind) {
      case 'scene.cut.request': return (d.to ? '"' + d.to + '"' : '') + (d.transition ? ' with ' + d.transition : '') + (d.by ? ' by ' + d.by : '');
      case 'scene.cut.refused': return (d.to ? '"' + d.to + '"' : '') + (d.reason ? ': ' + String(d.reason).replace(/_/g, ' ') : '');
      case 'scene.cut.dropped': return (d.to ? '"' + d.to + '"' : '') + (d.why ? ': ' + d.why : '');
      case 'scene.program': return (d.from ? '"' + d.from + '" to ' : '') + '"' + (d.to || '') + '"';
      case 'obs.disconnected': return d.error || '';
      case 'source.refresh': return '"' + (d.source || '') + '" (' + (d.page || '') + ')' + (d.attempt > 1 ? ', attempt ' + d.attempt : '');
      case 'flow.paused': return '"' + (d.flow || '') + '" ran ' + (d.runs || '?') + ' times in 10s';
      case 'rl.match.created': return d.series ? 'series ' + (d.series.blue || 0) + '-' + (d.series.orange || 0) : '';
      case 'rl.match.ended': return 'game ' + (d.game || '?') + ', ' + (d.blue != null ? d.blue : '?') + '-' + (d.orange != null ? d.orange : '?');
      case 'rl.goal': return (d.scorer || '') + (d.team != null ? (Number(d.team) === 1 ? ' (right team)' : ' (left team)') : '');
      case 'rl.event.duplicate': return d.event || '';
      case 'rl.silent': return 'no data for 15s' + (d.view ? ' (view: ' + d.view + ')' : '');
      case 'api.stale': return (d.source || '') + (d.what ? ': ' + d.what : '');
      case 'poll.failing': return pollName(d.poll) + (d.error ? ': ' + d.error : '');
      case 'poll.recovered': return pollName(d.poll) + (d.after ? ' after ' + d.after + ' failure' + (d.after === 1 ? '' : 's') : '');
      case 'app.start': return d.version ? 'version ' + d.version : '';
      default: return e.data ? JSON.stringify(e.data).slice(0, 160) : '';
    }
  }
  function time(t) { var d = new Date(t); var p = function (n, w) { return String(n).padStart(w || 2, '0'); }; return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }

  function health(s) {
    var items = [];
    var obs = s.obs || {};
    if (obs.enabled) items.push(obs.connected ? ['ok', 'Switcher connected' + (obs.currentScene ? ': on air "' + obs.currentScene + '"' : '')] : ['bad', 'Switcher not connected']);
    if (s.activeGame === 'rocket-league') {
      items.push(!s.rlConnected ? ['warn', 'Rocket League not connected'] : s.rlStale ? ['bad', 'Rocket League connected but silent'] : ['ok', 'Rocket League data flowing']);
    }
    (s.pollFailures || []).forEach(function (p) { items.push([p.fails >= 3 ? 'bad' : 'warn', pollName(p.name) + ' failing: ' + (p.lastError || 'request failed')]); });
    if (!items.length) items.push(['ok', 'Nothing connected that needs watching']);
    return items.map(function (i) { return '<span class="dg-h" data-lv="' + i[0] + '">' + esc(i[1]) + '</span>'; }).join('');
  }

  function render() {
    if (!build() || !visible()) return;
    var sec = $('set-diagnostics');
    var h = sec.querySelector('.dg-health'), hs = health(cur());
    if (h._sig !== hs) { h._sig = hs; h.innerHTML = hs; }
    [].forEach.call(sec.querySelectorAll('[data-dg="filter"]'), function (b) { b.classList.toggle('is-on', b.getAttribute('data-f') === filter); });
    var shown = events.filter(function (e) {
      var k = info(e);
      return filter === 'all' || (filter === 'problems' ? (k[2] === 'bad' || k[2] === 'warn') : k[0] === filter);
    }).slice(-400).reverse();
    var sig = filter + '|' + lastSeq + '|' + lastErr + '|' + shown.length;
    if (sig === listSig) return;
    listSig = sig;
    var list = sec.querySelector('.dg-list');
    list.innerHTML = (lastErr ? '<div class="dg-err">' + esc(lastErr) + '</div>' : '')
      + (shown.length ? shown.map(function (e) {
        var k = info(e);
        return '<div class="dg-row" data-lv="' + k[2] + '"><time>' + time(e.t) + '</time><b>' + esc(k[1]) + '</b><span>' + esc(detail(e)) + '</span></div>';
      }).join('') : '<div class="dg-empty">' + (events.length ? 'Nothing in this view yet.' : 'Nothing recorded yet. Entries appear here as the show runs.') + '</div>');
  }

  function asText() {
    return events.map(function (e) { var k = info(e); return time(e.t) + '  ' + k[1] + (detail(e) ? '  ' + detail(e) : ''); }).join('\n');
  }
  function onClick(ev) {
    var b = ev.target.closest('[data-dg]'); if (!b) return;
    var act = b.getAttribute('data-dg');
    if (act === 'filter') { filter = b.getAttribute('data-f'); listSig = ''; render(); }
    else if (act === 'copy') {
      var t = asText() || '(empty)';
      var done = function () { if (typeof showToast === 'function') showToast('Timeline copied (' + events.length + ' entries).', '#22c55e', 2500); };
      try { navigator.clipboard.writeText(t).then(done, done); } catch (e) { done(); }
    }
    else if (act === 'open') window.open(BASE + '/api/diagnostics/timeline?format=text&limit=2000', '_blank');
  }

  setInterval(function () { if (visible()) { fetchNew(); render(); } }, 2000);
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('#set-rail [data-stab="diagnostics"]')) { listSig = ''; setTimeout(fetchNew, 30); }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
