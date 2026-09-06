/*
  stream-platforms.js — canonical streaming-platform registry (icon + brand colour + label).

  ONE list, shared by every consumer so a channel badged on the bracket's pairings card and the
  same channel badged on the desk rail get the identical glyph and colour:
    · overlays        <script src="/stream-platforms.js">            (served off :3000)
    · control panel   <script src="../overlay/stream-platforms.js">  (runs from file://)

  The platform comes from start.gg's `streamSource` enum, captured per stream-queue row in
  server.js as `queue[].platform` (TWITCH / YOUTUBE / …). That enum is narrow and start.gg does
  not model every platform a TO actually streams on — Kick above all — so meta() also sniffs the
  CHANNEL NAME as a fallback before giving up on the generic broadcast mark.

  Plain global (no modules) because the control panel is a file:// page. Everything is on
  window.StreamPlatforms.
*/
(function (root) {
  'use strict';

  // key: matches start.gg's streamSource lowercased where one exists.
  // color: the platform's own brand colour — these are the marks viewers recognise at a glance,
  //        so they are deliberately NOT themed by the brand kit.
  // sniff: patterns for reading the platform off a channel name when the source is unknown.
  var PLATFORMS = [
    { key: 'twitch',   label: 'Twitch',   color: '#a970ff', sniff: /twitch|ttv/,
      icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/></svg>' },
    { key: 'youtube',  label: 'YouTube',  color: '#ff4e45', sniff: /youtube|youtu\.be|\byt\b/,
      icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12z"/></svg>' },
    { key: 'kick',     label: 'Kick',     color: '#53fc18', sniff: /kick/,
      icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 3h6v4.5h1.5V6h1.5V4.5H15V3h6v6h-1.5v1.5H18V12h1.5v1.5H21V21h-6v-1.5h-1.5V18H12v-1.5h-1.5V21H3V3z"/></svg>' },
    { key: 'facebook', label: 'Facebook', color: '#4c8bf5', sniff: /facebook|fb\.gg/,
      icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M24 12a12 12 0 1 0-13.875 11.854v-8.385H7.078V12h3.047V9.356c0-3.007 1.792-4.669 4.533-4.669 1.313 0 2.686.235 2.686.235v2.953H15.83c-1.49 0-1.955.925-1.955 1.874V12h3.328l-.532 3.469h-2.796v8.385A12.002 12.002 0 0 0 24 12z"/></svg>' }
  ];
  // Unknown platform: a plain play mark rather than nothing, so the row keeps its layout and the
  // channel still reads as "a stream".
  var GENERIC = { key: 'generic', label: 'Stream', color: '', sniff: null,
    icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>' };

  var byKey = {};
  PLATFORMS.forEach(function (p) { byKey[p.key] = p; });
  byKey.generic = GENERIC;
  // start.gg spells a couple of its sources differently to the platform's own name.
  var ALIAS = { mixer: 'generic', beam: 'generic', hitbox: 'generic', streamme: 'generic',
                smashcast: 'generic', 'youtube_gaming': 'youtube', yt: 'youtube', ttv: 'twitch' };

  // Resolve a start.gg streamSource (+ the channel name as a fallback) to one platform entry.
  function resolve(source, name) {
    var k = String(source || '').toLowerCase().trim();
    if (ALIAS[k]) k = ALIAS[k];
    if (byKey[k] && k !== 'generic') return byKey[k];
    var n = String(name || '').toLowerCase();
    for (var i = 0; i < PLATFORMS.length; i++) {
      if (PLATFORMS[i].sniff && PLATFORMS[i].sniff.test(n)) return PLATFORMS[i];
    }
    return GENERIC;
  }
  // What a renderer needs in one call: the CSS hook, the glyph, the colour and a display label.
  function meta(source, name) {
    var p = resolve(source, name);
    return { key: p.key, cls: 'plat-' + p.key, icon: p.icon, color: p.color, label: p.label };
  }
  // `<style>` text colouring each platform's glyph — lets a scene adopt the palette without
  // re-listing every hex in its own stylesheet (and drifting when a platform is added here).
  // `before` is the element carrying the .plat-<key> class, `after` the glyph inside it, e.g.
  // cssRules('.mb-chan', ' .mb-plat')  ->  ".mb-chan.plat-twitch .mb-plat { color: #a970ff; }"
  function cssRules(before, after) {
    var b = before || '', a = after || '';
    return PLATFORMS.map(function (p) {
      return b + '.plat-' + p.key + a + ' { color: ' + p.color + '; }';
    }).join('\n');
  }

  root.StreamPlatforms = {
    list: PLATFORMS,
    generic: GENERIC,
    byKey: byKey,
    resolve: resolve,
    meta: meta,
    cssRules: cssRules
  };
})(typeof window !== 'undefined' ? window : this);
