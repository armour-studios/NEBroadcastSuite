// node test/site-event.test.js
//
// Website events (siteEvent*): the one-click load, auto-follow of the match the website marks live
// on the stream, and score reports back. Drives the REAL functions out of server.js (pulled by
// source) against a stubbed cloud client; scoreboard plumbing that lives elsewhere is stubbed.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const competition = require('../backend/competition.js');

const src = require('./lib/server-source').serverSource().replace(/\r\n/g, '\n');
function fn(name) {
  let start = src.indexOf('\nfunction ' + name + '(');
  if (start < 0) start = src.indexOf('\nasync function ' + name + '(');
  assert.ok(start >= 0, name + ' not found in server.js');
  const end = src.indexOf('\n}', start) + 2;
  return src.slice(start, end);
}
const NAMES = ['normalizeCompetitionSettings', 'competitionLeague', 'compResolveTeam', 'competitionLiveIds',
  'competitionScheduleRows', 'refreshCompetitionFeed', 'competitionGoLive', 'applyCompetitionDoc',
  'describeSyncReport', 'lgRecalcServer', 'srvLgMatchTally', 'srvLgUid', 'compSyncStatus',
  'cloudOrgId', 'cloudCompError', 'readLeagueSource', 'syncLeagueSource', 'httpUrlOnly', 'cloudGetCompetition',
  'siteEventState', 'siteEventLeague', 'siteTeamName', 'mergeSiteTeamsIntoLibrary', 'siteAdoptGame', 'loadSiteEvent',
  'putSiteMatchOnAir', 'siteOnStreamMatch', 'siteEventFollow', 'siteReportCapture', 'siteReportHeld', '_siteReportSend', 'lgCaptureAppendGame', 'lgCaptureFinalize'];
const signInLine = src.match(/^const CLOUD_COMP_SIGNIN = .*$/m)[0];

const team = () => ({ name: '', nameRaw: '', logo: '', players: [], color: '#000000', abbr: '' });
function world() {
  const state = {
    leagues: [], competition: null, compFeed: null, compSync: {}, cloudCompetitions: [],
    upcoming: { source: 'event', matches: [], showResults: true, title: '' }, standings: { source: '', rows: [] },
    ticker: { source: 'manual' }, leagueCapture: { active: false }, teams: { blue: team(), orange: team() },
    activeEvent: {}, activeGame: 'valorant', bestOf: 3, roundLabel: '', eventName: '',
  };
  const savedTeams = [];
  const reports = [];
  const calls = { reset: 0, platform: '', game: '' };
  const cloud = {
    docs: {},
    authed: () => true, configured: () => true,
    getSession: () => ({ workspaceId: 'user:1' }),
    async getMyCompetition(id) { const d = cloud.docs[id]; if (!d) { const e = new Error('nf'); e.status = 404; throw e; } return { doc: JSON.parse(JSON.stringify(d)), etag: '' }; },
    async reportCompetitionMatch(id, mid, body) { reports.push({ id, mid, ...body }); return { ok: true }; },
  };
  const GAMES = { 'rocket-league': { name: 'Rocket League' }, valorant: { name: 'Valorant' } };
  const body = 'let leaguesVer = 0; let _srvLgUidC = 1; let _compRoutesLegacy = false; const _siteReports = new Map(); const _siteReportHold = new Map();\n' +
    'const _compEtags = {}; const _compCloudRevs = {};\nlet sheetsServiceAccount = ""; const sheets = {}; const competitionFeedTokens = {};\n' +
    signInLine + '\n' + NAMES.map(fn).join('\n') + '\nreturn { ' + NAMES.join(', ') + ' };';
  const make = new Function('state', 'savedTeams', 'competition', 'competitionSources', 'cloud', 'saveAppState', 'broadcastFullState',
    'refreshLeagueStandingsMirror', 'migrateLeague', 'console', 'GAMES', 'applyActiveGame', 'adoptEventGame', 'adoptEventName',
    'setActivePlatform', 'saveTeams', 'finalizeAndResetSeries', 'logoForTeamName', 'cleanTeamAbbr', 'abbrForTeamName',
    'rebuildCombinedPlayers', 'logAuto', body);
  const quiet = { log() {}, warn() {}, error() {} };
  const api = make(state, savedTeams, competition, require('../backend/competition-sources.js'), cloud, () => {}, () => {}, () => {},
    (lg) => Object.assign({ teams: [], schedule: [], standings: [], scoring: { win: 3, loss: 0, draw: 1, otw: 2 }, type: 'team', status: 'active' }, lg),
    quiet, GAMES, (g) => { state.activeGame = g; calls.game = g; return true; }, () => ({}), (s, n) => { state.eventName = n; },
    (p) => { calls.platform = p; state.activeEvent.platform = p; }, () => {}, () => { calls.reset++; state.leagueCapture = { active: false }; },
    () => '', (v) => (String(v || '').toUpperCase().slice(0, 6) || null), (n) => String(n).slice(0, 3).toUpperCase(), () => {}, () => {});
  return { state, savedTeams, reports, calls, cloud, api };
}

