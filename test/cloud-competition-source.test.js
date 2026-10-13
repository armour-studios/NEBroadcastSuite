// node test/cloud-competition-source.test.js
//
// The "Nameless website" competition source (league.source.type === 'cloud'). Drives the REAL
// functions out of server.js (pulled by source, so this can't drift from the shipped code) against
// a stubbed cloud client:
//   - a linked league pulls the ne-competition document and applies it (with pruning)
//   - a 304 from the website leaves the league untouched and counts as "Already up to date"
//   - a 401/403 writes the sign-in sentence to state.compSync
//   - the 60s list loop only re-fetches a document when the website's rev moved
//   - the website's live flag puts a league on air once per rev, and never fights the producer
//   - a 'cloud' league is skipped by the website push path
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
  'cloudOrgId', 'cloudCompError', 'httpUrlOnly', 'cloudGetCompetition', 'cloudListCompetitions', 'readLeagueSource', 'syncLeagueSource', 'cloudCompetitionsSig',
  'pullOrgCompetitions', 'buildLeaguePushPayload'];
const signInLine = src.match(/^const CLOUD_COMP_SIGNIN = .*$/m);
assert.ok(signInLine, 'CLOUD_COMP_SIGNIN not found in server.js');
const SIGNIN = new Function(signInLine[0] + '; return CLOUD_COMP_SIGNIN;')();
assert.ok(/sign in to the nameless website/i.test(SIGNIN), 'sign-in sentence names the website');
assert.ok(/'cloud'/.test(src.slice(src.indexOf('function migrateLeague('), src.indexOf('function migrateLeague(') + 6000)), 'migrateLeague accepts source.type cloud');

// A fake cloud-client: the same surface server.js uses (authed/getSession/configured/retryInMs +
// the two competition calls), with knobs for the list, each document, and failures.
function makeCloud() {
  const cloud = {
    _authed: true, workspaceId: 'org_1', calls: [], list: [], listError: null, docs: {}, legacy: false,
    configured: () => true,
    authed: () => cloud._authed,
    getSession: () => ({ workspaceId: cloud.workspaceId, authed: cloud._authed, configured: true }),
    retryInMs: () => 0,
    async listOrgCompetitions(orgId) {
      cloud.calls.push(['list', orgId]);
      if (cloud.listError) { const e = new Error(cloud.listError.message || 'fail'); e.status = cloud.listError.status; throw e; }
      return cloud.list;
    },
    // The person-scoped routes (current contract). legacy=true makes them 404 like an older website.
    async listMyCompetitions() {
      if (cloud.legacy) { const e = new Error('Not found'); e.status = 404; throw e; }
      cloud.calls.push(['list', 'me']);
      if (cloud.listError) { const e = new Error(cloud.listError.message || 'fail'); e.status = cloud.listError.status; throw e; }
      return { competitions: cloud.list, createUrl: 'https://example.test/compete/console/new' };
    },
    async getMyCompetition(id, { etag = '' } = {}) { return cloud.getOrgCompetition(id, { etag, orgId: 'me' }); },
    async getOrgCompetition(id, { etag = '', orgId } = {}) {
      cloud.calls.push(['get', id, etag, orgId]);
      const d = cloud.docs[id];
      if (!d) { const e = new Error('Not found'); e.status = 404; throw e; }
      if (d.error) { const e = new Error(d.error.message || 'fail'); e.status = d.error.status; throw e; }
      if (etag && etag === d.etag) return { notModified: true, etag };
      return { doc: d.doc, etag: d.etag };
    },
  };
  cloud.gets = () => cloud.calls.filter((c) => c[0] === 'get').length;
  return cloud;
}

