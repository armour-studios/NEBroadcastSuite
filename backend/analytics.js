/* ─── Broadcast analytics recorder ────────────────────────────────────────────
 *
 * Records a "broadcast session" — one show/stream — and accumulates the metrics a
 * producer, tournament organizer or host actually cares about: viewer trend, scene-time
 * breakdown, ad load, clip/replay activity, engagement, and a technical disconnect log.
 *
 * Lifecycle: auto-starts when Twitch reports the stream live (or manually), samples viewers
 * at the Twitch poll cadence (~30s), accumulates scene-time every second, and taps existing
 * server event hooks via analytics.event(type, data). Completed sessions persist to
 * userData/analytics.json (capped). A light summary is broadcast to clients as
 * 'analytics_update'; full viewer samples come from the GET endpoints.
 *
 * Kept dependency-free and injected (init({ dataDir, getState, broadcast, bridgeClients }))
 * so it mirrors backend/db/stats.js and never reaches into server internals directly.
 */
const fs = require('fs');
const path = require('path');

let FILE = null;
let deps = {};
let DB = { sessions: [], live: null };   // persisted: completed sessions + a crash-safety live snapshot
let live = null;                          // in-memory active session (null when not recording)
let tickTimer = null;
let saveTimer = null;
let _lastPush = 0;
let _offlineStreak = 0;
let _tickCount = 0;
let AUTO = true;                          // auto start/stop with the Twitch live signal

const SESSION_CAP = 100;
const SAMPLE_CAP = 2000;                  // viewer samples per session (~16h at 30s)
const POLL_SEC = 30;                      // assumed Twitch poll cadence (for live-time accrual)

function rid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function now() { return Date.now(); }

function init(d) {
  deps = d || {};
  FILE = path.join(deps.dataDir || '.', 'analytics.json');
  load();
  // A live snapshot left over from a crash/restart is finalized so its data isn't lost. It ends
  // when it was last tracked, not now: the time the app was closed was not broadcast time.
  if (DB.live) {
    const stale = DB.live; stale.active = false; stale.endedAt = stale.endedAt || trackedEnd(stale);
    DB.sessions.unshift(finalize(stale));
    if (DB.sessions.length > SESSION_CAP) DB.sessions.length = SESSION_CAP;
    DB.live = null; save(true);
  }
  if (repairSessions(DB.sessions)) save(true);
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(tick, 1000);   // 1s scene-time accrual
}

// tick() adds one second of scene time for every second the app runs a session, so the scene
// total is how long the session really ran.
function trackedSeconds(s) {
  return Object.values((s && s.sceneTime) || {}).reduce((a, v) => a + (Number(v) || 0), 0);
}
function trackedEnd(s) {
  const lastSample = (s.viewerSamples && s.viewerSamples.length) ? s.viewerSamples[s.viewerSamples.length - 1].t : 0;
  return Math.max(s.lastSeenAt || 0, lastSample || 0, s.startedAt + trackedSeconds(s) * 1000) || now();
}
// Sessions finalized before trackedEnd() existed ended at app restart, so a broadcast the app was
// closed in the middle of reads as 40+ hours. A session can't outlast the app running it: one that
// is more than 30 minutes longer than its tracked time is cut back to it.
function repairSessions(list) {
  let changed = false;
  (list || []).forEach((s) => {
    const tracked = trackedSeconds(s);
    if (!s || s.repaired || tracked < 60 || !(s.durationSec > tracked + 1800)) return;
    s.durationSec = tracked;
    s.endedAt = s.startedAt + tracked * 1000;
    s.repaired = true;
    changed = true;
  });
  return changed;
}

function load() {
  try {
    if (FILE && fs.existsSync(FILE)) {
      const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (j && Array.isArray(j.sessions)) DB.sessions = j.sessions;
      if (j && j.live) DB.live = j.live;
      if (j && typeof j.auto === 'boolean') AUTO = j.auto;
    }
  } catch (e) { /* fresh start */ }
}
function save(sync) {
  if (!FILE) return;
  DB.live = (live && live.active) ? live : null;
  const data = JSON.stringify({ sessions: DB.sessions, live: DB.live, auto: AUTO });
  if (sync) { try { fs.writeFileSync(FILE, data); } catch (e) {} return; }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { fs.writeFileSync(FILE, data); } catch (e) {} }, 800);
}

function state() { return (deps.getState && deps.getState()) || {}; }

