// Home page content from namelessesports.com, kept up to date without an app update.
//   home: GET /api/broadcast/home (public): headline copy, services, links, upcoming events, live
//         matches, news, track record, partners. Refreshed every 10 minutes.
//   me:   GET /api/broadcast/me (signed in): the producer's own communities, organisations, events
//         and upcoming matches. Refreshed every 5 minutes while signed in; cleared on sign-out.
//
// Same rules as promos.js: fetched, validated and cached here, served to the control panel only by
// the local GET /api/site-home, never put in state, so none of it can reach an overlay or OBS.
// A failed fetch keeps the last good copy; the panel falls back to built-in copy when there is none.

const fs = require('fs');
const path = require('path');

const HOME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;   // older than this, show the built-in copy instead
const ME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const isHttps = (u) => typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u);
const url = (u) => (isHttps(u) ? u : '');
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function cleanHome(h) {
  h = obj(h);
  const hero = obj(h.hero);
  const out = {
    hero: {
      eyebrow: str(hero.eyebrow, 40),
      title: str(hero.title, 90),
      body: str(hero.body, 300),
      ctas: arr(hero.ctas, 3).map((c) => ({ label: str(c && c.label, 30), url: url(c && c.url), primary: !!(c && c.primary) })).filter((c) => c.label && c.url),
    },
    services: arr(h.services, 6).map((s) => ({ title: str(s && s.title, 50), body: str(s && s.body, 200), url: url(s && s.url) })).filter((s) => s.title),
    links: arr(h.links, 10).map((l) => ({ label: str(l && l.label, 30), url: url(l && l.url) })).filter((l) => l.label && l.url),
    events: arr(h.events, 8).map((e) => ({
      id: str(e && e.id, 40), name: str(e && e.name, 120), startAt: num(e && e.startAt), entrants: num(e && e.entrants) || 0,
      games: arr(e && e.games, 4).map((g) => str(g, 40)).filter(Boolean), image: url(e && e.image), url: url(e && e.url),
      online: !!(e && e.online), city: str(e && e.city, 60), live: !!(e && e.live),
    })).filter((e) => e.name && e.url),
    live: {
      matches: arr(obj(h.live).matches, 6).map((m) => ({
        id: str(m && m.id, 60), context: str(m && m.context, 80), round: str(m && m.round, 60), a: str(m && m.a, 60), b: str(m && m.b, 60),
        scoreA: num(m && m.scoreA), scoreB: num(m && m.scoreB), ours: !!(m && m.ours), url: url(m && m.url), streamUrl: url(m && m.streamUrl), game: str(m && m.game, 40),
      })).filter((m) => m.a && m.b),
      events: arr(obj(h.live).events, 4).map((e) => ({ id: str(e && e.id, 40), title: str(e && e.title, 120), entrants: num(e && e.entrants) || 0, prize: str(e && e.prize, 30), url: url(e && e.url) })).filter((e) => e.title),
    },
    news: arr(h.news, 6).map((n) => ({
      id: str(n && n.id, 60), title: str(n && n.title, 160), excerpt: str(n && n.excerpt, 200), source: str(n && n.source, 40),
      image: url(n && n.image), url: url(n && n.url), publishedAt: num(n && n.publishedAt),
    })).filter((n) => n.title && n.url),
    stats: h.stats ? { events: num(h.stats.events) || 0, players: num(h.stats.players) || 0, biggest: num(h.stats.biggest) || 0, prizeUsd: num(h.stats.prizeUsd) || 0 } : null,
    partners: arr(h.partners, 12).map((p) => ({ name: str(p && p.name, 40), label: str(p && p.label, 60), logo: url(p && p.logo), url: url(p && p.url) })).filter((p) => p.name && p.url),
  };
  if (!out.hero.title) out.hero = null;
  return out;
}

