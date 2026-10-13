/* ─── analytics-charts.js — Analytics, charts first ────────────────────────────────────────────
   Loads after stats-analytics.js and analytics-ui.js and replaces two renderers:
     • Overview (renderAnalyticsDashboard): four headline numbers with trend lines, then charts:
       viewers per broadcast, air time by month, when you go live (weekday x hour), matches over
       time, top teams, recent broadcasts with their viewer curves.
     • Broadcast report (openBroadcastDetail): the viewer curve on a time axis with ad and
       disconnect markers, scene time, segments, engagement and stream health.
   Every chart is an AnChart card (an-charts.js) with PNG / SVG / CSV downloads.
   Data: GET /api/analytics/overview (series = every broadcast, compact), the stats dashboard
   (ensureDashboard: timeline, teams), and the sponsor summary. */
(function () {
  'use strict';
  const A = () => window.AnChart;
  const $ = (id) => document.getElementById(id);
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const API = (typeof ANALYTICS_API !== 'undefined' && ANALYTICS_API) || 'http://127.0.0.1:3000/api/analytics';
  const HALF = 470;   // drawing width for half-width cards, so their text stays readable
  const PAL = ['#22c3e6', '#a78bfa', '#f5b14a', '#22e06a', '#ec4899', '#60a5fa'];
  const num = (n) => Math.round(n || 0).toLocaleString();
  const hrs = (s) => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? h + 'h ' + m + 'm' : m + 'm'; };
  const day = (ms) => ms ? new Date(Number(ms)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
  const dayLong = (ms) => ms ? new Date(Number(ms)).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '';
  async function getJson(u) { try { const r = await fetch(u); return r.ok ? await r.json() : null; } catch (e) { return null; } }

  // Tiny inline trend line for a headline number.
  function spark(vals, color) {
    vals = (vals || []).filter((v) => typeof v === 'number');
    if (vals.length < 2) return '';
    const W = 120, H = 34, max = Math.max(1, ...vals), min = Math.min(...vals), span = Math.max(1, max - min);
    const pts = vals.map((v, i) => `${(i / (vals.length - 1) * W).toFixed(1)},${(H - 3 - ((v - min) / span) * (H - 6)).toFixed(1)}`);
    return `<svg class="anx-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="M0,${H} L${pts.join(' L')} L${W},${H} Z" fill="${color}" opacity=".16"/><path d="M${pts.join(' L')}" fill="none" stroke="${color}" stroke-width="2"/></svg>`;
  }
  // Change vs the previous period of the same length (last 30 days vs the 30 before).
  function delta(series, pick, agg) {
    const now = Date.now(), D = 30 * 864e5;
    const cur = series.filter((s) => s.startedAt > now - D), prev = series.filter((s) => s.startedAt <= now - D && s.startedAt > now - 2 * D);
    const f = (arr) => agg === 'max' ? Math.max(0, ...arr.map(pick)) : agg === 'avg' ? (arr.length ? arr.reduce((a, s) => a + pick(s), 0) / arr.length : 0) : arr.reduce((a, s) => a + pick(s), 0);
    if (!prev.length && !cur.length) return '';
    const a = f(cur), b = f(prev);
    if (!cur.length) return '<span class="anx-d">No broadcasts in the last 30 days</span>';
    if (!b) return '<span class="anx-d up">New in the last 30 days</span>';
    const pct = Math.round((a - b) / b * 100);
    return `<span class="anx-d ${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs previous 30 days</span>`;
  }
  function headline(label, value, sparkVals, color, deltaHtml) {
    return `<div class="anx-tile"><div class="anx-tile-l">${esc(label)}</div><div class="anx-tile-v">${esc(value)}</div>${deltaHtml || ''}${spark(sparkVals, color)}</div>`;
  }

  // ── Overview ────────────────────────────────────────────────────────────────────────────
  window.renderAnalyticsDashboard = async function () {
    const wrap = $('an-dashboard'); if (!wrap || !A()) return;
    const evQ = (typeof _anEvent !== 'undefined' && _anEvent) ? '?event=' + encodeURIComponent(_anEvent) : '';
    const [ov, dash] = await Promise.all([getJson(API + '/overview' + evQ), (typeof ensureDashboard === 'function' ? ensureDashboard().catch(() => null) : null)]);
    const series = ((ov && ov.series) || []).filter((s) => s.startedAt);
    const t = (ov && ov.totals) || {};
    document.querySelector('#stats-panel-overview')?.classList.add('anx-on');

    if (!series.length) {
      wrap.innerHTML = '<div class="anx-empty"><b>No broadcasts recorded yet</b><span>A broadcast is recorded when you go live on Twitch, or from the Broadcasts tab. Its viewers, air time, ads and scenes show here as charts.</span></div>' + matchCharts(dash);
      return;
    }
    const avgAvg = series.reduce((a, s) => a + s.avgViewers, 0) / series.length;
    const tiles = headline('Broadcasts', num(series.length), monthly(series, (s) => 1).map((m) => m.v), PAL[0], delta(series, () => 1, 'sum'))
      + headline('Air time', hrs(t.airSeconds), monthly(series, (s) => s.durationSec).map((m) => m.v), PAL[1], delta(series, (s) => s.durationSec, 'sum'))
      + headline('Best peak viewers', num(t.peakViewers), series.map((s) => s.peakViewers), PAL[2], delta(series, (s) => s.peakViewers, 'max'))
      + headline('Average viewers', num(avgAvg), series.map((s) => s.avgViewers), PAL[3], delta(series, (s) => s.avgViewers, 'avg'));

    const last = series.slice(-16);
    const viewers = A().card({
      id: 'ov-viewers', wide: true, title: 'Viewers per broadcast', sub: 'peak and average, last ' + last.length + ' shows',
      body: A().columns(last.map((s) => ({ label: day(s.startedAt), tip: (s.label || 'Broadcast') + ' (' + day(s.startedAt) + ')', values: [s.peakViewers, s.avgViewers] })),
        { series: [{ name: 'Peak', color: PAL[0] }, { name: 'Average', color: PAL[1] }] }),
      csv: { name: 'viewers-per-broadcast.csv', headers: ['Broadcast', 'Date', 'Peak viewers', 'Average viewers', 'Length'], rows: series.map((s) => [s.label, dayLong(s.startedAt), s.peakViewers, s.avgViewers, hrs(s.durationSec)]) },
    });
    const months = monthly(series, (s) => s.durationSec);
    const airtime = A().card({
      id: 'ov-airtime', title: 'Air time by month', sub: 'hours live',
      body: A().columns(months.map((m) => ({ label: m.label, values: [Math.round(m.v / 360) / 10] })), { series: [{ name: 'Hours', color: PAL[1] }], yFmt: (v) => v + 'h', height: 240, width: HALF }),
      csv: { name: 'air-time-by-month.csv', headers: ['Month', 'Hours live', 'Broadcasts'], rows: months.map((m) => [m.label, (m.v / 3600).toFixed(1), m.n]) },
    });
    const grid = [0, 1, 2, 3, 4, 5, 6].map(() => new Array(24).fill(0));
    series.forEach((s) => { const d = new Date(Number(s.startedAt)); grid[(d.getDay() + 6) % 7][d.getHours()]++; });
    const heat = A().card({
      id: 'ov-golive', title: 'When you go live', sub: 'broadcast starts by weekday and hour',
      body: A().heatmap(grid, { rows: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], cols: Array.from({ length: 24 }, (_, h) => (h % 12 || 12) + (h < 12 ? 'a' : 'p')), colEvery: 3, width: HALF, fmt: (v) => v + ' broadcast' + (v === 1 ? '' : 's') }),
      csv: { name: 'go-live-times.csv', headers: ['Weekday', 'Hour', 'Broadcasts'], rows: [].concat(...grid.map((r, ri) => r.map((v, h) => [['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][ri], h + ':00', v]))).filter((r) => r[2]) },
    });
    const recent = series.slice(-8).reverse();
    const recentHtml = `<div class="anc-card anc-wide anx-recent"><div class="anc-head"><div class="anc-ttl"><b>Recent broadcasts</b><span>click one for its full report</span></div></div><div class="anx-rlist">`
      + recent.map((s) => `<button type="button" class="anx-rrow" data-an-open="${esc(s.id)}"><span class="anx-rname"><b>${esc(s.label || 'Broadcast')}</b><span>${esc(dayLong(s.startedAt))} · ${esc(hrs(s.durationSec))}</span></span>${spark(s.curve, PAL[0])}<span class="anx-rnum"><b>${num(s.peakViewers)}</b><span>peak</span></span><span class="anx-rnum"><b>${num(s.avgViewers)}</b><span>avg</span></span></button>`).join('')
      + '</div></div>';
    wrap.innerHTML = `<div class="anx-tiles">${tiles}</div><div class="anx-grid">${viewers}${airtime}${heat}${matchCharts(dash)}${recentHtml}</div>`;
  };
  function monthly(series, pick) {
    const map = new Map();
    series.forEach((s) => { const d = new Date(Number(s.startedAt)); const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); const e = map.get(k) || { v: 0, n: 0, d }; e.v += pick(s) || 0; e.n++; map.set(k, e); });
    return [...map.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([k, e]) => ({ key: k, label: e.d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }), v: e.v, n: e.n }));
  }
  // Match data charts (from the stats dashboard): matches over time (weekly) + top teams.
  function matchCharts(dash) {
    if (!dash) return '';
    const tl = dash.timeline || [], weeks = new Map();
    tl.forEach((p) => {
      const d = new Date(p.date + 'T00:00:00'); if (isNaN(d)) return;
      const mon = new Date(d); mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const k = mon.getTime(); const e = weeks.get(k) || { x: k, matches: 0, games: 0 }; e.matches += p.matches || 0; e.games += p.games || 0; weeks.set(k, e);
    });
    const wk = [...weeks.values()].sort((a, b) => a.x - b.x);
    const teams = (dash.teams || []).slice().sort((a, b) => (b.wins || 0) - (a.wins || 0)).slice(0, 10);
    let out = '';
    if (wk.length > 1) out += A().card({
      id: 'ov-matches', title: 'Matches played per week', sub: 'matches and games recorded',
      body: A().line(wk, { series: [{ name: 'Matches', color: PAL[0], key: 'matches' }, { name: 'Games', color: PAL[1], key: 'games' }], xFmt: (x) => day(x), height: 250, width: HALF }),
      csv: { name: 'matches-per-week.csv', headers: ['Week of', 'Matches', 'Games'], rows: wk.map((w) => [new Date(w.x).toISOString().slice(0, 10), w.matches, w.games]) },
    });
    if (teams.length) out += A().card({
      id: 'ov-teams', title: 'Top teams by wins', sub: 'win-loss and win rate',
      body: A().hbars(teams.map((x) => ({ label: x.team, value: x.wins || 0, sub: (x.wins || 0) + '-' + (x.losses || 0) + '  ' + (x.winPct != null ? x.winPct + '%' : '') })), { color: PAL[3], width: HALF }),
      csv: { name: 'team-standings.csv', headers: ['Team', 'Played', 'Wins', 'Losses', 'Win %'], rows: (dash.teams || []).map((x) => [x.team, x.matches, x.wins, x.losses, x.winPct]) },
    });
    return out;
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-an-open]'); if (!b) return;
    if (typeof statsShowTab === 'function') statsShowTab('broadcasts');
    setTimeout(() => window.openBroadcastDetail(b.getAttribute('data-an-open')), 80);
  });

  // ── Broadcast report ────────────────────────────────────────────────────────────────────
  window.openBroadcastDetail = async function (id) {
    const wrap = $('an-detail'); if (!wrap || !A()) return;
    wrap.style.display = ''; wrap.innerHTML = '<section class="section"><p class="section-desc">Loading report…</p></section>';
    const d = await getJson(API + '/session/' + encodeURIComponent(id));
    const s = d && d.session;
    if (!s) { wrap.innerHTML = '<section class="section"><p style="color:#f56565;">Could not load that report.</p></section>'; return; }
    try { wrap.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
    const t0 = Number(s.startedAt) || ((s.viewerSamples && s.viewerSamples[0] && s.viewerSamples[0].t) || 0);
    const clock = (x) => { const sec = Math.max(0, Math.round((x - t0) / 1000)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h ? h + ':' + String(m).padStart(2, '0') : m + 'm'; };
    const samples = (s.viewerSamples || []).filter((p) => p && typeof p.v === 'number').map((p) => ({ x: p.t, v: p.v }));
    const markers = (s.disconnects || []).map((x) => ({ x: x.t, label: 'Disconnect: ' + (x.what || '') + ' at ' + clock(x.t), color: '#f56565' }))
      .concat(((s.ads && s.ads.list) || []).map((a) => ({ x: a.t || a.at, label: 'Ad break', color: '#f5b14a' })));
    const ev = s.engagement || {};
    const scenes = Object.keys(s.sceneTime || {}).map((k) => ({ label: k, value: s.sceneTime[k] })).filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
    const segs = Object.keys(s.segments || {}).map((k) => { const g = s.segments[k] || {}; return { label: k, value: g.avgViewers || 0, sub: num(g.avgViewers || 0) + ' avg · ' + hrs(g.seconds || 0) }; }).sort((a, b) => b.value - a.value);
    const eng = [['Follows', ev.follows], ['Subs', ev.subs], ['Bits', ev.bits], ['Raids', ev.raids], ['Predictions', ev.predictionsCreated], ['Polls', ev.pollsCreated], ['Wheel spins', ev.wheelSpins], ['Mini-games', ev.minigames]]
      .filter((x) => x[1]).map(([label, value]) => ({ label, value }));
    const h = s.health || null;
    const cards = [
      A().card({
        id: 'bc-viewers', wide: true, title: 'Viewers over the broadcast', sub: 'red lines are disconnects, amber are ad breaks',
        body: A().line(samples, { series: [{ name: 'Viewers', color: PAL[0], key: 'v' }], xFmt: clock, markers, height: 260, empty: 'No viewer samples were recorded for this broadcast.' }),
        csv: { name: 'viewers-over-time.csv', headers: ['Time into show', 'Viewers'], rows: samples.map((p) => [clock(p.x), p.v]) },
      }),
      scenes.length ? A().card({
        id: 'bc-scenes', title: 'Time on each scene', sub: 'share of the broadcast',
        body: A().donut(scenes.slice(0, 7).concat(scenes.length > 7 ? [{ label: 'Other', value: scenes.slice(7).reduce((a, x) => a + x.value, 0) }] : []), { fmt: hrs, center: hrs(scenes.reduce((a, x) => a + x.value, 0)), sub: 'on scenes' }),
        csv: { name: 'scene-time.csv', headers: ['Scene', 'Seconds'], rows: scenes.map((x) => [x.label, x.value]) },
      }) : '',
      segs.length ? A().card({
        id: 'bc-segments', title: 'Average viewers by segment', sub: 'which parts of the show held people',
        body: A().hbars(segs, { color: PAL[1], width: HALF }),
        csv: { name: 'segments.csv', headers: ['Segment', 'Average viewers'], rows: segs.map((x) => [x.label, x.value]) },
      }) : '',
      eng.length ? A().card({
        id: 'bc-engage', title: 'Engagement', sub: 'what chat did',
        body: A().hbars(eng, { color: PAL[4], width: HALF }),
        csv: { name: 'engagement.csv', headers: ['Type', 'Count'], rows: eng.map((x) => [x.label, x.value]) },
      }) : '',
      h ? A().card({
        id: 'bc-health', title: 'Stream health', sub: 'averages over the broadcast',
        body: A().hbars([
          { label: 'Dropped frames (avg)', value: h.avgDropPct || 0, sub: (h.avgDropPct || 0) + '%', color: (h.avgDropPct || 0) > 1 ? '#f56565' : '#22e06a' },
          { label: 'Dropped frames (worst)', value: h.maxDropPct || 0, sub: (h.maxDropPct || 0) + '%', color: (h.maxDropPct || 0) > 5 ? '#f56565' : '#f5b14a' },
          { label: 'Encoder CPU', value: h.avgCpu || 0, sub: (h.avgCpu || 0) + '%', color: (h.avgCpu || 0) > 85 ? '#f56565' : PAL[0] },
          { label: 'Render FPS', value: h.avgFps || 0, sub: String(h.avgFps || 0), color: PAL[5] },
        ], { width: HALF }),
        csv: { name: 'stream-health.csv', headers: ['Metric', 'Value'], rows: [['Avg dropped %', h.avgDropPct], ['Worst dropped %', h.maxDropPct], ['Avg CPU %', h.avgCpu], ['Avg FPS', h.avgFps], ['Avg bitrate kbps', h.avgBitrate], ['Worst congestion', h.maxCongestion]] },
      }) : '',
    ].filter(Boolean).join('');
    wrap.innerHTML = `<section class="section anx-report">
      <div class="anx-rhead"><div><h3 class="section-title" style="margin:0;">${esc(s.label || 'Broadcast')}${s.active ? ' <span class="an-rec-tag">LIVE</span>' : ''}</h3>
        <p class="section-desc" style="margin:4px 0 0;">${esc(dayLong(s.startedAt))} · ${esc(hrs(s.durationSec))}${s.game ? ' · ' + esc(s.game) : ''}</p></div>
        <div class="anx-ract"><button class="btn btn-secondary btn-sm" id="an-exp">Export CSV</button>${s.active ? '' : '<button class="btn btn-danger btn-sm" id="an-del">Delete</button>'}<button class="btn btn-ghost btn-sm" id="an-close">Close</button></div></div>
      <div class="anx-tiles">
        ${headline('Peak viewers', num(s.peakViewers), samples.map((p) => p.v), PAL[0])}
        ${headline('Average viewers', num(s.avgViewers), null, PAL[1])}
        ${headline('Live time', hrs(s.liveSeconds || s.durationSec), null, PAL[2])}
        ${headline('Ad breaks', num((s.ads && s.ads.count) || 0) + ' · ' + hrs((s.ads && s.ads.totalSec) || 0), null, PAL[3])}
      </div>
      <div class="anx-grid">${cards}</div></section>`;
    $('an-exp')?.addEventListener('click', () => typeof anFetchDownload === 'function' && anFetchDownload(API + '/export?session=' + encodeURIComponent(id), 'broadcast.csv'));
    $('an-close')?.addEventListener('click', () => { wrap.style.display = 'none'; wrap.innerHTML = ''; });
    $('an-del')?.addEventListener('click', async () => {
      if (typeof appConfirm === 'function' && !(await appConfirm('Delete this broadcast report?', 'Delete'))) return;
      try { await fetch(API + '/session/' + encodeURIComponent(id), { method: 'DELETE' }); } catch (er) {}
      wrap.style.display = 'none'; wrap.innerHTML = ''; if (typeof loadBroadcasts === 'function') loadBroadcasts();
    });
  };
})();
