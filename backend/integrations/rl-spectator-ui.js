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
  const key = String(cfg.key || 'h').replace(/[+^%~(){}[\]]/g, '{$&}');
  const presses = Math.max(1, Number(cfg.presses) || 2);
  const gap = Math.max(50, Number(cfg.gapMs) || 250);
  const focusDelay = Math.max(0, Number(cfg.focusDelayMs) || 500);

  const focusBlock = cfg.focusWindow ? `
$proc = Get-Process -Name 'RocketLeague' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($proc -and $proc.MainWindowHandle -ne 0) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RLFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
  [RLFocus]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null
  [RLFocus]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds ${focusDelay}
}
` : '';

  const sendLines = Array.from({ length: presses }, (_, i) => {
    const wait = i > 0 ? `Start-Sleep -Milliseconds ${gap}\n` : '';
    return `${wait}[System.Windows.Forms.SendKeys]::SendWait('${key}')`;
  }).join('\n');

  return `
Add-Type -AssemblyName System.Windows.Forms
${focusBlock}
${sendLines}
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
      stdio: 'ignore'
    });
    ps.on('error', (err) => resolve({ ok: false, reason: err.message }));
    ps.on('close', (code) => {
      if (code === 0) resolve({ ok: true, key: merged.key, presses: merged.presses });
      else resolve({ ok: false, reason: `exit_${code}` });
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