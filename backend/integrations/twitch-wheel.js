class WheelManager {
  constructor(state) {
    this.state = state;
  }

  addParticipant(userId, displayName, method, weight = 1) {
    if (!this.state.twitch.wheel.participants) {
      this.state.twitch.wheel.participants = [];
    }

    // Check if participant already exists
    const existing = this.state.twitch.wheel.participants.find(p => p.userId === userId);
    if (existing) {
      // Update weight if new method has higher priority
      const methodWeights = { sub: 2, follow: 1, chat: 0.5 };
      if (methodWeights[method] > methodWeights[existing.method]) {
        existing.method = method;
        existing.weight = weight;
      }
      return false; // Not a new participant
    }

    this.state.twitch.wheel.participants.push({
      userId,
      displayName,
      method,
      weight,
      joinedAt: new Date().toISOString()
    });

    return true; // New participant added
  }

  removeParticipant(userId) {
    const idx = this.state.twitch.wheel.participants.findIndex(p => p.userId === userId);
    if (idx !== -1) {
      this.state.twitch.wheel.participants.splice(idx, 1);
      return true;
    }
    return false;
  }

  clearParticipants() {
    this.state.twitch.wheel.participants = [];
  }

  selectWinner() {
    const participants = this.state.twitch.wheel.participants;
    if (!participants || participants.length === 0) {
      throw new Error('No participants in wheel');
    }

    // Weighted random selection
    const totalWeight = participants.reduce((sum, p) => sum + (p.weight || 1), 0);
    let rand = Math.random() * totalWeight;
    let winner = participants[0];

    for (const participant of participants) {
      rand -= (participant.weight || 1);
      if (rand <= 0) {
        winner = participant;
        break;
      }
    }

    return winner;
  }

  spin(duration = 4000) {
    if (this.state.twitch.wheel.participants.length === 0) {
      throw new Error('Cannot spin: no participants');
    }

    const spinId = 'spin_' + Date.now();
    const winner = this.selectWinner();

    this.state.twitch.wheel.current = {
      id: spinId,
      spinning: true,
      winner,
      startedAt: new Date().toISOString(),
      duration,
      selectedAt: null
    };

    return {
      spinId,
      duration,
      winner
    };
  }

  finalizeSpin(winnerData) {
    if (!this.state.twitch.wheel.current) {
      throw new Error('No active spin');
    }

    const spin = {
      ...this.state.twitch.wheel.current,
      spinning: false,
      selectedAt: new Date().toISOString(),
      winner: winnerData
    };

    this.state.twitch.wheel.history.unshift(spin);
    if (this.state.twitch.wheel.history.length > 100) {
      this.state.twitch.wheel.history.pop();
    }

    this.state.twitch.wheel.current = null;

    return spin;
  }

  getStats() {
    return {
      totalParticipants: this.state.twitch.wheel.participants.length,
      totalSpins: this.state.twitch.wheel.history.length,
      methodBreakdown: {
        followers: this.state.twitch.wheel.participants.filter(p => p.method === 'follow').length,
        subscribers: this.state.twitch.wheel.participants.filter(p => p.method === 'sub').length,
        chat: this.state.twitch.wheel.participants.filter(p => p.method === 'chat').length
      }
    };
  }
}

module.exports = { WheelManager };
