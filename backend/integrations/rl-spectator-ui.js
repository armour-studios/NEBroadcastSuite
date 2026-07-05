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
  matchDelayMs: 2800,
  hotkey: 'F9'
};

let lastAutoGameNumber = null;

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

function scheduleAutoHide(gameNumber, cfg, onResult) {
  const merged = mergeConfig(cfg);
  if (!merged.enabled || !merged.autoOnMatch) return false;
  if (gameNumber != null && lastAutoGameNumber === gameNumber) return false;

  const delay = Math.max(500, Number(merged.matchDelayMs) || 2800);
  setTimeout(() => {
    runHideNativeUi(merged).then((result) => {
      if (result.ok && gameNumber != null) lastAutoGameNumber = gameNumber;
      if (typeof onResult === 'function') onResult(result);
    });
  }, delay);

  if (gameNumber != null) lastAutoGameNumber = gameNumber;
  return true;
}

function resetAutoTracking() {
  lastAutoGameNumber = null;
}

module.exports = {
  DEFAULTS,
  mergeConfig,
  runHideNativeUi,
  scheduleAutoHide,
  resetAutoTracking
};