function newSession(label) {
  const st = state();
  return {
    id: rid(), active: true, autoStarted: false,
    label: (label || '').toString().slice(0, 80) || st.eventName || 'Broadcast',
    game: st.activeGame || '', eventName: st.eventName || '',
    startedAt: now(), endedAt: null,
    viewerSamples: [], peakViewers: 0, liveSeconds: 0,
    sceneTime: {}, sceneSwitches: 0,
    segmentTime: {}, segViewerSum: {},   // segment-type seconds + viewer-seconds (for segment analytics)
    health: { n: 0, cpuSum: 0, fpsSum: 0, dropMax: 0, dropSum: 0, congMax: 0, brSum: 0, brN: 0 },   // OBS stream-health samples
    ads: { count: 0, totalSec: 0 },
    clips: 0, replaysSaved: 0, goals: 0,
    matchesCompleted: 0, gamesCompleted: 0, autoSwitches: 0,
    predictionsCreated: 0, predictionsResolved: 0, pollsCreated: 0, wheelSpins: 0, minigames: 0,
    follows: 0, subs: 0, raids: 0, raidViewers: 0, bits: 0,
    disconnects: []
  };
}

// Classify the current on-air segment from live state signals (for segment analytics).
function classifySegment(st) {
  st = st || {};
  const tw = st.twitch || {};
  if (tw.adBreak && tw.adBreak.active) return 'Commercial';
  if (st.intro && st.intro.visible) return 'Countdown';
  if (st.breakScreen && st.breakScreen.visible) return 'Break';
  if (st.winner && st.winner.visible) return 'Awards';
  if (st.veto && st.veto.visible) return 'Draft';
  if (st.inReplay || st.view === 'goal') return 'Replay';
  if (st.casters && st.casters.visible) return 'Desk';
  if (st.view === 'hud' || st.view === 'scoreboard') return 'Gameplay';
  return 'Other';
}

// 1s tick: credit the current OBS program scene (time-on-scene) + the classified segment
// (segment-time + viewer-seconds so we can derive avg viewers / retention per segment).
function tick() {
  if (!live || !live.active) return;
  live.lastSeenAt = now();
  const st = state();
  const obs = st.obs || {};
  let scene;
  if (obs.connected) scene = obs.currentScene || '(no scene)';
  else scene = obs.enabled ? '(OBS connecting)' : '(OBS offline)';
  live.sceneTime[scene] = (live.sceneTime[scene] || 0) + 1;
  const seg = classifySegment(st);
  live.segmentTime[seg] = (live.segmentTime[seg] || 0) + 1;
  live.segViewerSum[seg] = (live.segViewerSum[seg] || 0) + (live._lastViewers || 0);
  // Keep the crash snapshot current, so a session cut short by a crash keeps its real length.
  if (++_tickCount % 60 === 0) save();
}

// Central event sink — called from server hook points.
function event(type, data) {
  if (!live || !live.active) return;
  data = data || {};
  switch (type) {
    case 'scene_change':       live.sceneSwitches++; break;
    case 'ad':                 live.ads.count++; live.ads.totalSec += Math.max(0, data.sec || 0); break;
    case 'clip':               live.clips++; break;
    case 'replay_saved':       live.replaysSaved++; break;
    case 'goal':               live.goals++; break;
    case 'match_complete':     live.matchesCompleted++; break;
    case 'game_complete':      live.gamesCompleted++; break;
    case 'auto_switch':        live.autoSwitches++; break;
    case 'prediction_create':  live.predictionsCreated++; break;
    case 'prediction_resolve': live.predictionsResolved++; break;
    case 'poll_create':        live.pollsCreated++; break;
    case 'wheel_spin':         live.wheelSpins++; break;
    case 'minigame':           live.minigames++; break;
    case 'follow':             live.follows++; break;
    case 'subscribe': case 'sub': case 'resub': case 'gift_sub': live.subs++; break;
    case 'raid':               live.raids++; live.raidViewers += Math.max(0, data.viewers || 0); break;
    case 'bits':               live.bits += Math.max(0, data.amount || 0); break;
    case 'disconnect':         live.disconnects.push({ t: now(), what: (data.what || '').toString().slice(0, 24) }); break;
    default: return;
  }
  push();
}

// Called from the Twitch stream-state poll (~30s). Drives viewer sampling + auto start/stop.
function recordStreamPoll(isLive, viewerCount) {
  if (isLive && (!live || !live.active) && AUTO) { startSession(''); if (live) live.autoStarted = true; }
  if (isLive) _offlineStreak = 0; else _offlineStreak++;
  if (live && live.active) {
    if (isLive) {
      live.liveSeconds += POLL_SEC;
      const v = Math.max(0, viewerCount | 0);
      live._lastViewers = v;
      live.viewerSamples.push({ t: now(), v });
      if (live.viewerSamples.length > SAMPLE_CAP) live.viewerSamples.shift();
      if (v > live.peakViewers) live.peakViewers = v;
    }
    save();
    push(true);
  }
  // Auto-stop after ~90s of sustained offline (only sessions we auto-started).
  if (!isLive && live && live.active && live.autoStarted && _offlineStreak >= 3) stopSession();
}

