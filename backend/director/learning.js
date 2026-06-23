/**
 * Lightweight producer-feedback learning — no ML, just weight adjustments.
 * Learns which event types and targets producers prefer over time.
 * Persists to director-learning.json in userData.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_WEIGHTS = {
  version: 1,
  global: {},
  byGame: {},
  byPlayer: {},
  stats: { totalFeedback: 0, accepted: 0, overridden: 0, locked: 0 }
};

function createLearningStore(dataDir) {
  const file = path.join(dataDir, 'director-learning.json');
  let weights = { ...DEFAULT_WEIGHTS };

  function load() {
    try {
      if (fs.existsSync(file)) {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        weights = { ...DEFAULT_WEIGHTS, ...saved };
        weights.global = saved.global || {};
        weights.byGame = saved.byGame || {};
        weights.byPlayer = saved.byPlayer || {};
        weights.stats = { ...DEFAULT_WEIGHTS.stats, ...(saved.stats || {}) };
      }
    } catch (e) {
      weights = { ...DEFAULT_WEIGHTS };
    }
  }

  function save() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(weights, null, 2));
    } catch (e) {
      console.error('[Director Learning] save failed:', e.message);
    }
  }

  function bump(map, key, delta) {
    if (!key) return;
    map[key] = Math.max(-30, Math.min(30, (map[key] || 0) + delta));
  }

  /**
   * @param {'accepted'|'rejected'|'locked'|'overridden'} action
   */
  function recordFeedback({ game, eventType, targetId, action, sensitivity }) {
    const delta = action === 'accepted' || action === 'locked' ? 2 : -1;
    const sensMul = 0.5 + (sensitivity ?? 0.5);

    bump(weights.global, eventType, delta * 0.5);
    if (!weights.byGame[game]) weights.byGame[game] = {};
    bump(weights.byGame[game], eventType, delta * sensMul);
    if (targetId) {
      const pk = `${game}:${targetId}`;
      bump(weights.byPlayer, pk, delta * 0.3);
    }

    weights.stats.totalFeedback++;
    if (action === 'accepted') weights.stats.accepted++;
    if (action === 'locked') weights.stats.locked++;
    if (action === 'overridden') weights.stats.overridden++;

    save();
  }

  function getBoost(game, eventType, targetId) {
    const g = (weights.byGame[game] || {})[eventType] || 0;
    const gl = weights.global[eventType] || 0;
    const pk = targetId ? `${game}:${targetId}` : '';
    const pl = pk ? (weights.byPlayer[pk] || 0) : 0;
    return g + gl * 0.5 + pl;
  }

  function getStats() {
    const s = weights.stats;
    const accuracy = s.totalFeedback > 0
      ? Math.round((s.accepted / s.totalFeedback) * 100)
      : 0;
    return { ...s, accuracy };
  }

  load();

  return { recordFeedback, getBoost, getStats, reload: load };
}

module.exports = { createLearningStore };