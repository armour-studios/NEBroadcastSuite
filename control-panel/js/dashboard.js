// control-panel/js/dashboard.js
// Focused Dashboard renders: ONLY "Broadcast Teams Info" + "Casters On Air".
// Slim / read+quick-action views. Delegates heavy editing (library, talent, full rows, sponsors) to dedicated tabs.
// Reuses core helpers from app.js (syncTeamCard, renderMatchPlayers, saveCasters, etc.).
// Call these from app.js applyState / game context updates.

(function (global) {
  const el = (id) => document.getElementById(id);

  // ── Broadcast Teams Info (focused dashboard version of match-teams) ─────────
  // Shows the live teams + key info. Full editor lives in Equipos tab.
  // Reuses syncTeamCard + renderMatchPlayers (they operate on shared DOM IDs).
  function renderDashboardTeams(data) {
    if (!data) return;
    const teams = data.teams || {};

    // Core cards (IDs live in principal or relocated equipos slot)
    if (typeof global.syncTeamCard === 'function') {
      global.syncTeamCard('blue', teams.blue);
      global.syncTeamCard('orange', teams.orange);
    }
    if (typeof global.renderMatchPlayers === 'function') {
      global.renderMatchPlayers('blue', teams.blue && teams.blue.players);
      global.renderMatchPlayers('orange', teams.orange && teams.orange.players);
    }
    if (typeof global.renderSeriesPanel === 'function') {
      global.renderSeriesPanel(data.match, teams);
    }

    // Note: do not hide editor controls here — user data (teams, brands) must remain fully editable and visible.
    // Full editor bits stay visible on dashboard and equipos tab.
  }

  // Casters On Air summary (non-destructive, only adds if slim container exists)
  function renderDashboardCastersOnAir(data) {
    if (!data) return;
    const panel = el('dash-casters-onair-slim');
    if (!panel) return; // no slim container — full UI is present, skip
    // ... (rest of slim render can stay or be expanded later)
    const casters = (data.casters || {});
    const list = Array.isArray(casters.list) ? casters.list : [];
    const onAir = list.filter(c => c && (c.name || c.camUrl));
    panel.innerHTML = onAir.length ? onAir.map(c => `<span class="caster-chip">${(c.name||'—')}</span>`).join(' ') : 'No casters on air';
  }

  // Main entry called from app.js apply flows
  function renderFocusedDashboard(data) {
    renderDashboardTeams(data);
    renderDashboardCastersOnAir(data);
  }

  // Note for maintainers (production + automation mindset):
  // VDO player automation (for rl-hud in-game facecams + talent rooms) and caster VDO (for duorow/casters.html desk scenes)
  // are fully driven by:
  // - server: ensureTeamVdo / ensureCasterVdo + build*Url + 'generate_team_vdo' handler + /api/vdo/links
  // - client facecams tab (cf-talent etc) + savedFacecams + facecams list in state
  // - overlay: findFacecam + renderFacecams (used in rl-hud, main hud, etc.)
  // The focused dashboard only surfaces live teams info + quick generate trigger + link to full.
  // Nothing in core automation was changed or removed.

  // Expose
  global.NEBroadcastDashboard = {
    renderFocusedDashboard,
    renderDashboardTeams,
    renderDashboardCastersOnAir
  };
})(window);