const DOC = (matches) => ({
  format: 'ne-competition', version: 1,
  competition: { id: 'c1', name: 'Fall League', season: 'Fall 2026', game: 'rocket-league' },
  teams: [
    { id: 'p1', name: 'Riverside', abbr: 'RVS', logo: 'https://x.test/r.png', players: [{ id: 'u1', name: 'Ace', role: 'Captain' }, { id: 'u2', name: 'Bolt' }] },
    { id: 'p2', name: 'Lakeside', logo: 'https://x.test/l.png', players: [{ id: 'u3', name: 'Cruz' }] },
    { id: 'p3', name: 'Hilltop', players: [] },
  ],
  matches,
});

(async () => {
  // 1. Load: league mirror, library, on air, platform, game. Two live matches, one on the stream → that one.
  {
    const { state, savedTeams, calls, cloud, api } = world();
    state.cloudCompetitions = [{ id: 'c1', name: 'Fall League', season: 'Fall 2026', game: 'rocket-league', kind: 'league', rev: 5, url: 'https://x.test/c1' }];
    cloud.docs.c1 = DOC([
      { id: 'f1', teamA: 'p1', teamB: 'p3', status: 'live', bestOf: 5, round: 'Week 1' },
      { id: 'f2', teamA: 'p1', teamB: 'p2', status: 'live', bestOf: 5, round: 'Week 1', onStream: true, queuePos: 1 },
      { id: 'f3', teamA: 'p2', teamB: 'p3', scheduledAt: '2099-01-01T19:00:00Z', bestOf: 3 },
    ]);
    const r = await api.loadSiteEvent('c1');
    assert.ok(r.ok);
    const lg = state.leagues[0];
    assert.strictEqual(lg.source.type, 'cloud');
    assert.strictEqual(lg.teams.length, 3);
    assert.deepStrictEqual(lg.teams[0].players.map((p) => p.name), ['Ace', 'Bolt'], 'website roster on the league team');
    assert.deepStrictEqual(savedTeams.map((t) => t.name), ['Riverside', 'Lakeside', 'Hilltop'], 'teams in the library');
    assert.strictEqual(savedTeams[0].siteId, 'p1');
    assert.strictEqual(state.competition.leagueId, lg.id, 'on air');
    assert.strictEqual(calls.platform, 'nameless');
    assert.strictEqual(calls.game, 'rocket-league');
    assert.strictEqual(state.activeEvent.name, 'Fall League');
    // auto-follow picked the queued match, not the other live one
    assert.strictEqual(state.teams.blue.name, 'RIVERSIDE');
    assert.strictEqual(state.teams.orange.name, 'LAKESIDE');
    assert.strictEqual(state.teams.blue.logo, 'https://x.test/r.png');
    assert.deepStrictEqual(state.teams.blue.players.map((p) => p.name), ['Ace', 'Bolt']);
    assert.strictEqual(state.bestOf, 5);
    assert.strictEqual(state.roundLabel, 'WEEK 1');
    assert.ok(state.leagueCapture.active && state.leagueCapture.matchId === lg.schedule.find((m) => m.extId === 'f2').id, 'capture armed on f2');
    console.log('PASS  load: mirror league, library, on air, game; auto-follow takes the stream-queued live match');
  }

  // 2. Reports: each game goes up as in-progress, the clincher as final; a busy series is never yanked.
  {
    const { state, reports, cloud, api } = world();
    cloud.docs.c1 = DOC([{ id: 'f2', teamA: 'p1', teamB: 'p2', status: 'live', bestOf: 3, onStream: true }]);
    await api.loadSiteEvent('c1');
    api.lgCaptureAppendGame(3, 1);
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(reports[0], { id: 'c1', mid: 'f2', games: [{ scoreA: 3, scoreB: 1 }], scoreA: 1, scoreB: 0, final: false, source: 'broadcast-studio' });
    // The website now marks a different match live: the series in progress stays on air.
    cloud.docs.c1 = DOC([{ id: 'f2', teamA: 'p1', teamB: 'p2', status: 'live', bestOf: 3 }, { id: 'f9', teamA: 'p2', teamB: 'p3', status: 'live', onStream: true }]);
    await api.syncLeagueSource(state.leagues[0].id);
    api.siteEventFollow(state.leagues[0]);
    assert.strictEqual(state.teams.orange.name, 'LAKESIDE', 'mid-series match kept');
    api.lgCaptureAppendGame(2, 0);
    await new Promise((r) => setImmediate(r));
    const fin = reports[reports.length - 1];
    assert.strictEqual(fin.final, true);
    assert.strictEqual(fin.scoreA, 2);
    assert.strictEqual(state.leagueCapture.active, false, 'disarmed after the clincher');
    // ...and now the next queued live match loads.
    api.siteEventFollow(state.leagues[0]);
    assert.strictEqual(state.teams.blue.name, 'LAKESIDE');
    assert.strictEqual(state.teams.orange.name, 'HILLTOP');
    console.log('PASS  reports per game + final; a series in progress is never switched away');
  }

  // 3. Several live, none queued → no guess. Auto-report off → nothing sent.
  {
    const { state, reports, cloud, api } = world();
    cloud.docs.c1 = DOC([{ id: 'f1', teamA: 'p1', teamB: 'p3', status: 'live' }, { id: 'f2', teamA: 'p1', teamB: 'p2', status: 'live' }]);
    await api.loadSiteEvent('c1');
    assert.strictEqual(state.teams.blue.name, '', 'nothing loaded when the stream match is ambiguous');
    state.siteEvent.autoReport = false;
    api.putSiteMatchOnAir('f1');
    api.lgCaptureAppendGame(1, 0);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(reports.length, 0);
    console.log('PASS  ambiguous live matches are not guessed; auto-report off sends nothing');
  }

  // 4. A producer's own team keeps its crest and roster; only gaps are filled.
  {
    const { savedTeams, cloud, api } = world();
    savedTeams.push({ name: 'Riverside', logo: 'mine.png', players: [{ name: 'Local' }] });
    cloud.docs.c1 = DOC([]);
    await api.loadSiteEvent('c1');
    assert.strictEqual(savedTeams[0].logo, 'mine.png');
    assert.deepStrictEqual(savedTeams[0].players.map((p) => p.name), ['Local']);
    assert.strictEqual(savedTeams[0].siteId, 'p1', 'linked for next time');
    console.log('PASS  hand-built library teams keep their crest and roster');
  }

  console.log('\nAll site event tests passed.');
})().catch((e) => { console.error('FAIL ', (e && e.stack) || e); process.exit(1); });
