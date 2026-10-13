// backend/flows/engine.js — moved out of server.js (refactor step 3) unchanged; server.js creates it once
// with createFlowEngine(ctx). ctx carries stable references plus live getters (ctx.<name>) for values
// server.js replaces at runtime, and set_<name>(v) for the ones this code writes.
module.exports = function createFlowEngine(ctx) {
  const { axios, powerMonitor, EventEmitter, matchTitle, tl, state, saveAppState, broadcast, aiShielded, tagObsSwitch, syncReplayBufferAvailability, replayBufferErrorMessage, logAuto, setGfxActive, vmixDo, switcherIsVmix, switcherAutoCut, vmixMarkReplay, currentMatchFields, clearBreakAutoSwitch, scheduleBreakAutoSwitch, broadcastFullState } = ctx;

// ─── Flow Automation Engine ────────────────────────────────────────────────
// Named automation rules: one or more triggers → ordered action list.
//
// triggerMode:
//   'any'      — any trigger in the list fires the flow (OR logic)
//   'sequence' — triggers must fire in order; each trigger after the first has an
//                optional `timeout` (ms) — if the next trigger doesn't arrive in time,
//                the sequence resets to step 0.
//
// Triggers: RL (goal/round/match/OT/replay), CS2 (round/bomb/halftime/match),
//   match (score_reached/series_ended/game_started), OBS (scene/stream/record/replay),
//   Twitch (online/offline/raid/sub/bits/follow/channel_points/hype_train),
//   in-app (countdown/break_shown/break_hidden), manual
//
// Actions: OBS (scene/stream/record/replay), Twitch (prediction/poll/announce/clip/title/shoutout),
//   overlays (lower_third/ticker/break/casters/winner/sponsor/reload),
//   match (advance_game/set_series_score/reset_series), generic (wait/http_webhook)

const flowBus = new EventEmitter();
flowBus.setMaxListeners(100);

const _flowSeqState  = {};  // { [flowId]: { step: number, timeoutHandle: Timeout|null } }
const _flowLastFired = {};  // { [flowId]: ms timestamp } — for cooldown enforcement
const _flowIntervals = new Map(); // { flowId → intervalHandle } — for timer_interval triggers
const _flowFireLog   = {};  // { [flowId]: number[] } — last 20 fire timestamps per flow

const FLOW_TRIGGER_TYPES = [
  // Rocket League
  'rl_goal', 'rl_round_started', 'rl_match_ended', 'rl_overtime', 'rl_replay_start', 'rl_replay_will_end', 'rl_replay_end',
  'rl_match_created', 'rl_demo', 'rl_save',
  // CS2
  'cs2_round_start', 'cs2_round_end', 'cs2_bomb_planted', 'cs2_half_time', 'cs2_match_ended',
  'cs2_kill', 'cs2_headshot_kill', 'cs2_ace', 'cs2_bomb_defused', 'cs2_bomb_exploded', 'cs2_clutch_situation',
  // Overwatch (Overwolf GEP relay)
  'ow_match_start', 'ow_round_start', 'ow_round_end', 'ow_match_end',
  // Marvel Rivals (Overwolf GEP relay)
  'mr_match_start', 'mr_round_start', 'mr_round_end', 'mr_match_end',
  // Universal game / production
  'score_reached', 'series_ended', 'game_started',
  // OBS
  'obs_scene_changed', 'obs_stream_started', 'obs_stream_stopped', 'obs_recording_started', 'obs_recording_stopped', 'obs_replay_saved',
  'obs_source_shown', 'obs_source_hidden', 'obs_input_muted', 'obs_input_unmuted', 'obs_media_started', 'obs_media_ended',
  // Twitch
  'twitch_stream_online', 'twitch_stream_offline', 'twitch_raid', 'twitch_sub', 'twitch_bits', 'twitch_follow', 'twitch_channel_points', 'twitch_hype_train', 'twitch_poll_end', 'twitch_ad_break', 'twitch_chat_command',
  // In-app / Timer
  'timer_countdown_end', 'break_shown', 'break_hidden',
  // Scheduled
  'time_of_day',
  // System (producer-machine state — Advanced-Scene-Switcher-style triggers)
  'process_started', 'process_stopped', 'system_became_idle', 'system_became_active',
  'window_focused', 'window_unfocused',
  // Manual
  'manual'
];

// Simple 5-field cron matcher: "minute hour day month weekday" — supports * and comma lists.
function _matchesCron(expr, date) {
  const parts = (expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [m, h, dom, mo, dow] = parts;
  const match = (part, val) => part === '*' || part.split(',').some(p => Number(p.trim()) === val);
  return match(m, date.getMinutes()) && match(h, date.getHours()) &&
         match(dom, date.getDate()) && match(mo, date.getMonth() + 1) &&
         match(dow, date.getDay());
}

// ── Scene-dwell triggers — Advanced-Scene-Switcher-style "after N seconds on scene X" ──
// Re-armed on every OBS program-scene change: every enabled flow with an obs_scene_dwell
// trigger matching the NEW scene gets a timer; a scene change before it lands cancels all.
let _dwellTimers = [];
function armSceneDwellFlows(sceneName) {
  _dwellTimers.forEach(clearTimeout);
  _dwellTimers = [];
  if (!sceneName) return;
  for (const flow of (state.flows || [])) {
    if (!flow.enabled) continue;
    (flow.triggers || []).forEach((t) => {
      if (t.type !== 'obs_scene_dwell') return;
      const p = t.params || {};
      if (p.scene && p.scene.toLowerCase() !== sceneName.toLowerCase()) return;
      const secs = Math.max(1, Number(p.seconds) || 30);
      _dwellTimers.push(setTimeout(() => {
        if ((state.obs.currentScene || '') !== sceneName) return;   // scene moved on — stale timer
        _fireFlow(flow, { scene: sceneName, dwellSec: secs });
      }, secs * 1000));
    });
  }
}

function initFlowEngine() {
  FLOW_TRIGGER_TYPES.forEach(type => {
    flowBus.on(type, data => _onFlowTrigger(type, data || {}));
  });
  // Minute tick: time_of_day events + cron_schedule evaluation.
  setInterval(() => {
    const now = new Date();
    const hhmm = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
    flowBus.emit('time_of_day', { time: hhmm });
    // Cron triggers fire directly — not via flowBus — to avoid wiring a bus listener.
    for (const flow of (state.flows || [])) {
      if (!flow.enabled) continue;
      for (const trig of (flow.triggers || [])) {
        if (trig.type === 'cron_schedule' && (trig.params || {}).expr) {
          if (_matchesCron(trig.params.expr, now)) _fireFlow(flow, { type: 'cron_schedule', time: hhmm });
        }
      }
    }
  }, 60000);
  _syncFlowIntervals();
}

// Start/stop per-flow setIntervals for timer_interval triggers.
function _syncFlowIntervals() {
  // Stop intervals for flows that were deleted, disabled, or no longer have a timer trigger.
  for (const [flowId, handle] of _flowIntervals) {
    const flow = (state.flows || []).find(f => f.id === flowId);
    const hasTimer = flow && flow.enabled && (flow.triggers || []).some(t => t.type === 'timer_interval');
    if (!hasTimer) { clearInterval(handle); _flowIntervals.delete(flowId); }
  }
  // Start intervals for eligible flows that aren't running yet.
  for (const flow of (state.flows || [])) {
    if (!flow.enabled || _flowIntervals.has(flow.id)) continue;
    const trig = (flow.triggers || []).find(t => t.type === 'timer_interval');
    if (!trig) continue;
    const ms = Math.max(1000, (Number((trig.params || {}).seconds) || 60) * 1000);
    _flowIntervals.set(flow.id, setInterval(() => {
      const live = (state.flows || []).find(f => f.id === flow.id);
      if (live && live.enabled) _fireFlow(live, { type: 'timer_interval' });
    }, ms));
  }
  // Re-arm scene-dwell timers against the current program scene (flow edits change eligibility).
  if (typeof armSceneDwellFlows === 'function') armSceneDwellFlows(state.obs.currentScene || '');
  // System-state watch-lists (process detection, idle detection, audio-level conditions) — only
  // poll/track for names/thresholds actually referenced by an enabled flow, and stop entirely
  // once none are.
  _syncProcessWatchList();
  _syncIdleWatchList();
  _syncAudioWatchList();
  _syncWindowWatchList();
}

// ── Audio-level conditions (audio_level_above/audio_level_below) ──────────────────────────────
// obs-client.js's onVolumeMeters delivers ~10 samples/sec per active input once subscribed
// (InputVolumeMeters is opt-in — see obs-client.js's connect() eventSubscriptions). Kept as a
// bounded rolling buffer per watched source so "has it been above/below X for the last N
// seconds" can be answered without re-querying OBS at condition-eval time.
const _audioLevelHistory = new Map();   // sourceName -> [{db, ts}], trimmed to the last 60s
const _audioWatchList = new Set();      // sourceNames referenced by an enabled flow's audio condition
function _syncAudioWatchList() {
  const names = new Set();
  for (const flow of (state.flows || [])) {
    if (!flow.enabled) continue;
    for (const c of (flow.conditions || []))
      if ((c.type === 'audio_level_above' || c.type === 'audio_level_below') && c.params && c.params.sourceName)
        names.add(c.params.sourceName);
  }
  _audioWatchList.clear();
  names.forEach(n => _audioWatchList.add(n));
  for (const k of Array.from(_audioLevelHistory.keys())) if (!_audioWatchList.has(k)) _audioLevelHistory.delete(k);
}
function _onObsVolumeMeters(inputs) {
  if (_audioWatchList.size === 0) return;
  const now = Date.now();
  for (const inp of inputs || []) {
    if (!inp || !_audioWatchList.has(inp.inputName)) continue;
    // inputLevelsMul: per-channel [levelMul, levelPeakMul, levelInputPeakMul] linear multipliers
    // (obs-websocket 5.x protocol) — use the peak of whichever channel is loudest this sample.
    const chans = inp.inputLevelsMul || [];
    let peakMul = 0;
    for (const c of chans) if (c && c[1] > peakMul) peakMul = c[1];
    const db = peakMul > 0 ? 20 * Math.log10(peakMul) : -100;
    const buf = _audioLevelHistory.get(inp.inputName) || [];
    buf.push({ db, ts: now });
    while (buf.length && now - buf[0].ts > 60000) buf.shift();
    _audioLevelHistory.set(inp.inputName, buf);
  }
}

// ── Process detection (process_started/process_stopped triggers, process_running condition) ──
// PowerShell Get-Process, never wmic — wmic is removed on newer Windows 11 builds and has already
// caused a crash elsewhere in this app (backend/clips/montage-encoder.js). One spawn per poll
// checks every running process regardless of watch-list size (the spawn itself, ~150-400ms,
// dominates the cost — a name-filtered query wouldn't meaningfully speed this up).
const _processWatchList = new Set();       // normalized names (lowercase, no .exe)
const _processRunningState = new Map();    // name -> bool, last known state
let _processPollTimer = null;
function _normalizeProcessName(n) { return (n || '').trim().toLowerCase().replace(/\.exe$/, ''); }
function _syncProcessWatchList() {
  const names = new Set();
  for (const flow of (state.flows || [])) {
    if (!flow.enabled) continue;
    for (const t of (flow.triggers || []))
      if ((t.type === 'process_started' || t.type === 'process_stopped') && t.params && t.params.processName)
        names.add(_normalizeProcessName(t.params.processName));
    for (const c of (flow.conditions || []))
      if (c.type === 'process_running' && c.params && c.params.processName)
        names.add(_normalizeProcessName(c.params.processName));
  }
  _processWatchList.clear();
  names.forEach(n => _processWatchList.add(n));
  if (_processWatchList.size === 0) {
    if (_processPollTimer) { clearInterval(_processPollTimer); _processPollTimer = null; }
    return;
  }
  if (!_processPollTimer) _processPollTimer = setInterval(_pollProcesses, 3000);
}
function _pollProcesses() {
  if (_processWatchList.size === 0) return;
  require('child_process').exec(
    'powershell -NoProfile -Command "Get-Process | Select-Object -ExpandProperty ProcessName"',
    { windowsHide: true, timeout: 5000 },
    (err, stdout) => {
      if (err) return;   // transient failure (PowerShell busy, etc.) — next poll retries; avoid log spam
      const running = new Set(String(stdout).split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(Boolean));
      for (const name of _processWatchList) {
        const now = running.has(name);
        const was = _processRunningState.get(name) || false;
        if (now && !was) flowBus.emit('process_started', { processName: name });
        if (!now && was) flowBus.emit('process_stopped', { processName: name });
        _processRunningState.set(name, now);
      }
    }
  );
}

// ── Idle detection (system_became_idle/system_became_active triggers, system_idle_for condition) ──
// powerMonitor.getSystemIdleTime() is Electron-built-in — no new dependency, no subprocess.
const _idleCrossed = new Map();   // minutes threshold -> bool (currently considered idle at that threshold)
let _idlePollTimer = null;
function _syncIdleWatchList() {
  const thresholds = new Set();
  for (const flow of (state.flows || [])) {
    if (!flow.enabled) continue;
    for (const t of (flow.triggers || []))
      if (t.type === 'system_became_idle') thresholds.add(Math.max(1, Number((t.params || {}).minutes) || 5));
  }
  if (thresholds.size === 0) {
    if (_idlePollTimer) { clearInterval(_idlePollTimer); _idlePollTimer = null; }
    return;
  }
  if (!_idlePollTimer) _idlePollTimer = setInterval(_pollIdle, 5000);
}
function _pollIdle() {
  const idleSec = powerMonitor.getSystemIdleTime();
  for (const flow of (state.flows || [])) {
    if (!flow.enabled) continue;
    for (const t of (flow.triggers || [])) {
      if (t.type !== 'system_became_idle') continue;
      const mins = Math.max(1, Number((t.params || {}).minutes) || 5);
      const isIdleNow = idleSec >= mins * 60;
      const wasIdle = _idleCrossed.get(mins) || false;
      if (isIdleNow && !wasIdle) flowBus.emit('system_became_idle', { minutes: mins });
      if (!isIdleNow && wasIdle) flowBus.emit('system_became_active', { minutes: mins });
      _idleCrossed.set(mins, isIdleNow);
    }
  }
}

// ── Window focus detection (window_focused/window_unfocused triggers, window_is_focused condition) ──
// GetForegroundWindow via a PowerShell Add-Type P/Invoke — no new npm dependency, avoids an
// Electron-ABI-sensitive native module (e.g. active-win). Add-Type's C# compile makes each call
// ~1.2s (vs ~150-400ms for the plain Get-Process poll above), so this polls on a longer 5s interval
// with an in-flight guard to avoid a slow call backing up behind the next tick.
const _windowWatchList = new Set();        // normalized (lowercase) titleContains substrings
const _windowMatchState = new Map();       // titleContains substring -> bool, last known match state
let _windowPollTimer = null;
let _windowPollInFlight = false;
let _lastFocusedWindowTitle = '';          // cache read by the window_is_focused condition
const _WINDOW_FOCUS_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Focus {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Auto)]
  public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
}
"@
$hwnd = [Win32Focus]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 256
[Win32Focus]::GetWindowText($hwnd, $sb, 256) | Out-Null
$sb.ToString()
`;
function _syncWindowWatchList() {
  const titles = new Set();
  for (const flow of (state.flows || [])) {
    if (!flow.enabled) continue;
    for (const t of (flow.triggers || []))
      if ((t.type === 'window_focused' || t.type === 'window_unfocused') && t.params && t.params.titleContains)
        titles.add(t.params.titleContains.trim().toLowerCase());
    for (const c of (flow.conditions || []))
      if (c.type === 'window_is_focused' && c.params && c.params.titleContains)
        titles.add(c.params.titleContains.trim().toLowerCase());
  }
  _windowWatchList.clear();
  titles.forEach(t => _windowWatchList.add(t));
  for (const k of Array.from(_windowMatchState.keys())) if (!_windowWatchList.has(k)) _windowMatchState.delete(k);
  if (_windowWatchList.size === 0) {
    if (_windowPollTimer) { clearInterval(_windowPollTimer); _windowPollTimer = null; }
    return;
  }
  if (!_windowPollTimer) _windowPollTimer = setInterval(_pollWindowFocus, 5000);
}
function _pollWindowFocus() {
  if (_windowWatchList.size === 0 || _windowPollInFlight) return;
  _windowPollInFlight = true;
  require('child_process').execFile(
    'powershell.exe', ['-NoProfile', '-Command', _WINDOW_FOCUS_SCRIPT],
    { windowsHide: true, timeout: 5000 },
    (err, stdout) => {
      _windowPollInFlight = false;
      if (err) return;   // transient failure (PowerShell busy, etc.) — next poll retries; avoid log spam
      const title = String(stdout || '').trim();
      _lastFocusedWindowTitle = title;
      const lower = title.toLowerCase();
      for (const needle of _windowWatchList) {
        const now = lower.includes(needle);
        const was = _windowMatchState.get(needle) || false;
        if (now && !was) flowBus.emit('window_focused', { title, titleContains: needle });
        if (!now && was) flowBus.emit('window_unfocused', { title, titleContains: needle });
        _windowMatchState.set(needle, now);
      }
    }
  );
}

function _onFlowTrigger(type, data) {
  const flows = state.flows || [];
  for (const flow of flows) {
    if (!flow.enabled) continue;
    const triggers = flow.triggers || [];
    if (!triggers.length) continue;
    if (flow.triggerMode === 'sequence') {
      _handleSequenceTrigger(flow, type, data);
    } else {
      if (triggers.some(t => _triggerMatches(t, type, data, flow))) _fireFlow(flow, data);
    }
  }
}

function _triggerMatches(trigger, type, data, flow) {
  if (trigger.type !== type) return false;
  const p = trigger.params || {};
  switch (type) {
    case 'rl_goal':
    case 'rl_demo':
    case 'rl_save': {
      const team = p.team || 'any';
      if (team === 'any') return true;
      return (team === 'blue' && data.team === 0) || (team === 'orange' && data.team === 1);
    }
    case 'cs2_round_end':
      return !p.winner || p.winner === 'any' || data.winner === p.winner;
    case 'cs2_kill':
    case 'cs2_headshot_kill':
    case 'cs2_ace': {
      const team = p.team || 'any';
      if (team === 'any') return true;
      return (data.killerTeam || data.team) === team;
    }
    case 'process_started':
    case 'process_stopped':
      return !p.processName || p.processName.trim().toLowerCase().replace(/\.exe$/, '') === (data.processName || '');
    case 'system_became_idle':
      return !p.minutes || Number(p.minutes) === data.minutes;
    case 'window_focused':
    case 'window_unfocused':
      return !p.titleContains || (data.title || '').toLowerCase().includes(p.titleContains.trim().toLowerCase());
    case 'twitch_channel_points':
      return !p.rewardTitle || (data.reward || '').toLowerCase().includes(p.rewardTitle.toLowerCase());
    case 'twitch_raid':
      return !p.minViewers || (data.viewers || 0) >= Number(p.minViewers);
    case 'twitch_bits':
      return !p.minBits || (data.bits || 0) >= Number(p.minBits);
    case 'twitch_sub':
      return !p.tier || p.tier === 'any' || data.tier === p.tier;
    case 'obs_scene_changed':
      return !p.scene || (data.scene || '').toLowerCase() === p.scene.toLowerCase();
    case 'obs_source_shown':
    case 'obs_source_hidden':
      return !p.sourceName || (data.sourceName || '').toLowerCase() === p.sourceName.toLowerCase();
    case 'obs_input_muted':
    case 'obs_input_unmuted':
    case 'obs_media_started':
    case 'obs_media_ended':
      return !p.inputName || (data.inputName || '').toLowerCase() === p.inputName.toLowerCase();
    case 'score_reached': {
      if (!p.team || p.value == null) return true;
      const score = p.team === 'blue' ? state.game.blueScore : state.game.orangeScore;
      return score >= Number(p.value);
    }
    case 'series_ended':
      return !p.winner || p.winner === 'any' || data.winner === p.winner;
    case 'time_of_day':
      return !!p.time && p.time === data.time;
    case 'twitch_chat_command':
      return !p.command || data.command === p.command.toLowerCase().replace(/^!/, '');
    case 'manual':
      // A manual trigger belongs to ITS OWN flow: fire_flow_manual for flow X must only fire X.
      // A bare params ({}) used to match EVERY manual emission — with several manual flows saved,
      // running any one of them ran them all (last break-screen action won, ad reads spammed chat).
      // params.flowId stays as an explicit override for "also fire me when flow Y is run manually".
      return data.flowId === (p.flowId || (flow && flow.id));
    default:
      return true;
  }
}

// ── Conditions (AND guards checked at fire time) ─────────────────────────────
function _checkFlowConditions(conditions) {
  for (const cond of conditions) {
    if (!_evalCondition(cond)) return false;
  }
  return true;
}
function _evalCondition(cond) {
  const p = cond.params || {};
  switch (cond.type) {
    case 'if_obs_scene':
      return !p.scene || ((state.obs || {}).currentScene || '') === p.scene;
    case 'if_streaming':
      return !!((state.obs || {}).streaming);
    case 'if_not_streaming':
      return !((state.obs || {}).streaming);
    case 'if_recording':
      return !!((state.obs || {}).recording);
    case 'if_not_recording':
      return !((state.obs || {}).recording);
    case 'if_game_number': {
      const n = Number(p.value);
      return isNaN(n) || state.game.number === n;
    }
    case 'if_series_state': {
      const b = state.series.blue || 0, o = state.series.orange || 0;
      if (p.compare === 'blue_leads')   return b > o;
      if (p.compare === 'orange_leads') return o > b;
      if (p.compare === 'tied')         return b === o;
      return true;
    }
    case 'if_score_diff': {
      const diff = Math.abs((state.game.blueScore || 0) - (state.game.orangeScore || 0));
      const val = Number(p.value) || 0;
      if (p.op === 'gte') return diff >= val;
      if (p.op === 'lte') return diff <= val;
      if (p.op === 'eq')  return diff === val;
      return true;
    }
    case 'if_time_range': {
      const now = new Date();
      const cur = now.getHours() * 60 + now.getMinutes();
      const [sh, sm] = (p.start || '00:00').split(':').map(Number);
      const [eh, em] = (p.end   || '23:59').split(':').map(Number);
      const start = sh * 60 + sm, end = eh * 60 + em;
      return start <= end ? (cur >= start && cur <= end) : (cur >= start || cur <= end);
    }
    case 'if_variable': {
      const val = String((state.flowVars || {})[p.name] ?? '');
      const cmp = String(p.value ?? '');
      const nv = Number(val), nc = Number(cmp);
      if (p.op === 'eq')       return val === cmp;
      if (p.op === 'neq')      return val !== cmp;
      if (p.op === 'gt')       return !isNaN(nv) && !isNaN(nc) && nv > nc;
      if (p.op === 'lt')       return !isNaN(nv) && !isNaN(nc) && nv < nc;
      if (p.op === 'gte')      return !isNaN(nv) && !isNaN(nc) && nv >= nc;
      if (p.op === 'lte')      return !isNaN(nv) && !isNaN(nc) && nv <= nc;
      if (p.op === 'contains') return val.toLowerCase().includes(cmp.toLowerCase());
      return !!val; // no op = just check if var is set and non-empty
    }
    case 'if_flow_last_fired': {
      if (!p.flowId || !p.maxAgoMs) return true;
      const last = _flowLastFired[p.flowId];
      if (!last) return false;
      return (Date.now() - last) <= Number(p.maxAgoMs);
    }
    case 'flow_is_enabled': {
      if (!p.flowId) return true;
      const f = (state.flows || []).find(f => f.id === p.flowId);
      return !!(f && f.enabled);
    }
    case 'system_idle_for':
      return !p.minutes || powerMonitor.getSystemIdleTime() >= Number(p.minutes) * 60;
    case 'process_running':
      return !p.processName || !!_processRunningState.get(_normalizeProcessName(p.processName));
    case 'window_is_focused':
      return !p.titleContains || _lastFocusedWindowTitle.toLowerCase().includes(p.titleContains.trim().toLowerCase());
    case 'audio_level_above':
    case 'audio_level_below': {
      if (!p.sourceName || p.thresholdDb == null || !p.seconds) return true;
      const buf = _audioLevelHistory.get(p.sourceName) || [];
      const windowStart = Date.now() - Number(p.seconds) * 1000;
      if (!buf.length || buf[0].ts > windowStart) return false;   // not enough history yet to prove it
      const inWindow = buf.filter(s => s.ts >= windowStart);
      const threshold = Number(p.thresholdDb);
      return cond.type === 'audio_level_above'
        ? inWindow.every(s => s.db >= threshold)
        : inWindow.every(s => s.db <= threshold);
    }
    case 'if_match_point': {
      const half = Math.ceil((state.bestOf || 5) / 2);
      const b = state.series?.blue || 0, o = state.series?.orange || 0;
      const blueMP   = b === half - 1;
      const orangeMP = o === half - 1;
      if (p.team === 'blue')   return blueMP;
      if (p.team === 'orange') return orangeMP;
      return blueMP || orangeMP; // 'any' — either team
    }
    default:
      return true;
  }
}

function _handleSequenceTrigger(flow, type, data) {
  const seq = _flowSeqState[flow.id] || { step: 0, timeoutHandle: null };
  const triggers = flow.triggers || [];
  const current = triggers[seq.step];
  if (!current || !_triggerMatches(current, type, data, flow)) return;

  if (seq.timeoutHandle) { clearTimeout(seq.timeoutHandle); seq.timeoutHandle = null; }

  const nextStep = seq.step + 1;
  if (nextStep >= triggers.length) {
    _flowSeqState[flow.id] = { step: 0, timeoutHandle: null };
    _fireFlow(flow, data);
  } else {
    const nextTrigger = triggers[nextStep];
    const timeout = nextTrigger && Number(nextTrigger.timeout);
    const handle = (timeout > 0)
      ? setTimeout(() => { _flowSeqState[flow.id] = { step: 0, timeoutHandle: null }; }, timeout)
      : null;
    _flowSeqState[flow.id] = { step: nextStep, timeoutHandle: handle };
  }
}

// Thrown by the stop_flow action to exit the current flow cleanly.
class _StopFlow extends Error {
  constructor() { super('stop_flow'); this.name = '_StopFlow'; }
}

// Replace {{token}} placeholders in a string with live game-state and flow-var values.
function _substituteTokens(text, ctx) {
  if (!text || typeof text !== 'string') return text;
  const g = state.game || {};
  const blue   = state.teams?.blue   || {};
  const orange = state.teams?.orange || {};
  let out = text
    .replaceAll('{{blue_score}}',    String(g.blueScore   ?? 0))
    .replaceAll('{{orange_score}}',  String(g.orangeScore ?? 0))
    .replaceAll('{{blue_team}}',     blue.name   || 'Blue')
    .replaceAll('{{orange_team}}',   orange.name || 'Orange')
    .replaceAll('{{series_blue}}',   String(state.series?.blue   || 0))
    .replaceAll('{{series_orange}}', String(state.series?.orange || 0))
    .replaceAll('{{game_number}}',   String(g.number || 1))
    .replaceAll('{{map_name}}',      g.map || '')
    .replaceAll('{{event_title}}',   state.eventTitle || '')
    .replaceAll('{{best_of}}',       String(state.bestOf || 5));
  for (const [k, v] of Object.entries(state.flowVars || {}))
    out = out.replaceAll(`{{${k}}}`, String(v ?? ''));
  if (ctx && typeof ctx === 'object')
    for (const [k, v] of Object.entries(ctx))
      if (typeof v === 'string' || typeof v === 'number')
        out = out.replaceAll(`{{trigger.${k}}}`, String(v));
  return out;
}

const _flowPausedUntil = {};
async function _fireFlow(flow, triggerData) {
  const now = Date.now();
  const cooldown = Number(flow.cooldown) || 0;
  if (cooldown > 0 && _flowLastFired[flow.id] && now - _flowLastFired[flow.id] < cooldown) return;
  // Conditions: all must pass (AND logic)
  if ((flow.conditions || []).length && !_checkFlowConditions(flow.conditions)) return;
  // Runaway guard: a flow whose action re-triggers itself (a scene-change trigger with no filter plus
  // a scene-cut action) used to cut back and forth forever. More than 8 runs in 10s pauses it for 30s.
  // Only OBS-driven triggers can feed back into themselves (a scene/source/media change trigger
  // whose action causes that change). Timers, Twitch alerts (gift bombs), chat commands, game
  // events and manual presses legitimately fire fast and must never be paused.
  const selfFeeding = (flow.triggers || []).some((t) => /^obs_/.test(String((t && t.type) || '')));
  if (selfFeeding && _flowPausedUntil[flow.id] && now < _flowPausedUntil[flow.id]) return;
  const recent = selfFeeding ? (_flowFireLog[flow.id] || []).filter((t) => now - t < 10000).length : 0;
  if (selfFeeding && recent >= 8) {
    _flowPausedUntil[flow.id] = now + 30000;
    logAuto('flow', `Flow "${flow.name || flow.id}" fired ${recent} times in 10s: paused for 30s (is it triggering itself?)`);
    console.warn('[Flow] runaway guard paused', flow.name || flow.id);
    tl('flow.paused', { flow: flow.name || flow.id, runs: recent });
    return;
  }
  _flowLastFired[flow.id] = now;
  // Track fire history (last 20 per flow)
  if (!_flowFireLog[flow.id]) _flowFireLog[flow.id] = [];
  _flowFireLog[flow.id].unshift(now);
  if (_flowFireLog[flow.id].length > 20) _flowFireLog[flow.id].length = 20;
  logAuto('flow', `Flow fired: ${flow.name || flow.id}${triggerData && triggerData.dwellSec ? ` (after ${triggerData.dwellSec}s on "${triggerData.scene}")` : ''}`);

  const repeatCount = Math.max(1, Number(flow.repeatCount) || 1);
  const repeatDelay = Math.max(0, Number(flow.repeatDelay) || 0);
  for (let rep = 0; rep < repeatCount; rep++) {
    if (rep > 0 && repeatDelay > 0) await new Promise(r => setTimeout(r, repeatDelay));
    for (const action of (flow.actions || [])) {
      if (Number(action.delay) > 0) await new Promise(r => setTimeout(r, Number(action.delay)));
      try { await _executeFlowAction(action, triggerData); }
      catch (e) {
        if (e instanceof _StopFlow) return; // stop_flow action — exit cleanly
        console.error('[Flow]', flow.name, '→', action.type, e.message);
      }
    }
  }
}

async function _executeFlowAction(action, ctx) {
  const rawP = action.params || {};
  // Substitute {{tokens}} in all string param values before executing
  const p = Object.fromEntries(
    Object.entries(rawP).map(([k, v]) => [k, typeof v === 'string' ? _substituteTokens(v, ctx) : v])
  );
  switch (action.type) {
    case 'wait':
      await new Promise(r => setTimeout(r, Math.max(0, Number(p.ms) || 0)));
      break;
    case 'obs_scene':
      // AI Shield promises to pause ALL scene automation — flows included.
      if (aiShielded()) { logAuto('flow', `Flow scene cut to "${p.scene}" BLOCKED — AI shield engaged`); break; }
      if (!p.scene) { logAuto('flow', 'Flow "Cut to scene" action has no scene selected — skipped'); break; }
      if (switcherIsVmix()) {
        const r = switcherAutoCut(p.scene);
        logAuto('flow', r.ok ? `Flow cut to "${p.scene.trim()}" (vMix)` : `Flow cut to "${p.scene.trim()}" skipped — ${ctx.RL_SCENE_FAIL_MESSAGES[r.reason] || r.reason}`);
        break;
      }
      if (ctx.obsClient && ctx.obsClient.isConnected()) {
        logAuto('flow', `Flow cut to "${p.scene.trim()}"`);
        tagObsSwitch(p.scene, 'auto');
        ctx.obsClient.switchScene(p.scene.trim());
      } else {
        logAuto('flow', `Flow cut to "${p.scene.trim()}" skipped — OBS not connected`);
      }
      break;
    // Switch back to whatever scene was on program before the last cut (ASS-style "previous scene").
    case 'obs_scene_previous':
      if (aiShielded()) { logAuto('flow', 'Flow previous-scene cut BLOCKED — AI shield engaged'); break; }
      if (switcherIsVmix()) {
        if (state.vmix.previousTitle) { logAuto('flow', `Flow cut back to previous input "${state.vmix.previousTitle}"`); switcherAutoCut(state.vmix.previousTitle); }
        break;
      }
      if (ctx.obsClient && ctx.obsClient.isConnected() && state.obs.previousScene) {
        logAuto('flow', `Flow cut back to previous scene "${state.obs.previousScene}"`);
        tagObsSwitch(state.obs.previousScene, 'auto');
        ctx.obsClient.switchScene(state.obs.previousScene);
      }
      break;
    case 'obs_save_replay':
      if (switcherIsVmix()) { await vmixMarkReplay(); break; }
      if (ctx.obsClient && ctx.obsClient.isConnected())
        try { await ctx.obsClient.call('SaveReplayBuffer'); } catch(e){}
      break;

    // ── vMix flow actions (fire vMix HTTP functions) ──────────────────────────
    case 'vmix_cut': {
      // Cut / transition PROGRAM to an input. Input = number | name | GUID.
      if (aiShielded()) { console.log('[Flow] vmix_cut skipped — AI shield engaged'); break; }
      const fn = (p.transition && p.transition !== 'Cut') ? p.transition : 'Cut';
      const params = { Input: p.input };
      const dur = Number(p.duration); if (dur > 0) params.Duration = Math.round(dur);
      await vmixDo(fn, params);
      break;
    }
    case 'vmix_overlay': {
      // Overlay channel 1-4 In / Out / Off (or toggle). Input optional (sets what the channel shows).
      if (aiShielded()) { console.log('[Flow] vmix_overlay skipped — AI shield engaged'); break; }
      const ch = Math.max(1, Math.min(4, Number(p.channel) || 1));
      const act = (p.action || 'In');                       // In | Out | Off | toggle
      const fn = 'OverlayInput' + ch + (act === 'toggle' ? '' : act);
      const params = {}; if (p.input) params.Input = p.input;
      await vmixDo(fn, params);
      break;
    }
    case 'vmix_start_stream': await vmixDo('StartStreaming', p.value !== undefined && p.value !== '' ? { Value: p.value } : {}); break;
    case 'vmix_stop_stream':  await vmixDo('StopStreaming',  p.value !== undefined && p.value !== '' ? { Value: p.value } : {}); break;
    case 'vmix_start_record': await vmixDo('StartRecording'); break;
    case 'vmix_stop_record':  await vmixDo('StopRecording');  break;
    case 'vmix_replay_last':  await vmixDo('ReplayPlayLastEvent'); break;
    case 'vmix_fade_to_black': await vmixDo('FadeToBlack'); break;
    case 'vmix_set_text': {
      // Update a Title/GT text field: SelectedName like "Headline.Text"; Input = the title input.
      const params = { Input: p.input, SelectedName: p.selectedName, Value: p.value !== undefined ? String(p.value) : '' };
      await vmixDo('SetText', params);
      break;
    }
    case 'vmix_function': {
      // Power-user escape hatch: any vMix function + optional Input/Value/Duration.
      if (!p.function) break;
      const params = {};
      if (p.input) params.Input = p.input;
      if (p.value !== undefined && p.value !== '') params.Value = p.value;
      const dur = Number(p.duration); if (dur > 0) params.Duration = Math.round(dur);
      await vmixDo(p.function, params);
      break;
    }

    case 'overlay_ticker':
      state.ticker = { ...state.ticker, messages: [p.text || ''].filter(Boolean), visible: true };
      broadcastFullState();
      break;
    case 'overlay_ticker_hide':
      state.ticker = { ...state.ticker, visible: false };
      broadcastFullState();
      break;
    case 'overlay_lower_third': {
      state.ticker = { ...state.ticker, messages: [p.text || ''].filter(Boolean), visible: true };
      broadcastFullState();
      const dur = Number(p.duration) || 0;
      if (dur > 0) {
        await new Promise(r => setTimeout(r, dur));
        state.ticker = { ...state.ticker, visible: false };
        broadcastFullState();
      }
      break;
    }
    case 'overlay_break_show':
      state.breakScreen = { ...state.breakScreen, visible: true };
      broadcastFullState();
      break;
    case 'overlay_break_hide':
      state.breakScreen = { ...state.breakScreen, visible: false };
      clearBreakAutoSwitch();
      broadcastFullState();
      break;
    case 'overlay_countdown_start': {
      // Start the "starting soon" break-screen countdown. Optional thenScene auto-cuts to that OBS
      // scene when it reaches 0 (same engine as the manual break countdown).
      const secs = Math.max(0, Number(p.seconds) || 0);
      state.breakScreen = {
        ...state.breakScreen,
        visible: true,
        title: (typeof p.title === 'string' && p.title.trim()) ? p.title : (state.breakScreen.title || 'STARTING SOON'),
        endsAt: secs > 0 ? Date.now() + secs * 1000 : null,
        frozenSeconds: null,
        thenScene: typeof p.thenScene === 'string' ? p.thenScene : (state.breakScreen.thenScene || '')
      };
      scheduleBreakAutoSwitch();
      saveAppState();
      broadcastFullState();
      break;
    }
    case 'set_event_title':
      state.eventName = (p.title || '').toString();
      saveAppState();
      broadcastFullState();
      break;
    case 'set_round_label':
      state.roundLabel = (p.text || '').toString();
      state.startgg.roundLabelAuto = false;   // hand-set — retuneRoundLabel must not overwrite it
      state.startgg.roundLabelSetId = null;
      saveAppState();
      broadcastFullState();
      break;
    case 'set_match_label':
      state.gameLabel = (p.text || '').toString();
      saveAppState();
      broadcastFullState();
      break;
    case 'overlay_casters_show':
      state.casters = { ...state.casters, visible: true };
      broadcastFullState();
      break;
    case 'overlay_casters_hide':
      state.casters = { ...state.casters, visible: false };
      broadcastFullState();
      break;
    case 'overlay_winner': {
      // Resolve the winning side. An explicit side param wins; otherwise ('auto' or unset) use the
      // trigger's winner — series_ended passes { winner } and only fires once the SERIES is clinched
      // (ceil(bestOf/2) game wins; Bo1 = the single game) — falling back to whoever leads the series.
      // This is what makes a "series_ended → show winner" flow display the real champion, not a preset.
      const side = (p.side && p.side !== 'auto') ? p.side
                 : (ctx && (ctx.winner === 'blue' || ctx.winner === 'orange')) ? ctx.winner
                 : (state.series.blue > state.series.orange ? 'blue'
                    : state.series.orange > state.series.blue ? 'orange' : 'blue');
      const team = (state.teams && state.teams[side]) || {};
      state.winner = {
        ...state.winner, visible: true, side,
        name:  p.name || team.name || state.winner.name || '',
        logo:  p.name ? state.winner.logo : (team.logo || state.winner.logo || null),
        color: team.color || state.winner.color || '',
      };
      broadcastFullState();
      break;
    }
    case 'overlay_winner_hide':
      state.winner = { ...state.winner, visible: false };
      broadcastFullState();
      break;
    case 'gfx_trigger': {
      // Push one of the on-demand punch-up graphics (line-up, veto, draft, bracket, schedule,
      // standings, credits, matchup) live through the SAME exclusivity path the Graphics hub uses —
      // whatever content is already configured for that graphic (team names, veto state, bracket
      // view, etc.) is what shows; this only handles visibility + on-air exclusivity, matching what
      // the producer already set up earlier. Chain a "Cut to scene" action after this (with a short
      // delay if you want the entrance animation to play first) to also switch OBS.
      if (aiShielded()) { logAuto('flow', `Flow graphic trigger "${p.key}" BLOCKED — AI shield engaged`); break; }
      if (!p.key) { logAuto('flow', 'Flow "Push graphic live" action has no graphic selected — skipped'); break; }
      setGfxActive(p.key);
      logAuto('flow', `Flow pushed graphic "${p.key}" live`);
      break;
    }
    case 'gfx_hide':
      if (aiShielded()) { logAuto('flow', 'Flow "Hide on-air graphic" BLOCKED — AI shield engaged'); break; }
      setGfxActive(null);
      logAuto('flow', 'Flow hid the on-air graphic');
      break;
    case 'overlay_reload':
      broadcast(ctx.bridgeClients, { type: 'reload' });
      break;
    case 'match_advance_game':
      state.game.number = Math.min(state.bestOf, state.game.number + 1);
      broadcastFullState();
      break;
    case 'match_reset_series':
      state.series = { blue: 0, orange: 0 };
      state.game.number = 1;
      // Fresh series = fresh stat sheet (matches finalizeAndResetSeries) — don't carry the last
      // series' per-game player stats into the new one.
      if (state.seriesStats) { state.seriesStats.games = []; state.seriesStats.liveBanked = false; }
      broadcastFullState();
      break;
    case 'twitch_prediction_create':
      if (ctx.predictionManager) try {
        const title = p.title || 'Who will win?';
        const outcomes = [p.outcome1 || 'Team Blue', p.outcome2 || 'Team Orange'];
        await ctx.predictionManager.createPrediction(title, outcomes, Number(p.duration) || 120);
      } catch(e){ console.warn('[Flow] prediction create:', e.message); }
      break;
    case 'twitch_prediction_lock':
      if (ctx.predictionManager) try { await ctx.predictionManager.lockPrediction(); } catch(e){}
      break;
    case 'twitch_prediction_resolve':
      if (ctx.predictionManager) try {
        const _cur = ctx.predictionManager.currentPrediction || state.twitch.predictions.current;
        const _outcomes = _cur?.outcomes || [];
        const idx = Number(p.outcomeIndex) || 0;
        const _outcomeId = _outcomes[idx]?.id;
        const _predId = _cur?.id;
        if (_outcomeId && _predId) await ctx.predictionManager.resolvePrediction(_outcomeId, _predId);
      } catch(e){ console.warn('[Flow] prediction resolve:', e.message); }
      break;
    case 'twitch_prediction_cancel':
      if (ctx.predictionManager) try { await ctx.predictionManager.cancelPrediction(); } catch(e){}
      break;
    case 'twitch_announcement': {
      const _cid = state.twitch.channelId;
      if (ctx.twitchClient && _cid && p.message) try {
        await ctx.twitchClient.postAnnouncement(_cid, _cid, p.message, p.color || 'PRIMARY');
      } catch(e){ console.warn('[Flow] announcement:', e.message); }
      break;
    }
    case 'twitch_clip': {
      const _cid = state.twitch.channelId;
      if (ctx.twitchClient && _cid) try {
        await ctx.twitchClient.createClip(_cid);
      } catch(e){ console.warn('[Flow] clip:', e.message); }
      break;
    }
    case 'twitch_channel_title': {
      const _cid = state.twitch.channelId;
      if (ctx.twitchClient && _cid && p.title) try {
        // The same {placeholders} as the auto-title, so a flow can say "{team1} vs {team2}".
        const _t = /\{\w+\}/.test(p.title) ? matchTitle.buildTitle(p.title, currentMatchFields(), matchTitle.TWITCH_TITLE_MAX) : p.title;
        await ctx.twitchClient.updateChannel(_cid, { title: _t });
      } catch(e){ console.warn('[Flow] channel title:', e.message); }
      break;
    }
    case 'twitch_create_poll': {
      const _cid = state.twitch.channelId;
      if (ctx.twitchClient && _cid && p.title) try {
        const choices = [p.choice1 || 'Yes', p.choice2 || 'No'];
        await ctx.twitchClient.createPoll(_cid, p.title, choices, Number(p.duration) || 60);
      } catch(e){ console.warn('[Flow] poll create:', e.message); }
      break;
    }
    case 'twitch_shoutout': {
      const _cid = state.twitch.channelId;
      if (ctx.twitchClient && _cid && p.toLogin) try {
        const toUser = await ctx.twitchClient.getUserByLogin(p.toLogin);
        if (toUser) await ctx.twitchClient.sendShoutout(_cid, toUser.id, _cid);
      } catch(e){ console.warn('[Flow] shoutout:', e.message); }
      break;
    }
    case 'obs_start_stream':
      if (ctx.obsClient && ctx.obsClient.isConnected()) try { await ctx.obsClient.call('StartStream'); } catch(e){}
      break;
    case 'obs_stop_stream':
      if (ctx.obsClient && ctx.obsClient.isConnected()) try { await ctx.obsClient.call('StopStream'); } catch(e){}
      break;
    case 'obs_start_record':
      if (ctx.obsClient && ctx.obsClient.isConnected()) try { await ctx.obsClient.call('StartRecord'); } catch(e){}
      break;
    case 'obs_stop_record':
      if (ctx.obsClient && ctx.obsClient.isConnected()) try { await ctx.obsClient.call('StopRecord'); } catch(e){}
      break;
    case 'obs_start_replay_buf':
      if (ctx.obsClient) try {
        const ok = await ctx.obsClient.startReplayBuffer();
        if (syncReplayBufferAvailability()) broadcastFullState();
        // A flow has no requesting socket — tell every panel (a bare `ws` here was a ReferenceError
        // the catch swallowed, so a failed start was silent).
        if (!ok) {
          const message = replayBufferErrorMessage('Could not start the Replay Buffer.');
          logAuto('flow', message);
          broadcast(ctx.bridgeClients, { type: 'obs-result', data: { toast: true, ok: false, message } });
        }
      } catch(e){}
      break;
    case 'obs_stop_replay_buf':
      if (ctx.obsClient) try { await ctx.obsClient.stopReplayBuffer(); } catch(e){}
      break;
    case 'obs_stream_marker': {
      const _cid = state.twitch.channelId;
      if (ctx.twitchClient && _cid) try {
        await ctx.twitchClient.createStreamMarker(_cid, p.description || '');
      } catch(e){ console.warn('[Flow] stream marker:', e.message); }
      break;
    }
    case 'overlay_sponsor_show':
      state.sponsorBanner = { ...(state.sponsorBanner||{}), visible: true };
      broadcastFullState();
      break;
    case 'overlay_sponsor_hide':
      state.sponsorBanner = { ...(state.sponsorBanner||{}), visible: false };
      broadcastFullState();
      break;
    case 'match_set_series_score':
      if (p.blue != null) state.series.blue = Number(p.blue) || 0;
      if (p.orange != null) state.series.orange = Number(p.orange) || 0;
      broadcastFullState();
      break;
    case 'http_webhook': {
      if (!p.url) break;
      // Ads must NEVER auto-play: refuse to let a flow loop back into our own ad endpoint,
      // and tag every flow-originated request so the ad route can reject it server-side too.
      if (/\/api\/twitch\/ad\//i.test(p.url)) {
        console.warn('[Flow] webhook blocked — flows may not trigger ad breaks:', p.url);
        break;
      }
      let body = {};
      try { body = p.body ? JSON.parse(p.body) : {}; } catch(e){}
      try { await axios.post(p.url, body, { timeout: 5000, headers: { 'X-NE-Flow': '1' } }); }
      catch(e) { console.warn('[Flow] webhook failed:', e.message); }
      break;
    }
    case 'obs_source_show':
      if (ctx.obsClient && ctx.obsClient.isConnected() && p.scene && p.source)
        await ctx.obsClient.setSceneItemEnabled(p.scene.trim(), p.source.trim(), true).catch(() => {});
      break;
    case 'obs_source_hide':
      if (ctx.obsClient && ctx.obsClient.isConnected() && p.scene && p.source)
        await ctx.obsClient.setSceneItemEnabled(p.scene.trim(), p.source.trim(), false).catch(() => {});
      break;
    case 'obs_input_mute':
      if (ctx.obsClient && ctx.obsClient.isConnected() && p.inputName)
        await ctx.obsClient.setInputMute(p.inputName.trim(), true).catch(() => {});
      break;
    case 'obs_input_unmute':
      if (ctx.obsClient && ctx.obsClient.isConnected() && p.inputName)
        await ctx.obsClient.setInputMute(p.inputName.trim(), false).catch(() => {});
      break;
    case 'obs_set_volume': {
      if (ctx.obsClient && ctx.obsClient.isConnected() && p.inputName) {
        const db = parseFloat(p.volumeDb);
        if (!isNaN(db)) await ctx.obsClient.setInputVolume(p.inputName.trim(), Math.max(-100, Math.min(26, db))).catch(() => {});
      }
      break;
    }
    case 'obs_filter_enable':
      if (ctx.obsClient && ctx.obsClient.isConnected() && p.sourceName && p.filterName)
        await ctx.obsClient.setSourceFilterEnabled(p.sourceName.trim(), p.filterName.trim(), true).catch(() => {});
      break;
    case 'obs_filter_disable':
      if (ctx.obsClient && ctx.obsClient.isConnected() && p.sourceName && p.filterName)
        await ctx.obsClient.setSourceFilterEnabled(p.sourceName.trim(), p.filterName.trim(), false).catch(() => {});
      break;
    case 'obs_set_transition':
      if (ctx.obsClient && ctx.obsClient.isConnected()) {
        try {
          if (p.transitionName) await ctx.obsClient.call('SetCurrentSceneTransition', { transitionName: p.transitionName });
          if (p.durationMs != null) await ctx.obsClient.call('SetCurrentSceneTransitionDuration', { transitionDuration: Number(p.durationMs) || 300 });
        } catch(e) { console.warn('[Flow] set transition:', e.message); }
      }
      break;
    case 'match_set_score':
      if (p.team === 'blue')   { state.game.blueScore   = Math.max(0, Number(p.value) || 0); broadcastFullState(); }
      if (p.team === 'orange') { state.game.orangeScore = Math.max(0, Number(p.value) || 0); broadcastFullState(); }
      break;
    case 'run_flow': {
      const target = p.flowId && (state.flows || []).find(f => f.id === p.flowId && f.enabled);
      if (target) {
        for (const a of (target.actions || [])) {
          if (Number(a.delay) > 0) await new Promise(r => setTimeout(r, Number(a.delay)));
          try { await _executeFlowAction(a, ctx); } catch(e) { console.error('[Flow] run_flow sub-action:', e.message); }
        }
      }
      break;
    }
    case 'stop_flow':
      throw new _StopFlow();
    case 'set_variable': {
      if (p.name) {
        if (!state.flowVars) state.flowVars = {};
        state.flowVars[p.name] = p.value ?? '';
        broadcastFullState();
      }
      break;
    }
    case 'increment_variable': {
      if (p.name) {
        if (!state.flowVars) state.flowVars = {};
        const cur = Number(state.flowVars[p.name]) || 0;
        state.flowVars[p.name] = String(cur + (Number(rawP.amount) || 1));
        broadcastFullState();
      }
      break;
    }
    case 'reset_variable': {
      if (!state.flowVars) state.flowVars = {};
      if (p.name) delete state.flowVars[p.name];
      else state.flowVars = {};
      broadcastFullState();
      break;
    }
    case 'twitch_send_chat': {
      if (p.message && ctx.chatManager && ctx.chatManager.isConnected) {
        ctx.chatManager.sendMessage(p.message);
      }
      break;
    }
    case 'send_discord_webhook': {
      if (!rawP.url) break;
      const embed = {};
      if (p.title)   embed.title       = p.title;
      if (p.message) embed.description = p.message;
      if (p.color)   embed.color       = parseInt(p.color.replace('#', ''), 16) || 0;
      const body = { embeds: [embed] };
      if (p.content) body.content = p.content;
      try { await axios.post(rawP.url, body, { timeout: 5000 }); }
      catch(e) { console.warn('[Flow] discord webhook:', e.message); }
      break;
    }
    case 'cycle_variable': {
      if (p.name && p.list) {
        if (!state.flowVars) state.flowVars = {};
        const items = rawP.list.split(',').map(s => s.trim()).filter(Boolean);
        if (!items.length) break;
        const cur = state.flowVars[p.name];
        const idx = items.indexOf(String(cur));
        state.flowVars[p.name] = items[(idx + 1) % items.length];
        broadcastFullState();
      }
      break;
    }
    case 'random_choice': {
      const ids = (rawP.flowIds || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!ids.length) break;
      const picked = ids[Math.floor(Math.random() * ids.length)];
      const target = (state.flows || []).find(f => f.id === picked && f.enabled);
      if (target) {
        for (const a of (target.actions || [])) {
          if (Number(a.delay) > 0) await new Promise(r => setTimeout(r, Number(a.delay)));
          try { await _executeFlowAction(a, ctx); } catch(e) { console.error('[Flow] random_choice:', e.message); }
        }
      }
      break;
    }
    case 'obs_playback_start':
      if (ctx.obsClient && ctx.obsClient.isConnected() && p.inputName) {
        try { await ctx.obsClient.call('TriggerMediaInputAction', { inputName: p.inputName.trim(), mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' }); } catch(e){}
      }
      break;
    case 'obs_playback_stop':
      if (ctx.obsClient && ctx.obsClient.isConnected() && p.inputName) {
        try { await ctx.obsClient.call('TriggerMediaInputAction', { inputName: p.inputName.trim(), mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }); } catch(e){}
      }
      break;
    case 'obs_playback_pause':
      if (ctx.obsClient && ctx.obsClient.isConnected() && p.inputName) {
        try { await ctx.obsClient.call('TriggerMediaInputAction', { inputName: p.inputName.trim(), mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE' }); } catch(e){}
      }
      break;
  }
}


  return { flowBus, _flowFireLog, initFlowEngine, _executeFlowAction, armSceneDwellFlows, _onObsVolumeMeters, _syncFlowIntervals, _flowSeqState, _evalCondition, _substituteTokens };
};
