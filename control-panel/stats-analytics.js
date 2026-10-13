/* ─── stats-analytics.js — Stats + Analytics domains ─────────────────────────
   Stats tab (matches/leaderboards/team records/head-to-head), Analytics dashboard
   (Overview/Broadcasts/Audience/Event), business figures, retention, start.gg
   historical import, reports/exports, sponsor proof-of-play, cross-game player
   profile. Extracted verbatim from app.js (2026-07). Loads after app.js; the only
   inbound calls are from the WS message handler (runtime — always resolved). */

// ── Stats Tab ─────────────────────────────────────────────────────────────────

let _statsOffset = 0;
const _statsPageSize = 20;

function fmtDuration(sec) {
  if (!sec) return '—';
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

async function loadStatsAggregate() {
  try {
    const r = await fetch('http://127.0.0.1:3000/api/stats/aggregate');
    const d = await r.json();
    if (!d.ok) return;
    const el2 = el('stats-aggregate');
    if (!el2) return;
    const chip = (label, val) =>
      `<div style="background:rgba(255,255,255,.06);border-radius:8px;padding:10px 16px;min-width:100px;">
        <div style="font-size:11px;color:var(--muted,#888);text-transform:uppercase;letter-spacing:.05em;">${label}</div>
        <div style="font-size:22px;font-weight:700;color:#e0e0e0;margin-top:2px;">${val}</div>
      </div>`;
    el2.innerHTML =
      chip('Matches', d.matchCount) +
      chip('Games', d.gameCount) +
      chip('Avg Game', fmtDuration(d.avgDurationSec)) +
      (d.topScorer ? chip('Top Scorer', `${d.topScorer.player_name} (${d.topScorer.total_goals}g)`) : '');
  } catch (_) {}
}

async function loadStatsMatches(reset) {
  if (reset) _statsOffset = 0;
  try {
    const r = await fetch(`http://127.0.0.1:3000/api/stats/matches?limit=${_statsPageSize + 1}`);
    const d = await r.json();
    if (!d.ok) return;
    const matches = d.matches.slice(0, _statsPageSize);
    const hasMore = d.matches.length > _statsPageSize;
    const listEl = el('stats-matches-list');
    if (!listEl) return;

    if (reset) listEl.innerHTML = '';
    if (!matches.length && reset) {
      listEl.innerHTML = '<p style="color:var(--muted,#888);font-size:13px;padding:12px 0;">No matches recorded yet. Data is captured automatically from live RL and CS2 games.</p>';
    }

    matches.forEach(m => {
      const div = document.createElement('div');
      div.style = 'background:rgba(255,255,255,.05);border-radius:8px;padding:12px 16px;margin-bottom:8px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:12px;';
      div.innerHTML = `
        <div style="min-width:0;">
          <div style="font-weight:600;color:#e0e0e0;font-size:13px;">${m.team_a || '—'} vs ${m.team_b || '—'}</div>
          <div style="font-size:11px;color:var(--muted,#888);margin-top:2px;">${m.game_type?.toUpperCase()} · Bo${m.best_of} · ${fmtDate(m.started_at)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;flex-shrink:0;">
          <div style="text-align:right;">
            <div style="font-size:18px;font-weight:700;color:#e0e0e0;">${m.score_a ?? '?'} – ${m.score_b ?? '?'}</div>
            <div style="font-size:11px;color:var(--muted,#888);">${m.game_count} game${m.game_count !== 1 ? 's' : ''}</div>
          </div>
          <button class="stats-del-match" data-mid="${m.id}" title="Delete this match">✕</button>
        </div>`;
      div.addEventListener('click', (e) => { if (e.target.closest('.stats-del-match')) return; openStatsDetail(m.id); });
      div.querySelector('.stats-del-match')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!(await appConfirm('Delete this match from the stats database? It affects team & player aggregates.', 'Delete'))) return;
        try { await fetch('http://127.0.0.1:3000/api/stats/match/' + m.id, { method: 'DELETE' }); } catch (_) {}
        _anDash = null; _anDashSig = '';
        loadStatsMatches(true); if (typeof loadStatsAggregate === 'function') loadStatsAggregate();
      });
      listEl.appendChild(div);
    });

    if (!window._statsClearWired) { window._statsClearWired = true; el('stats-clear-matches')?.addEventListener('click', async () => { if (!(await appConfirm('Clear the ENTIRE match history (all matches, games and player stats)? This cannot be undone.', 'Clear'))) return; try { await fetch('http://127.0.0.1:3000/api/stats/matches', { method: 'DELETE' }); } catch (_) {} _anDash = null; _anDashSig = ''; loadStatsMatches(true); if (typeof loadStatsAggregate === 'function') loadStatsAggregate(); }); }
    const moreBtn = el('stats-load-more');
    if (moreBtn) moreBtn.style.display = hasMore ? '' : 'none';
    _statsOffset += matches.length;
  } catch (_) {}
}

async function openStatsDetail(matchId) {
  const modal = el('stats-detail-modal');
  const body = el('stats-detail-body');
  const title = el('stats-detail-title');
  if (!modal || !body) return;
  body.innerHTML = '<p style="color:#888;padding:20px 0;">Loading…</p>';
  modal.style.display = 'block';
  try {
    const r = await fetch(`http://127.0.0.1:3000/api/stats/matches/${matchId}`);
    const d = await r.json();
    if (!d.ok || !d.match) { body.innerHTML = '<p style="color:#f56565;">Error loading match.</p>'; return; }
    const m = d.match;
    title.textContent = `${m.team_a || '—'} vs ${m.team_b || '—'} · ${fmtDate(m.started_at)}`;
    let html = `<div style="display:flex;gap:20px;margin-bottom:16px;flex-wrap:wrap;">
      <span style="color:#888;font-size:12px;">${m.game_type?.toUpperCase()} · Bo${m.best_of}</span>
      <span style="color:#888;font-size:12px;">Series: ${m.score_a} – ${m.score_b}</span>
      ${m.tournament ? `<span style="color:#888;font-size:12px;">${m.tournament}</span>` : ''}
    </div>`;
    (m.games || []).forEach(g => {
      const mapLabel = g.map ? ` · ${g.map}` : '';
      const otLabel  = g.overtime ? ' (OT)' : '';
      html += `<div style="background:rgba(255,255,255,.04);border-radius:8px;padding:14px;margin-bottom:12px;">
        <div style="font-weight:600;font-size:13px;color:#e0e0e0;margin-bottom:10px;">Game ${g.game_number}${mapLabel} — ${g.score_a ?? '?'}–${g.score_b ?? '?'}${otLabel} · ${fmtDuration(g.duration_sec)}</div>`;
      if (g.game_type === 'rl' && g.players?.length) {
        html += `<table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead><tr style="color:#888;text-align:left;">
            <th style="padding:4px 6px;">Player</th><th style="padding:4px 6px;">Team</th>
            <th style="padding:4px 6px;text-align:center;">G</th><th style="padding:4px 6px;text-align:center;">A</th>
            <th style="padding:4px 6px;text-align:center;">Sv</th><th style="padding:4px 6px;text-align:center;">Sh</th>
            <th style="padding:4px 6px;text-align:center;">Demo</th><th style="padding:4px 6px;text-align:center;">Score</th>
          </tr></thead><tbody>`;
        g.players.forEach(p => {
          const teamLabel = p.team === 'a' ? (m.team_a || 'Blue') : (m.team_b || 'Orange');
          html += `<tr style="border-top:1px solid rgba(255,255,255,.06);">
            <td style="padding:5px 6px;color:#e0e0e0;">${p.player_name}</td>
            <td style="padding:5px 6px;color:#888;">${teamLabel}</td>
            <td style="padding:5px 6px;text-align:center;">${p.goals}</td>
            <td style="padding:5px 6px;text-align:center;">${p.assists}</td>
            <td style="padding:5px 6px;text-align:center;">${p.saves}</td>
            <td style="padding:5px 6px;text-align:center;">${p.shots}</td>
            <td style="padding:5px 6px;text-align:center;">${p.demos}</td>
            <td style="padding:5px 6px;text-align:center;font-weight:600;">${p.score}</td>
          </tr>`;
        });
        html += '</tbody></table>';
      } else if (g.game_type === 'cs2' && g.players?.length) {
        html += `<table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead><tr style="color:#888;text-align:left;">
            <th style="padding:4px 6px;">Player</th><th style="padding:4px 6px;">Team</th>
            <th style="padding:4px 6px;text-align:center;">K</th><th style="padding:4px 6px;text-align:center;">D</th>
            <th style="padding:4px 6px;text-align:center;">A</th><th style="padding:4px 6px;text-align:center;">MVPs</th>
            <th style="padding:4px 6px;text-align:center;">Score</th>
          </tr></thead><tbody>`;
        g.players.forEach(p => {
          const teamLabel = p.team === 'a' ? (m.team_a || 'CT') : (m.team_b || 'T');
          html += `<tr style="border-top:1px solid rgba(255,255,255,.06);">
            <td style="padding:5px 6px;color:#e0e0e0;">${p.player_name}</td>
            <td style="padding:5px 6px;color:#888;">${teamLabel}</td>
            <td style="padding:5px 6px;text-align:center;color:#9ae6b4;">${p.kills}</td>
            <td style="padding:5px 6px;text-align:center;color:#f56565;">${p.deaths}</td>
            <td style="padding:5px 6px;text-align:center;">${p.assists}</td>
            <td style="padding:5px 6px;text-align:center;">${p.mvps}</td>
            <td style="padding:5px 6px;text-align:center;font-weight:600;">${p.score}</td>
          </tr>`;
        });
        html += '</tbody></table>';
      }
      html += '</div>';
    });
    body.innerHTML = html;
  } catch (e) { body.innerHTML = `<p style="color:#f56565;">Error: ${e.message}</p>`; }
}

function closeStatsDetail() {
  const m = el('stats-detail-modal');
  if (m) m.style.display = 'none';
}
// Esc or a click on the dimmed backdrop closes the match detail, like every other pop-up.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const m = document.getElementById('stats-detail-modal');
  if (m && m.style.display === 'block') { e.stopPropagation(); closeStatsDetail(); }
}, true);
document.addEventListener('mousedown', (e) => { if (e.target && e.target.id === 'stats-detail-modal') closeStatsDetail(); });

// Player search — runs on the button, on Enter, and as you type (debounced).
async function statsPlayerSearch() {
  const name = el('stats-player-search')?.value?.trim();
  const resultsEl = el('stats-player-results');
  if (!resultsEl) return;
  if (!name) { resultsEl.style.display = 'none'; resultsEl.innerHTML = ''; return; }
  resultsEl.style.display = '';
  resultsEl.innerHTML = '<p style="color:#888;font-size:13px;">Searching…</p>';
  try {
    const r = await fetch(`http://127.0.0.1:3000/api/stats/players?name=${encodeURIComponent(name)}`);
    const d = await r.json();
    if (!d.ok || !d.history?.length) { resultsEl.innerHTML = '<p style="color:#888;font-size:13px;">No results.</p>'; return; }
    let html = `<p style="font-size:12px;color:#888;margin-bottom:8px;">${d.history.length} game(s) found for <strong style="color:#e0e0e0;">${name}</strong></p>`;
    html += `<table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead><tr style="color:#888;"><th style="padding:4px 8px;text-align:left;">Date</th><th>vs</th><th>G</th><th>A</th><th>Sv</th><th>Score</th></tr></thead><tbody>`;
    d.history.forEach(row => {
      html += `<tr style="border-top:1px solid rgba(255,255,255,.06);">
        <td style="padding:5px 8px;color:#888;">${fmtDate(row.game_at)}</td>
        <td style="padding:5px 8px;color:#e0e0e0;">${row.team_a} vs ${row.team_b}</td>
        <td style="padding:5px 8px;text-align:center;">${row.goals}</td>
        <td style="padding:5px 8px;text-align:center;">${row.assists}</td>
        <td style="padding:5px 8px;text-align:center;">${row.saves}</td>
        <td style="padding:5px 8px;text-align:center;font-weight:600;">${row.score}</td>
      </tr>`;
    });
    html += '</tbody></table>';
    resultsEl.innerHTML = html;
  } catch (e) { resultsEl.innerHTML = `<p style="color:#f56565;">Error: ${e.message}</p>`; }
}
el('stats-player-search-btn')?.addEventListener('click', statsPlayerSearch);
el('stats-player-search')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); statsPlayerSearch(); } });
// 300ms, and two characters minimum: the backend scans the whole stats table per query, so a
// one-character search is both slow and useless.
NESearch.bindBox(el('stats-player-search'), (q) => { if (!q || q.length >= 2) statsPlayerSearch(); }, 300);

el('stats-load-more')?.addEventListener('click', () => loadStatsMatches(false));

// ── Stats deep analytics (leaderboards / team records / head-to-head) ───────
const STATS_API = 'http://127.0.0.1:3000/api/stats';
let _statsTab = (() => { try { return localStorage.getItem('stats_active_tab') || 'overview'; } catch (_) { return 'overview'; } })();
function statsShowTab(tab) {
  _statsTab = tab;
  document.querySelectorAll('#stats-subnav .ev-subnav-btn').forEach((b) => b.classList.toggle('active', b.dataset.stab === tab));
  ['overview', 'broadcasts', 'audience', 'event', 'players', 'teams', 'sponsors', 'reports', 'eventops'].forEach((t) => { const p = el('stats-panel-' + t); if (p) p.style.display = t === tab ? '' : 'none'; });
  if (tab === 'overview') { loadAnalyticsOverview(); loadStatsAggregate(); loadStatsMatches(true); }
  else if (tab === 'broadcasts') loadBroadcasts();
  else if (tab === 'audience') loadAudience();
  else if (tab === 'event') loadEventAnalytics();
  else if (tab === 'players') { loadStatsLeaders(); loadStatsPlayerList(); }
  else if (tab === 'teams') loadStatsTeams();
  else if (tab === 'sponsors') loadAdProof();
  else if (tab === 'reports') loadReports();
  // Event Ops moved here from ESPORTS (2026-08) — back-office spreadsheet/seed/bracket-mirror tools.
  else if (tab === 'eventops' && typeof window.eventOpsRender === 'function') window.eventOpsRender();
  try { localStorage.setItem('stats_active_tab', tab); } catch (_) {}
}


