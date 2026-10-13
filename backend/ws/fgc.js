'use strict';
// Fighting games (Smash, Brawlhalla, Tokon) — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly; values server.js reassigns are
// read and written through ctx (_bhGameClosed, _smashGameClosed).
let
  BH_REGIONS, broadcastFullState, checkBrawlhallaGameOver, checkSmashGameOver,
  normalizeTokonLayout, refillBrawlhallaStocks, refreshBrawlhallaCard, refreshBrawlhallaCards,
  resizeSmashSides, saveAppState, setSmashMode, state;
let ctx;

const handlers = {
  // ── Smash stock countdown ─────────────────────────────────────────────────────
  // A Smash game ends when one side's stocks reach zero. Rather than making the producer notice
  // that and then click a series win AND a game bump, running out closes the game itself: the
  // OPPONENT takes the series point (which already auto-advances state.game.number via the same
  // rule adjust_series uses) and both sides refill for the next game.
  //
  // `state.smash.autoAdvance` gates it, and _smashGameClosed latches so correcting a number down
  // through zero — or any second write while the board still reads 0 — can't award twice.
  //
  // _smashGameClosed is declared at MODULE scope (just above handleControlMessage), NOT here. A
  // `let` written at this point would sit in the switch's single block scope, and every case jumps
  // straight to its own label without ever running this line — so the binding stays in its temporal
  // dead zone and the first case to touch it throws ReferenceError. That is exactly what broke
  // `reset_series` and the Smash auto-advance: the throw was swallowed by the handler's try/catch,
  // so the button simply did nothing. (The Smash helper functions moved to module scope for the same
  // reason — see the note above _smashGameClosed.)


  // ── Super Smash Bros. HUD (overlay/smash.html) ──────────────────────────────
  set_smash_auto_advance(msg, ws) {
    if (msg.data) {
      state.smash.autoAdvance = !!msg.data.value;
      saveAppState();
      broadcastFullState();
    }
  },

  set_smash_stocks(msg, ws) {
    if (msg.data && (msg.data.side === 'blue' || msg.data.side === 'orange')) {
      const v = Math.max(0, Math.min(9, Math.round(Number(msg.data.value) || 0)));
      state.smash[msg.data.side].stocks = v;
      checkSmashGameOver();
      saveAppState();
      broadcastFullState();
    }
  },

  smash_stock_delta(msg, ws) {
    if (msg.data && (msg.data.side === 'blue' || msg.data.side === 'orange')) {
      const cur = Number(state.smash[msg.data.side].stocks) || 0;
      state.smash[msg.data.side].stocks = Math.max(0, Math.min(9, cur + (Math.round(Number(msg.data.delta)) || 0)));
      checkSmashGameOver();
      saveAppState();
      broadcastFullState();
    }
  },

  set_smash_character(msg, ws) {
    if (msg.data && (msg.data.side === 'blue' || msg.data.side === 'orange')) {
      state.smash[msg.data.side].character = String(msg.data.character || '').slice(0, 40);
      saveAppState();
      broadcastFullState();
    }
  },

  set_smash_start_stocks(msg, ws) {
    if (msg.data) {
      const s = Math.max(1, Math.min(9, Math.round(Number(msg.data.value) || 3)));
      state.smash.startStocks = s;
      state.smash.blue.players = state.smash.blue.players.map(() => s);
      state.smash.orange.players = state.smash.orange.players.map(() => s);
      saveAppState();
      broadcastFullState();
    }
  },

  reset_smash_stocks(msg, ws) {
    ctx._smashGameClosed = false;
    state.smash.blue.stocks = state.smash.startStocks;
    state.smash.orange.stocks = state.smash.startStocks;
    state.smash.blue.players = state.smash.blue.players.map(() => state.smash.startStocks);
    state.smash.orange.players = state.smash.orange.players.map(() => state.smash.startStocks);
    saveAppState();
    broadcastFullState();
  },

  // ── Brawlhalla HUD (overlay/brawlhalla.html) ────────────────────────────────
  // NOTE: every `case` below keeps its body inside braces. A bare `let`/`const` between cases in
  // this switch is a silent TDZ ReferenceError for every case after it (see
  // test/switch-scope.test.js) — that is how reset_series was killed once already.
  set_brawlhalla_mode(msg, ws) {
    const m = (msg.data && msg.data.mode) === '2v2' ? '2v2' : '1v1';
    state.brawlhalla.mode = m;
    saveAppState();
    broadcastFullState();
  },

  set_brawlhalla_stocks(msg, ws) {
    const d = msg.data || {};
    if (d.side === 'blue' || d.side === 'orange') {
      const v = Math.max(0, Math.min(9, Math.round(Number(d.value) || 0)));
      const seat = Math.max(0, Math.min(1, Math.round(Number(d.seat) || 0)));
      if (state.brawlhalla.mode === '2v2') state.brawlhalla[d.side].players[seat].stocks = v;
      else state.brawlhalla[d.side].stocks = v;
      checkBrawlhallaGameOver();
      saveAppState();
      broadcastFullState();
    }
  },

  brawlhalla_stock_delta(msg, ws) {
    const d = msg.data || {};
    if (d.side === 'blue' || d.side === 'orange') {
      const step = Math.round(Number(d.delta)) || 0;
      const seat = Math.max(0, Math.min(1, Math.round(Number(d.seat) || 0)));
      const clamp = (n) => Math.max(0, Math.min(9, n));
      if (state.brawlhalla.mode === '2v2') {
        const p = state.brawlhalla[d.side].players[seat];
        p.stocks = clamp((Number(p.stocks) || 0) + step);
      } else {
        state.brawlhalla[d.side].stocks = clamp((Number(state.brawlhalla[d.side].stocks) || 0) + step);
      }
      checkBrawlhallaGameOver();
      saveAppState();
      broadcastFullState();
    }
  },

  set_brawlhalla_legend(msg, ws) {
    const d = msg.data || {};
    if (d.side === 'blue' || d.side === 'orange') {
      const name = String(d.legend || '').slice(0, 40);
      const seat = Math.max(0, Math.min(1, Math.round(Number(d.seat) || 0)));
      if (state.brawlhalla.mode === '2v2') state.brawlhalla[d.side].players[seat].legend = name;
      else state.brawlhalla[d.side].legend = name;
      saveAppState();
      broadcastFullState();
    }
  },

  set_brawlhalla_start_stocks(msg, ws) {
    const v = Math.max(1, Math.min(9, Math.round(Number((msg.data || {}).value) || 3)));
    state.brawlhalla.startStocks = v;
    refillBrawlhallaStocks();
    saveAppState();
    broadcastFullState();
  },

  reset_brawlhalla_stocks(msg, ws) {
    ctx._bhGameClosed = false;
    refillBrawlhallaStocks();
    saveAppState();
    broadcastFullState();
  },

  set_brawlhalla_options(msg, ws) {
    const d = msg.data || {};
    if ('autoAdvance' in d) state.brawlhalla.autoAdvance = !!d.autoAdvance;
    if ('showRank' in d) state.brawlhalla.showRank = !!d.showRank;
    if ('showLegend' in d) state.brawlhalla.showLegend = !!d.showLegend;
    if (typeof d.title === 'string') {
      state.brawlhalla.title = d.title.slice(0, 40);
      // Typing a label pins it; clearing the box hands the slot back to the auto-fill.
      state.brawlhalla.titleManual = !!state.brawlhalla.title;
    }
    if (typeof d.region === 'string' && BH_REGIONS.includes(d.region.toUpperCase())) state.brawlhalla.region = d.region.toUpperCase();
    if (d.rankMode === 'ranked_1v1' || d.rankMode === 'ranked_3v3') state.brawlhalla.rankMode = d.rankMode;
    if (d.railPos === 'auto' || d.railPos === 'topleft') state.brawlhalla.railPos = d.railPos;
    saveAppState();
    broadcastFullState();
  },

  // Link a seat to a Brawlhalla account and pull its ranked card. bhId 0 unlinks (and drops the
  // card with it, so the board can't keep quoting a rank for a player who is no longer there).
  link_brawlhalla_player(msg, ws) {
    const d = msg.data || {};
    if (d.side === 'blue' || d.side === 'orange') {
      const seat = Math.max(0, Math.min(1, Math.round(Number(d.seat) || 0)));
      const id = Math.max(0, Math.round(Number(d.bhId) || 0));
      const p = state.brawlhalla[d.side].players[seat];
      p.bhId = id;
      if (!id) p.card = null;
      saveAppState();
      broadcastFullState();
      if (id) refreshBrawlhallaCard(d.side, seat).then(() => broadcastFullState());
    }
  },

  refresh_brawlhalla_cards(msg, ws) {
    refreshBrawlhallaCards();
  },

  set_smash_title(msg, ws) {
    if (msg.data) {
      const t = String(msg.data.value || '').slice(0, 40).trim();
      state.smash.title = t || state.smash.startggTitle || '';
      state.smash.titleManual = !!t;
      saveAppState();
      broadcastFullState();
    }
  },

  set_smash_mode(msg, ws) {
    if (msg.data) {
      setSmashMode(msg.data.mode);
      saveAppState();
      broadcastFullState();
    }
  },

  set_smash_rail_pos(msg, ws) {
    if (msg.data) {
      state.smash.railPos = ['bottom', 'topleft'].includes(msg.data.value) ? msg.data.value : 'auto';
      saveAppState();
      broadcastFullState();
    }
  },

  set_tokon_rail_pos(msg, ws) {
    if (msg.data) {
      state.tokon.railPos = ['bottomleft', 'bottomright'].includes(msg.data.value) ? msg.data.value : 'meters';
      saveAppState();
      broadcastFullState();
    }
  },

  set_tokon_layout(msg, ws) {
    if (msg.data) {
      if (msg.data.reset) state.tokon.layout = normalizeTokonLayout();
      else if (typeof msg.data.key === 'string') {
        state.tokon.layout = normalizeTokonLayout({ ...state.tokon.layout, [msg.data.key]: msg.data.value });
      }
      saveAppState();
      broadcastFullState();
    }
  },

  set_smash_crew_size(msg, ws) {
    if (msg.data) {
      const n = Math.max(1, Math.min(8, Math.round(Number(msg.data.value) || 4)));
      state.smash.crewSize = n;
      // characters[] is parallel to players[] — resizeSmashSides moves them in step, or the crew
      // rows and their fighters drift apart the moment the crew size changes mid-event. Doubles
      // is always two a side; the crew size is remembered for when the producer goes back to crew.
      if (state.smash.mode !== 'doubles') resizeSmashSides(n);
      saveAppState();
      broadcastFullState();
    }
  },

  set_smash_player_stock(msg, ws) {
    if (msg.data && (msg.data.side === 'blue' || msg.data.side === 'orange') && Array.isArray(state.smash[msg.data.side].players)) {
      const i = Math.round(Number(msg.data.index));
      const arr = state.smash[msg.data.side].players;
      if (i >= 0 && i < arr.length) {
        arr[i] = Math.max(0, Math.min(9, Math.round(Number(msg.data.value) || 0)));
        saveAppState();
        broadcastFullState();
      }
    }
  },

  set_smash_player_character(msg, ws) {
    if (msg.data && (msg.data.side === 'blue' || msg.data.side === 'orange')) {
      const sd = state.smash[msg.data.side];
      if (!Array.isArray(sd.characters)) sd.characters = sd.players.map(() => '');
      const i = Math.round(Number(msg.data.index));
      if (i >= 0 && i < sd.players.length) {
        while (sd.characters.length <= i) sd.characters.push('');
        sd.characters[i] = String(msg.data.character || '').slice(0, 40);
        saveAppState();
        broadcastFullState();
      }
    }
  },

  smash_player_stock_delta(msg, ws) {
    if (msg.data && (msg.data.side === 'blue' || msg.data.side === 'orange') && Array.isArray(state.smash[msg.data.side].players)) {
      const i = Math.round(Number(msg.data.index));
      const arr = state.smash[msg.data.side].players;
      if (i >= 0 && i < arr.length) {
        arr[i] = Math.max(0, Math.min(9, (Number(arr[i]) || 0) + (Math.round(Number(msg.data.delta)) || 0)));
        checkSmashGameOver();
        saveAppState();
        broadcastFullState();
      }
    }
  },
};

module.exports = function createFgcHandlers(c) {
  ctx = c;
  ({
    BH_REGIONS, broadcastFullState, checkBrawlhallaGameOver, checkSmashGameOver,
    normalizeTokonLayout, refillBrawlhallaStocks, refreshBrawlhallaCard,
    refreshBrawlhallaCards, resizeSmashSides, saveAppState, setSmashMode, state
  } = c);
  return handlers;
};
