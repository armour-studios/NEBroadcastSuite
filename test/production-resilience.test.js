// node test/production-resilience.test.js
// Regression tests for the production QA drills (stale game state, stuck scenes, blank browser
// sources, late API replies overwriting newer data). Each block names the failure it guards.
// Pure functions are driven for real; code living inside server.js closures is extracted the same
// way test/rl-board-new-match.test.js does, and the rest is checked at the source level.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
// Twitch services moved out of server.js (refactor step 3).
const twitchSrc = fs.readFileSync(path.join(root, 'backend', 'twitch', 'services.js'), 'utf8').replace(/\r\n/g, '\n');
function fn(name) {
  const start = src.indexOf('\nfunction ' + name + '(');
  assert.ok(start >= 0, name + ' not found');
  return src.slice(start, src.indexOf('\n}', start) + 2);
}
let pass = 0;
const ok = (cond, why) => { assert.ok(cond, why); pass++; };

(async () => {
  // ── Bug A: game state ───────────────────────────────────────────────────────────────────────
  // A repeated MatchEnded must not credit the series twice; MatchCreated re-arms it.
  ok(/if \(_rlMatchEndedHandled\) \{[\s\S]{0,300}?return; \}\s*_rlMatchEndedHandled = true;/.test(fn('handleMatchEnded')), 'MatchEnded is applied once per match');
  ok(/_rlMatchEndedHandled = false;/.test(fn('handleMatchCreated')), 'MatchCreated re-arms MatchEnded');
  ok(/if \(state\.rlPaused\) state\.rlPaused = false;/.test(fn('handleMatchCreated')), 'a new match never opens paused');
  // A repeated GoalScored within 3s is dropped (flows, Director, goal_scored fire once).
  ok(/_lastGoalKey === goalKey && Date\.now\(\) - _lastGoalAt < 3000/.test(fn('handleGoalScored')), 'duplicate GoalScored ignored');
  // Socket handlers belong to their own socket: a late close from a destroyed socket can't null the new one.
  const conn = fn('connectToRL');
  ok((conn.match(/if \(rlSocket !== sock\) return;/g) || []).length >= 3, 'RL socket handlers guarded by ownership');
  // Lobby torn down / feed lost mid-replay: back to the HUD, never a stuck REPLAY view.
  ok(/state\.view === 'goal'/.test(fn('rlLeaveStuckReplay')) && /rlLeaveStuckReplay\(\);/.test(fn('disconnectRL')), 'feed loss leaves a stuck replay');
  ok(/case 'MatchDestroyed':[\s\S]{0,1200}state\.view = 'hud'/.test(src), 'MatchDestroyed leaves the goal view');

  // Silence detection: connected but no packets for 15s -> rlStale; packets again -> clear.
  {
    const state = { rlConnected: true, rlStale: false };
    const sent = [];
    let intervalFn = null;
    const body = 'const tl = () => {}; let _rlStaleTimer = null, _rlLastPacketAt = 0; const RL_STALE_MS = 15000;\n' + fn('noteRlPacket') + fn('rlStaleCheck')
      + '\nreturn { noteRlPacket, rlStaleCheck, setLast: (t) => { _rlLastPacketAt = t; } };';
    const api = new Function('state', 'broadcast', 'bridgeClients', 'broadcastFullState', 'setInterval', 'clearInterval', 'console', body)(
      state, (c, m) => sent.push(m), null, () => {}, (f) => { intervalFn = f; return 1; }, () => { intervalFn = null; }, { log() {}, warn() {} });
    api.noteRlPacket();
    ok(typeof intervalFn === 'function', 'stale watchdog armed on first packet');
    api.setLast(Date.now() - 16000);
    api.rlStaleCheck(false);
    ok(state.rlStale === true && sent.some((m) => m.type === 'rl_status' && m.data.stale === true), 'silence while connected marks the feed stale');
    api.noteRlPacket();
    ok(state.rlStale === false && sent.some((m) => m.type === 'rl_status' && m.data.stale === false), 'data again clears it');
    api.rlStaleCheck(true);
    ok(intervalFn === null, 'disconnect stops the watchdog');
  }

  // Audit round (2026-10-11): an RL crash must still run the close cleanup (error used to null the
  // socket first); the MatchEnded latch re-arms at a kickoff and on MatchDestroyed; FACEIT does not
  // wipe the series after a restart when the same teams are on air.
  ok(!/rlSocket\.on\('error'[\s\S]{0,300}?rlSocket = null;/.test(conn), 'RL error handler leaves the cleanup to close');
  ok(/_rlMatchEndedHandled = false;/.test(fn('returnToInGameForKickoff')), 'a kickoff re-arms MatchEnded');
  ok(/if \(!sameTeams\) finalizeAndResetSeries\(\);/.test(src), 'FACEIT keeps the series when the same teams are already on air');

  // Overlay: a reconnect re-baselines the score (no late goal swipe), game_reset drops the old scorer.
  const hud = fs.readFileSync(path.join(root, 'overlay', 'rl-hud.html'), 'utf8');
  ok(/ws\.onopen=\(\)=>\{ prevBlue=prevOrange=null;/.test(hud), 'rl-hud re-baselines the score on reconnect');
  ok(/case 'game_reset':[\s\S]{0,900}currentState\._goal=null;/.test(hud), 'rl-hud forgets the previous scorer on a new game');
  ok(/function safe\(name, fn\)/.test(hud) && (hud.match(/safe\('/g) || []).length >= 20, 'rl-hud renders each full_state section in isolation');

  // ── Bug B: scenes ───────────────────────────────────────────────────────────────────────────
  // OBS requests can't hang forever: a call OBS never answers rejects; a cut reports failure.
  {
    let pending = 0;
    class FakeOBS {
      constructor() { this.handlers = {}; }
      on(ev, f) { (this.handlers[ev] = this.handlers[ev] || []).push(f); }
      off() {}
      call() { pending++; return new Promise(() => {}); }          // OBS never answers
      callBatch() { return new Promise(() => {}); }
      connect() { return Promise.resolve(); }
      disconnect() { return Promise.resolve(); }
    }
    const origLoad = Module._load;
    Module._load = function (req, parent, isMain) {
      if (req === 'obs-websocket-js') return { OBSWebSocket: FakeOBS, EventSubscription: { All: 1, InputVolumeMeters: 2 } };
      return origLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve('../backend/integrations/obs-client.js')];
    const { createObsClient } = require('../backend/integrations/obs-client.js');
    Module._load = origLoad;
    const scenes = [];
    const c = createObsClient({ callTimeoutMs: 150, onSceneChange: (s) => scenes.push(s) });
    await c.connect({ url: 'ws://127.0.0.1:4455' });   // connect resolves; GetCurrentProgramScene times out quietly
    ok(c.isConnected(), 'fake OBS connected');
    const t0 = Date.now();
    const r = await c.switchScene('Game');
    ok(r === false && Date.now() - t0 < 2000, 'an unanswered cut fails within its deadline instead of hanging');
    ok(/did not answer/.test(c.getLastError() || ''), 'the timeout is reported as the error');
    const r2 = await c.switchSceneWithTransition('Game', 'Gone');
    ok(r2 === false && pending > 2, 'a missing transition still attempts the cut');
    await c.disconnect();
  }
  // A cut that borrows a stinger puts the producer's own transition + duration back after it plays,
  // and two quick borrowed cuts still restore the ORIGINAL.
  {
    const log = [];
    let fake = null;
    class AnsweringOBS {
      constructor() { this.handlers = {}; this.cur = { transitionName: 'Fade', transitionDuration: 300 }; fake = this; }
      on(ev, f) { (this.handlers[ev] = this.handlers[ev] || []).push(f); }
      off(ev, f) { this.handlers[ev] = (this.handlers[ev] || []).filter((x) => x !== f); }
      emit(ev, d) { (this.handlers[ev] || []).slice().forEach((f) => f(d)); }
      async call(req, p) {
        log.push(req);
        if (req === 'GetCurrentSceneTransition') return Object.assign({}, this.cur);
        if (req === 'SetCurrentSceneTransition') { this.cur.transitionName = p.transitionName; return {}; }
        if (req === 'SetCurrentSceneTransitionDuration') { this.cur.transitionDuration = p.transitionDuration; return {}; }
        if (req === 'GetCurrentProgramScene') return { currentProgramSceneName: 'A' };
        return {};
      }
      callBatch() { return Promise.resolve([]); }
      connect() { return Promise.resolve(); }
      disconnect() { return Promise.resolve(); }
    }
    const origLoad = Module._load;
    Module._load = function (req) {
      if (req === 'obs-websocket-js') return { OBSWebSocket: AnsweringOBS, EventSubscription: { All: 1, InputVolumeMeters: 2 } };
      return origLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve('../backend/integrations/obs-client.js')];
    const { createObsClient } = require('../backend/integrations/obs-client.js');
    Module._load = origLoad;
    const c = createObsClient({});
    await c.connect({ url: 'ws://127.0.0.1:4455' });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await c.switchSceneWithTransition('Replay', 'Stinger', 0);
    ok(fake.cur.transitionName === 'Stinger', 'the stinger is current while it plays');
    fake.emit('SceneTransitionEnded', { transitionName: 'Stinger' });
    await wait(20);
    ok(fake.cur.transitionName === 'Fade', 'the producer\'s transition comes back after the stinger played');
    // Two borrowed cuts back to back: the second must not "restore" to the first's borrowed stinger.
    await c.switchSceneWithTransition('Replay', 'Stinger', 0);
    await c.switchSceneWithTransition('Game', 'Swipe', 900);
    fake.emit('SceneTransitionEnded', {});
    await wait(20);
    ok(fake.cur.transitionName === 'Fade' && fake.cur.transitionDuration === 300, 'back-to-back borrowed cuts restore the original transition and duration');
    // The producer picks another transition in OBS while ours plays: theirs stands.
    await c.switchSceneWithTransition('Replay', 'Stinger', 0);
    fake.cur.transitionName = 'Luma Wipe';
    fake.emit('SceneTransitionEnded', {});
    await wait(20);
    ok(fake.cur.transitionName === 'Luma Wipe', 'a transition the producer chose meanwhile is not overwritten');
    await c.disconnect();
  }
  // A repeated or empty program-scene report doesn't re-run scene flows.
  ok(/if \(\(sceneName \|\| ''\) === prev\) return;/.test(src), 'same-scene reports ignored');
  ok(/if \(!sceneName\) \{ broadcastFullState\(\); return; \}/.test(src), 'disconnect (empty scene) runs no flows and keeps previousScene');
  ok(/if \(state\.commercial && state\.commercial\.active\) \{?[^\n]{0,80}return/.test(fn('startCommercial')), 'a second commercial start cannot strand the show');
  ok(/if \(cutSeq !== _manualCutSeq\)/.test(src), 'a slow transition-armed cut cannot land after a newer cut');

  // Runaway flows pause themselves.
  {
    const body = 'const tl = () => {}; const _flowPausedUntil = {}; const _flowLastFired = {}; const _flowFireLog = {}; class _StopFlow extends Error {}\n'
      + src.slice(src.indexOf('\nasync function _fireFlow('), src.indexOf('\n}', src.indexOf('\nasync function _fireFlow(')) + 2)
      + '\nreturn _fireFlow;';
    let runs = 0;
    const fire = new Function('_checkFlowConditions', 'logAuto', '_executeFlowAction', 'console', body)(
      () => true, () => {}, async () => { runs++; }, { warn() {}, error() {} });
    const flow = { id: 'f1', name: 'loop', triggers: [{ type: 'obs_scene_changed' }], actions: [{ type: 'obs_scene' }] };
    for (let i = 0; i < 20; i++) await fire(flow, {});
    ok(runs === 8, 'a flow firing itself is paused after 8 runs in 10s (ran ' + runs + ')');
    runs = 0;
    const gifts = { id: 'f2', name: 'sub alert', triggers: [{ type: 'twitch_sub' }], actions: [{ type: 'play_sound' }] };
    for (let i = 0; i < 20; i++) await fire(gifts, {});
    ok(runs === 20, 'a busy non-OBS flow (gift bomb alerts) is never paused (ran ' + runs + ')');
  }

  // ── Bug C: browser sources ──────────────────────────────────────────────────────────────────
  const sb = fs.readFileSync(path.join(root, 'overlay', 'scene-base.js'), 'utf8');
  ok(/open\(\)\.catch\(retry\)/.test(sb), 'scene-base: a throw while connecting does not end the reconnect chain');
  ok(/ac\.abort\(\)/.test(sb), 'scene-base: the token fetch has a deadline');
  const ch = fs.readFileSync(path.join(root, 'overlay', 'custom.html'), 'utf8');
  ok(/if \(loading\) \{ again = true; return; \}/.test(ch) && /retry = setTimeout\(load, retryMs\)/.test(ch), 'custom overlay refetches a save made mid-load and retries a failed load');
  const cd = fs.readFileSync(path.join(root, 'overlay', 'countdown.html'), 'utf8');
  ok(/shown\.textContent === finalMessage/.test(cd), 'countdown final message is not rebuilt every tick');
  ['apex.html', 'apex-observer.html'].forEach((f) => ok(/body\.live #offline \{ display: none/.test(fs.readFileSync(path.join(root, 'overlay', f), 'utf8')), f + ': no debug box on air'));
  ok(/PressInputPropertiesButton', \{ inputName: name, propertyName: 'refreshnocache' \}/.test(src) && /_pagesServed\.has\(path\) \|\| livePaths\.has\(path\)/.test(src), 'only never-loaded OBS sources are refreshed');
  {
    const body = 'const HTTP_PORT = 3000;\n' + fn('_ourOverlayPath') + '\nreturn _ourOverlayPath;';
    const p = new Function(body)();
    ok(p('http://localhost:3000/rl-hud.html?x=1') === '/rl-hud.html', 'our overlay URL recognised');
    ok(p('http://192.168.1.4:3000/gfx.html') === '/gfx.html', 'LAN overlay URL recognised');
    ok(p('https://streamlabs.com/alert-box') === '' && p('http://localhost:8080/x.html') === '', 'other sources ignored');
  }

  // ── Bug D: late API replies ─────────────────────────────────────────────────────────────────
  ok(/const mySeq = \+\+_sggPushSeq;[\s\S]{0,200}if \(mySeq !== _sggPushSeq\)/.test(src), 'start.gg: only the newest set push applies');
  ok((src.match(/superseded/g) || []).length >= 5, 'start.gg: every caller handles a superseded push');
  ok(/dropped a stream-queue reply/.test(src), 'start.gg: a reply for a previous event is dropped');
  ok(/if \(\(state\.challonge\.tournamentSlug \|\| ''\)\.trim\(\) !== slug\) return;/.test(src), 'Challonge: stale tournament reply dropped');
  ok(/if \(\(state\.faceit\.competitionId \|\| ''\)\.trim\(\) !== id\) return;/.test(src), 'FACEIT: stale competition reply dropped');
  ok(/if \(!now \|\| now\.id !== cur\.id\) return;/.test(src), 'Twitch prediction poll never overwrites a newer prediction');
  ok(/edited during the read/.test(src) && /if \(_sheetsBusy\) return _sheetsBusy;/.test(src), 'Sheets keeps an edit made during the read; one sync at a time');
  ok(/if \(_twitchRefreshing\) return _twitchRefreshing;/.test(src), 'Twitch token refresh is single-flight');
  ok(/state\.twitch\.refreshToken = '';\s*\n\s*if \(_tokenRefreshTimer\)/.test(src), 'Twitch disconnect sticks');
  {
    const body = twitchSrc.slice(twitchSrc.indexOf('const _eventSubSeenIds'), twitchSrc.indexOf('class EventSubService {')) + '\nreturn _eventSubSeen;';
    const seen = new Function(body)();
    ok(seen('a') === false && seen('a') === true && seen('') === false, 'EventSub message ids deduped');
  }
  ok(/if \(this\._connecting\) return this\._connecting;/.test(twitchSrc) && /this\._lineBuf = lines\.pop\(\);/.test(twitchSrc), 'Twitch IRC: one socket, split lines kept');
  ok(/if \(gen !== _lolPollGen\) return;/.test(src), 'LoL: a reply from a stopped poll is ignored');

  // Integration polls report failure to pollLoop (backoff + panel warning) instead of swallowing it.
  ok(/refreshChallongeLive\(\)\.catch\(\(e\) => \{ console\.warn\('\[challonge\]', e && e\.message\); throw e; \}\)/.test(src), 'Challonge poll failures reach the backoff');
  ok(/if \(state\.faceit\.lastError\) throw/.test(src) && /if \(state\.nxgen\.lastError\) throw/.test(src), 'FACEIT / NXGEN poll failures reach the backoff');
  ok(/pollFailures: pollFailures\(\),/.test(src), 'failing polls are shown to the operator');
  {
    const body = 'const _pollLoops = new Map();\n' + fn('pollFailures') + '\nreturn { _pollLoops, pollFailures };';
    const api = new Function(body)();
    api._pollLoops.set('a', { name: 'a', fails: 0 });
    api._pollLoops.set('b', { name: 'b', fails: 4, lastError: 'HTTP 429', lastOkAt: 5 });
    const f = api.pollFailures();
    ok(f.length === 1 && f[0].name === 'b' && f[0].lastError === 'HTTP 429', 'only failing polls are broadcast');
  }
  ok(/if \(!rlGameLive\) \{\s*state\.game\.blueScore = 0;/.test(fn('finalizeAndResetSeries')), 'a fresh series does not show the last game\'s score');

  // Website score reports: one sender per match, newest report last; a recorded result is held
  // against an older document until the source catches up.
  {
    const sent = [];
    let release = null;
    const cloud = {
      authed: () => true,
      reportCompetitionMatch: (cid, mid, body) => new Promise((res) => {
        sent.push(body.games.length + (body.final ? 'F' : ''));
        if (sent.length === 1) release = res; else res({ ok: true });   // the first report is slow
      }),
    };
    const state = { leagues: [{ id: 'L', source: { type: 'cloud', cloudCompetitionId: 'C' }, schedule: [{ id: 'M', extId: 'X' }] }] };
    const se = { autoReport: true };
    const body = 'const _siteReports = new Map(); const _siteReportHold = new Map();\n' + fn('siteReportCapture') + fn('siteReportHeld')
      + src.slice(src.indexOf('\nasync function _siteReportSend('), src.indexOf('\n}', src.indexOf('\nasync function _siteReportSend(')) + 2)
      + '\nreturn { siteReportCapture, siteReportHeld };';
    const api = new Function('state', 'cloud', 'siteEventState', 'broadcastFullState', body)(state, cloud, () => se, () => {});
    const g = (n) => Array.from({ length: n }, () => ({ scoreA: 3, scoreB: 1 }));
    const p1 = api.siteReportCapture('L', 'M', g(1), false);
    api.siteReportCapture('L', 'M', g(2), false);            // queued behind game 1
    api.siteReportCapture('L', 'M', g(3), true);             // replaces game 2 (not yet sent)
    ok(api.siteReportHeld('L', 'M'), 'a match being reported is held');
    release({ ok: true });
    await p1;
    ok(sent.join(',') === '1,3F', 'reports go out in order and the final lands last (' + sent.join(',') + ')');
    ok(api.siteReportHeld('L', 'M'), 'still held while the source catches up');

    const competition = require('../backend/competition.js');
    const lg = { id: 'L', teams: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], schedule: [{ id: 'M', extId: 'X', teamA: 'a', teamB: 'b', games: g(3), result: { scoreA: 2, scoreB: 1, ot: false } }], standings: [] };
    const olderDoc = { teams: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], matches: [{ id: 'X', teamA: 'a', teamB: 'b', status: 'live', games: g(1), scoreA: 1, scoreB: 0 }] };
    competition.applyDoc(lg, olderDoc, { uid: (p) => p + Math.random(), protect: () => true });
    ok(lg.schedule[0].result.scoreA === 2 && lg.schedule[0].games.length === 3, 'an older document does not roll back a just-recorded result');
    const caughtUp = { teams: olderDoc.teams, matches: [{ id: 'X', teamA: 'a', teamB: 'b', status: 'completed', games: g(3), scoreA: 3, scoreB: 0 }] };
    competition.applyDoc(lg, caughtUp, { uid: (p) => p + Math.random(), protect: () => true });
    ok(lg.schedule[0].result.scoreA === 3, 'once the source has caught up it wins again');
  }
  const tc = fs.readFileSync(path.join(root, 'backend', 'integrations', 'twitch-client.js'), 'utf8');
  ok(/require\('axios'\)\.create\(\{ timeout: 12000 \}\)/.test(tc), 'Twitch client calls have a deadline');

  // Wrapper sources share one socket with their embedded graphics (verified end to end in an
  // Electron harness: gfx.html 18 -> 3 sockets, triggers.html 8 -> 1).
  ['gfx.html', 'triggers.html'].forEach((f) => {
    const h = fs.readFileSync(path.join(root, 'overlay', f), 'utf8');
    ok(/data-ne-bridge="1"/.test(h) && /<script src="bridge-host\.js"><\/script>/.test(h) && !/new WebSocket\(/.test(h), f + ' hosts one shared socket');
  });
  ok(/data-ne-bridge'\) === '1'/.test(sb) && /viaBridge\(b\)/.test(sb) && /return open\(\)\.catch\(retry\)/.test(sb), 'scene-base rides a wrapper\'s socket and falls back to its own');
  ok(/ws\._pages\.add\(ws\._page\)/.test(src), 'the server counts every page on a shared socket');

  // Custom overlay builder: an imported file is untrusted (no markup, no script URLs in the editor),
  // thumbnails never load live frames, deleting an overlay clears it in OBS.
  {
    const ob = fs.readFileSync(path.join(root, 'control-panel', 'overlay-builder.js'), 'utf8');
    const cr = fs.readFileSync(path.join(root, 'overlay', 'custom-render.js'), 'utf8');
    ok(/o\.elements\.map\(cleanImported\)/.test(ob) && /if \(!e \|\| typeof e !== 'object' \|\| !TYPE_NAME\[e\.type\]\) return null;/.test(ob), 'imports keep only known piece types');
    ok(/'<i class="ovb-lt ovb-lt-' \+ esc\(e\.type\)/.test(ob), 'layer list escapes the piece type');
    ok(/if \(src && !\/\^\(https\?:\\\/\\\/\|\\\/\)\/i\.test\(String\(src\)\.trim\(\)\)\) src = '';/.test(cr), 'frames only ever load http(s) or app paths');
    ok(/editor: true, thumb: true/.test(ob), 'thumbnails use placeholders, not live camera frames');
    ok(/state\.customOverlayRevs\[oid\] = 'deleted-' \+ Date\.now\(\)/.test(src), 'deleting a custom overlay clears it in OBS');
  }

  // ── Diagnostics: the show timeline ──────────────────────────────────────────────────────────
  {
    const os = require('os');
    const { createShowTimeline } = require('../backend/show-timeline.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
    const t = createShowTimeline({ dataDir: dir });
    t.record('scene.cut.request', { to: 'Game', by: 'operator', apiKey: 'SECRET', obsPassword: 'x' });
    t.record('scene.program', { from: 'Break', to: 'Game' });
    for (let i = 0; i < 2100; i++) t.record('rl.goal', { i });
    ok(t.size() === 2000, 'the timeline keeps the most recent 2000 events');
    const all = t.since(0);
    ok(all[all.length - 1].seq === 2102 && t.since(2100).length === 2, 'events are numbered and can be read since a point');
    const t2 = createShowTimeline({ dataDir: dir });
    t2.record('scene.cut.request', { to: 'Game', apiKey: 'SECRET', obsPassword: 'x', nested: { token: 'y', ok: 1 } });
    const ev = t2.since(0)[0];
    ok(!('apiKey' in ev.data) && !('obsPassword' in ev.data) && !('token' in ev.data.nested) && ev.data.nested.ok === 1, 'secrets never enter the timeline');
    ok(/scene\.cut\.request/.test(t2.text()), 'readable text form for bug reports');
    await t2.flush();
    const lines = fs.readFileSync(path.join(dir, 'logs', 'show-timeline.jsonl'), 'utf8').trim().split('\n');
    ok(lines.length >= 1 && JSON.parse(lines[lines.length - 1]).kind === 'scene.cut.request', 'events are written to logs/show-timeline.jsonl');
  }
  ok(/tl\('scene\.program'/.test(src) && /tl\('scene\.cut\.request'/.test(src) && /tl\('rl\.event\.duplicate'/.test(src) && /tl\('api\.stale'/.test(src) && /tl\('source\.refresh'/.test(src), 'scene cuts, game events, stale replies and source refreshes are recorded');
  ok(/app\.get\('\/api\/diagnostics\/timeline'/.test(src) && /Show timeline \(most recent 120 events\)/.test(src), 'timeline is readable over the API and rides bug reports');

  console.log(`production-resilience: all ${pass} checks passed`);
})().catch((e) => { console.error('FAIL ', (e && e.stack) || e); process.exit(1); });
