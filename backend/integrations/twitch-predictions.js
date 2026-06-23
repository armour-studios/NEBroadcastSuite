const { TwitchClient } = require('./twitch-client');

class PredictionManager {
  constructor(twitchClient, broadcasterId) {
    this.client = twitchClient;
    this.broadcasterId = broadcasterId;
    this.currentPrediction = null;
    this.cooldownUntil = 0;
  }

  async createPrediction(title, outcomes, durationSeconds) {
    // Check cooldown
    if (Date.now() < this.cooldownUntil) {
      throw new Error('Prediction cooldown active (5 minutes between predictions)');
    }

    console.log(`[Twitch] Creating prediction: "${title}"`);
    const result = await this.client.createPrediction(
      this.broadcasterId,
      title,
      outcomes,
      durationSeconds
    );

    if (result) {
      this.currentPrediction = result;
      this.cooldownUntil = Date.now() + 300000; // 5 min cooldown
      console.log('[Twitch] Prediction created:', result.id);
      return result;
    }

    throw new Error('Failed to create prediction on Twitch API');
  }

  async resolvePrediction(outcomeId) {
    if (!this.currentPrediction) {
      throw new Error('No active prediction to resolve');
    }

    console.log(`[Twitch] Resolving prediction with outcome: ${outcomeId}`);
    const result = await this.client.resolvePrediction(
      this.broadcasterId,
      this.currentPrediction.id,
      outcomeId
    );

    if (result) {
      this.currentPrediction = null;
      console.log('[Twitch] Prediction resolved');
      return result;
    }

    throw new Error('Failed to resolve prediction on Twitch API');
  }

  async cancelPrediction() {
    if (!this.currentPrediction) throw new Error('No active prediction to cancel');
    const result = await this.client.cancelPrediction(this.broadcasterId, this.currentPrediction.id);
    if (result) {
      this.currentPrediction = null;
      this.cooldownUntil = 0; // cancel doesn't start the cooldown
      return result;
    }
    throw new Error('Failed to cancel prediction on Twitch API');
  }

  getCurrentPrediction() {
    return this.currentPrediction;
  }

  isOnCooldown() {
    return Date.now() < this.cooldownUntil;
  }

  getCooldownRemaining() {
    const remaining = this.cooldownUntil - Date.now();
    return remaining > 0 ? remaining : 0;
  }
}

module.exports = { PredictionManager };
