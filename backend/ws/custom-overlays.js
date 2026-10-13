'use strict';
// Custom overlays (builder) — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly; values server.js reassigns are
// read and written through ctx (customOverlaysVer).
let
  GAMES, broadcastFullState, coStore, saveAppState, state, wsSend;
let ctx;

const handlers = {
  // (set_winner migrated to the WS_HANDLERS registry above handleControlMessage)

  // ── Map veto / map-pool overview board ───────────────────────────────
  // (set_veto / veto_* migrated to the WS_HANDLERS registry above handleControlMessage)

  // (ow_* migrated to the WS_HANDLERS registry above handleControlMessage)
  // (mr_* migrated to the WS_HANDLERS registry above handleControlMessage)

  // ── Custom overlay URL management ────────────────────────────────────
  manage_custom_overlay(msg, ws) {
    const d = msg.data || {};
    const gameId = String(d.gameId || '');
    if (!GAMES[gameId]) return;
    const custom = { ...(state.customOverlayLayouts || {}) };
    const list = [...(custom[gameId] || [])];
    if (d.action === 'add') {
      const name = String(d.name || '').trim();
      const path = String(d.path || '').trim();
      if (!name || !path) return;
      list.push({ id: 'custom-' + Date.now(), name, path });
      custom[gameId] = list;
      state.customOverlayLayouts = custom;
    } else if (d.action === 'remove') {
      const idx = list.findIndex((o) => o.id === d.overlayId);
      if (idx < 0) return;
      list.splice(idx, 1);
      custom[gameId] = list;
      state.customOverlayLayouts = custom;
    } else if (d.action === 'rename') {
      const idx = list.findIndex((o) => o.id === d.overlayId);
      if (idx < 0 || !String(d.name || '').trim()) return;
      list[idx] = { ...list[idx], name: String(d.name).trim() };
      custom[gameId] = list;
      state.customOverlayLayouts = custom;
    }
    saveAppState(); broadcastFullState();
  },

  // ── Custom overlays (overlay-builder.js) ──
  custom_overlay_get(msg, ws) {
    const o = coStore() && coStore().get(String((msg.data && msg.data.id) || ''));
    wsSend(ws, 'custom-overlay', o ? { ok: true, overlay: o } : { ok: false, error: 'That overlay was deleted.' });
  },

  custom_overlay_save(msg, ws) {
    try {
      if (!coStore()) throw new Error('Still starting up. Try again in a moment.');
      const o = coStore().save(msg.data && msg.data.overlay);
      state.customOverlayRevs[o.id] = o.updatedAt;
      ctx.customOverlaysVer++;
      broadcastFullState();
      wsSend(ws, 'custom-overlay-saved', { ok: true, overlay: o, reqId: msg.data && msg.data.reqId });
    } catch (e) { wsSend(ws, 'custom-overlay-saved', { ok: false, error: e.message, reqId: msg.data && msg.data.reqId }); }
  },

  custom_overlay_delete(msg, ws) {
    const oid = String((msg.data && msg.data.id) || '');
    // A tombstone rev (not a delete): custom.html refetches on a changed rev, gets the 404 and
    // clears itself. Deleting the key changed nothing it watches, so the layout stayed on air.
    if (coStore() && coStore().remove(oid)) {
      // Older tombstones have done their job (every open source saw them): drop them.
      Object.keys(state.customOverlayRevs).forEach((k) => { const v = String(state.customOverlayRevs[k]); if (v.indexOf('deleted-') === 0 && Date.now() - Number(v.slice(8)) > 10 * 60 * 1000) delete state.customOverlayRevs[k]; });
      state.customOverlayRevs[oid] = 'deleted-' + Date.now(); ctx.customOverlaysVer++; broadcastFullState();
    }
  },
};

module.exports = function createCustomOverlayHandlers(c) {
  ctx = c;
  ({
    GAMES, broadcastFullState, coStore, saveAppState, state, wsSend
  } = c);
  return handlers;
};
