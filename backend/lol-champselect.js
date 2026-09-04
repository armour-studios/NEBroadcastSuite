/* ─── League of Legends champ-select automation (LCU) ─────────────────────────
 *
 * Reads the live tournament draft straight from the League Client so the pick/ban
 * board fills itself — no manual entry. Same local-API pattern as the Valorant
 * (2999) and CS2 (GSI) integrations: it talks to the League Client Update (LCU)
 * API on 127.0.0.1 using the running client's port + auth token.
 *
 * Requirement: the League client must be RUNNING and IN champ select on THIS
 * machine (the observer / tournament-admin client that's in the draft lobby).
 *
 * Credentials come from the client's `lockfile` (common install paths) and, as a
 * fallback, from the running process command line (`--app-port` / `--remoting-auth-token`).
 *
 * Emits a normalised view of the draft: the completed ban/pick actions IN ORDER
 * (champion names), which server.js feeds to draftAction() one-by-one. Because our
 * draft sequence (backend/draft.js LOL) matches the standard tournament order, the
 * Nth completed action lands on the Nth slot of the board automatically.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const LOCKFILE_CANDIDATES = [
  'C:/Riot Games/League of Legends/lockfile',
  'D:/Riot Games/League of Legends/lockfile',
  'C:/Program Files/Riot Games/League of Legends/lockfile',
  'C:/Program Files (x86)/Riot Games/League of Legends/lockfile',
  (process.env.LOCALAPPDATA || '') + '/Riot Games/League of Legends/lockfile'
];

function parseLockfile(p) {
  try {
    const txt = fs.readFileSync(p, 'utf8');               // "LeagueClient:PID:PORT:PASSWORD:https"
    const parts = txt.trim().split(':');
    if (parts.length >= 5 && parts[2] && parts[3]) return { port: parts[2], password: parts[3], source: 'lockfile' };
  } catch (e) {}
  return null;
}

// Fallback: pull --app-port and --remoting-auth-token from the running LeagueClientUx process.
function credsFromProcess() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const ps = "Get-CimInstance Win32_Process -Filter \"name='LeagueClientUx.exe'\" | Select-Object -ExpandProperty CommandLine";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 6000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const port = (stdout.match(/--app-port=(\d+)/) || [])[1];
      const token = (stdout.match(/--remoting-auth-token=([\w-]+)/) || [])[1];
      resolve(port && token ? { port, password: token, source: 'process' } : null);
    });
  });
}

async function findCreds(customLockfilePath) {
  for (const p of [customLockfilePath, ...LOCKFILE_CANDIDATES].filter(Boolean)) {
    const c = parseLockfile(p);
    if (c) return c;
  }
  return await credsFromProcess();
}

function lcuGet(creds, apiPath) {
  return new Promise((resolve, reject) => {
    const auth = 'Basic ' + Buffer.from('riot:' + creds.password).toString('base64');
    const req = https.request({ host: '127.0.0.1', port: Number(creds.port), path: apiPath, method: 'GET',
      rejectUnauthorized: false, headers: { Authorization: auth, Accept: 'application/json' }, timeout: 4000 }, (res) => {
      let b = ''; res.on('data', (d) => b += d); res.on('end', () => {
        if (res.statusCode === 200) { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('parse error')); } }
        else if (res.statusCode === 404) resolve(null);   // 404 = not in champ select right now
        else reject(new Error('HTTP ' + res.statusCode));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// Champion id → display name, from the client's own game data (no external network).
async function loadChampionNames(creds) {
  const map = {};
  try {
    const list = await lcuGet(creds, '/lol-game-data/assets/v1/champion-summary.json');
    (list || []).forEach((c) => { if (c && c.id > 0 && c.name) map[c.id] = c.name; });
  } catch (e) {}
  return map;
}

// Session → { phase, done:[{type,name,isAlly}], current:{type,isAlly}|null }
function normalizeSession(session, nameById) {
  if (!session) return { phase: 'none', done: [], current: null };
  const flat = [];
  (session.actions || []).forEach((phase) => (phase || []).forEach((a) => {
    if (a && (a.type === 'ban' || a.type === 'pick')) flat.push(a);
  }));
  const done = flat.filter((a) => a.completed && a.championId > 0)
    .map((a) => ({ type: a.type, name: nameById[a.championId] || ('Champion ' + a.championId), isAlly: !!a.isAllyAction }));
  const cur = flat.find((a) => a.isInProgress) || flat.find((a) => !a.completed);
  return {
    phase: session.timer ? (session.timer.phase || 'BAN_PICK') : 'BAN_PICK',
    done,
    current: cur ? { type: cur.type, isAlly: !!cur.isAllyAction } : null
  };
}

// ── Poller ───────────────────────────────────────────────────────────────────
// start({ getLockfilePath, onUpdate, onStatus, intervalMs }) → stop()
function startPoller(opts) {
  const { getLockfilePath, onUpdate, onStatus } = opts || {};
  const intervalMs = (opts && opts.intervalMs) || 1500;
  let creds = null, nameById = {}, timer = null, stopped = false, lastStatus = '';

  const setStatus = (status, detail) => { if (status !== lastStatus) { lastStatus = status; try { onStatus && onStatus(status, detail || ''); } catch (e) {} } };

  async function tick() {
    if (stopped) return;
    try {
      if (!creds) {
        creds = await findCreds(getLockfilePath ? getLockfilePath() : '');
        if (!creds) { setStatus('no-client', 'League client not detected'); return; }
        nameById = await loadChampionNames(creds);
        setStatus('connected', 'Client found (' + creds.source + ')');
      }
      const session = await lcuGet(creds, '/lol-champ-select/v1/session');
      if (!session) { setStatus('idle', 'Connected — waiting for champ select'); try { onUpdate && onUpdate(null); } catch (e) {} return; }
      const norm = normalizeSession(session, nameById);
      setStatus('drafting', norm.done.length + ' locked');
      try { onUpdate && onUpdate(norm); } catch (e) {}
    } catch (e) {
      // A dead port/token (client restarted) → re-detect next tick.
      creds = null;
      setStatus('error', e.message || 'LCU error');
    }
  }

  timer = setInterval(tick, intervalMs);
  tick().catch((e) => console.warn('[lol-champselect: poll failed]', (e && e.message) || e));
  return function stop() { stopped = true; if (timer) clearInterval(timer); timer = null; };
}

module.exports = { startPoller, findCreds, lcuGet, normalizeSession, loadChampionNames };