// Called from the OBS stream-health poll (~5s). Accumulates drop-frame / bitrate / cpu samples.
function recordHealth(h) {
  if (!live || !live.active || !h) return;
  const H = live.health || (live.health = { n: 0, cpuSum: 0, fpsSum: 0, dropMax: 0, dropSum: 0, congMax: 0, brSum: 0, brN: 0 });
  H.n++;
  H.cpuSum += h.cpu || 0;
  H.fpsSum += h.fps || 0;
  const drop = h.outputDropPct || 0;
  H.dropSum += drop; if (drop > H.dropMax) H.dropMax = drop;
  if ((h.congestion || 0) > H.congMax) H.congMax = h.congestion || 0;
  if (h.bitrateKbps) { H.brSum += h.bitrateKbps; H.brN++; }
}

function avgViewers(samples) {
  if (!samples || !samples.length) return 0;
  return Math.round(samples.reduce((a, s) => a + (s.v || 0), 0) / samples.length);
}

// Full, persistable shape (includes viewer samples).
function finalize(s) {
  const end = s.endedAt || now();
  return {
    id: s.id, label: s.label, game: s.game, eventName: s.eventName,
    startedAt: s.startedAt, endedAt: end,
    durationSec: Math.max(0, Math.round((end - s.startedAt) / 1000)),
    liveSeconds: s.liveSeconds || 0,
    peakViewers: s.peakViewers || 0, avgViewers: avgViewers(s.viewerSamples),
    viewerSamples: s.viewerSamples || [],
    sceneTime: s.sceneTime || {}, sceneSwitches: s.sceneSwitches || 0,
    segmentTime: s.segmentTime || {},
    segments: (function () { const out = {}; const seg = s.segmentTime || {}, vs = s.segViewerSum || {}; Object.keys(seg).forEach((k) => { const sec = seg[k] || 0; out[k] = { seconds: sec, avgViewers: sec ? Math.round((vs[k] || 0) / sec) : 0 }; }); return out; })(),
    health: (function () { const H = s.health || { n: 0 }; if (!H.n) return null; return { samples: H.n, avgCpu: Math.round(H.cpuSum / H.n), avgFps: Math.round(H.fpsSum / H.n), avgDropPct: +(H.dropSum / H.n).toFixed(2), maxDropPct: +(H.dropMax || 0).toFixed(2), maxCongestion: +(H.congMax || 0).toFixed(2), avgBitrate: H.brN ? Math.round(H.brSum / H.brN) : 0 }; })(),
    ads: s.ads || { count: 0, totalSec: 0 },
    clips: s.clips || 0, replaysSaved: s.replaysSaved || 0, goals: s.goals || 0,
    matchesCompleted: s.matchesCompleted || 0, gamesCompleted: s.gamesCompleted || 0, autoSwitches: s.autoSwitches || 0,
    engagement: {
      predictionsCreated: s.predictionsCreated || 0, predictionsResolved: s.predictionsResolved || 0,
      pollsCreated: s.pollsCreated || 0, wheelSpins: s.wheelSpins || 0, minigames: s.minigames || 0,
      follows: s.follows || 0, subs: s.subs || 0, raids: s.raids || 0, raidViewers: s.raidViewers || 0, bits: s.bits || 0
    },
    disconnects: s.disconnects || []
  };
}

// Light shape for the live broadcast push (no viewer-sample array).
function liveLight() {
  if (!live || !live.active) return { active: false };
  const last = live.viewerSamples.length ? live.viewerSamples[live.viewerSamples.length - 1].v : 0;
  return {
    active: true, id: live.id, label: live.label, game: live.game,
    startedAt: live.startedAt, durationSec: Math.round((now() - live.startedAt) / 1000),
    viewers: last, peakViewers: live.peakViewers, avgViewers: avgViewers(live.viewerSamples), sampleCount: live.viewerSamples.length,
    sceneSwitches: live.sceneSwitches, ads: live.ads, clips: live.clips, replaysSaved: live.replaysSaved, goals: live.goals,
    matchesCompleted: live.matchesCompleted, gamesCompleted: live.gamesCompleted, autoSwitches: live.autoSwitches,
    disconnects: live.disconnects.length
  };
}

