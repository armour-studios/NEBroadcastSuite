/* ─── analytics-ui.js — the Analytics page's Overview and Sponsors renderers (2026-10 rebuild) ───
   Loads after stats-analytics.js and REPLACES two of its renderers by redeclaring them:
     renderAnalyticsDashboard()  — the Overview: plain tiles + viewers per broadcast + top sponsors
     renderAdProof(report)       — the Sponsors tab: proof of play with the sponsor marks (logos)
   Everything else on the page (tabs, filter bar, broadcasts, audience, reports, match stats) still
   lives in stats-analytics.js, and so do the helpers used here (anNum, anDur, anMmss, anColumns,
   escapeHtml, adProofMmss, adProofUsd, adProofExport, ADPROOF_API, ANALYTICS_API, appConfirm).

   Why a separate file: the old Overview was a "Production Score" composite with half its factors
   marked "Phase 1/4", and the Sponsors tab was a text table that never showed a sponsor's mark.
   Sponsor logos are resolved from the brand kits the panel already holds (by id, then by name), so a
   report never carries base64 and still shows the logo. */

(function () {
  const SUMMARY_DAYS = 30;
  const SPOT_NAMES = Object.assign({
    title: 'Title', rail: 'Rail', desk: 'Desk', overtime: 'Overtime', replayGoal: 'Replay', replayOutro: 'Replay end',
    scoreboard: 'Scoreboard', banner: 'Banner', ticker: 'Ticker'
  }, (typeof ADPROOF_SPOT_LABEL !== 'undefined' && ADPROOF_SPOT_LABEL) || {});

  // ── Sponsor marks ──────────────────────────────────────────────────────────────────────────
  function kitSponsors() {
    const out = [];
    const kits = (typeof currentState !== 'undefined' && currentState && currentState.brandKits) || [];
    kits.forEach((k) => {
      const pkgs = Array.isArray(k.packages) && k.packages.length ? k.packages : [{ sponsors: k.sponsors || [] }];
      pkgs.forEach((p) => (p.sponsors || []).forEach((s) => { if (s) out.push(s); }));
    });
    return out;
  }
  function usableLogo(v) {
    // Vault refs (@img:hash) are only resolvable by overlays; the panel's kits hold real srcs.
    return typeof v === 'string' && v && !v.startsWith('@img:') ? v : '';
  }
  function logoFor(sp) {
    if (!sp) return '';
    let src = usableLogo(sp.logo);
    if (src) return src;
    const all = kitSponsors();
    let hit = sp.id ? all.find((s) => s.id === sp.id) : null;
    if (!hit && sp.name) { const n = String(sp.name).trim().toLowerCase(); hit = all.find((s) => String(s.name || '').trim().toLowerCase() === n); }
    return hit ? usableLogo(hit.logo) : '';
  }
  // Reports keep the sponsor id; a sponsor saved without a name is looked up in the brand kits.
  function nameFor(sp) {
    if (sp && sp.name) return sp.name;
    const hit = sp && sp.id ? kitSponsors().find((s) => s.id === sp.id) : null;
    if (hit && hit.name) return hit.name;
    return logoFor(sp) ? 'Sponsor (no name)' : 'Sponsor no longer in a kit';
  }
  function hue(str) { let h = 0; const s = String(str || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }
  function initials(name) { return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0)).join('').toUpperCase() || '?'; }
  function markHTML(sp, size) {
    const cls = 'sp2-logo' + (size ? ' sp2-logo--' + size : '');
    const src = logoFor(sp);
    if (src) return `<span class="${cls}" title="${escapeHtml(sp.name || '')}"><img src="${escapeHtml(src)}" alt=""></span>`;
    return `<span class="${cls} is-initials" style="background:hsl(${hue(sp.name)} 45% 42%)" title="${escapeHtml(sp.name || '')}">${escapeHtml(initials(sp.name))}</span>`;
  }

  async function getJson(url) { try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch (e) { return null; } }
  function tile(v, l, s) { return `<div class="an2-tile"><div class="an2-tile-v">${v}</div><div class="an2-tile-l">${escapeHtml(l)}</div>${s ? `<div class="an2-tile-s">${escapeHtml(s)}</div>` : ''}</div>`; }
  function fmtWhen(ms) { return ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''; }

  // ── Overview ───────────────────────────────────────────────────────────────────────────────
  window.renderAnalyticsDashboard = async function renderAnalyticsDashboard() {
    const wrap = el('an-dashboard'); if (!wrap) return;
    const ev = (typeof _anEvent !== 'undefined' && _anEvent) ? '?event=' + encodeURIComponent(_anEvent) : '';
    const [ov, sum] = await Promise.all([getJson(ANALYTICS_API + '/overview' + ev), getJson(ADPROOF_API + '/summary?days=' + SUMMARY_DAYS)]);
    const t = (ov && ov.totals) || {};
    const recent = ((ov && ov.recent) || []).slice().reverse();   // oldest -> newest for the chart
    const sponsors = (sum && sum.sponsors) || [];
    const tiles = [
      tile(anNum(t.broadcasts || 0), 'Broadcasts', 'all time'),
      tile(anDur(t.airSeconds || 0), 'Air time'),
      tile(anNum(t.peakViewers || 0), 'Peak viewers', 'best broadcast'),
      tile(anNum(t.avgPeakViewers || 0), 'Average peak', 'per broadcast'),
      tile(anMmss((sum && sum.seconds) || 0), 'Sponsor time on screen', 'last ' + SUMMARY_DAYS + ' days'),
      tile(anNum((sum && sum.viewerSeconds) || 0), 'Est. sponsor impressions', 'viewer-seconds, last ' + SUMMARY_DAYS + ' days')
    ].join('');
    const cols = anColumns(recent.slice(-10).map((s) => ({ label: (s.label || 'Broadcast') + ' · ' + fmtWhen(s.endedAt || s.startedAt), value: s.peakViewers || 0, sub: anNum(s.peakViewers || 0) + ' peak' })), '#22c3e6');
    const maxSec = Math.max(1, ...sponsors.map((s) => s.seconds || 0));
    const top = sponsors.slice(0, 6).map((s) => `<div class="an2-sprow">${markHTML(s)}<span class="an2-sprow-name">${escapeHtml(nameFor(s))}</span><span class="an2-sprow-v">${adProofMmss(s.seconds || 0)} · ${anNum(s.viewerSeconds || 0)} est.</span><span class="an2-sprow-bar"><span class="an2-sprow-fill" style="width:${Math.round(100 * (s.seconds || 0) / maxSec)}%"></span></span></div>`).join('');
    wrap.innerHTML = `<div class="an2-tiles">${tiles}</div>
      <div class="an2-2col">
        <div class="an2-card"><div class="an2-card-head"><span class="an2-card-title">Peak viewers per broadcast</span><span class="an2-card-sub">last ${Math.min(10, recent.length)} shows</span></div>${recent.length ? cols : '<div class="an2-empty">No broadcasts recorded yet. A session starts when you go live on Twitch, or from the Broadcasts tab.</div>'}</div>
        <div class="an2-card"><div class="an2-card-head"><span class="an2-card-title">Top sponsors</span><span class="an2-card-sub">on-screen time, last ${SUMMARY_DAYS} days</span></div>${sponsors.length ? `<div class="an2-splist">${top}</div>` : '<div class="an2-empty">No sponsor exposure yet. Put a brand kit with sponsors live and the tracker fills this in during your next broadcast.</div>'}</div>
      </div>`;
  };

  // ── Sponsors tab ───────────────────────────────────────────────────────────────────────────
  let _summaryT = 0;
  async function renderSummary() {
    const host = el('app-summary'); if (!host) return;
    const sum = await getJson(ADPROOF_API + '/summary?days=' + SUMMARY_DAYS);
    const sponsors = (sum && sum.sponsors) || [];
    if (!sponsors.length) {
      host.innerHTML = '<div class="an2-empty">Nothing tracked in the last ' + SUMMARY_DAYS + ' days. Activate a brand kit with sponsors; tracking runs on its own while a broadcast session is recording.</div>';
      return;
    }
    const tiles = [
      tile(anMmss(sum.seconds || 0), 'On screen'),
      tile(anNum(sum.viewerSeconds || 0), 'Est. impressions', 'viewer-seconds'),
      tile(anNum(sponsors.length), 'Sponsors seen'),
      tile(anNum(sum.broadcasts || 0), 'Broadcasts')
    ].join('');
    host.innerHTML = `<div class="an2-tiles">${tiles}</div><div class="sp2-grid">${sponsors.map((s) => cardHTML(s, true)).join('')}</div>`;
  }

  function placesHTML(byPlacement) {
    const keys = Object.keys(byPlacement || {}).filter((k) => byPlacement[k] > 0).sort((a, b) => byPlacement[b] - byPlacement[a]);
    if (!keys.length) return '';
    const max = Math.max(1, ...keys.map((k) => byPlacement[k]));
    return `<div class="sp2-places">${keys.map((k) => `<div class="sp2-place"><span>${escapeHtml(SPOT_NAMES[k] || k)}</span><span class="sp2-place-track"><span class="sp2-place-fill" style="width:${Math.round(100 * byPlacement[k] / max)}%"></span></span><span class="sp2-place-v">${adProofMmss(byPlacement[k])}</span></div>`).join('')}</div>`;
  }
  function cardHTML(s, rollup) {
    const money = (s.dealValue != null && s.dealValue !== 0) || (s.valueDelivered != null && s.valueDelivered !== 0);
    const pct = (s.dealValue && s.valueDelivered != null) ? Math.round(100 * s.valueDelivered / s.dealValue) : (s.deliveryPct != null ? s.deliveryPct : null);
    return `<div class="sp2-card">
      <div class="sp2-card-top">${markHTML(s, 'lg')}<div style="min-width:0;flex:1;"><div class="sp2-card-name">${escapeHtml(nameFor(s))}</div><div class="sp2-card-sub">${rollup ? anNum(s.sessions || 0) + ' broadcast' + (s.sessions === 1 ? '' : 's') : (s.impressions || 0) + ' appearance' + (s.impressions === 1 ? '' : 's')}</div></div></div>
      <div class="sp2-card-big">${adProofMmss(s.seconds || 0)}<small>on screen</small></div>
      <div class="sp2-stats">
        <div class="sp2-stat"><b>${anNum(s.viewerSeconds || 0)}</b><span>est. impressions</span></div>
        <div class="sp2-stat"><b>${anNum(s.avgViewers || 0)}</b><span>avg viewers</span></div>
        <div class="sp2-stat"><b>${anNum(s.peakViewers || 0)}</b><span>peak</span></div>
      </div>
      ${placesHTML(s.byPlacement)}
      ${money ? `<div class="sp2-money">Paid <b>${adProofUsd(s.dealValue)}</b> · delivered <b>${adProofUsd(s.valueDelivered)}</b>${pct != null ? ` <span class="${pct >= 100 ? 'ok' : 'warn'}">(${pct}%)</span>` : ''}</div>` : ''}
    </div>`;
  }

  window.renderAdProof = function renderAdProof(rep) {
    rep = rep || { active: false, sponsors: [], sessions: [], durationSec: 0 };
    const startBtn = el('app-start'), stopBtn = el('app-stop'), live = el('app-live'), liveTx = el('app-live-tx');
    if (startBtn) startBtn.style.display = rep.active ? 'none' : '';
    if (stopBtn) stopBtn.style.display = rep.active ? '' : 'none';
    if (live) live.style.display = 'none';   // the status chip below says it
    if (liveTx && rep.active) liveTx.textContent = 'Recording';
    const st = el('sp2-status');
    if (st) {
      st.classList.toggle('is-live', !!rep.active);
      st.innerHTML = rep.active
        ? `<span class="sp2-dot"></span><span>Recording <b>${adProofMmss(rep.durationSec || 0)}</b>${rep.label ? ' · ' + escapeHtml(rep.label) : ''}</span>`
        : `<span class="sp2-dot"></span><span>Not recording</span>`;
    }
    // Live / last session
    const cur = el('app-current');
    if (cur) {
      const sponsors = rep.sponsors || [];
      const hasAny = rep.active || sponsors.length;
      if (!hasAny) {
        cur.innerHTML = '';
      } else {
        const moneySummary = (rep.totalDealValue != null || rep.totalValueDelivered != null)
          ? ` · ${adProofUsd(rep.totalDealValue)} sold, ${adProofUsd(rep.totalValueDelivered)} delivered` : '';
        cur.innerHTML = `<div class="sp2-toolbar"><span class="sp2-toolbar-l"><b>${rep.active ? 'This broadcast' : 'Last session (saved to history)'}</b> · ${adProofMmss(rep.durationSec || 0)}${rep.label ? ' · ' + escapeHtml(rep.label) : ''}${moneySummary}</span>
            <span style="display:flex;gap:6px;"><button class="btn btn-secondary btn-sm" id="app-exp-csv">Export CSV</button><button class="btn btn-secondary btn-sm" id="app-exp-json">Export JSON</button></span></div>`
          + (sponsors.length ? `<div class="sp2-grid">${sponsors.map((s) => cardHTML(s, false)).join('')}</div>`
                             : `<div class="an2-empty">No sponsor on screen yet${rep.active ? '. Make sure the live brand kit has sponsors with placements ticked.' : '.'}</div>`)
          + `<p class="sp2-note">Exposure is inferred from what the overlays are showing. On-screen time counts each second once even when a mark is in several places; appearances are the number of times it came on; estimated impressions are viewer-seconds (live viewers × seconds on screen).</p>`;
        el('app-exp-csv')?.addEventListener('click', () => adProofExport('current', 'csv'));
        el('app-exp-json')?.addEventListener('click', () => adProofExport('current', 'json'));
      }
    }
    // Saved reports
    const sess = el('app-sessions');
    if (sess) {
      const list = rep.sessions || [];
      if (!list.length) sess.innerHTML = '<div class="an2-empty">No saved reports yet. Each broadcast session saves one when it ends.</div>';
      else {
        sess.innerHTML = `<div class="sp2-toolbar"><span class="sp2-toolbar-l"><b>${list.length}</b> saved report${list.length === 1 ? '' : 's'}</span><button class="btn btn-danger btn-sm" id="app-clear-all">Delete all</button></div>` + list.map((s) => {
          const when = s.endedAt ? new Date(s.endedAt).toLocaleString() : '';
          const logos = (s.sponsors || []).map((x) => markHTML(x, 'sm')).join('');
          return `<div class="sp2-sess">
            <div style="min-width:0;"><div class="sp2-sess-lbl">${escapeHtml(s.label || 'Broadcast')}</div>
              <div class="sp2-sess-meta">${adProofMmss(s.durationSec || 0)} · ${s.sponsorCount || 0} sponsor${s.sponsorCount === 1 ? '' : 's'}${s.totalValueDelivered != null ? ` · ${adProofUsd(s.totalValueDelivered)} delivered` : ''} · ${escapeHtml(when)}</div>
              ${logos ? `<div class="sp2-sess-logos">${logos}</div>` : ''}</div>
            <div class="sp2-sess-act">
              <button class="btn btn-secondary btn-sm" data-app-csv="${escapeHtml(s.id)}">CSV</button>
              <button class="btn btn-secondary btn-sm" data-app-json="${escapeHtml(s.id)}">JSON</button>
              <button class="btn btn-danger btn-sm" data-app-del="${escapeHtml(s.id)}">Delete</button>
            </div></div>`;
        }).join('');
        sess.querySelectorAll('[data-app-csv]').forEach((b) => b.addEventListener('click', () => adProofExport(b.dataset.appCsv, 'csv')));
        sess.querySelectorAll('[data-app-json]').forEach((b) => b.addEventListener('click', () => adProofExport(b.dataset.appJson, 'json')));
        sess.querySelectorAll('[data-app-del]').forEach((b) => b.addEventListener('click', async () => {
          if (!(await appConfirm('Delete this saved report?', 'Delete'))) return;
          try { const r = await (await fetch(ADPROOF_API + '/session/' + b.dataset.appDel, { method: 'DELETE' })).json(); _adProofReport = r.report; renderAdProof(r.report); } catch (e) {}
        }));
        el('app-clear-all')?.addEventListener('click', async () => {
          if (!(await appConfirm('Delete every saved sponsor report? This cannot be undone.', 'Delete'))) return;
          try { const r = await (await fetch(ADPROOF_API + '/sessions', { method: 'DELETE' })).json(); _adProofReport = r.report; renderAdProof(r.report); } catch (e) {}
        });
      }
    }
    // The roll-up is a separate fetch; throttle it so the 2s live pushes do not hammer it.
    const nowT = Date.now();
    if (nowT - _summaryT > 15000) { _summaryT = nowT; renderSummary(); }
  };
})();
