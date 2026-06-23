const { z } = require('zod');

const TeamSchema = z.object({
  name: z.string().default(''),
  logo: z.string().nullable().default(null)
});

const StateSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  view: z.enum(['hud', 'goal', 'scoreboard']).default('hud'),
  eventName: z.string().default('ROCKET LEAGUE TOURNAMENT'),
  bestOf: z.number().int().min(1).max(9).default(5),
  teams: z.object({
    blue: TeamSchema,
    orange: TeamSchema
  }),
  series: z.object({
    blue: z.number().int().min(0).default(0),
    orange: z.number().int().min(0).default(0)
  }),
  game: z.object({
    blueScore: z.number().int().default(0),
    orangeScore: z.number().int().default(0),
    time: z.number().int().default(300),
    isOT: z.boolean().default(false),
    number: z.number().int().min(1).default(1)
  })
});

function createDefaultState(overrides = {}) {
  return StateSchema.parse({
    teams: {
      blue: { name: 'BLUE TEAM', logo: null },
      orange: { name: 'ORANGE TEAM', logo: null }
    },
    ...overrides
  });
}

function validateState(candidate) {
  return StateSchema.parse(candidate);
}

module.exports = {
  StateSchema,
  createDefaultState,
  validateState
};
