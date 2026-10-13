/* ─── an-charts.js — the Analytics chart kit ────────────────────────────────────────────────────
   Every chart is ONE self-contained SVG (explicit fills, fonts and sizes, no CSS variables), so the
   same picture shows on the page, downloads as PNG or SVG, and drops into the PDF report unchanged.
   Each chart sits in a card (AnChart.card) with Download PNG / SVG / CSV; the CSV is the exact data
   the chart draws.

     AnChart.card({ id, title, sub, body, csv: { name, headers, rows }, wide })
     AnChart.columns(groups, { series, yFmt, height })        grouped vertical bars, y axis + gridlines
     AnChart.line(points, { series, xFmt, yFmt, height, markers })   lines/areas over a numeric x
     AnChart.hbars(items, { fmt, color })                      horizontal bars with FULL labels
     AnChart.donut(segs, { center, sub })
     AnChart.heatmap(grid, { rows, cols, fmt })                e.g. weekday x hour
     AnChart.histogram(values, { bin, max, fmt, color })       counts per bucket (+ overflow bucket)
   Hover: every mark carries a <title>, which Chromium shows as a tooltip. */
(function () {
  'use strict';
  const C = {
    text: '#c9cdd6', muted: '#8a92a3', grid: 'rgba(255,255,255,0.07)', axis: 'rgba(255,255,255,0.14)',
    bg: '#14161c', font: "Inter, 'Segoe UI', Roboto, Arial, sans-serif",
    palette: ['#22c3e6', '#a78bfa', '#f5b14a', '#22e06a', '#ec4899', '#60a5fa', '#fb7185', '#34d399'],
  };
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => (Math.round(n || 0)).toLocaleString();
  const svgOpen = (w, h, extra) => `<svg class="anc" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet" font-family="${C.font}" ${extra || ''}>`;
  const empty = (msg) => `<div class="anc-empty">${esc(msg || 'No data in this range yet.')}</div>`;
  // Round an axis maximum up to a friendly number and give ~4 ticks.
  function niceScale(max, ticks) {
    ticks = ticks || 4;
    if (!(max > 0)) return { max: 1, step: 1 };
    const raw = max / ticks, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / mag, step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
    return { max: Math.ceil(max / step) * step, step };
  }
  const short = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  // ── Card with export buttons ────────────────────────────────────────────────────────────
  const REG = {};
  function card(o) {
    if (o.csv) REG[o.id] = o.csv;
    return `<div class="anc-card${o.wide ? ' anc-wide' : ''}" data-anc="${esc(o.id)}" data-anc-title="${esc(o.title)}">
      <div class="anc-head"><div class="anc-ttl"><b>${esc(o.title)}</b>${o.sub ? `<span>${esc(o.sub)}</span>` : ''}</div>
        <div class="anc-x" role="group" aria-label="Download this chart">
          <button type="button" data-anx="png" title="Download as a PNG picture">PNG</button>
          <button type="button" data-anx="svg" title="Download as an SVG (sharp at any size)">SVG</button>
          ${o.csv ? '<button type="button" data-anx="csv" title="Download the numbers behind this chart">CSV</button>' : ''}
        </div></div>
      <div class="anc-body">${o.body}</div></div>`;
  }

  // ── Grouped columns ─────────────────────────────────────────────────────────────────────
  function columns(groups, o) {
    o = o || {}; groups = (groups || []).filter(Boolean);
    const series = o.series || [{ name: 'Value', color: C.palette[0] }];
    if (!groups.length) return empty(o.empty);
    const W = o.width || 760, H = o.height || 260, L = 46, R = 12, T = 18, B = 44;
    const max = Math.max(1, ...groups.map((g) => Math.max(...g.values.map((v) => v || 0))));
    const sc = niceScale(max), pw = W - L - R, ph = H - T - B;
    const gw = pw / groups.length, bw = Math.max(3, Math.min(34, (gw * 0.72) / series.length));
    const y = (v) => T + ph - (v / sc.max) * ph;
    let s = svgOpen(W, H);
    for (let v = 0; v <= sc.max + 1e-9; v += sc.step) {
      s += `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${v ? C.grid : C.axis}"/>`;
      s += `<text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${C.muted}">${esc((o.yFmt || num)(v))}</text>`;
    }
    const every = Math.ceil(groups.length / Math.max(4, Math.floor(W / 64)));
    groups.forEach((g, gi) => {
      const gx = L + gi * gw + (gw - bw * series.length) / 2;
      g.values.forEach((v, si) => {
        const h = ((v || 0) / sc.max) * ph, x = gx + si * bw;
        s += `<rect x="${x.toFixed(1)}" y="${(T + ph - h).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="3" fill="${series[si].color}"><title>${esc((g.tip || g.label) + ' — ' + series[si].name + ': ' + (o.yFmt || num)(v || 0))}</title></rect>`;
      });
      if (gi % every === 0) s += `<text x="${(L + gi * gw + gw / 2).toFixed(1)}" y="${H - B + 18}" text-anchor="middle" font-size="11" fill="${C.muted}">${esc(short(g.label, 12))}</text>`;
    });
    if (series.length > 1) s += legend(series, L, H - 10);
    return s + '</svg>';
  }
  function legend(series, x, y) {
    let s = '', cx = x;
    series.forEach((se) => { s += `<rect x="${cx}" y="${y - 9}" width="10" height="10" rx="2" fill="${se.color}"/><text x="${cx + 15}" y="${y}" font-size="11.5" fill="${C.text}">${esc(se.name)}</text>`; cx += 26 + se.name.length * 6.6; });
    return s;
  }

  // ── Lines / areas over numeric x (timestamps or seconds) ───────────────────────────────
  function line(points, o) {
    o = o || {}; points = (points || []).filter((p) => p && p.x != null);
    const series = o.series || [{ name: 'Value', color: C.palette[0], key: 'v' }];
    if (points.length < 2) return empty(o.empty || 'Not enough data to draw a line yet.');
    const W = o.width || 760, H = o.height || 240, L = 46, R = 14, T = 16, B = series.length > 1 ? 50 : 32;
    const xs = points.map((p) => p.x), x0 = Math.min(...xs), x1 = Math.max(...xs), xr = Math.max(1, x1 - x0);
    let max = 1; points.forEach((p) => series.forEach((se) => { if ((p[se.key] || 0) > max) max = p[se.key]; }));
    const sc = niceScale(max), pw = W - L - R, ph = H - T - B;
    const X = (v) => L + ((v - x0) / xr) * pw, Y = (v) => T + ph - ((v || 0) / sc.max) * ph;
    let s = svgOpen(W, H);
    for (let v = 0; v <= sc.max + 1e-9; v += sc.step) {
      s += `<line x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="${v ? C.grid : C.axis}"/>`;
      s += `<text x="${L - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${C.muted}">${esc((o.yFmt || num)(v))}</text>`;
    }
    const ticks = 5;
    for (let i = 0; i <= ticks; i++) {
      const v = x0 + (xr * i) / ticks;
      s += `<text x="${X(v).toFixed(1)}" y="${T + ph + 18}" text-anchor="${i === 0 ? 'start' : i === ticks ? 'end' : 'middle'}" font-size="11" fill="${C.muted}">${esc((o.xFmt || num)(v))}</text>`;
    }
    (o.markers || []).forEach((m) => {
      if (m.x < x0 || m.x > x1) return;
      s += `<line x1="${X(m.x).toFixed(1)}" x2="${X(m.x).toFixed(1)}" y1="${T}" y2="${T + ph}" stroke="${m.color || '#f5b14a'}" stroke-dasharray="3 3" opacity=".8"><title>${esc(m.label || '')}</title></line>`;
    });
    series.forEach((se, si) => {
      const pts = points.map((p) => `${X(p.x).toFixed(1)},${Y(p[se.key]).toFixed(1)}`);
      if (si === 0 && o.area !== false) s += `<path d="M${X(x0).toFixed(1)},${T + ph} L${pts.join(' L')} L${X(x1).toFixed(1)},${T + ph} Z" fill="${se.color}" opacity=".14"/>`;
      s += `<path d="M${pts.join(' L')}" fill="none" stroke="${se.color}" stroke-width="2.2" stroke-linejoin="round"/>`;
    });
    // invisible hover targets (one per point, thinned) with values
    const step = Math.max(1, Math.floor(points.length / 120));
    for (let i = 0; i < points.length; i += step) {
      const p = points[i];
      s += `<rect x="${(X(p.x) - pw / Math.min(points.length, 120) / 2).toFixed(1)}" y="${T}" width="${(pw / Math.min(points.length, 120)).toFixed(1)}" height="${ph}" fill="transparent"><title>${esc((o.xFmt || num)(p.x) + ' — ' + series.map((se) => se.name + ': ' + (o.yFmt || num)(p[se.key] || 0)).join(', '))}</title></rect>`;
    }
    if (series.length > 1) s += legend(series, L, H - 8);
    return s + '</svg>';
  }

  // ── Horizontal bars with full labels ────────────────────────────────────────────────────
  function hbars(items, o) {
    o = o || {}; items = (items || []).filter(Boolean);
    if (!items.length) return empty(o.empty);
    const rowH = 30, W = o.width || 760, T = 6, labelW = Math.min(W * 0.42, Math.max(110, Math.max(...items.map((i) => String(i.label).length)) * 7.2 + 10));
    // The value column fits its longest label ("265G · 110A · 193S"), so nothing is clipped.
    const valLen = Math.max(...items.map((i) => String(i.sub != null ? i.sub : (o.fmt || num)(i.value)).length));
    const H = T + items.length * rowH + 4, valW = Math.min(W * 0.34, Math.max(70, valLen * 7.4 + 12)), pw = W - labelW - valW - 10;
    const max = Math.max(1, ...items.map((i) => i.value || 0));
    let s = svgOpen(W, H);
    items.forEach((it, i) => {
      const y = T + i * rowH, w = Math.max(2, ((it.value || 0) / max) * pw), col = it.color || o.color || C.palette[0];
      s += `<text x="${labelW - 10}" y="${y + 19}" text-anchor="end" font-size="13" fill="${C.text}">${esc(short(it.label, 40))}<title>${esc(it.label)}</title></text>`;
      s += `<rect x="${labelW}" y="${y + 6}" width="${pw}" height="16" rx="5" fill="rgba(255,255,255,0.05)"/>`;
      s += `<rect x="${labelW}" y="${y + 6}" width="${w.toFixed(1)}" height="16" rx="5" fill="${col}"><title>${esc(it.label + ': ' + (it.sub != null ? it.sub : (o.fmt || num)(it.value)))}</title></rect>`;
      s += `<text x="${labelW + pw + 10}" y="${y + 19}" font-size="12.5" font-weight="700" fill="${C.text}">${esc(it.sub != null ? it.sub : (o.fmt || num)(it.value))}</text>`;
    });
    return s + '</svg>';
  }

  // ── Donut ───────────────────────────────────────────────────────────────────────────────
  function donut(segs, o) {
    o = o || {}; segs = (segs || []).filter((x) => (x.value || 0) > 0);
    const total = segs.reduce((a, x) => a + x.value, 0);
    if (!total) return empty(o.empty);
    const W = 520, H = 220, cx = 110, cy = 110, R = 82, r = 52;
    let s = svgOpen(W, H), a0 = -Math.PI / 2;
    segs.forEach((g, i) => {
      const a1 = a0 + (g.value / total) * Math.PI * 2, big = a1 - a0 > Math.PI ? 1 : 0;
      const p = (rad, ang) => `${(cx + rad * Math.cos(ang)).toFixed(2)},${(cy + rad * Math.sin(ang)).toFixed(2)}`;
      const col = g.color || C.palette[i % C.palette.length];
      const d = segs.length === 1
        ? `M${cx - R},${cy} a${R},${R} 0 1,0 ${R * 2},0 a${R},${R} 0 1,0 ${-R * 2},0 M${cx - r},${cy} a${r},${r} 0 1,1 ${r * 2},0 a${r},${r} 0 1,1 ${-r * 2},0`
        : `M${p(R, a0)} A${R},${R} 0 ${big} 1 ${p(R, a1)} L${p(r, a1)} A${r},${r} 0 ${big} 0 ${p(r, a0)} Z`;
      s += `<path d="${d}" fill="${col}" fill-rule="evenodd"><title>${esc(g.label + ': ' + (o.fmt || num)(g.value) + ' (' + Math.round(g.value / total * 100) + '%)')}</title></path>`;
      const ly = 34 + i * 24;
      if (i < 7) s += `<rect x="240" y="${ly - 10}" width="12" height="12" rx="3" fill="${col}"/><text x="260" y="${ly}" font-size="13" fill="${C.text}">${esc(short(g.label, 22))}</text><text x="${W - 8}" y="${ly}" text-anchor="end" font-size="13" font-weight="700" fill="${C.text}">${esc((o.fmt || num)(g.value))} <tspan fill="${C.muted}" font-weight="400">${Math.round(g.value / total * 100)}%</tspan></text>`;
      a0 = a1;
    });
    s += `<text x="${cx}" y="${cy + 2}" text-anchor="middle" font-size="22" font-weight="800" fill="#ffffff">${esc(o.center != null ? o.center : num(total))}</text>`;
    if (o.sub) s += `<text x="${cx}" y="${cy + 20}" text-anchor="middle" font-size="11" fill="${C.muted}">${esc(o.sub)}</text>`;
    return s + '</svg>';
  }

  // ── Heatmap ─────────────────────────────────────────────────────────────────────────────
  function heatmap(grid, o) {
    o = o || {};
    const rows = o.rows || [], cols = o.cols || [];
    const max = Math.max(0, ...grid.map((r) => Math.max(...r)));
    if (!max) return empty(o.empty);
    const L = 44, T = 22, cw = o.width ? Math.max(12, Math.floor((o.width - L - 6) / cols.length)) : 28, ch = o.width ? Math.max(18, Math.round(cw * 0.95)) : 24, W = L + cols.length * cw + 6, H = T + rows.length * ch + 6;
    let s = svgOpen(W, H);
    cols.forEach((c, ci) => { if (ci % (o.colEvery || 1) === 0) s += `<text x="${L + ci * cw + cw / 2}" y="${T - 7}" text-anchor="middle" font-size="10.5" fill="${C.muted}">${esc(c)}</text>`; });
    rows.forEach((rlab, ri) => {
      s += `<text x="${L - 8}" y="${T + ri * ch + 16}" text-anchor="end" font-size="11.5" fill="${C.muted}">${esc(rlab)}</text>`;
      cols.forEach((c, ci) => {
        const v = (grid[ri] && grid[ri][ci]) || 0, a = v ? 0.15 + 0.85 * (v / max) : 0.04;
        s += `<rect x="${L + ci * cw + 1}" y="${T + ri * ch + 1}" width="${cw - 2}" height="${ch - 2}" rx="4" fill="${v ? (o.color || '#22c3e6') : '#ffffff'}" fill-opacity="${a.toFixed(2)}"><title>${esc(rlab + ' ' + c + ': ' + (o.fmt || num)(v))}</title></rect>`;
      });
    });
    return s + '</svg>';
  }

  // ── Histogram ───────────────────────────────────────────────────────────────────────────
  function histogram(values, o) {
    o = o || {}; values = (values || []).filter((v) => typeof v === 'number' && v >= 0);
    if (!values.length) return empty(o.empty);
    const bin = o.bin || 300, top = o.max || bin * 12, nb = Math.ceil(top / bin);
    const counts = new Array(nb + 1).fill(0);
    values.forEach((v) => { counts[v >= top ? nb : Math.floor(v / bin)]++; });
    const fmt = o.fmt || ((s) => Math.round(s / 60) + 'm');
    const groups = counts.map((c, i) => ({ label: i === nb ? fmt(top) + '+' : fmt(i * bin), tip: i === nb ? fmt(top) + ' or longer' : fmt(i * bin) + '–' + fmt((i + 1) * bin), values: [c] }));
    return columns(groups, { series: [{ name: o.name || 'Count', color: o.color || C.palette[2] }], height: o.height, width: o.width });
  }

  // ── Downloads ───────────────────────────────────────────────────────────────────────────
  function fileName(cardEl, ext) {
    const t = (cardEl.getAttribute('data-anc-title') || 'chart').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return t + '-' + new Date().toISOString().slice(0, 10) + '.' + ext;
  }
  function save(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function svgText(svg, title) {
    const clone = svg.cloneNode(true);
    const vb = (svg.getAttribute('viewBox') || '0 0 760 260').split(/\s+/).map(Number);
    clone.setAttribute('width', vb[2]); clone.setAttribute('height', vb[3] + (title ? 34 : 0));
    clone.setAttribute('viewBox', `0 ${title ? -34 : 0} ${vb[2]} ${vb[3] + (title ? 34 : 0)}`);
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('x', 0); bg.setAttribute('y', title ? -34 : 0); bg.setAttribute('width', vb[2]); bg.setAttribute('height', vb[3] + (title ? 34 : 0)); bg.setAttribute('fill', C.bg);
    clone.insertBefore(bg, clone.firstChild);
    if (title) {
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', 12); t.setAttribute('y', -12); t.setAttribute('font-size', 15); t.setAttribute('font-weight', 700); t.setAttribute('fill', '#ffffff'); t.setAttribute('font-family', C.font);
      t.textContent = title; clone.insertBefore(t, bg.nextSibling);
    }
    return { text: new XMLSerializer().serializeToString(clone), w: vb[2], h: vb[3] + (title ? 34 : 0) };
  }
  function toPng(svg, title) {
    return new Promise((resolve) => {
      const { text, w, h } = svgText(svg, title);
      const img = new Image();
      img.onload = () => {
        const k = 2, cv = document.createElement('canvas'); cv.width = w * k; cv.height = h * k;
        const g = cv.getContext('2d'); g.scale(k, k); g.drawImage(img, 0, 0, w, h);
        cv.toBlob((b) => resolve(b), 'image/png');
      };
      img.onerror = () => resolve(null);
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
    });
  }
  const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  document.addEventListener('click', async (e) => {
    const b = e.target.closest && e.target.closest('[data-anx]'); if (!b) return;
    const cardEl = b.closest('[data-anc]'); if (!cardEl) return;
    const kind = b.getAttribute('data-anx'), title = cardEl.getAttribute('data-anc-title') || '';
    const svg = cardEl.querySelector('svg.anc');
    if (kind === 'csv') {
      const d = REG[cardEl.getAttribute('data-anc')]; if (!d) return;
      const text = [d.headers.map(csvCell).join(',')].concat(d.rows.map((r) => r.map(csvCell).join(','))).join('\r\n');
      save(new Blob([text], { type: 'text/csv' }), d.name || fileName(cardEl, 'csv'));
    } else if (svg && kind === 'svg') {
      save(new Blob([svgText(svg, title).text], { type: 'image/svg+xml' }), fileName(cardEl, 'svg'));
    } else if (svg && kind === 'png') {
      const blob = await toPng(svg, title); if (blob) save(blob, fileName(cardEl, 'png'));
    }
  });

  window.AnChart = { card, columns, line, hbars, donut, heatmap, histogram, toPng, svgText, colors: C.palette, niceScale };
})();
