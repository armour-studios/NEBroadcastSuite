// control-panel/js/nav.js
// Lightweight enhancements for sidebar (badges for casters on air + teams) to support focused navigation.
// Does NOT duplicate core tab switching / collapse (those are in app.js).
// Exposes: window.NEBroadcastNav.updateSidebarBadges(data)

(function (global) {
  // ── State-driven badges for focused Dashboard (casters + teams) ────────────
  function updateSidebarBadges(data) {
    if (!data) return;
    const teams = data.teams || {};
    const casters = (data.casters && data.casters.list) || [];

    // Teams badge on Equipos nav
    const equiposBtn = document.getElementById('tab-equipos');
    if (equiposBtn) {
      let badge = equiposBtn.querySelector('.nav-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'nav-badge';
        equiposBtn.appendChild(badge);
      }
      const blueShort = (teams.blue && teams.blue.name) ? teams.blue.name.split(/\s+/).slice(-1)[0].slice(0,8) : '';
      const orangeShort = (teams.orange && teams.orange.name) ? teams.orange.name.split(/\s+/).slice(-1)[0].slice(0,8) : '';
      badge.textContent = (blueShort && orangeShort) ? `${blueShort} vs ${orangeShort}` : '';
      badge.style.display = badge.textContent ? '' : 'none';
    }

    // Casters on air badge (Dashboard or Camera Feeds)
    const dashBtn = document.getElementById('tab-principal');
    const camsBtn = document.getElementById('tab-facecams');
    const onAirCount = casters.filter(c => c && (c.name || c.camUrl)).length;
    const visible = !!(data.casters && data.casters.visible);

    [dashBtn, camsBtn].forEach(btn => {
      if (!btn) return;
      let badge = btn.querySelector('.nav-badge-casters');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'nav-badge-casters';
        btn.appendChild(badge);
      }
      if (onAirCount > 0 && visible) {
        badge.textContent = `${onAirCount} on air`;
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    });
  }

  global.NEBroadcastNav = global.NEBroadcastNav || {};
  global.NEBroadcastNav.updateSidebarBadges = updateSidebarBadges;

})(window);
