'use strict';
// League of Legends (draft, HUD, gold OCR) — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly; values server.js reassigns are
// read and written through ctx (_lolPollTimer).
let
  bridgeClients, broadcast, broadcastFullState, broadcastLol, lolOcr, lolOcrConfigure,
  saveAppState, startLolDraftAuto, startLolOcr, state, stopLolDraftAuto, stopLolOcr;
let ctx;

const handlers = {
  // (draft_* migrated to the WS_HANDLERS registry above handleControlMessage)
  // Toggle LoL champ-select automation (reads the live draft from the League Client).
  lol_draft_auto(msg, ws) {
    if (!state.draft) return;
    if (!state.draft.auto) state.draft.auto = { enabled: false, status: 'off', statusDetail: '', lockfilePath: '' };
    const d = msg.data || {};
    if (typeof d.lockfilePath === 'string') state.draft.auto.lockfilePath = d.lockfilePath.slice(0, 300);
    if (typeof d.enabled === 'boolean') {
      state.draft.auto.enabled = d.enabled;
      if (d.enabled) startLolDraftAuto(); else stopLolDraftAuto();
    }
    saveAppState(); broadcastFullState();
  },

  // Teamfight-transition control for the in-game LoL HUD: full | minimal | auto.
  lol_hud_mode(msg, ws) {
    const m = msg.data && msg.data.mode;
    if (['full', 'minimal', 'auto'].includes(m)) {
      state.lol.hudMode = m;
      broadcast(bridgeClients, { type: 'lol_hud_mode', mode: m });
      broadcastLol();
      saveAppState();
    }
  },

  // Optional OCR gold override — enable + calibrate the two capture regions.
  lol_ocr_config(msg, ws) {
    const d = msg.data || {};
    const o = state.lol.ocr;
    if (typeof d.enabled === 'boolean') o.enabled = d.enabled;
    if (d.displayId != null) o.displayId = String(d.displayId || '');
    if (d.regions) {
      ['blue', 'red'].forEach((s) => {
        if (d.regions[s]) ['x', 'y', 'w', 'h'].forEach((k) => {
          const v = Number(d.regions[s][k]);
          if (!isNaN(v)) o.regions[s][k] = Math.max(0, Math.round(v));
        });
      });
    }
    o.available = lolOcr.tessAvailable();
    // (Re)start or stop OCR to match — only meaningful while spectating League.
    stopLolOcr();
    if (o.enabled && state.activeGame === 'league' && ctx._lolPollTimer) startLolOcr();
    else if (!o.enabled) o.status = 'off';
    saveAppState();
    broadcastFullState();
  },

  // Calibration helpers. Each replies to the asking client only (the snapshot carries a
  // screenshot — never put it in state or a broadcast).
  lol_ocr_displays(msg, ws) {
    lolOcrConfigure();
    let displays = [];
    try { displays = lolOcr.listDisplays(); } catch (e) {}
    try { ws.send(JSON.stringify({ type: 'lol_ocr_displays', displays, current: state.lol.ocr.displayId || '' })); } catch (e) {}
  },

  lol_ocr_snapshot(msg, ws) {
    lolOcrConfigure();
    const o = state.lol.ocr;
    lolOcr.snapshot({ displayId: o.displayId, regions: o.regions })
      .then((res) => { try { ws.send(JSON.stringify({ type: 'lol_ocr_snapshot', ...res })); } catch (e) {} })
      .catch((e) => { try { ws.send(JSON.stringify({ type: 'lol_ocr_snapshot', ok: false, message: (e && e.message) || 'snapshot failed' })); } catch (e2) {} });
  },

  lol_ocr_autolocate(msg, ws) {
    lolOcrConfigure();
    const o = state.lol.ocr;
    lolOcr.autoLocate({ displayId: o.displayId })
      .then((res) => {
        if (res.ok && res.regions) {
          o.regions = { blue: { ...res.regions.blue }, red: { ...res.regions.red } };
          if (res.displayId) o.displayId = res.displayId;
          // A running reader picks the new boxes up on its next tick via getRegions().
          saveAppState();
          broadcastFullState();
        }
        try { ws.send(JSON.stringify({ type: 'lol_ocr_autolocate', ok: !!res.ok, message: res.message || '', regions: res.regions || null, words: res.words || null })); } catch (e) {}
      })
      .catch((e) => { try { ws.send(JSON.stringify({ type: 'lol_ocr_autolocate', ok: false, message: (e && e.message) || 'auto-detect failed' })); } catch (e2) {} });
  },
};

module.exports = function createLolHandlers(c) {
  ctx = c;
  ({
    bridgeClients, broadcast, broadcastFullState, broadcastLol, lolOcr, lolOcrConfigure,
    saveAppState, startLolDraftAuto, startLolOcr, state, stopLolDraftAuto, stopLolOcr
  } = c);
  return handlers;
};
