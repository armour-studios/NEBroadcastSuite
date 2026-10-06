// In-app promo strip — Nameless events + paid sponsor placements shown to producers in the control
// panel. This module only FETCHES, VALIDATES and CACHES the campaign list (the website owns the
// content: GET /api/broadcast/promos). Showing rules — calm pages only, not while live, one per
// session, dismiss memory — live in control-panel/promos.js.
//
// Hard rules:
//  - Promos are served ONLY by the local GET /api/promos to the control panel. They are never put in
//    state / buildLiveState, so they cannot reach an overlay or an OBS source.
//  - A failed fetch is silent: no feed = no strip, never an error toast.
//  - White-label / Armour builds opt out with NE_PROMOS=0 (env) — no fetch, empty list.

const fs = require('fs');
const path = require('path');

const MAX_PROMOS = 12;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;   // a cached feed older than this is not shown (stale sponsor deals)

const isHttps = (u) => typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u);
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

function disabledByBuild() {
  return String(process.env.NE_PROMOS || '').trim() === '0';
}

// Server-side re-validation: the website is trusted, but the app should never render an unvalidated
// URL or oversized text just because a feed said so.
function sanitize(list) {
  const now = Date.now();
  return (Array.isArray(list) ? list : []).slice(0, MAX_PROMOS).map((p) => {
    if (!p || typeof p !== 'object') return null;
    const kind = p.kind === 'sponsor' ? 'sponsor' : (p.kind === 'nameless' ? 'nameless' : '');
    const out = {
      id: clip(p.id, 60), kind, label: clip(p.label, 40), text: clip(p.text, 140), cta: clip(p.cta, 24),
      url: isHttps(p.url) ? p.url : '',
      logoUrl: isHttps(p.logoUrl) ? p.logoUrl : '',
      pages: Array.isArray(p.pages) ? p.pages.map((x) => clip(x, 30)).filter(Boolean).slice(0, 20) : [],
      games: Array.isArray(p.games) ? p.games.map((x) => clip(x, 30)).filter(Boolean).slice(0, 30) : [],
      weight: Math.max(1, Math.min(10, Number(p.weight) || 1)),
      startsAt: p.startsAt ? Date.parse(p.startsAt) || 0 : 0,
      endsAt: p.endsAt ? Date.parse(p.endsAt) || 0 : 0
    };
    if (!out.id || !out.kind || !out.text || !out.cta || !out.url) return null;
    if (out.kind === 'sponsor' && !out.label) return null;       // a sponsor placement must name the sponsor
    if (out.startsAt && out.startsAt > now) return null;
    if (out.endsAt && out.endsAt <= now) return null;
    return out;
  }).filter(Boolean);
}

// getDataDir is a function: server.js creates this at module load, before userData is resolved.
function create({ getDataDir, fetchFeed }) {
  let cache = null;
  const fileOf = () => path.join(getDataDir(), 'promos.json');
  const ensure = () => {
    if (cache) return cache;
    cache = { promos: [], fetchedAt: 0 };
    try {
      const c = JSON.parse(fs.readFileSync(fileOf(), 'utf8'));
      if (c && Array.isArray(c.promos)) cache = { promos: c.promos, fetchedAt: Number(c.fetchedAt) || 0 };
    } catch (_) { /* first run */ }
    return cache;
  };

  async function refresh() {
    if (disabledByBuild()) return false;
    const data = await fetchFeed();
    const promos = sanitize(data && data.promos);
    cache = { promos, fetchedAt: Date.now() };
    fs.promises.mkdir(getDataDir(), { recursive: true })
      .then(() => fs.promises.writeFile(fileOf(), JSON.stringify(cache)))
      .catch(() => {});
    return true;
  }

  // What the control panel may show right now. Re-sanitised on every read so a campaign that expired
  // since the last fetch drops out without a network call.
  function list() {
    if (disabledByBuild()) return [];
    const c = ensure();
    if (!c.fetchedAt || Date.now() - c.fetchedAt > MAX_AGE_MS) return [];
    return sanitize(c.promos);
  }

  return { refresh, list, _sanitize: sanitize };
}

module.exports = { create, sanitize };
