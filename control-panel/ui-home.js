/* ─── ui-home.js — the Modern Home page ───────────────────────────────────────────────────────
   Loads after ui-style.js, which adds the Home rail item (view "home") and calls
   window.__mxHome.render(state) on refresh. The page is Nameless Esports' front door inside the
   suite, and it keeps itself up to date from namelessesports.com (local GET /api/site-home, which
   server.js fills from the website every few minutes and caches for offline use):
     - headline, services and links: the website's own copy (lib/broadcast-home.ts on the site)
     - live matches, upcoming events, news, track record and partners: what the website shows
     - Your communities / Your events: the signed-in producer's own, from GET /api/broadcast/me
   The built-in copy below is only the fallback for a first run with no connection.
   Everything here is Modern-only (.mx-only); Classic never sees it. */
(function () {
  var root = document.documentElement;
  function isModern() { return root.getAttribute('data-ui') === 'modern'; }
  function $(id) { return document.getElementById(id); }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var BASE = window.SCENE_BASE_URL || 'http://localhost:3000';
  var SITE = 'https://www.namelessesports.com';

  // Fallback copy (first run, offline). The website's version replaces it as soon as it arrives.
  var FALLBACK = {
    hero: {
      eyebrow: 'Nameless Esports',
      title: 'Community esports, produced properly.',
      body: 'Tournaments, leagues and broadcasts for the community. This suite is how we run our shows, and how you can run yours.',
      ctas: [{ label: 'See upcoming events', url: SITE + '/tournaments', primary: true }, { label: 'Communities', url: SITE + '/communities' }, { label: 'Join the team', url: SITE + '/join' }]
    },
    services: [
      { title: 'Broadcast production', body: 'Full show production for your tournament or league: graphics, casters, replays and multi-stream delivery.', url: SITE + '/organizers' },
      { title: 'Tournament operations', body: 'Brackets, schedules and stream queues run on start.gg or our own competition platform.', url: SITE + '/tournaments' },
      { title: 'Communities', body: 'Run your community on Nameless: members, leagues, ladders and your own branded pages.', url: SITE + '/communities' },
      { title: 'The studio suite', body: 'This app, white-labelled for your organisation, with your brand kits and overlays.', url: SITE + '/platform' }
    ],
    links: [{ label: 'Tournaments', url: SITE + '/tournaments' }, { label: 'Communities', url: SITE + '/communities' }, { label: 'News', url: SITE + '/news' }, { label: 'Leaderboards', url: SITE + '/leaderboards' }, { label: 'Join the team', url: SITE + '/join' }]
  };

  var home = null;
  var site = null, siteAt = 0, siteLoading = false, siteFirst = true;   // GET /api/site-home snapshot
  var promos = null, promosAt = 0;

  // ── helpers ────────────────────────────────────────────────────────────────────
  function day(ms) { return ms ? new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : ''; }
  function dayTime(ms) { return ms ? new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; }
  function ago(ms) {
    if (!ms) return '';
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return day(ms);
  }
  function relDay(ms) {
    if (!ms) return '';
    var d = new Date(ms), now = new Date();
    var a = new Date(d.getFullYear(), d.getMonth(), d.getDate()), b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var diff = Math.round((a - b) / 86400000);
    var t = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (diff === 0) return 'Today ' + t;
    if (diff === 1) return 'Tomorrow ' + t;
    return dayTime(ms);
  }
  function money(n) { return '$' + Math.round(n).toLocaleString(); }
  function initials(name) { return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase(); }
  function link(url, cls, inner) { return url ? '<a class="' + cls + '" href="' + esc(url) + '" target="_blank" rel="noopener">' + inner + '</a>' : '<div class="' + cls + '">' + inner + '</div>'; }
  function mark(img, name, color) {
    return img ? '<img class="mx-home-mark" src="' + esc(img) + '" alt="" loading="lazy">'
      : '<span class="mx-home-mark is-text"' + (color ? ' style="background:' + esc(color) + '"' : '') + '>' + esc(initials(name)) + '</span>';
  }
  function setSig(el, sig) { if (el._sig === sig) return false; el._sig = sig; return true; }
  var ROLE = { owner: 'Owner', admin: 'Admin', manager: 'Manager', staff: 'Staff', coach: 'Coach', member: 'Member', moderator: 'Moderator', caster: 'Caster', producer: 'Producer', operator: 'Operator', talent: 'Talent', analyst: 'Analyst' };
  function roleName(r) { return ROLE[r] || (r ? r[0].toUpperCase() + r.slice(1) : ''); }
  var STATUS = { draft: 'Draft', registration: 'Registration open', active: 'In progress', completed: 'Finished', upcoming: 'Upcoming', playoffs: 'Playoffs', pending: 'Pending', checkin: 'Check-in' };
  function statusName(s) { return STATUS[s] || (s ? s[0].toUpperCase() + s.slice(1) : ''); }

  // ── build ──────────────────────────────────────────────────────────────────────
  function card(cls, title, extra) {
    return '<div class="mx-card ' + cls + '"><div class="mx-card-head"><span class="mx-card-title">' + esc(title) + '</span>' + (extra || '') + '</div><div class="mx-home-body"></div></div>';
  }
  function build() {
    if (home || !isModern()) return;
    var host = $('tab-principal-content'); if (!host) return;
    home = document.createElement('section');
    home.className = 'mx-only mx-home';
    home.id = 'mx-home';
    home.innerHTML =
      '<div class="mx-home-hero">'
      + '<img class="mx-home-logo" src="../assets/nelogo.png" alt="">'
      + '<div class="mx-home-hero-text"></div>'
      + '<div class="mx-card mx-home-tonight"><div class="mx-card-head"><span class="mx-card-title">Tonight</span><span class="mx-home-tonight-state"></span></div><div class="mx-home-tonight-body"></div>'
      +   '<button type="button" class="mx-btn mx-btn-wide mx-btn-primary" data-home="cr">Open the Dashboard</button></div>'
      + '</div>'
      + '<div class="mx-home-live" hidden></div>'
      + '<div class="mx-home-mine">'
      +   card('mx-home-comms', 'Your communities', '<a class="mx-link" href="' + SITE + '/communities" target="_blank" rel="noopener">Find communities</a>')
      +   card('mx-home-myev', 'Your events', '<span class="mx-home-fresh"></span><button type="button" class="mx-link mx-home-refresh" data-home="refresh" title="Pull the latest from namelessesports.com">Refresh</button>')
      + '</div>'
      + '<div class="mx-home-grid">'
      +   card('mx-home-events', 'Upcoming Nameless events', '<a class="mx-link" href="' + SITE + '/tournaments" target="_blank" rel="noopener">All events</a>')
      +   card('mx-home-news', 'News', '<a class="mx-link" href="' + SITE + '/news" target="_blank" rel="noopener">All news</a>')
      +   '<div class="mx-home-side">'
      +     card('mx-home-stats', 'Track record')
      +     card('mx-home-links', 'namelessesports.com')
      +     card('mx-home-partners', 'Partners')
      +   '</div>'
      + '</div>'
      + card('mx-home-services', 'What we do');
    var cr = $('mx-cr');
    if (cr) host.insertBefore(home, cr); else host.insertBefore(home, host.firstChild);
    home.addEventListener('click', function (e) {
      var b = e.target.closest('[data-home]'); if (!b) return;
      var what = b.getAttribute('data-home');
      if (what === 'cr') { var item = document.querySelector('.mx-nav [data-mx-item="live"]'); if (item) item.click(); }
      else if (what === 'refresh') { loadSite(true); }
      else if (what === 'signin') { var s = $('btn-discord-login'); if (s) s.click(); }
      else if (what === 'events-page') { var ev = document.querySelector('.mx-nav [data-mx-item="event"]'); if (ev) ev.click(); }
      else if (what === 'load-event') {
        var nav = document.querySelector('.mx-nav [data-mx-item="event"]'); if (nav) nav.click();
        if (typeof send === 'function') send('site_event_load', { id: b.getAttribute('data-id') });
        b.textContent = 'Loading...'; b.disabled = true;
      }
    });
  }
  function body(cls) { return home.querySelector('.' + cls + ' .mx-home-body'); }

  // ── data ───────────────────────────────────────────────────────────────────────
  function loadSite(force) {
    if (siteLoading) return;
    if (!force && Date.now() - siteAt < 60 * 1000) return;
    siteLoading = true;
    var btn = home && home.querySelector('.mx-home-refresh'); if (force && btn) btn.textContent = 'Refreshing...';
    var q = (force || siteFirst) ? '?refresh=1' : '';
    siteFirst = false;
    fetch(BASE + '/api/site-home' + q).then(function (r) { return r.json(); }).then(function (d) {
      site = d || {}; siteAt = Date.now(); siteLoading = false;
      if (btn) btn.textContent = 'Refresh';
      renderAll();
    }).catch(function () { siteAt = Date.now(); siteLoading = false; if (btn) btn.textContent = 'Refresh'; renderAll(); });
  }
  function loadPromos() {
    if (Date.now() - promosAt < 10 * 60 * 1000) return;
    promosAt = Date.now();
    fetch(BASE + '/api/promos').then(function (r) { return r.json(); }).then(function (d) {
      promos = (d && Array.isArray(d.promos)) ? d.promos : []; renderEvents();
    }).catch(function () { promos = promos || []; });
  }
  function siteHome() { return (site && site.home) || null; }
  function copy(key) { var h = siteHome(); return (h && h[key] && (Array.isArray(h[key]) ? h[key].length : true)) ? h[key] : FALLBACK[key]; }

  // ── render ─────────────────────────────────────────────────────────────────────
  function renderHero() {
    var el = home.querySelector('.mx-home-hero-text');
    var h = copy('hero');
    if (!setSig(el, JSON.stringify(h))) return;
    el.innerHTML = '<span class="mx-home-kicker">' + esc(h.eyebrow) + '</span><h2>' + esc(h.title) + '</h2><p>' + esc(h.body) + '</p>'
      + '<div class="mx-home-cta">' + (h.ctas || []).map(function (c, i) {
        return '<a class="mx-btn' + (c.primary || i === 0 ? ' mx-btn-primary' : (i === 2 ? ' mx-btn-quiet' : '')) + '" href="' + esc(c.url) + '" target="_blank" rel="noopener">' + esc(c.label) + '</a>';
      }).join('') + '</div>';
  }

  function renderLive() {
    var el = home.querySelector('.mx-home-live');
    var h = siteHome(), live = (h && h.live) || { matches: [], events: [] };
    var ms = live.matches || [], evs = live.events || [];
    if (!setSig(el, JSON.stringify([ms, evs]))) return;
    el.hidden = !ms.length && !evs.length;
    if (el.hidden) { el.innerHTML = ''; return; }
    var ours = ms.some(function (m) { return m.ours; });
    el.innerHTML = '<div class="mx-home-live-head"><span class="mx-home-live-dot"></span>' + (ours ? 'Live on Nameless' : 'Live now in esports') + '</div>'
      + '<div class="mx-home-live-row">'
      + ms.map(function (m) {
        var sc = (m.scoreA != null && m.scoreB != null) ? '<em>' + esc(m.scoreA) + ' - ' + esc(m.scoreB) + '</em>' : '<em>vs</em>';
        return link(m.streamUrl || m.url, 'mx-home-live-match', '<small>' + esc([m.context, m.round].filter(Boolean).join(' · ')) + '</small><span><b>' + esc(m.a) + '</b>' + sc + '<b>' + esc(m.b) + '</b></span>');
      }).join('')
      + evs.map(function (e) {
        return link(e.url, 'mx-home-live-match is-event', '<small>Event live' + (e.entrants ? ' · ' + esc(e.entrants) + ' entrants' : '') + '</small><span><b>' + esc(e.title) + '</b></span>');
      }).join('')
      + '</div>';
  }

  function signInPrompt(what) {
    var cloudOff = site && site.signedIn === false;
    return '<div class="mx-empty-state"><b>Sign in to see your ' + what + '</b><span>Your Nameless account brings your communities, the events you run or play in, and your next matches onto this page.</span>'
      + (cloudOff ? '<div class="empty-state-acts"><button type="button" class="mx-btn mx-btn-primary" data-home="signin">Sign in</button></div>' : '') + '</div>';
  }

  function renderCommunities() {
    var el = body('mx-home-comms');
    var me = site && site.me;
    var sig = JSON.stringify([!!site, site && site.signedIn, site && site.meError, me && me.communities, me && me.orgs]);
    if (!setSig(el, sig)) return;
    if (!site) { el.innerHTML = '<p class="mx-hint">Loading...</p>'; return; }
    if (!site.signedIn) { el.innerHTML = signInPrompt('communities'); return; }
    if (!me) {
      el.innerHTML = site.meError === 'not-available'
        ? '<p class="mx-hint">Your communities will show here once namelessesports.com is updated.</p>'
        : '<p class="mx-hint">Loading your communities...</p>';
      return;
    }
    var list = me.communities || [], orgs = me.orgs || [];
    if (!list.length && !orgs.length) {
      el.innerHTML = '<div class="mx-empty-state"><b>You are not in a community yet</b><span>Join one on namelessesports.com, or start your own for your league or school.</span>'
        + '<div class="empty-state-acts"><a class="mx-btn mx-btn-primary" href="' + SITE + '/communities" target="_blank" rel="noopener">Browse communities</a></div></div>';
      return;
    }
    el.innerHTML = '<div class="mx-home-list">'
      + list.slice(0, 6).map(function (c) {
        var meta = [roleName(c.role), c.members ? c.members + ' member' + (c.members === 1 ? '' : 's') : '', c.competitions ? c.competitions + ' competition' + (c.competitions === 1 ? '' : 's') : ''].filter(Boolean).join(' · ');
        var ann = c.announcement ? '<span class="mx-home-ann">' + esc(c.announcement.text) + (c.announcement.at ? ' <i>' + esc(ago(c.announcement.at)) + '</i>' : '') + '</span>' : '';
        return link(c.url, 'mx-home-row', mark(c.logo, c.name, c.color) + '<span class="mx-home-row-text"><b>' + esc(c.name) + (c.verified ? ' <span class="mx-home-verified" title="Verified">✓</span>' : '') + '</b><span>' + esc(meta) + '</span>' + ann + '</span>');
      }).join('')
      + orgs.slice(0, 3).map(function (o) {
        return '<div class="mx-home-row">' + mark(o.logo, o.name) + '<span class="mx-home-row-text"><b>' + esc(o.name) + '</b><span>Organisation · ' + esc(roleName(o.seatRole)) + ' seat in this suite</span></span></div>';
      }).join('')
      + '</div>'
      + (list.length > 6 ? '<a class="mx-link mx-home-more" href="' + SITE + '/communities" target="_blank" rel="noopener">' + (list.length - 6) + ' more on namelessesports.com</a>' : '');
  }

  function renderMyEvents() {
    var el = body('mx-home-myev');
    var fresh = home.querySelector('.mx-home-fresh');
    if (fresh) fresh.textContent = site && site.meAt ? 'Updated ' + ago(site.meAt) : (site && site.homeAt ? 'Updated ' + ago(site.homeAt) : '');
    var me = site && site.me;
    var s = (typeof currentState !== 'undefined' && currentState) || {};
    var local = (Array.isArray(s.myEvents) ? s.myEvents : []).slice(0, 4);
    var sig = JSON.stringify([!!site, site && site.signedIn, me && me.events, local.map(function (e) { return e.id || e.slug || e.name; })]);
    if (!setSig(el, sig)) return;
    var ev = (me && me.events) || { organizing: [], playing: [], matches: [] };
    var parts = [];
    if (ev.matches && ev.matches.length) {
      parts.push('<div class="mx-home-sub">Your next matches</div>' + ev.matches.slice(0, 3).map(function (m) {
        return link(m.url, 'mx-home-row is-match', '<span class="mx-home-when">' + esc(relDay(m.startAt)) + '</span><span class="mx-home-row-text"><b>' + esc(m.title) + '</b></span>');
      }).join(''));
    }
    if (ev.organizing && ev.organizing.length) {
      parts.push('<div class="mx-home-sub">Running</div>' + ev.organizing.slice(0, 4).map(function (c) {
        var meta = [roleName(c.role), statusName(c.season && c.season.status ? c.season.status : c.status), c.season && c.season.startsAt ? day(c.season.startsAt) : ''].filter(Boolean).join(' · ');
        // Load puts it on air here (Event page, site-events.js); the name opens it on the website.
        var href = c.consoleUrl || c.url;
        return '<div class="mx-home-row">' + mark(c.logo, c.name)
          + '<span class="mx-home-row-text"><b>' + (href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(c.name) + '</a>' : esc(c.name)) + '</b><span>' + esc(meta) + '</span></span>'
          + '<button type="button" class="mx-home-cta-chip" data-home="load-event" data-id="' + esc(c.id) + '" title="Load this event: teams, matches and standings">Load</button></div>';
      }).join(''));
    }
    if (ev.playing && ev.playing.length) {
      parts.push('<div class="mx-home-sub">Playing in</div>' + ev.playing.slice(0, 4).map(function (p) {
        var meta = [p.team, statusName(p.season && p.season.status), p.checkedIn ? 'Checked in' : ''].filter(Boolean).join(' · ');
        return link(p.url, 'mx-home-row', mark(p.competition.logo, p.competition.name) + '<span class="mx-home-row-text"><b>' + esc(p.competition.name) + '</b><span>' + esc(meta) + '</span></span>');
      }).join(''));
    }
    if (local.length) {
      parts.push('<div class="mx-home-sub">Saved from start.gg</div>' + local.map(function (e) {
        var meta = [day(e.startAt || e.startsAt || e.startDate), e.game || e.videogame || ''].filter(Boolean).join(' · ') || 'From your start.gg account';
        return '<button type="button" class="mx-home-row" data-home="events-page">' + mark('', e.name || e.tournamentName) + '<span class="mx-home-row-text"><b>' + esc(e.name || e.tournamentName || 'Your event') + '</b><span>' + esc(meta) + '</span></span></button>';
      }).join(''));
    }
    if (parts.length) { el.innerHTML = '<div class="mx-home-list">' + parts.join('') + '</div>'; return; }
    if (!site) { el.innerHTML = '<p class="mx-hint">Loading...</p>'; return; }
    if (!site.signedIn) { el.innerHTML = signInPrompt('events'); return; }
    el.innerHTML = '<div class="mx-empty-state"><b>No events right now</b><span>Leagues and tournaments you run, cast or play in on namelessesports.com show up here, with your next matches.</span></div>';
  }

  function renderEvents() {
    var el = body('mx-home-events');
    var h = siteHome();
    var evs = (h && h.events) || [];
    var pr = (promos || []).slice().sort(function (a, b) { return (a.kind === 'nameless' ? 0 : 1) - (b.kind === 'nameless' ? 0 : 1); }).slice(0, 2);
    if (!setSig(el, JSON.stringify([evs, pr.map(function (p) { return p.id; })]))) return;
    var html = pr.map(function (p) {
      return link(p.url, 'mx-home-row' + (p.kind === 'sponsor' ? ' is-sponsor' : ''), mark(p.logoUrl, p.label || 'Nameless') + '<span class="mx-home-row-text"><b>' + esc(p.label || (p.kind === 'sponsor' ? 'Sponsored' : 'Nameless Esports')) + '</b><span>' + esc(p.text) + '</span></span><span class="mx-home-cta-chip">' + esc(p.cta || 'Open') + '</span>');
    }).join('');
    html += evs.slice(0, 6).map(function (e) {
      var meta = [e.live ? 'Live now' : relDay(e.startAt), e.entrants ? e.entrants + ' registered' : '', e.games.join(', '), e.online ? 'Online' : e.city].filter(Boolean).join(' · ');
      return link(e.url, 'mx-home-event' + (e.live ? ' is-live' : ''), (e.image ? '<img class="mx-home-event-art" src="' + esc(e.image) + '" alt="" loading="lazy">' : '<span class="mx-home-event-art is-blank"></span>')
        + '<span class="mx-home-row-text"><b>' + esc(e.name) + '</b><span>' + esc(meta) + '</span></span>');
    }).join('');
    el.innerHTML = html ? '<div class="mx-home-list">' + html + '</div>'
      : '<div class="mx-empty-state"><b>Nothing announced right now</b><span>New Nameless events show up here as soon as they are published.</span></div>';
  }

  function renderNews() {
    var el = body('mx-home-news');
    var h = siteHome(), news = (h && h.news) || [];
    if (!setSig(el, JSON.stringify(news.map(function (n) { return n.id; })))) return;
    el.innerHTML = news.length ? '<div class="mx-home-list">' + news.slice(0, 5).map(function (n) {
      return link(n.url, 'mx-home-news-item', (n.image ? '<img class="mx-home-news-art" src="' + esc(n.image) + '" alt="" loading="lazy">' : '')
        + '<span class="mx-home-row-text"><b>' + esc(n.title) + '</b><span>' + esc([n.source, n.publishedAt ? ago(n.publishedAt) : ''].filter(Boolean).join(' · ')) + '</span></span>');
    }).join('') + '</div>' : '<p class="mx-hint">The latest esports news from namelessesports.com shows here.</p>';
  }

  function renderSide() {
    var h = siteHome();
    var st = h && h.stats;
    var sEl = body('mx-home-stats');
    sEl.closest('.mx-card').hidden = !st;
    if (st && setSig(sEl, JSON.stringify(st))) {
      sEl.innerHTML = '<div class="mx-home-stats-grid">'
        + [[st.events, 'events run'], [st.players, 'registrations'], [st.biggest, 'biggest bracket'], [st.prizeUsd ? money(st.prizeUsd) : 0, 'prize money']]
          .filter(function (x) { return x[0]; })
          .map(function (x) { return '<div><b>' + esc(typeof x[0] === 'number' ? x[0].toLocaleString() : x[0]) + '</b><span>' + esc(x[1]) + '</span></div>'; }).join('')
        + '</div>';
    }
    var lEl = body('mx-home-links'), links = copy('links');
    if (setSig(lEl, JSON.stringify(links))) {
      lEl.innerHTML = '<div class="mx-home-linklist">' + links.map(function (l) { return '<a class="mx-home-link" href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.label) + '</a>'; }).join('') + '</div>';
    }
    var pEl = body('mx-home-partners'), partners = (h && h.partners) || [];
    pEl.closest('.mx-card').hidden = !partners.length;
    if (partners.length && setSig(pEl, JSON.stringify(partners))) {
      pEl.innerHTML = '<div class="mx-home-partners-grid">' + partners.map(function (p) {
        return '<a class="mx-home-partner" href="' + esc(p.url) + '" target="_blank" rel="noopener sponsored" title="' + esc(p.label || p.name) + '">'
          + (p.logo ? '<img src="' + esc(p.logo) + '" alt="' + esc(p.name) + '" loading="lazy">' : '<b>' + esc(p.name) + '</b>') + '</a>';
      }).join('') + '</div>';
    }
  }

  function renderServices() {
    var el = body('mx-home-services'), svc = copy('services');
    if (!setSig(el, JSON.stringify(svc))) return;
    el.innerHTML = '<div class="mx-home-svc">' + svc.map(function (s) {
      return link(s.url, 'mx-home-svc-item', '<b>' + esc(s.title) + '</b><span>' + esc(s.body) + '</span>');
    }).join('') + '</div>';
  }

  function renderTonight(s) {
    var card = home.querySelector('.mx-home-tonight');
    var teams = s.teams || {}, obs = s.obs || {};
    var games = s.games || {}, g = games[s.activeGame] || {};
    var a = (teams.blue && teams.blue.name) || '', b = (teams.orange && teams.orange.name) || '';
    var sig = JSON.stringify([s.eventName, g.name, a, b, obs.streaming, s.roundLabel]);
    if (card._sig === sig) return;
    card._sig = sig;
    card.querySelector('.mx-home-tonight-state').textContent = obs.streaming ? 'Live now' : '';
    card.querySelector('.mx-home-tonight-state').classList.toggle('is-live', !!obs.streaming);
    var bodyEl = card.querySelector('.mx-home-tonight-body');
    if (!s.eventName && !a && !b) {
      bodyEl.innerHTML = '<p class="mx-hint">No show set up yet. The Dashboard walks you through it in a few steps.</p>';
      return;
    }
    bodyEl.innerHTML = '<div class="mx-home-ev"></div><div class="mx-home-game"></div><div class="mx-home-match"><b></b><i>vs</i><b></b></div><div class="mx-home-round"></div>';
    bodyEl.querySelector('.mx-home-ev').textContent = s.eventName || 'Untitled show';
    bodyEl.querySelector('.mx-home-game').textContent = g.name || '';
    var names = bodyEl.querySelectorAll('.mx-home-match b');
    names[0].textContent = a || 'TBD'; names[1].textContent = b || 'TBD';
    bodyEl.querySelector('.mx-home-round').textContent = s.roundLabel || '';
  }

  function renderAll() {
    if (!home) return;
    renderHero(); renderLive(); renderCommunities(); renderMyEvents(); renderEvents(); renderNews(); renderSide(); renderServices();
  }

  window.__mxHome = {
    render: function (s) {
      if (!isModern()) return;
      build(); if (!home) return;
      loadSite(false); loadPromos();   // ui-style.js only calls render while Home is the open view
      renderAll();
      renderTonight(s || {});
    }
  };
})();
