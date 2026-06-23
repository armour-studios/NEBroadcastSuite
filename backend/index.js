const path = require('path');
const pino = require('pino');

const { createDefaultState } = require('./core/state-store');
const { createRulesEngine } = require('./triggers/rules-engine');
const { createSceneRouter } = require('./scenes/scene-router');
const { listThemes } = require('./themes/theme-registry');

function createBackend() {
  const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
  const state = createDefaultState();

  const rulesEngine = createRulesEngine([
    {
      id: 'goal-replay-scene',
      when: 'game:replay_start',
      then: { scene: 'goal', transition: 'cut', durationMs: 6000 }
    }
  ]);

  const sceneRouter = createSceneRouter({ logger });
  const themes = listThemes(path.join(__dirname, '..', 'themes'));

  return {
    logger,
    state,
    themes,
    evaluateAndRoute(eventName, context) {
      const actions = rulesEngine.evaluate(eventName, context);
      return sceneRouter.route(actions);
    }
  };
}

module.exports = {
  createBackend
};
