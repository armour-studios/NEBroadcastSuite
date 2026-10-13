// Custom overlays built in the control panel (Overlays ▸ Custom). Pure sanitising + a tiny async
// file store (data/custom-overlays.json). server.js owns the WS / HTTP wiring; the renderer is
// overlay/custom-render.js (the element model is documented at its top). Layouts hold URLs, never
// inline images (data: URIs are dropped), so the file stays small and nothing heavy rides a broadcast.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_OVERLAYS = 300;
const MAX_ELEMENTS = 200;
const TYPES = new Set(['text', 'image', 'shape', 'list', 'embed', 'ticker', 'bar', 'slides']);
const SHOW = new Set(['always', 'break', 'nobreak', 'live', 'hud', 'replay', 'board', 'casters']);
const FONTS = new Set(['inter', 'montserrat', 'rajdhani', 'mono']);
const KINDS = new Set(['ingame', 'caster', 'break', 'lowerthird', 'fullscreen', 'other']);
const ANIMS = new Set(['', 'fade', 'up', 'down', 'left', 'right', 'zoom']);
const SHADOWS = new Set(['', 'soft', 'hard', 'glow']);
const STATS = new Set(['', 'goals', 'score', 'assists', 'saves', 'shots', 'demos', 'boost']);

const num = (v, min, max, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const color = (v, d) => (typeof v === 'string' && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\)|transparent|[a-z]{3,20})$/i.test(v.trim()) ? v.trim() : d);
const bind = (v) => (typeof v === 'string' && /^[a-z0-9.]{1,40}$/i.test(v) ? v : '');
// http(s), a path on this server, or an asset path. No data: URIs (they would bloat every save).
// A link typed without a scheme ("vdo.ninja/?view=x") is taken as https rather than dropped.
const src = (v) => { let s = str(v, 2000).trim(); if (s && !/^[a-z][a-z0-9+.-]*:/i.test(s) && !s.startsWith('/') && /^[\w-]+(\.[\w-]+)+/.test(s)) s = 'https://' + s; return /^(https?:\/\/|\/)/i.test(s) ? s : ''; };
const id = (v, prefix) => (typeof v === 'string' && /^[a-z0-9_-]{4,40}$/i.test(v) ? v : prefix + crypto.randomBytes(5).toString('hex'));
const show = (v) => (typeof v === 'string' && (SHOW.has(v) || /^gfx:[a-z0-9_-]{1,30}$/i.test(v)) ? v : 'always');

// The text styling shared by text pieces, player lists and the ticker.
function textStyle(t) {
  return {
    font: FONTS.has(t.font) ? t.font : 'inter', size: num(t.size, 6, 600, 40),
    weight: [400, 500, 600, 700, 800, 900].includes(Number(t.weight)) ? Number(t.weight) : 700,
    color: color(t.color, '#ffffff'), colorBind: bind(t.colorBind), upper: !!t.upper, italic: !!t.italic,
    spacing: num(t.spacing, -10, 40, 0), shadow: !!t.shadow,
    strokeW: num(t.strokeW, 0, 20, 0), strokeColor: color(t.strokeColor, '#000000'),
  };
}

