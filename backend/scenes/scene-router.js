function createSceneRouter({ logger }) {
  function route(actions = []) {
    const intents = actions.map((item) => ({
      type: 'scene_intent',
      data: item
    }));

    if (intents.length > 0) {
      logger.info({ intents: intents.length }, 'Scene intents generated');
    }

    return intents;
  }

  return {
    route
  };
}

module.exports = {
  createSceneRouter
};
