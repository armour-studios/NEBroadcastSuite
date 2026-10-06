/* ─── promos.js — the slim promo strip (Nameless events + paid sponsor placements) ───────────────
   Loads after gameconfig.js. The campaign list comes from the local GET /api/promos (cached from the
   Nameless website — see backend/promos.js); this file only decides WHETHER and WHAT to show.

   The rules that keep it from being overwhelming (do not loosen them without asking):
   - calm pages only (Dashboard / Events / Marketplace) — never Production, Replays, Camera Feeds…
   - never while live: OBS streaming or recording, any graphic on air, or in a popout window
   - ONE campaign per session, dismissible; a dismissed campaign stays hidden for 14 days
   - "Show promotions" in Settings turns it off entirely
   - sponsored campaigns always carry a "Sponsored" tag naming the sponsor
   Nothing here touches overlays or OBS: the strip is control-panel chrome only. */

(function () {
  const BASE = 'http://localhost:3000';
  const DEFAULT_PAGES = ['principal', 'events', 'integrations'];
  const DISMISS_KEY = 'ne_promo_dismissed';
  const OFF_KEY = 'ne_promos_off';
  const SESSION_KEY = 'ne_promo_session';
  const DISMISS_MS = 14 * 24 * 60 * 60 * 1000;

  let feed = [];
  let fetchedAt = 0;
  let strip = null;
  let shownId = '';

  const store = {
    get(k, fb) { try { const v = localStorage.getItem(k); return v == null ? fb : v; } catch (_) { return fb; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
    sget(k) { try { return sessionStorage.getItem(k) || ''; } catch (_) { return ''; } },
    sset(k, v) { try { sessionStorage.setItem(k, v); } catch (_) {} }
  };
  const dismissed = () => { try { return JSON.parse(store.get(DISMISS_KEY, '{}')) || {}; } catch (_) { return {}; } };
  const enabled = () => store.get(OFF_KEY, '') !== '1';

  const currentPage = () => {
    const a = document.querySelector('.tab-content.active');
    return a ? a.id.replace(/^tab-/, '').replace(/-content$/, '') : '';
  };

  // Live = anything a viewer could be seeing right now. Err on the side of hiding.
  function isLive() {
    const s = (typeof currentState !== 'undefined' && currentState) || {};
    if (s.obs && (s.obs.streaming || s.obs.recording)) return true;
    if (s.gfxActive) return true;
    return false;
  }

  function eligible(p) {
    const gone = dismissed()[p.id];
    if (gone && Date.now() - gone < DISMISS_MS) return false;
    const s = (typeof currentState !== 'undefined' && currentState) || {};
    if (p.games && p.games.length && s.activeGame && !p.games.includes(s.activeGame)) return false;
    return true;
  }

  // One campaign per session: keep the pick while it stays eligible, else draw a new one by weight.
  function pick() {
    const pool = feed.filter(eligible);
    if (!pool.length) return null;
    const prev = store.sget(SESSION_KEY);
    const keep = prev && pool.find((p) => p.id === prev);
    if (keep) return keep;
    let r = Math.random() * pool.reduce((n, p) => n + (p.weight || 1), 0);
    let chosen = pool[pool.length - 1];
    for (const p of pool) { r -= (p.weight || 1); if (r <= 0) { chosen = p; break; } }
    store.sset(SESSION_KEY, chosen.id);
    return chosen;
  }

  function build() {
    if (strip) return strip;
    const anchor = document.getElementById('tab-scroll');
    if (!anchor || !anchor.parentNode) return null;
    strip = document.createElement('div');
    strip.id = 'promo-strip';
    strip.className = 'promo-strip';
    strip.hidden = true;
    strip.setAttribute('role', 'complementary');
    strip.innerHTML = '<span class="promo-tag" id="promo-tag"></span>'
      + '<img class="promo-logo" id="promo-logo" alt="" hidden>'
      + '<span class="promo-text" id="promo-text"></span>'
      + '<a class="promo-cta" id="promo-cta" target="_blank" rel="noopener"></a>'
      + '<button type="button" class="promo-x" id="promo-x" title="Hide this for two weeks" aria-label="Dismiss">&times;</button>';
    anchor.parentNode.insertBefore(strip, anchor);
    strip.querySelector('#promo-x').addEventListener('click', () => {
      if (shownId) { const d = dismissed(); d[shownId] = Date.now(); store.set(DISMISS_KEY, JSON.stringify(d)); }
      render();
    });
    return strip;
  }

  function hide() { if (strip) strip.hidden = true; shownId = ''; }

  function render() {
    const root = build(); if (!root) return;
    if (!enabled() || isLive() || document.body.classList.contains('popout-mode')) return hide();
    const page = currentPage();
    const p = pick();
    if (!p) return hide();
    const pages = (p.pages && p.pages.length) ? p.pages : DEFAULT_PAGES;
    if (!pages.includes(page)) return hide();

    root.dataset.kind = p.kind;
    root.querySelector('#promo-tag').textContent = p.kind === 'sponsor' ? 'Sponsored · ' + p.label : (p.label || 'Nameless');
    root.querySelector('#promo-text').textContent = p.text;
    const cta = root.querySelector('#promo-cta'); cta.textContent = p.cta; cta.href = p.url;
    const logo = root.querySelector('#promo-logo');
    if (p.logoUrl) { logo.src = p.logoUrl; logo.hidden = false; logo.onerror = () => { logo.hidden = true; }; } else logo.hidden = true;
    shownId = p.id;
    root.hidden = false;
  }

  async function load() {
    try {
      const r = await fetch(BASE + '/api/promos', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      feed = Array.isArray(d.promos) ? d.promos : [];
    } catch (_) { /* server not up yet / offline: no strip */ }
    render();
  }

  // ── Wiring ──
  document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => setTimeout(render, 0)));
  const toggle = document.getElementById('settings-show-promos');
  if (toggle) {
    toggle.checked = enabled();
    toggle.addEventListener('change', () => { store.set(OFF_KEY, toggle.checked ? '' : '1'); render(); });
  }

  // Called from applyState on every state update — cheap: re-evaluates live/page, refetches hourly.
  window._promoRefresh = function () {
    if (Date.now() - fetchedAt > 60 * 60 * 1000 && enabled()) { fetchedAt = Date.now(); load(); return; }
    render();
  };
})();
