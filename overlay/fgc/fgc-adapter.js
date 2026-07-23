/* fgc-adapter.js — bridges our suite's full_state into the FGCasterOverlay templates.
 *
 * Loads AFTER the template's inline renderer (which registered an `update_scoreboard`
 * handler through fgc-bridge.js's io() stub) and AFTER scene-base.js. On every state
 * frame from the :3001 WS bridge it maps our canonical match model onto the flat `data`
 * shape the templates expect, then fans it out via window.__fgcEmit.
 *
 * The whole point of the port: the two competitors, their scores, their org/team names,
 * the event/round text and the caster credits all come from the SAME state the rest of
 * the production suite already edits (Match ▸ Teams, series score, casters lineup). A
 * producer never fills in a second, parallel data source.
 *
 * Field mapping (our full_state  →  FGC data):
 *   teams.blue / teams.orange     → player1 / player2  (+ team1 / team2 when it's an org)
 *   series.blue / series.orange   → player{1,2}.score
 *   roster player country         → player{1,2}.img    (country flag svg)
 *   eventName                     → toptext            (center banner)
 *   roundLabel                    → stage              (bracket round)
 *   bestOf / match.format         → match_type         ("BO5")
 *   casters.list[0..1]            → caster1 / caster2   (name + social handle)
 */
