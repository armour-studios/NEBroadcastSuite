const GAME_TYPES = {
  trivia: {
    name: 'Trivia',
    duration: 30000,
    rewardPoints: 500
  },
  prediction: {
    name: 'Prediction',
    duration: 30000,
    rewardPoints: 500
  },
  spin: {
    name: 'Spin',
    duration: 15000,
    rewardPoints: 250
  },
  vote: {
    name: 'Vote',
    duration: 20000,
    rewardPoints: 300
  }
};

class MiniGameManager {
  constructor(state) {
    this.state = state;
    this.currentGame = null;
    this.participants = new Map(); // userId -> { username, answer, timestamp }
  }

  createTrivia(question, answers, correctAnswerIndex) {
    const gameId = 'game_' + Date.now();

    this.currentGame = {
      id: gameId,
      type: 'trivia',
      state: 'active',
      question,
      answers,
      correctAnswerIndex,
      duration: GAME_TYPES.trivia.duration,
      startedAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + GAME_TYPES.trivia.duration).toISOString(),
      responses: {},
      winners: []
    };

    this.participants.clear();
    this.state.twitch.minigame.current = this.currentGame;

    return this.currentGame;
  }

  createPrediction(question, options) {
    const gameId = 'game_' + Date.now();

    this.currentGame = {
      id: gameId,
      type: 'prediction',
      state: 'active',
      question,
      options: options.map((o, i) => ({
        id: i,
        title: o,
        votes: 0,
        voters: []
      })),
      duration: GAME_TYPES.prediction.duration,
      startedAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + GAME_TYPES.prediction.duration).toISOString(),
      winner: null
    };

    this.participants.clear();
    this.state.twitch.minigame.current = this.currentGame;

    return this.currentGame;
  }

  createSpin(prizes) {
    const gameId = 'game_' + Date.now();

    this.currentGame = {
      id: gameId,
      type: 'spin',
      state: 'active',
      prizes,
      duration: GAME_TYPES.spin.duration,
      startedAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + GAME_TYPES.spin.duration).toISOString(),
      entries: [],
      winner: null
    };

    this.participants.clear();
    this.state.twitch.minigame.current = this.currentGame;

    return this.currentGame;
  }

  createVote(question, options) {
    const gameId = 'game_' + Date.now();

    this.currentGame = {
      id: gameId,
      type: 'vote',
      state: 'active',
      question,
      options: options.map((o, i) => ({
        id: i,
        title: o,
        votes: 0,
        voters: []
      })),
      duration: GAME_TYPES.vote.duration,
      startedAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + GAME_TYPES.vote.duration).toISOString(),
      winner: null
    };

    this.participants.clear();
    this.state.twitch.minigame.current = this.currentGame;

    return this.currentGame;
  }

  addResponse(userId, username, answer, optionId = null) {
    if (!this.currentGame || this.currentGame.state !== 'active') {
      return false;
    }

    // Trivia: track answer
    if (this.currentGame.type === 'trivia') {
      if (!this.currentGame.responses[userId]) {
        this.currentGame.responses[userId] = {
          username,
          answer,
          timestamp: Date.now(),
          correct: answer === this.currentGame.correctAnswerIndex
        };
        this.participants.set(userId, { username });
        return true;
      }
      return false;
    }

    // Prediction/Vote: track option vote
    if ((this.currentGame.type === 'prediction' || this.currentGame.type === 'vote') && optionId !== null) {
      const option = this.currentGame.options[optionId];
      if (option && !option.voters.includes(userId)) {
        option.voters.push(userId);
        option.votes = option.voters.length;
        this.participants.set(userId, { username });
        return true;
      }
      return false;
    }

    // Spin: track entry
    if (this.currentGame.type === 'spin') {
      if (!this.participants.has(userId)) {
        this.currentGame.entries.push({
          userId,
          username,
          joinedAt: Date.now()
        });
        this.participants.set(userId, { username });
        return true;
      }
      return false;
    }

    return false;
  }

  finalize() {
    if (!this.currentGame) return null;

    const game = this.currentGame;

    // Calculate results
    if (game.type === 'trivia') {
      const correct = Object.entries(game.responses)
        .filter(([_, r]) => r.correct)
        .map(([uid, r]) => ({ userId: uid, username: r.username }));

      game.winners = correct.slice(0, 5); // Top 5
      game.state = 'finished';
      game.winner = correct[0] || null;
    }

    if (game.type === 'prediction' || game.type === 'vote') {
      const maxVotes = Math.max(...game.options.map(o => o.votes || 0));
      const winningOption = game.options.find(o => (o.votes || 0) === maxVotes);
      game.winner = winningOption;
      game.state = 'finished';
    }

    if (game.type === 'spin') {
      if (game.entries.length > 0) {
        const randomIdx = Math.floor(Math.random() * game.entries.length);
        game.winner = game.entries[randomIdx];
      }
      game.state = 'finished';
    }

    // Add to history
    this.state.twitch.minigame.history.unshift(game);
    if (this.state.twitch.minigame.history.length > 50) {
      this.state.twitch.minigame.history.pop();
    }

    this.currentGame = null;
    this.participants.clear();

    return game;
  }

  cancel() {
    if (this.currentGame) {
      this.currentGame.state = 'cancelled';
      this.currentGame = null;
      this.participants.clear();
      return true;
    }
    return false;
  }

  getStats() {
    return {
      currentGame: this.currentGame,
      participantCount: this.participants.size,
      totalGames: this.state.twitch.minigame.history.length
    };
  }
}

module.exports = { MiniGameManager, GAME_TYPES };
