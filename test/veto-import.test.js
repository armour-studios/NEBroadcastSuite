'use strict';
// Map veto import from FACEIT room / HLTV match links (backend/veto-import.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const vi = require('../backend/veto-import');

test('parseVetoUrl recognises FACEIT rooms and HLTV matches', () => {
  assert.deepEqual(vi.parseVetoUrl('https://www.faceit.com/en/cs2/room/1-2f3a-4b5c/scoreboard').id, '1-2f3a-4b5c');
  assert.equal(vi.parseVetoUrl('faceit.com/en/csgo/room/1-abc').source, 'faceit');
  const h = vi.parseVetoUrl('https://www.hltv.org/matches/2372555/vitality-vs-faze-iem-cologne-2024');
  assert.equal(h.source, 'hltv'); assert.equal(h.id, '2372555');
  assert.equal(vi.parseVetoUrl('https://example.com/x'), null);
  assert.equal(vi.parseVetoUrl(''), null);
});

test('mapIdFromName normalises every spelling', () => {
  assert.equal(vi.mapIdFromName('de_mirage'), 'mirage');
  assert.equal(vi.mapIdFromName('Dust II'), 'dust2');
  assert.equal(vi.mapIdFromName('Dust2'), 'dust2');
  assert.equal(vi.mapIdFromName('de_dust2'), 'dust2');
  assert.equal(vi.mapIdFromName('Ancient '), 'ancient');
});

const HLTV = `
<div class="team1-gradient"><img alt="Vitality" src="https://img-cdn.hltv.org/teamlogo/vit.png" class="logo" title="Vitality"><div class="teamName">Vitality</div></div>
<div class="team2-gradient"><img alt="FaZe" src="https://img-cdn.hltv.org/teamlogo/faze.png" class="logo" title="FaZe"><div class="teamName">FaZe</div></div>
<div class="standard-box veto-box"><div class="padding preformatted-text">Best of 3 (LAN)

* Vitality has won the coin toss</div></div>
<div class="standard-box veto-box"><div class="padding">
<div>1. Vitality removed Dust2</div>
<div>2. FaZe removed Anubis</div>
<div>3. Vitality picked Mirage</div>
<div>4. FaZe picked Ancient</div>
<div>5. Vitality removed Inferno</div>
<div>6. FaZe removed Nuke</div>
<div>7. Train was left over</div>
</div></div>
<div class="mapholder"><div class="played"><div class="mapname">Mirage</div></div><div class="results"><div class="results-left won"><div class="results-team-score">13</div></div><div class="results-right lost"><div class="results-team-score">9</div></div></div></div>
<div class="mapholder"><div class="played"><div class="mapname">Ancient</div></div><div class="results"><div class="results-left lost"><div class="results-team-score">7</div></div><div class="results-right won"><div class="results-team-score">13</div></div></div></div>
`;

test('importHltv reads teams, best-of, the seven steps and map results', () => {
  const r = vi.importHltv(HLTV);
  assert.equal(r.source, 'hltv');
  assert.deepEqual(r.teams.map((t) => t.name), ['Vitality', 'FaZe']);
  assert.equal(r.teams[1].logo, 'https://img-cdn.hltv.org/teamlogo/faze.png');
  assert.equal(r.bestOf, 3);
  assert.equal(r.teamStart, 'a');
  assert.deepEqual(r.steps.map((s) => [s.mapId, s.action, s.by]), [
    ['dust2', 'ban', 0], ['anubis', 'ban', 1], ['mirage', 'pick', 0], ['ancient', 'pick', 1],
    ['inferno', 'ban', 0], ['nuke', 'ban', 1], ['train', 'decider', null],
  ]);
  assert.deepEqual(r.results, [
    { mapId: 'mirage', score: { a: 13, b: 9 }, winner: 0 },
    { mapId: 'ancient', score: { a: 7, b: 13 }, winner: 1 },
  ]);
});

test('importHltv: team 2 banning first flips teamStart', () => {
  const html = HLTV.replace('1. Vitality removed Dust2', '1. FaZe removed Dust2').replace('2. FaZe removed Anubis', '2. Vitality removed Anubis');
  assert.equal(vi.importHltv(html).teamStart, 'b');
});

test('importHltv rejects a page with no veto yet', () => {
  assert.throws(() => vi.importHltv('<div class="teamName">A</div><div class="teamName">B</div>'), /No veto/);
});