function cleanElement(e) {
  if (!e || typeof e !== 'object' || !TYPES.has(e.type)) return null;
  const fx = e.fx || {};
  const out = {
    id: id(e.id, 'e'), type: e.type, name: str(e.name, 60),
    x: Math.round(num(e.x, -4000, 6000, 0)), y: Math.round(num(e.y, -4000, 6000, 0)),
    w: Math.round(num(e.w, 1, 8000, 200)), h: Math.round(num(e.h, 1, 8000, 80)),
    opacity: num(e.opacity, 0, 1, 1), hidden: !!e.hidden, locked: !!e.locked, show: show(e.show),
    fx: { rot: num(fx.rot, -360, 360, 0), skew: num(fx.skew, -45, 45, 0), shadow: SHADOWS.has(fx.shadow) ? fx.shadow : '',
      blur: num(fx.blur, 0, 40, 0), anim: ANIMS.has(fx.anim) ? fx.anim : '', animMs: num(fx.animMs, 100, 4000, 500) },
  };
  if (e.type === 'text') {
    const t = e.text || {};
    out.text = Object.assign(textStyle(t), { content: str(t.content, 1000), bind: bind(t.bind),
      align: ['left', 'center', 'right'].includes(t.align) ? t.align : 'center', valign: ['top', 'middle', 'bottom'].includes(t.valign) ? t.valign : 'middle',
      wrap: !!t.wrap, lineHeight: num(t.lineHeight, 0.6, 3, 1.1), padX: num(t.padX, 0, 400, 0),
      bg: t.bg ? color(t.bg, '') : '', bgBind: bind(t.bgBind), bgRadius: num(t.bgRadius, 0, 2000, 0) });
  } else if (e.type === 'image') {
    const im = e.image || {};
    out.image = { src: src(im.src), bind: bind(im.bind), fit: ['contain', 'cover', 'fill'].includes(im.fit) ? im.fit : 'contain', radius: num(im.radius, 0, 2000, 0), gray: !!im.gray };
  } else if (e.type === 'shape') {
    const sh = e.shape || {};
    out.shape = { fill: color(sh.fill, '#111827'), fillBind: bind(sh.fillBind), fill2: sh.fill2 ? color(sh.fill2, '') : '', angle: num(sh.angle, 0, 360, 90),
      radius: num(sh.radius, 0, 2000, 0), circle: !!sh.circle, borderW: num(sh.borderW, 0, 100, 0), borderColor: color(sh.borderColor, '#ffffff'), borderBind: bind(sh.borderBind) };
  } else if (e.type === 'list') {
    const L = e.list || {};
    out.list = Object.assign(textStyle(L), { side: ['blue', 'orange', 'all'].includes(L.side) ? L.side : 'blue', stat: STATS.has(L.stat) ? L.stat : '',
      max: Math.round(num(L.max, 1, 10, 3)), gap: num(L.gap, 0, 200, 6), padX: num(L.padX, 0, 200, 12), radius: num(L.radius, 0, 200, 0),
      bg: color(L.bg, 'rgba(11,15,23,.82)'), hlBg: L.hlBg ? color(L.hlBg, '') : '', statColor: L.statColor ? color(L.statColor, '') : '',
      highlight: !!L.highlight, accent: !!L.accent, sort: !!L.sort });
  } else if (e.type === 'embed') {
    const em = e.embed || {};
    out.embed = { src: src(em.src), bind: bind(em.bind), radius: num(em.radius, 0, 2000, 0) };
  } else if (e.type === 'ticker') {
    const t = e.ticker || {};
    out.ticker = Object.assign(textStyle(t), { source: t.source === 'custom' ? 'custom' : 'show', text: str(t.text, 4000),
      sep: typeof t.sep === 'string' ? t.sep.slice(0, 20) : '   •   ', speed: num(t.speed, 10, 1000, 90), bg: color(t.bg, 'rgba(11,15,23,.9)'), radius: num(t.radius, 0, 2000, 0) });
  } else if (e.type === 'bar') {
    const b = e.bar || {};
    out.bar = { bind: bind(b.bind), value: num(b.value, 0, 100000, 50), max: num(b.max, 1, 100000, 100), dir: ['h', 'rtl', 'v'].includes(b.dir) ? b.dir : 'h',
      fill: color(b.fill, '#3d8bff'), fillBind: bind(b.fillBind), fill2: b.fill2 ? color(b.fill2, '') : '', track: color(b.track, 'rgba(255,255,255,.12)'), radius: num(b.radius, 0, 2000, 999) };
  } else {
    const sl = e.slides || {};
    out.slides = { source: sl.source === 'sponsors' ? 'sponsors' : 'images', images: (Array.isArray(sl.images) ? sl.images : []).slice(0, 30).map(src).filter(Boolean),
      interval: num(sl.interval, 1, 600, 6), fit: ['contain', 'cover', 'fill'].includes(sl.fit) ? sl.fit : 'contain' };
  }
  return out;
}

function cleanBg(b) {
  b = b || {};
  return { mode: ['checker', 'dark', 'light', 'image'].includes(b.mode) ? b.mode : 'checker', src: src(b.src) };
}

function cleanOverlay(o) {
  if (!o || typeof o !== 'object') return null;
  return {
    id: id(o.id, 'co'),
    name: str(o.name, 80).trim() || 'Untitled overlay',
    kind: KINDS.has(o.kind) ? o.kind : 'other',
    w: 1920, h: 1080,
    game: str(o.game, 40),
    bg: cleanBg(o.bg),                       // editor preview background only; never drawn on air
    grid: [0, 8, 16, 32, 48].includes(Number(o.grid)) ? Number(o.grid) : 0,
    elements: (Array.isArray(o.elements) ? o.elements : []).slice(0, MAX_ELEMENTS).map(cleanElement).filter(Boolean),
    updatedAt: Date.now(),
  };
}

function summary(o) {
  return { id: o.id, name: o.name, kind: o.kind || 'other', game: o.game || '', elements: (o.elements || []).length, updatedAt: o.updatedAt || 0 };
}

function createStore(dataDir) {
  const file = path.join(dataDir, 'custom-overlays.json');
  let list = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    list = (Array.isArray(raw && raw.overlays) ? raw.overlays : []).map((o) => Object.assign(cleanOverlay(o) || {}, { updatedAt: o.updatedAt || Date.now() })).filter((o) => o.id);
  } catch (e) { list = []; }
  let saving = null, again = false;
  function persist() {
    if (saving) { again = true; return saving; }
    const body = JSON.stringify({ version: 2, overlays: list });
    saving = fs.promises.writeFile(file + '.tmp', body).then(() => fs.promises.rename(file + '.tmp', file))
      .catch((e) => console.warn('[custom-overlays] save failed:', e && e.message))
      .then(() => { saving = null; if (again) { again = false; return persist(); } });
    return saving;
  }
  return {
    all: () => list,
    get: (oid) => list.find((o) => o.id === oid) || null,
    summaries: () => list.map(summary),
    save(input) {
      const o = cleanOverlay(input);
      if (!o) throw new Error('Not an overlay.');
      const i = list.findIndex((x) => x.id === o.id);
      if (i >= 0) list[i] = o;
      else { if (list.length >= MAX_OVERLAYS) throw new Error('You have ' + MAX_OVERLAYS + ' custom overlays. Delete one first.'); list.unshift(o); }
      persist();
      return o;
    },
    remove(oid) {
      const before = list.length;
      list = list.filter((o) => o.id !== oid);
      if (list.length !== before) persist();
      return list.length !== before;
    },
    flush: () => saving || Promise.resolve(),
  };
}

module.exports = { cleanOverlay, cleanElement, summary, createStore };