(function () {
  'use strict';

  var FLAG_BASE = '/fgc/static/flags/flags/1x1/';

  function str(v) { return (v == null ? '' : String(v)).trim(); }
  function firstNonEmpty() {
    for (var i = 0; i < arguments.length; i++) { var v = str(arguments[i]); if (v) return v; }
    return '';
  }

  // The roster's country ISO code for the flag — our editor stores a lowercase ISO alpha-2 in
  // `country`; start.gg imports use `countryCode`; the profile registry backs both up.
  function countryCode(p, prof) {
    return firstNonEmpty(p && p.country, p && p.countryCode, prof && prof.countryCode, prof && prof.country).toLowerCase();
  }

  // The active/on-air roster member for a side — the one actually competing, chosen in
  // Match ▸ Teams (state.activePlayer[side] = player id). '' or a stale id → the first player.
  function activeMemberIndex(roster, activeId) {
    if (activeId) {
      for (var i = 0; i < roster.length; i++) {
        if (roster[i] && String(roster[i].id) === String(activeId)) return i;
      }
    }
    return 0;
  }

  // Resolve a competitor "side" (our team object) into the FGC player row + the team row.
  //   - Player row = the ACTIVE roster member (name + their country flag), so a multi-player
  //     team (2XKO included) shows only whoever is currently competing this round.
  //   - Team row (secondary line) = the org name + logo; its score is the team RECORD, applied
  //     separately in applyTeamRecords() — the FGC "teams on a second line" layout.
  //   - With no roster the side name itself is the player, and the team row stays empty so it
  //     doesn't duplicate the player row.
  function mapSide(team, seriesScore, profiles, activeId) {
    team = team || {};
    var roster = Array.isArray(team.players) ? team.players : [];
    var teamName = str(team.name);

    var idx = activeMemberIndex(roster, activeId);
    var pA = roster[idx] || null;
    var prof = null, gamertag = '';
    if (pA) {
      gamertag = firstNonEmpty(pA.gamertag, pA.name, pA.primaryid);
      prof = profiles[gamertag.toLowerCase()] || null;
    }

    // Always the SINGLE active competitor — including on the 2XKO tag skin. A team can hold
    // several players; only the one selected in Match ▸ Teams (or the first) is shown.
    var playerName = gamertag || teamName;

    // Player row image = the active player's COUNTRY FLAG (matches the FGC layout — flags by
    // the name, org identity lives on the team row below).
    var cc = pA ? countryCode(pA, prof) : '';
    var playerImg = cc ? (FLAG_BASE + cc + '.svg') : '';

    // Top bar shows the PLAYER name only — the org/team lives on the team row below, so no
    // "TEAM | player" prefix up top.
    var clan = '';

    var player = {
      name: playerName, id: '', clan: clan, wl: '',
      score: Number(seriesScore) || 0,   // TOP score = the set score (adjusted in Match ▸ Teams)
      character: '', img: playerImg, profile: ''
    };

    // Team row (secondary line): the org name + logo. Its SCORE is the team RECORD, not the set
    // score — that's set separately in applyTeamRecords() (the template's score field only takes a
    // number, so the record string is written straight to the element after render).
    var teamPlaque = { name: '', score: 0, img: '', profile: '' };
    if (pA && teamName) {
      teamPlaque.name = teamName;
      teamPlaque.img = str(team.logo);
    }

    return { player: player, team: teamPlaque };
  }

  // Desk display name, matching scene-base.js._casterDisplay so the FGC casters read the SAME as
  // every other desk scene: the crew GAMERTAG by default (casters.nameMode 'gamertag'), the crew
  // profile's legal name only when the producer flips the SHOW DECK name toggle to 'name'. ONLY
  // `gamertag` qualifies as a display name — `handle` is the @social username and must never become
  // the on-air first name. No gamertag → fall back to the profile name.
  function casterDisplayName(c, nameMode) {
    if (!c) return '';
    var tag = str(c.gamertag).replace(/^@/, '');
    if (nameMode !== 'name' && tag) return tag;
    return firstNonEmpty(c.name, tag, c.handle);
  }

  // casters.list entry → FGC caster {name, twitch, twitter, youtube, instagram}.
  // Our lineup stores ONE social ({social:'twitch', socialHandle:'foo'}) per person; drop it
  // into the matching FGC slot so the template's social-cycle picks it up.
  function mapCaster(c, nameMode) {
    var out = { name: '', twitch: '', twitter: '', youtube: '', instagram: '' };
    if (!c) return out;
    out.name = casterDisplayName(c, nameMode);
    var platform = str(c.social).toLowerCase();
    var handle = firstNonEmpty(c.socialHandle, c.handle);
    if (handle && out.hasOwnProperty(platform)) out[platform] = handle;
    return out;
  }

  function bestOfLabel(state) {
    var fmt = str(state.match && state.match.format);
    if (fmt) return fmt;                         // producer-set label wins ("FT2", "BO7", …)
    var bo = Number(state.bestOf);
    return bo > 0 ? ('BO' + bo) : '';
  }

  function mapState(state) {
    state = state || {};
    var teams = state.teams || {};
    var series = state.series || {};
    var profiles = state.playerProfiles || {};

    var active = state.activePlayer || {};
    var a = mapSide(teams.blue, series.blue, profiles, active.blue);
    var b = mapSide(teams.orange, series.orange, profiles, active.orange);

    var nameMode = (state.casters && state.casters.nameMode) === 'name' ? 'name' : 'gamertag';
    var casters = (state.casters && Array.isArray(state.casters.list)) ? state.casters.list : [];
    var ordered = casters.slice().sort(function (x, y) {
      return (Number(x.slot) || 99) - (Number(y.slot) || 99);
    });

    // Centre block is stacked (see fgc-redesign.css): #topText = EVENT NAME on top; the secondary
    // line pairs #stageText = ROUND/STAGE with #matchTypeText = MATCH LABEL.
    var toptext = firstNonEmpty(state.eventName);
    var stage = firstNonEmpty(state.roundLabel, state.match && state.match.division);   // round/stage
    var matchLabel = firstNonEmpty(state.gameLabel, bestOfLabel(state));                // match label

    return {
      player1: a.player,
      player2: b.player,
      team1: a.team,
      team2: b.team,
      stage: stage,
      match_type: matchLabel,
      toptext: toptext,
      top_text: toptext,                          // some template branches read the snake_case key
      caster1: mapCaster(ordered[0], nameMode),
      caster2: mapCaster(ordered[1], nameMode),
      commentators: ordered.map(function (c) { return { name: casterDisplayName(c, nameMode) }; })
    };
  }

  // ── Colour maths (done in JS so the CSS carries CONCRETE hex — never color-mix()) ──────────
  // color-mix() isn't supported in older CEF (the browser inside some OBS builds); a color-mix
  // declaration is dropped at parse time there, so a skin's plaque falls back to its DEFAULT
  // colour (e.g. SF6 stays pink) instead of the brand colour. Precomputing the ramp here and
  // feeding plain hex vars makes the brand colours work in every browser source.
  function _hexToRgb(hex) {
    hex = String(hex || '').trim().replace(/^#/, '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
    var n = parseInt(hex, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function _rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(function (x) {
      return Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
    }).join('');
  }
  // Blend `hex` toward `target` (hex string) by amt (0..1). Returns a hex string (or hex unchanged).
  function mix(hex, target, amt) {
    var c = _hexToRgb(hex), t = _hexToRgb(target);
    if (!c || !t) return hex;
    return _rgbToHex(c[0] + (t[0] - c[0]) * amt, c[1] + (t[1] - c[1]) * amt, c[2] + (t[2] - c[2]) * amt);
  }

  // Colour the two plaques with each side's OWN colour — INDEPENDENT of the global colour-mode
  // selector — and place the brand logo left of the event name. Uses `ownColor` (the raw per-team
  // colour the server keeps alongside the mode-effective `color`). fgc-brand.css turns the per-side
  // hex vars into the plaque gradient/stroke/glow; fgc-redesign.css uses --fgc-brand-logo.
  var DARK = '#05070d';
  function setSideVars(root, n, c) {
    var hi = mix(c, '#ffffff', 0.14);
    var d1 = mix(c, DARK, 0.18);
    root.style.setProperty('--brand-p' + n, c);
    root.style.setProperty('--p' + n + '-hi', hi);
    root.style.setProperty('--p' + n + '-d1', d1);
    root.style.setProperty('--p' + n + '-d2', mix(c, DARK, 0.36));
    root.style.setProperty('--p' + n + '-stroke', mix(c, '#ffffff', 0.52));

    // Direct SVG paint — CEF does NOT substitute var() written INSIDE an SVG presentation attribute
    // (stop-color="var(--gradient-stop-1, #15bcba)" / flood-color="var(--glow-color, #F70041)"), so
    // the gradient FILL and the glow otherwise stay pinned to their hard-coded fallbacks — the
    // #F70041 pink — no matter what Match ▸ Teams is set to. (The plaque stroke DOES follow, because
    // fgc-brand.css sets `stroke` as a real CSS property.) Writing the stop/flood values straight
    // onto the elements guarantees the body + halo also follow the team colour. Runs every frame, so
    // it survives the template renderer swapping the noimg/full plaque variants.
    var ramp = { 0: hi, last: d1, mid: c };
    ['noimg', 'full'].forEach(function (kind) {
      var grad = document.getElementById('linear-gradient-p' + n + '-' + kind);
      if (!grad) return;
      var stops = grad.querySelectorAll('stop');
      for (var i = 0; i < stops.length; i++) {
        stops[i].setAttribute('stop-color', i === 0 ? ramp[0] : (i === stops.length - 1 ? ramp.last : ramp.mid));
      }
    });
    var glow = document.getElementById('coloredGlow_p' + n);
    var flood = glow && glow.querySelector('feFlood');
    if (flood) { flood.setAttribute('flood-color', c); flood.setAttribute('flood-opacity', '0.55'); }
  }
  function applyBrandColors(state) {
    var rootEl = document.documentElement;
    var teams = (state && state.teams) || {};
    var b = teams.blue || {}, o = teams.orange || {};
    // Use the MODE-EFFECTIVE colour (`color`) — the value the server already resolves per the
    // Match ▸ Teams colour segment (Team / Brand / Default / In-Game), same as every other overlay.
    // (`ownColor` is the raw saved team colour and ignores the mode — using it pinned both plaques
    // to whatever the two teams were saved as, even when they were the same colour.)
    var p1 = str(b.color || b.ownColor);
    var p2 = str(o.color || o.ownColor);

    // Brand logo → shown left of the event name (fgc-redesign.css #topText::before).
    var logo = str((state && state.brand && state.brand.logo));
    if (logo) {
      rootEl.style.setProperty('--fgc-brand-logo', 'url("' + logo.replace(/"/g, '%22') + '")');
      rootEl.classList.add('fgc-has-logo');
    } else {
      rootEl.classList.remove('fgc-has-logo');
    }

    if (!p1 && !p2) { rootEl.classList.remove('fgc-brand'); return; }
    if (p1) setSideVars(rootEl, '1', p1);
    if (p2) setSideVars(rootEl, '2', p2);
    rootEl.classList.add('fgc-brand');
  }
  window.__fgcApplyBrandColors = applyBrandColors;

  // ── Diagnostic (add ?debug=1 to the browser-source URL) ────────────────────
  // Prints, on-screen, exactly what the overlay is receiving so we can tell a STATE problem
  // (team colours arriving empty → plaques stay default) apart from a CACHE/render problem
  // (colours present + painted, but the source is running an old cached build).
  var _DEBUG = /(?:^|[?&])debug=1(?:&|$)/.test(location.search);
  var _dbgEl = null;
  function showDebug(state) {
    if (!_dbgEl) {
      _dbgEl = document.createElement('div');
      _dbgEl.style.cssText = 'position:fixed;top:8px;left:8px;z-index:99999;background:rgba(0,0,0,.85);'
        + 'color:#0f0;font:12px/1.5 monospace;padding:8px 12px;border-radius:6px;white-space:pre;pointer-events:none;';
      (document.body || document.documentElement).appendChild(_dbgEl);
    }
    var t = (state && state.teams) || {}, b = t.blue || {}, o = t.orange || {};
    var g1 = document.getElementById('linear-gradient-p1-full');
    var painted = g1 && g1.querySelector('stop') ? g1.querySelector('stop').getAttribute('stop-color') : '(no gradient)';
    _dbgEl.textContent =
      'FGC adapter LIVE — build 2\n' +
      'blue.ownColor=' + (b.ownColor || '(none)') + '  blue.color=' + (b.color || '(none)') + '\n' +
      'orange.ownColor=' + (o.ownColor || '(none)') + '  orange.color=' + (o.color || '(none)') + '\n' +
      'colorMode=' + (state && state.colorMode || '(none)') + '\n' +
      '.fgc-brand=' + document.documentElement.classList.contains('fgc-brand') + '\n' +
      'p1 first stop-color=' + painted;
  }

  // The team row's SCORE = the team RECORD (season W-L / points / placement — whatever metric is
  // set in Match ▸ Teams ▸ Team Record), NOT the set score on the player row. The template's score
  // field only renders a number, so we write the resolved record STRING straight to the element
  // AFTER the template has rendered. Empty when no record is configured → the team row just shows
  // name + logo. state.teamRecords is the server's resolved {enabled, blue, orange} blob.
  function applyTeamRecords(state) {
    var tr = (state && state.teamRecords) || {};
    var rec1 = tr.enabled ? str(tr.blue) : '';
    var rec2 = tr.enabled ? str(tr.orange) : '';
    var t1 = document.getElementById('team1Score');
    var t2 = document.getElementById('team2Score');
    if (t1) { t1.textContent = rec1; t1.classList.toggle('fgc-team-record', !!rec1); }
    if (t2) { t2.textContent = rec2; t2.classList.toggle('fgc-team-record', !!rec2); }
  }
  window.__fgcApplyTeamRecords = applyTeamRecords;

  // ── Single-caster layout ──────────────────────────────────────────────────
  // With one caster the template still lays out two 130px name slots with the mic between them,
  // so the lone name sits left-of-centre with dead space to its right. Flag the single-caster
  // case on <html> and let fgc-redesign.css collapse the empty second slot and drop the mic
  // to the LEFT of the single name, centred as one unit.
  function casterNameCount(state) {
    var list = (state && state.casters && Array.isArray(state.casters.list)) ? state.casters.list : [];
    var nameMode = (state.casters && state.casters.nameMode) === 'name' ? 'name' : 'gamertag';
    var n = 0;
    for (var i = 0; i < list.length; i++) { if (str(casterDisplayName(list[i], nameMode))) n++; }
    return n;
  }
  function applyCasterLayout(state) {
    document.documentElement.classList.toggle('fgc-single-caster', casterNameCount(state) === 1);
  }
  window.__fgcApplyCasterLayout = applyCasterLayout;

  // ── Sponsor rail (bottom, under the casters) ──────────────────────────────
  // The FGC skins have no sponsor row of their own, so the adapter injects one slim rail at the
  // bottom edge and fills it from the active brand kit's sponsors (state.brand.sponsors — the same
  // source the standalone sponsor-rail.html uses). Shown only when there are sponsor logos.
  var _railEl = null, _railSig = '';
  function ensureRail() {
    if (_railEl) return _railEl;
    _railEl = document.createElement('div');
    _railEl.id = 'fgc-sponsor-rail';
    _railEl.className = 'fgc-sponsor-rail';
    (document.body || document.documentElement).appendChild(_railEl);
    return _railEl;
  }
  function applySponsorRail(state) {
    var brand = (state && state.brand) || {};
    var all = Array.isArray(brand.sponsors) ? brand.sponsors : [];
    // Sponsors flagged for the rail placement (matches sponsor-rail.html); if none are explicitly
    // flagged, fall back to any sponsor that has a logo so the rail isn't silently empty.
    var railed = all.filter(function (s) { return s && s.logo && s.placements && s.placements.rail; });
    var logos = (railed.length ? railed : all.filter(function (s) { return s && s.logo; }))
      .map(function (s) { return { name: str(s.name), logo: str(s.logo) }; });
    // An explicit empty label (brand kit) renders NO heading + NO separator — just the logos. Only a
    // MISSING label (null/undefined) falls back to 'PARTNERS'.
    var label = brand.sponsorLabel == null ? 'PARTNERS' : str(brand.sponsorLabel);

    var sig = label + '::' + logos.map(function (l) { return l.logo; }).join('|');
    if (sig === _railSig) return;
    _railSig = sig;

    var rail = ensureRail();
    // Casters sit at the very bottom edge, so make room: shift them up (CSS) only when sponsors show.
    document.documentElement.classList.toggle('fgc-has-sponsors', logos.length > 0);
    if (!logos.length) { rail.className = 'fgc-sponsor-rail'; rail.innerHTML = ''; return; }
    rail.innerHTML = label ? '<span class="fgc-spon-label"></span><span class="fgc-spon-sep"></span>' : '';
    if (label) rail.querySelector('.fgc-spon-label').textContent = label;
    logos.forEach(function (l) {
      var img = document.createElement('img');
      img.className = 'fgc-spon-logo';
      img.src = l.logo; img.alt = l.name;
      img.onerror = function () { img.style.display = 'none'; };
      rail.appendChild(img);
    });
    rail.className = 'fgc-sponsor-rail show';
  }
  window.__fgcApplySponsorRail = applySponsorRail;

  // Expose for headless verification / debugging.
  window.__fgcMapState = mapState;

  // Force the FontAwesome icon fonts to download NOW, on load — the caster mic/social icons start
  // display:none, so the webfont isn't fetched until an icon first shows, which makes the headset
  // pop in a beat AFTER the (already-loaded) caster name. Rendering the real icon classes off-screen
  // triggers the fetch up front (version-agnostic: uses whatever families/glyphs the icons use).
  function preloadCasterIcons() {
    try {
      var probe = document.createElement('div');
      probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none;font-size:24px;';
      probe.innerHTML =
        '<i class="fa-solid fa-headset"></i><i class="fa-brands fa-twitch"></i>'
        + '<i class="fa-brands fa-x-twitter"></i><i class="fa-brands fa-youtube"></i>'
        + '<i class="fa-brands fa-instagram"></i>';
      (document.body || document.documentElement).appendChild(probe);
      setTimeout(function () { if (probe.parentNode) probe.parentNode.removeChild(probe); }, 5000);
    } catch (e) {}
  }

  function boot() {
    if (!window.SceneBase || typeof window.SceneBase.connect !== 'function') {
      // scene-base.js hasn't parsed yet — retry on next tick.
      return setTimeout(boot, 30);
    }
    preloadCasterIcons();
    if (typeof window.__fgcConnect === 'function') window.__fgcConnect();
    window.SceneBase.connect(function (state) {
      try {
        applyBrandColors(state);
        applyCasterLayout(state);
        window.__fgcEmit('update_scoreboard', mapState(state));
        applyTeamRecords(state);   // AFTER render — overwrites the team-row score with the record
        applySponsorRail(state);
        if (_DEBUG) showDebug(state);
      } catch (e) { console.error('[fgc-adapter] map/emit failed:', e); }
    });
  }
  boot();
})();