const FACEIT_MATCH = {
  best_of: 3,
  teams: { faction1: { name: 'Team Alpha', avatar: 'https://a/alpha.png' }, faction2: { name: 'Team Beta', avatar: 'https://a/beta.png' } },
  voting: { map: {
    pick: ['de_ancient', 'de_nuke', 'de_inferno'],
    entities: [{ game_map_id: 'de_ancient', name: 'Ancient', image_lg: 'https://a/ancient.jpg' }, { game_map_id: 'de_nuke', name: 'Nuke' }, { game_map_id: 'de_inferno', name: 'Inferno' }],
  } },
};
const FACEIT_HISTORY = { payload: { tickets: [{ entity_type: 'map', entities: [
  { guid: 'de_mirage', status: 'drop', selected_by: 'faction2' },
  { guid: 'de_dust2', status: 'drop', selected_by: 'faction1' },
  { guid: 'de_ancient', status: 'pick', selected_by: 'faction2' },
  { guid: 'de_nuke', status: 'pick', selected_by: 'faction1' },
  { guid: 'de_anubis', status: 'drop', selected_by: 'faction2' },
  { guid: 'de_train', status: 'drop', selected_by: 'faction1' },
  { guid: 'de_inferno', status: 'pick', random: true },
] }] } };

test('importFaceit uses the room history for ban order and the match for teams', () => {
  const r = vi.importFaceit(FACEIT_MATCH, FACEIT_HISTORY);
  assert.deepEqual(r.teams, [{ name: 'Team Alpha', logo: 'https://a/alpha.png' }, { name: 'Team Beta', logo: 'https://a/beta.png' }]);
  assert.equal(r.bestOf, 3);
  assert.equal(r.teamStart, 'b');
  assert.deepEqual(r.steps.map((s) => [s.mapId, s.action, s.by]), [
    ['mirage', 'ban', 1], ['dust2', 'ban', 0], ['ancient', 'pick', 1], ['nuke', 'pick', 0],
    ['anubis', 'ban', 1], ['train', 'ban', 0], ['inferno', 'decider', null],
  ]);
  assert.equal(r.steps[2].image, 'https://a/ancient.jpg');
});

test('importFaceit falls back to the picked maps when there is no history', () => {
  const r = vi.importFaceit(FACEIT_MATCH, null);
  assert.deepEqual(r.steps.map((s) => s.mapId), ['ancient', 'nuke', 'inferno']);
  assert.equal(r.steps.every((s) => s.action === 'pick'), true);
});

test('importVeto routes a FACEIT link through the injected fetcher and tries the key first', async () => {
  const calls = [];
  const fetchJson = async (url, headers) => {
    calls.push([url, headers && headers.Authorization]);
    if (url.includes('open.faceit.com')) return FACEIT_MATCH;
    if (url.includes('/history')) return FACEIT_HISTORY;
    throw new Error('unexpected ' + url);
  };
  const r = await vi.importVeto('https://www.faceit.com/en/cs2/room/1-abc', { faceitKey: 'k', fetchJson });
  assert.equal(r.steps.length, 7);
  assert.equal(calls[0][1], 'Bearer k');
});

test('importVeto routes an HLTV link through fetchHtml', async () => {
  const r = await vi.importVeto('https://www.hltv.org/matches/1/x', { fetchHtml: async () => HLTV });
  assert.equal(r.source, 'hltv');
  assert.equal(r.steps.length, 7);
  await assert.rejects(vi.importVeto('https://www.hltv.org/matches/1/x', { fetchHtml: async () => '<title>Just a moment...</title>' }), (e) => /paste/.test(e.message) && e.openUrl === 'https://www.hltv.org/matches/1/x');
});

test('importPasted reads the veto lines copied off an HLTV page, with or without line breaks', async () => {
  const text = 'Best of 3 (LAN)\n1. BIG removed Ancient\n2. G2 removed Dust2\n3. BIG picked Mirage\n4. G2 picked Inferno\n5. BIG removed Train\n6. G2 removed Anubis\n7. Nuke was left over';
  const r = vi.importPasted(text);
  assert.deepEqual(r.teams.map((t) => t.name), ['BIG', 'G2']);
  assert.equal(r.bestOf, 3);
  assert.deepEqual(r.steps.map((s) => s.mapId + ':' + s.action + ':' + s.by), ['ancient:ban:0', 'dust2:ban:1', 'mirage:pick:0', 'inferno:pick:1', 'train:ban:0', 'anubis:ban:1', 'nuke:decider:null']);
  const flat = vi.importPasted(text.replace(/\n/g, ' '));
  assert.equal(flat.steps.length, 7);
  assert.equal(flat.steps[6].mapId, 'nuke');
  // importVeto routes pasted text without touching the network.
  const viaImport = await vi.importVeto(text, { fetchHtml: async () => { throw new Error('no network'); } });
  assert.equal(viaImport.source, 'pasted');
  assert.throws(() => vi.importPasted('nothing here'), /No veto lines/);
});
