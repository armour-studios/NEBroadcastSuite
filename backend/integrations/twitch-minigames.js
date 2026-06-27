const GAME_TYPES = {
  trivia:           { name: 'Trivia',            duration: 30000,  rewardPoints: 500 },
  prediction:       { name: 'Prediction',         duration: 30000,  rewardPoints: 500 },
  vote:             { name: 'Vote',               duration: 20000,  rewardPoints: 300 },
  spin:             { name: 'Raffle Spin',        duration: 15000,  rewardPoints: 250 },
  number_guess:     { name: 'Number Guess',       duration: 60000,  rewardPoints: 300 },
  fastest_finger:   { name: 'Fastest Finger',     duration: 30000,  rewardPoints: 500 },
  score_prediction: { name: 'Score Prediction',   duration: 60000,  rewardPoints: 400 }
};

class MiniGameManager {
  constructor(state) {
    this.state = state;
    this.currentGame = null;
    this.participants = new Map();
  }

  _baseGame(type, duration) {
    const dur = duration || GAME_TYPES[type].duration;
    return {
      id: 'game_' + Date.now(),
      type,
      state: 'active',
      duration: dur,
      startedAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + dur).toISOString()
    };
  }

  createTrivia(question, answers, correctAnswerIndex, duration) {
    this.currentGame = {
      ...this._baseGame('trivia', duration),
      question,
      answers,
      correctAnswerIndex,
      responses: {},
      winners: []
    };
    this.participants.clear();
    this.state.twitch.minigame.current = this.currentGame;
    return this.currentGame;
  }

  createPrediction(question, options, duration) {
    this.currentGame = {
      ...this._baseGame('prediction', duration),
      question,
      options: options.map((o, i) => ({ id: i, title: o, votes: 0, voters: [] })),
      winner: null
    };
    this.participants.clear();
    this.state.twitch.minigame.current = this.currentGame;
    return this.currentGame;
  }

  createVote(question, options, duration) {
    this.currentGame = {
      ...this._baseGame('vote', duration),
      question,
      options: options.map((o, i) => ({ id: i, title: o, votes: 0, voters: [] })),
      winner: null
    };
    this.participants.clear();
    this.state.twitch.minigame.current = this.currentGame;
    return this.currentGame;
  }

  createSpin(prizes, duration) {
    this.currentGame = {
      ...this._baseGame('spin', duration),
      prizes,
      entries: [],
      winner: null
    };
    this.participants.clear();
    this.state.twitch.minigame.current = this.currentGame;
    return this.currentGame;
  }

  createNumberGuess(question, targetNumber, duration) {
    this.currentGame = {
      ...this._baseGame('number_guess', duration),
      question,
      targetNumber,
      guesses: {},
      winner: null,
      winners: []
    };
    this.participants.clear();
    this.state.twitch.minigame.current = this.currentGame;
    return this.currentGame;
  }

  createFastestFinger(keyword, duration) {
    const kw = (keyword || '').trim();
    this.currentGame = {
      ...this._baseGame('fastest_finger', duration),
      question: `Type "${kw}" in chat to win!`,
      keyword: kw.toLowerCase(),
      keywordDisplay: kw,
      attempts: 0,
      winner: null
    };
    this.participants.clear();
    this.state.twitch.minigame.current = this.currentGame;
    return this.currentGame;
  }

  createScorePrediction(question, teamA, teamB, maxGames, duration) {
    this.currentGame = {
      ...this._baseGame('score_prediction', duration),
      question: question || 'What will the series score be?',
      teamA: teamA || 'Team A',
      teamB: teamB || 'Team B',
      maxGames: maxGames || 5,
      guesses: {},
      actualScore: null,
      winners: []
    };
    this.participants.clear();
    this.state.twitch.minigame.current = this.currentGame;
    return this.currentGame;
  }

  addResponse(userId, username, answer, extra) {
    if (!this.currentGame || this.currentGame.state !== 'active') return false;
    const game = this.currentGame;

    if (game.type === 'trivia') {
      if (!game.responses[userId]) {
        game.responses[userId] = {
          username, answer, timestamp: Date.now(),
          correct: answer === game.correctAnswerIndex
        };
        this.participants.set(userId, { username });
        return true;
      }
      return false;
    }

    if (game.type === 'prediction' || game.type === 'vote') {
      const optionId = answer; // reuse answer param as optionId
      const option = game.options[optionId];
      if (option && !option.voters.includes(userId)) {
        option.voters.push(userId);
        option.votes = option.voters.length;
        this.participants.set(userId, { username });
        return true;
      }
      return false;
    }

    if (game.type === 'spin') {
      if (!this.participants.has(userId)) {
        game.entries.push({ userId, username, joinedAt: Date.now() });
        this.participants.set(userId, { username });
        return true;
      }
      return false;
    }

    if (game.type === 'number_guess') {
      if (!game.guesses[userId]) {
        game.guesses[userId] = { username, guess: answer, timestamp: Date.now() };
        this.participants.set(userId, { username });
        return true;
      }
      return false;
    }

    if (game.type === 'fastest_finger') {
      if (!game.winner) {
        game.attempts++;
        game.winner = { userId, username };
        game.state = 'finished';
        return 'won';
      }
      return false;
    }

    if (game.type === 'score_prediction') {
      if (!game.guesses[userId]) {
        // answer = [a, b], extra = raw string e.g. "3-1"
        game.guesses[userId] = { username, guess: answer, raw: extra || `${answer[0]}-${answer[1]}`, timestamp: Date.now() };
        this.participants.set(userId, { username });
        return true;
      }
      return false;
    }

    return false;
  }

  finalize(options = {}) {
    if (!this.currentGame) return null;
    const game = this.currentGame;

    if (game.type === 'trivia') {
      const correct = Object.entries(game.responses)
        .filter(([, r]) => r.correct)
        .map(([uid, r]) => ({ userId: uid, username: r.username }));
      game.winners = correct.slice(0, 5);
      game.winner = correct[0] || null;
      game.state = 'finished';
    }

    if (game.type === 'prediction' || game.type === 'vote') {
      const maxVotes = Math.max(0, ...game.options.map(o => o.votes || 0));
      game.winner = game.options.find(o => (o.votes || 0) === maxVotes) || null;
      game.state = 'finished';
    }

    if (game.type === 'spin') {
      if (game.entries.length > 0) {
        game.winner = game.entries[Math.floor(Math.random() * game.entries.length)];
      }
      game.state = 'finished';
    }

    if (game.type === 'number_guess') {
      const target = game.targetNumber;
      const sorted = Object.entries(game.guesses)
        .map(([uid, g]) => ({ userId: uid, username: g.username, guess: g.guess, diff: Math.abs(g.guess - target) }))
        .sort((a, b) => a.diff - b.diff || a.timestamp - b.timestamp);
      game.winners = sorted.slice(0, 5);
      game.winner = sorted[0] || null;
      game.state = 'finished';
    }

    if (game.type === 'fastest_finger') {
      // winner already set in addResponse; just ensure finished
      game.state = 'finished';
    }

    if (game.type === 'score_prediction') {
      const actual = options.actualScore || game.actualScore;
      if (actual) {
        game.actualScore = actual;
        const sorted = Object.entries(game.guesses)
          .map(([uid, g]) => ({
            userId: uid, username: g.username, guess: g.guess, raw: g.raw,
            diff: Math.abs(g.guess[0] - actual[0]) + Math.abs(g.guess[1] - actual[1])
          }))
          .sort((a, b) => a.diff - b.diff);
        game.winners = sorted.slice(0, 5);
        game.winner = sorted[0] || null;
      }
      game.state = 'finished';
    }

    this.state.twitch.minigame.history.unshift(game);
    if (this.state.twitch.minigame.history.length > 50) this.state.twitch.minigame.history.pop();

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
