// node test/competition-server.test.js
//
// Drives the REAL live-competition wiring out of server.js (functions and the /api/v1 route block
// are pulled out by source, so this can't drift from the shipped code) against a stub state:
//   - going live binds the ticker / schedule / standings and builds compFeed
//   - recording a result through the API re-mirrors the schedule board and the feed
//   - the API refuses requests without the key, and PUT prunes only synced fixtures
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const competition = require('../backend/competition.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function fn(name) {
  let start = src.indexOf('\nfunction ' + name + '(');
  if (start < 0) start = src.indexOf('\nasync function ' + name + '(');
  assert.ok(start >= 0, name + ' not found in server.js');
  const end = src.indexOf('\n}', start) + 2;
  return src.slice(start, end);
}
const NAMES = ['normalizeCompetitionSettings', 'competitionLeague', 'compResolveTeam', 'competitionLiveIds',
  'competitionScheduleRows', 'refreshCompetitionFeed', 'competitionGoLive', 'applyCompetitionDoc',
  'describeSyncReport', 'lgRecalcServer', 'srvLgMatchTally', 'srvLgUid'];
const routesStart = src.indexOf('  // ── Competition API v1');
const routesEnd = src.indexOf('\n  // Wipe the whole vault.', routesStart);
assert.ok(routesStart > 0 && routesEnd > routesStart, 'competition route block not found');

function world() {
  const state = {
    leagues: [{
      id: 'lg1', name: 'Fall League', season: 'S1', game: 'rocket-league', standingsMode: 'schedule',
      teams: [{ id: 'a', teamName: 'Riverside' }, { id: 'b', teamName: 'Lakeside' }, { id: 'c', teamName: 'Hilltop' }],
      schedule: [
        { id: 'm1', extId: 'wk1', teamA: 'a', teamB: 'b', week: '1', date: '2026-09-10', time: '19:00', result: { scoreA: 3, scoreB: 1 }, games: [], src: 'sync' },
        { id: 'm2', extId: 'wk2', teamA: 'b', teamB: 'c', week: '2', date: '2099-09-17', time: '19:00', result: { scoreA: null, scoreB: null }, games: [], src: 'sync' },
        { id: 'm3', teamA: 'c', teamB: 'a', week: '3', date: '2099-09-24', time: '19:00', result: { scoreA: null, scoreB: null }, games: [] },
      ],
      standings: [],
    }],
    competition: null, compFeed: null,
    upcoming: { source: 'event', matches: [], showResults: true, title: '' },
    standings: { source: '', rows: [] },
    ticker: { source: 'manual' },
    leagueCapture: { active: false },
  };
  const calls = { save: 0, broadcast: 0, mirror: 0 };
  const deps = {
    state, savedTeams: [{ name: 'Riverside', logo: 'data:image/png;base64,RV' }], competition,
    saveAppState: () => calls.save++, broadcastFullState: () => calls.broadcast++,
    refreshLeagueStandingsMirror: () => calls.mirror++, migrateLeague: (lg) => lg,
    _srvLgUidC: Date.now(),
  };
  deps.leaguesVer = 0;
  const body = 'let leaguesVer = 0; let _srvLgUidC = Date.now(); let competitionApiKey = "nek_test";\n' +
    NAMES.map(fn).join('\n') +
    '\nconst app = __app;\n' + src.slice(routesStart, routesEnd) +
    '\nreturn { ' + NAMES.join(', ') + ' };';
  const make = new Function('state', 'savedTeams', 'competition', 'saveAppState', 'broadcastFullState',
    'refreshLeagueStandingsMirror', 'migrateLeague', '__app', 'require', 'Buffer', body);
  const app = express();
  app.use(express.json());
  const api = make(state, deps.savedTeams, competition, deps.saveAppState, deps.broadcastFullState,
    deps.refreshLeagueStandingsMirror, deps.migrateLeague, app, require, Buffer);
  return { state, calls, api, app };
}

function request(server, method, p, body, key) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const rq = http.request({ host: '127.0.0.1', port: server.address().port, method, path: p,
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) } }, (rs) => {
      let t = ''; rs.on('data', (c) => { t += c; }); rs.on('end', () => resolve({ status: rs.statusCode, json: t ? JSON.parse(t) : null }));
    });
    rq.on('error', reject);
    if (data) rq.write(data);
    rq.end();
  });
}

