function createRulesEngine(rules = []) {
  function evaluate(eventName, context = {}) {
    return rules
      .filter((rule) => rule.when === eventName)
      .map((rule) => ({
        id: rule.id,
        action: rule.then,
        context
      }));
  }

  return {
    evaluate
  };
}

module.exports = {
  createRulesEngine
};
