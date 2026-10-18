// node test/brand-overlay-look.test.js
// A brand package's captured show setup carries the Rocket League overlay look (wording, colours,
// styles), so exporting a kit or syncing it to the org brings the look along. server.js
// applyOverlayLook() must only take known fields with sane values: a kit file is user data.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
let pass = 0;
const ok = (c, why) => { assert.ok(c, why); pass++; };

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const m = src.match(/function applyOverlayLook\(o\) \{[\s\S]*?\r?\n\}/);
ok(!!m, 'applyOverlayLook found');
const state = {
  overtime: { label: 'OVERTIME', bg: '#e0202a', color: '#ffffff', logo: 'keep' },
  replay: { label: 'REPLAY', colorMode: 'team', style: 'slam', logo: 'keep' },
  scoreboardAd: { label: 'PRESENTED BY', logo: 'keep' },
  rlStatsScreen: { showStats: true, design: 'default' },
  rlReplayTransitions: true, rlSponsorRoll: false, worldsTicker: true,
  worldsSidebar: { visible: true, title: 'Total Goals', subtitle: '', rows: [1, 2] },
};
const apply = new Function('state', 'REPLAY_STYLES', m[0] + '; return applyOverlayLook;')(state, ['slam', 'cinema', 'sweep']);

apply({
  overtime: { label: 'KENZOT', bg: '#112233', color: 'red; background:url(x)' },
  replay: { label: 'INSTANT REPLAY', colorMode: 'mono', style: 'cinema' },
  scoreboardLabel: 'Powered By:',
  rlStatsScreen: { showStats: false, design: 'compare' },
  rlReplayTransitions: false, rlSponsorRoll: true, worldsTicker: false,
  worldsSidebar: { title: 'All-Time Goals', subtitle: 'Worlds', rows: ['x'] },
});
ok(state.overtime.label === 'KENZOT' && state.overtime.bg === '#112233', 'overtime wording and bar colour applied');
ok(state.overtime.color === '#ffffff', 'a colour that is not a hex colour is ignored');
ok(state.overtime.logo === 'keep' && state.replay.logo === 'keep' && state.scoreboardAd.logo === 'keep', 'sponsor logos stay with the brand placements');
ok(state.replay.label === 'INSTANT REPLAY' && state.replay.colorMode === 'mono' && state.replay.style === 'cinema', 'replay look applied');
ok(state.scoreboardAd.label === 'Powered By:', 'Presented by label applied');
ok(state.rlStatsScreen.showStats === false && state.rlStatsScreen.design === 'compare', 'scoreboard style applied');
ok(!state.rlReplayTransitions && state.rlSponsorRoll && !state.worldsTicker, 'switches applied');
ok(state.worldsSidebar.title === 'All-Time Goals' && state.worldsSidebar.rows.length === 2 && state.worldsSidebar.visible, 'sidebar wording only; its rows and visibility stay');

apply({ replay: { style: 'explode', colorMode: 'neon' }, rlStatsScreen: { design: 'fancy' } });
ok(state.replay.style === 'cinema' && state.replay.colorMode === 'mono' && state.rlStatsScreen.design === 'compare', 'unknown styles are ignored');
apply(null); apply('x');
ok(state.overtime.label === 'KENZOT', 'a missing look changes nothing');
console.log('brand-overlay-look: ' + pass + ' checks passed');