// ════════════════ Analytics dashboard (Overview / Broadcasts / Audience / Event) ════════════════
const ANALYTICS_API = 'http://127.0.0.1:3000/api/analytics';
let _anLive = null, _anBound = false;
let _anEvent = '', _anEventWired = false;   // Overview 'sort by event' filter
function anDur(sec) { sec = Math.max(0, Math.round(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return h ? `${h}h ${m}m` : (m ? `${m}m ${s}s` : `${s}s`); }
function anMmss(sec) { sec = Math.max(0, Math.round(sec || 0)); const m = Math.floor(sec / 60); return m + ':' + String(sec % 60).padStart(2, '0'); }
function anNum(n) { n = n || 0; return (typeof n === 'number' && n >= 1000) ? n.toLocaleString() : String(n); }
function anWhen(ts) { try { return ts ? new Date(ts).toLocaleString() : ''; } catch (e) { return ''; } }
function anKpis(tiles) { return '<div class="an-kpi">' + tiles.map((t) => `<div class="an-tile"><div class="an-tile-v">${escapeHtml(String(t.v))}</div><div class="an-tile-l">${escapeHtml(t.l)}</div></div>`).join('') + '</div>'; }
function anKpiInner(tiles) { return tiles.map((t) => `<div class="an-tile"><div class="an-tile-v">${escapeHtml(String(t.v))}</div><div class="an-tile-l">${escapeHtml(t.l)}</div></div>`).join(''); }
function anSparkline(samples, color) {
  samples = (samples || []).filter((s) => s && typeof s.v === 'number');
  if (samples.length < 2) return `<div class="an-chart-empty">Not enough viewer data captured yet${samples.length ? ` (last ${samples[0].v})` : ''}.</div>`;
  const W = 600, H = 120, P = 4, n = samples.length;
  const vs = samples.map((s) => s.v), max = Math.max(1, ...vs), min = Math.min(...vs), span = Math.max(1, max - min);
  const x = (i) => P + (i / (n - 1)) * (W - 2 * P), y = (v) => H - P - ((v - min) / span) * (H - 2 * P);
  const line = samples.map((s, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(s.v).toFixed(1)).join(' ');
  const area = `M${x(0).toFixed(1)} ${H - P} ` + samples.map((s, i) => 'L' + x(i).toFixed(1) + ' ' + y(s.v).toFixed(1)).join(' ') + ` L${x(n - 1).toFixed(1)} ${H - P} Z`;
  return `<div class="an-spark-wrap"><svg class="an-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="${area}" fill="${color}" opacity="0.13"/><path d="${line}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg><div class="an-spark-ax"><span>peak ${anNum(max)}</span><span>low ${anNum(min)}</span></div></div>`;
}
function anBars(items, color) {
  items = items || [];
  if (!items.length) return '<p class="section-desc" style="margin:0;">No data.</p>';
  const max = Math.max(1, ...items.map((i) => i.value || 0));
  return '<div class="an-bars">' + items.map((i) => `<div class="an-bar-row"><span class="an-bar-lbl" title="${escapeHtml(i.label)}">${escapeHtml(i.label)}</span><span class="an-bar-track"><span class="an-bar-fill" style="width:${Math.round((i.value || 0) / max * 100)}%;${color ? 'background:' + color : ''}"></span></span><span class="an-bar-val">${escapeHtml(i.sub != null ? String(i.sub) : String(i.value || 0))}</span></div>`).join('') + '</div>';
}
// Vertical column chart (value labels + axis labels). items: [{label, value, sub?}]
function anColumns(items, color) {
  items = (items || []).filter((i) => i);
  if (!items.length) return '<div class="an-chart-empty">No data captured yet.</div>';
  const max = Math.max(1, ...items.map((i) => i.value || 0));
  return '<div class="an-cols">' + items.map((i) => `<div class="an-col" title="${escapeHtml(i.label)}: ${escapeHtml(String(i.sub != null ? i.sub : (i.value || 0)))}"><span class="an-col-v">${escapeHtml(String(i.value || 0))}</span><span class="an-col-bar" style="height:${Math.max(2, Math.round((i.value || 0) / max * 100))}%;${color ? 'background:' + color : ''}"></span><span class="an-col-l">${escapeHtml(i.label)}</span></div>`).join('') + '</div>';
}
// Donut chart from segments [{label, value, color}].
function anDonut(segs, centerLabel) {
  segs = (segs || []).filter((s) => (s.value || 0) > 0);
  const total = segs.reduce((a, s) => a + (s.value || 0), 0);
  if (!total) return '<div class="an-chart-empty">No data captured yet.</div>';
  const R = 52, C = 2 * Math.PI * R; let off = 0;
  const arcs = segs.map((s) => { const dash = (s.value / total) * C; const el = `<circle r="${R}" cx="64" cy="64" fill="none" stroke="${s.color}" stroke-width="20" stroke-dasharray="${dash.toFixed(2)} ${(C - dash).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 64 64)"/>`; off += dash; return el; }).join('');
  const legend = segs.map((s) => `<span class="an-leg"><i style="background:${s.color}"></i>${escapeHtml(s.label)} <b>${anNum(s.value)}</b></span>`).join('');
  return `<div class="an-donut"><svg viewBox="0 0 128 128" width="120" height="120">${arcs}<circle r="31" cx="64" cy="64" fill="var(--surface2,#1a1d24)"/><text x="64" y="60" text-anchor="middle" class="an-donut-c">${anNum(total)}</text><text x="64" y="77" text-anchor="middle" class="an-donut-s">${escapeHtml(centerLabel || 'total')}</text></svg><div class="an-legend">${legend}</div></div>`;
}
// Progress ring for a single percentage.
function anRing(pct, label, color) {
  pct = Math.max(0, Math.min(100, Math.round(pct || 0))); const R = 48, C = 2 * Math.PI * R, dash = pct / 100 * C; color = color || '#22c3e6';
  return `<div class="an-ring"><svg viewBox="0 0 120 120" width="116" height="116"><circle r="${R}" cx="60" cy="60" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="12"/><circle r="${R}" cx="60" cy="60" fill="none" stroke="${color}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${(C - dash).toFixed(1)}" transform="rotate(-90 60 60)"/><text x="60" y="57" text-anchor="middle" class="an-ring-v">${pct}%</text><text x="60" y="77" text-anchor="middle" class="an-ring-l">${escapeHtml(label || '')}</text></svg></div>`;
}
const AN_COLORS = ['#22c3e6', '#ec4899', '#f5b14a', '#22e06a', '#a78bfa', '#60a5fa', '#fb7185', '#34d399'];

// Multi-series timeline line chart. points:[{date,...}], series:[{key,color,label}]
function anLineChart(points, series) {
  points = points || []; series = series || [];
  if (points.length < 2) return '<div class="an-chart-empty">Not enough data in this range to chart.</div>';
  const W = 720, H = 170, PX = 6, PY = 12, n = points.length;
  let max = 1; points.forEach((p) => series.forEach((s) => { if ((p[s.key] || 0) > max) max = p[s.key] || 0; }));
  const x = (i) => PX + (i / (n - 1)) * (W - 2 * PX), y = (v) => H - PY - (v / max) * (H - 2 * PY);
  const paths = series.map((s, si) => {
    const line = points.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p[s.key] || 0).toFixed(1)).join(' ');
    const area = si === 0 ? `<path d="M${x(0).toFixed(1)} ${H - PY} ${points.map((p, i) => 'L' + x(i).toFixed(1) + ' ' + y(p[s.key] || 0).toFixed(1)).join(' ')} L${x(n - 1).toFixed(1)} ${H - PY} Z" fill="${s.color}" opacity="0.10"/>` : '';
    return area + `<path d="${line}" fill="none" stroke="${s.color}" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  }).join('');
  const legend = series.map((s) => `<span class="an-leg"><i style="background:${s.color}"></i>${escapeHtml(s.label)}</span>`).join('');
  const idx = [0, Math.floor(n / 2), n - 1]; const xlabels = idx.map((i) => `<span>${escapeHtml((points[i].date || '').slice(5))}</span>`).join('');
  return `<div class="an-line-wrap"><div class="an-line-head"><span class="an-line-max">peak ${anNum(max)}</span><div class="an-legend-row">${legend}</div></div><svg class="an-line" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${paths}</svg><div class="an-line-ax">${xlabels}</div></div>`;
}

// Sortable table. Click a header to sort. columns:[{key,label,num?,fmt?}]. Re-renders into mountId.
const _anSort = {}, _anSortTables = {};
function anSortableHTML(id, columns, rows) {
  const st = _anSort[id];
  const sorted = rows.slice().sort((a, b) => { const v = a[st.key], w = b[st.key]; const c = (typeof v === 'number' && typeof w === 'number') ? (v - w) : String(v == null ? '' : v).localeCompare(String(w == null ? '' : w)); return st.dir * c; });
  const head = columns.map((c) => `<th data-sk="${c.key}" class="an-th${c.num ? ' st-num' : ''}${st.key === c.key ? ' sorted ' + (st.dir < 0 ? 'desc' : 'asc') : ''}">${escapeHtml(c.label)}</th>`).join('');
  const body = sorted.map((r) => '<tr>' + columns.map((c) => `<td${c.num ? ' class="st-num"' : (c.key === columns[0].key ? ' class="st-name"' : '')}>${c.fmt ? c.fmt(r[c.key], r) : escapeHtml(String(r[c.key] == null ? '' : r[c.key]))}</td>`).join('') + '</tr>').join('')
    || `<tr><td colspan="${columns.length}" class="stats-empty">No data in this range.</td></tr>`;
  return `<table class="stats-table an-sortable" data-tid="${id}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
function anRenderSortable(id) { const t = _anSortTables[id]; if (!t) return; const m = el(t.mountId); if (m) m.innerHTML = anSortableHTML(id, t.columns, t.rows); }
function anSortable(mountId, id, columns, rows, defaultKey, defaultDir) {
  _anSortTables[id] = { columns, rows, mountId };
  if (!_anSort[id]) _anSort[id] = { key: defaultKey || columns[0].key, dir: defaultDir || -1 };
  anRenderSortable(id);
}
document.addEventListener('click', (e) => {
  const th = e.target.closest && e.target.closest('.an-sortable .an-th'); if (!th) return;
  const id = th.closest('.an-sortable').dataset.tid; const sk = th.dataset.sk; const st = _anSort[id]; if (!st) return;
  if (st.key === sk) st.dir *= -1; else { st.key = sk; st.dir = -1; }
  anRenderSortable(id);
});

// ── Global analytics filter (date range / game / tournament) ────────────────
let _anFilter = { from: 0, to: 0, game: '', tournament: '' };
let _anRangePreset = 'all';
let _anFilterOpts = null;
let _anDash = null, _anDashSig = '';
let _anRefreshTimer = null;

function anFilterSig() { return [_anFilter.from, _anFilter.to, _anFilter.game, _anFilter.tournament].join('|'); }
async function ensureDashboard(force) {
  const sig = anFilterSig();
  if (!force && _anDash && _anDashSig === sig) return _anDash;
  const qs = new URLSearchParams();
  if (_anFilter.from) qs.set('from', _anFilter.from); if (_anFilter.to) qs.set('to', _anFilter.to);
  if (_anFilter.game) qs.set('game', _anFilter.game); if (_anFilter.tournament) qs.set('tournament', _anFilter.tournament);
  try { const r = await (await fetch('http://127.0.0.1:3000/api/stats/dashboard?' + qs.toString())).json(); _anDash = r.data || null; _anDashSig = sig; }
  catch (e) { _anDash = null; }
  return _anDash;
}
async function loadAnalyticsFilters() {
  try { _anFilterOpts = await (await fetch('http://127.0.0.1:3000/api/stats/filters')).json(); } catch (e) { _anFilterOpts = null; }
  const gsel = el('an-fb-game'), tsel = el('an-fb-tourn');
  const GAME_LABEL = { rl: 'Rocket League', cs2: 'CS2', valorant: 'Valorant' };
  // Never two blank dropdowns: before (or without) the server's answer they read All games / All
  // tournaments, and a filter with nothing to choose hides.
  const opts = _anFilterOpts || {};
  if (gsel) gsel.hidden = !(opts.games || []).length;
  if (tsel) tsel.hidden = !(opts.tournaments || []).length;
  if (gsel && !_anFilterOpts) gsel.innerHTML = '<option value="">All games</option>';
  if (tsel && !_anFilterOpts) tsel.innerHTML = '<option value="">All tournaments</option>';
  if (gsel && _anFilterOpts) {
    gsel.innerHTML = '<option value="">All games</option>' + (_anFilterOpts.games || []).map((g) => `<option value="${g.id}">${GAME_LABEL[g.id] || g.id} (${g.count})</option>`).join('');
    gsel.value = _anFilter.game;
  }
  if (tsel && _anFilterOpts) {
    tsel.innerHTML = '<option value="">All tournaments</option>' + (_anFilterOpts.tournaments || []).map((t) => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name.length > 46 ? t.name.slice(0, 46) + '…' : t.name)} (${t.count})</option>`).join('');
    tsel.value = _anFilter.tournament;
  }
}
function anApplyRangePreset(preset) {
  _anRangePreset = preset;
  document.querySelectorAll('#an-fb-range button').forEach((b) => b.classList.toggle('active', b.dataset.range === preset));
  el('an-fb-custom').style.display = preset === 'custom' ? 'inline-flex' : 'none';
  if (preset === 'all') { _anFilter.from = 0; _anFilter.to = 0; }
  else if (preset === 'custom') {
    const f = el('an-fb-from').value, t = el('an-fb-to').value;
    _anFilter.from = f ? new Date(f + 'T00:00:00').getTime() : 0;
    _anFilter.to = t ? new Date(t + 'T23:59:59').getTime() : 0;
  } else { _anFilter.to = 0; _anFilter.from = Date.now() - Number(preset) * 86400000; }
}
function anUpdateFilterMeta() {
  const m = el('an-fb-meta'); if (!m) return;
  const parts = [];
  if (_anRangePreset === 'all') parts.push('All time'); else if (_anRangePreset === 'custom') parts.push('Custom range'); else parts.push('Last ' + _anRangePreset + ' days');
  if (_anFilter.game) parts.push(({ rl: 'Rocket League', cs2: 'CS2', valorant: 'Valorant' })[_anFilter.game] || _anFilter.game);
  if (_anDash) parts.push(anNum(_anDash.totals.matches) + ' matches · ' + anNum(_anDash.totals.teams) + ' teams');
  m.textContent = parts.join(' · ');
}
async function anOnFilterChange() {
  _anDash = null; _anDashSig = '';
  await refreshActiveAnalyticsTab(true);
  anUpdateFilterMeta();
}
function refreshActiveAnalyticsTab(force) {
  const t = _statsTab;
  if (t === 'overview') return loadAnalyticsOverview();
  if (t === 'event') return loadEventAnalytics();
  if (t === 'teams') return loadStatsTeams();
  if (t === 'players') return loadStatsLeaders();
  if (t === 'broadcasts') return loadBroadcasts();
  if (t === 'audience') return loadAudience();
  if (t === 'sponsors') return loadAdProof();
  if (t === 'reports') return loadReports();
}

function anSessionsTable(rows) {
  if (!rows || !rows.length) return '<p class="section-desc" style="margin:0;">No broadcasts recorded yet. Start a session (or go live on Twitch) and it shows up here.</p>';
  return '<table class="stats-table an-table"><thead><tr><th>Broadcast</th><th>When</th><th>Length</th><th>Peak</th><th>Avg</th><th>Ads</th><th>Clips</th></tr></thead><tbody>'
    + rows.map((s) => `<tr class="an-row" data-an-sess="${s.id}"><td class="st-name">${escapeHtml(s.label || 'Broadcast')}${s.active ? ' <span class="an-rec-tag">LIVE</span>' : ''}</td><td>${escapeHtml(anWhen(s.endedAt || s.startedAt))}</td><td>${anDur(s.durationSec)}</td><td class="st-hi">${anNum(s.peakViewers)}</td><td>${anNum(s.avgViewers)}</td><td>${anNum(s.ads)}</td><td>${anNum(s.clips)}</td></tr>`).join('')
    + '</tbody></table>';
}

// ── Analytics dashboard: scannable category cards + a composite Production Score ──
function anDMetric(l, v, sub) { return `<div class="an-dm"><div class="an-dm-v">${escapeHtml(String(v))}</div><div class="an-dm-l">${escapeHtml(l)}</div>${sub ? `<div class="an-dm-s">${escapeHtml(sub)}</div>` : ''}</div>`; }
function anDCard(title, accent, metrics) {
  return `<div class="an-dcard" style="--dc:${accent};"><div class="an-dcard-hd"><span class="an-dcard-dot"></span>${escapeHtml(title)}</div><div class="an-dcard-grid">${metrics.map((m) => anDMetric(m.l, m.v, m.s)).join('')}</div></div>`;
}
function anScoreBar(label, pct) {
  const p = pct == null ? null : Math.max(0, Math.min(100, Math.round(pct)));
  return `<div class="an-sb"><span class="an-sb-l">${escapeHtml(label)}</span><span class="an-sb-track"><span class="an-sb-fill" style="width:${p == null ? 0 : p}%;"></span></span><span class="an-sb-v">${p == null ? '—' : p + '%'}</span></div>`;
}
// ── Business figures (manual entry, localStorage) — feeds the Business card ──
function anBusiness() { try { return JSON.parse(localStorage.getItem('ne_business_v1')) || {}; } catch (e) { return {}; } }
function anSaveBusiness(b) { try { localStorage.setItem('ne_business_v1', JSON.stringify(b || {})); } catch (e) {} }
let _bizWired = false;
function wireBusinessForm() {
  const b = anBusiness();
  ['sponsorship', 'entry', 'prize', 'production'].forEach((k) => { const inp = el('biz-' + k); if (inp && document.activeElement !== inp) inp.value = (b[k] != null) ? b[k] : ''; });
  if (_bizWired) return; _bizWired = true;
  el('biz-save')?.addEventListener('click', () => {
    const nb = {}; ['sponsorship', 'entry', 'prize', 'production'].forEach((k) => { const v = parseFloat(el('biz-' + k)?.value); if (!isNaN(v)) nb[k] = v; });
    anSaveBusiness(nb); if (typeof showToast === 'function') showToast('Business figures saved', '#22c55e'); renderAnalyticsDashboard();
  });
  el('biz-clear')?.addEventListener('click', async () => {
    if (!(await appConfirm('Clear the saved business figures?', 'Clear'))) return;
    anSaveBusiness({}); ['sponsorship', 'entry', 'prize', 'production'].forEach((k) => { const inp = el('biz-' + k); if (inp) inp.value = ''; }); renderAnalyticsDashboard();
  });
}

// ── Audience retention: area chart + join/leave heat strip + drop-off / gain callouts ──
function anClock(samples, i) { return anMmss(Math.round(((samples[i].t || 0) - (samples[0].t || 0)) / 1000)); }
function anRetention(samples) {
  samples = (samples || []).filter((p) => p && typeof p.v === 'number');
  if (samples.length < 2) return '<p class="section-desc" style="margin:0;">Not enough viewer samples yet — retention builds as a broadcast records.</p>';
  const vals = samples.map((p) => p.v);
  const peak = Math.max(1, ...vals);
  const first = vals[0] || 0, last = vals[vals.length - 1] || 0;
  let maxDrop = 0, dropAt = -1, maxGain = 0, gainAt = -1;
  for (let i = 1; i < vals.length; i++) { const d = vals[i] - vals[i - 1]; if (d < maxDrop) { maxDrop = d; dropAt = i; } if (d > maxGain) { maxGain = d; gainAt = i; } }
  const W = 680, H = 120, pad = 4;
  const X = (i) => (pad + (i / (samples.length - 1)) * (W - 2 * pad)).toFixed(1);
  const Y = (v) => (H - pad - (v / peak) * (H - 2 * pad)).toFixed(1);
  const line = vals.map((v, i) => (i ? 'L' : 'M') + X(i) + ',' + Y(v)).join(' ');
  const area = 'M' + X(0) + ',' + (H - pad) + ' ' + vals.map((v, i) => 'L' + X(i) + ',' + Y(v)).join(' ') + ' L' + X(vals.length - 1) + ',' + (H - pad) + ' Z';
  const mk = (i, c) => i < 0 ? '' : `<circle cx="${X(i)}" cy="${Y(vals[i])}" r="3.6" fill="${c}" stroke="#0b0d12" stroke-width="1"/>`;
  const strip = vals.slice(1).map((v, i) => { const d = v - vals[i]; const a = Math.min(1, Math.abs(d) / (peak * 0.15) + 0.12); const c = d > 0 ? `rgba(34,224,106,${a})` : (d < 0 ? `rgba(245,101,101,${a})` : 'rgba(255,255,255,.04)'); return `<span style="flex:1;background:${c};"></span>`; }).join('');
  const retPct = first ? Math.round((last / first) * 100) : 0;
  return `<div class="an-ret">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="an-ret-svg"><defs><linearGradient id="anretg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22c3e6" stop-opacity=".34"/><stop offset="1" stop-color="#22c3e6" stop-opacity="0"/></linearGradient></defs>
      <path d="${area}" fill="url(#anretg)"/><path d="${line}" fill="none" stroke="#22c3e6" stroke-width="2" vector-effect="non-scaling-stroke"/>${mk(dropAt, '#f56565')}${mk(gainAt, '#22e06a')}</svg>
    <div class="an-ret-heat" title="Green = viewers joining, red = leaving">${strip}</div>
    ${anKpis([
      { l: 'Start / end', v: anNum(first) + ' / ' + anNum(last) }, { l: 'Retention', v: retPct + '%' },
      { l: 'Biggest drop', v: maxDrop ? (anNum(maxDrop) + ' @ ' + anClock(samples, dropAt)) : '-' },
      { l: 'Biggest gain', v: maxGain ? ('+' + anNum(maxGain) + ' @ ' + anClock(samples, gainAt)) : '-' }
    ])}
  </div>`;
}

function wireEventFilter(ov) {
  const sel = el('an-event-filter'); if (!sel) return;
  const events = (ov && ov.events) || [];
  const sig = events.join('|');
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = '<option value="">All events</option>' + events.map((e) => `<option value="${escapeHtml(e)}">${escapeHtml(e.length > 42 ? e.slice(0, 42) + '…' : e)}</option>`).join('');
  }
  if (sel.value !== _anEvent) sel.value = _anEvent;
  if (_anEventWired) return; _anEventWired = true;
  sel.addEventListener('change', () => { _anEvent = sel.value; loadAnalyticsOverview(); });
}
async function renderAnalyticsDashboard() {
  const wrap = el('an-dashboard'); if (!wrap) return;
  let ov = null, ap = null, dash = null;
  try { ov = await (await fetch(ANALYTICS_API + '/overview' + (_anEvent ? '?event=' + encodeURIComponent(_anEvent) : ''))).json(); } catch (e) {}
  try { ap = await (await fetch(ADPROOF_API)).json(); } catch (e) {}
  try { dash = await ensureDashboard(); } catch (e) {}
  const ot = (ov && ov.totals) || {}, t = (dash && dash.totals) || {}, mp = ((dash && dash.pacing) || {}).matches || {};
  const spons = (ap && ap.sponsors) || [];
  const spSec = spons.reduce((a, x) => a + (x.seconds || 0), 0);
  const spVS = spons.reduce((a, x) => a + (x.viewerSeconds || 0), 0);
  const D = '—';
  const biz = anBusiness();
  const bizRev = (Number(biz.sponsorship) || 0) + (Number(biz.entry) || 0);
  const bizCpv = (Number(biz.production) && ot.peakViewers) ? ('$' + (Number(biz.production) / ot.peakViewers).toFixed(2)) : D;

  // Composite Production Score — averages ONLY the factors we can measure today.
  const perShowDisc = ot.broadcasts ? (ot.disconnects || 0) / ot.broadcasts : 0;
  const health = (ot.avgDropPct != null)
    ? Math.max(0, Math.round(100 - (ot.avgDropPct * 10) - Math.min(20, perShowDisc * 15) - (ot.avgCpu > 88 ? 10 : 0)))
    : (ot.broadcasts ? Math.max(0, Math.round(100 - Math.min(100, perShowDisc * 30))) : null);
  const engage = (ot.peakViewers && ot.avgPeakViewers) ? Math.round(100 * Math.min(1, ot.avgPeakViewers / ot.peakViewers)) : null;
  const tourn = (dash && t.tournaments) ? Math.min(100, 55 + Math.min(45, (t.matches || 0) * 2)) : null;
  const effic = ot.broadcasts ? Math.min(100, 65 + Math.min(35, (ot.clips || 0) * 3)) : null;
  const sponsor = spSec > 0 ? 100 : null;
  const factors = [['Broadcast Health', health], ['Viewer Engagement', engage], ['Tournament Ops', tourn], ['Production Efficiency', effic], ['Sponsor Delivery', sponsor]];
  const avail = factors.filter((x) => x[1] != null);
  const score = avail.length ? Math.round(avail.reduce((a, x) => a + x[1], 0) / avail.length) : null;

  const cards = [
    anDCard('Audience', '#22c3e6', [
      { l: 'Peak CCV', v: anNum(ot.peakViewers || 0) }, { l: 'Avg CCV', v: anNum(ot.avgPeakViewers || 0) },
      { l: 'Air time', v: anDur(ot.airSeconds || 0) }, { l: 'New viewers', v: D, s: 'Phase 1' }
    ]),
    anDCard('Tournament', '#a78bfa', [
      { l: 'Teams', v: anNum(t.teams || 0) }, { l: 'Matches', v: anNum(t.matches || 0) },
      { l: 'Games', v: anNum(t.games || 0) }, { l: 'Avg match', v: mp.count ? anMmss(mp.avg) : D }
    ]),
    anDCard('Broadcast', '#34d399', [
      { l: 'Broadcasts', v: anNum(ot.broadcasts || 0) }, { l: 'Live time', v: anDur(ot.airSeconds || 0) },
      { l: 'Disconnects', v: anNum(ot.disconnects || 0) }, { l: 'Replays', v: anNum(ot.replays || 0) }
    ]),
    anDCard('Stream Health', '#f43f5e', [
      { l: 'Dropped frames', v: ot.avgDropPct != null ? ot.avgDropPct + '%' : D, s: ot.avgDropPct == null ? 'relaunch to capture' : '' },
      { l: 'Bitrate', v: ot.avgBitrate ? anNum(ot.avgBitrate) + ' kbps' : D },
      { l: 'CPU', v: ot.avgCpu != null ? ot.avgCpu + '%' : D }, { l: 'Disconnects', v: anNum(ot.disconnects || 0) }
    ]),
    anDCard('Sponsors', '#ec4899', [
      { l: 'Airtime', v: anMmss(spSec) }, { l: 'Est. impressions', v: anNum(spVS) },
      { l: 'Sponsors', v: anNum(spons.length) }, { l: 'Clicks', v: D, s: 'no source' }
    ]),
    anDCard('Graphics', '#f0a83a', [
      { l: 'Ads run', v: anNum(ot.ads || 0) }, { l: 'Ad time', v: anMmss(ot.adSeconds || 0) },
      { l: 'Sponsor exposure', v: anMmss(spSec) }, { l: 'Lower thirds', v: D, s: 'Phase 1' }
    ]),
    anDCard('Production', '#f472b6', [
      { l: 'Scene changes', v: anNum(ot.sceneSwitches || 0) }, { l: 'Auto-switches', v: anNum(ot.autoSwitches || 0) },
      { l: 'Ad breaks', v: anNum(ot.ads || 0) }, { l: 'Manual overrides', v: D, s: 'Phase 1' }
    ]),
    anDCard('Social', '#818cf8', [
      { l: 'Clips created', v: anNum(ot.clips || 0) }, { l: 'Clip views', v: D, s: 'Phase 4' },
      { l: 'Shorts', v: D }, { l: 'CTR', v: D }
    ]),
    anDCard('Business', '#94a3b8', [
      { l: 'Revenue', v: bizRev ? '$' + anNum(bizRev) : D, s: bizRev ? '' : 'enter below' }, { l: 'Cost / viewer', v: bizCpv },
      { l: 'Prize pool', v: Number(biz.prize) ? '$' + anNum(Number(biz.prize)) : D }, { l: 'Production', v: Number(biz.production) ? '$' + anNum(Number(biz.production)) : D }
    ])
  ];

  wrap.innerHTML = `<div class="an-score">
      <div class="an-score-ring" style="--ang:${(score || 0) * 3.6}deg; --sc:${score == null ? '#7c5cff' : (score >= 85 ? '#22e06a' : (score >= 60 ? '#f5b14a' : '#f56565'))};"><div class="an-score-num">${score == null ? '—' : score}</div><div class="an-score-max">/ 100</div></div>
      <div class="an-score-side">
        <div class="an-score-title">Production Score</div>
        <div class="an-score-bars">${factors.map((x) => anScoreBar(x[0], x[1])).join('')}</div>
        <div class="an-score-note">Composite of the factors captured today; blank factors fill in as later phases add stream health, retention and sponsor-delivery data.</div>
      </div>
    </div>
    <div class="an-dgrid">${cards.join('')}</div>`;
}

async function loadAnalyticsOverview() {
  renderAnalyticsDashboard();
  wireBusinessForm();
  const dash = await ensureDashboard();
  let ov = null; try { ov = await (await fetch(ANALYTICS_API + '/overview' + (_anEvent ? '?event=' + encodeURIComponent(_anEvent) : ''))).json(); } catch (e) {}
  wireEventFilter(ov);
  const t = (dash && dash.totals) || {}, ot = (ov && ov.totals) || {};
  const kpi = el('an-kpi');
  if (kpi) kpi.innerHTML = anKpiInner([
    { l: 'Matches', v: anNum(t.matches) }, { l: 'Games', v: anNum(t.games) }, { l: 'Teams', v: anNum(t.teams) }, { l: 'Tournaments', v: anNum(t.tournaments) },
    { l: 'Broadcasts', v: anNum(ot.broadcasts) }, { l: 'Air time', v: anDur(ot.airSeconds) }, { l: 'Peak viewers', v: anNum(ot.peakViewers) }, { l: 'Clips', v: anNum(ot.clips) }
  ]);
  const banner = el('an-live-banner');
  if (banner) {
    const live = ov && ov.live;
    if (live && live.active) {
      // Try to pull YouTube live viewers to show combined count
      let ytViewers = 0;
      try {
        const yr = await fetch('http://127.0.0.1:3000/api/youtube/stats');
        if (yr.ok) { const yd = await yr.json(); ytViewers = (yd.data && yd.data.live && yd.data.live.isLive) ? (yd.data.live.viewers || 0) : 0; }
      } catch (_) {}
      const total = (live.viewers || 0) + ytViewers;
      const platforms = [
        live.viewers ? `<span class="aud-live-chip aud-live-tw">${anNum(live.viewers)} Twitch</span>` : '',
        ytViewers    ? `<span class="aud-live-chip aud-live-yt">${anNum(ytViewers)} YouTube</span>` : '',
      ].filter(Boolean).join('');
      banner.innerHTML = `<div class="an-livebar">
        <span class="app-live-dot"></span> <b>${escapeHtml(live.label || 'Recording')}</b>
        <span class="an-live-sub">${anDur(live.durationSec)} · peak ${anNum(live.peakViewers)}</span>
        <span class="an-livebar-viewers">${anNum(total)} viewers ${platforms}</span>
      </div>`;
    } else {
      banner.innerHTML = '';
    }
  }
  const charts = el('an-charts');
  if (charts) {
    const tl = (dash && dash.timeline) || [];
    const teamsTop = ((dash && dash.teams) || []).slice(0, 8).map((x) => ({ label: x.team.length > 16 ? x.team.slice(0, 16) + '…' : x.team, value: x.wins, sub: x.wins + '-' + x.losses }));
    const mix = anDonut([
      { label: 'Matches', value: t.matches || 0, color: AN_COLORS[0] }, { label: 'Games', value: t.games || 0, color: AN_COLORS[3] },
      { label: 'Clips', value: ot.clips || 0, color: AN_COLORS[1] }, { label: 'Ads', value: ot.ads || 0, color: AN_COLORS[2] }
    ], 'items');
    charts.innerHTML = `<h4 class="stats-sub" style="margin-top:0;">Match activity over time</h4>${anLineChart(tl, [{ key: 'matches', color: '#22c3e6', label: 'Matches' }, { key: 'games', color: '#a78bfa', label: 'Games' }])}
      <div class="an-2col" style="margin-top:14px;">
        <div><h4 class="stats-sub">Most wins (top teams)</h4>${anBars(teamsTop, '#22e06a')}</div>
        <div><h4 class="stats-sub">Content produced</h4>${mix}</div>
      </div>`;
  }
  const recent = el('an-recent');
  if (recent) {
    recent.innerHTML = anSessionsTable((ov && ov.recent) || []);
    recent.querySelectorAll('[data-an-sess]').forEach((r) => r.addEventListener('click', () => { statsShowTab('broadcasts'); setTimeout(() => openBroadcastDetail(r.dataset.anSess), 60); }));
  }
  anUpdateFilterMeta();
}

async function loadBroadcasts() {
  let ov = null; try { ov = await (await fetch(ANALYTICS_API + '/overview')).json(); } catch (e) {}
  _anLive = ov && ov.live;
  renderLiveCard(_anLive);
  const auto = el('an-auto'); if (auto) auto.checked = !(ov && ov.auto === false);
  const sess = el('an-sessions');
  if (sess) {
    const rows = (ov && ov.recent) || [];
    sess.innerHTML = (rows.length ? `<div style="display:flex;justify-content:flex-end;margin-bottom:6px;"><button class="btn btn-danger btn-sm" id="an-clear-all">Clear all broadcasts</button></div>` : '') + anSessionsTable(rows);
    sess.querySelectorAll('[data-an-sess]').forEach((r) => r.addEventListener('click', () => openBroadcastDetail(r.dataset.anSess)));
    el('an-clear-all')?.addEventListener('click', async () => { if (!(await appConfirm('Delete ALL broadcast sessions? This cannot be undone.', 'Delete'))) return; try { await fetch(ANALYTICS_API + '/sessions', { method: 'DELETE' }); } catch (e) {} loadBroadcasts(); });
  }
  bindBroadcastControls();
}
function bindBroadcastControls() {
  if (_anBound) return; _anBound = true;
  el('an-start')?.addEventListener('click', async () => { const label = (el('an-label')?.value || '').trim(); try { await fetch(ANALYTICS_API + '/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) }); } catch (e) {} loadBroadcasts(); });
  el('an-stop')?.addEventListener('click', async () => { try { await fetch(ANALYTICS_API + '/stop', { method: 'POST' }); } catch (e) {} loadBroadcasts(); });
  el('an-auto')?.addEventListener('change', async (e) => { try { await fetch(ANALYTICS_API + '/auto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: e.target.checked }) }); } catch (er) {} });
}
function renderLiveCard(live) {
  const card = el('an-live-card'); const start = el('an-start'), stop = el('an-stop');
  const active = !!(live && live.active);
  if (start) start.style.display = active ? 'none' : '';
  if (stop) stop.style.display = active ? '' : 'none';
  if (!card) return;
  if (!active) { card.innerHTML = '<p class="section-desc" style="margin:0;">No session recording. Start one to capture this show — or it auto-starts when Twitch reports you live.</p>'; return; }
  const viewers = (live.viewers != null) ? live.viewers : (live.viewerSamples && live.viewerSamples.length ? live.viewerSamples[live.viewerSamples.length - 1].v : 0);
  const disc = Array.isArray(live.disconnects) ? live.disconnects.length : (live.disconnects || 0);
  const spark = (live.viewerSamples && live.viewerSamples.length > 1) ? `<div style="margin-top:12px;">${anSparkline(live.viewerSamples, '#22c3e6')}</div>` : '';
  card.innerHTML = `<div class="an-live-head"><span class="app-live-dot"></span><b>${escapeHtml(live.label || '')}</b><span class="an-live-sub">${anDur(live.durationSec)} elapsed${live.game ? ' · ' + escapeHtml(live.game) : ''}</span></div>`
    + anKpis([
      { l: 'Viewers now', v: anNum(viewers) }, { l: 'Peak', v: anNum(live.peakViewers) }, { l: 'Avg', v: anNum(live.avgViewers) }, { l: 'Scene switches', v: anNum(live.sceneSwitches) },
      { l: 'Ads', v: anNum(live.ads && live.ads.count) }, { l: 'Clips', v: anNum(live.clips) }, { l: 'Games done', v: anNum(live.gamesCompleted) }, { l: 'Disconnects', v: anNum(disc) }
    ]) + spark;
}
async function openBroadcastDetail(id) {
  const wrap = el('an-detail'); if (!wrap) return;
  wrap.style.display = ''; wrap.innerHTML = '<section class="section"><p class="section-desc">Loading report…</p></section>';
  let d = null; try { d = await (await fetch(ANALYTICS_API + '/session/' + id)).json(); } catch (e) {}
  const s = d && d.session;
  if (!s) { wrap.innerHTML = '<section class="section"><p style="color:#f56565;">Could not load that report.</p></section>'; return; }
  try { wrap.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
  const sceneItems = Object.keys(s.sceneTime || {}).map((k) => ({ label: k, value: s.sceneTime[k], sub: anMmss(s.sceneTime[k]) })).sort((a, b) => b.value - a.value).slice(0, 12);
  const segItems = Object.keys(s.segments || {}).map((k) => { const g = s.segments[k] || {}; return { label: k, value: g.avgViewers || 0, sub: anMmss(g.seconds || 0) + ' \u00b7 ' + anNum(g.avgViewers || 0) + ' CCV' }; }).sort((a, b) => b.value - a.value);
  const e = s.engagement || {}, disc = s.disconnects || [];
  wrap.innerHTML = `<section class="section">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
      <div><h3 class="section-title" style="margin:0;">${escapeHtml(s.label || 'Broadcast')}${s.active ? ' <span class="an-rec-tag">LIVE</span>' : ''}</h3>
        <p class="section-desc" style="margin:4px 0 0;">${escapeHtml(anWhen(s.startedAt))} · ${anDur(s.durationSec)}${s.game ? ' · ' + escapeHtml(s.game) : ''}</p></div>
      <div style="display:flex;gap:6px;">
        <button class="btn btn-secondary btn-sm" id="an-exp">Export CSV</button>
        ${s.active ? '' : '<button class="btn btn-danger btn-sm" id="an-del">Delete</button>'}
        <button class="btn btn-ghost btn-sm" id="an-close">Close</button>
      </div>
    </div>
    <div style="margin-top:12px;">${anKpis([
      { l: 'Peak viewers', v: anNum(s.peakViewers) }, { l: 'Avg viewers', v: anNum(s.avgViewers) }, { l: 'Live time', v: anDur(s.liveSeconds) },
      { l: 'Ads', v: anNum((s.ads && s.ads.count) || 0) + ' · ' + anMmss((s.ads && s.ads.totalSec) || 0) },
      { l: 'Clips', v: anNum(s.clips) }, { l: 'Replays', v: anNum(s.replaysSaved) }, { l: 'Matches', v: anNum(s.matchesCompleted) }, { l: 'Disconnects', v: anNum(disc.length) }
    ])}</div>
    <h4 class="stats-sub" style="margin-top:18px;">Audience retention</h4>${anRetention(s.viewerSamples)}
    <div class="an-2col">
      <div><h4 class="stats-sub">Time on scene</h4>${sceneItems.length ? anBars(sceneItems) : '<p class="section-desc" style="margin:0;">No scene data — connect OBS to capture this.</p>'}</div>
      <div><h4 class="stats-sub">Engagement</h4>${anBars([
        { label: 'Predictions', value: e.predictionsCreated || 0 }, { label: 'Polls', value: e.pollsCreated || 0 }, { label: 'Wheel spins', value: e.wheelSpins || 0 }, { label: 'Mini-games', value: e.minigames || 0 },
        { label: 'Follows', value: e.follows || 0 }, { label: 'Subs', value: e.subs || 0 }, { label: 'Bits', value: e.bits || 0 }, { label: 'Raids', value: e.raids || 0 }
      ])}</div>
    </div>
    <h4 class="stats-sub" style="margin-top:16px;">Segments \u2014 average viewers</h4>${segItems.length ? anBars(segItems) : '<p class="section-desc" style="margin:0;">No segment data yet \u2014 segments are captured live while a broadcast records.</p>'}
    ${s.health ? `<h4 class="stats-sub" style="margin-top:16px;">Stream health</h4>${anKpis([
      { l: 'Avg drop', v: s.health.avgDropPct + '%' }, { l: 'Peak drop', v: s.health.maxDropPct + '%' },
      { l: 'Avg bitrate', v: anNum(s.health.avgBitrate) + ' kbps' }, { l: 'Avg CPU', v: s.health.avgCpu + '%' },
      { l: 'Avg FPS', v: s.health.avgFps }, { l: 'Peak congestion', v: s.health.maxCongestion }
    ])}` : ''}
    ${disc.length ? `<h4 class="stats-sub" style="margin-top:16px;">Technical log</h4><div class="an-disc">${disc.map((x) => `<div class="an-disc-row"><span>${escapeHtml(x.what || 'disconnect')}</span><span>${escapeHtml(new Date(x.t).toLocaleTimeString())}</span></div>`).join('')}</div>` : ''}
  </section>`;
  el('an-exp')?.addEventListener('click', () => anFetchDownload(ANALYTICS_API + '/export?session=' + encodeURIComponent(id), 'broadcast.csv'));
  el('an-close')?.addEventListener('click', () => { wrap.style.display = 'none'; wrap.innerHTML = ''; });
  el('an-del')?.addEventListener('click', async () => { if (!(await appConfirm('Delete this broadcast report?', 'Delete'))) return; try { await fetch(ANALYTICS_API + '/session/' + id, { method: 'DELETE' }); } catch (er) {} wrap.style.display = 'none'; wrap.innerHTML = ''; loadBroadcasts(); });
}

// YouTube channel stats — subscribers, video views, recent uploads, live viewers.
async function loadYouTubeStats(refresh) {
  const wrap = el('aud-youtube'); if (!wrap) return;
  if (!wrap.innerHTML) wrap.innerHTML = '<p class="section-desc" style="margin:0;">Loading YouTube stats…</p>';
  let r = null;
  try { r = await (await fetch('http://127.0.0.1:3000/api/youtube/stats' + (refresh ? '?refresh=1' : ''))).json(); } catch (e) {}
  if (!r || !r.ok) {
    const msg = (r && r.message) || 'Could not reach YouTube.';
    const btn = (r && r.needsConnect) ? ' <button class="btn btn-secondary btn-sm" onclick="document.querySelector(\'.tab-btn[data-tab=ajustes]\')?.click()">Connect YouTube</button>' : '';
    wrap.innerHTML = `<div class="an-chart-empty">${escapeHtml(msg)}${btn}</div>`;
    return;
  }
  const d = r.data || {};
  const ch = d.channel || {}, live = d.live || {}, videos = d.videos || [];

  const liveChip = live.isLive
    ? `<span class="aud-live-chip aud-live-yt"><span class="app-live-dot"></span>${anNum(live.viewers)} live</span>`
    : '';

  const kpis = anKpis([
    { l: 'Subscribers',  v: anNum(ch.subscribers) },
    { l: 'Total views',  v: anNum(ch.totalViews)  },
    { l: 'Videos',       v: anNum(ch.videoCount)  },
    { l: 'Live viewers', v: live.isLive ? anNum(live.viewers) : 'Offline' },
  ]);

  const vidRows = videos.slice(0, 10).map((v) =>
    `<div class="an-disc-row">
      <span><a class="aud-yt-link" href="${escapeHtml(v.url)}" target="_blank" title="${escapeHtml(v.title)}">${escapeHtml((v.title || '').slice(0, 52))}</a></span>
      <span>${anNum(v.views)} views</span>
    </div>`
  ).join('') || '<p class="section-desc" style="margin:0;">No recent videos found.</p>';

  const viewCols = videos.slice(0, 10).reverse().map((v) => ({
    label: (v.publishedAt || '').slice(5, 10),
    value: v.views,
    sub: anNum(v.views) + ' views',
  }));

  wrap.innerHTML = liveChip + kpis
    + `<div class="an-2col" style="margin-top:12px;">
        <div><h4 class="stats-sub" style="margin-top:0;">Recent video views</h4>${viewCols.length ? anColumns(viewCols, '#ff0000') : '<div class="an-chart-empty">No videos.</div>'}</div>
        <div><h4 class="stats-sub" style="margin-top:0;">Recent uploads</h4><div class="an-disc">${vidRows}</div></div>
      </div>`;
}

// Twitch channel stats (followers/subs/bits/VODs/clips) pulled from the Twitch API.
async function loadTwitchChannelStats(refresh) {
  const wrap = el('aud-twitch'); if (!wrap) return;
  if (!wrap.innerHTML) wrap.innerHTML = '<p class="section-desc" style="margin:0;">Loading Twitch stats…</p>';
  let r = null;
  try { r = await (await fetch('http://127.0.0.1:3000/api/twitch/stats' + (refresh ? '?refresh=1' : ''))).json(); } catch (e) {}
  if (!r || !r.ok) {
    wrap.innerHTML = `<div class="an-chart-empty">${escapeHtml((r && r.message) || 'Could not reach Twitch.')}${(r && r.needsReconnect) ? ' <button class="btn btn-secondary btn-sm" onclick="document.querySelector(\'.tab-btn[data-tab=ajustes]\')?.click()">Open Settings</button>' : ''}</div>`;
    return;
  }
  const d = r.data || {};
  if (d.needsReconnect) { wrap.innerHTML = '<div class="an-chart-empty">Your Twitch token has expired — reconnect Twitch in Settings to pull channel stats.</div>'; return; }
  const f = d.followers || {}, s = d.subscriptions || {}, b = d.bits || {}, vods = (d.pastBroadcasts && d.pastBroadcasts.items) || [], clips = (d.topClips && d.topClips.items) || [];
  const kpis = anKpis([
    { l: 'Followers', v: f.ok ? anNum(f.total) : '—' },
    { l: 'Subscribers', v: s.ok ? anNum(s.total) : '—' },
    { l: 'Sub points', v: s.ok ? anNum(s.points) : '—' },
    { l: 'Bits (all-time)', v: b.ok ? anNum(b.total) : '—' },
    { l: 'Past broadcasts', v: anNum(vods.length) },
    { l: 'Live now', v: (d.stream && d.stream.isLive) ? anNum(d.stream.viewers) : 'Offline' }
  ]);
  const vodCols = vods.slice(0, 12).reverse().map((v) => ({ label: (v.createdAt || '').slice(5, 10), value: v.viewCount, sub: anNum(v.viewCount) + ' views' }));
  const clipRows = clips.slice(0, 10).map((c) => `<div class="an-disc-row"><span><b>${escapeHtml((c.title || '').slice(0, 48))}</b>${c.creator ? ' · ' + escapeHtml(c.creator) : ''}</span><span>${anNum(c.viewCount)} views</span></div>`).join('') || '<p class="section-desc" style="margin:0;">No clips found.</p>';
  const scopeNote = (!f.ok || !s.ok) ? `<p class="section-desc" style="margin-top:6px;font-size:11px;">${!f.ok ? 'Followers' : ''}${(!f.ok && !s.ok) ? ' & ' : ''}${!s.ok ? 'Subscribers' : ''} unavailable — reconnect Twitch to grant the needed scopes.</p>` : '';
  wrap.innerHTML = kpis + scopeNote + `<div class="an-2col" style="margin-top:12px;">
      <div><h4 class="stats-sub" style="margin-top:0;">Past broadcast views (VODs)</h4>${vodCols.length ? anColumns(vodCols, '#9147ff') : '<div class="an-chart-empty">No past broadcasts found.</div>'}</div>
      <div><h4 class="stats-sub" style="margin-top:0;">Top clips by views</h4><div class="an-disc">${clipRows}</div></div>
    </div>`;
}

async function loadAudience() {
  // Load platform panels in parallel, then engagement data
  [loadTwitchChannelStats(), loadYouTubeStats()];
  let d = null; try { d = (await (await fetch(ANALYTICS_API + '/engagement')).json()).data; } catch (e) {}

  // Platforms bar — combined live viewers across connected platforms
  const platBar = el('aud-platforms-bar');
  if (platBar && d) {
    const twLive = d.stream && d.stream.isLive;
    const chips = [];
    if (twLive) chips.push(`<span class="aud-live-chip aud-live-tw"><span class="app-live-dot"></span><b>${anNum(d.stream.viewers)}</b> on Twitch</span>`);
    platBar.innerHTML = chips.length
      ? `<div class="aud-platforms-header">Live now: ${chips.join('')}</div>`
      : '';
  }

  const kpi = el('aud-kpi'), body = el('aud-body');
  if (!d) { if (kpi) kpi.innerHTML = ''; if (body) body.innerHTML = '<p class="section-desc">No engagement data yet.</p>'; return; }
  const a = d.activity || {}, p = d.predictions || {}, po = d.polls || {}, wh = d.wheel || {}, mg = d.minigames || {};
  if (kpi) kpi.innerHTML = anKpiInner([
    { l: 'Twitch viewers', v: (d.stream && d.stream.isLive) ? anNum(d.stream.viewers) : 'Offline' },
    { l: 'Predictions', v: anNum(p.total) }, { l: 'Pts wagered', v: anNum(p.totalPoints) }, { l: 'Polls', v: anNum(po.total) },
    { l: 'Wheel spins', v: anNum(wh.spins) }, { l: 'Mini-games', v: anNum(mg.total) },
    { l: 'Follows', v: anNum(a.follow) }, { l: 'Subs', v: anNum(a.subscribe) }, { l: 'Raids', v: anNum(a.raid) }, { l: 'Bits', v: anNum(a.bitsAmount) }
  ]);
  if (body) {
    const predRows = (p.recent || []).map((x) => `<tr><td class="st-name">${escapeHtml(x.title || '')}</td><td>${escapeHtml(x.state || '')}</td><td class="st-hi">${anNum(x.points)}</td><td>${anNum(x.voters)}</td></tr>`).join('') || '<tr><td colspan="4" class="stats-empty">No predictions run yet.</td></tr>';
    const acts = (d.recentActivity || []).slice(0, 24).map((x) => {
      const tag = x.type === 'bits' ? `${anNum(x.amount)} bits` : x.type === 'raid' ? `raid · ${anNum(x.viewers)}` : x.type === 'subscribe' ? `sub${x.tier ? ' T' + x.tier : ''}` : 'follow';
      return `<div class="an-disc-row"><span><b>${escapeHtml(x.username || 'someone')}</b> · ${escapeHtml(tag)}</span><span>${escapeHtml(x.timestamp ? new Date(x.timestamp).toLocaleTimeString() : '')}</span></div>`;
    }).join('') || '<p class="section-desc" style="margin:0;">No channel activity captured.</p>';
    const activityMix = anDonut([
      { label: 'Follows', value: a.follow || 0, color: AN_COLORS[0] },
      { label: 'Subs', value: a.subscribe || 0, color: AN_COLORS[1] },
      { label: 'Raids', value: a.raid || 0, color: AN_COLORS[2] },
      { label: 'Bits cheers', value: a.bits || 0, color: AN_COLORS[3] }
    ], 'events');
    const segCols = anColumns([
      { label: 'Predict', value: p.total || 0 }, { label: 'Polls', value: po.total || 0 },
      { label: 'Wheel', value: wh.spins || 0 }, { label: 'Mini', value: mg.total || 0 }
    ], '#a78bfa');
    body.innerHTML = `<div class="an-2col">
        <div><h4 class="stats-sub" style="margin-top:0;">Channel activity mix</h4>${activityMix}</div>
        <div><h4 class="stats-sub" style="margin-top:0;">Interactive segments run</h4>${segCols}</div>
      </div>
      <div class="an-2col" style="margin-top:6px;">
        <div><h4 class="stats-sub">Recent predictions</h4><table class="stats-table"><thead><tr><th>Title</th><th>Result</th><th>Pts</th><th>Voters</th></tr></thead><tbody>${predRows}</tbody></table>
          <h4 class="stats-sub" style="margin-top:16px;">Wheel entries by method</h4>${anBars(Object.keys(wh.byMethod || {}).map((k) => ({ label: k, value: wh.byMethod[k] })))}</div>
        <div><h4 class="stats-sub">Channel activity</h4><div class="an-disc">${acts}</div></div>
      </div>`;
  }
}

// Trigger the historical start.gg importer; progress arrives over WS ('startgg_import').
async function startggImportGo() {
  const btn = el('sgi-go'), status = el('sgi-status');
  const nameQuery = (el('sgi-name')?.value || 'Rocket Rush').trim();
  if (btn) btn.disabled = true;
  if (status) { status.textContent = 'Starting import…'; status.style.color = ''; }
  try {
    const r = await (await fetch('http://127.0.0.1:3000/api/stats/import-startgg', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nameQuery }) })).json();
    if (!r.ok) { if (status) { status.textContent = r.message || 'Could not start.'; status.style.color = '#f56565'; } if (btn) btn.disabled = false; }
  } catch (e) { if (status) { status.textContent = 'Request failed: ' + e.message; status.style.color = '#f56565'; } if (btn) btn.disabled = false; }
}
function onStartggImport(p) {
  const status = el('sgi-status'), btn = el('sgi-go');
  if (status) {
    const s = p.summary;
    status.textContent = (p.message || '') + (s ? ` — ${s.imported} imported, ${s.skipped} skipped` : '');
    status.style.color = p.error ? '#f56565' : (p.done ? '#9ae6b4' : '');
  }
  if (p.done) {
    if (btn) btn.disabled = false;
    _anDash = null; _anDashSig = '';
    // Refresh the dashboards with the freshly imported data.
    if (el('stats-panel-event') && el('stats-panel-event').style.display !== 'none') loadEventAnalytics();
    if (typeof loadAnalyticsOverview === 'function') loadAnalyticsOverview();
  }
}

// ── start.gg find-and-add: search any tournament → pick an event → import its sets ──
async function sgiSearch() {
  const q = (el('sgi-search')?.value || '').trim();
  const res = el('sgi-results'), evs = el('sgi-events');
  if (evs) evs.innerHTML = '';
  if (!q || q.length < 2) { if (res) res.innerHTML = '<p class="section-desc" style="margin:8px 0 0;">Type at least 2 characters.</p>'; return; }
  if (res) res.innerHTML = '<p class="section-desc" style="margin:8px 0 0;">Searching start.gg…</p>';
  try {
    const r = await (await fetch('http://127.0.0.1:3000/api/startgg/search-tournaments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) })).json();
    if (r.error) { if (res) res.innerHTML = `<p class="section-desc" style="color:#f56565;margin:8px 0 0;">${escapeHtml(r.error)}</p>`; return; }
    const list = r.tournaments || [];
    if (!list.length) { if (res) res.innerHTML = '<p class="section-desc" style="margin:8px 0 0;">No tournaments found.</p>'; return; }
    res.innerHTML = list.map((t) => `<button class="sgi-tourn" data-slug="${escapeHtml(t.slug)}" data-name="${escapeHtml(t.name)}">${t.image ? `<img src="${escapeHtml(t.image)}" alt="">` : '<span class="sgi-tourn-ph"></span>'}<span class="sgi-tourn-b"><span class="sgi-tourn-n">${escapeHtml(t.name)}</span><span class="sgi-tourn-m">${t.eventCount || 0} events · ${anNum(t.numAttendees || 0)} entrants${t.startAt ? ' · ' + new Date(t.startAt * 1000).toLocaleDateString() : ''}</span></span></button>`).join('');
    res.querySelectorAll('.sgi-tourn').forEach((b) => b.addEventListener('click', () => sgiLoadEvents(b.dataset.slug, b.dataset.name)));
  } catch (e) { if (res) res.innerHTML = `<p class="section-desc" style="color:#f56565;margin:8px 0 0;">Search failed: ${escapeHtml(e.message)}</p>`; }
}
async function sgiLoadEvents(slug, tname) {
  const evs = el('sgi-events');
  if (evs) evs.innerHTML = '<p class="section-desc" style="margin:8px 0 0;">Loading events…</p>';
  try {
    const r = await (await fetch('http://127.0.0.1:3000/api/startgg/tournament-events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tournamentSlug: slug }) })).json();
    const list = r.events || [];
    if (!list.length) { if (evs) evs.innerHTML = '<p class="section-desc" style="margin:8px 0 0;">No events on that tournament.</p>'; return; }
    evs.innerHTML = `<div class="sgi-events-hd">${escapeHtml(tname)} — pick an event to import:</div>` + list.map((e) => {
      const g = ((e.videogame && e.videogame.name) || '').toLowerCase();
      const gt = g.includes('rocket') ? 'rl' : ((g.includes('counter') || g.includes('cs:')) ? 'cs2' : (g.includes('valorant') ? 'valorant' : 'rl'));
      return `<button class="sgi-event" data-eid="${escapeHtml(String(e.id))}" data-name="${escapeHtml(tname + ' — ' + e.name)}" data-gt="${gt}"><span class="sgi-event-n">${escapeHtml(e.name)}</span><span class="sgi-event-m">${escapeHtml((e.videogame && e.videogame.name) || '')}${e.numEntrants ? ' · ' + anNum(e.numEntrants) + ' entrants' : ''}</span><span class="sgi-event-add">+ Add</span></button>`;
    }).join('');
    evs.querySelectorAll('.sgi-event').forEach((b) => b.addEventListener('click', () => sgiImportEvent(b.dataset.eid, b.dataset.name, b.dataset.gt)));
  } catch (e) { if (evs) evs.innerHTML = `<p class="section-desc" style="color:#f56565;margin:8px 0 0;">Failed to load events: ${escapeHtml(e.message)}</p>`; }
}
async function sgiImportEvent(eventId, tournamentName, gameType) {
  const status = el('sgi-status');
  if (status) { status.textContent = 'Starting import…'; status.style.color = ''; }
  try {
    const r = await (await fetch('http://127.0.0.1:3000/api/stats/import-startgg-event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId, tournamentName, gameType }) })).json();
    if (!r.ok && status) { status.textContent = r.message || 'Could not start.'; status.style.color = '#f56565'; }
  } catch (e) { if (status) { status.textContent = 'Request failed: ' + e.message; status.style.color = '#f56565'; } }
}
el('sgi-search-go')?.addEventListener('click', sgiSearch);
el('sgi-search')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') sgiSearch(); });
// Search as you type as well as on Enter/click. 400ms is long enough that a normal typing burst
// costs one start.gg call, not one per character.
NESearch.bindBox(el('sgi-search'), (q) => { if (q.length >= 2) sgiSearch(); }, 400);

async function loadEventAnalytics() {
  const dash = await ensureDashboard();
  let live = null; try { live = (await (await fetch(ANALYTICS_API + '/event')).json()).data; } catch (e) {}
  const kpi = el('ev-an-kpi'), body = el('ev-an-body');
  const b = (live && live.bracket) || {}, q = (live && live.queue) || {}, ev = (live && live.event) || {};
  const pc = (dash && dash.pacing) || {}, mp = (pc.matches || {}), gp = (pc.games || {});
  if (kpi) kpi.innerHTML = anKpiInner([
    { l: 'Live bracket', v: (b.pct || 0) + '%' }, { l: 'Sets on stream', v: anNum(b.completed) + ' / ' + anNum(b.total || (q.done + q.live + q.upcoming) || 0) },
    { l: 'Matches (filtered)', v: anNum((dash && dash.totals.matches) || 0) }, { l: 'Tournaments', v: anNum((dash && dash.totals.tournaments) || 0) },
    { l: 'Avg match', v: mp.count ? anMmss(mp.avg) : '—' }, { l: 'Median match', v: mp.count ? anMmss(mp.median) : '—' }, { l: 'Avg game', v: gp.count ? anMmss(gp.avg) : '—' }, { l: 'Longest match', v: mp.count ? anMmss(mp.max) : '—' }
  ]);
  if (body) {
    const histo = (pc.histogram || []).map((h) => ({ label: h.label, value: h.count }));
    const queueDonut = anDonut([
      { label: 'Completed', value: q.done || 0, color: AN_COLORS[3] }, { label: 'On now', value: q.live || 0, color: AN_COLORS[1] }, { label: 'Upcoming', value: q.upcoming || 0, color: AN_COLORS[2] }
    ], 'sets');
    const hero = `<div class="an-hero">
      <div class="an-hero-c"><h4 class="stats-sub" style="margin-top:0;text-align:center;">Live bracket</h4>${anRing(b.pct || 0, 'complete', '#22e06a')}</div>
      <div class="an-hero-c"><h4 class="stats-sub" style="margin-top:0;text-align:center;">Stream queue (now)</h4>${queueDonut}</div>
      <div class="an-hero-c" style="flex:2;min-width:280px;"><h4 class="stats-sub" style="margin-top:0;">Match length distribution${mp.count ? ' (median ' + anMmss(mp.median) + ')' : ''}</h4>${histo.length ? (window.AnChart ? AnChart.columns(histo.map((h) => ({ label: h.label, values: [h.value] })), { series: [{ name: 'Matches', color: '#f5b14a' }], height: 230 }) : anColumns(histo, '#f5b14a')) : '<div class="an-chart-empty">No completed matches in range.</div>'}</div>
    </div>`;
    const maps = ((dash && dash.mapStats) || []).slice(0, 12).map((m) => ({ label: m.map + (m.game_type && m.game_type !== 'rl' ? ' · ' + m.game_type : ''), value: m.played, sub: m.played + ' (A ' + m.aWins + ' / B ' + m.bWins + ')' }));
    body.innerHTML = hero
      + `<h4 class="stats-sub">Tournament breakdown <span class="section-desc" style="font-weight:600;">(click a column to sort)</span></h4><div id="ev-tourn-table"></div>`
      + `<div class="an-2col" style="margin-top:16px;"><div><h4 class="stats-sub">Map / arena split</h4>${maps.length ? anBars(maps) : '<p class="section-desc" style="margin:0;">No map-level results in range.</p>'}</div>
        <div><h4 class="stats-sub">Scheduling guide</h4><p class="section-desc">${mp.count ? `Plan ~${anMmss(mp.median)} per match (avg ${anMmss(mp.avg)}, range ${anMmss(mp.min)}–${anMmss(mp.max)}). A ${anNum(q.upcoming || 0)}-set queue ≈ ${anMmss((q.upcoming || 0) * (mp.median || 0))} of play.` : 'Not enough completed matches in range to estimate pacing.'}</p></div></div>`;
    const rows = ((dash && dash.perTournament) || []).map((t) => ({ tournament: t.tournament, matches: t.matches, games: t.games, teams: t.teams, lastAt: t.lastAt }));
    anSortable('ev-tourn-table', 'ev-tourn', [
      { key: 'tournament', label: 'Tournament', fmt: (v) => escapeHtml(v.length > 50 ? v.slice(0, 50) + '…' : v) },
      { key: 'matches', label: 'Matches', num: true }, { key: 'games', label: 'Games', num: true }, { key: 'teams', label: 'Teams', num: true },
      { key: 'lastAt', label: 'Last played', num: true, fmt: (v) => escapeHtml(anWhen(v)) }
    ], rows, 'lastAt', -1);
  }
}

// ── Reports & exports ───────────────────────────────────────────────────────
function anDownload(name, content, mime) {
  try {
    const blob = new Blob([content], { type: mime || 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 120);
  } catch (e) {}
}
function csvCell(v) { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function toCSV(headers, rows) { return [headers.map(csvCell).join(',')].concat(rows.map((r) => r.map(csvCell).join(','))).join('\r\n'); }
// Download a server-generated file (CSV/JSON) without a pop-up window — fetch it and save the blob.
async function anFetchDownload(url, fallbackName, mime) {
  try {
    const res = await fetch(url); const text = await res.text();
    const cd = res.headers.get('Content-Disposition') || ''; const m = cd.match(/filename="?([^";]+)"?/);
    anDownload((m && m[1]) || fallbackName, text, mime || 'text/csv;charset=utf-8');
  } catch (e) { try { window.open(url, '_blank'); } catch (_) {} }
}
function reportContext() {
  const parts = [];
  parts.push(_anRangePreset === 'all' ? 'All time' : _anRangePreset === 'custom' ? 'Custom range' : 'Last ' + _anRangePreset + ' days');
  parts.push(_anFilter.game ? (({ rl: 'Rocket League', cs2: 'CS2', valorant: 'Valorant' })[_anFilter.game] || _anFilter.game) : 'All games');
  parts.push(_anFilter.tournament || 'All tournaments');
  return parts.join(' · ');
}
function repSlug() {
  const t = _anFilter.tournament ? _anFilter.tournament.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)
    : (_anRangePreset === 'all' ? 'all-time' : _anRangePreset === 'custom' ? 'custom' : _anRangePreset + 'd');
  return ('ne-report-' + t).replace(/-+/g, '-').replace(/-$/, '');
}
function repTeamsCSV(d) { return toCSV(['Team', 'Played', 'Wins', 'Losses', 'Win %'], (d.teams || []).map((x) => [x.team, x.matches, x.wins, x.losses, x.winPct])); }
function repTournamentsCSV(d) { return toCSV(['Tournament', 'Matches', 'Games', 'Teams', 'First played', 'Last played'], (d.perTournament || []).map((t) => [t.tournament, t.matches, t.games, t.teams, anWhen(t.firstAt), anWhen(t.lastAt)])); }
function repTimelineCSV(d) { return toCSV(['Date', 'Matches', 'Games'], (d.timeline || []).map((p) => [p.date, p.matches, p.games])); }
function repMapsCSV(d) { return toCSV(['Map', 'Game', 'Played', 'A wins', 'B wins'], (d.mapStats || []).map((m) => [m.map, m.game_type, m.played, m.aWins, m.bWins])); }
function repPacingCSV(d) {
  const p = d.pacing || {}, m = p.matches || {}, g = p.games || {};
  let csv = toCSV(['Scope', 'Count', 'Avg', 'Median', 'Min', 'Max'], [['Match', m.count, anMmss(m.avg), anMmss(m.median), anMmss(m.min), anMmss(m.max)], ['Game', g.count, anMmss(g.avg), anMmss(g.median), anMmss(g.min), anMmss(g.max)]]);
  csv += '\r\n\r\n' + toCSV(['Match length bucket', 'Count'], (p.histogram || []).map((h) => [h.label, h.count]));
  return csv;
}
function repPlayersCSV(d) {
  const L = d.leaders || { rl: [], cs2: [], val: [] }; const rows = [];
  (L.rl || []).forEach((p) => rows.push(['Rocket League', p.player, p.games, p.goals, p.assists, p.saves, p.shots, p.gpg, p.score, '', '', '']));
  (L.cs2 || []).forEach((p) => rows.push(['CS2', p.player, p.games, '', '', '', '', '', p.score, p.kills, p.deaths, p.kd]));
  (L.val || []).forEach((p) => rows.push(['Valorant', p.player, p.games, '', '', '', '', '', '', p.kills, p.deaths, p.kd]));
  return toCSV(['Game', 'Player', 'GP', 'Goals', 'Assists', 'Saves', 'Shots', 'G/Game', 'Score', 'Kills', 'Deaths', 'K/D'], rows);
}

async function loadReports() {
  const dash = await ensureDashboard();
  const ctxEl = el('rep-context'); if (ctxEl) ctxEl.textContent = reportContext();
  // The recap is built on demand by openPrintableRecap() (Print / Save as PDF) — no inline preview.
  if (!window._repWired) {
    window._repWired = true;
    el('rep-print')?.addEventListener('click', () => openPrintableRecap(_anDash));
    el('rep-refresh')?.addEventListener('click', () => { _anDash = null; _anDashSig = ''; loadReports(); });
  }
  const t = (dash && dash.totals) || {};
  const cards = [
    { title: 'Team standings', desc: anNum(t.teams) + ' teams · win/loss records', actions: [['CSV', () => anDownload(repSlug() + '-teams.csv', repTeamsCSV(dash))], ['JSON', () => anDownload(repSlug() + '-teams.json', JSON.stringify(dash.teams || [], null, 2), 'application/json')]] },
    { title: 'Player leaderboards', desc: 'Per-player stats from streamed matches (RL / CS2 / Valorant)', actions: [['CSV', () => anDownload(repSlug() + '-players.csv', repPlayersCSV(dash))], ['JSON', () => anDownload(repSlug() + '-players.json', JSON.stringify(dash.leaders || {}, null, 2), 'application/json')]] },
    { title: 'Tournament breakdown', desc: anNum(t.tournaments) + ' tournaments · matches / games / teams', actions: [['CSV', () => anDownload(repSlug() + '-tournaments.csv', repTournamentsCSV(dash))]] },
    { title: 'Match pacing', desc: 'Durations + length distribution — for scheduling', actions: [['CSV', () => anDownload(repSlug() + '-pacing.csv', repPacingCSV(dash))]] },
    { title: 'Daily activity', desc: 'Matches & games played per day', actions: [['CSV', () => anDownload(repSlug() + '-activity.csv', repTimelineCSV(dash))]] },
    { title: 'Map / arena split', desc: 'Plays + win split per map', actions: [['CSV', () => anDownload(repSlug() + '-maps.csv', repMapsCSV(dash))]] },
    { title: 'Sponsor proof-of-play', desc: 'Per-broadcast on-screen sponsor exposure (export per report)', actions: [['Open Sponsors →', () => statsShowTab('sponsors')]] },
    { title: 'Broadcast reports', desc: 'Per-show viewer / scene / ad / engagement CSVs', actions: [['Open Broadcasts →', () => statsShowTab('broadcasts')]] }
  ];
  const wrap = el('rep-cards'); if (!wrap) return;
  wrap.innerHTML = cards.map((c, i) => `<div class="rep-card${c.primary ? ' rep-primary' : ''}"><div class="rep-card-t">${escapeHtml(c.title)}</div><div class="rep-card-d">${escapeHtml(c.desc)}</div><div class="rep-card-a">${c.actions.map((a, j) => `<button class="btn ${(c.primary && j === 0) ? 'btn-primary' : 'btn-secondary'} btn-sm" data-rc="${i}" data-ra="${j}">${escapeHtml(a[0])}</button>`).join('')}</div></div>`).join('');
  wrap.querySelectorAll('[data-rc]').forEach((b) => b.addEventListener('click', () => { const c = cards[+b.dataset.rc]; const a = c && c.actions[+b.dataset.ra]; if (a) a[1](); }));
}

const REPORT_PRINT_CSS = `*{box-sizing:border-box;} body{font-family:Arial,Helvetica,sans-serif;color:#141414;margin:26px;background:#fff;}
h1{font-size:22px;margin:0;} h2{font-size:14px;margin:22px 0 8px;border-bottom:2px solid #eee;padding-bottom:4px;text-transform:uppercase;letter-spacing:.04em;color:#333;}
.rep-head{display:flex;align-items:center;gap:14px;border-bottom:3px solid #141414;padding-bottom:12px;margin-bottom:16px;}
.rep-head img{height:42px;} .rep-sub{color:#666;font-size:12px;margin-top:4px;}
.an-kpi{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;}
.an-tile{border:1px solid #ddd;border-radius:8px;padding:10px 12px;background:#fafafa;}
.an-tile-v{font-size:19px;font-weight:800;color:#111;} .an-tile-l{font-size:10px;text-transform:uppercase;color:#777;font-weight:700;margin-top:3px;letter-spacing:.04em;}
.cols2{display:grid;grid-template-columns:1fr 1fr;gap:20px;}
.an-line-wrap,.an-spark-wrap{border:1px solid #ddd;border-radius:8px;padding:8px 10px;background:#fff;}
.an-line{width:100%;height:150px;display:block;} .an-line-head{display:flex;justify-content:space-between;font-size:11px;color:#666;margin-bottom:4px;}
.an-legend-row{display:flex;gap:12px;} .an-leg{display:inline-flex;align-items:center;gap:5px;font-size:11px;} .an-leg i{width:10px;height:10px;border-radius:2px;}
.an-line-ax{display:flex;justify-content:space-between;font-size:10px;color:#888;margin-top:3px;}
.an-bars{display:flex;flex-direction:column;gap:5px;} .an-bar-row{display:grid;grid-template-columns:130px 1fr auto;align-items:center;gap:8px;}
.an-bar-lbl{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;} .an-bar-track{height:9px;background:#eee;border-radius:5px;overflow:hidden;} .an-bar-fill{display:block;height:100%;background:#2a7;} .an-bar-val{font-size:10px;color:#555;white-space:nowrap;}
.an-cols{display:flex;align-items:flex-end;gap:5px;height:130px;border:1px solid #ddd;border-radius:8px;padding:6px;background:#fff;} .an-col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;gap:2px;} .an-col-bar{width:70%;max-width:30px;background:#f5b14a;border-radius:3px 3px 0 0;min-height:2px;} .an-col-v{font-size:9px;} .an-col-l{font-size:8px;color:#888;}
.an-chart-empty{border:1px dashed #ccc;border-radius:8px;padding:18px;text-align:center;color:#888;font-size:12px;}
table{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px;} th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #eee;} th{background:#f3f3f3;font-size:10px;text-transform:uppercase;color:#555;}
.rep-foot{margin-top:20px;color:#888;font-size:11px;border-top:1px solid #eee;padding-top:8px;}
@media print{ body{margin:0;} h2{break-after:avoid;} .an-line-wrap,.an-cols,table,.cols2{break-inside:avoid;} }`;

function buildRecapHtml(dash) {
  dash = dash || _anDash || {};
  const t = dash.totals || {}, pc = dash.pacing || {}, mp = pc.matches || {};
  const tl = dash.timeline || [];
  const span = tl.length ? (tl[0].date + ' → ' + tl[tl.length - 1].date) : '—';
  const teamsTop = (dash.teams || []).slice(0, 10).map((x) => ({ label: x.team.length > 22 ? x.team.slice(0, 22) + '…' : x.team, value: x.wins, sub: x.wins + '-' + x.losses + ' · ' + x.winPct + '%' }));
  const histo = (pc.histogram || []).map((h) => ({ label: h.label, value: h.count }));
  const rl = (dash.leaders && dash.leaders.rl) || [];
  const playerRows = rl.slice(0, 15).map((p, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(p.player)}</td><td>${p.games}</td><td>${p.goals}</td><td>${p.assists}</td><td>${p.saves}</td><td>${p.shots}</td><td>${p.gpg}</td></tr>`).join('') || '<tr><td colspan="8">No player stats in range.</td></tr>';
  const tourRows = (dash.perTournament || []).slice(0, 20).map((x) => `<tr><td>${escapeHtml(x.tournament)}</td><td>${x.matches}</td><td>${x.games}</td><td>${x.teams}</td><td>${escapeHtml(anWhen(x.lastAt))}</td></tr>`).join('') || '<tr><td colspan="5">No tournaments in range.</td></tr>';
  const brand = (typeof currentState !== 'undefined' && currentState.brand) || {};
  const logo = brand.logo ? `<img src="${brand.logo}" alt="">` : '';
  const title = (brand.name || 'Broadcast Studio') + ' — Production Report';
  const kpis = anKpiInner([
    { l: 'Matches', v: anNum(t.matches) }, { l: 'Games', v: anNum(t.games) }, { l: 'Teams', v: anNum(t.teams) }, { l: 'Tournaments', v: anNum(t.tournaments) },
    { l: 'Avg match', v: mp.count ? anMmss(mp.avg) : '—' }, { l: 'Median match', v: mp.count ? anMmss(mp.median) : '—' }, { l: 'Longest match', v: mp.count ? anMmss(mp.max) : '—' }, { l: 'Players tracked', v: anNum(rl.length) }
  ]);
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${REPORT_PRINT_CSS}</style></head><body>
    <div class="rep-head">${logo}<div><h1>${escapeHtml(title)}</h1><div class="rep-sub">${escapeHtml(reportContext())} · ${escapeHtml(span)} · generated ${escapeHtml(new Date().toLocaleString())}</div></div></div>
    <div class="an-kpi">${kpis}</div>
    <h2>Activity over time</h2>${anLineChart(tl, [{ key: 'matches', color: '#1e88c7', label: 'Matches' }, { key: 'games', color: '#7c4dff', label: 'Games' }])}
    <div class="cols2" style="margin-top:14px;">
      <div><h2>Top teams (by wins)</h2>${anBars(teamsTop, '#2a9d5b')}</div>
      <div><h2>Match length distribution</h2>${histo.length ? anColumns(histo, '#f0a83a') : '<div class="an-chart-empty">No completed matches in range.</div>'}</div>
    </div>
    <h2>Top players</h2><table><thead><tr><th>#</th><th>Player</th><th>GP</th><th>Goals</th><th>Assists</th><th>Saves</th><th>Shots</th><th>G/Game</th></tr></thead><tbody>${playerRows}</tbody></table>
    <h2>Tournaments</h2><table><thead><tr><th>Tournament</th><th>Matches</th><th>Games</th><th>Teams</th><th>Last played</th></tr></thead><tbody>${tourRows}</tbody></table>
    <div class="rep-foot">Generated by Broadcast Studio · ${escapeHtml(reportContext())}. Match results from start.gg; player stats from live-streamed series.</div>
  </body></html>`;
  return html;
}
// Render the same recap into the on-page A4 preview iframe.
function renderRecapPreview(dash) {
  const frame = el('rep-preview-frame'); if (!frame) return;
  try {
    const doc = frame.contentWindow.document; doc.open(); doc.write(buildRecapHtml(dash)); doc.close();
    setTimeout(() => { try { const h = (doc.body && doc.body.scrollHeight) || 0; if (h) frame.style.height = (h + 24) + 'px'; } catch (e) {} }, 150);
  } catch (e) {}
}
function openPrintableRecap(dash) {
  const html = buildRecapHtml(dash);
  // Electron can't reliably print a renderer iframe ("this app doesn't support print preview") and
  // its native dialog has no preview pane, so route to the main process in 'pdf' mode: render the
  // report offscreen → PDF → Save dialog → open the saved PDF. No intermediate webpage or dialog.
  if (window.electronAPI && typeof window.electronAPI.printReport === 'function') {
    if (typeof showToast === 'function') showToast('Generating report PDF…', '#22c55e', 4000);
    window.electronAPI.printReport(html, 'pdf').then((res) => {
      if (res && res.saved && typeof showToast === 'function') showToast('Saved & opened PDF', '#22c55e', 4000);
      else if (res && res.ok === false && !res.canceled && typeof showToast === 'function') showToast('Could not save PDF' + (res.error ? ': ' + res.error : ''), '#c53030', 6000);
    }).catch((e) => { if (typeof showToast === 'function') showToast('PDF failed: ' + (e && e.message), '#c53030', 5000); });
    return;
  }
  // Browser fallback: print via a hidden iframe.
  let frame = document.getElementById('rep-print-frame');
  if (frame) frame.remove();
  frame = document.createElement('iframe');
  frame.id = 'rep-print-frame';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:900px;height:1200px;border:0;';
  document.body.appendChild(frame);
  const doPrint = () => { try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch (e) {} };
  frame.onload = () => setTimeout(doPrint, 250);   // give images/fonts a beat to paint
  const doc = frame.contentWindow.document;
  doc.open(); doc.write(html); doc.close();
  if (typeof showToast === 'function') showToast('Opening print dialog…', '#22c55e');
}

function statTable(cols, rows, rowFn) {
  return `<table class="stats-table"><thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.map(rowFn).join('') || `<tr><td colspan="${cols.length}" class="stats-empty">No data yet — broadcast some games first.</td></tr>`}</tbody></table>`;
}

// ── Sponsor proof-of-play ───────────────────────────────────────────────────
const ADPROOF_API = 'http://127.0.0.1:3000/api/adproof';
const ADPROOF_SPOTS = ['rail', 'desk', 'overtime', 'replayGoal', 'replayOutro', 'scoreboard', 'banner', 'ticker'];
const ADPROOF_SPOT_LABEL = { rail: 'Rail', desk: 'Desk', overtime: 'OT', replayGoal: 'Replay', replayOutro: 'Outro', scoreboard: 'Score', banner: 'Banner', ticker: 'Ticker' };
let _adProofReport = null;
function adProofMmss(s) { s = Math.max(0, Math.round(s || 0)); const m = Math.floor(s / 60); return m + ':' + String(s % 60).padStart(2, '0'); }
function adProofPlacementStr(byPlacement) {
  const parts = ADPROOF_SPOTS.filter((k) => byPlacement && byPlacement[k]).map((k) => ADPROOF_SPOT_LABEL[k] + ' ' + adProofMmss(byPlacement[k]));
  return parts.join(' · ') || '—';
}
function adProofUsd(n) { return (n == null) ? '—' : '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
async function loadAdProof() {
  try { _adProofReport = await (await fetch(ADPROOF_API)).json(); }
  catch (e) { _adProofReport = null; }
  renderAdProof(_adProofReport);
}
function renderAdProof(rep) {
  rep = rep || { active: false, sponsors: [], sessions: [], durationSec: 0 };
  const startBtn = el('app-start'), stopBtn = el('app-stop'), live = el('app-live'), liveTx = el('app-live-tx');
  if (startBtn) startBtn.style.display = rep.active ? 'none' : '';
  if (stopBtn) stopBtn.style.display = rep.active ? '' : 'none';
  if (live) live.style.display = rep.active ? 'inline-flex' : 'none';
  if (liveTx && rep.active) liveTx.textContent = 'Recording · ' + adProofMmss(rep.durationSec) + (rep.label ? ' · ' + rep.label : '');

  // Live / current session table
  const cur = el('app-current');
  if (cur) {
    const sponsors = rep.sponsors || [];
    if (!rep.active && !sponsors.length) {
      cur.innerHTML = '<p class="section-desc" style="margin:0;">No active session. Start one when you go live to begin logging sponsor exposure.</p>';
    } else {
      // $ columns only appear once at least one sponsor has a deal value / target CPM set
      // (Brand Kits → sponsor editor) — stays out of the way for producers who don't track $.
      const hasMoney = sponsors.some((s) => s.dealValue != null || s.targetCpm != null);
      const rows = sponsors.map((s) => `<tr>
        <td class="st-name">${escapeHtml(s.name || '(unnamed)')}</td>
        <td class="st-hi">${adProofMmss(s.seconds)}</td>
        <td>${s.impressions || 0}</td>
        <td class="st-hi" title="Estimated impressions = concurrent viewers x on-screen seconds">${anNum(s.viewerSeconds || 0)}</td>
        <td>${anNum(s.avgViewers || 0)}</td>
        <td>${anNum(s.peakViewers || 0)}</td>
        ${hasMoney ? `<td class="st-hi" title="What this sponsor paid for the deal">${adProofUsd(s.dealValue)}</td>
        <td title="What they effectively paid per 1000 impression-seconds delivered">${s.realizedCpm != null ? adProofUsd(s.realizedCpm) : '—'}</td>
        <td class="st-hi" title="$ value of the exposure delivered, at their agreed/market CPM">${s.valueDelivered != null ? adProofUsd(s.valueDelivered) : '—'}${s.deliveryPct != null ? ` <span style="color:${s.deliveryPct >= 100 ? '#7ef0b0' : '#f3b45f'};">(${s.deliveryPct}%)</span>` : ''}</td>` : ''}
        <td class="app-place">${escapeHtml(adProofPlacementStr(s.byPlacement))}</td></tr>`).join('')
        || `<tr><td colspan="${hasMoney ? 10 : 7}" class="stats-empty">No sponsor exposure logged yet${rep.active ? ' — make sure a brand kit with sponsors is active.' : '.'}</td></tr>`;
      const moneySummary = (rep.totalDealValue != null || rep.totalValueDelivered != null)
        ? ` · <span title="Sum of every sponsor's deal value / value delivered this session">${adProofUsd(rep.totalDealValue)} sold · ${adProofUsd(rep.totalValueDelivered)} delivered</span>` : '';
      const head = `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
          <span class="app-cur-lbl">${rep.active ? 'Current session' : 'Last session (unsaved)'} · ${adProofMmss(rep.durationSec)}${rep.label ? ' · ' + escapeHtml(rep.label) : ''}${moneySummary}</span>
          <span style="display:flex;gap:6px;">
            <button class="btn btn-secondary btn-sm" id="app-exp-csv">Export CSV</button>
            <button class="btn btn-secondary btn-sm" id="app-exp-json">Export JSON</button>
          </span></div>`;
      cur.innerHTML = head + `<table class="stats-table"><thead><tr><th>Sponsor</th><th>On screen</th><th>Spots</th><th>Est. impressions</th><th>Avg CCV</th><th>Peak</th>${hasMoney ? '<th>Deal $</th><th>Realized CPM</th><th>Value delivered</th>' : ''}<th>Placements</th></tr></thead><tbody>${rows}</tbody></table>`
        + `<p class="section-desc" style="margin-top:6px;font-size:11px;">Estimated exposure inferred from live overlay state. "On screen" de-duplicates time across placements; "Spots" = distinct appearances. "Est. impressions" = viewer-seconds (concurrent Twitch+YouTube viewers x seconds on screen).${hasMoney ? ' "Value delivered" = impression-seconds valued at the sponsor\'s target CPM (set in Brand Kits); the % compares it to what they paid.' : ''}</p>`;
      el('app-exp-csv')?.addEventListener('click', () => adProofExport('current', 'csv'));
      el('app-exp-json')?.addEventListener('click', () => adProofExport('current', 'json'));
    }
  }

  // Saved sessions
  const sess = el('app-sessions');
  if (sess) {
    const list = rep.sessions || [];
    if (!list.length) { sess.innerHTML = '<p class="section-desc" style="margin:0;">No saved reports yet.</p>'; }
    else {
      sess.innerHTML = `<div style="display:flex;justify-content:flex-end;margin-bottom:6px;"><button class="btn btn-danger btn-sm" id="app-clear-all">Clear all reports</button></div>` + list.map((s) => {
        const when = s.endedAt ? new Date(s.endedAt).toLocaleString() : '';
        return `<div class="app-sess">
          <div class="app-sess-main"><span class="app-sess-lbl">${escapeHtml(s.label || 'Broadcast')}</span>
            <span class="app-sess-meta">${adProofMmss(s.durationSec)} · ${s.sponsorCount || 0} sponsors${s.totalValueDelivered != null ? ` · ${adProofUsd(s.totalValueDelivered)} delivered` : ''} · ${escapeHtml(when)}</span></div>
          <div class="app-sess-act">
            <button class="btn btn-secondary btn-sm" data-app-csv="${s.id}">CSV</button>
            <button class="btn btn-secondary btn-sm" data-app-json="${s.id}">JSON</button>
            <button class="btn btn-danger btn-sm" data-app-del="${s.id}">Delete</button>
          </div></div>`;
      }).join('');
      sess.querySelectorAll('[data-app-csv]').forEach((b) => b.addEventListener('click', () => adProofExport(b.dataset.appCsv, 'csv')));
      sess.querySelectorAll('[data-app-json]').forEach((b) => b.addEventListener('click', () => adProofExport(b.dataset.appJson, 'json')));
      sess.querySelectorAll('[data-app-del]').forEach((b) => b.addEventListener('click', async () => {
        if (!(await appConfirm('Delete this saved report?', 'Delete'))) return;
        try { const r = await (await fetch(ADPROOF_API + '/session/' + b.dataset.appDel, { method: 'DELETE' })).json(); _adProofReport = r.report; renderAdProof(r.report); } catch (e) {}
      }));
      el('app-clear-all')?.addEventListener('click', async () => {
        if (!(await appConfirm('Delete ALL saved sponsor reports? This cannot be undone.', 'Delete'))) return;
        try { const r = await (await fetch(ADPROOF_API + '/sessions', { method: 'DELETE' })).json(); _adProofReport = r.report; renderAdProof(r.report); } catch (e) {}
      });
    }
  }
}
function adProofExport(session, format) {
  anFetchDownload(ADPROOF_API + '/export?session=' + encodeURIComponent(session) + '&format=' + format, 'proof-of-play.' + format, format === 'json' ? 'application/json' : 'text/csv;charset=utf-8');
}
async function adProofStartSession() {
  const label = (el('app-label')?.value || '').trim();
  try { const r = await (await fetch(ADPROOF_API + '/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) })).json(); _adProofReport = r.report; renderAdProof(r.report); } catch (e) {}
}
async function adProofStopSession() {
  try { const r = await (await fetch(ADPROOF_API + '/stop', { method: 'POST' })).json(); _adProofReport = r.report; renderAdProof(r.report); } catch (e) {}
}
el('app-start')?.addEventListener('click', adProofStartSession);
el('app-stop')?.addEventListener('click', adProofStopSession);
function _delPlayerCol(v, r) { return '<button class="stats-del-row" data-del-player="' + escapeHtml(r.player) + '" title="Delete this player from the leaderboards">✕</button>'; }
document.addEventListener('click', async (e) => {
  const dt = e.target.closest && e.target.closest('[data-del-team]');
  if (dt) { const name = dt.dataset.delTeam; if (!(await appConfirm('Delete "' + name + '" — remove every match this team appears in? (affects both teams in those matches)', 'Delete'))) return; try { await fetch('http://127.0.0.1:3000/api/stats/team/' + encodeURIComponent(name), { method: 'DELETE' }); } catch (_) {} _anDash = null; _anDashSig = ''; if (typeof loadStatsTeams === 'function') loadStatsTeams(); return; }
  const dp = e.target.closest && e.target.closest('[data-del-player]');
  if (dp) { const name = dp.dataset.delPlayer; if (!(await appConfirm('Delete player "' + name + '" from the leaderboards?', 'Delete'))) return; try { await fetch('http://127.0.0.1:3000/api/stats/player/' + encodeURIComponent(name), { method: 'DELETE' }); } catch (_) {} _anDash = null; _anDashSig = ''; if (typeof loadStatsLeaders === 'function') loadStatsLeaders(); return; }
  const tc = e.target.closest && e.target.closest('#teams-clear-all');
  if (tc) { if (!(await appConfirm('Clear ALL match history? Wipes every team & player record for fresh reporting.', 'Clear'))) return; try { await fetch('http://127.0.0.1:3000/api/stats/matches', { method: 'DELETE' }); } catch (_) {} _anDash = null; _anDashSig = ''; if (typeof loadStatsTeams === 'function') loadStatsTeams(); return; }
});
async function loadStatsLeaders() {
  const wrap = el('stats-leaders'); if (!wrap) return;
  if (!window._pdbClearWired) { window._pdbClearWired = true; el('stats-clear-playerdb')?.addEventListener('click', async () => { if (!(await appConfirm('Clear the ENTIRE player database? This wipes saved rank/profile links for fresh reporting.', 'Clear'))) return; try { await fetch('http://127.0.0.1:3000/api/playerdb', { method: 'DELETE' }); if (typeof showToast === 'function') showToast('Player database cleared', '#22c55e'); } catch (e) {} loadStatsLeaders(); }); }
  const dash = await ensureDashboard();
  const L = (dash && dash.leaders) || { rl: [], cs2: [], val: [] };
  let html = '', gh = '';
  const _pClip = (n) => { n = n || '—'; return n.length > 16 ? n.slice(0, 16) + '…' : n; };
  if (L.rl.length) {
    const top = L.rl.slice().sort((a, b) => (b.goals || 0) - (a.goals || 0)).slice(0, 8).map((p) => ({ label: _pClip(p.player), value: p.goals || 0, sub: (p.goals || 0) + 'G · ' + (p.assists || 0) + 'A · ' + (p.saves || 0) + 'S' }));
    gh += '<h4 class="stats-sub" style="margin-top:0;">Top scorers — Rocket League</h4>' + anBars(top, '#22c3e6');
    html += '<h4 class="stats-sub" style="margin-top:18px;">RL leaderboard <span class="section-desc" style="font-weight:600;">(click a column to sort)</span></h4><div id="ld-rl"></div>';
  }
  if (L.cs2.length) {
    const top = L.cs2.slice().sort((a, b) => (b.kills || 0) - (a.kills || 0)).slice(0, 8).map((p) => ({ label: _pClip(p.player), value: p.kills || 0, sub: (p.kills || 0) + 'K · ' + (p.kd || 0) + ' K/D' }));
    gh += '<h4 class="stats-sub" style="margin-top:18px;">Top fraggers — CS2</h4>' + anBars(top, '#f5b14a');
    html += '<h4 class="stats-sub" style="margin-top:12px;">CS2 leaderboard</h4><div id="ld-cs2"></div>';
  }
  if (L.val.length) {
    const top = L.val.slice().sort((a, b) => (b.kills || 0) - (a.kills || 0)).slice(0, 8).map((p) => ({ label: _pClip(p.player), value: p.kills || 0, sub: (p.kills || 0) + 'K · ' + (p.kd || 0) + ' K/D' }));
    gh += '<h4 class="stats-sub" style="margin-top:18px;">Top fraggers — Valorant</h4>' + anBars(top, '#f472b6');
    html += '<h4 class="stats-sub" style="margin-top:12px;">Valorant leaderboard</h4><div id="ld-val"></div>';
  }
  if (!html) html = '<p class="section-desc">No player stats in this range. Player lines come from live game integrations — start.gg history (most of your matches) has results but no per-player stats.</p>';
  // Tiles: only the games that have players (a "0 CS2 players" tile is noise), then the leaders.
  const _tiles = [];
  if (L.rl.length) _tiles.push({ l: 'Rocket League players', v: anNum(L.rl.length) });
  if (L.cs2.length) _tiles.push({ l: 'CS2 players', v: anNum(L.cs2.length) });
  if (L.val.length) _tiles.push({ l: 'Valorant players', v: anNum(L.val.length) });
  const _topRl = L.rl.slice().sort((a, b) => (b.goals || 0) - (a.goals || 0))[0];
  const _topCs = L.cs2.slice().sort((a, b) => (b.kills || 0) - (a.kills || 0))[0];
  if (_topRl) _tiles.push({ l: 'Top scorer · ' + anNum(_topRl.goals || 0) + ' goals', v: _pClip(_topRl.player) });
  if (_topCs) _tiles.push({ l: 'Top fragger · ' + anNum(_topCs.kills || 0) + ' kills', v: _pClip(_topCs.player) });
  if (!_tiles.length) _tiles.push({ l: 'Players with stats', v: '0' });
  const _pk = el('stats-players-kpi'); if (_pk) _pk.innerHTML = anKpiInner(_tiles.slice(0, 4));
  // Charts as cards with PNG / SVG / CSV export (an-charts.js), falling back to the plain bars.
  const _pg = el('stats-players-graphs');
  if (_pg && window.AnChart) {
    const A = window.AnChart, cards = [];
    const lead = (list, key, title, sub, id, color, csvHead, csvRow) => {
      const top = list.slice().sort((a, b) => (b[key] || 0) - (a[key] || 0)).slice(0, 10);
      cards.push(A.card({ id, wide: true, title, sub,
        body: A.hbars(top.map((p) => { const r = csvRow(p); return { label: _pClip(p.player), value: p[key] || 0, sub: r[r.length - 1] }; }), { color }),
        csv: { name: id + '.csv', headers: csvHead, rows: list.map((p) => csvRow(p).slice(0, -1)) } }));
    };
    if (L.rl.length) lead(L.rl, 'goals', 'Top scorers: Rocket League', 'goals, with assists and saves', 'players-rl', '#22c3e6',
      ['Player', 'Games', 'Goals', 'Assists', 'Saves', 'Shots'], (p) => [p.player, p.games || 0, p.goals || 0, p.assists || 0, p.saves || 0, p.shots || 0, (p.goals || 0) + 'G · ' + (p.assists || 0) + 'A · ' + (p.saves || 0) + 'S']);
    if (L.cs2.length) lead(L.cs2, 'kills', 'Top fraggers: CS2', 'kills, with K/D', 'players-cs2', '#f5b14a',
      ['Player', 'Games', 'Kills', 'Deaths', 'K/D'], (p) => [p.player, p.games || 0, p.kills || 0, p.deaths || 0, p.kd || 0, (p.kills || 0) + 'K · ' + (p.kd || 0) + ' K/D']);
    if (L.val.length) lead(L.val, 'kills', 'Top fraggers: Valorant', 'kills, with K/D', 'players-val', '#f472b6',
      ['Player', 'Games', 'Kills', 'Deaths', 'K/D'], (p) => [p.player, p.games || 0, p.kills || 0, p.deaths || 0, p.kd || 0, (p.kills || 0) + 'K · ' + (p.kd || 0) + ' K/D']);
    _pg.innerHTML = cards.length ? '<div class="anx-grid">' + cards.join('') + '</div>' : '<p class="section-desc" style="margin:0;">No player stats in this range yet.</p>';
  } else if (_pg) _pg.innerHTML = gh || '<p class="section-desc" style="margin:0;">No player stats in this range yet.</p>';
  wrap.innerHTML = html;
  if (L.rl.length) anSortable('ld-rl', 'ld-rl-t', [
    { key: 'player', label: 'Player' }, { key: 'games', label: 'GP', num: true }, { key: 'goals', label: 'Goals', num: true }, { key: 'assists', label: 'Assists', num: true },
    { key: 'saves', label: 'Saves', num: true }, { key: 'shots', label: 'Shots', num: true }, { key: 'gpg', label: 'G/Game', num: true }, { key: 'score', label: 'Score', num: true }, { key: '_del', label: '', fmt: _delPlayerCol }
  ], L.rl, 'goals', -1);
  if (L.cs2.length) anSortable('ld-cs2', 'ld-cs2-t', [
    { key: 'player', label: 'Player' }, { key: 'games', label: 'GP', num: true }, { key: 'kills', label: 'K', num: true }, { key: 'deaths', label: 'D', num: true },
    { key: 'assists', label: 'A', num: true }, { key: 'kd', label: 'K/D', num: true }, { key: 'hs', label: 'HS', num: true }, { key: 'mvps', label: 'MVP', num: true }, { key: '_del', label: '', fmt: _delPlayerCol }
  ], L.cs2, 'kills', -1);
  if (L.val.length) anSortable('ld-val', 'ld-val-t', [
    { key: 'player', label: 'Player' }, { key: 'agent', label: 'Agent' }, { key: 'games', label: 'GP', num: true }, { key: 'kills', label: 'K', num: true },
    { key: 'deaths', label: 'D', num: true }, { key: 'assists', label: 'A', num: true }, { key: 'kd', label: 'K/D', num: true }, { key: '_del', label: '', fmt: _delPlayerCol }
  ], L.val, 'kills', -1);
}
// ── Cross-game player profile ──
let _statsPlayerListLoaded = false;
async function loadStatsPlayerList() {
  if (_statsPlayerListLoaded) return;
  try {
    const d = await (await fetch(`${STATS_API}/player-list`)).json();
    const dl = el('stats-player-datalist');
    if (dl) dl.innerHTML = (d.players || []).map((p) => `<option value="${String(p.player).replace(/"/g, '&quot;')}">${p.titles.join(', ')}</option>`).join('');
    _statsPlayerListLoaded = true;
  } catch (e) { /* picker is a convenience; manual entry still works */ }
}
const GAME_LABELS = { rl: 'Rocket League', cs2: 'CS2', valorant: 'Valorant' };
async function loadStatsProfile() {
  const name = (el('stats-profile-name')?.value || '').trim();
  const wrap = el('stats-profile-result'); if (!wrap) return;
  if (!name) { wrap.innerHTML = '<p class="section-desc">Enter a player name.</p>'; return; }
  wrap.innerHTML = '<p class="section-desc">Loading…</p>';
  try {
    const res = await fetch(`${STATS_API}/profile?name=${encodeURIComponent(name)}`);
    if (res.status === 404) { wrap.innerHTML = '<p class="section-desc">No recorded games for that player yet.</p>'; return; }
    const { profile: p } = await res.json();
    const esc = (s) => String(s || '').replace(/</g, '&lt;');
    const t = p.totals;
    const teams = p.teams.map((x) => esc(x.team)).join(' · ') || '—';
    const badges = p.gamesPlayed.map((g) => `<span class="prof-badge">${GAME_LABELS[g] || g}</span>`).join(' ');
    let cards = '';
    if (p.titles.rl) { const r = p.titles.rl; cards += profCard('Rocket League', r.winPct, r.wins, r.losses, [['Games', r.games], ['Goals', r.goals], ['GPG', r.gpg], ['Assists', r.assists], ['Saves', r.saves], ['Shots', r.shots]]); }
    if (p.titles.cs2) { const c = p.titles.cs2; cards += profCard('CS2', c.winPct, c.wins, c.losses, [['Games', c.games], ['Kills', c.kills], ['Deaths', c.deaths], ['K/D', c.kd], ['HS %', c.hsPct + '%'], ['MVPs', c.mvps]]); }
    if (p.titles.valorant) { const v = p.titles.valorant; cards += profCard('Valorant', v.winPct, v.wins, v.losses, [['Games', v.games], ['Kills', v.kills], ['Deaths', v.deaths], ['K/D', v.kd], ['Assists', v.assists], ['Top Agent', esc(v.topAgent) || '—']]); }
    const tl = (p.timeline || []).map((g) => {
      const date = g.game_at ? new Date(g.game_at).toLocaleDateString() : '';
      const res = g.won === true ? '<span class="prof-w">W</span>' : g.won === false ? '<span class="prof-l">L</span>' : '<span class="prof-d">–</span>';
      let line = '';
      if (g.game_type === 'rl') line = `${g.line.goals}G ${g.line.assists}A ${g.line.saves}Sv`;
      else if (g.game_type === 'cs2') line = `${g.line.kills}/${g.line.deaths}/${g.line.assists}`;
      else if (g.game_type === 'valorant') line = `${esc(g.line.agent)} · ${g.line.kills}/${g.line.deaths}/${g.line.assists}`;
      return `<tr><td>${date}</td><td>${GAME_LABELS[g.game_type] || g.game_type}</td><td>${g.map ? esc(g.map) : '—'}</td><td>${esc(g.team_a)} vs ${esc(g.team_b)}</td><td>${line}</td><td style="text-align:center;">${res}</td></tr>`;
    }).join('');
    wrap.innerHTML = `
      <div class="prof-header">
        <div class="prof-name">${esc(p.player)} ${badges}</div>
        <div class="prof-overall">${t.wins}–${t.losses} <span class="prof-pct">(${t.winPct}% across ${t.games} games)</span></div>
        <div class="section-desc" style="margin-top:2px;">Teams: ${teams}</div>
      </div>
      <div class="prof-cards">${cards}</div>
      <h4 class="stats-sub" style="margin-top:18px;">Recent games</h4>
      ${statTable(['Date', 'Title', 'Map', 'Match', 'Line', 'Result'], p.timeline || [], () => '').replace(/<tbody>.*<\/tbody>/s, `<tbody>${tl || '<tr><td colspan="6" class="stats-empty">No games.</td></tr>'}</tbody>`)}`;
  } catch (e) { wrap.innerHTML = `<p style="color:#f56565;">Error: ${e.message}</p>`; }
}
function profCard(title, winPct, wins, losses, rows) {
  return `<div class="prof-card">
    <div class="prof-card-title">${title}</div>
    <div class="prof-card-wl">${winPct}% <span>${wins}W ${losses}L</span></div>
    <div class="prof-card-grid">${rows.map(([k, v]) => `<div><span class="pk">${k}</span><span class="pv">${v}</span></div>`).join('')}</div>
  </div>`;
}
// Names that are slots, not teams ("Placeholder", "TBD", "Team A"...): kept in the table, left out of
// the charts and headline numbers so they never rank as a real team.
const AN_PLACEHOLDER_TEAM = /^(placeholder|tbd|tba|bye|unknown|n\/a|team ?[ab12]|blue|orange|team (blue|orange))$/i;
async function loadStatsTeams() {
  const dash = await ensureDashboard();
  const allTeams = (dash && dash.teams) || [];
  const teams = allTeams.filter((x) => x && x.team && !AN_PLACEHOLDER_TEAM.test(String(x.team).trim()));
  const kpi = el('stats-teams-kpi'), g = el('stats-teams-graphs');
  if (kpi) {
    const played = teams.filter((x) => x.matches > 0);
    const avgWin = played.length ? Math.round(played.reduce((a, x) => a + (x.winPct || 0), 0) / played.length) : 0;
    const most = teams.slice().sort((a, b) => (b.wins || 0) - (a.wins || 0))[0];
    const matches = played.reduce((a, x) => a + (x.matches || 0), 0) / 2;
    const best = played.filter((x) => x.matches >= 5).sort((a, b) => { const w = (x) => { const n = (x.wins || 0) + (x.losses || 0); if (!n) return 0; const p = x.wins / n; return (p + 1.92 / n - 1.96 * Math.sqrt((p * (1 - p) + 0.96 / n) / n)) / (1 + 3.84 / n); }; return w(b) - w(a); })[0];
    const clip = (n) => (n.length > 16 ? n.slice(0, 16) + '…' : n);
    kpi.innerHTML = anKpiInner([
      { l: 'Teams with a result', v: anNum(played.length) }, { l: 'Matches recorded', v: anNum(Math.round(matches)) },
      { l: 'Most wins · ' + (most ? most.wins + '-' + most.losses : ''), v: most ? clip(most.team) : '—' },
      { l: 'Best win rate (5+) · ' + (best ? best.winPct + '%' : ''), v: best ? clip(best.team) : '—' }
    ]);
  }
  if (g) {
    // Ranked by the Wilson lower bound: a 17-0 team outranks a 6-0 one, which raw win % ties.
    const wilson = (x) => { const n = (x.wins || 0) + (x.losses || 0); if (!n) return 0; const p = x.wins / n, z = 1.96; return (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n); };
    const winBars = teams.filter((x) => x.matches >= 5).sort((a, b) => wilson(b) - wilson(a)).slice(0, 12).map((x) => ({ label: x.team.length > 18 ? x.team.slice(0, 18) + '…' : x.team, value: x.winPct, sub: x.winPct + '% (' + x.wins + '-' + x.losses + ')' }));
    const wonBars = teams.slice().sort((a, b) => (b.wins || 0) - (a.wins || 0)).slice(0, 12).map((x) => ({ label: x.team.length > 18 ? x.team.slice(0, 18) + '…' : x.team, value: x.wins, sub: x.wins + '-' + x.losses }));
    if (window.AnChart) {
      const A = window.AnChart;
      const csv = { headers: ['Team', 'Played', 'Wins', 'Losses', 'Win %'], rows: teams.filter((x) => x.matches > 0).map((x) => [x.team, x.matches, x.wins, x.losses, x.winPct]) };
      g.innerHTML = '<div class="anx-grid">'
        + A.card({ id: 'teams-winrate', title: 'Best win rate', sub: '5+ matches, weighted for how many they played', body: winBars.length ? A.hbars(winBars, { color: '#22e06a', width: 470 }) : '<div class="anc-empty">No team has played 5 matches yet.</div>', csv: Object.assign({ name: 'team-records.csv' }, csv) })
        + A.card({ id: 'teams-wins', title: 'Most wins', sub: 'wins and losses', body: wonBars.length ? A.hbars(wonBars, { color: '#22c3e6', width: 470 }) : '<div class="anc-empty">No results yet.</div>', csv: Object.assign({ name: 'team-records.csv' }, csv) })
        + '</div>';
    } else {
      g.innerHTML = '<div class="an-2col"><div><h4 class="stats-sub" style="margin-top:0;">Best win rate (5+ matches)</h4>' + (winBars.length ? anBars(winBars, '#22e06a') : '<p class="section-desc" style="margin:0;">No teams with 5+ matches.</p>') + '</div><div><h4 class="stats-sub" style="margin-top:0;">Most wins</h4>' + (wonBars.length ? anBars(wonBars, '#22c3e6') : '<p class="section-desc" style="margin:0;">No teams yet.</p>') + '</div></div>';
    }
  }
  if (el('stats-teams')) anSortable('stats-teams', 'teams-tbl', [
    { key: 'team', label: 'Team' }, { key: 'matches', label: 'Played', num: true }, { key: 'wins', label: 'W', num: true }, { key: 'losses', label: 'L', num: true }, { key: 'winPct', label: 'Win %', num: true, fmt: (v) => v + '%' },
    { key: '_del', label: '', fmt: (v, r) => `<button class="stats-del-row" data-del-team="${escapeHtml(r.team)}" title="Delete this team's matches">✕</button>` }
  ], allTeams, 'wins', -1);
}
async function loadStatsH2H() {
  const a = (el('stats-h2h-a')?.value || '').trim(), b = (el('stats-h2h-b')?.value || '').trim();
  const wrap = el('stats-h2h-result'); if (!wrap) return;
  if (!a || !b) { wrap.innerHTML = '<p class="section-desc">Enter two team names.</p>'; return; }
  wrap.innerHTML = '<p class="section-desc">Loading…</p>';
  try {
    const d = await (await fetch(`${STATS_API}/h2h?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`)).json();
    const esc = (s) => String(s || '').replace(/</g, '&lt;');
    const total = d.aWins + d.bWins;
    const head = `<div class="h2h-score"><span class="h2h-team">${esc(d.a)}</span><span class="h2h-num">${d.aWins}</span><span class="h2h-dash">—</span><span class="h2h-num">${d.bWins}</span><span class="h2h-team">${esc(d.b)}</span></div>
      <div class="section-desc" style="text-align:center;margin-bottom:12px;">${total} completed match${total === 1 ? '' : 'es'}</div>`;
    const rows = (d.matches || []).map((m) => `<tr><td>${m.team_a ? esc(m.team_a) : ''} ${m.score_a ?? ''}–${m.score_b ?? ''} ${m.team_b ? esc(m.team_b) : ''}</td><td>${m.tournament ? esc(m.tournament) : '—'}</td><td>${m.started_at ? new Date(m.started_at).toLocaleDateString() : ''}</td></tr>`).join('');
    wrap.innerHTML = head + statTable(['Match', 'Event', 'Date'], d.matches || [], () => '').replace(/<tbody>.*<\/tbody>/s, `<tbody>${rows || '<tr><td colspan="3" class="stats-empty">No matches between these teams.</td></tr>'}</tbody>`);
  } catch (e) { wrap.innerHTML = `<p style="color:#f56565;">Error: ${e.message}</p>`; }
}
document.querySelectorAll('#stats-subnav .ev-subnav-btn').forEach((b) => b.addEventListener('click', () => statsShowTab(b.dataset.stab)));
document.querySelectorAll('#teams-subnav .ev-subnav-btn').forEach((b) => b.addEventListener('click', () => { document.querySelectorAll('#teams-subnav .ev-subnav-btn').forEach((x) => x.classList.toggle('active', x === b)); const w = b.dataset.tsub, gp = el('teams-sub-graphs'), dp = el('teams-sub-data'); if (gp) gp.style.display = w === 'graphs' ? '' : 'none'; if (dp) dp.style.display = w === 'data' ? '' : 'none'; }));
document.querySelectorAll('#players-subnav .ev-subnav-btn').forEach((b) => b.addEventListener('click', () => { document.querySelectorAll('#players-subnav .ev-subnav-btn').forEach((x) => x.classList.toggle('active', x === b)); const w = b.dataset.psub, gp = el('players-sub-graphs'), dp = el('players-sub-data'); if (gp) gp.style.display = w === 'graphs' ? '' : 'none'; if (dp) dp.style.display = w === 'data' ? '' : 'none'; }));
el('sgi-go')?.addEventListener('click', startggImportGo);
// Global filter bar
document.querySelectorAll('#an-fb-range button').forEach((b) => b.addEventListener('click', () => { anApplyRangePreset(b.dataset.range); if (b.dataset.range !== 'custom') anOnFilterChange(); }));
el('an-fb-from')?.addEventListener('change', () => { anApplyRangePreset('custom'); anOnFilterChange(); });
el('an-fb-to')?.addEventListener('change', () => { anApplyRangePreset('custom'); anOnFilterChange(); });
el('an-fb-game')?.addEventListener('change', (e) => { _anFilter.game = e.target.value; anOnFilterChange(); });
el('an-fb-tourn')?.addEventListener('change', (e) => { _anFilter.tournament = e.target.value; anOnFilterChange(); });
// Real-time auto-refresh while the Analytics page is open (self-gates on active tab).
function anStartAutoRefresh() {
  if (_anRefreshTimer) return;
  _anRefreshTimer = setInterval(() => {
    if (el('tab-stats-content')?.classList.contains('active')) { _anDash = null; _anDashSig = ''; refreshActiveAnalyticsTab(true); }
  }, 30000);
}
el('tws-refresh')?.addEventListener('click', () => loadTwitchChannelStats(true));
el('yt-refresh')?.addEventListener('click',  () => loadYouTubeStats(true));
el('stats-h2h-go')?.addEventListener('click', loadStatsH2H);
el('stats-profile-go')?.addEventListener('click', loadStatsProfile);
el('stats-profile-name')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadStatsProfile(); });

// Load stats when the tab is opened — restore the last sub-tab (sanitised after the revamp).
el('tab-stats')?.addEventListener('click', () => {
  const valid = ['overview', 'broadcasts', 'audience', 'event', 'players', 'teams', 'sponsors'];
  if (!valid.includes(_statsTab)) _statsTab = 'overview';
  loadAnalyticsFilters();
  statsShowTab(_statsTab);
  anStartAutoRefresh();
});

