/**
 * Opt-in auto-switch bridge — sends spectator hotkeys to the focused game window on this PC.
 * Windows: PowerShell SendKeys. Producer must opt in; keep the spectator client focused.
 *
 * CS2: observer slot keys 1–0 map to player slots. (Rocket League camera automation was removed.)
 */

const { spawn } = require('child_process');

const COOLDOWN_MS = 3500;
const SLOT_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

let lastSwitchAt = 0;
let enabled = false;
let lastTargetKey = '';

function setEnabled(val) {
  enabled = !!val;
}

function isEnabled() {
  return enabled;
}

function sendKey(key) {
  if (process.platform !== 'win32') {
    console.warn('[AutoSwitch] Key simulation only supported on Windows (this PC)');
    return false;
  }
  const escaped = key.replace(/[+^%~(){}[\]]/g, '{$&}');
  const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`;
  spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    windowsHide: true,
    stdio: 'ignore'
  });
  return true;
}

function resolveCs2Key(target, csgoState) {
  if (!target || !csgoState?.players) return null;
  const id = target.id;
  const player = csgoState.players.find((p) => p.steamid === id || p.name === target.name);
  if (!player || player.slot == null) return null;
  const slot = Number(player.slot);
  if (slot >= 0 && slot <= 9) return SLOT_KEYS[slot] || String(slot + 1);
  return null;
}

function trySwitch({ gameId, primary, gameState }) {
  if (!enabled || !primary?.target) return { ok: false, reason: 'disabled' };

  const now = Date.now();
  if (now - lastSwitchAt < COOLDOWN_MS) return { ok: false, reason: 'cooldown' };

  const tKey = `${primary.target.kind}:${primary.target.id}`;
  if (tKey === lastTargetKey) return { ok: false, reason: 'same_target' };

  let key = null;
  if (gameId === 'csgo') {
    key = resolveCs2Key(primary.target, gameState);
    if (!key) return { ok: false, reason: 'no_slot_mapping' };
  } else {
    return { ok: false, reason: 'no_feed_adapter' };
  }

  const sent = sendKey(key);
  if (sent) {
    lastSwitchAt = now;
    lastTargetKey = tKey;
    return { ok: true, key, target: primary.name };
  }
  return { ok: false, reason: 'send_failed' };
}

function reset() {
  lastTargetKey = '';
}

module.exports = { setEnabled, isEnabled, trySwitch, reset, sendKey };