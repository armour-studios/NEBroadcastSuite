class ChatParser {
  constructor(miniGameManager) {
    this.miniGameManager = miniGameManager;
  }

  parseMessage(userId, username, message) {
    if (!this.miniGameManager.currentGame) {
      return null;
    }

    const game = this.miniGameManager.currentGame;
    const msg = message.trim().toLowerCase();

    // Trivia: Match answer letters or words
    if (game.type === 'trivia') {
      // Try single letter: "a", "b", "c", "d"
      if (/^[a-d]$/i.test(msg)) {
        const idx = msg.charCodeAt(0) - 97; // a=0, b=1, etc
        if (idx < game.answers.length) {
          return this.miniGameManager.addResponse(userId, username, idx);
        }
      }

      // Try answer number: "1", "2", "3", "4"
      if (/^[1-4]$/.test(msg)) {
        const idx = parseInt(msg) - 1;
        if (idx < game.answers.length) {
          return this.miniGameManager.addResponse(userId, username, idx);
        }
      }

      // Try matching answer text
      for (let i = 0; i < game.answers.length; i++) {
        if (game.answers[i].toLowerCase().includes(msg) || msg.includes(game.answers[i].toLowerCase())) {
          return this.miniGameManager.addResponse(userId, username, i);
        }
      }
    }

    // Prediction/Vote: Match !predict/!vote commands
    if (game.type === 'prediction' || game.type === 'vote') {
      const prefix = game.type === 'prediction' ? '!predict' : '!vote';
      if (msg.startsWith(prefix)) {
        const arg = msg.substring(prefix.length).trim();

        // Try "!predict 1", "!predict 2", etc
        if (/^\d+$/.test(arg)) {
          const optionId = parseInt(arg) - 1;
          if (optionId < game.options.length) {
            return this.miniGameManager.addResponse(userId, username, null, optionId);
          }
        }

        // Try matching option text
        for (let i = 0; i < game.options.length; i++) {
          if (game.options[i].toLowerCase().includes(arg) || arg.includes(game.options[i].toLowerCase())) {
            return this.miniGameManager.addResponse(userId, username, null, i);
          }
        }
      }

      // Also allow shorthand: "!1", "!2", "!3", "!4"
      if (/^!(\d+)$/.test(msg)) {
        const optionId = parseInt(msg.substring(1)) - 1;
        if (optionId < game.options.length) {
          return this.miniGameManager.addResponse(userId, username, null, optionId);
        }
      }
    }

    // Spin: Any message enters the raffle
    if (game.type === 'spin' && msg.length > 0 && !msg.startsWith('!')) {
      return this.miniGameManager.addResponse(userId, username);
    }

    return false;
  }
}

module.exports = { ChatParser };
