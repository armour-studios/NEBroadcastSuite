'use strict';
// Rainbow Six, Bedwars — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly; values server.js reassigns are
// read and written through ctx (bedwarsToken).
let
  broadcastFullState, saveAppState, state;
let ctx;

const handlers = {
  // Build a manual league seeded from a start.gg event's entrants (teams + rosters).
  // Live-data automation toggles for the manually-scored titles. Both default OFF: automation
  // that moves the scoreboard without the producer asking for it is a liability on air.
  set_r6_settings(msg, ws) {
    if (!state.r6) state.r6 = { autoScore: false, gepData: null };
    if (typeof msg.data.autoScore === 'boolean') state.r6.autoScore = msg.data.autoScore;
    broadcastFullState(); saveAppState();
  },

  set_bedwars_settings(msg, ws) {
    if (!state.bedwars) state.bedwars = { autoScore: false, data: null };
    if (typeof msg.data.autoScore === 'boolean') state.bedwars.autoScore = msg.data.autoScore;
    // The panel can only ever send a BLANK field on reload (the token is never broadcast back —
    // only hasToken), so treating '' as "set empty" meant one Save click silently disabled auth on
    // /api/bedwars. Blank = leave alone; clearing requires an explicit clearToken flag.
    if (msg.data.clearToken === true) ctx.bedwarsToken = '';
    else if (typeof msg.data.token === 'string' && msg.data.token.trim()) ctx.bedwarsToken = msg.data.token.trim().slice(0, 128);
    broadcastFullState(); saveAppState();
  },
};

module.exports = function createOtherGameHandlers(c) {
  ctx = c;
  ({
    broadcastFullState, saveAppState, state
  } = c);
  return handlers;
};
