const { pruneEvents } = require('./events');
const { getStorylineBoost } = require('./storyline');

const DEFAULTS = {
  dwellMs: 4000,
  cooldownMs: 2500,
  preemptGap: 25,
  feedMax: 40
};

/**
 * Game-agnostic director core — scoring, dwell, cooldown, alternates.
 */
function createDirectorCore({ learning, onStateChange }) {
  let settings = { enabled: true, sensitivity: 0.5, lockTarget: null, autoSwitch: false };
  let storylineContext = null;
  let activeEvents = [];
  let feed = [];
  let current = { primary: null, alternates: [], confidence: 0 };
  let lastSwitchAt = 0;
  let currentPrimaryKey = '';

  function targetKey(t) {
    if (!t) return '';
    return `${t.kind}:${t.id}`;
  }

  function scoreEvent(event, now) {
    const age = now - event.ts;
    const recencyBoost = Math.max(0, 20 - age / 400);
    const staleness = age / 1000;
    const learnBoost = learning ? learning.getBoost(event.game, event.type, event.target?.id) : 0;
    const storyBoost = getStorylineBoost(event, storylineContext);
    const sensMul = 0.7 + settings.sensitivity * 0.6;
    return (event.priority + recencyBoost - staleness + learnBoost + storyBoost) * sensMul;
  }

  function shotFromEvent(event, score) {
    return {
      target: event.target,
      name: event.target?.name || '?',
      type: event.type,
      reason: event.reason,
      confidence: Math.min(99, Math.round(score)),
      gameTime: event.gameTime
    };
  }

  function pushFeed(event) {
    feed.unshift({
      id: `feed_${event.ts}_${event.type}_${event.target?.id || 'x'}`,
      ts: event.ts,
      type: event.type,
      target: event.target?.name,
      targetId: event.target?.id || null,
      targetKind: event.target?.kind || null,
      reason: event.reason,
      gameTime: event.gameTime || null
    });
    if (feed.length > DEFAULTS.feedMax) feed.length = DEFAULTS.feedMax;
  }

  function buildCandidates(adapter, gameState, now) {
    const candidates = [];
    activeEvents.forEach((e) => {
      candidates.push({ event: e, score: scoreEvent(e, now) });
    });
    const baseline = adapter.getBaseline(gameState);
    if (baseline) {
      candidates.push({ event: baseline, score: scoreEvent(baseline, now) });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  }

  function tick(adapter, gameState) {
    if (!settings.enabled) {
      return getOutput();
    }

    const now = Date.now();
    activeEvents = pruneEvents(activeEvents, now);

    const candidates = buildCandidates(adapter, gameState, now);
    if (!candidates.length) {
      current = { primary: null, alternates: [], confidence: 0 };
      emit();
      return getOutput();
    }

    // Manual lock override
    if (settings.lockTarget) {
      const locked = candidates.find((c) => targetKey(c.event.target) === settings.lockTarget)
        || candidates.find((c) => c.event.target?.id === settings.lockTarget);
      if (locked) {
        current = {
          primary: shotFromEvent(locked.event, locked.score),
          alternates: candidates.filter((c) => c !== locked).slice(0, 3).map((c) => shotFromEvent(c.event, c.score)),
          confidence: Math.min(99, Math.round(locked.score))
        };
        emit();
        return getOutput();
      }
    }

    const best = candidates[0];
    const bestKey = targetKey(best.event.target);
    const preemptThreshold = DEFAULTS.preemptGap * (1.1 - settings.sensitivity * 0.5);

    const canSwitch = (now - lastSwitchAt) >= DEFAULTS.cooldownMs;
    const dwellMet = (now - lastSwitchAt) >= DEFAULTS.dwellMs;
    const isPreempt = best.score - (current.confidence || 0) >= preemptThreshold;

    if (!currentPrimaryKey || canSwitch && (dwellMet || isPreempt || best.event.type === 'ace' || best.event.type === 'goal')) {
      if (bestKey !== currentPrimaryKey) {
        lastSwitchAt = now;
        currentPrimaryKey = bestKey;
      }
      current = {
        primary: shotFromEvent(best.event, best.score),
        alternates: candidates.slice(1, 4).map((c) => shotFromEvent(c.event, c.score)),
        confidence: Math.min(99, Math.round(best.score))
      };
    } else {
      current.alternates = candidates.slice(0, 3).map((c) => shotFromEvent(c.event, c.score));
    }

    emit();
    return getOutput();
  }

  function ingestEvents(events) {
    events.forEach((e) => {
      activeEvents.push(e);
      pushFeed(e);
    });
    activeEvents = pruneEvents(activeEvents);
  }

  function setStorylineContext(ctx) {
    storylineContext = ctx;
  }

  function setSettings(patch) {
    if ('enabled' in patch) settings.enabled = !!patch.enabled;
    if ('sensitivity' in patch) settings.sensitivity = Math.max(0, Math.min(1, Number(patch.sensitivity) || 0.5));
    if ('lockTarget' in patch) settings.lockTarget = patch.lockTarget || null;
    if ('autoSwitch' in patch) settings.autoSwitch = !!patch.autoSwitch;
    emit();
  }

  function getSettings() {
    return { ...settings };
  }

  function getOutput() {
    return {
      enabled: settings.enabled,
      sensitivity: settings.sensitivity,
      lockTarget: settings.lockTarget,
      autoSwitch: settings.autoSwitch,
      primary: current.primary,
      alternates: current.alternates || [],
      confidence: current.confidence || 0,
      feed: feed.slice(0, 20),
      learning: learning ? learning.getStats() : null
    };
  }

  function emit() {
    if (onStateChange) onStateChange(getOutput());
  }

  function reset() {
    activeEvents = [];
    feed = [];
    current = { primary: null, alternates: [], confidence: 0 };
    currentPrimaryKey = '';
    lastSwitchAt = 0;
  }

  return {
    tick,
    ingestEvents,
    setSettings,
    setStorylineContext,
    getSettings,
    getOutput,
    reset
  };
}

module.exports = { createDirectorCore, DEFAULTS };