(async () => {
  // 1. Go live binds the boards and builds the feed.
  {
    const { state, api } = world();
    api.competitionGoLive('lg1');
    assert.strictEqual(state.competition.leagueId, 'lg1');
    assert.strictEqual(state.ticker.source, 'competition');
    assert.strictEqual(state.upcoming.source, 'league');
    assert.strictEqual(state.standings.source, 'league');
    assert.deepStrictEqual(state.compFeed.upcoming.map((m) => m.id), ['m2', 'm3']);
    assert.deepStrictEqual(state.compFeed.results.map((m) => m.id), ['m1']);
    assert.deepStrictEqual(state.upcoming.matches.map((m) => [m.id, m.state]), [['m2', 1], ['m3', 1], ['m1', 3]]);
    assert.strictEqual(state.upcoming.title, 'Fall League — S1');
    // Off air releases the boards
    api.competitionGoLive('');
    assert.strictEqual(state.compFeed, null);
    assert.strictEqual(state.ticker.source, 'manual');
    assert.strictEqual(state.upcoming.source, 'event');
    console.log('PASS  go live binds ticker/schedule/standings; off air releases them');
  }

  // 2. An armed capture makes that fixture LIVE on the feed and the board.
  {
    const { state, api } = world();
    api.competitionGoLive('lg1');
    state.leagueCapture = { active: true, leagueId: 'lg1', matchId: 'm2' };
    api.refreshCompetitionFeed();
    assert.deepStrictEqual(state.compFeed.live.map((m) => m.id), ['m2']);
    assert.strictEqual(state.compFeed.next.id, 'm2');
    assert.strictEqual(state.upcoming.matches[0].live, true);
    console.log('PASS  armed capture reads LIVE');
  }

  // 3. A deleted league unbinds itself.
  {
    const { state, api } = world();
    api.competitionGoLive('lg1');
    state.leagues = [];
    api.refreshCompetitionFeed();
    assert.strictEqual(state.competition.leagueId, '');
    assert.strictEqual(state.compFeed, null);
    console.log('PASS  deleted live league unbinds');
  }

  // 4. HTTP API
  {
    const { state, api, app } = world();
    api.competitionGoLive('lg1');
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      let r = await request(server, 'GET', '/api/v1/competitions');
      assert.strictEqual(r.status, 401, 'no key → 401');
      r = await request(server, 'GET', '/api/v1/competitions', null, 'wrong');
      assert.strictEqual(r.status, 401, 'wrong key → 401');
      r = await request(server, 'GET', '/api/v1/schema');
      assert.strictEqual(r.status, 200, 'schema is public');

      r = await request(server, 'GET', '/api/v1/competitions', null, 'nek_test');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.live, 'lg1');

      // Report a result by the source's match id
      r = await request(server, 'PATCH', '/api/v1/competitions/lg1/matches/wk2', { status: 'completed', scoreA: 2, scoreB: 3 }, 'nek_test');
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual(r.json.match.scoreB, 3);
      assert.ok(state.compFeed.results.some((m) => m.id === 'm2' && m.winSide === 'b'), 'feed shows the new final');
      assert.ok(state.upcoming.matches.some((m) => m.id === 'm2' && m.state === 3), 'schedule board re-mirrored');
      const lg = state.leagues[0];
      assert.strictEqual(lg.standings.find((s) => s.teamId === 'c').w, 1, 'standings recalculated');

      // Mark live, then a bad status
      r = await request(server, 'PATCH', '/api/v1/competitions/lg1/matches/m3', { status: 'live' }, 'nek_test');
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(state.compFeed.live.map((m) => m.id), ['m3']);
      r = await request(server, 'PATCH', '/api/v1/competitions/lg1/matches/m3', { status: 'banana' }, 'nek_test');
      assert.strictEqual(r.status, 400);
      r = await request(server, 'PATCH', '/api/v1/competitions/lg1/matches/nope', { status: 'live' }, 'nek_test');
      assert.strictEqual(r.status, 404);

      // PUT = whole truth: wk2 missing → removed; hand-added m3 kept
      r = await request(server, 'PUT', '/api/v1/competitions/lg1', {
        matches: [{ id: 'wk1', teamA: 'Riverside', teamB: 'Lakeside', week: '1', scoreA: 3, scoreB: 1 },
                  { id: 'wk4', teamA: 'Hilltop', teamB: 'Riverside', scheduledAt: '2099-10-01T19:30:00Z' }] }, 'nek_test');
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      const ids = lg.schedule.map((m) => m.extId || m.id).sort();
      assert.deepStrictEqual(ids, ['m3', 'wk1', 'wk4']);

      // Export round-trips
      r = await request(server, 'GET', '/api/v1/competitions/lg1', null, 'nek_test');
      assert.strictEqual(r.json.format, 'ne-competition');
      assert.strictEqual(r.json.matches.length, 3);
      assert.ok(!r.json.teams.some((t) => t.logo && t.logo.startsWith('data:')), 'no data: logos exported');

      // Create + go live via the API
      r = await request(server, 'POST', '/api/v1/competitions', { competition: { name: 'Spring Cup' }, teams: [{ name: 'X' }, { name: 'Y' }], matches: [{ teamA: 'X', teamB: 'Y' }] }, 'nek_test');
      assert.strictEqual(r.status, 201, JSON.stringify(r.json));
      const newId = r.json.competition.id;
      assert.strictEqual(r.json.competition.matches, 1);
      r = await request(server, 'POST', '/api/v1/live', { id: newId }, 'nek_test');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(state.competition.leagueId, newId);
      assert.strictEqual(state.compFeed.name, 'Spring Cup');
      r = await request(server, 'POST', '/api/v1/competitions', { teams: [{ name: 'X' }] }, 'nek_test');
      assert.strictEqual(r.status, 400, 'create needs a name');
      console.log('PASS  /api/v1: auth, match PATCH, PUT prune, export, create + go live');
    } finally {
      server.close();
    }
  }
  // 5. Dashboard "My league" link: a feed URL becomes a synced, live league; pasting it again reuses
  //    it; a feed with nothing in it creates nothing.
  {
    const { state, api } = world();
    const hStart = src.indexOf('  competition_link(msg, ws) {');
    const hEnd = src.indexOf('\n  },\n', hStart) + 4;
    assert.ok(hStart > 0, 'competition_link handler not found');
    const extra = ['readLeagueSource', 'compSyncStatus'].map(fn).join('\n');
    const replies = [];
    const docs = {
      '/good.json': { competition: { name: 'Feed League' }, teams: [{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }], matches: [{ id: 'g1', teamA: 'x', teamB: 'y', scheduledAt: '2099-01-01T19:00:00Z' }] },
      '/empty.json': { competition: { name: 'Nothing' } },
    };
    const feedServer = http.createServer((rq, rs) => { rs.setHeader('Content-Type', 'application/json'); rs.end(JSON.stringify(docs[rq.url] || {})); });
    feedServer.listen(0, '127.0.0.1');
    await new Promise((r) => feedServer.once('listening', r));
    const base = 'http://127.0.0.1:' + feedServer.address().port;
    const make = new Function('state', 'competition', 'competitionSources', 'api', 'savedTeams', 'saveAppState', 'broadcastFullState', 'refreshLeagueStandingsMirror', 'migrateLeague',
      'let leaguesVer = 0; let _srvLgUidC = Date.now(); const _compEtags = {}; let sheetsServiceAccount = ""; const sheets = {}; const competitionFeedTokens = {};\n' +
      NAMES.map(fn).join('\n') + '\n' + extra +
      '\nconst replies = api.replies; function compReply(ws, op, data) { replies.push({ op, ...data }); }\nconst h = {\n' + src.slice(hStart, hEnd) + '\n};\nreturn h.competition_link;');
    const deps = { replies };
    const link = make(state, competition, require('../backend/competition-sources.js'), deps, [], () => {}, () => {}, () => {}, (lg) => lg);
    const waitReply = async (n) => { for (let i = 0; i < 100 && replies.length < n; i++) await new Promise((r) => setTimeout(r, 20)); };
    try {
      link({ data: { type: 'feed', url: base + '/good.json' } });
      await waitReply(1);
      assert.ok(replies[0].ok, JSON.stringify(replies[0]));
      assert.strictEqual(replies[0].name, 'Feed League');
      assert.strictEqual(replies[0].created, true);
      assert.strictEqual(state.competition.leagueId, replies[0].leagueId, 'went live');
      assert.strictEqual(state.leagues.length, 2);
      link({ data: { type: 'feed', url: base + '/good.json' } });
      await waitReply(2);
      assert.strictEqual(replies[1].created, false, 'same link reuses the league');
      assert.strictEqual(state.leagues.length, 2);
      link({ data: { type: 'feed', url: base + '/empty.json' } });
      await waitReply(3);
      assert.strictEqual(replies[2].ok, false);
      assert.strictEqual(state.leagues.length, 2, 'an empty feed creates nothing');
      link({ data: { type: 'feed', url: 'not a url' } });
      await waitReply(4);
      assert.strictEqual(replies[3].ok, false);
      console.log('PASS  My league link: feed becomes a live league, re-link reuses, empty/bad links create nothing');
    } finally { feedServer.close(); }
  }
  console.log('\nAll competition server tests passed.');
})().catch((e) => { console.error('FAIL ', e && e.stack || e); process.exit(1); });