function push(force) {
  if (!deps.broadcast || !deps.bridgeClients) return;
  const t = now();
  if (!force && t - _lastPush < 3000) return;
  _lastPush = t;
  try { deps.broadcast(deps.bridgeClients, { type: 'analytics_update', data: liveLight() }); } catch (e) {}
}

function startSession(label) {
  if (live && live.active) return liveLight();
  live = newSession(label);
  _offlineStreak = 0;
  try { if (typeof deps.onStart === 'function') deps.onStart(live.label); } catch (e) {}
  save(true);
  push(true);
  return liveLight();
}

function stopSession() {
  if (!live || !live.active) return null;
  live.active = false; live.endedAt = now();
  let linked = null;
  try { if (typeof deps.onStop === 'function') linked = deps.onStop(); } catch (e) {}
  const sess = finalize(live);
  if (linked && linked.id) sess.adProofSessionId = linked.id;
  DB.sessions.unshift(sess);
  if (DB.sessions.length > SESSION_CAP) DB.sessions.length = SESSION_CAP;
  live = null; DB.live = null;
  save(true);
  push(true);
  return sess;
}

// ── Read API (for endpoints) ────────────────────────────────────────────────
function getLive() {
  if (!live || !live.active) return { active: false };
  const last = live.viewerSamples.length ? live.viewerSamples[live.viewerSamples.length - 1].v : 0;
  return { ...finalize(live), active: true, viewers: last };
}

function sessionRow(s) {
  return {
    id: s.id, label: s.label, game: s.game, eventName: s.eventName,
    startedAt: s.startedAt, endedAt: s.endedAt, durationSec: s.durationSec,
    peakViewers: s.peakViewers, avgViewers: s.avgViewers,
    ads: (s.ads && s.ads.count) || 0, clips: s.clips || 0,
    matchesCompleted: s.matchesCompleted || 0, disconnects: (s.disconnects || []).length
  };
}
function getSessions() {
  const rows = DB.sessions.map(sessionRow);
  if (live && live.active) rows.unshift({ ...sessionRow(finalize(live)), active: true });
  return rows;
}
function getSession(id) {
  if (live && live.active && live.id === id) return { ...finalize(live), active: true };
  return DB.sessions.find((s) => s.id === id) || null;
}
function deleteSession(id) {
  const before = DB.sessions.length;
  DB.sessions = DB.sessions.filter((s) => s.id !== id);
  if (DB.sessions.length !== before) save(true);
  return DB.sessions.length !== before;
}

function clearAllSessions() { DB.sessions = []; save(true); return true; }

function overview(eventFilter) {
  const evF = eventFilter ? String(eventFilter).toLowerCase() : '';
  const all = DB.sessions.filter((s) => !evF || (s.eventName || '').toLowerCase() === evF);
  const n = all.length;
  const sum = (f) => all.reduce((a, s) => a + (f(s) || 0), 0);
  const totalAirSec = sum((s) => s.durationSec);
  return {
    live: getLive(),
    totals: {
      broadcasts: n,
      airSeconds: totalAirSec,
      peakViewers: all.reduce((m, s) => Math.max(m, s.peakViewers || 0), 0),
      avgPeakViewers: n ? Math.round(sum((s) => s.peakViewers) / n) : 0,
      ads: sum((s) => (s.ads && s.ads.count) || 0),
      adSeconds: sum((s) => (s.ads && s.ads.totalSec) || 0),
      clips: sum((s) => s.clips),
      matches: sum((s) => s.matchesCompleted),
      games: sum((s) => s.gamesCompleted),
      follows: sum((s) => (s.engagement && s.engagement.follows) || 0),
      subs: sum((s) => (s.engagement && s.engagement.subs) || 0),
      bits: sum((s) => (s.engagement && s.engagement.bits) || 0),
      disconnects: sum((s) => (s.disconnects || []).length),
      sceneSwitches: sum((s) => s.sceneSwitches || 0),
      autoSwitches: sum((s) => s.autoSwitches || 0),
      replays: sum((s) => s.replaysSaved || 0),
      avgDropPct: (function () { const hs = all.filter((x) => x.health); return hs.length ? +(hs.reduce((a, x) => a + (x.health.avgDropPct || 0), 0) / hs.length).toFixed(2) : null; })(),
      avgCpu: (function () { const hs = all.filter((x) => x.health); return hs.length ? Math.round(hs.reduce((a, x) => a + (x.health.avgCpu || 0), 0) / hs.length) : null; })(),
      avgBitrate: (function () { const hs = all.filter((x) => x.health); return hs.length ? Math.round(hs.reduce((a, x) => a + (x.health.avgBitrate || 0), 0) / hs.length) : null; })()
    },
    recent: (evF ? getSessions().filter((s) => (s.eventName || '').toLowerCase() === evF) : getSessions()).slice(0, 12),
    // Every broadcast in time order, compact, for the Analytics charts (trend lines, per-broadcast
    // viewers, air time by month, go-live heatmap). `curve` is the viewer curve thinned to <= 48 points.
    series: all.slice().sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0)).map((s) => {
      const vs = Array.isArray(s.viewerSamples) ? s.viewerSamples : [];
      const step = Math.max(1, Math.ceil(vs.length / 48));
      return {
        id: s.id, label: s.label || s.eventName || '', eventName: s.eventName || '', game: s.game || '',
        startedAt: s.startedAt || 0, durationSec: s.durationSec || 0,
        peakViewers: s.peakViewers || 0, avgViewers: s.avgViewers || 0,
        ads: (s.ads && s.ads.count) || 0, adSeconds: (s.ads && s.ads.totalSec) || 0, clips: s.clips || 0,
        follows: (s.engagement && s.engagement.follows) || 0, subs: (s.engagement && s.engagement.subs) || 0,
        dropPct: s.health ? s.health.avgDropPct : null, disconnects: (s.disconnects || []).length,
        curve: vs.filter((_, i) => i % step === 0).map((p) => p.v || 0),
      };
    }),
    events: Array.from(new Set(DB.sessions.map((s) => s.eventName).filter(Boolean)))
  };
}

