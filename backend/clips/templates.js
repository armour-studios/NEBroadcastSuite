const MONTAGE_TEMPLATES = {
  highlights: {
    id: 'highlights',
    name: 'Highlight Reel',
    description: 'Straight cuts, fastest encode',
    gapSec: 0,
    introSec: 0,
    outroSec: 0
  },
  brb: {
    id: 'brb',
    name: 'Be Right Back',
    description: 'Clips with BRB slates between — for intermission screens',
    gapSec: 3,
    gapTitle: 'BE RIGHT BACK',
    introSec: 2,
    introTitle: 'HIGHLIGHTS',
    outroSec: 0
  },
  postgame: {
    id: 'postgame',
    name: 'Post-Game Recap',
    description: 'Intro title + clips + outro',
    gapSec: 1,
    gapTitle: '',
    introSec: 3,
    introTitle: 'MATCH HIGHLIGHTS',
    outroSec: 2,
    outroTitle: 'GG'
  }
};

function getTemplate(id) {
  return MONTAGE_TEMPLATES[id] || MONTAGE_TEMPLATES.highlights;
}

function listTemplates() {
  return Object.values(MONTAGE_TEMPLATES);
}

module.exports = { MONTAGE_TEMPLATES, getTemplate, listTemplates };