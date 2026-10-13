// backend/cs2-setup.js — one-click CS2 setup.
//
// findCfgDir(): where CS2 is installed, read from Steam itself (no typing paths):
//   1. Steam's install folder: registry HKCU\Software\Valve\Steam SteamPath, else the usual folders.
//   2. Every Steam library listed in steamapps/libraryfolders.vdf.
//   3. The first library holding steamapps/common/Counter-Strike Global Offensive/game/csgo/cfg.
// launchUrl(): a steam:// link that starts CS2 with the console port the app talks to
//   (-netconport), so nobody has to edit launch options. Steam asks once to confirm the arguments.
//
// Nothing here edits Steam's own settings files or the producer's autoexec.cfg.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CS2_DIR = path.join('steamapps', 'common', 'Counter-Strike Global Offensive');
const CFG_SUB = path.join('game', 'csgo', 'cfg');

// libraryfolders.vdf: "path"  "D:\\SteamLibrary" entries (backslashes doubled).
function parseLibraryFolders(text) {
  const out = [];
  const re = /"path"\s+"([^"]+)"/gi;
  let m;
  while ((m = re.exec(String(text || '')))) out.push(m[1].replace(/\\\\/g, '\\'));
  return out;
}

function regSteamPath() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve('');
    execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      if (err) return resolve('');
      const m = /SteamPath\s+REG_SZ\s+(.+)/i.exec(String(stdout || ''));
      resolve(m ? m[1].trim().replace(/\//g, '\\') : '');
    });
  });
}

async function steamRoots() {
  const roots = [];
  const reg = await regSteamPath();
  if (reg) roots.push(reg);
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  roots.push(path.join(pf86, 'Steam'), path.join(pf, 'Steam'));
  if (process.platform !== 'win32' && process.env.HOME) roots.push(path.join(process.env.HOME, '.steam', 'steam'), path.join(process.env.HOME, '.local', 'share', 'Steam'));
  return [...new Set(roots)].filter((r) => { try { return fs.existsSync(r); } catch (_) { return false; } });
}

// Resolves { cfgDir, steamRoot, libraries[] } or { cfgDir: '' } when CS2 isn't found.
async function findCfgDir() {
  const roots = await steamRoots();
  const libs = [];
  for (const r of roots) {
    libs.push(r);
    try { parseLibraryFolders(fs.readFileSync(path.join(r, 'steamapps', 'libraryfolders.vdf'), 'utf8')).forEach((l) => libs.push(l)); } catch (_) { /* no vdf */ }
  }
  const uniq = [...new Set(libs.map((l) => path.normalize(l)))];
  for (const lib of uniq) {
    const dir = path.join(lib, CS2_DIR, CFG_SUB);
    try { if (fs.existsSync(dir)) return { cfgDir: dir, steamRoot: roots[0] || '', libraries: uniq }; } catch (_) {}
  }
  return { cfgDir: '', steamRoot: roots[0] || '', libraries: uniq };
}

// Accept the cfg folder, the CS2 install folder, or a Steam library folder.
function resolveCfgDir(input) {
  const dir = String(input || '').trim().replace(/^"|"$/g, '');
  if (!dir) return '';
  const tries = [dir, path.join(dir, CFG_SUB), path.join(dir, CS2_DIR, CFG_SUB)];
  for (const t of tries) {
    try { if (/[\\/]cfg[\\/]?$/i.test(t) && fs.existsSync(t)) return t; } catch (_) {}
  }
  return '';
}

// steam.exe in the Steam folder (Windows), or ''.
function steamExe(steamRoot) {
  const p = steamRoot ? path.join(steamRoot, process.platform === 'win32' ? 'steam.exe' : 'steam') : '';
  try { return p && fs.existsSync(p) ? p : ''; } catch (_) { return ''; }
}

// Is CS2 already running? Steam will not restart it with new options while it is open.
function isCs2Running() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false);
    execFile('tasklist', ['/FI', 'IMAGENAME eq cs2.exe', '/NH'], { windowsHide: true, timeout: 4000 }, (err, out) => resolve(!err && /cs2\.exe/i.test(String(out || ''))));
  });
}

// Close CS2 (the producer confirmed it in the panel) and wait up to 20s for it to exit.
function closeCs2() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false);
    execFile('taskkill', ['/IM', 'cs2.exe'], { windowsHide: true, timeout: 5000 }, () => {
      const t0 = Date.now();
      const poll = async () => {
        if (!(await isCs2Running())) return resolve(true);
        if (Date.now() - t0 > 8000) execFile('taskkill', ['/F', '/IM', 'cs2.exe'], { windowsHide: true, timeout: 5000 }, () => {});
        if (Date.now() - t0 > 20000) return resolve(false);
        setTimeout(poll, 700);
      };
      setTimeout(poll, 700);
    });
  });
}

// Start CS2 with the console port. `steam.exe -applaunch 730 <options>` is Steam's documented way
// to pass launch options for one run (a steam://run link dropped them on the producer's PC).
// Resolves { ok, how, message }.
async function launch(port) {
  const p = Number(port) > 0 && Number(port) < 65536 ? Number(port) : 2121;
  if (await isCs2Running()) return { ok: false, running: true, message: 'CS2 is already open. Close it, then press Launch CS2 for observing again (Steam only adds the console port when it starts the game).' };
  const roots = await steamRoots();
  const exe = roots.map(steamExe).find(Boolean);
  if (exe) {
    try {
      const { spawn } = require('child_process');
      // +exec cs2-spectator: the clean observer view (no CS2 HUD, radar or crosshair; F9 flips it
      // back) from the moment the game loads. It needs no console link, which current CS2 builds do
      // not open even with -netconport (seen 2026-10-09: launched with it, port never listened).
      const child = spawn(exe, ['-applaunch', '730', '-netconport', String(p), '+exec', 'cs2-spectator'], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return { ok: true, how: 'steam.exe', message: 'Starting CS2 for observing: its own HUD, radar and crosshair stay hidden (F9 in game brings them back).' };
    } catch (e) { /* fall through to the link */ }
  }
  return { ok: true, how: 'url', url: launchUrl(p), message: 'Starting CS2 through Steam. If Steam asks about launch options, press OK.' };
}

function launchUrl(port) {
  const p = Number(port) > 0 && Number(port) < 65536 ? Number(port) : 2121;
  return 'steam://run/730//' + encodeURIComponent('-netconport ' + p + ' +exec cs2-spectator') + '/';
}

// GSI tells us whether the client is spectating: allplayers only arrives while observing (or on
// GOTV). A playing client gets its own player block only.
function isSpectating(payload) {
  const all = payload && payload.allplayers;
  return !!(all && typeof all === 'object' && Object.keys(all).length > 1);
}

module.exports = { parseLibraryFolders, steamRoots, findCfgDir, resolveCfgDir, launchUrl, launch, isCs2Running, closeCs2, steamExe, isSpectating, CS2_DIR, CFG_SUB };
