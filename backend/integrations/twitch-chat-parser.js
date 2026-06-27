class ChatParser {
  constructor(miniGameManager) {
    this.miniGameManager = miniGameManager;
  }

  parseMessage(userId, username, message) {
    if (!this.miniGameManager.currentGame) return null;
    const game = this.miniGameManager.currentGame;
    const msg = message.trim().toLowerCase();

    // ── Trivia ───────────────────────────────────────────────────────────────
    if (game.type === 'trivia') {
      // Single letter: a / b / c / d
      if (/^[a-d]$/i.test(msg)) {
        const idx = msg.charCodeAt(0) - 97;
        if (idx < game.answers.length)
          return this.miniGameManager.addResponse(userId, username, idx);
      }
      // Number: 1 / 2 / 3 / 4
      if (/^[1-4]$/.test(msg)) {
        const idx = parseInt(msg) - 1;
        if (idx < game.answers.length)
          return this.miniGameManager.addResponse(userId, username, idx);
      }
      // Answer text fuzzy match
      for (let i = 0; i < game.answers.length; i++) {
        const a = game.answers[i].toLowerCase();
        if (a.includes(msg) || msg.includes(a))
          return this.miniGameManager.addResponse(userId, username, i);
      }
    }

    // ── Prediction / Vote ────────────────────────────────────────────────────
    if (game.type === 'prediction' || game.type === 'vote') {
      const prefix = game.type === 'prediction' ? '!predict' : '!vote';
      if (msg.startsWith(prefix)) {
        const arg = msg.slice(prefix.length).trim();
        if (/^\d+$/.test(arg)) {
          const optId = parseInt(arg) - 1;
          if (optId >= 0 && optId < game.options.length)
            return this.miniGameManager.addResponse(userId, username, optId);
        }
        for (let i = 0; i < game.options.length; i++) {
          const t = game.options[i].title.toLowerCase();
          if (t.includes(arg) || arg.includes(t))
            return this.miniGameManager.addResponse(userId, username, i);
        }
      }
      // Shorthand !1 / !2 / !3 / !4
      const shM = msg.match(/^!(\d+)$/);
      if (shM) {
        const optId = parseInt(shM[1]) - 1;
        if (optId >= 0 && optId < game.options.length)
          return this.miniGameManager.addResponse(userId, username, optId);
      }
    }

    // ── Raffle Spin ──────────────────────────────────────────────────────────
    if (game.type === 'spin' && msg.length > 0 && !msg.startsWith('!')) {
      return this.miniGameManager.addResponse(userId, username);
    }

    // ── Number Guess — !guess 42 ─────────────────────────────────────────────
    if (game.type === 'number_guess') {
      const m = msg.match(/^!guess\s+(-?\d+)$/);
      if (m) return this.miniGameManager.addResponse(userId, username, parseInt(m[1]));
    }

    // ── Fastest Finger — first to type the exact keyword ────────────────────
    if (game.type === 'fastest_finger') {
      if (!game.winner && msg === game.keyword)
        return this.miniGameManager.addResponse(userId, username);
    }

    // ── Score Prediction — !score 3-1 or !score 3 1 ─────────────────────────
    if (game.type === 'score_prediction') {
      const m = msg.match(/^!score\s+(\d+)[-\s](\d+)$/);
      if (m) {
        const a = parseInt(m[1]), b = parseInt(m[2]);
        return this.miniGameManager.addResponse(userId, username, [a, b], `${a}-${b}`);
      }
    }

    return false;
  }
}

module.exports = { ChatParser };
