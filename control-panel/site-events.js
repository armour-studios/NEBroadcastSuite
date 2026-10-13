/* ─── site-events.js — Event page: your leagues and tournaments from the Nameless website ─────────
   The website is where leagues and tournaments are created and run. This puts them at the top of
   the Event page the way start.gg events load:
     • Your events: every competition you own or staff on the website (state.cloudCompetitions,
       polled by the server each minute). Load = teams + rosters into the library, the league on
       air (ticker, schedule, standings, BRB), the game switched, the live match followed.
     • The loaded event: its matches (live / up next / results) with Put on scoreboard, plus the
       two switches that make it hands-off: Auto-follow the live match and Send scores to the website.
     • Other platforms (start.gg, Challonge, FACEIT, NXGEN, Challengermode, a Google Sheet) are one
       click away (Other platforms, top of the list), folded while a website event is in use.
   Layout: two panes, both on screen without scrolling the page. Left: the event list (search,
   filters, its own scroll). Right: the event name and the loaded event, or the other-platform
   loaders. The page's original pieces (#input-event, the platform tabs/panels, the queue blocks)
   are MOVED into the right pane, never rebuilt, so every handler keeps working. Narrow: stacked.
   Server: loadSiteEvent / putSiteMatchOnAir / siteEventFollow / siteReportCapture in server.js.
   WS: site_event_load {id}, site_event_match {matchId}, site_event_settings, site_event_refresh,
   site_event_unload. Works in both interface styles. */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function tx(type, data) { if (typeof send === 'function') send(type, data || {}); }
  function openUrl(u) {
    if (!u) return;
    if (window.electronAPI && typeof window.electronAPI.openExternal === 'function') window.electronAPI.openExternal(u);
    else window.open(u, '_blank', 'noopener');
  }

  var host = null, pending = '', note = { text: '', bad: false }, lastSig = '';
  var OTHER_KEY = 'ne_sev_other_open';
  function otherOpen() { try { return localStorage.getItem(OTHER_KEY) === '1'; } catch (e) { return false; } }
  function setOtherOpen(v) { try { localStorage.setItem(OTHER_KEY, v ? '1' : '0'); } catch (e) {} }

  function ensureHost() {
    if (host && document.body.contains(host)) return host;
    var sec = document.querySelector('[data-dash-id="event"]');
    var hdr = sec && sec.querySelector('.ev-hdr');
    if (!sec || !hdr) return null;
    host = document.createElement('div');
    host.className = 'sev sev-shell';
    host.id = 'sev-hub';
    // Fixed skeleton: only the boxes re-render, so the search box keeps focus while you type.
    host.innerHTML = '<aside class="sev-side">'
      + '<div class="sev-headbox"></div>'
      + '<div class="sev-browser" hidden>'
      +   '<div class="sev-tools">'
      +     '<div class="sev-search"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8.5" cy="8.5" r="5.5"/><line x1="13" y1="13" x2="17" y2="17"/></svg>'
      +       '<input type="search" class="sev-q" placeholder="Search events, games, hosts..." aria-label="Search events"></div>'
      +     '<div class="sev-seg" role="tablist"></div>'
      +     '<select class="sev-sel sev-game" aria-label="Game"></select>'
      +     '<select class="sev-sel sev-src" aria-label="Source"><option value="">All sources</option><option value="nameless">Nameless website</option><option value="startgg">start.gg</option></select>'
      +     '<select class="sev-sel sev-kind" aria-label="Type"><option value="">All types</option><option value="league">Leagues</option><option value="tournament">Tournaments</option></select>'
      +   '</div>'
      +   '<div class="sev-listbox"></div>'
      + '</div>'
      + '</aside>'
      + '<div class="sev-main"><div class="sev-mainhead"></div><div class="sev-loadedbox"></div><div class="sev-legacy"></div></div>';
    hdr.parentNode.insertBefore(host, hdr.nextSibling);
    // Everything else the page has (event name, platform tabs/panels, queue blocks, the Modern
    // event card and steps) moves into the right pane, in order. Moved, not copied: same nodes,
    // same ids, same handlers. The name field leads the pane: it is what goes on air.
    var main = host.querySelector('.sev-main'), legacy = host.querySelector('.sev-legacy');
    var nameRow = sec.querySelector('#input-event'); nameRow = nameRow && nameRow.closest('.field-row');
    if (nameRow) { nameRow.classList.add('sev-namerow'); host.querySelector('.sev-mainhead').appendChild(nameRow); }
    var adopt = function () {
      Array.prototype.slice.call(sec.children).forEach(function (el) {
        if (el === hdr || el === host) return;
        // The Classic dashboard's layout handle (drag, width, hide) belongs on the section itself.
        if (el.classList && (el.classList.contains('dash-handle') || el.hasAttribute('data-sev-keep'))) return;
        // The Modern event card belongs above the loaders, the rest in page order.
        if (el.classList && el.classList.contains('mx-evhero')) legacy.insertBefore(el, legacy.firstChild);
        else legacy.appendChild(el);
      });
    };
    adopt();
    // Other scripts add to the section later (ui-style.js: the event card and step headings):
    // bring those in too.
    if (typeof MutationObserver === 'function') new MutationObserver(adopt).observe(sec, { childList: true });
    // Two panes side by side when there is room, stacked when not (no container queries in
    // Electron 18: measured here).
    var fit = function () { host.classList.toggle('is-narrow', host.clientWidth > 0 && host.clientWidth < 760); };
    if (typeof ResizeObserver === 'function') new ResizeObserver(fit).observe(host);
    window.addEventListener('resize', fit);
    setTimeout(fit, 0);
    host.addEventListener('click', onClick);
    host.addEventListener('change', onChange);
    var q = host.querySelector('.sev-q');
    q.value = view.q;
    q.addEventListener('input', function () { view.q = q.value; renderList(cur()); });
    q.addEventListener('keydown', function (e) {
      // Enter with exactly one match loads it; Esc clears the search.
      if (e.key === 'Escape') { q.value = ''; view.q = ''; renderList(cur()); }
      if (e.key === 'Enter' && lastShown.length === 1 && lastShown[0].id !== ((cur().siteEvent || {}).id)) loadEvent(lastShown[0].id);
    });
    return host;
  }

  // ── list view state (filters persist per producer) ────────────────────────────────────────
  var VIEW_KEY = 'ne_sev_view_v1';
  var view = (function () {
    var d = { q: '', f: 'all', game: '', kind: '', src: '', showDone: false };
    try { var v = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null'); if (v) { d.f = v.f || 'all'; d.game = v.game || ''; d.kind = v.kind || ''; d.src = v.src || ''; } } catch (e) {}
    return d;
  })();
  function saveView() { try { localStorage.setItem(VIEW_KEY, JSON.stringify({ f: view.f, game: view.game, kind: view.kind, src: view.src })); } catch (e) {} }
  var FOLD_KEY = 'ne_sev_loaded_folded';
  function loadedFolded() { try { return localStorage.getItem(FOLD_KEY) === '1'; } catch (e) { return false; } }
  function cur() { return (typeof currentState !== 'undefined' && currentState) || {}; }
  var lastShown = [];

  // ── formatting ───────────────────────────────────────────────────────────────────────────
  function gameName(s, g) { var x = (s.games || {})[g]; return (x && x.name) || ''; }
  function gameLogo(s, g) { var x = (s.games || {})[g]; return x && x.logo ? '../assets/' + x.logo : ''; }
  function when(ms) {
    if (!ms) return '';
    var d = new Date(ms), now = Date.now(), diff = ms - now;
    var day = 86400000;
    var t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (diff > -day && d.toDateString() === new Date().toDateString()) return 'today ' + t;
    if (diff > 0 && diff < 2 * day && d.toDateString() === new Date(now + day).toDateString()) return 'tomorrow ' + t;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + t;
  }
  function matchWhen(m) {
    if (!m.date) return '';
    var iso = m.date + 'T' + (m.time || '00:00');
    var ms = Date.parse(iso);
    return isNaN(ms) ? m.date : (m.time ? when(ms) : new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' }));
  }
  var STATUS = { draft: 'Draft', registration: 'Registration open', active: 'In progress', completed: 'Finished' };
  var PLAT_LABEL = { startgg: 'start.gg', challonge: 'Challonge', challengermode: 'Challengermode', nxgen: 'NXGEN', faceit: 'FACEIT', league: 'a Sheet / feed' };

  // ── data ─────────────────────────────────────────────────────────────────────────────────
  function loadedLeague(s) {
    var se = s.siteEvent || {};
    if (!se.leagueId) return null;
    return (s.leagues || []).find(function (l) { return l && l.id === se.leagueId; }) || null;
  }
  function teamOf(lg, id) { return (lg.teams || []).find(function (t) { return t.id === id; }) || null; }
  function tName(t) { return (t && (t.teamName || t.name)) || 'TBD'; }
  function mStatus(m) {
    if (m.status === 'live' || m.status === 'cancelled' || m.status === 'postponed') return m.status;
    return m.result && m.result.scoreA != null && m.result.scoreB != null ? 'completed' : 'scheduled';
  }

  // ── render ───────────────────────────────────────────────────────────────────────────────
  // ── start.gg: the tournaments you admin, beside the website's events ───────────────────
  // Fetched from the app's own /api/startgg/my-tournaments while a start.gg token is saved, at
  // most every 10 minutes (Refresh forces it). Rows load through the start.gg loader.
  var BASE = window.SCENE_BASE_URL || 'http://127.0.0.1:3000';
  var sgg = { at: 0, list: [], loading: false, error: '' };
  function fetchSgg(force) {
    var s = cur();
    if (!(s.startgg && s.startgg.hasToken) || sgg.loading) return;
    if (!force && sgg.at && Date.now() - sgg.at < 10 * 60 * 1000) return;
    sgg.loading = true;
    fetch(BASE + '/api/startgg/my-tournaments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) { sgg.list = x.ok ? (x.d.tournaments || []) : []; sgg.error = x.ok ? '' : (x.d.error || 'start.gg did not answer'); })
      .catch(function (e) { sgg.error = (e && e.message) || 'start.gg did not answer'; })
      .then(function () { sgg.loading = false; sgg.at = Date.now(); if (host) host._listSig = ''; render(cur()); });
  }
  function sggRows(s) {
    if (!(s.startgg && s.startgg.hasToken)) return [];
    var now = Date.now();
    return sgg.list.map(function (t) {
      var start = t.startAt ? t.startAt * 1000 : null, end = t.endAt ? t.endAt * 1000 : null;
      var live = !!(start && start <= now && (!end || end >= now));
      return {
        id: 'sgg:' + t.slug, source: 'startgg', slug: t.slug, kind: 'tournament', name: t.name || t.tournamentName || '',
        season: (t.eventCount || 0) + ' event' + (t.eventCount === 1 ? '' : 's'), game: '', gameText: (t.games || []).join(', '),
        host: [t.city, t.countryCode].filter(Boolean).join(', '), live: live, status: end && end < now ? 'completed' : 'active',
        nextMatchAt: start && start > now ? start : null, startsAt: start, updatedAt: start || 0, teams: t.numAttendees || 0, teamsWord: 'entrants',
        logo: t.image || '', url: 'https://www.start.gg/' + String(t.slug || '').replace(/^\/+/, ''), consoleUrl: '',
      };
    });
  }
  // Website events and start.gg tournaments as one list.
  function allEvents(s) {
    var site = (Array.isArray(s.cloudCompetitions) ? s.cloudCompetitions : []).map(function (c) { return Object.assign({ source: 'nameless' }, c); });
    return site.concat(sggRows(s));
  }

  function render(s) {
    s = s || {};
    var h = ensureHost();
    if (!h) return;
    var meta = s.cloudEventsMeta || {};
    var list = Array.isArray(s.cloudCompetitions) ? s.cloudCompetitions : [];
    var se = s.siteEvent || {};
    var lg = loadedLeague(s);
    var plat = (s.activeEvent && s.activeEvent.platform) || '';
    var cap = s.leagueCapture || {};
    var sig = JSON.stringify([meta, se, plat, pending, note, lg && lg.schedule, lg && (lg.teams || []).length, cap.active && cap.matchId, cap.games, otherOpen(), (s.compSync || {})[se.leagueId], sgg.error]);
    fetchSgg(false);
    var merged = allEvents(s);
    var listSig = JSON.stringify([merged, se.id, pending, s.activeEvent && s.activeEvent.slug]);

    var sec = h.parentNode;
    var signedIn = meta.signedIn === true;
    // Other platforms fold away while the website runs the event; another platform loaded opens them.
    var other = otherOpen() || (plat && plat !== 'nameless') || meta.signedIn === false;
    sec.classList.toggle('sev-on', true);
    sec.classList.toggle('sev-other-open', !!other);
    sec.classList.toggle('sev-site-loaded', plat === 'nameless' && !!se.id);

    var browser = h.querySelector('.sev-browser');
    browser.hidden = !merged.length;
    if (h._listSig !== listSig) { h._listSig = listSig; renderList(s); }
    if (sig === lastSig) return;
    lastSig = sig;

    var head = '<div class="sev-head"><div class="sev-head-t"><b>Your events</b><span>' + (merged.length ? merged.length + ' from the Nameless website' + (sggRows(s).length ? ' and start.gg' : '') : 'From the Nameless website') + '</span></div>'
      + '<div class="sev-head-a">'
      + (signedIn ? '<button type="button" class="btn btn-ghost btn-sm" data-sev="refresh" title="Check the website and start.gg now">Refresh</button>' : '')
      + '<button type="button" class="btn btn-secondary btn-sm" data-sev="create" title="Leagues and tournaments are created and edited on the website; the app fills in teams, matches, scores and standings by itself.">Create</button>'
      + '</div></div>'
      // While another platform's event is loaded its loaders ARE the event view: there is nothing to
      // go back to, so the button says what is loaded instead of a Back that does nothing.
      // Signed out, the platform loaders are the only way in and always shown: no toggle to offer.
      + (meta.signedIn === false ? ''
        : plat && plat !== 'nameless'
          ? '<div class="sev-otherbtn is-on is-static">Loaded from ' + esc(PLAT_LABEL[plat] || plat) + '<span>Load a website event to switch back</span></div>'
          : '<button type="button" class="sev-otherbtn' + (other ? ' is-on' : '') + '" data-sev="other">'
            + (other ? 'Back to your events' : 'Load from another platform') + '<span>' + (other ? '' : 'start.gg, Challonge, FACEIT, NXGEN, Sheets') + '</span></button>');
    if (note.text) head += '<div class="sev-note' + (note.bad ? ' bad' : '') + '">' + esc(note.text) + '</div>';
    if (meta.error && signedIn) head += '<div class="sev-note bad">Could not get your events from the website: ' + esc(meta.error) + '</div>';
    if (sgg.error && s.startgg && s.startgg.hasToken) head += '<div class="sev-note bad">start.gg: ' + esc(sgg.error) + '</div>';
    if (!meta.loaded) {
      head += '<div class="sev-empty">Checking the website for your events...</div>';
    } else if (!signedIn) {
      head += '<div class="sev-empty"><b>Sign in to see your events</b><span>Sign in with your Nameless account and every league and tournament you run shows up here, ready to load.</span>'
        + '<div class="sev-empty-a"><button type="button" class="btn btn-primary btn-sm" data-sev="signin">Sign in</button></div></div>';
    } else if (!list.length) {
      head += '<div class="sev-empty"><b>No events yet</b><span>Create a league or tournament on the website and it appears here within a minute. Events you are staff on (owner, admin, moderator or caster) show up too.</span>'
        + '<div class="sev-empty-a"><button type="button" class="btn btn-primary btn-sm" data-sev="create">Create an event</button></div></div>';
    }
    h.querySelector('.sev-headbox').innerHTML = head;
    // Right pane: the website event you are producing; or, while another platform is in use, its
    // own loaders (the legacy pane); or a pointer to the list when nothing is loaded yet.
    var showLegacy = !!other;
    h.querySelector('.sev-legacy').hidden = !showLegacy;
    h.querySelector('.sev-loadedbox').innerHTML = lg && plat === 'nameless' && !showLegacy ? loadedPanel(s, lg, se, cap)
      : (!showLegacy ? '<div class="sev-pick"><b>No event loaded</b><span>Pick one from your events' + (h.classList.contains('is-narrow') ? ' above' : ' on the left') + ' and press Load: teams, rosters, matches and standings fill in by themselves, and the live match goes on the scoreboard.</span></div>' : '');
  }

  // ── The list: search, quick filters and date groups ─────────────────────────────────────
  var DAY = 86400000;
  function startOfDay(t) { var d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function isDone(c) { return c.status === 'completed' || c.status === 'archived'; }
  function bucketOf(c) {
    if (c.live) return 'live';
    if (isDone(c)) return 'done';
    var t = c.nextMatchAt || c.startsAt;
    if (!t) return 'nodate';
    var today = startOfDay(Date.now());
    if (t < today + DAY) return 'today';
    if (t < today + 7 * DAY) return 'week';
    return 'later';
  }
  var BUCKETS = [['live', 'Live now'], ['today', 'Today'], ['week', 'Next 7 days'], ['later', 'Later'], ['nodate', 'No matches scheduled'], ['done', 'Finished']];
  var FILTERS = [['all', 'All'], ['live', 'Live'], ['week', '7 days'], ['upcoming', 'Upcoming'], ['done', 'Finished']];
  function passFilter(c, f) {
    var b = bucketOf(c);
    if (f === 'live') return b === 'live';
    if (f === 'week') return b === 'live' || b === 'today' || b === 'week';
    if (f === 'upcoming') return b !== 'done';
    if (f === 'done') return b === 'done';
    return true;
  }
  function matchesQuery(s, c, q) {
    if (!q) return true;
    var hay = [c.name, c.season, c.host, gameName(s, c.game), c.game, c.gameText, c.kind, c.source === 'startgg' ? 'start.gg startgg' : 'nameless', STATUS[c.status] || c.status].join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every(function (w) { return hay.indexOf(w) >= 0; });
  }

  function renderList(s) {
    var h = host; if (!h) return;
    var list = allEvents(s);
    var se = s.siteEvent || {};
    // Toolbar: filter counts follow the search and the game/type pickers, so a number is what you get.
    var base = list.filter(function (c) {
      return (!view.src || c.source === view.src) && (!view.game || c.game === view.game) && (!view.kind || c.kind === view.kind) && matchesQuery(s, c, view.q);
    });
    h.querySelector('.sev-seg').innerHTML = FILTERS.map(function (f) {
      var n = base.filter(function (c) { return passFilter(c, f[0]); }).length;
      return '<button type="button" role="tab" data-sevf="' + f[0] + '" class="' + (view.f === f[0] ? 'is-on' : '') + (f[0] === 'live' && n ? ' has-live' : '') + '"' + (n || f[0] === 'all' ? '' : ' disabled') + '>' + f[1] + '<em>' + n + '</em></button>';
    }).join('');
    var games = {};
    list.forEach(function (c) { if (c.game) games[c.game] = (games[c.game] || 0) + 1; });
    var gs = h.querySelector('.sev-game');
    var gKeys = Object.keys(games).sort(function (a, b) { return (gameName(s, a) || a).localeCompare(gameName(s, b) || b); });
    gs.innerHTML = '<option value="">All games</option>' + gKeys.map(function (g) { return '<option value="' + esc(g) + '">' + esc(gameName(s, g) || g) + ' (' + games[g] + ')</option>'; }).join('');
    gs.value = games[view.game] ? view.game : '';
    gs.hidden = gKeys.length < 2;
    var ss = h.querySelector('.sev-src');
    ss.value = view.src;
    ss.hidden = !(list.some(function (c) { return c.source === 'nameless'; }) && list.some(function (c) { return c.source === 'startgg'; }));
    var ks = h.querySelector('.sev-kind');
    ks.value = view.kind;
    ks.hidden = !(list.some(function (c) { return c.kind === 'league'; }) && list.some(function (c) { return c.kind === 'tournament'; }));

    var shown = base.filter(function (c) { return passFilter(c, view.f); });
    lastShown = shown;
    var out = '';
    if (!shown.length) {
      out = '<div class="sev-none">No events match' + (view.q ? ' "' + esc(view.q) + '"' : '') + '. <button type="button" class="sev-link" data-sev="clear">Clear the filters</button></div>';
    } else {
      var soon = function (a, b) { return (b.id === se.id) - (a.id === se.id) || (a.nextMatchAt || a.startsAt || 9e15) - (b.nextMatchAt || b.startsAt || 9e15) || String(a.name).localeCompare(String(b.name)); };
      BUCKETS.forEach(function (bk) {
        var rows = shown.filter(function (c) { return bucketOf(c) === bk[0]; });
        if (!rows.length) return;
        if (bk[0] === 'done') rows.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
        else rows.sort(soon);
        // Finished events fold away unless you asked for them.
        var fold = bk[0] === 'done' && view.f !== 'done' && !view.q && !view.showDone;
        out += '<div class="sev-group sev-group--' + bk[0] + '"><div class="sev-group-h">' + bk[1] + '<em>' + rows.length + '</em>'
          + (bk[0] === 'done' && view.f !== 'done' && !view.q ? '<button type="button" class="sev-link" data-sev="done">' + (fold ? 'Show' : 'Hide') + '</button>' : '') + '</div>'
          + (fold ? '' : '<div class="sev-rows">' + rows.map(function (c) { return row(s, c, se); }).join('') + '</div>') + '</div>';
      });
    }
    h.querySelector('.sev-listbox').innerHTML = out;
  }

  var ICON_EXT = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
  function row(s, c, se) {
    var ae = s.activeEvent || {};
    var loaded = c.source === 'startgg' ? (ae.platform === 'startgg' && String(ae.slug || '').indexOf(String(c.slug || '').replace(/^tournament\//, '')) >= 0) : c.id === se.id;
    var busy = pending === c.id;
    var logo = c.logo || gameLogo(s, c.game);
    var gLogo = gameLogo(s, c.game);
    var sub = [c.kind === 'tournament' ? 'Tournament' : 'League', c.season, c.host, c.teams ? c.teams + ' ' + (c.teamsWord || 'teams') : ''].filter(Boolean).join(' · ');
    var nextTxt = c.live ? '<span class="sev-badge live">Live</span>'
      : isDone(c) ? '<span class="sev-dim">Finished</span>'
      : c.nextMatchAt ? '<span title="Next match">' + esc(when(c.nextMatchAt)) + '</span>'
      : '<span class="sev-dim">' + esc(STATUS[c.status] || 'No matches yet') + '</span>';
    var gTxt = gameName(s, c.game) || c.gameText || c.game || '';
    return '<div class="sev-row' + (loaded ? ' is-loaded' : '') + (c.live ? ' is-live' : '') + '">'
      + (logo ? '<img class="sev-row-logo" alt="" src="' + esc(logo) + '">' : '<span class="sev-row-logo"></span>')
      + '<div class="sev-row-main"><b title="' + esc(c.name) + '">' + esc(c.name || 'Untitled event') + '</b>'
      +   '<span class="sev-row-l2"><span class="sev-row-next">' + nextTxt + '</span>'
      +     (gTxt ? '<span class="sev-row-game" title="' + esc(c.gameText || gTxt) + '">' + (gLogo ? '<img alt="" src="' + esc(gLogo) + '">' : '') + '<em>' + esc(gTxt) + '</em></span>' : '') + '</span>'
      +   '<span class="sev-row-l3">' + (c.source === 'startgg' ? '<i class="sev-src-tag">start.gg</i>' : '') + esc(sub) + '</span></div>'
      + '<div class="sev-row-a">'
      + (loaded ? '<span class="sev-loaded">Loaded</span>'
                : '<button type="button" class="btn ' + (c.live ? 'btn-primary' : 'btn-secondary') + ' btn-sm" data-sev="load" data-id="' + esc(c.id) + '"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Loading...' : 'Load') + '</button>')
      + (c.consoleUrl || c.url ? '<button type="button" class="sev-ext" data-sev="open" data-url="' + esc(c.consoleUrl || c.url) + '" title="' + (c.source === 'startgg' ? 'Open on start.gg' : 'Manage on the website') + '" aria-label="Open the event page">' + ICON_EXT + '</button>' : '')
      + '</div></div>';
  }

  function loadedPanel(s, lg, se, cap) {
    var sched = (lg.schedule || []).slice();
    var live = [], next = [], done = [];
    sched.forEach(function (m) {
      var st = mStatus(m);
      if (st === 'live') live.push(m); else if (st === 'completed') done.push(m); else if (st !== 'cancelled') next.push(m);
    });
    var key = function (m) { return (m.date || '9999') + (m.time || ''); };
    next.sort(function (a, b) { return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0; });
    done.sort(function (a, b) { return key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0; });
    var onAir = cap.active && cap.leagueId === lg.id ? cap.matchId : '';
    var row = function (m) {
      var st = mStatus(m), a = teamOf(lg, m.teamA), b = teamOf(lg, m.teamB);
      var score = m.result && m.result.scoreA != null ? '<b class="sev-score">' + esc(m.result.scoreA) + ' - ' + esc(m.result.scoreB) + '</b>' : '<span class="sev-vs">vs</span>';
      var logo = function (t) { return t && t.logo ? '<img alt="" src="' + esc(t.logo) + '">' : '<i></i>'; };
      var tags = [];
      if (st === 'live') tags.push('<span class="sev-badge live">Live</span>');
      if (m.onStream || m.featured) tags.push('<span class="sev-badge stream">' + esc(m.streamName || 'On stream') + (m.queuePos ? ' #' + esc(m.queuePos) : '') + '</span>');
      var isOn = onAir === m.id;
      return '<div class="sev-m' + (isOn ? ' is-on' : '') + '">'
        + '<div class="sev-m-teams"><span class="sev-m-t">' + logo(a) + esc(tName(a)) + '</span>' + score + '<span class="sev-m-t sev-m-t--b">' + esc(tName(b)) + logo(b) + '</span></div>'
        + '<div class="sev-m-meta">' + esc([m.round, matchWhen(m), m.format ? m.format.toUpperCase() : ''].filter(Boolean).join(' · ')) + tags.join('') + '</div>'
        + (isOn ? '<span class="sev-m-on">On the scoreboard' + (cap.games && cap.games.length ? ' · game ' + (cap.games.length + 1) : '') + '</span>'
                : st !== 'completed' ? '<button type="button" class="btn btn-secondary btn-sm" data-sev="match" data-id="' + esc(m.id) + '">Put on scoreboard</button>' : '')
        + '</div>';
    };
    var group = function (title, rows, empty, max) {
      return '<div class="sev-mg"><div class="sev-mg-h">' + title + (rows.length ? ' <em>' + rows.length + '</em>' : '') + '</div>'
        + (rows.length ? rows.slice(0, max).map(row).join('') + (rows.length > max ? '<div class="sev-more">' + (rows.length - max) + ' more on the website</div>' : '') : '<div class="sev-mg-empty">' + empty + '</div>') + '</div>';
    };
    var sync = (s.compSync || {})[lg.id] || {};
    var syncLine = sync.lastError ? '<span class="bad">' + esc(sync.lastError) + '</span>'
      : sync.lastOkAt ? 'Synced ' + esc(new Date(sync.lastOkAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) + (sync.summary ? ' · ' + esc(sync.summary) : '') : '';
    var folded = loadedFolded();
    var liveLine = live.length ? ' · <b class="sev-livecount">' + live.length + ' live</b>' : '';
    return '<div class="sev-live' + (folded ? ' is-folded' : '') + '">'
      + '<div class="sev-live-h"><div><b>' + esc((s.activeEvent && s.activeEvent.name) || lg.name) + '</b><span>' + syncLine + liveLine + '</span></div>'
      + '<div class="sev-live-h-a"><button type="button" class="btn btn-ghost btn-sm" data-sev="fold">' + (folded ? 'Show matches' : 'Hide matches') + '</button>'
      + '<button type="button" class="btn btn-ghost btn-sm" data-sev="unload" title="Stop following this event (it stays on the website)">Unload</button></div></div>'
      + '<div class="sev-switches">'
      + '<label class="sev-sw"><label class="switch"><input type="checkbox" data-sevset="autoFollow"' + (se.autoFollow !== false ? ' checked' : '') + '><span class="slider"></span></label><span><b>Auto-follow</b> When the website marks a match on your stream live, it goes on the scoreboard. A series you are in the middle of is never switched away.</span></label>'
      + '<label class="sev-sw"><label class="switch"><input type="checkbox" data-sevset="autoReport"' + (se.autoReport !== false ? ' checked' : '') + '><span class="slider"></span></label><span><b>Send scores to the website</b> Each game result goes up as it ends, and the final score moves the bracket and standings on. Needs organizer or moderator access.</span></label>'
      + '</div>'
      + (se.lastReport ? '<div class="sev-note' + (se.lastReportOk === false ? ' bad' : '') + '">' + esc(se.lastReport) + '</div>' : '')
      + '<div class="sev-mgs">' + group('Live now', live, 'Nothing live. Matches the website marks in progress show here.', 6) + group('Up next', next, 'No matches scheduled.', 8) + group('Results', done, 'No results yet.', 5) + '</div>'
      + '</div>';
  }

  // ── actions ──────────────────────────────────────────────────────────────────────────────
  function loadEvent(id) {
    // A start.gg tournament goes through the start.gg loader (it may ask which of its events).
    if (String(id || '').indexOf('sgg:') === 0) {
      setOtherOpen(true);
      var tab = document.querySelector('.ev-plat-tab[data-plat="startgg"]'); if (tab) tab.click();
      tx('load_startgg_url', { url: 'https://www.start.gg/' + id.slice(4).replace(/^\/+/, '') });
      note = { text: 'Loading from start.gg: teams first, then the bracket. If the tournament has more than one event, pick it below.', bad: false };
      lastSig = ''; if (host) host._listSig = '';
      render(cur());
      return;
    }
    pending = id || '';
    note = { text: '', bad: false };
    tx('site_event_load', { id: pending });
    if (host) host._listSig = '';
    lastSig = '';
    render(cur());
  }
  function onClick(e) {
    var f = e.target.closest('[data-sevf]');
    if (f) { view.f = f.getAttribute('data-sevf'); view.showDone = false; saveView(); renderList(cur()); return; }
    var b = e.target.closest('[data-sev]');
    if (!b) return;
    var act = b.getAttribute('data-sev');
    var s = cur();
    if (act === 'load') {
      loadEvent(b.getAttribute('data-id'));
    } else if (act === 'clear') {
      view.q = ''; view.f = 'all'; view.game = ''; view.kind = ''; view.src = ''; saveView();
      var q = host.querySelector('.sev-q'); if (q) q.value = '';
      renderList(s);
    } else if (act === 'fold') {
      try { localStorage.setItem(FOLD_KEY, loadedFolded() ? '0' : '1'); } catch (er) {}
      lastSig = '';
      render(s);
    } else if (act === 'done') {
      view.showDone = !view.showDone;
      renderList(s);
    } else if (act === 'match') {
      tx('site_event_match', { matchId: b.getAttribute('data-id') });
    } else if (act === 'refresh') {
      note = { text: 'Checking the website...', bad: false };
      tx('site_event_refresh');
      fetchSgg(true);
      render(s);
    } else if (act === 'unload') {
      tx('site_event_unload');
    } else if (act === 'create') {
      openUrl((s.cloudEventsMeta && s.cloudEventsMeta.createUrl) || 'https://www.namelessesports.com/compete/console/new');
    } else if (act === 'open') {
      openUrl(b.getAttribute('data-url'));
    } else if (act === 'signin') {
      var si = $('btn-discord-login');
      if (si) si.click(); else if (typeof window.openSettings === 'function') window.openSettings('profile');
    } else if (act === 'other') {
      var sec = host && host.parentNode;
      setOtherOpen(!(sec && sec.classList.contains('sev-other-open')));
      lastSig = '';
      render(s);
    }
  }
  function onChange(e) {
    var t = e.target;
    if (t && t.classList.contains('sev-game')) { view.game = t.value; saveView(); renderList(cur()); return; }
    if (t && t.classList.contains('sev-kind')) { view.kind = t.value; saveView(); renderList(cur()); return; }
    if (t && t.classList.contains('sev-src')) { view.src = t.value; saveView(); renderList(cur()); return; }
    var k = t && t.getAttribute('data-sevset');
    if (!k) return;
    var d = {}; d[k] = !!e.target.checked;
    tx('site_event_settings', d);
  }
  function onResult(d) {
    var s = (typeof currentState !== 'undefined' && currentState) || {};
    if (d.refreshed) note = { text: '', bad: false };
    else if (d.ok && d.leagueId) note = { text: 'Loaded: ' + (d.teams || 0) + ' teams, ' + (d.matches || 0) + ' matches. ' + (d.summary || ''), bad: false };
    else if (!d.ok) note = { text: d.error || 'That did not work.', bad: true };
    pending = '';
    lastSig = '';
    if (host) host._listSig = '';
    render(s);
    // The loaded event opens above the list: bring it into view.
    if (d.ok && d.leagueId && host && host.classList.contains('is-narrow')) { var lb = host.querySelector('.sev-loadedbox'); if (lb && lb.firstChild) lb.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    if (d.ok && d.leagueId) setTimeout(function () { note = { text: '', bad: false }; lastSig = ''; render((typeof currentState !== 'undefined' && currentState) || {}); }, 8000);
  }

  // A crest that will not load is hidden, never a broken icon.
  document.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t.tagName === 'IMG' && t.closest && t.closest('.sev')) t.style.visibility = 'hidden';
  }, true);

  window.__siteEvents = {
    render: render, onResult: onResult,
    // Search ("Other platforms") lands on the loaders: open them first, or the flash hits a hidden box.
    openOther: function () { setOtherOpen(true); lastSig = ''; render(cur()); },
  };
})();