function world({ leagues } = {}) {
  const state = {
    leagues: leagues || [],
    competition: null, compFeed: null, compSync: {}, cloudCompetitions: [], cloudEventsMeta: { createUrl: '' },
    upcoming: { source: 'event', matches: [], showResults: true, title: '' },
    standings: { source: '', rows: [] },
    ticker: { source: 'manual' },
    leagueCapture: { active: false },
  };
  const calls = { save: 0, broadcast: 0 };
  const cloud = makeCloud();
  const body = 'let leaguesVer = 0; let cloudCompetitionsVer = 0; let _srvLgUidC = Date.now(); let _compRoutesLegacy = false;\n' +
    'const _compEtags = {}; const _compCloudRevs = {}; const _compCloudLiveArmed = {};\n' +
    'let sheetsServiceAccount = ""; const sheets = {}; const competitionFeedTokens = {};\n' +
    signInLine[0] + '\n' +
    NAMES.map(fn).join('\n') +
    '\nreturn { ' + NAMES.join(', ') + ', etags: _compEtags, revs: _compCloudRevs, ver: () => cloudCompetitionsVer };';
  const make = new Function('state', 'savedTeams', 'competition', 'competitionSources', 'cloud', 'saveAppState', 'broadcastFullState',
    'refreshLeagueStandingsMirror', 'migrateLeague', 'console', 'siteEventFollow', body);
  const quiet = { log() {}, warn() {}, error() {} };
  const api = make(state, [], competition, require('../backend/competition-sources.js'), cloud,
    () => calls.save++, () => calls.broadcast++, () => {}, (lg) => lg, quiet, () => {});
  return { state, calls, cloud, api };
}

const cloudLeague = (id, cmp, extra) => ({ id, name: '', game: '', status: 'active', type: 'team', teams: [], schedule: [], standings: [],
  source: { type: 'cloud', cloudCompetitionId: cmp, intervalSec: 60, auto: true }, ...(extra || {}) });
const docV = (matches, name) => ({
  format: 'ne-competition', version: 1,
  competition: { id: 'cmp1', name: name || 'Web League', game: 'rocket-league' },
  teams: [{ id: 'x', name: 'Riverside' }, { id: 'y', name: 'Lakeside' }, { id: 'z', name: 'Hilltop' }],
  matches,
});
const M1 = { id: 'm1', teamA: 'x', teamB: 'y', scheduledAt: '2099-01-01T19:00:00Z', bestOf: 5 };
const M2 = { id: 'm2', teamA: 'y', teamB: 'z', scheduledAt: '2099-01-08T19:00:00Z', bestOf: 5 };