function setAuto(on) { AUTO = !!on; save(true); }
function getAuto() { return AUTO; }

// ── CSV export for one session ──────────────────────────────────────────────
function exportCsv(id) {
  const s = getSession(id);
  if (!s) return null;
  const mmss = (x) => { x = Math.max(0, Math.round(x || 0)); const m = Math.floor(x / 60); return m + ':' + String(x % 60).padStart(2, '0'); };
  const lines = [];
  lines.push('Broadcast Studio — Broadcast report');
  lines.push('Label,' + csv(s.label));
  lines.push('Game,' + csv(s.game));
  lines.push('Started,' + csv(new Date(s.startedAt).toLocaleString()));
  lines.push('Duration,' + mmss(s.durationSec));
  lines.push('Live time,' + mmss(s.liveSeconds));
  lines.push('Peak viewers,' + (s.peakViewers || 0));
  lines.push('Average viewers,' + (s.avgViewers || 0));
  lines.push('');
  lines.push('Metric,Value');
  lines.push('Scene switches,' + (s.sceneSwitches || 0));
  lines.push('Ads run,' + ((s.ads && s.ads.count) || 0));
  lines.push('Ad seconds,' + ((s.ads && s.ads.totalSec) || 0));
  lines.push('Clips captured,' + (s.clips || 0));
  lines.push('Replays saved,' + (s.replaysSaved || 0));
  lines.push('Matches completed,' + (s.matchesCompleted || 0));
  lines.push('Games completed,' + (s.gamesCompleted || 0));
  lines.push('Director auto-switches,' + (s.autoSwitches || 0));
  const e = s.engagement || {};
  lines.push('Predictions created,' + (e.predictionsCreated || 0));
  lines.push('Polls created,' + (e.pollsCreated || 0));
  lines.push('Wheel spins,' + (e.wheelSpins || 0));
  lines.push('Minigames,' + (e.minigames || 0));
  lines.push('Follows,' + (e.follows || 0));
  lines.push('Subs,' + (e.subs || 0));
  lines.push('Raids,' + (e.raids || 0));
  lines.push('Bits,' + (e.bits || 0));
  lines.push('Disconnects,' + ((s.disconnects || []).length));
  lines.push('');
  lines.push('Scene,Seconds,mm:ss');
  Object.keys(s.sceneTime || {}).sort((a, b) => s.sceneTime[b] - s.sceneTime[a])
    .forEach((k) => lines.push(csv(k) + ',' + s.sceneTime[k] + ',' + mmss(s.sceneTime[k])));
  lines.push('');
  lines.push('Viewer samples');
  lines.push('Time,Viewers');
  (s.viewerSamples || []).forEach((p) => lines.push(new Date(p.t).toLocaleTimeString() + ',' + p.v));
  return { name: (s.label || 'broadcast').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 50) || 'broadcast', csv: lines.join('\r\n') };
}
function csv(v) { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

module.exports = {
  init, event, recordStreamPoll,
  startSession, stopSession,
  getLive, getSessions, getSession, deleteSession, clearAllSessions, recordHealth,
  overview, setAuto, getAuto, exportCsv,
  isActive: () => !!(live && live.active)
};
