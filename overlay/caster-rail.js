/*
  caster-rail.js — shared bottom "talent + partners" rail for scoreboard scenes.

  A dark pill pinned to the bottom of the 1920x1080 canvas, STACKED and unlabelled:
    top    -> the brand kit's sponsor logos, cross-fading in pages when there are more than fit.
    bottom -> the SHOW DECK talent: the host from casters.showRoles plus everyone in desk slots
              1-4, NAMES ONLY (no role, no @handle), using the same display-name rules as every
              other desk scene (casters.nameMode gamertag/name). A mic mark stands between a
              PAIR of names and sits to the LEFT of a single one.
  Deliberately no "PARTNERS" / "ON THE CALL" headings: on air the logos and the names read as what
  they are, and the labels were the boxiest thing in the graphic.

  Self-contained: injects its own <style>, its own Font Awesome link (for the social glyphs)
  and its own DOM, so a scene only has to do:

      CasterRail.mount({ variant: 'chip' });   // once, at load
      CasterRail.render(data);                 // every full_state tick

  Two shapes, chosen with `variant`:
    'chip' (default) - a compact pill that shrink-wraps its content and sits centred at the bottom
                       of frame, so it reads as one more graphic rather than a band across the feed.
    'bar'            - the full-width version; pass `width` to size it.
  Either way it rises into frame on first show and hides itself when both halves are empty.

  PLACEMENT. Bottom-centre by default. Crew battles fill the bottom of the frame with Smash's own
  per-player HUD, so the card can also be parked in the UPPER LEFT - in the empty margin BESIDE
  player 1's plate, not under it. Pass `anchor` (a selector for the scoreboard) and the card hangs
  its centre on the same line as the centre brand mark (`vAnchor`) and CENTRES itself in the
  margin, so it carries the same air against the edge of frame as it does against the plate. That margin is only ~280px on a 1280-wide board,
  so this placement caps the card to the space that is actually there and drops the sponsors to one
  at a time - it stays a compact block instead of overrunning the plate. Where the position comes from is the scene's
  business: give mount() a `posFrom(data)` and it is re-read on every render.

  Params honoured off the scene's own URL:  ?rail=0  ?casters=0  ?sponsors=0  ?anim=0
                                            ?railrotate=8 (sponsor page seconds)
                                            ?railpos=topleft|bottom (overrides the producer's pick)
  Sponsor pool follows the kit's placement tags STRICTLY: rail-tagged sponsors win, then
  desk-tagged, and nothing else - no untagged fallback, so clearing a sponsor's placements in the
  brand kit actually takes it off the rail.
*/
(function (global) {
  'use strict';

  var PAGE_SIZE_BAR = 4;      // sponsor logos per rotating page, full-width bar
  var PAGE_SIZE_CHIP = 3;     // ...and in the compact centred pill
  var PAGE_SIZE_TL = 1;       // ...and one at a time in the narrow margin beside player 1

  var CSS = [
    '@keyframes crail-rise { from { opacity: 0; transform: translateX(-50%) translateY(16px); }',
    '                         to   { opacity: 1; transform: translateX(-50%) translateY(0); } }',
    '.crail {',
    '  position: absolute; left: 50%; transform: translateX(-50%);',
    '  bottom: var(--crail-bottom, 26px);',
    '  display: flex; flex-direction: column; align-items: stretch;',
    "  font-family: 'Rajdhani', 'Inter', system-ui, sans-serif; text-transform: uppercase;",
    '/* Matches the scoreboard bars up top: same dark gradient, the same 2px inset black frame,',
    '   and squared-off corners instead of a pill so the two graphics read as one set. */',
    '  background: linear-gradient(180deg, #14161f, #06070c);',
    '  border-radius: 4px; overflow: hidden;',
    '  box-shadow: inset 0 0 0 2px rgba(0,0,0,.55), 0 10px 26px rgba(0,0,0,.5);',
    '  opacity: 0; pointer-events: none;',
    '/* A HARD CAP so the card can never sprawl across the feed as sponsors are added — extra',
    '   logos page and cross-fade instead of widening it (see PAGE_SIZE_CHIP / renderSponsors). */',
    '  max-width: var(--crail-max, 720px);',
    '}',
    '/* chip (default): shrink-wrap the content so the pill is only as wide as what is in it */',
    '.crail.show { animation: crail-rise .45s cubic-bezier(.2, .8, .3, 1) .62s both; }',
    '/* Upper-left placement: BESIDE player 1, in the margin outside the board. The card is pinned',
    '   by its RIGHT edge (just off the plate) and grows leftward, so it never creeps under the',
    '   scoreboard as names or logos change. --crail-right/--crail-y/--crail-max are all measured',
    '   off the board at render time. It slides in from the left rather than rising. These rules',
    '   have to out-order .crail / .crail.show - equal specificity, so source order is what wins. */',
    '@keyframes crail-slide-l { from { opacity: 0; transform: translateX(-14px); }',
    '                           to   { opacity: 1; transform: translateX(0); } }',
    '.crail--tl {',
    '  left: var(--crail-left, 40px); right: auto; top: var(--crail-y, 13px); bottom: auto;',
    '  transform: none;',
    '}',
    '.crail--tl.show { animation: crail-slide-l .45s cubic-bezier(.2, .8, .3, 1) .62s both; }',
    '/* Everything tightens up for the narrow slot - a full-size row would just ellipsize away.',
    '   The two rows are sized to add up to bar 1 exactly (38 + 30 = 68px), so the card is flush',
    '   top AND bottom with the player plate beside it. Stacking two full-height rows made it read',
    '   as the tallest thing in the corner, taller than the player card it sits next to. */',
    '.crail--tl .crail-seg { padding: 0 12px; }',
    '.crail--tl .crail-name { font-size: 15px; letter-spacing: .06em; }',
    '.crail--tl .crail-mic svg { width: 17px; height: 17px; }',
    '.crail--tl .crail-people.is-duo { gap: 9px; }',
    '.crail--tl .crail-people { gap: 8px; }',
    '.crail--tl .crail-row--partners { min-height: 38px; }',
    '.crail--tl .crail-row--talent { min-height: 30px; }',
    '.crail--tl .crail-logos { height: 26px; }',
    '.crail--tl .crail-logo { height: 26px; max-width: 190px; }',
    '.crail--bar { width: var(--crail-w, 1660px); border-radius: 10px; }',
    '/* Each stacked row is its own band; the hairline only appears between two live rows. */',
    '.crail-row { display: flex; align-items: stretch; justify-content: center; min-height: 38px; }',
    '/* Sponsors are the paid placement - they get the taller row and the bigger mark. */',
    '.crail-row--partners { min-height: 54px; }',
    '.crail-row.is-empty { display: none; }',
    '/* The divider fades at both ends rather than ruling right across - a full-width line was',
    '   the thing that made two stacked rows read as a box. */',
    '.crail-row + .crail-row:not(.is-empty)::before {',
    "  content: ''; position: absolute; top: 0; left: 12%; right: 12%; height: 1px;",
    '  background: linear-gradient(90deg, transparent, rgba(255,255,255,.14) 25%,',
    '                              rgba(255,255,255,.14) 75%, transparent);',
    '}',
    '.crail-row { position: relative; }',
    '.no-anim .crail.show, body.no-anim .crail.show { animation: none; opacity: 1; }',
    '/* A hairline of accent at the very top, dissolved at both ends so the pill has no hard edge. */',
    '.crail::before {',
    "  content: ''; position: absolute; top: 2px; left: 2px; right: 2px; height: 2px;",
    '  pointer-events: none; z-index: 2;',
    '  background: linear-gradient(90deg, transparent, var(--crail-accent, #29b6f6) 30%,',
    '                              var(--crail-accent, #29b6f6) 70%, transparent);',
    '  opacity: .9;',
    '}',

    '.crail-seg { display: flex; align-items: center; gap: 14px; padding: 0 20px; min-width: 0; flex: 0 0 auto; }',
    '.crail-seg.is-empty { display: none; }',
    '.crail-row--talent .crail-seg { flex: 0 1 auto; }',
    '.crail--bar .crail-seg { gap: 18px; padding: 0 26px; }',


    '/* -- Talent -- */',
    '/* A MIC stands between the names rather than a bullet: on a two-hander it reads as "these two',
    '   are on the call", which a dot never did. With one caster it moves to the left of the name;',
    '   with three or more it leads the row and thin rules separate the names. */',
    '.crail-people { display: flex; align-items: center; gap: 14px; min-width: 0; overflow: hidden; }',
    '.crail-p { display: flex; align-items: center; flex: 0 1 auto; min-width: 0; }',
    '.crail-mic {',
    '  flex: 0 0 auto; display: flex; align-items: center; justify-content: center;',
    '  color: var(--crail-accent, #29b6f6);',
    '}',
    '.crail-mic svg { width: 21px; height: 21px; display: block; fill: currentColor;',
    '  filter: drop-shadow(0 1px 3px rgba(0,0,0,.6)); }',
    '/* The pair is a 3-track grid, not a centred flex run, so the MIC lands on the cards exact',
    '   centre line - under the middle sponsor - instead of being pushed off-axis whenever one',
    '   name is longer than the other. Equal 1fr tracks both size to the wider name, so the mark',
    '   stays put no matter who is on the call. minmax(0,1fr) keeps the ellipsis working. */',
    '.crail-people.is-duo {',
    '  display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);',
    '  align-items: center; gap: 18px;',
    '}',
    '/* Align the NAME inside its track, not the track to the name: justify-self would size each',
    '   item to its content, so a long name overflowed the track and got clipped by the row',
    '   instead of ellipsizing. Stretched items shrink with the track and the ellipsis works. */',
    '.crail-people.is-duo .crail-p:first-child { justify-content: flex-end; }',
    '.crail-people.is-duo .crail-p:last-child { justify-content: flex-start; }',
    '/* 3+ names: a hairline between them, not a dot */',
    '.crail-people.is-list .crail-p + .crail-p { position: relative; padding-left: 14px; }',
    '.crail-people.is-list .crail-p + .crail-p::before {',
    "  content: ''; position: absolute; left: 0; top: 50%; transform: translateY(-50%);",
    '  width: 1px; height: 15px; background: rgba(255,255,255,.2);',
    '}',
    '.crail-name {',
    '  font-size: 19px; font-weight: 800; letter-spacing: .12em; line-height: 1; color: #fff;',
    '  white-space: nowrap; text-shadow: 0 1px 4px rgba(0,0,0,.6);',
    '  overflow: hidden; text-overflow: ellipsis; min-width: 0;',
    '}',
    '.crail--bar .crail-name { font-size: 24px; }',
    '/* -- Sponsors -- */',
    '/* Pages stack on top of each other so they can cross-fade, which means none of them',
    '   contributes intrinsic width - left unmanaged the container collapses and the logos',
    '   spill left over the segment label. Each page shrink-wraps (no `left`) and sizeLogos()',
    '   sets the container to the widest one once the images have their dimensions. */',
    '.crail-logos { position: relative; flex: 0 0 auto; height: 38px; }',
    '.crail-page {',
    '  position: absolute; top: 0; bottom: 0; right: 0;',
    '  display: flex; align-items: center; justify-content: flex-end;',
    '  gap: 26px; opacity: 0; transition: opacity .6s ease;',
    '}',
    '.crail-page.on { opacity: 1; }',
    '/* flex: 0 0 auto is load-bearing - a shrinkable logo collapses inside the zero-width',
    '   container it is measured in, and sizeLogos() then locks in that collapsed width. */',
    '/* An explicit HEIGHT, not max-height: an SVG uploaded with only a viewBox has no intrinsic',
    '   size, so a max-height rule leaves it to shrink-to-fit and it renders postage-stamp small.',
    '   flex: 0 0 auto keeps it from collapsing while sizeLogos() is measuring the page. */',
    '.crail-logo { flex: 0 0 auto; height: 36px; width: auto; max-width: 150px; object-fit: contain; display: block; }',
    '.crail--bar .crail-logos { height: 48px; }',
    '.crail--bar .crail-logo { height: 46px; max-width: 230px; }'
  ].join('\n');

  var mounted = false;
  var opts = {};
  var QP = new URLSearchParams(global.location.search);
  var SHOW_RAIL = QP.get('rail') !== '0';
  // ?casters=0 always wins; otherwise a scene can mount sponsors-only with { casters:false }.
  // A bracket board wants the partner logos but not the desk lineup.
  function showCasters() {
    if (QP.get('casters') === '0') return false;
    return !(opts && opts.casters === false);
  }
  var SHOW_SPONSORS = QP.get('sponsors') !== '0';
  var ROTATE_PARAM = Number(QP.get('railrotate')) || 0;

  var elRail, elCastSeg, elPeople, elSponSeg, elLogos;
  var _sponsorSig = '';
  var _sponsorTimer = null;
  var _peopleSig = '';

  function str(v) { return (v == null ? '' : String(v)).trim(); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  function mount(o) {
    if (mounted) return;
    mounted = true;
    opts = o || {};

    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    if (QP.get('anim') === '0') document.body.classList.add('no-anim');
    elRail = document.createElement('div');
    elRail.className = 'crail' + (opts.variant === 'bar' ? ' crail--bar' : '');
    if (opts.width) elRail.style.setProperty('--crail-w', opts.width + 'px');
    if (opts.bottom != null) elRail.style.setProperty('--crail-bottom', opts.bottom + 'px');
    elRail.innerHTML =
      '<div class="crail-row crail-row--partners is-empty">' +
        '<div class="crail-seg crail-seg--sponsors"><div class="crail-logos"></div></div>' +
      '</div>' +
      '<div class="crail-row crail-row--talent is-empty">' +
        '<div class="crail-seg crail-seg--casters"><div class="crail-people"></div></div>' +
      '</div>';
    document.body.appendChild(elRail);

    elCastSeg = elRail.querySelector('.crail-row--talent');
    elPeople = elRail.querySelector('.crail-people');
    elSponSeg = elRail.querySelector('.crail-row--partners');
    elLogos = elRail.querySelector('.crail-logos');
  }

  /* The Show Deck's HOST lives in casters.showRoles.host as a bare NAME - it never reaches
     casters.list, which is built only from the slot lineup. Resolve them against the caster
     library and then the crew roster so the host arrives with the same handle/social/country
     as anyone in a slot; without this the person opening the show was the one name missing
     from the on-air talent line. */
  function hostEntry(data) {
    var casters = data.casters || {};
    var name = str((casters.showRoles || {}).host);
    if (!name) return null;
    var key = name.toLowerCase();
    var match = function (list) {
      return (list || []).find(function (c) {
        if (!c) return false;
        return str(c.name).toLowerCase() === key
            || str(c.gamertag).toLowerCase() === key
            || str(c.handle).toLowerCase() === key;
      }) || null;
    };
    var hit = match(casters.library) || match(data.crew) || { name: name };
    // Route it through the same display-name rules the slots get (nameMode gamertag/name).
    var shown = SceneBase._casterDisplay ? SceneBase._casterDisplay(casters, hit) : hit;
    return { profile: shown, role: str(hit.role) || 'Host' };
  }

  /* Show Deck talent -> [{name, role, handle, social}]. Host first (they open the show), then
     desk slots 1-4, slot-resolved so an unassigned slot stays empty rather than borrowing the
     next caster's feed. Deduped by name, since a host is often also in a slot. */
  function people(data) {
    var casters = data.casters || {};
    if (!showCasters()) return [];
    if (typeof SceneBase === 'undefined') return [];

    // NOT gated on casters.visible: that flag is the caster-CAM desk's on-air toggle, and a
    // producer running a Smash board never turns it on - so the talent row silently never
    // appeared. Whoever is on the Show Deck is on the call, regardless of whether their cameras
    // are up. ?casters=0 is the way to switch this row off.
    var entries = [];
    var host = hostEntry(data);
    if (host) entries.push(host);
    SceneBase.castersBySlots(casters, Number(opts.casterSlots) || 4).forEach(function (c) {
      if (c) entries.push({ profile: c, role: str(c.role) });
    });

    // NAMES ONLY. Roles and @handles turned a one-line strip into three columns of small print
    // that nobody reads at broadcast distance; the desk scenes are where the socials belong.
    var seen = {};
    var out = [];
    entries.forEach(function (e) {
      var name = str(e.profile && e.profile.name);
      if (!name) return;
      var key = name.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push(name);
    });
    return out;
  }

  /* Inline SVG, not an icon font: the rail dropped its Font Awesome link when the handles went,
     and a broadcast graphic should not depend on a webfont loading in time. */
  var MIC_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M12 14.5a3.2 3.2 0 0 0 3.2-3.2V5.2a3.2 3.2 0 1 0-6.4 0v6.1A3.2 3.2 0 0 0 12 14.5z"/>'
    + '<path d="M17.6 11.3a5.6 5.6 0 0 1-11.2 0H4.6a7.4 7.4 0 0 0 6.5 7.3V21H8.9v1.8h6.2V21h-2.2v-2.4a7.4 7.4 0 0 0 6.5-7.3h-1.8z"/>'
    + '<path d="M4.5 8.9a3.7 3.7 0 0 0 0 6.2M19.5 8.9a3.7 3.7 0 0 1 0 6.2" stroke="currentColor" '
    +   'stroke-width="1.9" stroke-linecap="round" fill="none" opacity=".7"/>'
    + '</svg>';

  function renderPeople(data) {
    var list = people(data);
    var sig = list.join('~');
    elCastSeg.classList.toggle('is-empty', !list.length);
    if (sig === _peopleSig) return;
    _peopleSig = sig;
    var mic = '<span class="crail-mic">' + MIC_SVG + '</span>';
    var nameHtml = function (n) { return '<div class="crail-p"><span class="crail-name">' + esc(n) + '</span></div>'; };
    var html;
    if (list.length === 2) html = nameHtml(list[0]) + mic + nameHtml(list[1]);   // mic between the pair
    else if (list.length) html = mic + list.map(nameHtml).join('');              // 1 or 3+: mic leads
    else html = '';
    elPeople.className = 'crail-people'
      + (list.length === 2 ? ' is-duo' : '')
      + (list.length > 2 ? ' is-list' : '');
    elPeople.innerHTML = html;
  }

  /* Sponsor pool: ONLY what the active brand kit has tagged for a placement - rail first, then
     desk. Deliberately NOT falling back to brand.sponsors (which is every sponsor in the kit
     regardless of placement), nor pulling in brand.spots.title or the manual deskFooter override:
     all three kept partners on screen after the producer had removed them from the kit, because
     they are populated from different fields than the placement tags. Untagged = not on this rail.
     Accepts both kit shapes: {name,logo} objects and bare URL strings. */
  function sponsorLogos(data) {
    if (!SHOW_SPONSORS) return [];
    var brand = data.brand || {};
    var pool = (brand.railSponsors || []).length ? brand.railSponsors : (brand.deskSponsors || []);
    var out = [];
    (pool || []).forEach(function (s) {
      var u = (typeof s === 'string') ? s : (s && s.logo);
      if (u && out.indexOf(u) === -1) out.push(u);
    });
    return out;
  }

  /* Reserve room for the widest page. Runs again on every logo load because a not-yet-decoded
     image has no width to measure. */
  function sizeLogos() {
    var w = 0;
    [].forEach.call(elLogos.children, function (pg) { w = Math.max(w, pg.scrollWidth); });
    elLogos.style.width = w ? (w + 'px') : '';
    placeCard();                                 // the card's width just changed - re-centre it
  }

  function renderSponsors(data) {
    var logos = sponsorLogos(data);
    var sig = logos.join('|');
    if (sig === _sponsorSig) return;                   // unchanged - never restart the cycle
    _sponsorSig = sig;
    if (_sponsorTimer) { clearInterval(_sponsorTimer); _sponsorTimer = null; }
    elLogos.innerHTML = '';
    elSponSeg.classList.toggle('is-empty', !logos.length);
    if (!logos.length) return;

    var pages = [];
    var per = (opts.variant === 'bar') ? PAGE_SIZE_BAR
            : (_pos === 'topleft') ? PAGE_SIZE_TL : PAGE_SIZE_CHIP;
    for (var i = 0; i < logos.length; i += per) pages.push(logos.slice(i, i + per));
    pages.forEach(function (page, pi) {
      var wrap = document.createElement('div');
      wrap.className = 'crail-page' + (pi === 0 ? ' on' : '');
      page.forEach(function (src) {
        var img = document.createElement('img');
        img.className = 'crail-logo'; img.src = src; img.alt = '';
        img.addEventListener('load', sizeLogos);
        wrap.appendChild(img);
      });
      elLogos.appendChild(wrap);
    });
    sizeLogos();
    if (pages.length < 2) return;

    var secs = ROTATE_PARAM > 0 ? ROTATE_PARAM
             : (Number((data.brand || {}).sponsorInterval) > 0 ? Number(data.brand.sponsorInterval) : 8);
    var idx = 0;
    _sponsorTimer = setInterval(function () {
      var kids = elLogos.children;
      if (kids.length < 2) return;
      kids[idx].classList.remove('on');
      idx = (idx + 1) % kids.length;
      kids[idx].classList.add('on');
    }, Math.max(3, secs) * 1000);
  }

  /* Where the card sits. The scene owns the decision (its own state key, its own default) and
     hands it over through mount().posFrom; ?railpos= on the source URL beats both, so a producer
     can park one browser source differently without touching the show state. */
  var _pos = '';
  function applyPos(data) {
    var want = QP.get('railpos') || (opts.posFrom ? opts.posFrom(data) : '') || 'bottom';
    want = (want === 'topleft') ? 'topleft' : 'bottom';
    var tl = want === 'topleft';
    if (want !== _pos) {
      _pos = want;
      elRail.classList.toggle('crail--tl', tl);
      // The two placements page sponsors differently (3-up vs 1-up), and renderSponsors bails
      // early when the logo list is unchanged - so force it to re-chunk on a placement change.
      _sponsorSig = '';
    }
    if (!tl) elRail.style.removeProperty('--crail-max');
  }

  /* Runs AFTER the rows are filled, because centring needs the card's real width. Measured every
     tick rather than once: the board moves with ?top= and ?w=, and the card's own width moves with
     the names and the sponsor page. sizeLogos() calls this again once the logos have decoded. */
  function placeCard() {
    if (_pos !== 'topleft' || !elRail) return;
    var a = opts.anchor && document.querySelector(opts.anchor);
    if (!a) return;
    var r = a.getBoundingClientRect();
    if (!r.width) return;                       // board not up yet - keep the last good numbers
    var gap = (opts.gap != null ? opts.gap : 22);   // breathing room between card and plate
    var edge = 20;                                  // ...and against the edge of frame
    var avail = Math.max(150, Math.round(r.left - gap - edge));
    elRail.style.setProperty('--crail-max', avail + 'px');

    var box = elRail.getBoundingClientRect();
    // Centred in the margin, not pinned to the plate: right-anchoring it put all the slack on the
    // outside, so the card crowded player 1 while ~130px sat empty against the edge of frame.
    elRail.style.setProperty('--crail-left', Math.round(edge + Math.max(0, (avail - box.width) / 2)) + 'px');
    // Vertically it rides the CENTRE BRAND MARK's line, which is centred on the whole two-bar
    // stack rather than on bar 1 - so the card reads as the left-hand partner to the mark instead
    // of as a second, taller plate stacked against player 1. Falls back to the board's own centre.
    var m = opts.vAnchor && document.querySelector(opts.vAnchor);
    var mr = m && m.getBoundingClientRect();
    var cy = (mr && mr.height) ? (mr.top + mr.height / 2) : (r.top + r.height / 2);
    elRail.style.setProperty('--crail-y', Math.round(cy - box.height / 2) + 'px');
  }

  function render(data) {
    if (!mounted || !SHOW_RAIL) return;
    data = data || {};
    if (typeof SceneBase !== 'undefined') {
      elRail.style.setProperty('--crail-accent', SceneBase.brandColor(data) || '#29b6f6');
    }
    applyPos(data);
    renderPeople(data);
    renderSponsors(data);
    placeCard();
    // The whole rail hides when there is nothing on either side - an empty bar across the
    // bottom of the feed is worse than no bar.
    var any = !elCastSeg.classList.contains('is-empty') || !elSponSeg.classList.contains('is-empty');
    elRail.classList.toggle('show', any);
  }

  global.CasterRail = { mount: mount, render: render };
})(window);
