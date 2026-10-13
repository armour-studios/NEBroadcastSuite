/* ─── settings-connections.js — Settings ▸ Connections ────────────────────────────────────────
   Every service the app talks to, in one list, with its live status: your Nameless account, the
   switcher (OBS / vMix), Twitch, Stream Deck, tournament platforms, game data and cameras.
   The rows are read from the Apps page's integration cards (#int-store-grid): same names, logos and
   status chips (renderIntegrationStore keeps those current), so there is one source of truth and
   no second copy of any key form. Set up / Manage opens that service's own panel on the Apps page.
   Signed-in state for the Nameless account comes from state.cloudEventsMeta (server.js). */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function cur() { try { return (typeof currentState !== 'undefined' && currentState) || {}; } catch (e) { return {}; } }

  var GROUPS = [
    { title: 'Production', desc: 'Your streaming software, your stream and your control surface.', keys: ['obs', 'twitch', 'streamdeck'] },
    { title: 'Tournaments and data', desc: 'Where brackets, schedules and results come from. Nameless website events need only your account above.', keys: ['startgg', 'challonge', 'faceit', 'nxgen', 'liquipedia', 'sheets'] },
    { title: 'Game data', desc: 'Live stats from the game itself, for scoreboards and automation.', keys: ['rl', 'cs2', 'valorant', 'lol', 'riot'] },
    { title: 'Cameras and talent', desc: 'Remote cameras and caster feeds.', keys: ['vdo'] },
  ];

  var built = false;
  function build() {
    if (built) return true;
    var rail = $('set-rail'), content = $('set-content');
    if (!rail || !content) return false;
    built = true;
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'set-rail-btn'; btn.setAttribute('data-stab', 'connections'); btn.textContent = 'Connections';
    var gen = rail.querySelector('[data-stab="general"]');
    rail.insertBefore(btn, gen ? gen.nextSibling : rail.firstChild);
    var sec = document.createElement('section');
    sec.className = 'section'; sec.setAttribute('data-setcat', 'connections'); sec.id = 'set-connections';
    sec.style.display = 'none';
    sec.innerHTML = '<h3 class="section-title">Connections</h3>'
      + '<p class="section-desc" style="max-width:720px;">Everything the app is connected to, and what still needs setting up. Keys and tokens stay on this computer; nothing here is shared when you export a profile.</p>'
      + '<div class="cx-body"></div>';
    content.insertBefore(sec, content.firstChild);
    sec.addEventListener('click', onClick);
    return true;
  }

  function cardInfo(key) {
    var c = document.querySelector('#int-store-grid .int-card[data-card="' + key + '"]');
    if (!c) return null;
    var st = c.querySelector('.int-card-status');
    var logo = c.querySelector('.int-card-logo');
    return {
      key: key,
      name: (c.querySelector('.int-card-name') || {}).textContent || key,
      tag: (c.querySelector('.int-card-tag') || {}).textContent || '',
      logo: logo ? logo.outerHTML : '',
      st: st ? (st.getAttribute('data-st') || 'off') : 'off',
      status: st ? st.textContent.trim() : '',
    };
  }

  function accountRow(s) {
    var m = s.cloudEventsMeta || {};
    var on = m.signedIn === true;
    var unknown = m.signedIn == null;
    return '<div class="cx-row cx-row--account">'
      + '<div class="cx-logo cx-logo--ne">NE</div>'
      + '<div class="cx-txt"><b>Nameless account</b><span>Your leagues and tournaments from the website, your communities on Home, organization seats, stations and cloud sync.</span></div>'
      + '<span class="cx-st" data-st="' + (on ? 'on' : unknown ? 'off' : 'warn') + '">' + (on ? 'Signed in' : unknown ? 'Checking' : 'Signed out') + '</span>'
      + '<div class="cx-act">' + (on ? '<button type="button" class="btn btn-ghost btn-sm" data-cx="profile">Manage</button>' : '<button type="button" class="btn btn-primary btn-sm" data-cx="signin">Sign in</button>') + '</div>'
      + '</div>';
  }

  var lastSig = '';
  function render() {
    if (!build()) return;
    var sec = $('set-connections');
    if (!sec || sec.style.display === 'none' || !sec.offsetParent) return;
    var s = cur();
    var groups = GROUPS.map(function (g) { return { g: g, rows: g.keys.map(cardInfo).filter(Boolean) }; });
    // Any card the Apps page gains later still shows up, under Other.
    var known = {};
    GROUPS.forEach(function (g) { g.keys.forEach(function (k) { known[k] = 1; }); });
    var other = [].slice.call(document.querySelectorAll('#int-store-grid .int-card')).map(function (c) { return c.getAttribute('data-card'); })
      .filter(function (k) { return k && !known[k] && k !== 'marblerace'; }).map(cardInfo).filter(Boolean);
    if (other.length) groups.push({ g: { title: 'Other', desc: '' }, rows: other });
    var sig = JSON.stringify([s.cloudEventsMeta, groups.map(function (x) { return x.rows.map(function (r) { return r.key + r.st + r.status; }); })]);
    if (sig === lastSig) return;
    lastSig = sig;
    var all = groups.reduce(function (n, x) { return n.concat(x.rows); }, []);
    var onN = all.filter(function (r) { return r.st === 'on'; }).length;
    var warn = all.filter(function (r) { return r.st === 'warn'; });
    var out = '<div class="cx-sum"><b>' + onN + '</b> of ' + all.length + ' services connected'
      + (warn.length ? ' · <span class="cx-warn">' + warn.length + ' need' + (warn.length === 1 ? 's' : '') + ' attention: ' + esc(warn.map(function (r) { return r.name; }).join(', ')) + '</span>' : '') + '</div>';
    out += '<div class="cx-group"><div class="cx-gh"><b>Account</b></div><div class="cx-list">' + accountRow(s) + '</div></div>';
    groups.forEach(function (x) {
      if (!x.rows.length) return;
      out += '<div class="cx-group"><div class="cx-gh"><b>' + esc(x.g.title) + '</b>' + (x.g.desc ? '<span>' + esc(x.g.desc) + '</span>' : '') + '</div><div class="cx-list">'
        + x.rows.map(function (r) {
          return '<div class="cx-row">' + '<div class="cx-logo">' + r.logo + '</div>'
            + '<div class="cx-txt"><b>' + esc(r.name) + '</b><span>' + esc(r.tag) + '</span></div>'
            + '<span class="cx-st" data-st="' + esc(r.st) + '">' + esc(r.status || (r.st === 'on' ? 'Connected' : 'Not set up')) + '</span>'
            + '<div class="cx-act"><button type="button" class="btn ' + (r.st === 'off' ? 'btn-secondary' : 'btn-ghost') + ' btn-sm" data-cx="open" data-key="' + esc(r.key) + '">' + (r.st === 'off' ? 'Set up' : 'Manage') + '</button></div>'
            + '</div>';
        }).join('') + '</div></div>';
    });
    sec.querySelector('.cx-body').innerHTML = out;
  }

  function onClick(e) {
    var b = e.target.closest('[data-cx]');
    if (!b) return;
    var act = b.getAttribute('data-cx');
    if (act === 'profile') {
      var p = document.querySelector('#set-rail [data-stab="profile"]'); if (p) p.click();
      setTimeout(function () { var c = $('cloud-sync-block'); if (c) c.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 60);
    } else if (act === 'signin') {
      var si = $('btn-discord-login'); if (si) si.click();
    } else if (act === 'open') {
      var key = b.getAttribute('data-key');
      var card = document.querySelector('#int-store-grid .int-card[data-card="' + key + '"]');
      if (!card) return;
      // Game data panels live in Settings ▸ Games; the card's own handler switches there itself.
      if (card.getAttribute('data-goto') !== 'games') {
        if (typeof window.closeSettingsModal === 'function') window.closeSettingsModal();
        var nav = document.querySelector('html[data-ui="modern"] .mx-nav [data-mx-item="market"]') || document.querySelector('.tab-btn[data-tab="integrations"]');
        if (nav) nav.click();
      }
      setTimeout(function () { card.click(); }, 120);
    }
  }

  // Cheap: re-checks the status chips only while the section is on screen.
  setInterval(render, 1200);
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('#set-rail [data-stab="connections"]')) { lastSig = ''; setTimeout(render, 30); }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