(async () => {
  // 1. A linked league pulls the document and applies it; the picker list lands in state.
  {
    const { state, cloud, api } = world({ leagues: [cloudLeague('lg1', 'cmp1')] });
    cloud.list = [{ id: 'cmp1', kind: 'league', name: 'Web League', season: 'S1', game: 'rocket-league', rev: 1, updatedAt: 1000, live: false }];
    cloud.docs.cmp1 = { doc: docV([M1]), etag: '"v1"' };
    const r = await api.pullOrgCompetitions();
    assert.strictEqual(r.synced, 1, 'one league synced');
    assert.deepStrictEqual(cloud.calls[0], ['list', 'me'], 'list is person-scoped');
    assert.deepStrictEqual(cloud.calls[1], ['get', 'cmp1', '', 'me'], 'first fetch is unconditional, person-scoped');
    assert.strictEqual(state.cloudEventsMeta.createUrl, 'https://example.test/compete/console/new', 'create link carried');
    const lg = state.leagues[0];
    assert.strictEqual(lg.name, 'Web League', 'name adopted from the document');
    assert.strictEqual(lg.teams.length, 3);
    assert.deepStrictEqual(lg.schedule.map((m) => m.extId), ['m1']);
    assert.strictEqual(api.etags.lg1, '"v1"', 'ETag remembered');
    const st = state.compSync.lg1;
    assert.ok(st.lastOkAt > 0 && st.lastError === '' && st.fails === 0, JSON.stringify(st));
    assert.strictEqual(state.cloudCompetitions.length, 1);
    assert.deepStrictEqual(Object.keys(state.cloudCompetitions[0]).sort(), ['canReport', 'consoleUrl', 'game', 'host', 'id', 'kind', 'live', 'logo', 'name',
      'nextMatchAt', 'rev', 'role', 'season', 'startsAt', 'status', 'teams', 'updatedAt', 'url']);
    assert.strictEqual(api.ver(), 3, 'library-tier counter bumped for sign-in, the create link and the list');
    assert.strictEqual((state.competition && state.competition.leagueId) || '', '', 'live:false puts nothing on air');
    console.log('PASS  linked league pulls + applies the website document; picker list stored');

    // 2. Same rev on the next ticks → no document fetch at all (rev gate).
    await api.pullOrgCompetitions();
    await api.pullOrgCompetitions();
    assert.strictEqual(cloud.gets(), 1, 'unchanged rev → no fetch');
    assert.strictEqual(api.ver(), 3, 'identical list → no library re-send');

    // A manual "Sync now" DOES fetch — and the website's 304 leaves everything as it was.
    const before = JSON.stringify(lg);
    const s = await api.syncLeagueSource('lg1');
    assert.strictEqual(cloud.gets(), 2);
    assert.strictEqual(cloud.calls[cloud.calls.length - 1][2], '"v1"', 'If-None-Match sent');
    assert.strictEqual(s.summary, 'Already up to date');
    assert.strictEqual(JSON.stringify(lg), before, '304 changes nothing');
    assert.strictEqual(state.compSync.lg1.lastError, '');
    console.log('PASS  unchanged rev skips the fetch; a 304 leaves the league untouched');

    // 3. rev moves → fetched again; the new document is the whole truth (m1 gone, m2 in).
    cloud.list[0].rev = 2;
    cloud.docs.cmp1 = { doc: docV([M2]), etag: '"v2"' };
    await api.pullOrgCompetitions();
    assert.strictEqual(cloud.gets(), 3, 'rev change → one fetch');
    assert.deepStrictEqual(lg.schedule.map((m) => m.extId), ['m2'], 'website-owned fixture pruned, new one added');
    assert.strictEqual(api.etags.lg1, '"v2"');
    assert.strictEqual(api.revs.lg1, 'r2');
    await api.pullOrgCompetitions();
    assert.strictEqual(cloud.gets(), 3, 'and not again until rev moves');
    console.log('PASS  loop re-syncs only when rev changes; document applied with pruning');

    // 4. 401 on the document → the sign-in sentence lands in compSync; nothing is wiped.
    cloud.list[0].rev = 3;
    cloud.docs.cmp1 = { error: { status: 401, message: 'unauthorized' } };
    await api.pullOrgCompetitions();
    assert.strictEqual(state.compSync.lg1.lastError, SIGNIN);
    assert.strictEqual(state.compSync.lg1.fails, 1);
    assert.deepStrictEqual(lg.schedule.map((m) => m.extId), ['m2'], 'data kept');
    assert.strictEqual(api.revs.lg1, 'r2', 'failed sync does not latch the new rev');
    // Failed league backs off: the very next tick does not hammer the website.
    const gets = cloud.gets();
    await api.pullOrgCompetitions();
    assert.strictEqual(cloud.gets(), gets, 'backoff after a failure');
    // 403 reads the same way; a 404 says the competition is gone.
    cloud.docs.cmp1 = { error: { status: 403, message: 'forbidden' } };
    let r2 = await api.syncLeagueSource('lg1');
    assert.strictEqual(r2.error, SIGNIN);
    delete cloud.docs.cmp1;
    r2 = await api.syncLeagueSource('lg1');
    assert.ok(/no longer on the Nameless website/.test(r2.error), r2.error);
    console.log('PASS  401/403 write the sign-in error to compSync; failures back off');

    // 5. The list itself answering 401 marks every linked league and rejects (cloudLoop backs off).
    cloud.listError = { status: 401, message: 'unauthorized' };
    state.compSync.lg1.lastError = '';
    await assert.rejects(() => api.pullOrgCompetitions(), (e) => e.message === SIGNIN);
    assert.strictEqual(state.compSync.lg1.lastError, SIGNIN);
    cloud.listError = null;
    // A competition that vanished from the list says so and stops syncing.
    cloud.list = [];
    await api.pullOrgCompetitions();
    assert.ok(/no longer on the Nameless website/.test(state.compSync.lg1.lastError));
    assert.strictEqual(state.cloudCompetitions.length, 0);
    console.log('PASS  list 401 → sign-in error + loop failure; vanished competition reported');
  }

  // 6. The website's live flag puts a linked league on air once per rev and never fights the producer.
  {
    const { state, cloud, api } = world({ leagues: [cloudLeague('lg1', 'cmp1'), { id: 'lg2', name: 'Hand League', teams: [], schedule: [], standings: [], source: { type: 'manual' } }] });
    cloud.list = [{ id: 'cmp1', kind: 'tournament', name: 'October Open', rev: 5, live: true }];
    cloud.docs.cmp1 = { doc: docV([M1], 'October Open'), etag: '"a"' };
    await api.pullOrgCompetitions();
    assert.strictEqual(state.competition.leagueId, 'lg1', 'live:true + nothing on air → on air');
    assert.strictEqual(state.ticker.source, 'competition');
    // Producer takes it off air → same rev must NOT re-arm it.
    api.competitionGoLive('');
    await api.pullOrgCompetitions();
    await api.pullOrgCompetitions();
    assert.strictEqual(state.competition.leagueId, '', 'producer stays in charge at the same rev');
    // rev moves → re-armed once.
    cloud.list[0].rev = 6;
    cloud.docs.cmp1 = { doc: docV([M1, M2], 'October Open'), etag: '"b"' };
    await api.pullOrgCompetitions();
    assert.strictEqual(state.competition.leagueId, 'lg1', 'new rev re-arms');
    // Something else on air → the flag does nothing.
    api.competitionGoLive('lg2');
    cloud.list[0].rev = 7;
    await api.pullOrgCompetitions();
    assert.strictEqual(state.competition.leagueId, 'lg2', 'never steals the air from another league');
    // No rev and no updatedAt → synced, never auto-armed.
    api.competitionGoLive('');
    cloud.list = [{ id: 'cmp1', kind: 'tournament', name: 'October Open', live: true }];
    const g = cloud.gets();
    await api.pullOrgCompetitions();
    assert.strictEqual(cloud.gets(), g + 1, 'no rev → fetch each tick (ETag makes it cheap)');
    assert.strictEqual(state.competition.leagueId, '', 'no rev → no auto go-live');
    // auto:false → the loop leaves the league alone entirely.
    state.leagues[0].source.auto = false;
    cloud.list = [{ id: 'cmp1', kind: 'tournament', name: 'October Open', rev: 9, live: true }];
    const g2 = cloud.gets();
    await api.pullOrgCompetitions();
    assert.strictEqual(cloud.gets(), g2, 'auto off → no fetch');
    assert.strictEqual(state.competition.leagueId, '', 'auto off → no go-live');
    console.log('PASS  live flag → on air once per rev; off-air is respected until rev changes');
  }

  // 7. Signed out: the picker empties, linked leagues say why, and a read refuses with the same sentence.
  {
    const { state, cloud, api } = world({ leagues: [cloudLeague('lg1', 'cmp1')] });
    cloud.list = [{ id: 'cmp1', kind: 'league', name: 'Web League', rev: 1 }];
    cloud.docs.cmp1 = { doc: docV([M1]), etag: '"v1"' };
    await api.pullOrgCompetitions();
    assert.strictEqual(state.cloudCompetitions.length, 1);
    cloud._authed = false;
    const r = await api.pullOrgCompetitions();
    assert.strictEqual(r.skipped, 'signed-out');
    assert.strictEqual(state.cloudCompetitions.length, 0, 'picker emptied');
    assert.strictEqual(state.compSync.lg1.lastError, SIGNIN);
    await assert.rejects(() => api.readLeagueSource(state.leagues[0]), (e) => e.message === SIGNIN);
    assert.strictEqual(cloud.gets(), 1, 'no document calls while signed out');
    // Person-scoped: a personal workspace lists and reads like any other account.
    cloud._authed = true; cloud.workspaceId = 'user:42';
    await api.pullOrgCompetitions();
    assert.strictEqual(cloud.calls.filter((c) => c[0] === 'list').length, 2, 'personal workspace lists its events');
    assert.strictEqual(state.cloudCompetitions.length, 1);
    // No competition picked yet → a clear message, no call.
    cloud.workspaceId = 'org_1';
    state.leagues[0].source.cloudCompetitionId = '';
    await assert.rejects(() => api.readLeagueSource(state.leagues[0]), /Pick a competition/);
    console.log('PASS  signed out / personal workspace / nothing picked → clear errors, no calls');
  }

  // 7b. An older website (no person-scoped routes) falls back to the org routes.
  {
    const { state, cloud, api } = world({ leagues: [cloudLeague('lg1', 'cmp1')] });
    cloud.legacy = true;
    cloud.list = [{ id: 'cmp1', kind: 'league', name: 'Web League', rev: 1, live: false }];
    cloud.docs.cmp1 = { doc: docV([M1]), etag: '"v1"' };
    const r = await api.pullOrgCompetitions();
    assert.strictEqual(r.synced, 1);
    assert.deepStrictEqual(cloud.calls[0], ['list', 'org_1'], 'fell back to the org list');
    assert.deepStrictEqual(cloud.calls[1], ['get', 'cmp1', '', 'org_1'], 'and the org document route');
    assert.strictEqual(state.leagues[0].schedule.length, 1);
    console.log('PASS  older website: person routes 404 → org routes');
  }

  // 8. The website push path skips a 'cloud' league (it is the website's data, read-only here).
  {
    const { api } = world();
    const cl = cloudLeague('lg1', 'cmp1', { name: 'Web League', teams: [{ id: 't1', teamName: 'A' }] });
    assert.strictEqual(api.buildLeaguePushPayload(cl), null, 'cloud league → nothing to push');
    const manual = { id: 'lg9', name: 'Mine', source: { type: 'manual' }, teams: [{ id: 't1', teamName: 'A' }], schedule: [] };
    const p = api.buildLeaguePushPayload(manual);
    assert.strictEqual(p.externalId, 'lg9');
    assert.strictEqual(p.teams.length, 1);
    const pushCase = src.slice(src.indexOf('  cloud_push_league(msg, ws) {'), src.indexOf('  cloud_list_leagues(msg, ws) {'));
    assert.ok(/if \(!payload\)/.test(pushCase) && /read-only/.test(pushCase), 'cloud_push_league refuses a null payload with a read-only message');
    const loop = fn('startCompetitionSyncLoop');
    assert.ok(/s\.type !== 'sheet' && s\.type !== 'feed'/.test(loop), 'per-league timer still skips cloud leagues (pullOrgCompetitions owns them)');
    assert.ok(/cloudLoop\('org-competitions'/.test(src), 'list poll runs under cloudLoop, not setInterval');
    assert.strictEqual(require('../backend/state-schema').broadcastTiers().cloudCompetitions, 'library', 'picker list is library tier');
    console.log('PASS  cloud league skipped by the push path; loop + tier wiring present');
  }

  console.log('\nAll cloud competition source tests passed.');
})().catch((e) => { console.error('FAIL ', (e && e.stack) || e); process.exit(1); });
