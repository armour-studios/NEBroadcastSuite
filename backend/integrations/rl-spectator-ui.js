/**
 * Hide Rocket League's native spectator UI by sending key presses to the game window.
 * Default: press H twice (same as many observers' "hh" bind) after focusing Rocket League.
 */

const { spawn } = require('child_process');

const DEFAULTS = {
  enabled: true,
  autoOnMatch: true,
  key: 'h',
  presses: 2,
  gapMs: 250,
  focusWindow: true,
  focusDelayMs: 500,
  matchDelayMs: 1500,   // delay after joining spectate before the single hide press (tunable in the UI)
  hotkey: 'F9'
};

// Auto-hide state, reset when the observer joins spectate on a fresh lobby (resetAutoTracking).
// The key is a TOGGLE, so we press it AT MOST ONCE per spectate-join — no retries: each blind press
// risks flipping the UI the wrong way, and if one press doesn't land the producer can hide it by
// hand. _done = we've pressed (or a manual hide landed) this game; _pending = scheduled/in-flight.
let _done = false;
let _pending = false;

function mergeConfig(cfg) {
  return { ...DEFAULTS, ...(cfg || {}) };
}

function buildScript(cfg) {
  // Virtual-key code: for a single letter/digit, VK_* equals the uppercase ASCII code (VK_A=0x41
  // ... VK_Z=0x5A, VK_0=0x30 ... VK_9=0x39), so no lookup table is needed for the realistic case
  // (a single bound key like "h"). Falls back to 'H' for anything else configured.
  const rawKey = String(cfg.key || 'h').trim().charAt(0).toUpperCase();
  const vk = /^[A-Z0-9]$/.test(rawKey) ? rawKey.charCodeAt(0) : 'H'.charCodeAt(0);
  const presses = Math.max(1, Number(cfg.presses) || 2);
  const gap = Math.max(50, Number(cfg.gapMs) || 250);
  const focusDelay = Math.max(0, Number(cfg.focusDelayMs) || 500);

  // Only steal focus when Rocket League ISN'T already the foreground window — and never
  // ShowWindow(SW_RESTORE), which forces a fullscreen re-acquire and freezes the game for
  // a beat. When the observer already has RL focused (the common case, incl. the in-game
  // F9 hotkey) this block is a no-op, so there's no hitch at all.
  //
  // $result tracks what actually happened (found/focused) so the caller can tell the difference
  // between "worked" and "silently did nothing".
  const focusBlock = cfg.focusWindow ? `
$proc = Get-Process -Name 'RocketLeague' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($proc) {
  $result.found = $true
  if ($proc.MainWindowHandle -ne 0) {
    if ([RLNative]::GetForegroundWindow() -eq $proc.MainWindowHandle) {
      $result.focused = $true
    } else {
      $result.focused = [bool]([RLNative]::SetForegroundWindow($proc.MainWindowHandle))
      if ($result.focused) { Start-Sleep -Milliseconds ${focusDelay} }
    }
  }
}
` : '$result.focused = $true';   // focus-check disabled — trust the caller already has RL focused

  // Raw keybd_event down/up pairs — NOT System.Windows.Forms.SendKeys. SendKeys synchronizes
  // through a hidden-window message pump that only exists in an interactive WinForms/WPF app;
  // called back-to-back from a non-interactive PowerShell host (no message loop of its own) it
  // silently dropped the 2nd of 2 rapid presses, so only one of the two taps ever reached the
  // game — exactly the "only pressed once" symptom reported. keybd_event has no such dependency.
  const KEYEVENTF_KEYUP = 2;
  const sendLines = Array.from({ length: presses }, (_, i) => {
    const wait = i > 0 ? `Start-Sleep -Milliseconds ${gap}\n` : '';
    return `${wait}[RLNative]::keybd_event(${vk}, 0, 0, [UIntPtr]::Zero)\nStart-Sleep -Milliseconds 40\n[RLNative]::keybd_event(${vk}, 0, ${KEYEVENTF_KEYUP}, [UIntPtr]::Zero)`;
  }).join('\n');

  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RLNative {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
$result = @{ found = $false; focused = $false; sent = $false }
${focusBlock}
if ($result.found -and $result.focused) {
${sendLines}
  $result.sent = $true
}
$result | ConvertTo-Json -Compress
`.trim();
}

function runHideNativeUi(cfg) {
  if (process.platform !== 'win32') {
    console.warn('[RL UI] Key simulation only supported on Windows');
    return Promise.resolve({ ok: false, reason: 'windows_only' });
  }

  const merged = mergeConfig(cfg);
  const script = buildScript(merged);

  return new Promise((resolve) => {
    const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let out = '';
    ps.stdout.on('data', (d) => { out += d; });
    ps.on('error', (err) => resolve({ ok: false, reason: err.message }));
    ps.on('close', (code) => {
      if (code !== 0) { resolve({ ok: false, reason: `exit_${code}` }); return; }
      let parsed = null;
      try { parsed = JSON.parse(out.trim()); } catch (_) { /* fall through to no_result below */ }
      if (!parsed) { resolve({ ok: false, reason: 'Could not read the result — try again.' }); return; }
      if (!parsed.found) { resolve({ ok: false, reason: "Rocket League isn't running — nothing to hide." }); return; }
      if (!parsed.focused) { resolve({ ok: false, reason: 'Could not bring Rocket League to the foreground — check that neither app is running as Administrator while the other isn\'t (Windows blocks focus-stealing across that boundary), then try the manual hotkey.' }); return; }
      if (!parsed.sent) { resolve({ ok: false, reason: 'Failed to send the keystroke.' }); return; }
      resolve({ ok: true, key: merged.key, presses: merged.presses });
    });
  });
}

// Called once when the observer joins spectate (players appear in the lobby). The key is a TOGGLE,
// so a KEYSTROKE is sent at most once per game — but a failed attempt (RL not found / couldn't be
// brought to the foreground, e.g. the producer is tabbed into the control panel or OBS at join)
// sends NO keystroke, so retrying it is safe. Keep retrying every RETRY_MS until the press actually
// lands, the producer hides manually (markHidden), or a new game resets tracking (_gen kills stale
// retry loops after resetAutoTracking).
const RETRY_MS = 3000;
const MAX_ATTEMPTS = 60;   // ≈3 minutes, then give up — the manual button / hotkey remains
let _gen = 0;

function scheduleAutoHide(gameNumber, cfg, onResult) {
  const merged = mergeConfig(cfg);
  if (!merged.enabled || !merged.autoOnMatch) {
    console.log('[RL UI] Auto-hide skipped — ' + (!merged.enabled ? 'hide is disabled' : '"Auto on new game" is off') + ' in Settings.');
    return false;
  }
  if (_done || _pending) {
    console.log('[RL UI] Auto-hide skipped — already ' + (_pending ? 'scheduled' : 'pressed') + ' this game.');
    return false;
  }

  _pending = true;
  const myGen = _gen;
  const delay = Math.max(500, Number(merged.matchDelayMs) || 2800);
  let attempts = 0;
  console.log('[RL UI] Auto-hide scheduled — pressing "' + merged.key + '" x' + merged.presses + ' in ' + delay + 'ms.');
  const attempt = () => {
    // Never press when the UI is already believed hidden (manual hide landed → markHidden), and
    // die silently if a new game reset tracking while we were waiting.
    if (myGen !== _gen) return;
    if (_done) { _pending = false; return; }
    attempts++;
    runHideNativeUi(merged).then((result) => {
      if (myGen !== _gen) return;
      if (_done) { _pending = false; return; }
      if (result.ok) {
        _pending = false;
        _done = true;   // keystroke went out — the toggle must not fire again this game
        console.log('[RL UI] Auto-hide press sent (attempt ' + attempts + ').');
        if (typeof onResult === 'function') onResult(result);
        return;
      }
      // No keystroke was sent (RL missing / not focusable) — safe to try again.
      if (attempts < MAX_ATTEMPTS) {
        console.log('[RL UI] Auto-hide attempt ' + attempts + ' failed (' + (result.reason || 'unknown') + ') — retrying in ' + (RETRY_MS / 1000) + 's.');
        setTimeout(attempt, RETRY_MS);
      } else {
        _pending = false;
        _done = true;
        console.log('[RL UI] Auto-hide gave up after ' + attempts + ' attempts (' + (result.reason || 'unknown') + ').');
        if (typeof onResult === 'function') onResult(result);
      }
    });
  };
  setTimeout(attempt, delay);
  return true;
}

// The manual hide (app button / in-game hotkey routed through the app) landed — record that the UI is
// hidden so the auto path won't fire the toggle again and flip it back on.
function markHidden() {
  _done = true;
  _pending = false;
}

function resetAutoTracking() {
  _done = false;
  _pending = false;
  _gen++;   // invalidate any in-flight retry loop from the previous game
}

module.exports = {
  DEFAULTS,
  mergeConfig,
  runHideNativeUi,
  scheduleAutoHide,
  resetAutoTracking,
  markHidden
};