function cleanMe(m) {
  m = obj(m);
  const ev = obj(m.events);
  const season = (s) => (s && typeof s === 'object' ? { name: str(s.name, 60), status: str(s.status, 20), startsAt: num(s.startsAt), endsAt: num(s.endsAt) } : null);
  return {
    user: m.user ? { id: str(m.user.id, 60), name: str(m.user.name, 60), image: url(m.user.image) } : null,
    communities: arr(m.communities, 40).map((c) => ({
      id: str(c && c.id, 60), name: str(c && c.name, 80), type: str(c && c.type, 20), logo: url(c && c.logo), color: /^#[0-9a-f]{3,8}$/i.test(String(c && c.color)) ? c.color : '',
      verified: !!(c && c.verified), role: str(c && c.role, 20), members: num(c && c.members) || 0, competitions: num(c && c.competitions) || 0,
      announcement: c && c.announcement && c.announcement.text ? { text: str(c.announcement.text, 280), at: num(c.announcement.at) } : null,
      url: url(c && c.url),
    })).filter((c) => c.name),
    orgs: arr(m.orgs, 20).map((o) => ({ id: str(o && o.id, 60), name: str(o && o.name, 80), logo: url(o && o.logo), seatRole: str(o && o.seatRole, 20) })).filter((o) => o.name),
    events: {
      organizing: arr(ev.organizing, 20).map((c) => ({
        id: str(c && c.id, 60), name: str(c && c.name, 120), kind: str(c && c.kind, 20), status: str(c && c.status, 20), logo: url(c && c.logo),
        role: str(c && c.role, 20), season: season(c && c.season), url: url(c && c.url), consoleUrl: url(c && c.consoleUrl),
      })).filter((c) => c.name),
      playing: arr(ev.playing, 20).map((p) => ({
        id: str(p && p.id, 60), team: str(p && p.team, 80), status: str(p && p.status, 20), checkedIn: !!(p && p.checkedIn),
        competition: { name: str(p && p.competition && p.competition.name, 120), kind: str(p && p.competition && p.competition.kind, 20), logo: url(p && p.competition && p.competition.logo) },
        season: season(p && p.season), url: url(p && p.url),
      })).filter((p) => p.competition.name),
      matches: arr(ev.matches, 10).map((x) => ({ id: str(x && x.id, 80), title: str(x && x.title, 160), startAt: num(x && x.startAt), url: url(x && x.url) })).filter((x) => x.title && x.startAt),
    },
  };
}

// getDataDir is a function: server.js creates this at module load, before userData is resolved.
function create({ getDataDir, fetchHome, fetchMe, isSignedIn, userId }) {
  let cache = null;
  const fileOf = () => path.join(getDataDir(), 'site-home.json');
  const ensure = () => {
    if (cache) return cache;
    cache = { home: null, homeAt: 0, me: null, meAt: 0, meUser: '', meError: '' };
    try {
      const c = JSON.parse(fs.readFileSync(fileOf(), 'utf8'));
      if (c && typeof c === 'object') cache = { ...cache, home: c.home ? cleanHome(c.home) : null, homeAt: Number(c.homeAt) || 0, me: c.me ? cleanMe(c.me) : null, meAt: Number(c.meAt) || 0, meUser: String(c.meUser || '') };
    } catch (_) { /* first run */ }
    return cache;
  };
  const persist = () => {
    const c = ensure();
    fs.promises.mkdir(getDataDir(), { recursive: true })
      .then(() => fs.promises.writeFile(fileOf(), JSON.stringify({ home: c.home, homeAt: c.homeAt, me: c.me, meAt: c.meAt, meUser: c.meUser })))
      .catch(() => {});
  };

  async function refreshHome() {
    const data = await fetchHome();
    const c = ensure();
    c.home = cleanHome(data && data.home);
    c.homeAt = Date.now();
    persist();
    return true;
  }

  async function refreshMe() {
    const c = ensure();
    if (!isSignedIn()) { if (c.me) clearMe(); return false; }
    try {
      const data = await fetchMe();
      c.me = cleanMe(data && data.me);
      c.meAt = Date.now();
      c.meUser = String(userId() || '');
      c.meError = '';
      persist();
      return true;
    } catch (e) {
      // A website without the route yet (404) or a refused token is not an outage: say so, keep going.
      c.meError = e && (e.status === 404) ? 'not-available' : (e && e.status === 401 ? 'signed-out' : 'unreachable');
      if (e && (e.status === 404 || e.status === 401)) return false;
      throw e;
    }
  }

  function clearMe() {
    const c = ensure();
    c.me = null; c.meAt = 0; c.meUser = ''; c.meError = '';
    persist();
  }

  // What the control panel may show right now.
  function snapshot() {
    const c = ensure();
    const now = Date.now();
    const signedIn = !!isSignedIn();
    const meFresh = signedIn && c.me && now - c.meAt < ME_MAX_AGE_MS && (!c.meUser || c.meUser === String(userId() || ''));
    return {
      home: c.home && now - c.homeAt < HOME_MAX_AGE_MS ? c.home : null,
      homeAt: c.homeAt,
      me: meFresh ? c.me : null,
      meAt: meFresh ? c.meAt : 0,
      meError: c.meError,
      signedIn,
    };
  }

  return { refreshHome, refreshMe, clearMe, snapshot };
}

module.exports = { create, cleanHome, cleanMe };
