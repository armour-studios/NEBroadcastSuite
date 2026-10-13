require('dotenv').config({ path: (() => { const p = require('path'), f = require('fs'); const dev = p.join(__dirname, '.env.local'); return f.existsSync(dev) ? dev : p.join(__dirname, '.env.production'); })() });
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
// Twitch calls made straight from this file (token refresh/validate, stream/channel/ads poll,
// EventSub subscribe) had no deadline: a hung request stalled its loop for good. Any twitch.tv call
// without its own timeout gets 15s. Other hosts are untouched (downloads can legitimately be long).
axios.interceptors.request.use((cfg) => {
  if (!cfg.timeout && /^https:\/\/(api|id)\.twitch\.tv\//.test(String(cfg.url || ''))) cfg.timeout = 15000;
  return cfg;
});
const https = require('https');
const FormData = require('form-data');
const fsp = require('fs/promises');
const os = require('os');
const AdmZip = require('adm-zip');
// Electron, wherever the server runs: in the main process or its own utility process (backend/electron-api.js).
const electronApi = require('./backend/electron-api');
const { dialog, app: _electronApp, powerMonitor } = electronApi;
const { EventEmitter } = require('events');
const IS_DEV = () => _electronApp && !_electronApp.isPackaged;
const { createStartGgClient } = require('./backend/integrations/startgg-client');
const { createChallongeClient } = require('./backend/integrations/challonge-client');
const { resolveGameId } = require('./backend/game-match');
const matchTitle = require('./backend/match-title');
const obsPlace = require('./backend/obs-overlay-place');
const vmixPlace = require('./backend/vmix-place');
const lanSeats = require('./backend/lan-seats');   // LAN seat cameras: permanent per-seat links, players assigned per match
const GAME_CONFIG_VERSION_CAP = 20;   // saved custom-content versions kept per game
const { frameJson } = require('./backend/rl-framing');
const { obsPreviewRedirect } = require('./backend/obs-preview-guard');
const { isAllowedOrigin, originGuardMiddleware } = require('./backend/origin-guard');
const { createChallengermodeClient, parseChallengermodeId } = (() => {
  const m = require('./backend/integrations/challengermode-client');
  return { createChallengermodeClient: m.createChallengermodeClient, parseChallengermodeId: m.parseTournamentId };
})();
const cmData = require('./backend/challengermode');   // Challengermode GraphQL queries + mapping (NOT Challonge)   // platform game name -> GAMES id (makes every platform multi-game)
const { createBrawlhalla, BH_REGIONS } = require('./backend/brawlhalla');   // Brawlhalla career-stats API (no live feed — see the module header)
const { createBallchasingClient } = require('./backend/integrations/ballchasing-client');
const { createBallchasingWatcher } = require('./backend/integrations/ballchasing-watcher');
const { scanAndRenameReplays } = require('./backend/integrations/replay-renamer');
const { getNxgenEvents, getNxgenEventLive, getNxgenLeaderboard } = require('./backend/nxgen');
const faceit = require('./backend/integrations/faceit-client');
const { createDirectorEngine } = require('./backend/director');
const promosData = require('./backend/promos');
const cs2Setup = require('./backend/cs2-setup');
const siteHomeData = require('./backend/site-home');
const customOverlays = require('./backend/custom-overlays');
const cloud = require('./backend/cloud/cloud-client');   // Nameless cloud (dormant until BROADCAST_REMOTE_URL set)
const { createClipSystem } = require('./backend/clips');
const { createTelemetryRecorder } = require('./backend/telemetry/recorder');   // AI training-data capture (Phase 0, local JSONL)
const { createTelemetryUploader } = require('./backend/telemetry/uploader');   // AI training-data cloud upload (Phase 2, opt-in)
const autoSwitch = require('./backend/director/auto-switch');
const { createNetcon } = require('./backend/cs2-netcon');
const { createCinematic } = require('./backend/cs2-cinematic');
const rlSpectatorUi = require('./backend/integrations/rl-spectator-ui');
const sheets = require('./backend/sheets');   // Google Sheets two-way integration (service-account auth)
const { createOverlayEditor } = require('./backend/scenes/overlay-editor');
const { createYouTubeChat } = require('./backend/youtube-chat');   // multichat source #2 (rides the Social YouTube OAuth)
const { createKickChat } = require('./backend/kick-chat');         // multichat source #3 (public Kick Pusher ws)
const { createDiscordChat, fetchChannelMessages: fetchDiscordMessages } = require('./backend/discord-chat');   // multichat source #4 (Discord bot gateway)
const questionStore = require('./backend/questions');             // Q&A mailbag store (sources, dedupe, keyword capture)
const vetoData = require('./backend/veto');
const vetoImport = require('./backend/veto-import');   // FACEIT / HLTV veto link import
const draftData = require('./backend/draft');
const gameConfigData = require('./backend/game-config');
const vmix = require('./backend/vmix');   // vMix HTTP control — the full alternative to OBS (docs/vmix-integration.md)
const lolChampSelect = require('./backend/lol-champselect');
const lolLive = require('./backend/lol-live');
const lolOcr = require('./backend/lol-ocr');
const apexLive = require('./backend/apex-live');   // Apex LiveAPI ingestion (game connects to our WS server)
const stats = require('./backend/db/stats');
const analytics = require('./backend/analytics');
const startggImport = require('./backend/startgg-import');
const twitchStats = require('./backend/twitch-stats');
const playerDb   = require('./backend/player-db');
const teamDb     = require('./backend/team-db');
const competition = require('./backend/competition');           // league data interchange (docs/competition-api.md)
const competitionSources = require('./backend/competition-sources');   // Google Sheet / JSON feed pull sources

const { generateSceneCollection } = require('./obs/build-scene-collection');

// OBS integration is optional — never let a missing/broken package crash the app.
let createObsClient = null;
try {
  ({ createObsClient } = require('./backend/integrations/obs-client'));
} catch (e) {
  console.warn('[OBS] Integration unavailable:', e.message);
}
let createSlobsClient = null;
try {
  ({ createSlobsClient } = require('./backend/integrations/slobs-client'));
} catch (e) {
  console.warn('[Streamlabs] Integration unavailable:', e.message);
}
let obsClient = null;
let obsPassword = '';
let slobsToken = '';   // Streamlabs Desktop > Settings > Remote Control API token
// Video file of the OBS stinger transition the REPLAYS page last inspected (obs_transition_info).
// Served by /api/obs/transition-stinger so the replay player can run the same sting between clips.
let obsStingerFile = '';
// Map a replay URL back to the file on disk. TWO shapes reach us and only one used to be handled:
//   /api/clips/file?path=<abs>   — staging files and already-prepared transcodes
//   /data/clips/<name>           — IMPORTED LIBRARY CLIPS, served straight off the static /data mount
// Because only the first form was recognised, no library clip ever went through prepareForAir: a
// clip the browser source can't decode (OBS records HEVC/MKV by default) was pushed to air raw and
// played as a black frame, while the transition around it worked fine.
function replayUrlToPath(rawUrl) {
  const m = /^(.*?)\/api\/clips\/file\?(?:.*&)?path=([^&]+)/.exec(rawUrl);
  if (m) { try { return { origin: m[1], file: decodeURIComponent(m[2]), kind: 'api' }; } catch (e) { return null; } }
  // Exports (/data/clips/exports/…) are already normal encodes — the [^/?#]+ keeps them out.
  const s = /^(.*?)\/data\/clips\/([^/?#]+)(?:[?#].*)?$/.exec(rawUrl);
  if (s && clipSystem) {
    try {
      const f = path.join(clipSystem.manager.getClipsDir(), decodeURIComponent(s[2]));
      return fs.existsSync(f) ? { origin: s[1], file: f, kind: 'static' } : null;
    } catch (e) { return null; }
  }
  return null;
}
// Will this URL be transcoded before air? Staging pushes (the /api/clips/file route) always were —
// that's the existing B-frame/High-Profile lag fix and it stays. Library clips served off /data are
// only prepared when the browser genuinely can't decode them, so a normal instant replay still goes
// to air immediately instead of waiting on ffmpeg.
async function willAirPrep(resolved) {
  if (!resolved || !clipSystem) return false;
  if (resolved.kind === 'api') return true;
  try { return await needsAirPrep(resolved.file); } catch (e) { return false; }
}
// Does this file need transcoding before a browser source can show it? Containers/codecs Chromium
// decodes natively go to air untouched (an instant replay shouldn't wait on ffmpeg); anything else
// — HEVC, MKV, MOV/ProRes, MPEG-2 … — is prepared first. Cached per file identity, so the probe
// runs once per clip.
const _airPrepNeed = new Map();
async function needsAirPrep(file) {
  let key;
  try { const st = fs.statSync(file); key = file + ':' + st.mtimeMs + ':' + st.size; }
  catch (e) { return false; }
  if (_airPrepNeed.has(key)) return _airPrepNeed.get(key);
  let need;
  const ext = path.extname(file).toLowerCase();
  if (!['.mp4', '.m4v', '.webm'].includes(ext)) {
    need = true;
  } else {
    const info = await probeVideoInfo(file);
    // Unknown codec (probe failed) → leave it alone rather than transcoding every clip on a machine
    // without ffprobe; the common case is already-fine H.264.
    need = info.codec ? !['h264', 'avc1', 'vp8', 'vp9', 'av1'].includes(info.codec) : false;
  }
  _airPrepNeed.set(key, need);
  return need;
}
// Resolve the URL a browser source should actually play: the original when it's already decodable,
// otherwise the cached baseline-H.264 transcode. Never rejects — air always gets something.
async function airPlayableUrl(rawUrl) {
  const r = replayUrlToPath(rawUrl);
  if (!r || !clipSystem) return rawUrl;
  try {
    if (!(await willAirPrep(r))) return rawUrl;
    // The transcode has no deadline of its own; a hung ffmpeg left the replay (and its OBS cut)
    // pending forever. After 2 minutes air gets the original file rather than nothing.
    let to;
    const prepared = await Promise.race([
      clipSystem.prepareForAir(r.file),
      new Promise((res) => { to = setTimeout(() => { console.warn('[Replay] air-prep transcode still running after 120s; playing the original file'); res(null); }, 120000); }),
    ]).finally(() => clearTimeout(to));
    if (!prepared || prepared === r.file) return rawUrl;
    return `${r.origin}/api/clips/file?path=${encodeURIComponent(prepared)}`;
  } catch (e) { return rawUrl; }
}

// Duration (ms) + frame rate of a video via ffprobe; zeroes if it can't be read. Best-effort and
// time-boxed — used for stinger files, whose containers often omit the duration the browser would
// otherwise rely on, and whose fps converts a frames-based OBS transition point into milliseconds.
function probeVideoInfo(file) {
  return new Promise((resolve) => {
    let ff = 'ffmpeg';
    try { ff = (clipSystem && clipSystem.encoder && clipSystem.encoder.ffmpegPath && clipSystem.encoder.ffmpegPath()) || 'ffmpeg'; } catch (e) {}
    const ffprobe = (ff !== 'ffmpeg') ? ff.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1') : 'ffprobe';
    let out = '', done = false;
    const finish = () => {
      if (done) return;
      done = true;
      // Lines: codec_name ("hevc"), avg_frame_rate ("30000/1001"), duration in seconds ("1.234").
      const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const rate = lines.find((l) => l.includes('/')) || '';
      const [n, d] = rate.split('/').map(Number);
      const fps = (n && d) ? (n / d) : 0;
      const secs = lines.filter((l) => !l.includes('/')).map(parseFloat).find((v) => !isNaN(v) && v > 0) || 0;
      const codec = lines.find((l) => !l.includes('/') && isNaN(parseFloat(l))) || '';
      resolve({ durationMs: Math.round(secs * 1000), fps, codec: codec.toLowerCase() });
    };
    try {
      const { spawn } = require('child_process');
      const p = spawn(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,avg_frame_rate', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', file], { windowsHide: true });
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.on('close', finish);
      p.on('error', finish);
      setTimeout(() => { try { p.kill(); } catch (e) {} finish(); }, 4000);
    } catch (e) { finish(); }
  });
}

// Twitch integration
const { registerTwitchWebhooks } = require('./backend/integrations/twitch-webhooks');
const { TwitchClient } = require('./backend/integrations/twitch-client');
const { SocialPublisher } = require('./backend/social-publisher');
const liquipedia         = require('./backend/integrations/liquipedia-client');
const riot               = require('./backend/integrations/riot-client');
const valGep             = require('./backend/integrations/valorant-gep');
const { PredictionManager } = require('./backend/integrations/twitch-predictions');
const { WheelManager } = require('./backend/integrations/twitch-wheel');
const { MiniGameManager } = require('./backend/integrations/twitch-minigames');
const { ChatParser } = require('./backend/integrations/twitch-chat-parser');
const { MarbleRaceManager } = require('./backend/integrations/marble-race');
const { fetchTwitchChatters } = require('./backend/twitch-chatters');
let twitchDataFile = '';
let discordDataFile = '';
let twitchClient = null;
// Match titles (VOD naming): bumped by finalizeAndResetSeries so a recording keeps the series it
// started on; the label snapshot follows edits only while that series is still on. Declared up here
// because finalizeAndResetSeries can run during boot, long before the match-titles block below.
let _seriesEpoch = 0;
let _recLabel = null;   // { epoch, fields, startedAt }
let socialPublisher = null;
let youtubeChat = null;   // YouTube Live Chat poller (multichat source #2)
let kickChat = null;      // Kick Pusher chat (multichat source #3)
let discordChat = null;   // Discord bot gateway chat (multichat source #4)
let multichatDataFile = '';   // persisted config: kick channel, discord channel + bot token (encrypted)
let questionsDataFile = '';   // persisted Q&A mailbag: queued questions + capture settings
let predictionManager = null;
let wheelManager = null;
let _predPollTimer = null;
let miniGameManager = null;
let chatParser = null;
let gameTimers = new Map(); // gameId -> timeout
let marbleRaceManager = null;   // cross-platform (Twitch+Kick+YouTube) 3D obstacle-course chat game — see backend/integrations/marble-race.js
// "!play" entry — no arguments, just adds the chatter as a participant. Module-level (not nested
// inside the chat-connector setup) since TwitchChatManager is a top-level class (handleChatMessage
// below) that needs to reach this too, alongside the Kick/YouTube onMessage closures — a single
// shared implementation so all three platforms parse identically.
function tryEnterMarbleRace(platform, userId, username, message) {
  const mr = state.marbleRace;
  if (!marbleRaceManager || !mr || mr.status !== 'entry') return;
  if (String(message || '').trim().toLowerCase() !== '!play') return;
  const added = marbleRaceManager.enterParticipant({ platform, userId, username, source: 'chat' });
  if (added) broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
}

// NE_HTTP_PORT / NE_WS_PORT: a second, isolated server for end-to-end tests (scripts/e2e-server.js)
// while the producer's own app keeps 3000 / 3001. Production never sets them.
const HTTP_PORT = Number(process.env.NE_HTTP_PORT) || 3000;
// LAN address of this machine, resolved once at boot. The control panel runs from file://, where
// location.hostname is '' — so it cannot work this out for itself, and any "point your server here"
// hint it renders would always say localhost (useless from another host). Computed here instead.
const lanHost = (() => {
  try {
    const ifaces = require('os').networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const ni of (ifaces[name] || [])) {
        if (ni && ni.family === 'IPv4' && !ni.internal && ni.address) return ni.address;
      }
    }
  } catch (_) { /* fall through */ }
  return 'localhost';
})();
const WS_PORT = Number(process.env.NE_WS_PORT) || 3001;
const RL_STATS_PORT = 49123;
const RL_RECONNECT_INTERVAL = 3000;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || 't4vpvwcxaxk4vil453fmf3kuahbs5e';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_REDIRECT_URI = 'http://localhost:3000/api/oauth/discord/callback';
const BROADCAST_REMOTE_URL = process.env.BROADCAST_REMOTE_URL || 'https://www.namelessesports.com';
const BROADCAST_API_KEY    = process.env.BROADCAST_API_KEY    || '';

let httpServer = null;
let httpServer6 = null;   // IPv6 loopback twin of httpServer (see the listen block in start())
let bridgeWss = null;
let bridgeHttp6 = null;   // IPv6 loopback twin of the WS bridge (see startBridgeServer)
let _bridgeHeartbeat = null;

// Stats tracking — match/game IDs for the current broadcast session
let statsCurrentMatchId = null;
let statsCurrentGameId  = null;  // RL
let statsCs2GameId      = null;  // CS2
let statsValGameId      = null;  // Valorant

let appDir = __dirname;
let dataDir;
// Show timeline (backend/show-timeline.js): what happened, in order, for diagnosing a stuck scene or
// wrong data after the fact. tl() is safe to call anywhere, before or after start().
const showTimeline = require('./backend/show-timeline').createShowTimeline();
function tl(kind, data) { try { showTimeline.record(kind, data); } catch (e) {} }
let teamsFile;
let stateFile;
let facecamsFile;
let presetsFile;
let brandsFile;
let wsTokenFile;
let wsAuthToken = '';   // shared secret required on every WS bridge connection — see getOrCreateWsToken()
let startggApiToken = '';
let challongeApiKey = '';
// Challengermode (challengermode.com) — a DIFFERENT platform from Challonge. This is the long-lived
// REFRESH key from their Application Dashboard; the short-lived bot token it buys lives inside the
// client and is never persisted.
let challengermodeRefreshKey = '';
let nxgenApiKey = '';
let faceitApiKey = '';        // FACEIT Data API server-side key (encrypted at rest, never broadcast)
let ballchasingApiKey = '';
let riotApiKey = '';         // Riot Games developer/production key — the PRODUCER's own, from
                             // developer.riotgames.com. Encrypted at rest, never broadcast.
                             // NOTE: a DEVELOPMENT key expires every 24h; riot-client says so on 403.
let liquipediaApiKey = '';   // Liquipedia LPDB key — the PRODUCER's own. Access is not self-service and
                             // the free tier is non-commercial, so the licensing relationship is
                             // theirs, not the suite's. Encrypted at rest, never broadcast.
let bedwarsToken = '';        // Bedwars plugin shared secret (X-Suite-Token); never broadcast
let sheetsServiceAccount = '';   // Google service-account JSON key (encrypted at rest, never broadcast)
let competitionApiKey = '';      // /api/v1 write key (encrypted at rest, never broadcast — handed to the panel on request)
let competitionFeedTokens = {};   // leagueId -> bearer token for that league's JSON feed (encrypted at rest, never broadcast)
let _startggImportRunning = false;   // guards the historical start.gg importer
let _twitchStatsCache = null;        // { at, data } — short cache for GET /api/twitch/stats
let _twitchTokenInvalid = false;     // true once Twitch returns 401 → stop retry storms until reconnect

let appVersion = '0.0.0';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  appVersion = pkg.version;
} catch (e) { console.error('Error reading package.json version:', e); }

// ─── Games & overlay designs (themes) ────────────────────────────────────────
// Each game has its own overlay route and a set of selectable designs (themes).
// format: match shape so UI/overlays stop hard-assuming blue/orange (see PRODUCTION.md).
//   'duo' = 2 teams + score (RL), 'team5' = 2 teams of 5 + rounds (CS2/LoL/Val),
//   'ffa'/'bracket' = entrants (Smash), '1v1' = head-to-head.
// teamLabels: what the two sides are called in this game.
// logo = path under /assets (served to overlays as `/assets/<logo>`, to the control
// panel as `../assets/<logo>`). rosterSize doubles as the per-team camera count.
// features = capability flags a game-specific UI can branch on. overlay '' = uses the
// generic production scenes (countdown/winner/veto/intro/casters) — no dedicated HUD yet.
// Per-game overlay layouts (browser source URLs) — not colour themes.
const OVERLAY_LAYOUTS = {
  'rocket-league': [
    // 'classic' (overlay/index.html at "/") was retired 2026-10: the React HUD handles every message
    // and state field it did (its break screen lives on as countdown.html). Saved 'classic' picks are
    // aliased to the React HUD below, and "/" redirects to /rl-hud.html so old OBS sources still work.
    { id: 'lexogrine', name: 'React HUD', path: '/rl-hud.html' },
    { id: 'player',    name: 'Player HUD (in-game)', path: '/rl-player.html' },
    { id: 'worlds',    name: 'Worlds HUD', path: '/rl-worlds.html' }
  ],
  'csgo': [
    { id: 'cs2-hud', name: 'CS2 HUD', path: '/csgo.html' },
    { id: 'cs2-pro', name: 'CS2 Pro HUD', path: '/cs2-pro.html' }
  ],
  'overwatch': [
    { id: 'ow-scoreboard', name: 'Overwatch Overlay', path: '/overwatch.html' }
  ],
  'valorant': [
    { id: 'valorant-hud', name: 'Valorant HUD', path: '/valorant.html' }
  ],
  'league': [
    { id: 'lol-hud', name: 'LoL In-Game HUD', path: '/lol-hud.html' }
  ],
  // These four MUST be listed here even though GAMES[].overlay names the same file:
  // resolveOverlayLayout() returns themes[0] when no theme matches, and gameThemes() falls back to
  // GENERIC_OVERLAY_LAYOUTS (path ''), so the `|| g.overlay` branch at the end of that function is
  // unreachable. Without an entry here a game's real overlay can never be selected.
  'marvel-rivals': [
    { id: 'mr-scoreboard', name: 'Marvel Rivals Overlay', path: '/marvel-rivals.html' }
  ],
  'apex': [
    { id: 'apex-hud',      name: 'Apex BR HUD',      path: '/apex.html' },
    { id: 'apex-observer', name: 'Apex Observer HUD', path: '/apex-observer.html' },
    { id: 'br-leaderboard', name: 'BR Series Leaderboard', path: '/br-leaderboard.html' },
    { id: 'br-rail',        name: 'BR Standings Rail',     path: '/br-rail.html' },
    { id: 'br-match',       name: 'BR Match Result',       path: '/br-match.html' }
  ],
  // Fortnite has no third-party live match feed, so its series is scored from a Google Sheet or the
  // manual grid (see state.br) — the br-* scenes render whatever the scoring engine derived.
  'fortnite': [
    { id: 'fncs-board',     name: 'FNCS Standings Board',  path: '/br-leaderboard.html?skin=fncs' },
    { id: 'br-leaderboard', name: 'BR Series Leaderboard', path: '/br-leaderboard.html' },
    { id: 'br-rail',        name: 'BR Standings Rail',     path: '/br-rail.html' },
    { id: 'br-match',       name: 'BR Match Result',       path: '/br-match.html' },
    { id: 'fn-dropmap',     name: 'Drop Map',              path: '/fn-dropmap.html' },
    { id: 'fn-compare',     name: 'Comparison Card',       path: '/fn-compare.html' },
    { id: 'fn-victory',     name: 'Victory Royale',        path: '/fn-victory.html' },
    { id: 'points-board',   name: 'Points / Placement Board', path: '/standings.html' },
    // Ballistic (5v5) and Creative 1v1 are head-to-head Fortnite — the normal scoreboard is the
    // right instrument for those, so it stays selectable even though the game is a BR game.
    { id: 'head-to-head',   name: 'Head-to-Head Scoreboard',  path: '/duorow.html' }
  ],
  'bedwars': [
    { id: 'head-to-head', name: 'Head-to-Head with cameras', path: '/duorow.html' },
    { id: 'points-board', name: 'Points / Placement Board', path: '/standings.html' }
  ],
  // Rainbow Six has no live-data HUD (no GSI equivalent wired), but everything else about it is
  // already supported — map pool + STD7 veto format in backend/veto.js, roles, league stat set. It
  // just needed selectable layouts like every other game; without an entry here it fell through to
  // GENERIC_OVERLAY_LAYOUTS and had no overlay at all. Map veto is pushed from Graphics, not here.
  // The first layout is what the one-click "NE Scoreboard" source (live.html) shows in game, so it
  // must leave the gameplay visible: the transparent scorebar (overlay/scorebar.html). duorow.html is
  // a full-screen head-to-head scene with two camera boxes, for between games. Rainbow Six's own
  // round clock and score sit top centre, so its bar defaults to the bottom edge.
  'rainbow6': [ { id: 'scorebar-bottom', name: 'In-game scorebar (bottom)', path: '/scorebar.html?pos=bottom' }, { id: 'scorebar', name: 'In-game scorebar (top)', path: '/scorebar.html' }, { id: 'head-to-head', name: 'Head-to-Head with cameras', path: '/duorow.html' }, { id: 'points-board', name: 'Standings / Points Board', path: '/standings.html' } ],
  // Dota 2: the live HUD (Valve's Game State Integration, backend/dota-gsi.js).
  'dota2': [ { id: 'dota2-hud', name: 'Dota 2 HUD (live)', path: '/dota2-hud.html' }, { id: 'dota2-board', name: 'Dota 2 scoreboard (all players)', path: '/dota2-hud.html?board=1' }, { id: 'scorebar-split', name: 'Corner team plates', path: '/scorebar.html?pos=split' }, { id: 'head-to-head', name: 'Head-to-Head with cameras', path: '/duorow.html' }, { id: 'points-board', name: 'Standings / Points Board', path: '/standings.html' } ],
  'cod': [ { id: 'scorebar', name: 'In-game scorebar (top)', path: '/scorebar.html' }, { id: 'scorebar-bottom', name: 'In-game scorebar (bottom)', path: '/scorebar.html?pos=bottom' }, { id: 'head-to-head', name: 'Head-to-Head with cameras', path: '/duorow.html' }, { id: 'points-board', name: 'Standings / Points Board', path: '/standings.html' } ],
  'eafc': [ { id: 'scorebar', name: 'In-game scorebar (top)', path: '/scorebar.html' }, { id: 'scorebar-bottom', name: 'In-game scorebar (bottom)', path: '/scorebar.html?pos=bottom' }, { id: 'head-to-head', name: 'Head-to-Head with cameras', path: '/duorow.html' }, { id: 'points-board', name: 'Standings / Points Board', path: '/standings.html' } ],
  // MOBAs: the game's own score and clock are top centre, so the default is two corner plates.
  'mobile-legends': [ { id: 'scorebar-split', name: 'Corner team plates', path: '/scorebar.html?pos=split' }, { id: 'scorebar', name: 'In-game scorebar (top)', path: '/scorebar.html' }, { id: 'head-to-head', name: 'Head-to-Head with cameras', path: '/duorow.html' }, { id: 'points-board', name: 'Standings / Points Board', path: '/standings.html' } ],
  'honor-of-kings': [ { id: 'scorebar-split', name: 'Corner team plates', path: '/scorebar.html?pos=split' }, { id: 'scorebar', name: 'In-game scorebar (top)', path: '/scorebar.html' }, { id: 'head-to-head', name: 'Head-to-Head with cameras', path: '/duorow.html' }, { id: 'points-board', name: 'Standings / Points Board', path: '/standings.html' } ],
  // Fighting games — ported FGCasterOverlay scoreboards (overlay/fgc/<skin>). Each skin is a
  // standalone lower-third fed by fgc-adapter.js from the same match/teams/casters state.
  'tekken8':   [
    { id: 'fgc-tekken8-blue', name: 'Tekken 8 Scoreboard (Blue)', path: '/fgc/tekken8-blue/template.html' },
    { id: 'fgc-tekken8-red',  name: 'Tekken 8 Scoreboard (Red)',  path: '/fgc/tekken8-red/template.html' },
    { id: 'fgc-default',      name: 'Generic FGC Scoreboard',      path: '/fgc/default/template.html' }
  ],
  'sf6':       [
    { id: 'fgc-sf6',      name: 'Street Fighter 6 Scoreboard', path: '/fgc/sf6/template.html' },
    { id: 'fgc-default',  name: 'Generic FGC Scoreboard',      path: '/fgc/default/template.html' }
  ],
  'ggstrive':  [
    { id: 'fgc-ggstrive', name: 'Guilty Gear Strive Scoreboard', path: '/fgc/ggstrive/template.html' },
    { id: 'fgc-default',  name: 'Generic FGC Scoreboard',        path: '/fgc/default/template.html' }
  ],
  '2xko':      [
    { id: 'fgc-2xko',     name: '2XKO Scoreboard (tag)', path: '/fgc/2xko/template.html' },
    { id: 'fgc-default',  name: 'Generic FGC Scoreboard', path: '/fgc/default/template.html' }
  ],
  // Marvel Tokon — its own board, shaped around the game's top HUD (overlay/tokon.html); the
  // generic FGC scoreboards stay available.
  'marvel-tokon': [
    { id: 'tokon-hud',       name: 'Marvel Tokon Scoreboard', path: '/tokon.html' },
    { id: 'fgc-default',     name: 'Generic FGC Scoreboard',  path: '/fgc/default/template.html' },
    { id: 'fgc-default-img', name: 'FGC Scoreboard (image)',  path: '/fgc/default-img/template.html' }
  ],
  // THE FINALS — no live data source; head-to-head for 2-team formats, points board for Cashout lobbies.
  'the-finals': [
    { id: 'finals-bar',   name: 'THE FINALS Broadcast Bar', path: '/the-finals.html' },
    { id: 'head-to-head', name: 'Head-to-Head Scoreboard',  path: '/duorow.html' },
    { id: 'points-board', name: 'Standings / Points Board', path: '/standings.html' }
  ],
  // Brawlhalla — 1v1 and 2v2 platform fighter. Stocks/legends are producer-driven (the game has
  // no live feed); the ranked card on the board comes from the official stats API.
  'brawlhalla': [
    { id: 'brawlhalla-hud',  name: 'Brawlhalla Scoreboard',  path: '/brawlhalla.html' },
    { id: 'points-board',    name: 'Top 8 Placement Board',  path: '/standings.html' },
    { id: 'fgc-default',     name: 'FGC Scoreboard',         path: '/fgc/default/template.html' }
  ],
  'smash':     [
    { id: 'smash-hud',       name: 'Smash Scoreboard',       path: '/smash.html' },
    { id: 'smash-team',      name: 'Smash Team Scoreboard',  path: '/smash-team.html' },
    // Same overlay as every other game's standings board — it renders the top-8 PLACEMENT CARDS
    // (character art per finisher) for Smash. See state.standings.layout.
    { id: 'points-board',    name: 'Top 8 Placement Board',  path: '/standings.html' },
    { id: 'fgc-default',     name: 'FGC Scoreboard',         path: '/fgc/default/template.html' },
    { id: 'fgc-default-img', name: 'FGC Scoreboard (image)', path: '/fgc/default-img/template.html' }
  ]
};
const GENERIC_OVERLAY_LAYOUTS = [
  { id: 'production', name: 'Production browser sources', path: '' }
];

const GAMES = {
  'rocket-league': { id: 'rocket-league', name: 'Rocket League', overlay: '/rl-hud.html', format: 'duo',   teamLabels: { a: 'Blue', b: 'Orange' },           rosterSize: 3, logo: 'games/rocketleague.svg',  features: ['boost', 'stats-api', 'director'],   themes: [], statLabel: 'Goals',  statAbbr: 'G' },
  'csgo':          { id: 'csgo',          name: 'CS2 / CS:GO',   overlay: '/csgo.html', format: 'team5', teamLabels: { a: 'CT', b: 'T' },                  rosterSize: 5, logo: 'games/cs2.svg',           features: ['gsi', 'radar', 'vetoes', 'director'], themes: [], statLabel: 'Rounds', statAbbr: 'R' },
  'valorant':      { id: 'valorant',      name: 'Valorant',      overlay: '',           format: 'team5', teamLabels: { a: 'Attackers', b: 'Defenders' },   rosterSize: 5, logo: 'games/valorant.svg',      features: ['vetoes', 'agents', 'director'],     themes: [], statLabel: 'Rounds', statAbbr: 'R' },
  'league':        { id: 'league',        name: 'League of Legends', overlay: '/lol-hud.html', format: 'team5', teamLabels: { a: 'Blue', b: 'Red' },         rosterSize: 5, logo: 'games/lol.svg',           features: ['draft', 'live-data', 'director'],    themes: [] },
  'dota2':         { id: 'dota2',         name: 'Dota 2',        overlay: '/dota2-hud.html', format: 'team5', teamLabels: { a: 'Radiant', b: 'Dire' },     rosterSize: 5, logo: 'games/dota2.svg',         features: ['draft', 'gsi'],                themes: [] },
  'overwatch':     { id: 'overwatch',     name: 'Overwatch 2',   overlay: '/overwatch.html', format: 'team5', teamLabels: { a: 'Defenders', b: 'Attackers' }, rosterSize: 5, logo: 'games/overwatch2.png',    features: ['heroes', 'vetoes', 'draft'], themes: [] },
  'rainbow6':      { id: 'rainbow6',      name: 'Rainbow Six Siege', overlay: '',       format: 'team5', teamLabels: { a: 'Attack', b: 'Defense' },        rosterSize: 5, logo: 'games/rainbow6.svg',      features: ['vetoes', 'operators'],  themes: [] },
  'cod':           { id: 'cod',           name: 'Call of Duty',  overlay: '',           format: 'team4', teamLabels: { a: 'Team A', b: 'Team B' },         rosterSize: 4, logo: 'games/cod.png',           features: ['vetoes'],               themes: [] },
  'apex':          { id: 'apex',          name: 'Apex Legends',  overlay: '/apex.html',  format: 'ffa',   teamLabels: { a: 'Team A', b: 'Team B' },         rosterSize: 3, logo: 'games/apex.svg',          features: ['battle-royale', 'legends', 'liveapi'], themes: [] },
  'fortnite':      { id: 'fortnite',      name: 'Fortnite',      overlay: '/br-leaderboard.html', format: 'ffa',   teamLabels: { a: 'Team A', b: 'Team B' },         rosterSize: 4, logo: 'games/fortnite.png',      features: ['battle-royale'],        themes: [] },
  // Minecraft Bedwars — multi-team lobby game run as a points series (no live data source; scored
  // manually or fed from a Sheet). rosterSize 4 = the common competitive 4s format; change here if
  // an organiser runs doubles/8s. statLabel is per-game beds broken.
  'bedwars':       { id: 'bedwars',       name: 'Minecraft Bedwars', overlay: '',       format: 'ffa',   teamLabels: { a: 'Team A', b: 'Team B' },         rosterSize: 4, logo: 'games/bedwars.png',       features: ['bracket'],              themes: [], statLabel: 'Beds', statAbbr: 'B' },
  'marvel-rivals': { id: 'marvel-rivals', name: 'Marvel Rivals', overlay: '/marvel-rivals.html', format: 'team6', teamLabels: { a: 'Team A', b: 'Team B' }, rosterSize: 6, logo: 'games/rivals.png',        features: ['heroes', 'draft'],       themes: [] },
  'smash':         { id: 'smash',         name: 'Super Smash Bros.', overlay: '/smash.html', format: '1v1',   teamLabels: { a: 'Player 1', b: 'Player 2' },     rosterSize: 1, logo: 'games/ssb.png',           features: ['bracket', 'stocks', 'fgc'], themes: [] },
  // Brawlhalla — free-to-play platform fighter. 1v1 and 2v2 are both competitive formats, so
  // rosterSize is 2 (the doubles pair); the board lays itself out from state.brawlhalla.mode.
  // 'stats-api' = the official career-stats API (rank/tier/ELO/legends), NOT a live match feed —
  // stocks and the legend on screen are producer-driven, exactly like Smash.
  'brawlhalla':    { id: 'brawlhalla',    name: 'Brawlhalla',    overlay: '/brawlhalla.html', format: '1v1', teamLabels: { a: 'Player 1', b: 'Player 2' }, rosterSize: 2, logo: 'games/brawlhalla.png', features: ['bracket', 'stocks', 'fgc', 'legends', 'stats-api'], themes: [], statLabel: 'Stocks', statAbbr: 'S' },
  // Fighting games (FGC) — 1v1 head-to-head; sides are the two players. 2XKO is a 2v2 tag game
  // (two characters/players per side). Overlays live under overlay/fgc/ (see OVERLAY_LAYOUTS).
  'tekken8':       { id: 'tekken8',       name: 'Tekken 8',      overlay: '/fgc/tekken8-blue/template.html', format: '1v1', teamLabels: { a: 'Player 1', b: 'Player 2' }, rosterSize: 1, logo: 'games/tekken8.svg',  features: ['bracket', 'fgc'], themes: [] },
  'sf6':           { id: 'sf6',           name: 'Street Fighter 6', overlay: '/fgc/sf6/template.html',        format: '1v1', teamLabels: { a: 'Player 1', b: 'Player 2' }, rosterSize: 1, logo: 'games/sf6.svg',      features: ['bracket', 'fgc'], themes: [] },
  'ggstrive':      { id: 'ggstrive',      name: 'Guilty Gear Strive', overlay: '/fgc/ggstrive/template.html',  format: '1v1', teamLabels: { a: 'Player 1', b: 'Player 2' }, rosterSize: 1, logo: 'games/ggstrive.svg', features: ['bracket', 'fgc'], themes: [] },
  '2xko':          { id: '2xko',          name: '2XKO',          overlay: '/fgc/2xko/template.html',          format: '1v1', teamLabels: { a: 'Player 1', b: 'Player 2' }, rosterSize: 2, logo: 'games/2xko.svg',     features: ['bracket', 'fgc', 'tag'], themes: [] },
  // Marvel Tokon: Fighting Souls — 4v4 tag fighter, but competitive is one player per side.
  'marvel-tokon':  { id: 'marvel-tokon',  name: 'Marvel Tokon',  overlay: '/tokon.html',                      format: '1v1', teamLabels: { a: 'Player 1', b: 'Player 2' }, rosterSize: 1, logo: 'games/marveltokon.svg', features: ['bracket', 'fgc', 'tag'], themes: [] },
  'the-finals':    { id: 'the-finals',    name: 'The Finals',    overlay: '/the-finals.html', format: 'team3', teamLabels: { a: 'Team A', b: 'Team B' },   rosterSize: 3, logo: 'games/thefinals.svg',     features: ['observer'],                     themes: [] },
  'eafc':          { id: 'eafc',          name: 'EA Sports FC',  overlay: '',           format: '1v1',   teamLabels: { a: 'Home', b: 'Away' },             rosterSize: 1, logo: 'games/eafc.svg',          features: [],                       themes: [] },
  'mobile-legends':{ id: 'mobile-legends',name: 'Mobile Legends', overlay: '',          format: 'team5', teamLabels: { a: 'Blue', b: 'Red' },              rosterSize: 5, logo: 'games/mobilelegends.svg', features: ['draft'],                themes: [] },
  'honor-of-kings':{ id: 'honor-of-kings',name: 'Honor of Kings', overlay: '',          format: 'team5', teamLabels: { a: 'Blue', b: 'Red' },              rosterSize: 5, logo: 'games/honorofkings.svg',  features: ['draft'],                themes: [] }
};

Object.keys(GAMES).forEach((id) => {
  GAMES[id].themes = OVERLAY_LAYOUTS[id] || GENERIC_OVERLAY_LAYOUTS;
});

// ─── Battle-royale "lobby" model (Fortnite-first) ────────────────────────────
// A BR broadcast is not two teams with a score. It is ONE lobby of N entrants racing a points
// table over M matches, and the producer's job is roster + placements + who to spectate. The
// blue-vs-orange Match — Teams panel is the wrong instrument for that, so games listed here swap
// it for the lobby board (control-panel/br-lobby.js). Every game NOT in this list keeps the two
// team cards exactly as before — that is the whole point of gating it on a list instead of on
// `format: 'ffa'` (bedwars is ffa too, and its head-to-head cards still work for it).
// To give another game the lobby panel, add its id here and nothing else.
const BR_LOBBY_GAMES = ['fortnite'];
function isLobbyGame(gameId) { return BR_LOBBY_GAMES.includes(gameId); }
BR_LOBBY_GAMES.forEach((id) => {
  if (GAMES[id] && !GAMES[id].features.includes('lobby')) GAMES[id].features.push('lobby');
});

// Fortnite ships several genuinely different competitive products, and they do NOT share a
// scoreboard shape: BR/Zero Build/Reload/OG are points-per-placement lobbies, Ballistic is a
// 5v5 round-based head-to-head, Creative is whatever the island's rules say. `kind` is what the
// rest of the app switches on — 'lobby' games get the lobby panel and the br-* overlays,
// 'versus' games fall back to the normal two-team cards even though the game is Fortnite.
//   players  — default lobby size, shown as the field cap in the panel
//   respawn  — reboot/respawn mode: an entrant eliminated mid-match can come back, so "teams
//              alive" is not monotonic and the panel must not auto-eliminate on a death report.
const BR_GAME_MODES = {
  fortnite: [
    { id: 'br-build',      name: 'Battle Royale (Build)', kind: 'lobby',  players: 100, respawn: false, short: 'BR' },
    { id: 'br-zerobuild',  name: 'Zero Build',            kind: 'lobby',  players: 100, respawn: false, short: 'ZB' },
    { id: 'reload',        name: 'Reload',                kind: 'lobby',  players: 40,  respawn: true,  short: 'RLD' },
    { id: 'reload-zb',     name: 'Reload (Zero Build)',   kind: 'lobby',  players: 40,  respawn: true,  short: 'RLD ZB' },
    { id: 'og',            name: 'OG',                    kind: 'lobby',  players: 100, respawn: false, short: 'OG' },
    { id: 'ballistic',     name: 'Ballistic (5v5)',       kind: 'versus', players: 10,  respawn: true,  short: 'BAL' },
    { id: 'creative',      name: 'Creative / UEFN',       kind: 'lobby',  players: 16,  respawn: true,  short: 'UEFN' },
    { id: 'creative-1v1',  name: 'Creative Head-to-Head', kind: 'versus', players: 2,   respawn: true,  short: '1v1' }
  ],
  apex: [
    { id: 'br',      name: 'Battle Royale', kind: 'lobby',  players: 60, respawn: true,  short: 'BR' },
    { id: 'mixtape', name: 'Mixtape',       kind: 'versus', players: 12, respawn: true,  short: 'MIX' }
  ]
};
const BR_DEFAULT_MODE = { fortnite: 'br-build', apex: 'br' };
function brModesFor(gameId) { return BR_GAME_MODES[gameId] || BR_GAME_MODES.fortnite; }
function brModeMeta(gameId, modeId) {
  const list = brModesFor(gameId);
  return list.find((m) => m.id === modeId) || list[0];
}

// Squad size. `solo` still runs through the lobby board — a solo lobby is just a field where every
// entrant has one player, which is why the panel is entrant-shaped rather than team-shaped.
const BR_TEAM_FORMATS = [
  { id: 'solo',  name: 'Solos',  size: 1 },
  { id: 'duo',   name: 'Duos',   size: 2 },
  { id: 'trio',  name: 'Trios',  size: 3 },
  { id: 'squad', name: 'Squads', size: 4 }
];
function brFormatSize(id) {
  const f = BR_TEAM_FORMATS.find((x) => x.id === id);
  return f ? f.size : 2;
}
function brFormatForSize(n) {
  const f = BR_TEAM_FORMATS.find((x) => x.size === Math.max(1, Math.min(4, parseInt(n, 10) || 2)));
  return f ? f.id : 'duo';
}

// Drop-map POIs. x/y are PERCENTAGES of the map image, so the same set renders correctly at any
// overlay resolution and against any map image the producer swaps in.
//
// ⚠ The Fortnite island changes every season — treat this as a SEED, not a source of truth. The
// producer edits/replaces it per season from the Fortnite panel (Settings ▸ Games ▸ Fortnite ▸
// Drop map), and the edited set is stored in state.gameConfigs[game].pois, which brPoiSet() below
// prefers over this table. Same mechanism the maps/roles/characters game-config builder already
// uses, so a season update never needs a code change or an app update.
const BR_POI_SETS = {
  fortnite: {
    'br-build': {
      name: 'Battle Royale island',
      map: '/assets/games/fortnite-map.png',
      pois: [
        { id: 'fn-nw-peaks',   name: 'Frozen Peaks',    x: 22, y: 14 },
        { id: 'fn-n-ridge',    name: 'North Ridge',     x: 44, y: 11 },
        { id: 'fn-ne-dunes',   name: 'Sunburnt Dunes',  x: 74, y: 17 },
        { id: 'fn-w-shore',    name: 'West Shore',      x: 13, y: 38 },
        { id: 'fn-c-lake',     name: 'Central Lake',    x: 41, y: 33 },
        { id: 'fn-e-mesa',     name: 'Eastern Mesa',    x: 71, y: 34 },
        { id: 'fn-c-hub',      name: 'Midtown',         x: 50, y: 47 },
        { id: 'fn-w-mill',     name: 'Old Mill',        x: 24, y: 55 },
        { id: 'fn-e-canyon',   name: 'Red Canyon',      x: 76, y: 52 },
        { id: 'fn-sw-grove',   name: 'Willow Grove',    x: 27, y: 71 },
        { id: 'fn-s-docks',    name: 'South Docks',     x: 49, y: 78 },
        { id: 'fn-se-reef',    name: 'Coral Reef',      x: 72, y: 74 }
      ]
    },
    reload: {
      name: 'Reload island',
      map: '/assets/games/fortnite-reload-map.png',
      pois: [
        { id: 'rl-nw', name: 'Ranger Ridge',  x: 27, y: 24 },
        { id: 'rl-ne', name: 'Hazy Hillside', x: 71, y: 26 },
        { id: 'rl-c',  name: 'Lucky Landing', x: 50, y: 50 },
        { id: 'rl-sw', name: 'Dusty Depot',   x: 28, y: 73 },
        { id: 'rl-se', name: 'Tilted Towers', x: 73, y: 71 }
      ]
    }
  }
};
// Resolve the POI set for a game+mode, preferring the producer's own edits in gameConfigs.
// Zero Build / OG share the BR island; Reload Zero Build shares the Reload island.
function brPoiKey(modeId) {
  if (modeId === 'reload' || modeId === 'reload-zb') return 'reload';
  return 'br-build';
}
function brPoiSet(gameId, modeId) {
  const key = brPoiKey(modeId);
  const builtin = ((BR_POI_SETS[gameId] || {})[key]) || { name: '', map: '', pois: [] };
  const cfg = (state.gameConfigs || {})[gameId] || {};
  const custom = (cfg.pois && cfg.pois[key]) || null;
  if (custom && Array.isArray(custom.pois) && custom.pois.length) {
    return { name: custom.name || builtin.name, map: custom.map || builtin.map, pois: custom.pois };
  }
  return builtin;
}

const THEME_ALIASES = {
  'rocket-league': { default: 'lexogrine', midnight: 'lexogrine', neon: 'lexogrine', classic: 'lexogrine' },
  'csgo': { default: 'cs2-hud', midnight: 'cs2-hud', neon: 'cs2-hud' },
  'valorant': { default: 'valorant-hud', midnight: 'valorant-hud', neon: 'valorant-hud' },
  'league': { default: 'lol-hud', midnight: 'lol-hud', neon: 'lol-hud' }
};

// Returns built-in + user-added custom overlay layouts for a game.
function gameThemes(gameId) {
  const builtin = OVERLAY_LAYOUTS[gameId] || GENERIC_OVERLAY_LAYOUTS;
  const custom = ((state.customOverlayLayouts || {})[gameId]) || [];
  return builtin.concat(custom);
}

function migrateThemeId(gameId, themeId) {
  if (isValidTheme(gameId, themeId)) return themeId;
  const aliases = THEME_ALIASES[gameId] || {};
  if (aliases[themeId]) return aliases[themeId];
  const themes = gameThemes(gameId);
  return (themes[0] && themes[0].id) || themeId;
}

function isValidTheme(gameId, themeId) {
  return gameThemes(gameId).some((t) => t.id === themeId);
}

function resolveOverlayLayout(gameId, themeId) {
  const g = GAMES[gameId];
  if (!g) return { id: '', name: '', path: '/' };
  const themes = gameThemes(gameId);
  const id = migrateThemeId(gameId, themeId || state.themesByGame[gameId]);
  const layout = themes.find((t) => t.id === id) || themes[0];
  return layout || { id: '', name: '', path: g.overlay || '/' };
}

function activeOverlayPath(gameId) {
  return resolveOverlayLayout(gameId, state.themesByGame[gameId]).path;
}

function gameHasFeature(gameId, feat) {
  const g = GAMES[gameId];
  return !!(g && g.features && g.features.includes(feat));
}

// ─── State ───────────────────────────────────────────────────────────────────
// The winner reveal's look. 'slam' is the cinematic full-bleed default; 'depth' is the previous
// centred medallion, kept so an event that was cut against it can stay on it. Declared ABOVE state
// so the startup restore, which validates against it, can never hit a temporal-dead-zone error.
const WINNER_STYLES = ['slam', 'depth'];

// The look of the full-screen replay transition. 'slam' is the shutter-bar wipe that shipped;
// 'cinema' is the letterboxed scrolling-type treatment. Declared ABOVE state for the same
// temporal-dead-zone reason WINNER_STYLES is.
const REPLAY_STYLES = ['slam', 'cinema', 'sweep'];   // overlay/replay-fx.js implements all three; only rl-worlds.html loads it (rl-hud.html plays 'cinema' or falls back to slam)

let state = {
  version: appVersion,
  view: 'hud',              // 'hud' | 'scoreboard' | 'goal'
  rlHudHidden: false,       // manual "hide UI" — blanks the live RL HUD overlay for a clean feed (not persisted)
  rlReplayTransitions: true,   // play the animated shutter-slam replay intro/outro (+ Brazil flag) on the RL overlays; off = no wipe, HUD just hides/shows for the replay (persisted)
  rlSponsorRoll: false,        // occasionally roll the title-sponsor tab out from behind the bottom-right statcard on the RL HUD (persisted)
  // optional RLCS-style stats sidebar on the Worlds overlay (rl-worlds.html): ranked rows the producer
  // fills manually or pulls from league standings / series stats (persisted)
  worldsSidebar: { visible: false, title: 'Total Goals', subtitle: '', source: 'manual', rows: [] },
  worldsTicker: true,          // producer on/off for the scores ticker on the Worlds overlay (rl-worlds.html); off just hides that source's ticker lane, the global ticker feed keeps running everywhere else (persisted)
  rlScoreboardSeparate: false,  // route the post-game scoreboard to its OWN browser source (rl-hud.html?only=scoreboard); when on, the MAIN HUD hides its inline board (persisted)
  // Game performance mode: while an RL match is LIVE the app sheds load so borderless
  // gameplay stays smooth — panel previews/animations pause, the app's process priority
  // drops below the game's, and full-state broadcasts coalesce wider. Broadcast overlays
  // are untouched. enabled = producer setting (persisted); active = engaged right now.
  // enabled = auto game mode; always = permanent lean mode; reduceAnimations /
  // pausePreviews = independent panel knobs; broadcastRate = smooth|balanced|light
  // (full_state coalesce width). active = a match is live right now.
  perfMode: { enabled: true, active: false, always: false, reduceAnimations: false, pausePreviews: false, broadcastRate: 'smooth', resourceWarnings: true },
  // Org Library sync — two-way share of teams/brand kits/facecams/casters across the org. This app
  // auto-pushes its OWN items up (as the producer's workspace-shared profile) and auto-pulls org-mates'
  // shared items down, tagged _org so they sit in their own "From organization" category everywhere.
  orgLibrary: { autoSync: true, profileId: null, lastPush: 0, lastPull: 0 },
  activeGame: 'rocket-league',
  // Pulse multiview: when publish is on (and the cloud is linked), this app heartbeats its live game to
  // the org so it appears on other producers' Pulse scenes. feedViewUrl = this observer's own VDO view
  // URL others pull for the featured video (optional — without it the tile is scores-only).
  // URL others pull for the featured video (optional — without it the tile is scores-only). channel =
  // this producer's Twitch handle (shown on the grid tile bar); label = a desk name ("Desk 2") when the
  // handle is empty.
  pulse: { publish: false, feedViewUrl: '', channel: '', label: '' },
  // One title template drives the Twitch title and the VOD file names (backend/match-title.js).
  // twitch.auto: retitle the channel whenever the match on air changes. vod.rename: when an OBS
  // recording stops, rename the file to the match title, file it under an event folder and append
  // a row to recordings.csv beside it. status/vodLog are runtime readouts for the settings panel.
  matchTitles: {
    twitch: { auto: false, template: matchTitle.DEFAULT_TWITCH_TEMPLATE },
    vod: { rename: false, template: matchTitle.DEFAULT_VOD_TEMPLATE, eventFolder: true, datePrefix: true, csv: true },
    stripSponsors: true,
    status: { twitchTitle: '', twitchAt: 0, twitchError: '' },
    vodLog: []
  },
  themesByGame: { 'rocket-league': 'lexogrine', 'csgo': 'cs2-hud' },
  eventName: '',   // fresh installs start with no preset title — the producer sets their own
  // Which event slug the current eventName was pulled from. Loading a DIFFERENT event pulls its
  // title once; anything typed afterwards is the producer's and survives re-loads of that event.
  eventNameSlug: '',
  gameLabel: '',   // custom "GAME x | BEST OF x" override (e.g. "UPCOMING MATCH"); '' = auto
  roundLabel: '',  // optional bracket round/stage shown on the overlay (e.g. "WINNERS FINALS"); '' = hidden
  dateFormat: 'us', // schedule date/time display: 'us' (Jul 12, 8:00 PM) | 'intl' (12 Jul, 20:00)
  speedUnit: 'mph', // shot-speed display unit: 'mph' | 'kmh'. RL's Stats API reports km/h and does NOT
                    // expose the player's UI unit setting, so this is a manual toggle. Overlay converts.
  fontFamily: 'Industry',
  clock24h: false,
  // Pushing a start.gg set from a DIFFERENT event than the last one switches to that event's game
  // (multi-game stream queues). Off by default: loading an event already sets the game.
  followSetGame: false,
  showSeries: true,
  defaultBestOf: 3,
  facecamsEnabled: true,
  replayCams: true,         // show all player cams + cards during replays (RL React HUD)
  lanSeats: lanSeats.normalize({}),   // LAN seat cams (backend/lan-seats.js); seats[] is derived, never saved
  activeBrandKitId: null,   // selected client brand kit (recolors overlays + drives sponsor rail)
  useBrandColors: false,    // legacy mirror of (colorMode === 'brand') — kept for back-compat
  // Which colours overlays use for the two sides. Non-destructive: each source is kept separately
  // (team = teams.x.color, brand = active kit, default = per-game) and the effective colour is
  // computed at broadcast time, so toggling never overwrites a team's own colour.
  colorMode: 'team',        // 'team' | 'brand' | 'default'
  sceneBg: {},              // live bg fill per overlay path, keyed by pathname
  banner: { visible: false, images: [], captions: [], interval: 10, slant: 'right', header: '' },
  // Stream Credits scrolling roll (overlay/stream-credits.html) — a gfx.html Push Live scene like any
  // other; the overlay has no visibility gate of its own, so `visible` is the only thing that decides
  // whether it's showing. Extras: producer-added "credit sponsors" — a dedicated big call-out section
  // in the roll, separate from the brand-kit sponsor bar [{name,logo,tier}]; talent = manual
  // {name,role} credits (other-shift crew). (Single source of truth — must not be redefined below.)
  credits: { visible: false, sponsors: [], talent: [], endText: '' },   // endText: big end-card text after the roll ('' → "Thanks For Watching")
  casters: { visible: false, showCountry: false, nameMode: 'gamertag',   // off on a fresh install: nothing is on air before the producer puts it there
             showRoles: { host: '', observer: '' }, shifts: [], activeShiftId: '', support: [],
    // Undo stack for "Next shift" handovers — [{ slots, host, observer, movedCrewIds, shiftId }].
    // Session-only by design (not restored on boot): last night's crew change isn't something
    // you'd want to "undo" into tonight's desk.
    shiftHistory: [], stationId: '', list: [], lowerThird: '', library: [], vdo: { room: '', password: '' }, guestsVdo: { room: '', password: '' }, observersVdo: { room: '', password: '' }, rooms: [], lineup: [], activeLayout: '', interview: { room: '', password: '' }, apiKey: '', interviewee: null, playerCam: null, deskRoomId: '', slotLabels: { 1: 'Caster 1', 2: 'Caster 2', 3: 'Caster 3', 4: 'Caster 4', 5: 'Player' } },   // list = on-air slots; showCountry = render each caster's country on the desk; library = saved casters/guests/observers (by kind); vdo/guestsVdo/observersVdo = the three shared group rooms; rooms = named VDO rooms; lineup = this-show active assignments; apiKey = director IFrame-API key; interviewee = spotlight-desk right cam; playerCam = slot-5 player feed ({camUrl,name,playerId}); deskRoomId = which named room is the interview/desk room
  // VDO.Ninja talent workflow. Global config (server-side, replaces the old localStorage settings);
  // per-team rooms/passwords live on teams.x.vdo, per-player IDs on the player objects.
  vdo: {
    base: 'https://vdo.ninja',
    lang: 'en-US',          // &transcribe language for live captions
    listenCaptions: true,   // LISTEN IN: show/hide the transcription strip (Talent Rooms toggle)
    cleanOutput: true,      // strip VDO UI on view/OBS links
    transparent: false,
    cover: true,            // fill the frame
    volume: 100,
    bitrate: '',            // kbps (blank = auto)
    codec: '',              // '' | h264 | vp8 | vp9 | av1
    buffer: '',             // jitter buffer ms
    viewParams: '',         // extra params appended to OBS/view links
    pushParams: '',         // extra params appended to talent join links
    audioMono: false,       // down-mix every feed to mono (&mono)
    audioBitrate: '',       // audio bitrate kbps (&ab — blank = auto)
    audioParams: ''         // free-text extra VDO audio params (e.g. &compressor&limiter)
  },
  // LISTEN IN — the player whose audio + live captions are currently on-air (listen-in.html).
  listenIn: { active: false, side: '', name: '', url: '' },
  // Break / "starting soon" standby. endsAt = epoch ms target for the countdown scene; null = no timer.
  // titleOnly: show the countdown TITLE with no clock beside it — for a scene where the label is
  // the whole point ("INTERMISSION") and a ticking number would just be noise. The timer itself
  // keeps running; this only changes what the scenes draw.
  breakScreen: { visible: false, title: 'STARTING SOON', message: '', endsAt: null, frozenSeconds: null, finalMessage: "WE'RE LIVE!", thenScene: '', titleOnly: false },
  ticker: { visible: false, messages: [], speed: 10, source: 'manual', feed: [], sponsor: '' },
  // The live competition every competition scene follows (see refreshCompetitionFeed). compFeed is
  // DERIVED from that league on every change — small, names + scores, no library logos. compSync is
  // each league's pull-source status (Google Sheet / JSON feed) for the panel.
  competition: { leagueId: '', feeds: { ticker: true, schedule: true, standings: true, brb: true }, ticker: { live: true, upcoming: true, results: true, max: 12 }, showResultsOnSchedule: true },
  compFeed: null,
  compSync: {},
  // The org's competitions hosted on the Nameless website (ids, names, rev, live flag — no
  // fixtures), refreshed by the org-competitions cloud loop for the Data source picker. A cache,
  // not persisted; library tier (the panel reads it, overlays never do).
  cloudCompetitions: [],
  cloudEventsMeta: { createUrl: '', signedIn: null, loaded: false },
  customOverlayRevs: {},   // custom overlay id -> updatedAt: an open custom.html refetches its layout when this moves   // website events hub: where "Create an event" goes
  // Sponsor proof-of-play: archived per-broadcast impression reports (estimated on-screen seconds
  // per sponsor logo, by placement). The live session is tracked in-memory (adProof); completed
  // sessions land here and persist. Tiny — names + counts only, no logos.
  adProofSessions: [],
  spotlight: { visible: false, playerName: '' },          // featured-player lower-third (live stats)
  // Post-match WINNER screen (game-agnostic). side resolves a team from `teams`; or set name/logo/color directly.
  // style: see WINNER_STYLES.
  winner: { visible: false, side: '', name: '', logo: null, color: '', subtitle: '', style: 'slam' },
  // Map veto / map-pool overview board (CS2/Valorant/etc.). Each map: name, mode, image, action, by, score, winner.
  // action: 'ban'|'pick'|'decider'|''  by: 'a'|'b'|''  winner: 'a'|'b'|''  score: { a, b }
  veto: { visible: false, title: '', maps: [] },
  // Overwatch 2 series scoreboard — hero bans per map + format display.
  // bansByMap: [{ a: { hero, role }, b: { hero, role } }] indexed by map order.
  owMatch: { visible: true, format: 'FT3', currentMapIdx: 0, bansByMap: [], gameMode: 'escort', showMapLabels: true, mapWinners: [], mapModes: [] },
  // Marvel Rivals series scoreboard — 4 bans per team (match-global), map results, Overwolf GEP data.
  // bansByMap: [{ a: [{hero,role}×4], b: [{hero,role}×4] }] — uses index 0 (bans are series-wide).
  mrMatch: { visible: true, format: 'BO5', bansByMap: [], gameMode: 'convergence', showMapLabels: true, mapWinners: [], mapModes: [], gepData: null },
  // Rainbow Six Siege live data, relayed by the Overwolf companion (same pipeline as Overwatch and
  // Marvel Rivals — see companion-overwolf/background.html). R6 has no first-party GSI, so GEP on an
  // OBSERVER machine is the only practical source; running it on players' PCs is an adoption problem,
  // not a technical one. autoScore is opt-in: a producer must never have the scoreboard move under
  // them because a spectator client reconnected mid-round.
  r6: {
    autoScore: false,      // mirror GEP round wins onto state.series (producer opt-in)
    gepData: null          // { gepConnected, lastSeen, roster, map, score:{a,b}, round, side, operators, killFeed }
  },
  // Minecraft Bedwars live data, pushed by a server-side plugin rather than a game client. Bedwars is
  // usually played on a server the organiser controls, so the authoritative scorer is the server
  // itself — higher fidelity than any client scrape, and no per-player install. See /api/bedwars.
  // NOTE: the shared token is NOT here. state.bedwars rides the LIVE broadcast tier, which reaches
  // every OBS browser source and any custom overlay — a secret in it is a secret published. It lives
  // in the module-level `bedwarsToken` alongside the other credentials; only a hasToken flag is sent.
  bedwars: {
    autoScore: false,
    data: null             // { connected, lastSeen, teams:[{key,name,bedAlive,players,eliminated}], events:[] }
  },
  // User-defined overlay URLs shown alongside the built-in ones in the layout dropdown.
  // Keyed by gameId → [{ id, name, path }]
  customOverlayLayouts: {},
  // One active Game Config per game (maps/roles/characters extending an EXISTING built-in game —
  // see gameConfigMapsFor/gameConfigCharactersFor in backend/veto.js and backend/draft.js, and
  // rolesForActiveGame() client-side). Keyed by gameId → the imported bundle, or absent = pure
  // built-in. Importing REPLACES a game's slot; the bundle's own maps/characters/roles still merge
  // by id onto the built-in tables at read time, so an import doesn't need to re-list everything.
  gameConfigs: {},
  // Named snapshots of a game's custom content (e.g. "Season 19", "Season 20") the producer can
  // switch between or build on. gameId -> [{ name, savedAt, bundle }]. The ACTIVE content is
  // still gameConfigs[gameId]; loading a version copies it there. "Original" = no active config.
  gameConfigVersions: {},
  // gameId -> { name: version the active content was loaded from or last saved as ('' = Original),
  //             clean: true until the active content is edited after that }.
  gameConfigFrom: {},
  // Named, reusable point matrices the producer creates (built-ins are generated, not stored).
  // A league picks a season default; any cup can override it. See sanitizePointMatrix.
  pointMatrices: [],
  // Champion/hero draft board (LoL etc.). sequence/ops drive the live pick-ban.
  draft: { visible: false, title: '', subtitle: '', game: '', teamStart: 'a', owBanCount: 2, sequence: [], ops: [], turn: null, complete: false,
    // Board look (producer preferences, kept across games and restarts): layout 'auto' = the broadcast
    // strip for Dota 2 / Mobile Legends / Honor of Kings and the two-column board elsewhere; 'strip' or
    // 'board' force one. stripPos = which edge the strip sits on. turnSeconds = the on-air shot clock
    // per turn (0 = the game's default, -1 = no clock).
    layout: 'auto', stripPos: 'top', turnSeconds: 0,
    // owBanCount: Overwatch total hero bans (2 = one per team, 4 = two per team). Producer-set.
    // LoL champ-select automation — fills the board live from the League Client (LCU).
    auto: { enabled: false, status: 'off', statusDetail: '', lockfilePath: '' } },
  // Team-lineup / player-intro card scene. side = which team to feature ('blue'|'orange'); style = card variant.
  intro: { visible: false, side: 'blue', title: '', style: 1, showFooter: false, showRealName: true },
  // (state.credits defined once near the top of this state object — sponsors/talent/visible together.)
  // Overtime ad slot — sellable sponsor slot shown on the overlay during OT.
  overtime: { label: 'OVERTIME', logo: null, bg: '#e0202a', color: '#ffffff' },
  // Replay ad slot. logo = sponsor on the goal swipe; outroLogo = logo on the after-replay swipe
  // (e.g. tournament-organizer logo); colorMode: 'team' | 'mono' (B&W).
  // skin = a full-frame TRANSPARENT PNG shown over the whole replay (a branded frame/border to
  // "skin" replays); null = none.
  replay: { label: 'REPLAY', logo: null, outroLogo: null, colorMode: 'team', skin: null, style: 'slam',   // style: see REPLAY_STYLES
    // Replay-to-screen buses (see the replay_play handlers). These used to be a SECOND `replay:` key
    // further down this object, which silently replaced the transition defaults above.
    program: { url: '', name: '', loop: false, playing: false },
    preview: { url: '', name: '', loop: false, playing: false } },
  // Scoreboard ad slot — sponsor logo + uploadable scene background on the scorecard.
  scoreboardAd: { label: 'PRESENTED BY', logo: null, background: null },
  // Post-game stats screen skin (RL scoreboard). showStats=false shows a clean FINAL-only board;
  // design picks the look of the per-team stat table: default | glass | block | radar.
  rlStatsScreen: { showStats: true, design: 'default' },
  // Series-long RL player stats (opt-in). playerCache is wiped on every MatchCreated, so nothing
  // survives into game 2 — this slice keeps a SNAPSHOT of each COMPLETED game's final per-player
  // line and the overlay adds the live game on top. Storing only finished games means it changes
  // once per game instead of on every stat tick, so a running game costs the live payload nothing.
  // enabled defaults OFF: existing shows are untouched until a producer turns it on.
  // liveBanked closes a double-count window: between MatchEnded (which banks the game) and the next
  // MatchCreated (which wipes playerCache), the cache still holds numbers that are already in
  // games[]. While it is true the board shows banked games only; the live game is added on top again
  // as soon as the next game re-baselines the cache.
  seriesStats: { enabled: false, visible: false, design: 'table', games: [], liveBanked: false },
  // OBS background browser source (background.html). type: 'solid'|'gradient'|'image'.
  background: { type: 'gradient', color1: '#07090f', color2: '#0c1220', angle: 135, imageUrl: '' },
  // Desk footer logos — manual Dashboard override. When non-empty these replace the active
  // brand's desk-tagged sponsors on the caster-desk scenes; when empty the brand's logos show.
  deskFooter: { logos: [] },
  // Desk Show (preshow.html) — 2-cam standalone OBS scene; cams/team-matchup/kickoff
  // timer/brand logo all reuse existing state (casters/upcoming/breakScreen/teams/brand). Only
  // the discussion-topics rail + headline need their own settings.
  // Each topic: { text, sceneName } — sceneName is an optional OBS scene to cut to when that
  // topic goes active (e.g. cut to the Bracket while discussing "who's going to Worlds").
  // homeScene is the OBS scene "Return" switches back to (typically the Desk Show scene).
  // headline/topics mirror the active brand package's own topicsHeadline/topics fields
  // (syncActivePreshowTopics()) — not independently persisted here.
  // predictions[i] = caster in desk slot i+1's pick for the upcoming match: '' | 'blue' | 'orange'.
  preshow: { headline: '', topics: [], activeTopicIndex: 0, homeScene: '', predictions: ['', ''] },
  // Dota 2 Game State Integration (backend/dota-gsi.js). Settings persist; live is the latest parsed
  // frame (not saved). radiantSide = which app side (a = blue/left, b = orange/right) is Radiant.
  // autoDraft mirrors the in-game Captains Mode draft onto the Pick & Ban board.
  dota: { connected: false, lastUpdate: 0, cfgPath: '', autoDraft: true, radiantSide: 'a', showBoard: false, live: null },
  csgo: {                                                 // CS2 Game State Integration
    connected: false,
    lastUpdate: 0,
    cfgPath: '',
    map: { name: '', phase: '', mode: '' },
    round: { number: 0, phase: '', bomb: '', winTeam: '' },
    ct: { name: 'CT', score: 0, lossBonus: 0, timeouts: 0, seriesWins: 0 },
    t:  { name: 'T',  score: 0, lossBonus: 0, timeouts: 0, seriesWins: 0 },
    provider: { version: null, timestamp: null },
    roundHistory: [],  // [{ round, winner: 'CT'|'T', method }]
    observed: null,    // currently spectated player (bottom focus panel)
    players: [],   // [{ steamid, name, team, health, armor, money, kills, assists, deaths, mvps, score, roundKills, roundHs, roundDmg, alive, equip, flashed, burning, smoked, weapon, nades, primary, secondary, hasTaser, activeNade, hasKit, hasBomb, pos }]
    grenades: [],  // active grenades for the radar: [{ type, x, y, effecttime }]
    bomb: { state: '', countdown: null, pos: null, player: '' },
    phase: '',
    phaseEndsIn: null,
    showHistory: false,    // round-history overlay visibility (control-panel toggle)
    builtinRadar: true,    // true = built-in auto-zoom radar (default); false = external (boltobserv)
    autoWinner: true,      // put the Winner graphic on air when a map ends (gameover); persisted
    proLayout: 'wide',     // CS2 Pro HUD layout: 'wide' (team columns in the corners) | 'stacked' (both teams down the left); persisted
    autoHud: true,         // hide CS2's own HUD over the console the moment the client starts spectating, restore it when playing; persisted
    observerAssist: true,  // show the Director's observer pick inside the HUD when it runs over the game (not in OBS); persisted
    radarLayout: null,     // CS2 Pro HUD radar { x, y, size } in 1920x1080 px; null = the layout's default; persisted
    // Scripted freezetime camera (backend/cs2-cinematic.js) over CS2's network console (-netconport).
    // enabled/port/shots persisted; status/playing are runtime only.
    cinematic: { enabled: false, port: 2121, shots: {}, status: 'off', statusDetail: '', playing: null },
    killfeed: []           // recent kills: [{ killer, killerTeam, victim, victimTeam, weapon, hs, ts }]
  },
  valorant: {                                              // Overwolf GEP relay (POST /api/val-gep)
    connected: false,
    lastUpdate: 0,
    source: '',       // 'gep' once the relay has ever reported
    map: { name: '', displayName: '' },
    round: { number: 1, phase: 'warmup', rawPhase: '' },   // phase: warmup|shopping|live|bomb|end
    // ORDER / CHAOS are FIXED team identities (GEP team index 0 / 1). They do not swap at half;
    // the overlay works out who is attacking from the round number.
    order: { score: 0 },
    chaos: { score: 0 },
    spikeState: '',   // '' | 'planted' | 'defused' | 'detonated'
    // Every field here is one Overwolf's `scoreboard_N` actually sends. Per-player HEALTH and
    // utility charges are NOT in that payload (only the local player's, via `me`), so they are
    // deliberately absent rather than rendered as zeros — see backend/integrations/valorant-gep.js.
    players: [],      // [{ name, agent, agentName, team, isLocal, teammate, alive, shield, armor,
                      //    kills, deaths, assists, credits, ultPointsGained, ultPointsNeeded, weapon, hasSpike }]
    observed: null,   // who the relay seat is spectating (match_info.observing)
    roundHistory: [], // [{ round, winner: 'ORDER'|'CHAOS' }] — derived from the score moving
    killfeed: [],     // [{ attacker, victim, weapon, headshot, assists, ts }]
    gameMode: '',
    matchId: '',
    localSide: '',    // 'attack' | 'defense' — the RELAY PC's side this half, not the match's
  },
  lol: {                                                   // League Live Client Data API (port 2999, spectator)
    connected: false,
    lastUpdate: 0,
    gameTime: 0,
    mapNumber: 1,
    gameMode: '',
    // ORDER = blue side, CHAOS = red side. gold is ESTIMATED net worth (see backend/lol-live.js).
    blue: { kills: 0, gold: 0, towers: 0, inhibs: 0, dragons: [], barons: 0, heralds: 0, grubs: 0, dragonSoul: '', firstBlood: false },
    red:  { kills: 0, gold: 0, towers: 0, inhibs: 0, dragons: [], barons: 0, heralds: 0, grubs: 0, dragonSoul: '', firstBlood: false },
    goldDiff: 0,      // blue.gold - red.gold (+ = blue ahead)
    players: [],      // [{ name, champion, team, position, level, dead, respawn, kills, deaths, assists, cs, vision, items, itemValue, spells, gold }]
    events: [],       // recent notable events for the kill feed/ticker
    hudMode: 'auto',  // 'full' | 'minimal' | 'auto' — producer control for the teamfight transition
    // Optional OCR override for REAL team gold (estimate is the default). Producer
    // calibrates the two capture regions over the spectator scoreboard gold numbers.
    ocr: {
      enabled: false, available: false, status: 'off', statusDetail: '',
      source: 'est',          // 'est' | 'ocr' — which feed is currently driving team gold
      lastBlue: null, lastRed: null,   // last VALIDATED values (for calibration feedback)
      lastBlueConf: 0, lastRedConf: 0, // Tesseract confidence of the last raw read, 0-100
      lastReason: { blue: '', red: '' },   // why the tracker took/held the last read (ok/first/lowconf/jump/decrease/noread)
      capture: '',            // 'display' (Electron frame grab) | 'powershell' (fallback)
      displayId: '',          // which monitor the spectator client is on ('' = primary); regions are in its physical pixels
      regions: { blue: { x: 800, y: 16, w: 78, h: 26 }, red: { x: 1042, y: 16, w: 78, h: 26 } }  // 1080p defaults
    },
  },
  apex: {                                                  // Apex LiveAPI (game connects to our WS server; see backend/apex-live.js)
    connected: false,
    lastUpdate: 0,
    port: 7777,
    matchState: 'lobby',            // lobby | live | postmatch
    map: '', playlist: '',
    gameNumber: 1, gamesPlayed: 0,
    ring: { stage: 0, current: 0, end: 0, shrinking: false },
    observed: null,                 // spectated player card { name, legend, hp, shield, kills, squad:[...] }
    standings: [],                  // ALGS leaderboard: series points per team (computed from games + live)
    squadsAlive: 0, squadsTotal: 0, playersAlive: 0,
    killfeed: [],
    winners: [],
    // ALGS scoring config (editable) + series accumulation. Team identity (logo/abbrev) is
    // resolved client-side from the team library; teamMap holds producer overrides (liveKey -> saved team name).
    scoring: { placementPoints: [12, 9, 7, 5, 4, 3, 3, 2, 2, 2, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], killPoints: 1 },
    games: [],                      // completed-game snapshots (survives a mid-series restart)
    teamMap: {},                    // { normalizedLiveApiName: savedTeamName } manual identity overrides
    event: { title: '', match: '', split: '' },   // broadcast branding shown top-left
  },
  // -- Battle-royale series (game-agnostic) ------------------------------------
  // The Apex block above is the same idea welded to one game's LiveAPI. This is that model lifted
  // out: a points series over N matches, fed by a Google Sheet, by hand, or by live game data,
  // and rendered by the br-*.html overlays. Fortnite/PUBG/Warzone have no third-party live match
  // feed, so Sheets + manual entry are the real production path for them.
  br: {
    enabled: false,
    game: 'fortnite',                 // which BR this series is for (labels/logo only)
    event: { title: '', match: '', split: '' },   // broadcast branding
    format: { matches: 6, teamSize: 4 },          // matches in the series, players per team
    scoringPreset: 'fncsFinals',
    scoring: { placementPoints: [], killPoints: 1, killCap: 0 },   // filled from the preset on load
    // Raw results, one entry per (match, team). Everything else is DERIVED from these, so a
    // corrected placement re-scores the whole series instead of leaving a stale total behind.
    results: [],                      // [{ match, team, placement, elims }]
    playerResults: [],                // [{ match, player, team, elims }]
    standings: [],                    // derived - see computeBrStandings()
    playerBoard: [],                  // derived - per-player elim leaderboard
    lastMatch: null,                  // derived - the most recent match's own result card
    source: 'manual',                 // manual | sheets | live  (what last wrote results)
    lastUpdate: 0,
    // ── Lobby model (the Fortnite Match — Lobby panel) ─────────────────────────
    // mode/teamFormat describe the PRODUCT being played (see BR_GAME_MODES / BR_TEAM_FORMATS).
    // format.teamSize is kept in lockstep with teamFormat so the existing sheet template and
    // roster-size checks keep working off the number they already read.
    mode: 'br-build',
    teamFormat: 'duo',
    // Season store. When both are set the board MIRRORS lg.brSeries[seriesId] and every result
    // write lands in the league — so the league page is the record and the lobby stays the
    // live cockpit. Both empty = the old standalone/sheet-fed behaviour, untouched.
    leagueId: '',
    seriesId: '',
    // Which named matrix the live series is scoring under, and per-match weighting
    // (a double-points final). Both mirror down from the bound cup when there is one.
    matrixId: '',
    matchMultipliers: {},
    // The field. One row per ENTRANT (a solo, a duo, a squad) — never per side, because a BR
    // broadcast has no sides. Deliberately free of logos/photos: the overlays resolve a logo from
    // savedTeams by name, so a 50-entrant field never puts 50 base64 images on every broadcast.
    //   { id, name, seed, players: [{ name, epic }], drop, note, out }
    lobby: [],
    // What the producer is doing RIGHT NOW, as opposed to the series totals above.
    //   match      which match number the manual entry + result card are pointed at
    //   focus      entrant id the observer is spectating (drives the focus rail / director hints)
    //   teamsAlive producer-tracked, because no Fortnite feed reports it to us
    live: { match: 1, focus: '', teamsAlive: 0, playersAlive: 0, running: false, startedAt: 0 },
    // Drop map (fn-dropmap.html). mapUrl is a URL/relative path — NEVER a data URL, or it would
    // ride every live broadcast (see BROADCAST_TIERS: br is 'live').
    dropmap: { visible: false, title: '', mapUrl: '', showPlayers: true, showLogos: false },
    // Head-to-head comparison card (fn-compare.html). rows are producer-defined stat lines so the
    // same card covers "elims/damage/mats/builds" for BR and anything else for Creative.
    //   a/b: { name, team, sub, image }   rows: [{ label, a, b }]
    compare: { visible: false, kind: 'duo', title: 'Comparison', label: '', footnote: '',
               a: { name: '', team: '', sub: '', image: '' }, b: { name: '', team: '', sub: '', image: '' }, rows: [] },
    // Victory Royale slam (fn-victory.html).
    victory: { visible: false, team: '', players: [], stage: '', match: '', elims: 0, at: 0 }
  },
  bestOf: 5,
  teams: {
    blue:   { name: 'BLUE TEAM',   logo: null, color: '#055fdb', abbr: null, players: [] },
    orange: { name: 'ORANGE TEAM', logo: null, color: '#e97139', abbr: null, players: [] }
  },
  teamPlayers: {}, // keyed by side, contains player data
  series:  { blue: 0, orange: 0 },
  // Which roster member is the one actually on the overlay per side (FGC 1v1 within a multi-
  // player team / crew battle). Stores the player id; '' or a stale id → the side's first
  // player. Lets a team of several players show just the active competitor on the scoreboard.
  activePlayer: { blue: '', orange: '' },
  // The ONE player the observer is spectating, across both sides (THE FINALS bar's player plate).
  // Unlike activePlayer (one per side), a spectator view follows a single player. side '' = nobody.
  observedPlayer: { side: '', playerId: '' },
  // Super Smash Bros. HUD state (overlay/smash.html). Stocks = lives remaining this game (manual —
  // Smash Ultimate has no easy live feed); character = each side's fighter name (free text/datalist).
  // startStocks = the game's starting stock count (3 by default) — also how many pips render.
  // mode: 'singles' (1v1 → smash.html) | 'doubles' (2v2 → smash.html, both players on each plate)
  //       | 'team' (crew battle w/ aggregate team stocks → smash-team.html).
  // In doubles + team mode each side's players[] holds per-player stocks remaining and the side's
  // total = their sum (doubles is just a two-player pool: the game ends when both are out).
  // characters[] is the crew's per-player fighter (team mode), parallel to players[]; `character`
  // stays the singles fighter. Both are fighter NAMES — the overlays resolve them to slugs/art via
  // overlay/smash-fighters.js, so free text a producer typed still finds the right stock icon.
  smash: {
    startStocks: 3,
    mode: 'singles',
    crewSize: 4,
    // Which Smash + bracket format ("Ultimate Singles"), printed under the centre medallion.
    // Auto-filled from the start.gg event on every set push unless the producer typed their own,
    // in which case titleManual pins it. startggTitle keeps what start.gg last said so the
    // control panel can offer "use the start.gg label" again.
    title: '', titleManual: false, startggTitle: '',
    // Running a side out of stocks closes the game: the opponent takes the series point and both
    // sides refill. Off = the producer drives the series buttons themselves.
    autoAdvance: true,
    // Where the caster/sponsor card sits on the Smash boards: 'auto' (the default - bottom-centre in
    // singles, beside player 1 in doubles/crew), or pinned 'bottom' / 'topleft'. Doubles and crew put
    // Smash's own per-player HUD right across the bottom of the frame, which the centred card sat
    // on top of - so 'auto' moves it up beside the board whenever there are 4+ player HUDs.
    railPos: 'auto',
    // The bracket format start.gg last reported ('Singles' | 'Doubles'), so a NEW event of a different
    // format switches the mode once, while the producer's own pick sticks for the rest of the event.
    startggFormat: '',
    blue:   { stocks: 3, character: '', players: [3, 3, 3, 3], characters: ['', '', '', ''] },
    orange: { stocks: 3, character: '', players: [3, 3, 3, 3], characters: ['', '', '', ''] }
  },
  // Brawlhalla board (overlay/brawlhalla.html). Same shape as `smash` on purpose — it is the same
  // KIND of game and the same kind of broadcast: a platform fighter with NO live data feed, so the
  // stocks and the legend on screen are producer-driven. What Brawlhalla adds over Smash is a real
  // career-stats API, so each side also carries a `card` — the player's ranked identity (ELO, tier,
  // peak, global/region rank, season W/L, most-played legends) pulled from api.brawlhalla.com.
  //   mode        '1v1' | '2v2' — lays the board out for singles or the doubles pair
  //   players[]   per-seat stocks, legends and linked brawlhalla_ids (seat 0 = the singles player)
  //   card        the last ranked pull for that seat, or null. Never blocks the board: a board with
  //               no cards is a correct board, it just has no rank chips.
  brawlhalla: {
    startStocks: 3,
    mode: '1v1',
    // Which ladder the rank chips quote. The API has no ranked_2v2 player stats (2v2 rating lives
    // on the TEAM), so a doubles board still shows each player's 1v1 card — labelled as such.
    rankMode: 'ranked_1v1',
    region: 'ALL',
    // Printed under the centre mark, e.g. "1v1 Singles". Auto-filled from the loaded event unless
    // the producer typed their own, in which case titleManual pins it.
    title: '', titleManual: false,
    // Running a side out of stocks closes the game (opponent takes the series point, both refill).
    autoAdvance: true,
    showRank: true,       // rank/ELO chips on the board
    showLegend: true,     // legend portrait + name on each plate
    railPos: 'auto',
    blue:   { stocks: 3, legend: '', players: [{ stocks: 3, legend: '', bhId: 0, card: null }, { stocks: 3, legend: '', bhId: 0, card: null }] },
    orange: { stocks: 3, legend: '', players: [{ stocks: 3, legend: '', bhId: 0, card: null }, { stocks: 3, legend: '', bhId: 0, card: null }] },
    lastError: '', lastLookupAt: 0
  },
  // Marvel Tokon board (overlay/tokon.html). The game's HUD owns the bottom-centre, so casters and
  // sponsors go either along the bottom ('meters': sponsors rotating between the super meters, casters
  // beside the bottom-edge event tab)
  // or as the caster-rail card in a bottom corner ('bottomleft' | 'bottomright').
  // layout = where the board sits on the frame (Match ▸ Teams ▸ Marvel Tokon ▸ Position).
  // layoutV bumps when the board's shape changes enough that old saved positions no longer fit it.
  tokon: { railPos: 'meters', layoutV: 2, layout: normalizeTokonLayout() },
  // Series/match editor: format + division + per-map results (feeds the HUDs).
  // maps: [{ name, scoreA, scoreB, played }]
  match:   { format: '', division: '', maps: [], seriesVisible: true },
  // Manually-managed leagues (NOT start.gg). Each league:
  // { id, name, game, type:'team'|'freeagent'|'salary', season, salaryCap,
  //   teams:[{id,name,logo,players:[{id,name,role,salary,stats}]}],
  //   freeAgents:[{id,name,role,salary,stats}], standings:[{teamId,w,l,pts}], schedule:[{a,b,scoreA,scoreB,date,played}] }
  leagues: [],
  // Events the producer has "added to the app" (the MY EVENTS page). Each:
  // { id, tournamentSlug, eventSlug, name, tournamentName, game, numEntrants, startAt, addedAt,
  //   roster, lastSync, syncError }
  myEvents: [],
  // Event Ops (ESPORTS ▸ Event Ops) — the start.gg → Challonge mirroring workbench.
  // headers/rows: the FULL imported spreadsheet (every column, rows as string arrays);
  // roleMap: which column index means team/team2/player/email/challonge/flags (-1 = none);
  // seeds: TRUE start.gg bracket seeds (initialSeedNum) [{ seed, name }] — the order to
  // recreate in Challonge so byes land identically.
  eventOps: { headers: [], rows: [], roleMap: {}, seeds: [], eventSlug: '', importedAt: 0, seededAt: 0 },
  // Per-player profile registry keyed by lowercased gamertag. Auto-linked: start.gg
  // (slug/playerId) on every roster pull; older entries may also carry 6mans data from the
  // removed seeding tool. Read by the team editor and Match-Teams panel to show links.
  //   { <gamertag>: { gamerTag, startggSlug, startggPlayerId, sixmans:{name,elo,rank,region,platform}, updatedAt } }
  playerProfiles: {},
  // Team vault settings + a small summary. The RECORDS themselves deliberately never enter state:
  // they carry base64 logos and full roster history, and everything in state is broadcast to every
  // overlay (see the broadcast-payload notes). The control panel reads them over /api/teamdb, and
  // `ver` bumps so it knows when to re-fetch.
  //   enabled    — run imports through the vault at all (off = byte-identical to the old behaviour)
  //   autoLink   — let an import create a vault record for an entrant it has never seen
  //   autoEnrich — after an import, read each linked org's start.gg TEAM page in the background for
  //                its crest and full membership. This is what makes pasting a slug optional.
  teamVault: { enabled: true, autoLink: true, autoEnrich: true, count: 0, ver: 0, lastMatch: null, enrich: null },
  game:    { blueScore: 0, orangeScore: 0, time: 300, isOT: false, number: 1 },
  gameTeams: { blue: '', orange: '', blueColor: '', orangeColor: '' },   // *Color = live in-game paint colours (RL Stats API ColorPrimary)
  players: [],          // active players (from last UpdateState)
  playerCache: {},      // all players seen (keyed by name) — for scoreboard
  currentGoal: null,    // { scorer, assister, speed, team }
  spectatedPlayer: null,
  rlConnected: false,
  rlStale: false,          // connected but no data for 15s (menu, hung feed) — see rlStaleCheck
  rlReplayLenMs: 0,     // measured goal-replay length (ReplayStart→ReplayEnd); drives the overlay's outro timing. 0 = not measured yet
  rlSpectatorUi: { ...rlSpectatorUi.DEFAULTS },
  rlLastTouch: null,    // { name, ts } — most recent ball toucher (from BallHit); fed to the AI Director
  rlPaused: false,      // live match pause state — driven by SetMatchPaused cmd + MatchPaused/Unpaused events
  startgg: {
    enabled: false,
    tournamentSlug: '',
    eventSlug: '',
    setId: '',
    connected: false,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastError: null,
    // Stream-queue auto-population: matches marked for a stream, optionally auto-pushed live.
    streams: [],           // [streamName] available on the tournament (+ the pinned one, see streamOffQueue)
    streamName: '',        // selected stream to follow ('' = first/any)
    streamOffQueue: false, // true = the chosen station currently has no sets on start.gg's queue, so
                           // it is being held from cache rather than dropped (never auto-switch station)
    autoFollowHold: null,  // { setId, nextSetId, since } while auto-follow is holding the on-air match
    queue: [],             // [{ setId, stream, round, state, teamA, teamB, live }]
    // Archive of matches that were on air / played on the followed stream this event — so the producer
    // can review what the queue held AFTER the event. Accumulated per poll, cleared on a new event.
    queueArchive: [],      // [{ setId, stream, round, teamA, teamB, scoreA, scoreB, done, ts }]
    archiveEventSlug: '',  // which event queueArchive belongs to (clear the archive when it changes)
    teamQueue: [],         // team-search results (non-admin path)
    focusTeam: '',         // team name to highlight in bracket overlay
    matchFeed: [],         // [{ setId, round, teamA, teamB, scoreA, scoreB, status, stream }] for desk tickers
    matchFeedEventSlug: '',// which event matchFeed was built for — lets pruneStaleMatchFeed() spot a feed
                           // left behind by the previous event when a poll fails after switching
    autoFollow: false,     // auto-push the in-progress set when queue polls
    // Sticky opt-out: set the moment a producer touches the Auto-follow switch (either way).
    // Activating an event used to force autoFollow back on every time, so turning it off never
    // held — the scoreboard kept re-pushing itself. Once this is true, activation leaves the
    // producer's choice alone.
    autoFollowChosen: false,
    queueEnabled: false,   // dashboard toggle — poll stream queue from Settings API config
    lastPushedSetId: null,
    queueFetchedAt: null,
    roundLabelAuto: false, // state.roundLabel came from a start.gg set (so retuneRoundLabel may re-bind
                           // it to whoever is on air). False = a producer typed/preset it — hands off.
    roundLabelSetId: null, // which set that auto label came from
    // New: selected tournament/event for pulling teams/stats (separate from savedTeams)
    selectedEvent: null,   // { tournamentSlug, eventSlug, name, tournamentName }
    eventTeams: [],        // [{ name, logo, players: [{id,name,platform,platformId,assignedCamera}], startggId }]
    logoMap: {},           // lowercased entrant name -> logo URL (so queue/upcoming/bracket can show logos)
    pendingEvents: []      // [{ slug, name, numEntrants }] when a tournament has >1 event (panel shows a picker)
  },
  // ballchasing.com — Rocket League replay stats, feeding the League feature's Ballchasing tab.
  // The API key itself lives in the module-level `ballchasingApiKey` var (like startggApiToken),
  // never here — this is just the one global setting (auto-upload) that isn't per-league.
  ballchasing: {
    connected: false,
    lastError: null,
    autoUpload: { enabled: false, folder: '', activeLeagueId: '' },
    // Manual batch tool (see replay-renamer.js) — NOT a watcher, no lifecycle to start/stop. A
    // separate folder from autoUpload's since a producer may want renaming without ever enabling
    // the continuous watcher.
    replayRename: { enabled: false, folder: '', activeLeagueId: '' }
  },
  // Liquipedia (LPDB v3). Cache-first by necessity: the API allows 60 requests per HOUR, so
  // nothing here polls — a request only happens when the producer presses Refresh, and the
  // remaining budget is surfaced so they can see what they have left mid-show.
  liquipedia: {
    enabled: false,
    wiki: 'rocketleague',   // which game wiki to query (rocketleague, counterstrike, dota2, …)
    contact: '',            // REQUIRED by Liquipedia's terms — goes in the User-Agent so they can
                            // reach the key holder. Requests are refused until it is set.
    budgetRemaining: 55,
    budgetResetInMs: 0,
    lastFetchAt: null,
    lastError: null,
    attribution: '',        // CC BY-SA 3.0 credit the overlays render (filled at boot)
    // Last normalised pulls, kept in state so a graphic can be filled without another request.
    standings: [],
    rankings: [],
    tournament: null,
    squad: []
  },
  // Riot Games API. Identity and ranked data for LoL / Valorant / TFT, using the producer's OWN
  // key from developer.riotgames.com. Nothing polls — Riot's per-key rate limit is small and a
  // development key expires daily, so every call here is a deliberate producer action.
  riot: {
    region: 'americas',    // account-v1 / match-v5 routing: americas | europe | asia | sea
    platform: 'na1',       // summoner-v4 / league-v4 / status routing: na1 | euw1 | kr | …
    keyKind: 'none',       // none | development | production — dev keys expire every 24 hours
    lastCheckAt: null,
    lastError: null,
    lastPlayer: null       // last Riot ID looked up, for the panel's result line
  },
  challonge: {
    enabled: false,
    tournamentSlug: '',    // e.g. "my-tournament" or "subdomain-tournament"
    connected: false,
    lastError: null,
    lastSyncAt: null,
    selectedTournament: null, // { id, slug, name, url, type, state, participantsCount, gameName }
    eventTeams: [],        // [{ name, logo, seed, challongeId, finalRank }]
    logoMap: {},
    queue: [],             // [{ matchId, round, identifier, state, teamA, teamB, logoA, logoB, scoreA, scoreB, live }]
    matchFeed: [],
    queueFetchedAt: null,
    autoFollow: false,
    lastAutoFollowMatchId: null
  },
  nxgen: {
    enabled: false,
    eventSlug: '',         // nxgen.pro event slug
    connected: false,
    lastError: null,
    selectedEvent: null,   // { name, slug, activity, format, status, url }
    eventTeams: [],        // [{ name, logo, nxgenId }]
    logoMap: {},           // name.toLowerCase() → logo URL
    queue: [],             // [{ matchId, round, teamA, teamB, logoA, logoB, scoreA, scoreB, status, live }]
    queueFetchedAt: null,
    // Live + recently-finished matches for the scores ticker, in the SAME shape start.gg's
    // matchFeed uses so one overlay code path renders both platforms.
    matchFeed: [],         // [{ matchId, round, teamA, teamB, logoA, logoB, scoreA, scoreB, status, winSide }]
    autoFollow: false,
    lastAutoFollowMatchId: null,
    // Which of OUR games this tournament is, resolved from Challonge's `game_name`
    // (backend/game-match.js). '' = we couldn't tell, and we then leave the active game alone
    // rather than guessing an overlay. This is what makes Challonge multi-game: without it a
    // Brawlhalla bracket loads while the app is still wearing Rocket League's overlay and labels.
    gameId: '',
    gameApplied: false,    // did loading actually switch the active game (vs. already being on it)
    // Seconds between live polls. Exposed because Challonge's FREE plan is 500 requests/MONTH and
    // every poll costs three (tournament + participants + matches) — see challongeBudget below.
    pollSec: 30,
    // Rolling request counter for the current calendar month, so a producer can see where they are
    // against that 500 before a 429 tells them on air. Not a limit we enforce — it's their quota to
    // spend — but they should be able to see it being spent.
    budget: { month: '', used: 0, limit: 500, warned: false }
  },
  // Challengermode (challengermode.com) — a DIFFERENT platform from Challonge, despite the name.
  // GraphQL API, bot-token auth, and a tournament graph of STAGES (groups then playoffs) rather
  // than one flat bracket — see backend/challengermode.js. Mirrors the Challonge state shape so
  // everything downstream (queue, ticker, bracket, auto-follow, top 8) is shared.
  challengermode: {
    enabled: false,
    tournamentId: '',      // UUID; producers paste a URL and parseChallengermodeId() digs it out
    selectedTournament: null,   // { id, name, state, gameName, gameSlug, lineupCount, url }
    connected: false,
    lastError: null,
    lastSyncAt: null,
    eventTeams: [],        // [{ id, name, logo, seed, players:[{name,captain}] }]
    logoMap: {},           // lowercased lineup name -> logo URL
    queue: [],             // same shape every other platform's queue uses
    queueFetchedAt: null,
    matchFeed: [],
    autoFollow: false,
    lastAutoFollowMatchId: null,
    // Which of OUR games this tournament is, from gameTitle.slug/title (backend/game-match.js).
    gameId: '',
    gameApplied: false,
    // Challengermode publishes no requests-per-minute limit — the API is budgeted by FIELD COST
    // instead — so this is an ordinary poll interval, not a quota dial like Challonge's.
    pollSec: 30,
    // Space (organiser) id, so "my Challengermode tournaments" can be listed without a game slug.
    spaceId: ''
  },
  // Real finish order for the loaded CHALLENGERMODE tournament. `placementText` carries the tie
  // RANGE ("5-8") that Challengermode models natively and Challonge cannot.
  challengermodePlacements: { id: '', rows: [], complete: false, fetchedAt: 0, error: '' },
  // Real finish order (1, 2, 3, 4, 5, 5, 7, 7) for the loaded CHALLONGE tournament, refreshed on
  // the live poll. The mirror image of startggPlacements — same row shape, same job: it is what
  // the top-8 board draws from. See challongePlacements().
  challongePlacements: { slug: '', rows: [], complete: false, fetchedAt: 0, error: '' },
  // FACEIT (open.faceit.com Data API v4). A "competition" is either a CHAMPIONSHIP (bracket /
  // league tournament) or a HUB (rolling ladder) — organisers use both, and the match shape is
  // identical, so competitionType picks the endpoint family and everything downstream is shared.
  faceit: {
    enabled: false,
    competitionId: '',       // championship_id or hub_id (UUID)
    competitionType: 'championship',   // 'championship' | 'hub'
    organizerId: '',         // saved organiser → "my FACEIT competitions" list in the Events tab
    organizerName: '',
    connected: false,
    lastError: null,
    selectedEvent: null,     // { name, id, type, game, region, status, url }
    eventTeams: [],          // [{ name, logo, faceitId, seed, players: [gamertag] }]
    logoMap: {},             // name.toLowerCase() → avatar URL
    queue: [],               // [{ matchId, round, teamA, teamB, logoA, logoB, scoreA, scoreB, status, live }]
    queueFetchedAt: null,
    autoFollow: false,
    lastAutoFollowMatchId: null
  },
  // Google Sheets two-way integration. Auth = a service-account key (stored encrypted in
  // sheetsServiceAccount, never broadcast — only a hasKey flag). Each data type has its own worksheet
  // tab + direction: 'off' | 'import' (sheet→app) | 'export' (app→sheet) | 'both' (import then export).
  sheets: {
    enabled: false,
    connected: false,
    sheetUrl: '',
    sheetId: '',
    title: '',             // spreadsheet title (from getMeta)
    saEmail: '',           // service-account email (shown so the producer knows who to share the sheet with)
    tabs: [],              // available worksheet names (from getMeta) — for the Tab pickers
    autoSyncSec: 0,        // 0 = manual only; else re-sync every N seconds
    lastError: null,
    lastSyncAt: null,
    lastSyncMsg: '',
    maps: {
      teams:     { direction: 'off', tab: '' },
      schedule:  { direction: 'off', tab: '' },
      // Battle-royale series. brResults = one row per (match, team); brPlayers = per-player elims.
      // Both default to 'import': the sheet is the scorekeeper's workspace, the app is the display.
      brResults: { direction: 'off', tab: '' },
      brPlayers: { direction: 'off', tab: '' },
      standings: { direction: 'off', tab: '' }
    }
  },
  activeEvent: {
    platform: null,      // 'startgg' | 'challonge' | 'challengermode' | 'nxgen' | 'faceit' | null
    slug: '',
    name: '',
    gameName: '',
    numEntrants: 0,
    format: '',
    url: '',
    logo: '',            // the event's own logo from its platform (start.gg tournament/event profile image, FACEIT avatar, NXGEN image)
    loadedAt: null
  },
  // The OBS stinger transition the REPLAYS page is set to use, remembered across restarts so the
  // player can fetch the same sting video for clip-to-clip advances without re-querying OBS first.
  obsStinger: { name: '', path: '', point: 0, lengthMs: 0 },
  obs: {
    enabled: false,
    connected: false,
    // Which streaming app fills the OBS slot: 'obs' (obs-websocket) or 'streamlabs' (Streamlabs
    // Desktop's Remote Control API, backend/integrations/slobs-client.js). Every OBS feature routes
    // through the same client interface, so the rest of the app doesn't care which one it is.
    app: 'obs',
    url: 'ws://127.0.0.1:4455',
    slobsUrl: 'ws://127.0.0.1:59650',
    autoSwitch: true,
    // The app NEVER switches the producer's OBS profile or scene collection — removed 2026-08.
    autoReplayOnGoal: false,   // save an OBS replay-buffer clip on every goal
    lastError: null,
    postGameToCastersSec: 0,  // auto-switch post-game → casters after N seconds (0 = off)
    kickoff: { enabled: false, scene: '', transition: '' },  // smart trigger: auto-cut to this scene at the 3-2-1 kickoff countdown
    scoreboardScene: { enabled: false, scene: '', transition: '' },  // RL: at MATCH END, cut to a dedicated scoreboard scene (the first post-game cut, before the After-Scoreboard cut)
    postGame: { enabled: false, scene: '', delaySec: 20, transition: '' },  // RL: after the post-game scoreboard shows for delaySec, cut to this scene
    availableScenes: [],
    availableTransitions: [],
    audioInputs: [],     // [{ name, muted, volumeDb }] — live mixer inventory for the on-air audio pills
    sources: [],         // [{ scene, source, enabled }] — scene items for the source show/hide pills
    currentScene: '',    // live OBS PROGRAM scene = what viewers see (authoritative "on air")
    currentPreviewScene: '',  // Studio Mode preview scene (the Switcher page's "next")
    studioMode: false,        // OBS Studio Mode on/off (needed for preview/program + TAKE)
    scenes: {            // OBS scene name to switch to for each broadcast moment
      inGame: '',
      replay: '',
      postGame: '',
      break: '',
      commercial: '',    // dedicated ad-break scene that plays commercial videos
      casters: '',
      bracket: ''
    },
    commercialAutoReturn: true,  // auto-cut back to program when the commercial video ends
    replayBufferActive: false,   // live status from OBS ReplayBufferStateChanged
    replayBufferAvailable: null  // false = Replay Buffer is switched off in OBS Settings > Output (only the producer can change it)
  },
  // vMix — the FULL ALTERNATIVE production backend to OBS (either/or, never both). HTTP Web API
  // (default :8088) polled for live state; functions fired by flows + the switcher. See
  // docs/vmix-integration.md. state.switcher.target picks which backend is live.
  vmix: {
    enabled: false,
    connected: false,
    host: '127.0.0.1',
    port: 8088,
    lastError: null,
    version: '',
    edition: '',
    active: null,        // program input number
    preview: null,       // preview input number
    streaming: false,
    recording: false,
    inputs: [],          // [{ number, key, type, title, state }]
    overlays: []         // [{ number, input }] — overlay channels 1-4
  },
  // Which production switcher is live. Mutually exclusive — vMix is a full alternative to OBS.
  switcher: { target: 'obs' },   // 'obs' | 'vmix'
  // Runtime (not persisted): are we currently in a commercial, and where to return.
  commercial: { active: false, returnScene: '' },
  // Featured chat message lower third (overlay/chat-highlight.html) — click a message
  // in the panel's multichat feed to put it on stream. Runtime-only, tiny live-tier key.
  chatHighlight: { visible: false, platform: 'twitch', user: '', color: '', text: '', kicker: '', ts: 0 },
  // Multichat sources beyond Twitch: Kick (public, just a channel slug) + Discord (bot
  // token + channel). Persisted to multichat-data.json; the token is never in full_state.
  multichat: { kickChannel: '', discordChannelId: '', discordBotToken: '' },
  // Q&A mailbag — questions pulled from a Discord channel, captured by keyword out of any
  // chat source, grabbed off a chat row, or typed in with whichever social they came from.
  // Persisted to questions-data.json; library tier (panel-only, never rides live broadcasts).
  questions: {
    list: [],   // see backend/questions.js for the shape
    settings: {
      discordChannelId: '',   // dedicated #questions channel (separate from the multichat one)
      keyword: '!ask',        // prefix that promotes a chat message to a question
      keywordEnabled: true,
      duration: 30            // seconds a question stays on air (0 = until cleared)
    }
  },
  // Cross-platform (Twitch+Kick+YouTube) chat game — every viewer's marble races a 3D obstacle
  // course. A TOP-LEVEL sibling of `twitch` below, not nested inside it, since it's explicitly not
  // Twitch-specific. Owned/mutated by marbleRaceManager (backend/integrations/marble-race.js).
  marbleRace: {
    status: 'idle',            // idle | entry | locked | finished
    entryEndsAt: null,         // epoch ms — overlays compute their own local countdown, no server ticks
    autoEnterViewers: false,   // pull the live Twitch chatters list at lock time (Twitch-only — Kick/YouTube have no such API)
    customViewers: [],         // producer-typed extra names, always entered regardless of platform
    participants: [],          // [{platform, userId, username, source: 'chat'|'auto'|'custom'}]
    droppedCount: 0,           // how many entrants were randomly dropped for exceeding the participant cap (never silent)
    race: null,                // { keyframes, winner, durationMs } — set once, on lock
    result: null,              // { winnerParticipant } — set once, after the race finishes
    history: []                // capped ring buffer of recent rounds
  },
  bracket: {
    visible: false,
    eventSlug: '',
    followActive: true,   // auto-point at the ACTIVE event (Dashboard ▸ Event); false = producer typed an explicit slug
    title: '',
    subtitle: '',         // small header line under the title — mainly used by the League source
    showRecord: true,     // show/hide W-L columns on the standings table (League source toggle)
    // How the current phases were populated. 'imported' = a platform feed owns the data and the
    // live-refresh tick may overwrite it; 'manual' = the in-app builder owns it and NOTHING external
    // should clobber it. Prevents the old silent collision where a manual edit wiped an import (and
    // vice-versa). source names the platform for 'imported'. Default '' = empty/no bracket yet.
    mode: '',            // '' | 'imported' | 'manual'
    source: '',          // '' | 'startgg' | 'challonge' | 'challengermode' | 'nxgen' | 'faceit'
    type: '',            // SINGLE_ELIMINATION | DOUBLE_ELIMINATION | ROUND_ROBIN | SWISS (mirrors active phase)
    winners: [],         // [{ name, round, sets: [{ a:{name,score,winner}, b:{...} }] }] (mirrors active phase)
    losers: [],
    finals: [],
    standings: [],       // [{ placement, name, wins, losses }] for round-robin / swiss (mirrors active phase)
                         // NOTE: for an ELIMINATION phase these are ordered by set wins, not by
                         // finish — use startgg.placements for a real top 8.
    schedule: [],        // [{ name, round, sets: [{a,b}] }] round-by-round pairings, round-robin/swiss only
    roster: [],          // round-robin/swiss entrant names (mirrors active phase)
    matches: [],         // [{ id, round, a, b, state }] flat picker list
    // Multi-phase events (e.g. Day 1 double-elim → Day 2 single-elim/swiss).
    // Each phase: { id, name, type, winners, losers, finals, standings, schedule, roster, pools }.
    // Each phase also has pools: [{ id, name, type, roster, schedule, standings, matrix }] — one
    // entry per Start.gg phaseGroup (Pool 1, Pool 2, ...); single-pool phases still get one entry
    // so winners/losers/finals/standings/schedule/roster below always mirror pools[0].
    // Top-level winners/losers/finals/standings/type/schedule/roster mirror the ACTIVE phase's
    // ACTIVE POOL so the existing overlay keeps working unchanged.
    phases: [],
    activePhaseId: '',
    pools: [],           // [{ id, name }] lightweight list of the active phase's pools, for the pool selector
    activePoolId: '',
    matrix: null,        // { teams:[{id,name}], cells:{ "idA_idB": {aScore,bScore,winner} } } — Round Robin pools only
    view: 'both',        // overlay view: both | winners | losers | finals | schedule | standings | matrix | swiss | group
    rounds: 4,           // for view='finals' — how many last round-columns of each bracket to show
    // Swiss stage thresholds (view='swiss'): wins that qualify / losses that eliminate. 0 = let
    // the overlay derive them from the round count (5 rounds → 3/3, the standard swiss shape).
    // swissAdvance doubles as the group board's qualification cut line.
    swissAdvance: 0,
    swissEliminate: 0,
    // Swiss tier palette (green advance / amber mid / red elimination / blue opening round).
    // Off = one neutral slate for every bucket, for packages that don't want four accent
    // colours on air. Render-time only; the tiering itself is unchanged.
    swissColors: true,
    ignoreReset: false,  // hide the grand-final RESET match (render-time display filter)
    ignoreRounds: 0,     // hide the first N rounds of the bracket (render-time display filter; 0 = show all)
    hideLogos: false,    // render team names only — no logos/abbrev badges (render-time display filter)
    logoWatermark: true, // draw each team's crest behind their name at low opacity (render-time display filter)
    // How strong that watermark is, in PERCENT. 7 is the tuned default (see .bk-slot-wm); a dark
    // stream or a busy background wants more, a pale brand less — so it is the producer's to set
    // rather than a constant in the overlay. 0 hides it, same as logoWatermark:false.
    watermarkOpacity: 7,
    lastFetchAt: null,
    lastError: null
  },
  upcoming: {
    visible: false,
    title: 'SCHEDULE',
    eyebrow: 'On Deck',    // small label above the title (board layout uses title as e.g. "WEEK 11")
    layout: 'cards',       // 'cards' = duorow card row | 'board' = weekly matchup board (team-colored bars)
    // 'event' = follow the stream queue (marked-as-stream matches + a couple non-stream upcoming);
    // 'team' = the searched team's own matches. Set by which Stream Queue tab / fetch is used.
    source: 'event',
    showResults: false,   // keep FINISHED matches on the board with their final series score (else hidden)
    matches: []   // manual entries/overrides: [{id,round,teamA,teamB,teamALogo,teamBLogo,date,time,stream,scoreA,scoreB,week,note}]
  },
  // Real finish order (1, 2, 3, 4, 5, 5, 7, 7) for the linked start.gg event, refreshed on the
  // regular poll. This is what the Smash top-8 board draws from — see fetchEventPlacements().
  // rows: [{ placement, name, entrantId, character }] — character is start.gg's REPORTED
  // per-game selection (blank when the event never reported one). reportedCharacters counts how
  // many of the top 8 came back with one, so the panel can say why a board came up empty.
  startggPlacements: { slug: '', rows: [], complete: false, fetchedAt: 0, error: '',
                       reportedCharacters: 0, charError: '', charShape: '', setsScanned: 0 },
  // The character each side has most often REPORTED at this event. start.gg has no live "playing
  // right now" feed — selections only exist once a game is reported — so this is a prior for the
  // matchup card, never live truth. A fighter set by hand in Match > Teams always wins over it.
  startggCharacters: { blue: '', orange: '', fetchedAt: 0 },
  standings: {
    visible: false,
    title: '',    // '' = inherit bracket.title; auto-populated from bracket.standings if rows is empty
    subtitle: '', // optional line under the title (e.g. "Week 4 · Group A" or a season label)
    showRecord: true, // false = hide the W/L columns (clean points-only leaderboard)
    // Where the rows came from, and the credit line the overlay must show with them. Liquipedia
    // content is CC BY-SA 3.0 — attribution is a licence condition, not a nicety, so it travels
    // with the data rather than being something the producer can forget to switch on.
    attribution: '',   // (source is declared below — it was declared twice, and the later 'auto' always won)
    // How standings.html draws the board:
    //   'podium'    — the default pedestal top-3 + table
    //   'placement' — the SMASH top-8 placement card wall (fighter art per row, sized by rank)
    //   'auto'      — 'placement' for Smash, else 'podium'
    // 'placement' is Smash-ONLY: standings.html gates it on the game's 'stocks' feature, so a
    // board left on this layout falls back to the podium the moment another game is active.
    layout: 'auto',
    source: 'auto',   // 'auto' (bracket/start.gg) | 'league' | 'startgg-league' | 'manual' — informational; rows always win
    // Which in-app league the 'league' source follows. Rows used to be a one-shot snapshot taken at
    // push time, so our own points went stale on air the moment a result was recorded — this lets
    // the server re-mirror the league's live standings (see refreshLeagueStandingsMirror).
    leagueId: '',
    rows: []      // manual override: [{placement,name,logo,wins,losses,points}]
  },
  // Dedicated league season-stats board (overlay/league-stats.html) — pushed from the Leagues ▸ Stats
  // tab. columns describe the grouped table (Series / Games / In-game tiers); rows carry each team's
  // values keyed by column key. Distinct from `standings` (the podium leaderboard).
  leagueStats: {
    visible: false,
    title: '',
    subtitle: '',
    columns: [],  // [{ key, label, group }]
    rows: []      // [{ name, logo, color, values:{ <key>:number } }]
  },
  // Producer-armed capture of a SPECTATED match's result into a league fixture. While active, each
  // finished game's score is appended to games[] (mapped so A = the fixture's teamA regardless of
  // which live side that is); when the series clinches (or the producer saves) it writes the series
  // score + per-game breakdown into the league match and recalculates standings. Runtime-only.
  leagueCapture: { active: false, leagueId: '', matchId: '', aSide: 'blue', teamA: '', teamB: '', bestOf: 5, games: [], startedAt: 0, lastNote: '' },
  // The loaded Nameless website event (siteEventState): auto-follow its live match, report scores back.
  siteEvent: { id: '', leagueId: '', autoFollow: true, autoReport: true, matchId: '', lastReport: '', lastReportOk: true },
  // Ballchasing per-player leaderboard board — same generic {columns,rows} shape as leagueStats,
  // kept as its own overlay/state pair so the team board and the leaderboard can run as two
  // independent OBS sources at once.
  leagueLeaderboard: {
    visible: false,
    title: '',
    subtitle: '',
    columns: [],
    rows: []
  },
  // Season / league record shown under each team name on the top scorebar overlay.
  // Source priority: per-team manual league standings (W/L/PTS) for season + points +
  // placement; live start.gg event standings for "this week" W/L. Resolved per-broadcast
  // in buildLiveState() into a tiny teamRecords:{blue,orange} blob — see resolveTeamRecords().
  //   metric: 'season' | 'week' | 'pts' | 'place' | 'record-pts'
  //   source: 'stats' (in-app leagues) | 'startgg' (tournament platform) | 'manual' (per-team below)
  //   manualByName: per-TEAM W/L (+ optional pts/place) keyed by lowercased team name, so a hand-set
  //     record is tied to the team PROFILE — it follows the team across side swaps and reassignments.
  //     (Legacy `manual: {blue,orange}` is migrated into this on load.)
  teamRecord: {
    enabled: false, metric: 'season', source: 'stats', leagueId: '',   // leagueId = chosen in-app league for the 'stats' source ('' = auto-pick)
    week: '',   // 'stats' source only — which lg.schedule week feeds weekW/weekL ('' = auto: latest fully-completed week)
    manual: { blue: { w: 0, l: 0, pts: null, place: null }, orange: { w: 0, l: 0, pts: null, place: null } },
    manualByName: {}
  },
  // When on, team names reported by the live game (CS2 GSI / RL Stats API) are matched to the
  // saved-teams library and applied to Blue/Orange (name + logo + colour). Generic names ignored.
  autoTeamsFromGame: false,
  // Season-long standings pulled from a start.gg LEAGUE (e.g. "3v3 Rocket Rush x Trophi.ai
  // Season 2") — DISTINCT from in-app manual leagues and from per-tournament standings. A
  // start.gg League aggregates many tournaments into one season with league points; we read
  // Standing.totalPoints + placement per entrant. This is the authoritative source for the
  // overlay's season points/placement (teamRecord); W/L still comes from in-app leagues.
  startggLeagueStandings: {
    slug: '',          // start.gg league slug or full URL (normalized on fetch)
    name: '',          // resolved league name
    fetchedAt: null,
    lastError: null,
    teams: []          // [{ name, place, points }] (sorted by placement)
  },
  // Which production graphic is currently showing in the unified gfx.html overlay.
  // null = nothing showing. Values match SCENE_META keys: 'break','winner','intro','ticker', etc.
  gfxActive: null,
  scenePresets: {},   // { [sceneKey]: { active: string, presets: { [name]: { label, config: { accent, accent2, font } } } } }
  // "Teams to Watch" spotlight graphic — a small set of teams the producer marks on an event,
  // each with custom fields (CURRENT RANK / POINTS / …). Team logos are resolved by name in the
  // overlay (savedTeams / start.gg logo map) so this stays tiny in the broadcast.
  watchlist: {
    visible: false,
    title: 'TEAMS TO WATCH',
    subtitle: '',                          // smaller line under the title (auto = the start.gg event name)
    logo: '',                              // optional header/event logo (URL or small image)
    fields: [{ id: 'rank', label: 'CURRENT RANK' }],   // custom columns shown per team
    teams: []                              // [{ id, name, players:[gamerTag], values:{ fieldId }, pos:0 }] (pos 1 = podium centre)
  },
  // Single-team deep-dive spotlight. Team-level data (seed/placement/record/recent+next sets) is
  // auto-pulled from start.gg for the entrant; per-player shows the seeding rank by default and
  // live GSI stats (RL/CS2/Valorant) when this team is the one on-air.
  teamSpotlight: {
    visible: false,
    name: '', eventSlug: '', entrantId: '',
    players: [],   // [{ gamerTag, name, seedRank }]
    sg: { seed: null, placement: null, record: { w: 0, l: 0 }, recent: [], next: null },
    lastSync: 0, syncError: ''
  },
  director: {
    enabled: true,
    sensitivity: 0.5,
    lockTarget: null,
    autoSwitch: false,
    primary: null,
    alternates: [],
    feed: [],
    confidence: 0,
    learning: null,
    lastAutoSwitch: null
  },
  // AI master controls. `shield` = panic kill-switch: when true, ALL AI automations are
  // blocked (director auto-switch, auto-clipping, OBS auto-switch, auto-replay, smart triggers).
  // Recommendations still display; nothing acts on its own. Reversible — your toggles are kept.
  ai: {
    shield: false,
    // enabled = local decision logging for training (Phase 0). uploadEnabled = separate,
    // explicit opt-in to also batch those local records to the shared cloud dataset (Phase 2) —
    // default OFF; only runs when uploadEnabled AND cloud-authed. lastUploadAt/lastUploadCount
    // are status feedback for the UI, not producer-set.
    telemetry: { enabled: true, uploadEnabled: false, lastUploadAt: null, lastUploadCount: 0 }
  },
  clips: {
    library: [],
    montages: [],
    // How highlight events are clipped: 'auto' (clip silently), 'prompt' (ask the
    // producer with a pop-up), or 'manual' (only the Capture button). autoCapture
    // mirrors mode==='auto' for back-compat with the manager.
    // OPT-IN by default ('manual'): auto-clipping silently STARTS and SAVES OBS's replay buffer on
    // every director event (goals/saves/demos), which surprised a producer who never enabled it and
    // couldn't tell why their buffer kept saving ("triggers at random times even though I have it
    // off"). Same rule as no-auto-ads: the app must not drive OBS on its own until the producer opts
    // in (Production ▸ NEURAL AI ▸ clip mode → Auto/Prompt).
    captureMode: 'manual',
    autoCapture: false,
    autoMontage: false,       // auto-add captured clips to the live montage
    autoMontageId: null,
    replayFolder: '',
    captureRules: {
      goal: true, ace: true, clutch: true, save: true, multi_kill: true, defuse: true,
      kickoff: false, demo: false, shot: false
    }
  },
  encode: { queue: [], active: null },
  // Built-in info commands the chat bot answers automatically (!bracket / !discord / !casters).
  // bracket + casters resolve from LIVE state (active event, Show Deck lineup); the Discord invite
  // is show-wide config, so it lives here rather than on activeEvent (which is replaced per event).
  chatCommands: { enabled: true, discord: '' },
  twitch: {
    connected: false,
    adsEnabled: true,   // producer gate for running Twitch ads (persisted, enforced in /ad/run)
    channelId: '',
    userId: '',
    displayName: '',
    apiToken: '',
    refreshToken: '',
    webhookSecret: process.env.TWITCH_WEBHOOK_SECRET || (() => {
      if (!IS_DEV()) console.warn('[Twitch] TWITCH_WEBHOOK_SECRET not set — using insecure fallback. Set it in .env');
      return 'dev-secret';
    })(),
    webhookUrl: process.env.TWITCH_WEBHOOK_URL || 'http://localhost:3000/api/twitch/webhooks',

    predictions: {
      enabled: true,
      current: null,
      history: [],
      lastAuto: null,   // { kind:'created'|'resolved'|'skip'|'error', message, ts } — last auto-prediction attempt (diagnostics surfaced in the panel)
      settings: {
        autoCreate: false,
        template: 'generic',
        cooldown: 300000,
        overlayLoop: 30,      // seconds the looped overlay stays SHOWN per cycle
        overlayHide: 8,       // seconds the looped overlay stays HIDDEN between cycles
        overlayHidden: false, // producer force-hide — show/hide the card on stream during a game
        hideInReplay: false   // auto-hide while a Rocket League goal replay is playing (state.inReplay)
      }
    },

    wheel: {
      current: null,
      prizes: [
        { id: 'prize-1', name: 'Sub Gift', color: '#FF6B6B', weight: 1 },
        { id: 'prize-2', name: '$25 Amazon', color: '#4ECDC4', weight: 1 },
        { id: 'prize-3', name: 'Game Copy', color: '#FFE66D', weight: 2 }
      ],
      participants: [],
      history: [],
      settings: {
        duration: 8000,
        requireLiveView: false,
        entryMethod: 'follow'
      }
    },

    minigame: {
      current: null,
      games: [],
      history: [],
      settings: {
        enabled: true,
        defaultDuration: 30000,
        breakScreenGameType: 'trivia',
        pointReward: 500
      }
    },

    chat: {
      recentMessages: [],
      activeParticipants: []
    },

    chatSettings: {},
    chatConnected: false,
    chatChannel: '',

    automations: {
      announceOnMatchStart: '',
      announceOnMatchEnd: ''
    },

    poll: {
      current: null,
      history: []
    },

    adBreak: {
      active: false,
      duration: 0,
      startedAt: null,
      endsAt: null,
      isAutomatic: false
    },
    activityLog: []
  },

  discord: {
    connected: false,
    userId: '',
    username: '',
    discriminator: '',
    globalName: '',
    avatarUrl: '',
    accessToken: '',
    refreshToken: '',
    lastError: ''   // why the last OAuth attempt failed (surfaced in the panel + login poll)
  },

  // ─── Flows (production automation) ─────────────────────────────────────────
  // Each flow: { id, name, enabled, triggerMode: 'any'|'sequence', triggers: [...], actions: [...], cooldown }
  // Triggers: { id, type, params, timeout (sequence mode only) }
  // Actions:  { id, type, params }
  flows: [],
  // Named key/value pairs set by set_variable/increment_variable actions; used in {{token}} substitution
  flowVars: {}
};

let directorEngine = null;
let clipSystem = null;
let telemetry = null;            // AI decision recorder (Phase 0)
let _directorRecShownAt = 0;     // when the current primary rec was first emitted (for decision latency)
let _lastRecTargetId = null;     // de-dupe the shadow recommendation stream
let overlayEditor = null;
let onEncodeProgressCallback = null;
let _launcherLaunchCb = null;   // main.js: swap the launcher window for the studio window
let _launcherResizeCb = null;   // main.js: resize the launcher window (license view needs room)
// First sign-in after approval: the backend refused login pending the license signature.
// Holds { token, license: {version,title,preamble,sections} } until accepted or logout.
let _pendingContract = null;
let onRlSpectatorUiHotkeyChange = null;
let lastGenericDirectorFeed = 0;

let savedTeams = [];   // [{ name, logo }]
let savedFacecams = []; // [{ name, platformId, link }]
let savedPresets = [];  // [{ id, name, game, config }] — broadcast config presets
// Client/production identities. Selecting one recolors overlays + loads its sellable sponsor set.
let savedBrandKits = []; // [{ id, name, logo, color, accent, font, sponsorLabel, sponsorInterval,
                         //    sponsors: [{ id, name, logo, tier }], themes: { [gameId]: themeId } }]
// Monotonic version bumped on EVERY brand-kit mutation (via saveBrandKits). librarySig() and the
// client's renderBrands signature key off it so the brand library re-broadcasts + the editor's
// closures refresh on ANY change — the old length/count hash missed reorders, tier changes,
// same-length renames and edits to non-active packages, which made sponsor edits silently revert.
let brandKitsVer = 0;
let savedTeamsVer = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Pretty-printed JSON.stringify(data, null, 2) is roughly 1000x more stack-hungry per nesting
// level than the plain (no-indent) form — confirmed by direct benchmark: the indented form
// RangeErrors ("Maximum call stack size exceeded") around ~5,000 levels deep, where plain
// stringify tolerates 5,000,000+. A producer hit exactly this (v0.4.0, "call stack limit
// reached", start.gg silently stopped updating afterward) — real production data can carry
// enough nesting to cross that gap even though it's nowhere near truly pathological. Retry
// without indentation rather than losing the save/broadcast entirely; only a RangeError falls
// back (any other error — e.g. a genuine circular ref, which JSON.stringify itself already
// reports as a distinct TypeError — still propagates to the caller's own diagnostics).
function _stringifyForSave(data) {
  try { return JSON.stringify(data, null, 2); }
  catch (e) {
    if (!(e instanceof RangeError)) throw e;
    console.warn('[save] pretty-printed JSON.stringify hit the stack limit — retrying compact:', e.message);
    return JSON.stringify(data);
  }
}

// Atomic write: write to .tmp then rename so a crash mid-write never corrupts the live file.
// The server runs INSIDE the Electron main process, so the default path is ASYNC — a
// synchronous writeFileSync here stalls the window (clicks drop, UI freezes). Overlapping
// writes to the same file are coalesced to the latest data so the single .tmp never races.
// Pass sync=true only for the shutdown flush, where the write must finish before exit.
const _writingFiles = new Set();
const _pendingWrites = new Map();
function safeWriteJson(filePath, data, sync = false) {
  if (sync) {
    const tmp = filePath + '.tmp';
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, _stringifyForSave(data));
    fs.renameSync(tmp, filePath);
    return;
  }
  if (_writingFiles.has(filePath)) { _pendingWrites.set(filePath, data); return; }
  // Stringify BEFORE taking the write lock — a throw here used to leave the path locked, so every
  // later save only queued and the file was never written again that session.
  const json = _stringifyForSave(data);
  _writingFiles.add(filePath);
  const tmp = filePath + '.tmp';
  const done = () => {
    _writingFiles.delete(filePath);
    if (_pendingWrites.has(filePath)) {
      const next = _pendingWrites.get(filePath);
      _pendingWrites.delete(filePath);
      safeWriteJson(filePath, next, false);
    }
  };
  fs.mkdir(path.dirname(filePath), { recursive: true }, (mkErr) => {
    if (mkErr) { console.error('[save] mkdir', filePath, mkErr.message); return done(); }
    fs.writeFile(tmp, json, (wErr) => {
      if (wErr) { console.error('[save] write', filePath, wErr.message); return done(); }
      fs.rename(tmp, filePath, (rErr) => { if (rErr) console.error('[save] rename', filePath, rErr.message); done(); });
    });
  });
}

// Safe load: if the primary file is corrupt, fall back to the .bak written on last successful load.
function safeReadJson(filePath, fallback) {
  for (const candidate of [filePath, filePath + '.bak']) {
    try {
      if (fs.existsSync(candidate)) {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        // On first successful parse of the primary, write a backup.
        if (candidate === filePath) {
          try { fs.copyFileSync(filePath, filePath + '.bak'); } catch (_) {}
        }
        return parsed;
      }
    } catch (_) {}
  }
  return fallback;
}

// ── Secret-at-rest encryption (OBS password, start.gg/Challonge/NXGEN keys, Twitch/Discord
// OAuth tokens) — these previously landed in state.json / twitch-data.json / discord-user.json
// as plaintext. safeStorage encrypts with the OS keychain (DPAPI/Keychain/libsecret), so the
// files are unreadable outside this machine+user even if copied. The 'enc:' prefix marks the
// new format; unprefixed strings are legacy plaintext from a pre-migration state.json and are
// read as-is, then re-saved encrypted on the next write. Falls back to plaintext (with a
// warning) only if the OS has no keychain available (e.g. a headless/no-keyring Linux box) —
// better to keep working than to lose saved credentials.
// 'enc:' = OS keychain; 'enc2:' = AES with a keychain-protected key (written by the server's own
// process while the keychain answer is on its way). See backend/host-services.js.
function encryptSecret(plain) { return electronApi.secrets.encrypt(plain); }
function decryptSecret(stored) { return electronApi.secrets.decrypt(stored); }

// ── WS bridge auth token ─────────────────────────────────────────────────────
// The :3001 bridge accepts a `?token=` query param on every connection (control panel,
// overlay browser sources, anything else). Loopback-only by default, so this mainly
// guards the opt-in WS_HOST=0.0.0.0 (multi-PC) case — without it, anyone who can reach
// the port gets full unauthenticated read+control of the broadcast. Generated once and
// persisted (not part of state.json / Producer Profile exports) so it survives restarts
// but doesn't leak into a shared/exported profile.
function getOrCreateWsToken() {
  try {
    const existing = safeReadJson(wsTokenFile, null);
    if (existing && typeof existing.token === 'string' && existing.token.length >= 32) return existing.token;
  } catch (e) {}
  const token = require('crypto').randomBytes(24).toString('hex');
  try { safeWriteJson(wsTokenFile, { token }, true); } catch (e) { console.error('[bridge] failed to persist WS token:', e.message); }
  return token;
}

function loadTeams() {
  savedTeams = safeReadJson(teamsFile, []);
}

function saveTeams() {
  savedTeamsVer++;
  try { safeWriteJson(teamsFile, savedTeams); } catch (e) { console.error('Error saving teams:', e); }
  if (typeof syncProfileToCloud === 'function') syncProfileToCloud();
}

// The account id a facecam matches on. Older rows stored the whole RL PrimaryId ('Steam|123|0')
// or a placeholder ('0', 'Unknown|0|0' for bots and hidden accounts, shared by many players and
// so never a key); both are reduced here to the bare id or ''.
function cleanFacecamId(v) {
  let s = (v == null ? '' : String(v)).trim();
  if (s.includes('|')) s = (s.split('|')[1] || '').trim();
  return (!s || /^0*$/.test(s) || /^unknown$/i.test(s)) ? '' : s;
}
function loadFacecams() {
  savedFacecams = safeReadJson(facecamsFile, []);
  let fixed = 0;
  (Array.isArray(savedFacecams) ? savedFacecams : []).forEach((f) => {
    if (f && f.platformId != null && cleanFacecamId(f.platformId) !== f.platformId) { f.platformId = cleanFacecamId(f.platformId); fixed++; }
  });
  if (fixed) { try { safeWriteJson(facecamsFile, savedFacecams); } catch (e) {} console.log('[facecams] cleared ' + fixed + ' placeholder ids'); }
}

function saveFacecams() {
  try { safeWriteJson(facecamsFile, savedFacecams); } catch (e) { console.error('Error saving facecams:', e); }
  if (typeof syncProfileToCloud === 'function') syncProfileToCloud();
}

function loadPresets() {
  savedPresets = safeReadJson(presetsFile, []);
}

function savePresets() {
  try { safeWriteJson(presetsFile, savedPresets); } catch (e) { console.error('Error saving presets:', e); }
}

function loadBrandKits() {
  savedBrandKits = safeReadJson(brandsFile, []);
  savedBrandKits.forEach(ensureKitPackages);   // wrap legacy top-level sponsor/banner config into a package
}

let _bkSaveTimer = null;
function saveBrandKits() {
  clearTimeout(_bkSaveTimer); _bkSaveTimer = null;   // an immediate save satisfies any pending deferred one
  brandKitsVer++;   // any persisted brand-kit change forces a library re-broadcast (see brandKitsVer)
  try { safeWriteJson(brandsFile, savedBrandKits); } catch (e) { console.error('Error saving brand kits:', e); }
  if (typeof syncProfileToCloud === 'function') syncProfileToCloud();
}
// Deferred variant for edits that arrive per KEYSTROKE (Desk Show topics/headline are stored on the
// active brand package). saveBrandKits() writes the whole brands.json — megabytes once a producer has
// real kits — AND bumps brandKitsVer, which re-broadcasts the brand-kit library to every connected
// client. Doing both 16 times while someone types one topic is what made the Graphics panel crawl.
// The edit still lands in state immediately (state.preshow is live-tier and broadcasts as usual);
// only the disk write + library re-send wait for a pause in typing.
function saveBrandKitsSoon() {
  if (_bkSaveTimer) return;
  _bkSaveTimer = setTimeout(() => { _bkSaveTimer = null; saveBrandKits(); }, 1200);
}
function flushBrandKitsSave() { if (_bkSaveTimer) saveBrandKits(); }

// Mirror a match team's roster into the saved-team library so roster edits made in the Match — Teams
// panel actually persist. Matches the library entry by NORMALIZED name (trim + case-insensitive) —
// the panel uppercases the match name (applyTeam), so an exact match against the saved "Team Alpha"
// used to silently fail. CREATES the library entry when missing, so a team typed/imported into the
// match (never saved before) still saves. Field-preserving: keeps saved-only per-player data (country,
// links, etc.) and layers the live edits on top. Skips placeholder/unnamed sides.
function persistRosterToLibrary(side) {
  const t = state.teams[side];
  if (!t) return;
  const name = (t.name || '').trim();
  const low = name.toLowerCase();
  if (!name || low === 'blue' || low === 'orange') return;
  let saved = savedTeams.find((s) => (s.name || '').trim().toLowerCase() === low);
  if (!saved) { saved = { name, logo: t.logo || null, players: [] }; savedTeams.push(saved); }
  const prev = Array.isArray(saved.players) ? saved.players : [];
  saved.players = (t.players || []).map((p) => {
    const old = (p.id && prev.find((o) => o.id === p.id))
             || (p.name && prev.find((o) => (o.name || '').trim().toLowerCase() === (p.name || '').trim().toLowerCase()));
    return old ? { ...old, ...p } : { ...p };
  });
  if (t.logo && !saved.logo) saved.logo = t.logo;
  saveTeams();
}

// ─── Shared zip-bundle asset helpers ────────────────────────────────────────
// Generic, schema-agnostic: any exported bundle (Producer Profile, Game Config, ...) can be
// packaged as a zip without hand-listing which fields are images. Every base64 image data-URI
// found anywhere in the object tree becomes a real file inside the zip; the in-memory/JS shape
// (base64 data URIs) never changes for any existing consumer — the zip is purely a transport format.
const ZIP_ASSET_DATA_URI_RE = /^data:image\/([a-zA-Z0-9+.-]+);base64,([\s\S]+)$/;
const ZIP_ASSET_PREFIX = 'zipasset:';
const ZIP_ASSET_MIME_EXT = { jpeg: 'jpg', 'svg+xml': 'svg' };

// Deep-clones obj; every base64 image data-URI string found anywhere in the tree is decoded to a
// Buffer, added to the zip at assets/img-<n>.<ext>, and replaced in the clone with a
// 'zipasset:assets/img-<n>.<ext>' sentinel string. Returns the clone (safe to JSON.stringify as
// manifest.json) — never mutates obj or the zip's caller-visible state beyond the added entries.
function extractAssetsToZip(obj, zip) {
  let counter = 0;
  const walk = (v) => {
    if (typeof v === 'string') {
      const m = v.match(ZIP_ASSET_DATA_URI_RE);
      if (!m) return v;
      const mime = m[1].toLowerCase();
      const ext = ZIP_ASSET_MIME_EXT[mime] || mime.replace(/[^a-z0-9]/g, '') || 'bin';
      const rel = `assets/img-${++counter}.${ext}`;
      zip.addFile(rel, Buffer.from(m[2], 'base64'));
      return ZIP_ASSET_PREFIX + rel;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return walk(obj);
}

// Inverse of extractAssetsToZip: deep-clones obj (a parsed manifest.json), replaces every
// 'zipasset:...' sentinel with the re-encoded data: URI read from that path in the zip.
function inflateAssetsFromZip(obj, zip) {
  const walk = (v) => {
    if (typeof v === 'string' && v.startsWith(ZIP_ASSET_PREFIX)) {
      const rel = v.slice(ZIP_ASSET_PREFIX.length);
      const entry = zip.getEntry(rel);
      if (!entry) return v;   // missing asset — leave the sentinel rather than fabricate an image
      const ext = (rel.split('.').pop() || '').toLowerCase();
      const mime = ext === 'jpg' ? 'jpeg' : (ext === 'svg' ? 'svg+xml' : ext) || 'png';
      return `data:image/${mime};base64,${entry.getData().toString('base64')}`;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return walk(obj);
}

// ─── Producer profile export / import ──────────────────────────────────────
// A single portable file holding a producer's whole SETUP — teams, brand kits,
// facecams, presets, leagues, caster library, and overlay/look settings — so it
// can be shared with staff before cloud sync exists. Deliberately EXCLUDES secrets
// and machine-specific state: no Twitch/Discord/OBS tokens or passwords, no live
// scores, no local file paths. Sharing a profile never leaks credentials.
// Items pulled FROM the org are tagged _org — never re-export them (they belong to their author's
// profile and come back on the next pull; including them here would grow every profile without bound
// and create a push↔pull loop).
function _own(arr) { return (Array.isArray(arr) ? arr : []).filter((x) => !x || !x._org); }
function buildProfileBundle() {
  const s = state;
  return {
    format: 'ne-broadcast-profile',
    version: 1,
    app: 'Broadcast Studio',
    exportedAt: Date.now(),
    data: {
      // Each team's private VDO room + PASSWORD stays on this PC. The Profile page promises no
      // passwords are included, and this bundle is also what org library sync pushes to every
      // teammate. A team without a room gets a fresh one the first time it's needed (ensureTeamVdo).
      teams:          _own(savedTeams).map((t) => { if (!t || !t.vdo) return t; const { vdo, ...rest } = t; return rest; }),
      brandKits:      _own(savedBrandKits),
      facecams:       _own(savedFacecams),
      // A preset snapshots ALL of state.casters, including the shared caster/guest/observer room
      // passwords, the interview room and the director API key. Those belong to this install
      // (applyPreset keeps the local ones anyway), so they never leave in an export.
      presets:        (savedPresets || []).map((p) => {
        if (!p || !p.config || !p.config.casters) return p;
        const c = { ...p.config.casters };
        ['vdo', 'guestsVdo', 'observersVdo', 'interview', 'apiKey', 'rooms'].forEach((k) => { delete c[k]; });
        return { ...p, config: { ...p.config, casters: c } };
      }),
      leagues:        s.leagues || [],
      castersLibrary: _own((s.casters && s.casters.library) || []),
      settings: {
        fontFamily:           s.fontFamily,
        themesByGame:         s.themesByGame,
        colorMode:            s.colorMode,
        activeBrandKitId:     s.activeBrandKitId,
        bestOf:               s.bestOf,
        banner:               s.banner,
        ticker:               s.ticker,
        overtime:             s.overtime,
        replay:               s.replay,
        scoreboardAd:         s.scoreboardAd,
        rlStatsScreen:        s.rlStatsScreen,
        deskFooter:           s.deskFooter,
        vdo:                  s.vdo,
        preshow:              s.preshow,   // Desk Show headline/topics + saved topic presets
        customOverlayLayouts: s.customOverlayLayouts
      }
    }
  };
}
// Merge an imported profile into the current data. Libraries MERGE (additive, de-duped);
// settings OVERWRITE (and are opt-out via options.settings === false). Returns a summary.
function applyProfileBundle(bundle, options) {
  if (!bundle || bundle.format !== 'ne-broadcast-profile' || !bundle.data) {
    throw new Error('Not a valid NE Broadcast profile file.');
  }
  const d = bundle.data, opts = options || {};
  const want = (k) => opts[k] !== false;     // default: import everything present
  const parts = [];
  if (want('teams') && Array.isArray(d.teams)) {
    savedTeams = mergeAtTop(savedTeams, d.teams, (a, b) => a.name === b.name);
    saveTeams(); parts.push(`${d.teams.length} teams`);
  }
  if (want('brandKits') && Array.isArray(d.brandKits)) {
    savedBrandKits = mergeAtTop(savedBrandKits, d.brandKits, (a, b) => (a.id && a.id === b.id) || a.name === b.name);
    savedBrandKits.forEach(ensureKitPackages);   // migrate any legacy-format imported kits
    saveBrandKits(); parts.push(`${d.brandKits.length} brand kits`);
  }
  if (want('facecams') && Array.isArray(d.facecams)) {
    savedFacecams = mergeAtTop(savedFacecams, d.facecams, (a, b) => a.platform === b.platform && a.platformId === b.platformId);
    saveFacecams(); parts.push(`${d.facecams.length} facecams`);
  }
  if (want('presets') && Array.isArray(d.presets)) {
    savedPresets = mergeAtTop(savedPresets, d.presets, (a, b) => (a.id && a.id === b.id) || a.name === b.name);
    savePresets(); parts.push(`${d.presets.length} presets`);
  }
  if (want('leagues') && Array.isArray(d.leagues)) {
    const migrated = d.leagues.map(migrateLeague);
    state.leagues = mergeAtTop(state.leagues || [], migrated, (a, b) => (a.id && a.id === b.id) || a.name === b.name);
    leaguesVer++;
    parts.push(`${d.leagues.length} leagues`);
  }
  if (want('castersLibrary') && Array.isArray(d.castersLibrary)) {
    if (!Array.isArray(state.casters.library)) state.casters.library = [];
    state.casters.library = mergeAtTop(state.casters.library, d.castersLibrary, (a, b) => (a.id && a.id === b.id) || a.name === b.name);
    parts.push(`${d.castersLibrary.length} casters`);
  }
  if (want('settings') && d.settings && typeof d.settings === 'object') {
    const v = d.settings;
    ['activeBrandKitId', 'bestOf', 'banner', 'ticker', 'preshow', 'vdo']
      .forEach((k) => { if (v[k] !== undefined) state[k] = v[k]; });
    parts.push('settings');
    // Overlay styles — layouts per game, font, colour mode, replay / overtime / stats-screen /
    // scoreboard-ad / desk-footer looks. Importing a profile (usually to pick up its teams or brand
    // kits) used to overwrite all of these, which read as "my overlay styles reset". They now
    // import only when asked for explicitly (options.styles === true).
    if (opts.styles === true) {
      ['fontFamily', 'colorMode', 'overtime', 'replay', 'scoreboardAd', 'rlStatsScreen', 'deskFooter', 'customOverlayLayouts']
        .forEach((k) => { if (v[k] !== undefined) state[k] = v[k]; });
      if (v.themesByGame && typeof v.themesByGame === 'object') state.themesByGame = { ...state.themesByGame, ...v.themesByGame };
      state.useBrandColors = (state.colorMode === 'brand');
      parts.push('overlay styles');
    }
  }
  saveAppState();
  return 'Imported ' + (parts.join(', ') || 'nothing');
}

// Multichat source config (Kick channel, Discord channel + bot token). Bot token is a
// secret → encrypted at rest, never sent in full_state (panel only sees hasDiscordToken).
function saveMultichatData(sync = false) {
  if (!state.multichat || !multichatDataFile) return;
  try {
    safeWriteJson(multichatDataFile, {
      kickChannel:     state.multichat.kickChannel || '',
      discordChannelId: state.multichat.discordChannelId || '',
      discordBotToken: encryptSecret(state.multichat.discordBotToken || '')
    }, sync);
  } catch (err) { console.error('[Multichat] save failed:', err.message); }
}
function loadMultichatData() {
  if (!multichatDataFile) return;
  const saved = safeReadJson(multichatDataFile, null);
  if (!saved) return;
  state.multichat.kickChannel = saved.kickChannel || '';
  state.multichat.discordChannelId = saved.discordChannelId || '';
  state.multichat.discordBotToken = saved.discordBotToken ? decryptSecret(saved.discordBotToken) : '';
}

// Q&A mailbag. Kept in its own file (not state.json) because it churns during a show —
// every incoming question would otherwise rewrite the whole app state.
function saveQuestionsData(sync = false) {
  if (!state.questions || !questionsDataFile) return;
  try { safeWriteJson(questionsDataFile, state.questions, sync); }
  catch (err) { console.error('[Questions] save failed:', err.message); }
}
function loadQuestionsData() {
  if (!questionsDataFile) return;
  const saved = safeReadJson(questionsDataFile, null);
  if (!saved) return;
  if (Array.isArray(saved.list)) state.questions.list = saved.list.filter(q => q && q.id && q.text);
  if (saved.settings) state.questions.settings = { ...state.questions.settings, ...saved.settings };
}
// Every mutation goes through here: version bump (so librarySig re-sends the queue), save, push.
function questionsChanged() {
  questionsVer++;
  saveQuestionsData();
  broadcastFullState();
}

function saveTwitchData(sync = false) {
  if (!state.twitch) return;

  try {
    const data = {
      apiToken:       encryptSecret(state.twitch.apiToken       || ''),
      refreshToken:   encryptSecret(state.twitch.refreshToken   || ''),
      displayName:    state.twitch.displayName    || '',
      channelId:      state.twitch.channelId      || '',
      profilePicture: state.twitch.profilePicture || '',
      webhookSecret:  encryptSecret(state.twitch.webhookSecret),
      predictions:    state.twitch.predictions,
      wheel:          state.twitch.wheel,
      minigame:       state.twitch.minigame,
      chatSettings:   state.twitch.chatSettings,
      automations:    state.twitch.automations,
      adsEnabled:     state.twitch.adsEnabled !== false
    };
    safeWriteJson(twitchDataFile, data, sync);
  } catch (err) {
    console.error('[Twitch] Error saving data:', err.message);
  }
}

// Single-flight: several pollers can 401 at once and each started a refresh with the SAME refresh
// token (Twitch rotates it, so all but one fail and can log the producer out). They share one now.
let _twitchRefreshing = null;
function refreshTwitchToken() {
  if (_twitchRefreshing) return _twitchRefreshing;
  _twitchRefreshing = _refreshTwitchTokenOnce().finally(() => { _twitchRefreshing = null; });
  return _twitchRefreshing;
}
async function _refreshTwitchTokenOnce() {
  if (!state.twitch.refreshToken) throw new Error('No refresh token stored — please reconnect');
  let access_token, refresh_token;
  // Backend-first: the cloud holds the Twitch client secret (contract §3), so a signed-in app
  // refreshes through it — the installer never ships the secret. Falls back to the legacy
  // direct exchange (dev machines with a local .env.local secret) if the cloud path fails.
  let refreshed = false;
  try {
    if (cloud && typeof cloud.authed === 'function' && cloud.authed() && typeof cloud.refreshTwitch === 'function') {
      const d = await cloud.refreshTwitch(state.twitch.refreshToken);
      access_token = d.accessToken;
      refresh_token = d.refreshToken || '';
      refreshed = !!access_token;
    }
  } catch (e) {
    console.warn('[Twitch] Backend refresh failed, trying direct:', e.message);
  }
  if (!state.twitch.refreshToken) throw new Error('Twitch was disconnected during the refresh');
  if (!refreshed) {
    const params = {
      client_id: TWITCH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: state.twitch.refreshToken
    };
    // Client secret is optional for public clients; include it when available
    const secret = process.env.TWITCH_CLIENT_SECRET;
    if (secret) params.client_secret = secret;
    const r = await axios.post('https://id.twitch.tv/oauth2/token', null, { params });
    access_token = r.data.access_token;
    refresh_token = r.data.refresh_token;
  }
  // The producer pressed Disconnect while this was in flight: do not bring Twitch back.
  if (!state.twitch.refreshToken) throw new Error('Twitch was disconnected during the refresh');
  state.twitch.apiToken = access_token;
  if (refresh_token) state.twitch.refreshToken = refresh_token;
  if (twitchClient) twitchClient.updateToken(access_token);
  // A mid-session 401 flips these off and, before this, ONLY a manual reconnect ever flipped
  // them back — so one stray 401 (wake-from-sleep race, transient revoke check) permanently
  // disabled Twitch features even though this refresh just succeeded. The refresh heals them.
  _twitchTokenInvalid = false;
  state.twitch.connected = true;
  saveTwitchData();
  broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
  console.log('[Twitch] Access token refreshed');
  scheduleTokenRefresh();
  return access_token;
}

// Proactive refresh — fires 30 minutes before expiry so mid-session use is never interrupted
let _tokenRefreshTimer = null, _tokenRefreshGen = 0;
function scheduleTokenRefresh() {
  if (_tokenRefreshTimer) { clearTimeout(_tokenRefreshTimer); _tokenRefreshTimer = null; }
  if (!state.twitch.refreshToken) return;
  // Two calls in flight used to arm two timers (only one handle kept): only the latest call arms one.
  const gen = ++_tokenRefreshGen;
  // Validate to learn the current expiry, then schedule a refresh 30 min before it
  axios.get('https://id.twitch.tv/oauth2/validate', {
    headers: { 'Authorization': `OAuth ${state.twitch.apiToken}` }
  }).then(r => {
    const expiresIn = r.data.expires_in; // seconds
    if (!expiresIn || gen !== _tokenRefreshGen || !state.twitch.refreshToken) return;
    if (_tokenRefreshTimer) clearTimeout(_tokenRefreshTimer);
    const refreshIn = Math.max((expiresIn - 1800) * 1000, 60000); // 30 min early, min 1 min
    console.log(`[Twitch] Token valid for ${Math.round(expiresIn / 3600)}h — auto-refresh in ${Math.round(refreshIn / 60000)} min`);
    _tokenRefreshTimer = setTimeout(async () => {
      try { await refreshTwitchToken(); } catch (e) { console.error('[Twitch] Scheduled refresh failed:', e.message); }
    }, refreshIn);
  }).catch(() => {
    // Token already expired — try refresh immediately
    if (gen === _tokenRefreshGen && state.twitch.refreshToken) {
      refreshTwitchToken().catch(e => console.error('[Twitch] Immediate refresh failed:', e.message));
    }
  });
}

function loadTwitchData() {
  try {
    if (fs.existsSync(twitchDataFile)) {
      const data = safeReadJson(twitchDataFile, {});
      // Restore auth credentials so the app reconnects without re-OAuth
      if (data.apiToken)       state.twitch.apiToken       = decryptSecret(data.apiToken);
      if (data.refreshToken)   state.twitch.refreshToken   = decryptSecret(data.refreshToken);
      if (data.displayName)    state.twitch.displayName    = data.displayName;
      if (data.channelId)      state.twitch.channelId      = data.channelId;
      if (data.profilePicture) state.twitch.profilePicture = data.profilePicture;
      if (data.webhookSecret)  state.twitch.webhookSecret  = decryptSecret(data.webhookSecret);
      if (data.predictions) {
        Object.assign(state.twitch.predictions, data.predictions);
        // Don't resume an in-progress prediction across restarts — it can't be
        // voted on and the overlay would show a frozen card indefinitely.
        const cur = state.twitch.predictions.current;
        if (cur) {
          const expired = cur.endsAt && new Date(cur.endsAt) < new Date();
          const done    = cur.state === 'RESOLVED' || cur.state === 'CANCELLED';
          if (expired || done) state.twitch.predictions.current = null;
        }
      }
      if (data.wheel)         Object.assign(state.twitch.wheel,         data.wheel);
      if (data.minigame)      Object.assign(state.twitch.minigame,      data.minigame);
      if (data.chatSettings)  Object.assign(state.twitch.chatSettings,  data.chatSettings);
      if (data.automations)   Object.assign(state.twitch.automations,   data.automations);
      if (typeof data.adsEnabled === 'boolean') state.twitch.adsEnabled = data.adsEnabled;
      console.log('[Twitch] Data loaded', data.displayName ? `(connected as ${data.displayName})` : '');
    }
  } catch (err) {
    console.error('[Twitch] Failed to load data:', err.message);
  }
}

function saveDiscordUser(sync = false) {
  if (!discordDataFile) return;
  try {
    const data = {
      userId:       state.discord.userId       || '',
      username:     state.discord.username     || '',
      discriminator: state.discord.discriminator || '',
      globalName:   state.discord.globalName   || '',
      avatarUrl:    state.discord.avatarUrl    || '',
      accessToken:  encryptSecret(state.discord.accessToken  || ''),
      refreshToken: encryptSecret(state.discord.refreshToken || '')
    };
    safeWriteJson(discordDataFile, data, sync);
  } catch (err) {
    console.error('[Discord] Error saving user:', err.message);
  }
}

// ── Cloud access enforcement — force sign-out for THIS user only when the backend
// definitively refuses them (access revoked / rejected / session invalid). ──────────
function forceCloudSignOut(message) {
  try { cloud.clearSession(); } catch (_) {}
  state.discord.connected     = false;
  state.discord.userId        = '';
  state.discord.username      = '';
  state.discord.discriminator = '';
  state.discord.globalName    = '';
  state.discord.avatarUrl     = '';
  state.discord.accessToken   = '';
  state.discord.refreshToken  = '';
  state.discord.lastError     = message || 'Your Broadcast Studio access was revoked — contact an admin.';
  _pendingContract = null;
  saveDiscordUser();
  try { broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() }); } catch (_) {}
  console.log('[Cloud] Forced sign-out:', state.discord.lastError);
}

// The Nameless backend re-checks the studio access gate on every token refresh:
//   403 → access revoked/rejected/unsigned (the response says exactly why)
//   401 → refresh token invalid or expired
// Anything else (network down, server 5xx, no cloud session at all) is IGNORED —
// an active user must never get signed out because of a wifi blip or an outage.
async function validateCloudSession(trigger) {
  if (!cloud.configured() || !state.discord.connected) return;
  try {
    await cloud.refreshSession();
    // Session confirmed live → keep the cloud copy of the producer's library current. Covers every
    // sign-in method (Discord, email, contract) on boot/periodic without a per-path hook.
    if (cloud.authed()) { syncProfileToCloud(); if (trigger !== 'periodic') pullOrgLibrary().catch(() => {}); }
  } catch (e) {
    if (e && (e.status === 403 || e.status === 401)) {
      const backendMsg = (e.data && e.data.error && e.data.error.message) || e.message || '';
      forceCloudSignOut(
        e.status === 403 ? backendMsg : 'Your session expired — sign in again.'
      );
    } else if (e && /No refresh token/i.test(e.message || '')) {
      // Local-dev Discord login (no cloud session) — nothing to enforce.
    } else {
      console.warn(`[Cloud] Session check (${trigger}) inconclusive — keeping the user signed in:`, (e && e.message) || e);
    }
  }
}

function loadDiscordUser() {
  try {
    if (fs.existsSync(discordDataFile)) {
      const data = safeReadJson(discordDataFile, {});
      if (data.userId)       state.discord.userId       = data.userId;
      if (data.username)     state.discord.username     = data.username;
      if (data.discriminator) state.discord.discriminator = data.discriminator;
      if (data.globalName)   state.discord.globalName   = data.globalName;
      if (data.avatarUrl)    state.discord.avatarUrl    = data.avatarUrl;
      if (data.accessToken)  state.discord.accessToken  = decryptSecret(data.accessToken);
      if (data.refreshToken) state.discord.refreshToken = decryptSecret(data.refreshToken);
      // Backend-mode logins never hold a local Discord accessToken (the Nameless backend
      // keeps it), so a saved user IS a signed-in user. If the cloud session is actually
      // dead/revoked, validateCloudSession('boot') force-signs-out with the real reason.
      if (data.userId) state.discord.connected = true;
      console.log('[Discord] User loaded', data.username ? `(${data.username})` : '');
    }
  } catch (err) {
    console.error('[Discord] Failed to load user:', err.message);
  }
}

// Where a sponsor logo can be displayed. Each brand sponsor carries a `placements`
// map of these flags, set with checkmarks in the brand editor.
const SPONSOR_SPOTS = ['title', 'rail', 'desk', 'overtime', 'replayGoal', 'replayOutro', 'scoreboard', 'banner', 'ticker'];
// A desk caster's tournament-winner pick — ANY team from the library (state.savedTeams), not
// tied to whichever two teams the current match happens to be. Snapshotted at pick time (name +
// logo), same "don't just store a pointer that can go stale" convention as MatchSession's team
// snapshots, so the badge on the overlay still renders correctly if that team is later renamed
// or removed from the library.
function sanitizePreshowPick(v) {
  if (!v || typeof v !== 'object' || typeof v.name !== 'string' || !v.name.trim()) return '';
  return { name: v.name.trim().slice(0, 80), logo: typeof v.logo === 'string' ? v.logo.slice(0, 500000) : null };
}

function sanitizePlacements(p) {
  // No placements (legacy sponsor saved before this feature) → show on rail + caster desk,
  // matching the old "every sponsor shows on the rail/desk" behaviour.
  if (!p || typeof p !== 'object') {
    return { title: false, rail: true, desk: true, overtime: false, replayGoal: false, replayOutro: false, scoreboard: false, banner: false, ticker: false };
  }
  const o = {};
  SPONSOR_SPOTS.forEach((k) => { o[k] = !!p[k]; });
  return o;
}

// ── Brand packages ─────────────────────────────────────────────────────────
// A profile's sellable config (sponsor set + placements + banner) lives in named "packages"
// (e.g. one per sponsorship deal / event type). Package-scoped fields are below; identity
// (name/logo/colours/font/themes) stays on the kit. Legacy kits stored these fields at the top
// level — they're wrapped into a single "Main" package on load so every read path resolves
// through activePackage().
function brandId() { return Math.random().toString(36).slice(2, 11); }
const PACKAGE_FIELDS = ['sponsorLabel', 'presentedLabel', 'sponsorInterval', 'sponsorMode', 'sponsors', 'bannerImages', 'bannerCaptions', 'bannerSlant', 'bannerHeader', 'bannerInterval', 'replaySkin', 'scoreboardBg'];

// Worlds overlay stats sidebar: clamp to a small, safe shape (≤10 ranked rows) so it can ride the
// live broadcast tier without bloating it. Logos are optional and kept only when a data: or short URL.
function sanitizeWorldsSidebar(s) {
  s = s || {};
  const src = ['manual', 'standings', 'series'].includes(s.source) ? s.source : 'manual';
  const rows = (Array.isArray(s.rows) ? s.rows : []).slice(0, 10).map((r, i) => {
    r = r || {};
    const row = {
      rank: (r.rank != null && r.rank !== '') ? String(r.rank).slice(0, 4) : (i + 1),
      name: String(r.name == null ? '' : r.name).slice(0, 40),
      value: String(r.value == null ? '' : r.value).slice(0, 12),
    };
    if (typeof r.logo === 'string' && r.logo && r.logo.length < 262144) row.logo = r.logo;
    return row;
  }).filter((r) => r.name.trim());
  return {
    visible: !!s.visible,
    title: String(s.title == null ? 'Total Goals' : s.title).slice(0, 40),
    subtitle: String(s.subtitle == null ? '' : s.subtitle).slice(0, 40),
    source: src,
    rows,
  };
}

function sanitizePackage(p, fallbackName) {
  p = p || {};
  return {
    id: p.id || brandId(),
    name: (p.name || fallbackName || 'Main').toString().slice(0, 40),
    sponsorLabel: (p.sponsorLabel != null ? p.sponsorLabel : 'PARTNERS').toString(),   // preserve explicit '' (no rail heading); default only when unset
    // "Presented by" wording for the title-sponsor lockup across ALL overlays (RL HUD roll-out,
    // desk/duorow plate, post-game scorecard). Empty = overlays use their 'PRESENTED BY' default.
    presentedLabel: typeof p.presentedLabel === 'string' ? p.presentedLabel.slice(0, 40) : '',
    sponsorInterval: Number(p.sponsorInterval) > 0 ? Number(p.sponsorInterval) : 6,
    sponsorMode: p.sponsorMode === 'static' ? 'static' : 'cycle',   // rail: cycle one at a time, or show all at once
    sponsors: Array.isArray(p.sponsors) ? p.sponsors.map((s) => ({
      id: s.id || brandId(), name: (s.name || '').toString(), logo: s.logo || null,
      tier: String(s.tier || 'partner').slice(0, 20), placements: sanitizePlacements(s.placements),
      // Deal $/ROI: what this sponsor paid, and/or their agreed market rate — both optional,
      // feed the Sponsor Proof of Play $ metrics (realized CPM / value delivered).
      dealValue: (typeof s.dealValue === 'number' && s.dealValue >= 0) ? s.dealValue : null,
      targetCpm: (typeof s.targetCpm === 'number' && s.targetCpm >= 0) ? s.targetCpm : null
    })) : [],
    bannerImages: Array.isArray(p.bannerImages) ? p.bannerImages : [],
    bannerCaptions: Array.isArray(p.bannerCaptions) ? p.bannerCaptions.map((t) => (typeof t === 'string' ? t : '')) : [],
    bannerSlant: ['right', 'left', 'box'].includes(p.bannerSlant) ? p.bannerSlant : 'right',
    bannerHeader: typeof p.bannerHeader === 'string' ? p.bannerHeader.slice(0, 40) : '',
    // Desk Show (preshow.html) headline + discussion topics — package-scoped like sponsors/banner,
    // so switching the active package automatically switches what Desk Show shows.
    topicsHeadline: typeof p.topicsHeadline === 'string' ? p.topicsHeadline.slice(0, 140) : '',
    topics: Array.isArray(p.topics) ? p.topics.filter((t) => t && typeof t === 'object').map((t) => ({
      text: typeof t.text === 'string' ? t.text.slice(0, 60) : '',
      sceneName: typeof t.sceneName === 'string' ? t.sceneName.slice(0, 100) : ''
    })).slice(0, 12) : [],
    bannerInterval: Number(p.bannerInterval) > 0 ? Number(p.bannerInterval) : 10,
    replaySkin: p.replaySkin || null,   // per-profile replay transition background image
    scoreboardBg: p.scoreboardBg || null,   // per-profile RL post-game scoreboard background image (link or uploaded)
    // Captured show setup ("Capture current show setup" in the profile editor): scene presets,
    // ticker, event name, board titles, caster lineup + slot labels, OBS moment mappings.
    // Applied on kit/package activation — only the fields the snapshot actually carries.
    // Deliberately EXCLUDES production-dependent toggles (facecams enabled, replay cams).
    showSnapshot: (p.showSnapshot && typeof p.showSnapshot === 'object') ? p.showSnapshot : null,
  };
}

// Snapshot the CURRENT live show setup into a package (see sanitizePackage.showSnapshot).
function capturePackageSnapshot() {
  return {
    capturedAt: Date.now(),
    scenePresets: JSON.parse(JSON.stringify(state.scenePresets || {})),
    ticker: {
      messages: (state.ticker.messages || []).slice(0, 50),
      speed: state.ticker.speed, source: state.ticker.source, sponsor: state.ticker.sponsor || ''
    },
    eventName: state.eventName || '',
    standingsTitle: (state.standings && state.standings.title) || '',
    standingsSubtitle: (state.standings && state.standings.subtitle) || '',
    upcomingTitle: (state.upcoming && state.upcoming.title) || '',
    lowerThird: (state.casters && state.casters.lowerThird) || '',
    lineup: JSON.parse(JSON.stringify((state.casters && state.casters.lineup) || [])),
    slotLabels: { ...((state.casters && state.casters.slotLabels) || {}) },
    obsScenes: { ...((state.obs && state.obs.scenes) || {}) }
  };
}

// Activate a profile (brand kit) — the ONE path for every activation side effect: topics,
// show snapshot, theme snap, ad slots, OBS collection/profile switch. Used by the
// activate_brand_kit WS case and by save_brand_kit's "Save & Activate".
function activateBrandKitById(id) {
  state.activeBrandKitId = id || null;
  const kit = savedBrandKits.find((b) => b.id === id);
  if (kit) ensureKitPackages(kit);
  syncActivePreshowTopics();   // Desk Show headline/topics follow the newly-active kit's active package
  if (kit) applyPackageSnapshot(activePackage(kit), { styles: !!kit.linkStyles });   // captured show setup travels with the package
  if (kit) applyKitStyles(kit);
  applyBrandSlots();           // fill the ad slots from this brand's sponsor placements
  saveAppState();
  broadcastFullState();        // brand colours apply automatically when colorMode === 'brand'
  // The app NEVER switches the user's OBS profile or scene collection — everyone's OBS is set up
  // differently and it's theirs. (Removed 2026-08: the old opt-in brand-kit profile/collection switch.)
}

// Overlay STYLES (per-game layout, per-scene style presets) belong to the producer, not to a
// brand. Activating, re-saving or switching a package used to snap the active game's layout to
// the kit's design and REPLACE every scene style preset with the copy captured into the package —
// so styles "reset" every time a brand was touched. Now a kit only drives styles when the producer
// links them (kit.linkStyles, the "Apply these designs when this profile goes live" switch), and
// then it sets each game it names, not just whichever game happens to be active.
function applyKitStyles(kit) {
  if (!kit || !kit.linkStyles || !kit.themes || typeof kit.themes !== 'object') return false;
  let changed = false;
  Object.keys(kit.themes).forEach((g) => {
    const t = kit.themes[g];
    if (GAMES[g] && t && isValidTheme(g, t) && state.themesByGame[g] !== t) { state.themesByGame[g] = t; changed = true; }
  });
  return changed;
}

// Apply a package's captured show setup. Only fields the snapshot carries are touched, so a
// package captured before a feature existed can't blank newer state. Scene style presets are
// applied only with opts.styles (a linked kit), and MERGED — presets made since the capture survive.
function applyPackageSnapshot(pkg, opts) {
  const s = pkg && pkg.showSnapshot;
  if (!s || typeof s !== 'object') return false;
  if (opts && opts.styles && s.scenePresets && typeof s.scenePresets === 'object') {
    const snap = JSON.parse(JSON.stringify(s.scenePresets));
    if (!state.scenePresets || typeof state.scenePresets !== 'object') state.scenePresets = {};
    Object.keys(snap).forEach((scene) => {
      const cur = state.scenePresets[scene] || { active: 'Default', presets: {} };
      const inc = snap[scene] || {};
      state.scenePresets[scene] = {
        active: inc.active || cur.active,
        presets: { ...(cur.presets || {}), ...(inc.presets || {}) }
      };
    });
  }
  if (s.ticker && typeof s.ticker === 'object') {
    if (Array.isArray(s.ticker.messages)) state.ticker.messages = s.ticker.messages.slice(0, 50);
    if (Number(s.ticker.speed) > 0) state.ticker.speed = Number(s.ticker.speed);
    if (['startgg', 'nxgen', 'br', 'manual'].includes(s.ticker.source)) state.ticker.source = s.ticker.source;
    if (typeof s.ticker.sponsor === 'string') state.ticker.sponsor = s.ticker.sponsor;
  }
  if (s.eventName) state.eventName = String(s.eventName);
  if (s.standingsTitle) state.standings.title = String(s.standingsTitle);
  if (s.standingsSubtitle) state.standings.subtitle = String(s.standingsSubtitle);
  if (s.upcomingTitle) state.upcoming.title = String(s.upcomingTitle);
  if (typeof s.lowerThird === 'string' && s.lowerThird) state.casters.lowerThird = s.lowerThird;
  if (Array.isArray(s.lineup) && s.lineup.length) {
    state.casters.lineup = JSON.parse(JSON.stringify(s.lineup));
    resolveLineupToList();
  }
  if (s.slotLabels && typeof s.slotLabels === 'object' && Object.keys(s.slotLabels).length) {
    state.casters.slotLabels = { ...state.casters.slotLabels, ...s.slotLabels };
  }
  if (s.obsScenes && typeof s.obsScenes === 'object' && Object.values(s.obsScenes).some(Boolean)) {
    state.obs.scenes = { ...state.obs.scenes, ...s.obsScenes };
  }
  return true;
}

// Migrate a kit in place: guarantee a packages[] array + a valid activePackageId.
function ensureKitPackages(kit) {
  if (!kit) return kit;
  if (!Array.isArray(kit.packages) || !kit.packages.length) {
    kit.packages = [sanitizePackage({
      id: kit.activePackageId, name: 'Main',
      sponsorLabel: kit.sponsorLabel, sponsorInterval: kit.sponsorInterval, sponsors: kit.sponsors,
      bannerImages: kit.bannerImages, bannerCaptions: kit.bannerCaptions, bannerSlant: kit.bannerSlant,
      bannerHeader: kit.bannerHeader, bannerInterval: kit.bannerInterval,
    })];
    kit.activePackageId = kit.packages[0].id;
    PACKAGE_FIELDS.forEach((f) => delete kit[f]);   // drop the legacy top-level duplicates
  }
  if (!kit.activePackageId || !kit.packages.some((p) => p.id === kit.activePackageId)) {
    kit.activePackageId = kit.packages[0].id;
  }
  return kit;
}

// The package currently selected for broadcast on a kit (falls back to legacy top-level fields).
function activePackage(kit) {
  if (!kit) return null;
  const pkgs = Array.isArray(kit.packages) ? kit.packages : [];
  if (pkgs.length) return pkgs.find((p) => p.id === kit.activePackageId) || pkgs[0];
  return sanitizePackage({   // legacy kit with no packages yet
    sponsorLabel: kit.sponsorLabel, sponsorInterval: kit.sponsorInterval, sponsors: kit.sponsors,
    bannerImages: kit.bannerImages, bannerCaptions: kit.bannerCaptions, bannerSlant: kit.bannerSlant,
    bannerHeader: kit.bannerHeader, bannerInterval: kit.bannerInterval,
  });
}

// The active client brand kit, resolved for overlays (or null → overlays fall back to event branding).
// Identity comes from the kit; sponsors/banner come from the kit's active package.
function activeBrand() {
  const kit = savedBrandKits.find((b) => b.id === state.activeBrandKitId);
  if (!kit) return null;
  const pkg = activePackage(kit);
  const sponsors = (Array.isArray(pkg.sponsors) ? pkg.sponsors : []).map((s) => ({
    id: s.id, name: s.name || '', logo: s.logo || null, tier: s.tier || 'partner',
    placements: sanitizePlacements(s.placements),
    dealValue: (typeof s.dealValue === 'number') ? s.dealValue : null,
    targetCpm: (typeof s.targetCpm === 'number') ? s.targetCpm : null
  }));
  const tagged = (key) => sponsors.filter((s) => s.logo && s.placements[key]);
  return {
    id: kit.id,
    name: kit.name || '',
    logo: kit.logo || null,
    color: kit.color || null,
    accent: kit.accent || null,
    font: kit.font || null,
    sponsorLabel: pkg.sponsorLabel != null ? pkg.sponsorLabel : 'PARTNERS',   // preserve explicit '' (no rail heading); default only when unset
    presentedLabel: pkg.presentedLabel || '',   // "Presented by" wording for the title-sponsor lockup across all overlays
    sponsorInterval: Number(pkg.sponsorInterval) > 0 ? Number(pkg.sponsorInterval) : 6,
    sponsorMode: pkg.sponsorMode === 'static' ? 'static' : 'cycle',
    bannerImages: Array.isArray(pkg.bannerImages) ? pkg.bannerImages : [],
    bannerInterval: Number(pkg.bannerInterval) > 0 ? Number(pkg.bannerInterval) : 10,
    replaySkin: pkg.replaySkin || null,        // per-profile replay transition background
    scoreboardBg: pkg.scoreboardBg || null,    // per-profile RL post-game scoreboard background
    sponsors,                                  // all (for the editor + back-compat consumers)
    railSponsors: tagged('rail'),              // rotating corner bug
    deskSponsors: tagged('desk'),              // caster-desk footer logos
    bannerSponsors: tagged('banner'),          // sponsor-banner rotation
    spots: {                                   // single-logo ad slots → first tagged sponsor's logo
      title: (tagged('title')[0] || {}).logo || null,   // prominent always-on title-sponsor bug
      overtime: (tagged('overtime')[0] || {}).logo || null,
      replayGoal: (tagged('replayGoal')[0] || {}).logo || null,
      replayOutro: (tagged('replayOutro')[0] || {}).logo || null,
      scoreboard: (tagged('scoreboard')[0] || {}).logo || null,
      ticker: (tagged('ticker')[0] || {}).logo || null
    },
    // Package metadata for the editor + Dashboard quick-switch (names only — no base64).
    packages: (Array.isArray(kit.packages) ? kit.packages : []).map((p) => ({ id: p.id, name: p.name })),
    activePackageId: kit.activePackageId || null,
  };
}

// Mirror the active brand package's Desk Show headline/topics into state.preshow — the fields
// the control panel + overlay/preshow.html actually read/edit live. Content is persisted on the
// PACKAGE (sanitizePackage, above); this just keeps the live mirror in sync whenever the active
// kit/package changes, the same "persist on the real record, mirror to the top-level fields the
// UI reads" pattern used for bracket phases/pools.
function syncActivePreshowTopics() {
  const kit = savedBrandKits.find((b) => b.id === state.activeBrandKitId);
  const pkg = kit ? activePackage(kit) : null;
  state.preshow.headline = (pkg && pkg.topicsHeadline) || '';
  state.preshow.topics = (pkg && Array.isArray(pkg.topics)) ? pkg.topics : [];
  state.preshow.activeTopicIndex = 0;   // the old index may be out of range for the new topic list
}

// ── Sponsor proof-of-play (impression tracking) ──────────────────────────────
// While a session is active, sample once a second and credit every on-air sponsor logo by
// placement, producing a defensible "estimated on-screen seconds per sponsor" report — a
// sellable proof-of-play deliverable. Exposure is inferred from the overlay STATE the server
// already knows (which placements are visible), so it's an estimate, labelled as such.
const adProof = {
  active: false, startedAt: 0, label: '', ticks: 0,
  sponsors: {}   // id -> { id, name, seconds, byPlacement:{spot:sec}, impressions, _onPrev }
};
let _adProofTimer = null;

// Current combined concurrent viewers (Twitch + YouTube when available) — used for sponsor
// viewer-seconds and the recorder's viewer samples.
function currentViewers() {
  let v = 0;
  try { if (typeof streamStateManager !== 'undefined' && streamStateManager && streamStateManager.streamState.isLive) v += streamStateManager.streamState.viewerCount || 0; } catch (e) {}
  try { if (state.youtube && (state.youtube.live || state.youtube.isLive)) v += state.youtube.viewers || state.youtube.concurrentViewers || 0; } catch (e) {}
  return v;
}

// ── OBS stream-health poll: dropped frames / bitrate / fps / cpu / congestion (~5s) ──
let _obsHealthPrev = { bytes: 0, at: 0 };
async function pollObsHealth() {
  if (!obsClient || !obsClient.isConnected()) { if (state.obs) state.obs.health = null; _obsHealthPrev = { bytes: 0, at: 0 }; return; }
  try {
    const stats = await obsClient.call('GetStats');
    if (!stats) return;
    let ss = null; try { ss = await obsClient.call('GetStreamStatus'); } catch (e) {}
    const outTot = (ss && ss.outputTotalFrames) || 0, outSkip = (ss && ss.outputSkippedFrames) || 0;
    const rndTot = stats.renderTotalFrames || 0, rndSkip = stats.renderSkippedFrames || 0;
    let bitrateKbps = 0;
    if (ss && ss.outputActive) {
      const nowMs = Date.now(), bytes = ss.outputBytes || 0;
      if (_obsHealthPrev.at && bytes >= _obsHealthPrev.bytes) { const dt = (nowMs - _obsHealthPrev.at) / 1000; if (dt > 0) bitrateKbps = Math.round(((bytes - _obsHealthPrev.bytes) * 8) / dt / 1000); }
      _obsHealthPrev = { bytes, at: nowMs };
    } else { _obsHealthPrev = { bytes: 0, at: 0 }; }
    const health = {
      cpu: +(stats.cpuUsage || 0).toFixed(1), fps: Math.round(stats.activeFps || 0),
      renderLagMs: +(stats.averageFrameRenderTime || 0).toFixed(2),
      renderDropPct: rndTot ? +((rndSkip / rndTot) * 100).toFixed(2) : 0,
      outputDropPct: outTot ? +((outSkip / outTot) * 100).toFixed(2) : 0,
      congestion: ss ? +(ss.outputCongestion || 0).toFixed(2) : 0,
      bitrateKbps, streaming: !!(ss && ss.outputActive), reconnecting: !!(ss && ss.outputReconnecting), at: Date.now()
    };
    if (state.obs) state.obs.health = health;
    // Backstop for a missed StreamStateChanged event: the poll already knows the truth.
    if (ss && state.obs && !!state.obs.streaming !== !!ss.outputActive) {
      state.obs.streaming = !!ss.outputActive;
      state.obs.streamStartedAt = ss.outputActive ? Date.now() - (ss.outputDuration || 0) : 0;
      broadcastFullState();
    }
    try { analytics.recordHealth(health); } catch (e) {}
  } catch (e) {}
}
setInterval(pollObsHealth, 5000);

// Which sponsor logos are on-air this second, given the live state. Returns [{ sponsor, placement }].
function adProofOnAir(brand, elapsed) {
  const out = [];
  const live = !(state.breakScreen && state.breakScreen.visible);   // the main overlay is composited
  // Rail bug: 'static' shows ALL sponsors at once; 'cycle' rotates through them one at a time.
  const rail = brand.railSponsors || [];
  if (live && rail.length) {
    if (brand.sponsorMode === 'static') {
      rail.forEach((s) => out.push({ sponsor: s, placement: 'rail' }));
    } else {
      const interval = Number(brand.sponsorInterval) > 0 ? Number(brand.sponsorInterval) : 6;
      const idx = Math.floor((elapsed - 1) / interval) % rail.length;
      if (rail[idx]) out.push({ sponsor: rail[idx], placement: 'rail' });
    }
  }
  // Desk + banner show every tagged sponsor at once while their surface is up.
  if (state.casters && state.casters.visible) (brand.deskSponsors || []).forEach((s) => out.push({ sponsor: s, placement: 'desk' }));
  if (state.banner && state.banner.visible) (brand.bannerSponsors || []).forEach((s) => out.push({ sponsor: s, placement: 'banner' }));
  // Single-logo ad slots — on-air when their moment/scene is live.
  const gfx = typeof state.gfxActive === 'string' ? state.gfxActive : '';
  const cond = {
    overtime:   !!(state.game && state.game.isOT),
    scoreboard: state.view === 'scoreboard',
    replayGoal: state.view === 'goal',
    // The ticker bar persists on the live overlay, but only while it is switched on.
    ticker:     live && !(state.ticker && state.ticker.visible === false),
    // The title-sponsor lockup ("presented by") sits on the break screen and the full-frame boards.
    title:      !!(state.breakScreen && state.breakScreen.visible) || ['bracket', 'preshow', 'credits', 'schedule', 'standings', 'matchup'].includes(gfx)
  };
  ['overtime', 'scoreboard', 'replayGoal', 'ticker', 'title'].forEach((spot) => {
    if (!cond[spot]) return;
    const sp = (brand.sponsors || []).find((s) => s.logo && s.placements && s.placements[spot]);
    if (sp) out.push({ sponsor: sp, placement: spot });
  });
  return out;
}

function adProofTick() {
  if (!adProof.active) return;
  const brand = activeBrand();
  adProof.ticks++;
  const v = currentViewers();
  const onAir = brand ? adProofOnAir(brand, adProof.ticks) : [];
  const creditedNow = new Set();
  onAir.forEach(({ sponsor, placement }) => {
    if (!sponsor || !sponsor.id) return;
    const rec = adProof.sponsors[sponsor.id] ||
      (adProof.sponsors[sponsor.id] = { id: sponsor.id, name: sponsor.name || '', logo: '', seconds: 0, byPlacement: {}, impressions: 0, viewerSeconds: 0, peakViewers: 0, dealValue: null, targetCpm: null, _onPrev: false });
    if (sponsor.name) rec.name = sponsor.name;
    // A short logo reference (URL or @img vault ref) travels with the record; a base64 logo does not
    // (the panel resolves those from the brand kits by id/name, so reports still show the mark).
    rec.logo = (typeof sponsor.logo === 'string' && sponsor.logo.length <= 400) ? sponsor.logo : '';
    // Refresh $ terms every tick (like name) so a mid-broadcast edit to the sponsor's deal
    // value/target CPM in the brand kit editor is reflected in this session's numbers.
    rec.dealValue = sponsor.dealValue;
    rec.targetCpm = sponsor.targetCpm;
    rec.byPlacement[placement] = (rec.byPlacement[placement] || 0) + 1;   // placement-seconds
    if (!creditedNow.has(sponsor.id)) { rec.seconds++; rec.viewerSeconds += v; if (v > rec.peakViewers) rec.peakViewers = v; creditedNow.add(sponsor.id); }   // on-air seconds + viewer-seconds (de-duped)
  });
  // impressions = number of distinct on-air appearances (off→on transitions)
  Object.values(adProof.sponsors).forEach((rec) => {
    const nowOn = creditedNow.has(rec.id);
    if (nowOn && !rec._onPrev) rec.impressions++;
    rec._onPrev = nowOn;
  });
  if (adProof.ticks % 2 === 0) broadcast(bridgeClients, { type: 'adproof_update', data: adProofReport() });
}

// $/ROI metrics derived from viewer-seconds (treated as impression-seconds, matching this
// report's existing "viewer-seconds = estimated impressions" convention):
//   realizedCpm    — what the sponsor effectively paid per 1000 impression-seconds (needs dealValue)
//   valueDelivered — $ value of the exposure delivered at the sponsor's agreed/market rate (needs targetCpm)
//   deliveryPct    — valueDelivered vs. what they paid (needs both)
function adProofValueMetrics(r) {
  const units = (r.viewerSeconds || 0) / 1000;   // thousands of impression-seconds
  const dealValue = typeof r.dealValue === 'number' ? r.dealValue : null;
  const targetCpm = typeof r.targetCpm === 'number' ? r.targetCpm : null;
  const realizedCpm = (dealValue != null && units > 0) ? +(dealValue / units).toFixed(2) : null;
  const valueDelivered = (targetCpm != null) ? +(units * targetCpm).toFixed(2) : null;
  const deliveryPct = (dealValue != null && dealValue > 0 && valueDelivered != null) ? Math.round((valueDelivered / dealValue) * 100) : null;
  return { dealValue, targetCpm, realizedCpm, valueDelivered, deliveryPct };
}

function adProofReport() {
  const sponsors = Object.values(adProof.sponsors).map((r) => ({
    id: r.id, name: r.name, logo: r.logo || '', seconds: r.seconds, impressions: r.impressions, byPlacement: { ...r.byPlacement },
    viewerSeconds: r.viewerSeconds || 0, peakViewers: r.peakViewers || 0, avgViewers: r.seconds ? Math.round((r.viewerSeconds || 0) / r.seconds) : 0,
    ...adProofValueMetrics(r)
  })).sort((a, b) => b.seconds - a.seconds);
  const totalDealValue = sponsors.reduce((sum, s) => sum + (s.dealValue || 0), 0);
  const totalValueDelivered = sponsors.reduce((sum, s) => sum + (s.valueDelivered || 0), 0);
  return {
    active: adProof.active, startedAt: adProof.startedAt, label: adProof.label,
    durationSec: adProof.ticks, sponsors,
    totalDealValue: totalDealValue || null, totalValueDelivered: totalValueDelivered || null,
    sessions: (state.adProofSessions || []).map((s) => ({
      id: s.id, label: s.label, startedAt: s.startedAt, endedAt: s.endedAt,
      durationSec: s.durationSec, sponsorCount: (s.sponsors || []).length,
      analyticsSessionId: s.analyticsSessionId || '',
      // A light strip for the history list: who was on, for how long, with their mark.
      sponsors: (s.sponsors || []).slice(0, 12).map((x) => ({ id: x.id || '', name: x.name || '', logo: x.logo || '', seconds: x.seconds || 0 })),
      totalDealValue: (s.sponsors || []).reduce((sum, x) => sum + (x.dealValue || 0), 0) || null,
      totalValueDelivered: (s.sponsors || []).reduce((sum, x) => sum + (x.valueDelivered || 0), 0) || null
    }))
  };
}

function adProofStart(label) {
  adProof.active = true;
  adProof.startedAt = Date.now();
  adProof.label = ((label || '').toString().slice(0, 80)) || (state.eventName || 'Broadcast');
  adProof.ticks = 0;
  adProof.sponsors = {};
  if (_adProofTimer) clearInterval(_adProofTimer);
  _adProofTimer = setInterval(adProofTick, 1000);
  broadcast(bridgeClients, { type: 'adproof_update', data: adProofReport() });
}

function adProofStop() {
  if (!adProof.active) return null;
  adProof.active = false;
  if (_adProofTimer) { clearInterval(_adProofTimer); _adProofTimer = null; }
  const session = {
    id: Math.random().toString(36).slice(2, 11),
    label: adProof.label, startedAt: adProof.startedAt, endedAt: Date.now(), durationSec: adProof.ticks,
    sponsors: Object.values(adProof.sponsors).map((r) => ({
      id: r.id, name: r.name, logo: r.logo || '', seconds: r.seconds, impressions: r.impressions, byPlacement: { ...r.byPlacement },
      viewerSeconds: r.viewerSeconds || 0, peakViewers: r.peakViewers || 0, avgViewers: r.seconds ? Math.round((r.viewerSeconds || 0) / r.seconds) : 0,
      ...adProofValueMetrics(r)
    })).sort((a, b) => b.seconds - a.seconds)
  };
  if (!Array.isArray(state.adProofSessions)) state.adProofSessions = [];
  state.adProofSessions.unshift(session);
  if (state.adProofSessions.length > 50) state.adProofSessions.length = 50;   // cap history
  saveAppState();
  broadcast(bridgeClients, { type: 'adproof_update', data: adProofReport() });
  return session;
}

// Build a CSV report for one session (or the live tracker).
function adProofCsv(sess) {
  const spots = SPONSOR_SPOTS;
  const mmss = (s) => { const m = Math.floor(s / 60), x = s % 60; return m + ':' + String(x).padStart(2, '0'); };
  const cell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = ['Sponsor', 'Total seconds', 'Total (mm:ss)', 'Impressions', 'Deal value ($)', 'Target CPM ($)', 'Realized CPM ($)', 'Value delivered ($)', 'Delivery %', ...spots.map((s) => s + ' sec')];
  const lines = [head.join(',')];
  (sess.sponsors || []).forEach((s) => {
    const m = adProofValueMetrics(s);
    lines.push([cell(s.name), s.seconds, mmss(s.seconds), s.impressions,
      m.dealValue ?? '', m.targetCpm ?? '', m.realizedCpm ?? '', m.valueDelivered ?? '', m.deliveryPct ?? '',
      ...spots.map((sp) => (s.byPlacement && s.byPlacement[sp]) || 0)].join(','));
  });
  return lines.join('\r\n');
}

// Push the active brand's single-logo spot assignments into the live ad-slot state so the
// existing overlays (which read state.overtime.logo / state.replay.* / state.scoreboardAd.logo)
// reflect brand placements with no overlay changes. Only writes when a sponsor is tagged, so a
// manual Dashboard upload is preserved when no sponsor claims that spot.
function applyBrandSlots() {
  const b = activeBrand();
  if (!b) return;
  // Ownership check must span EVERY kit's sponsors (all packages), not just the active kit's —
  // otherwise a slot filled by the PREVIOUS kit's sponsor (e.g. trophi.ai on the scoreboard)
  // looks like a manual upload after switching kits and sticks forever. Mirrors the
  // all-kits replaySkin ownership set below.
  const sponsorLogos = new Set(savedBrandKits.flatMap((k) =>
    (k.packages || []).flatMap((p) => (p.sponsors || []).map((s) => s && s.logo))
      .concat((k.sponsors || []).map((s) => s && s.logo))
  ).filter(Boolean));
  // tagged → use it; no tag but the slot currently holds ANY brand sponsor → clear (the tick
  // was removed / the kit changed); otherwise keep (a manual Dashboard upload, not brand-owned).
  const resolve = (cur, tagged) => (tagged != null ? tagged : (sponsorLogos.has(cur) ? null : cur));
  state.overtime.logo = resolve(state.overtime.logo, b.spots.overtime);
  state.replay.logo = resolve(state.replay.logo, b.spots.replayGoal);
  state.replay.outroLogo = resolve(state.replay.outroLogo, b.spots.replayOutro);
  state.scoreboardAd.logo = resolve(state.scoreboardAd.logo, b.spots.scoreboard);
  // Replay transition BACKGROUND (skin): the active profile's image wins; a manual (non-brand) upload
  // is kept when the active profile has none, and a previous profile's skin is cleared when you switch.
  const allBrandSkins = new Set(savedBrandKits.flatMap((k) => (k.packages || []).map((p) => p.replaySkin).filter(Boolean)));
  state.replay.skin = (b.replaySkin != null) ? b.replaySkin : (allBrandSkins.has(state.replay.skin) ? null : state.replay.skin);
}

// Banner images for broadcast.
// When a brand kit is active: uses the kit's own banner images + sponsors tagged "banner".
// When no kit is active: falls back to the global main banner (state.banner).
function bannerForBroadcast() {
  const b = activeBrand();
  if (b) {
    const sponsorImages = b.bannerSponsors.map((s) => s.logo).filter(Boolean);
    const kitImages = b.bannerImages || [];
    return {
      visible: state.banner.visible,
      interval: b.bannerInterval,
      images: kitImages.concat(sponsorImages),
      ownImages: kitImages,
      sponsorCount: sponsorImages.length,
      kitId: b.id
    };
  }
  const own = state.banner.images || [];
  return { ...state.banner, images: own, ownImages: own, sponsorCount: 0, kitId: null };
}

// "Count down to 23:00" — resolve a wall-clock HH:MM into the next epoch it occurs at, in the
// SERVER's local timezone. Resolved here, not in the panel, so every client agrees on the target
// even if their own clocks/timezones differ. A time that has already passed today means tomorrow,
// which is what a producer typing "00:00" at 22:00 means.
function resolveClockTarget(hhmm) {
  const m = /^\s*(\d{1,2})\s*[:.]\s*(\d{2})\s*$/.exec(String(hhmm || ''));
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  const d = new Date();
  d.setHours(h, mi, 0, 0);
  let t = d.getTime();
  // Exactly-now counts as today (a 0s countdown), anything already past rolls to tomorrow.
  if (t < Date.now()) t += 24 * 60 * 60 * 1000;
  return t;
}

// Per-game default side colours (used when colorMode === 'default'). Mirrors the client map.
const GAME_DEFAULT_COLORS = {
  'rocket-league': { a: '#055fdb', b: '#e97139' },
  'csgo':          { a: '#5b8def', b: '#d6a44a' },   // CT blue / T tan
  'valorant':      { a: '#ff4655', b: '#23c08a' },   // Attackers / Defenders
  'league':        { a: '#2a7fff', b: '#e0383e' },   // Blue / Red
  'dota2':         { a: '#5aae4a', b: '#d34c3e' },   // Radiant / Dire
  'overwatch':     { a: '#055fdb', b: '#e0383e' },   // Defenders blue / Attackers red
  'rainbow6':      { a: '#2e7dd1', b: '#e08a2a' },
  'cod':           { a: '#055fdb', b: '#e97139' },
  'marvel-rivals': { a: '#055fdb', b: '#e97139' },
  'bedwars':       { a: '#e0383e', b: '#2a7fff' },   // classic Bedwars bed-team red / blue
  'smash':         { a: '#e0383e', b: '#2a7fff' },   // Smash player 1 red / player 2 blue
  'mobile-legends':{ a: '#2a7fff', b: '#e0383e' },
  'honor-of-kings':{ a: '#2a7fff', b: '#e0383e' },
  'the-finals':    { a: '#e0383e', b: '#f2c230' },   // THE FINALS red / gold
  'marvel-tokon':  { a: '#e0383e', b: '#2a7fff' },
  'brawlhalla':    { a: '#f24b3a', b: '#2f7de1' }    // Brawlhalla's own player-1 red / player-2 blue
};
const gameDefaultColors = (id) => GAME_DEFAULT_COLORS[id] || { a: '#055fdb', b: '#e97139' };
// Every colour that's a per-game default → lets us tell an un-customised placeholder team
// (still on a default colour) apart from a saved team carrying its own brand colour.
const DEFAULT_SIDE_COLOR_SET = new Set(
  Object.values(GAME_DEFAULT_COLORS).flatMap((c) => [c.a.toLowerCase(), c.b.toLowerCase()])
);

// Re-tint PLACEHOLDER side colours to the active game's defaults. A team carrying its own brand
// colour is left alone — only colours that are themselves a per-game default count as "unset".
// Called on set_game AND once at boot: without the boot call, a producer already sitting on a game
// never picks up a newly-added default (Smash stayed on Rocket League's blue/orange until they
// switched game and back).
/*
  Switch the active game and bring everything that is keyed to a game along with it.

  Extracted from the set_active_game WS case so a PLATFORM can do the same thing. A tournament
  platform knows which game its bracket is for — resolving that string and calling this is what
  lets a Challonge (or start.gg, or FACEIT) load land on the right overlay, team labels, roster
  size and default colours instead of whatever the producer happened to be on last.

  Returns true when the game actually changed.
*/
function applyActiveGame(g) {
  if (!g || !GAMES[g]) return false;
  const prev = state.activeGame;
  if (prev === g) return false;
  state.activeGame = g;
  // Re-tint placeholder team colours to the new game's defaults (e.g. Overwatch → blue/red)
  // so the Match-Teams cards reflect the game. Saved teams' own brand colours are preserved
  // because those aren't part of the default palette.
  applyGameDefaultSideColors();
  if (directorEngine) directorEngine.reset();
  // Map Pool and Draft are keyed to the OLD game's pool/roster (map ids, hero rosters,
  // ban formats) — leaving them as-is showed stale maps/heroes from the previous game
  // (or Overwatch's ban board hanging around after switching away from Overwatch). Reset
  // both to their clean not-started shape so the next Start Veto / Start Draft builds
  // fresh from the NEW game's pool.
  if (prev !== g) {
    state.veto = { visible: false, title: '', maps: [] };
    // Board content resets (old game's pool/roster), but PRODUCER PREFERENCES survive:
    // teamStart and the Overwatch ban count are settings, not board state — resetting
    // owBanCount to 4 here silently undid "one ban per team" every time the game switched.
    state.draft = { visible: false, title: '', subtitle: '',
      game: '', teamStart: (state.draft && state.draft.teamStart) || 'a',
      owBanCount: (state.draft && state.draft.owBanCount) || 2,
      ...draftLookPrefs(state.draft),
      sequence: [], ops: [], turn: null, complete: false,
      auto: (state.draft && state.draft.auto) || { enabled: false, status: 'off', statusDetail: '', lockfilePath: '' } };
  }
  // Stop data connections for the previous game
  if (prev === 'rocket-league' && g !== 'rocket-league') disconnectRL();
  if (prev === 'valorant' && g !== 'valorant') stopValorantWatchdog();
  if (prev === 'league' && g !== 'league') stopLolPolling();
  if (prev === 'apex' && g !== 'apex') stopApexServer();
  // Start data connections for the new game
  if (g === 'rocket-league' && prev !== 'rocket-league') connectToRL();
  if (g === 'valorant') startValorantWatchdog();
  if (g === 'league') startLolPolling();
  if (g === 'apex') startApexServer();
  if (g === 'marvel-rivals') {
    if (!state.mrMatch) state.mrMatch = { visible: true, format: 'BO5', bansByMap: [], gameMode: 'convergence', showMapLabels: true, mapWinners: [], mapModes: [], gepData: null };
    state.mrMatch.visible = true;
  }
  return true;
}

/*
  Adopt the game a tournament platform says its bracket is for.

  Every platform hands the game over as free text and spells it its own way, so resolving it lives
  in backend/game-match.js and this is the one place that ACTS on the answer. Returns
  { id, changed } — id '' means "we couldn't tell", and in that case we deliberately do nothing:
  switching to a guessed game would swap the overlay, the team labels and the roster size out from
  under the producer, which is worse than leaving them where they were.

  `pinned` is the producer's own choice. They can always override the platform afterwards with the
  header dropdown, and a manual pick must survive the next poll — so only a LOAD passes
  pinned:false, never the refresh.
*/
// The start.gg event whose game was last adopted (event load or the first pushed set from it).
let _gameAdoptedForEventSlug = '';
function adoptEventGame(gameName, { pinned = false } = {}) {
  const id = resolveGameId(gameName, Object.keys(GAMES));
  if (!id || pinned) return { id, changed: false };
  const changed = applyActiveGame(id);
  if (changed) console.log(`[platform] game set to ${GAMES[id].name} from "${gameName}"`);
  return { id, changed };
}

function applyGameDefaultSideColors() {
  const dc = gameDefaultColors(state.activeGame);
  let changed = false;
  if (state.teams.blue && DEFAULT_SIDE_COLOR_SET.has((state.teams.blue.color || '').toLowerCase())
      && state.teams.blue.color !== dc.a) { state.teams.blue.color = dc.a; changed = true; }
  if (state.teams.orange && DEFAULT_SIDE_COLOR_SET.has((state.teams.orange.color || '').toLowerCase())
      && state.teams.orange.color !== dc.b) { state.teams.orange.color = dc.b; changed = true; }
  return changed;
}

// The colours overlays should actually render for each side, per the active colour mode.
// NON-DESTRUCTIVE: never mutates state.teams — the team's own colour is preserved so the
// 'team' mode (and the saved team library) always keep their real values.
function effectiveTeamColors() {
  const mode = state.colorMode || 'team';
  if (mode === 'brand') {
    const b = activeBrand();
    return { blue: (b && b.color) || state.teams.blue.color, orange: (b && b.accent) || state.teams.orange.color };
  }
  if (mode === 'default') {
    const c = gameDefaultColors(state.activeGame);
    return { blue: c.a, orange: c.b };
  }
  if (mode === 'game') {
    // In-game (RL private-match paint) colours reported live by the Stats API — fall back to the
    // team's own colour for a side the feed hasn't sent a colour for yet.
    const g = state.gameTeams || {};
    return { blue: g.blueColor || state.teams.blue.color, orange: g.orangeColor || state.teams.orange.color };
  }
  return { blue: state.teams.blue.color, orange: state.teams.orange.color };
}

// Snapshot of the event-level broadcast configuration (not live match scores).
function capturePreset() {
  return {
    activeGame: state.activeGame,
    theme: state.themesByGame[state.activeGame] || 'default',
    eventName: state.eventName,
    gameLabel: state.gameLabel,
    roundLabel: state.roundLabel,
    teamRecord: state.teamRecord,
    startggLeagueStandings: state.startggLeagueStandings,
    speedUnit: state.speedUnit,
    fontFamily: state.fontFamily,
    bestOf: state.bestOf,
    facecamsEnabled: state.facecamsEnabled,
    // By VALUE — a reference meant later live edits silently rewrote the saved preset.
    banner: structuredCloneSafe(state.banner),
    ticker: structuredCloneSafe(state.ticker),
    casters: structuredCloneSafe(state.casters)
  };
}
function structuredCloneSafe(v) { try { return JSON.parse(JSON.stringify(v)); } catch (_) { return v; } }
// Caster set-up that belongs to the install, not to a show preset — loading a preset must not
// roll these back to whatever they were when the preset was saved.
const PRESET_KEEP_CASTER_KEYS = ['library', 'vdo', 'rooms', 'apiKey', 'shifts', 'support'];

function applyPreset(cfg) {
  if (!cfg || typeof cfg !== 'object') return;
  if (cfg.activeGame && GAMES[cfg.activeGame]) state.activeGame = cfg.activeGame;
  if (cfg.theme && isValidTheme(state.activeGame, cfg.theme)) {
    state.themesByGame[state.activeGame] = cfg.theme;
  }
  if (typeof cfg.eventName === 'string') state.eventName = cfg.eventName;
  if (typeof cfg.gameLabel === 'string') state.gameLabel = cfg.gameLabel;
  if (typeof cfg.roundLabel === 'string') state.roundLabel = cfg.roundLabel;
  if (cfg.speedUnit === 'mph' || cfg.speedUnit === 'kmh') state.speedUnit = cfg.speedUnit;
  if (cfg.teamRecord && typeof cfg.teamRecord === 'object') state.teamRecord = { ...state.teamRecord, ...cfg.teamRecord };
  if (cfg.startggLeagueStandings && typeof cfg.startggLeagueStandings === 'object') state.startggLeagueStandings = { ...state.startggLeagueStandings, ...cfg.startggLeagueStandings };
  if (typeof cfg.fontFamily === 'string') state.fontFamily = cfg.fontFamily;
  if (cfg.bestOf) state.bestOf = cfg.bestOf;
  if (typeof cfg.facecamsEnabled === 'boolean') state.facecamsEnabled = cfg.facecamsEnabled;
  if (cfg.banner && typeof cfg.banner === 'object') state.banner = structuredCloneSafe(cfg.banner);
  if (cfg.ticker && typeof cfg.ticker === 'object') state.ticker = structuredCloneSafe(cfg.ticker);
  if (cfg.casters && typeof cfg.casters === 'object') {
    const cur = state.casters || {};
    const next = structuredCloneSafe(cfg.casters);
    PRESET_KEEP_CASTER_KEYS.forEach((k) => { if (k in cur) next[k] = cur[k]; });
    state.casters = next;
  }
}

// Show Deck support / tournament-ops roles. Kept in sync with control-panel TD_SUPPORT_LABEL +
// the #td-support-role-sel options — used only to migrate the legacy group-based support column
// into the event-scoped state.casters.support list.
const TD_SUPPORT_LABELS = { producer: 'Producer', admin: 'Tournament Admin', coordinator: 'Coordinator', replay: 'Replay Op', stats: 'Statistician', moderator: 'Moderator', graphics: 'Graphics', flex: 'Flex', socials: 'Social' };
const TD_SUPPORT_GROUPS = Object.keys(TD_SUPPORT_LABELS);

// ── Crew roster mirror → cloud ────────────────────────────────────────────────
// Debounced push of the crew list (names/handles/countries only — never pay/contact fields) to
// the org so the website's station join pages can offer "pick your crew profile". Fire-and-
// forget: any failure just means the join page falls back to a free-text name box.
let _crewRosterSyncT = null;
function syncCrewRosterToCloud() {
  try {
    if (!cloud.authed()) return;
    const s = cloud.getSession() || {};
    const orgId = s.workspaceId;
    if (!orgId || String(orgId).startsWith('user:')) return;
    clearTimeout(_crewRosterSyncT);
    _crewRosterSyncT = setTimeout(() => {
      const crew = (state.crew || [])
        .filter((c) => c && c.name)
        .map((c) => ({ name: c.name, handle: c.handle || '', country: c.country || '', role: c.role || '', group: c.group || '' }));
      cloud.pushCrewRoster(orgId, crew).catch(() => {});
    }, 4000);
  } catch (_) { /* cloud not configured — local-first, never throws */ }
}

// ── cloudLoop: the one scheduler for every background cloud poll ───────────────────
// Replaces the bare `setInterval(fn, ms)` these polls used to run on. Three things that shape
// got wrong, in order of how much damage they did:
//
//  1. BACKOFF. Every poll was a fixed interval with an empty catch, so an unwell backend got hit
//     at exactly the same rate as a healthy one, forever. The breaker in cloud-client.js watches
//     every request; while it says "suspended" this skips the tick WITHOUT making a request, so
//     one outage quiets all of them together and the recovery window actually opens. (An exhausted
//     Upstash quota taking the whole site down is precisely this failure.)
//  2. JITTER, always — not just while failing. Desks boot together before a scheduled show, so
//     their fixed intervals stay in lockstep all night and land as a burst on every tick. A spread
//     start + spread period de-correlates them permanently.
//  3. NO OVERLAP. setInterval fires on schedule whether or not the previous run finished; on a
//     slow link that stacks runs. Each cycle is armed only after the previous one settles.
//
// `fn` may swallow its own errors (most of these do, deliberately — a transient cloud blip must
// never surface mid-show); the breaker still sees the failed request underneath, so backoff works
// either way. Anything fn DOES throw is caught here and backs this one loop off on its own.
const _cloudLoops = new Map();   // name -> status, surfaced in the panel's cloud status readout
function cloudLoop(name, fn, baseMs, opts = {}) {
  const maxMs = opts.maxMs || Math.max(baseMs * 8, 5 * 60 * 1000);
  const spread = (opts.jitter == null ? 0.2 : opts.jitter);
  const jitter = (ms) => Math.max(1000, Math.round(ms * (1 + (Math.random() * 2 - 1) * spread)));
  const st = { name, baseMs, fails: 0, lastRunAt: 0, lastOkAt: 0, lastError: '', nextAt: 0, running: false };
  _cloudLoops.set(name, st);

  const arm = (ms) => { st.nextAt = Date.now() + ms; setTimeout(run, ms); };

  async function run() {
    st.running = true;
    let next = baseMs;
    try {
      // Breaker open: skip the call entirely and look again just after it lifts. Deliberately does
      // NOT count as a failure of this loop — it never got to try.
      const held = (typeof cloud.retryInMs === 'function') ? cloud.retryInMs() : 0;
      if (held > 0) {
        next = Math.min(held + 500, maxMs);
      } else {
        st.lastRunAt = Date.now();
        await fn();
        st.lastOkAt = Date.now();
        if (st.fails) { console.log(`[cloudLoop:${name}] recovered after ${st.fails} failure(s)`); st.fails = 0; }
        st.lastError = '';
      }
    } catch (e) {
      st.fails++;
      st.lastError = (e && e.message) || String(e);
      // First failure only — a loop that has been down an hour must not fill the log with it.
      if (st.fails === 1) console.warn(`[cloudLoop:${name}] failed, backing off:`, st.lastError);
      next = Math.min(baseMs * Math.pow(2, Math.min(st.fails, 6)), maxMs);
    } finally {
      st.running = false;
      arm(jitter(next));
    }
  }

  arm(jitter(opts.startAfterMs != null ? opts.startAfterMs : baseMs));
  return st;
}

// ── pollLoop: the same discipline for the third-party polls a producer can switch on and off ──
// start.gg queue, Challonge, Challengermode, NXGEN, FACEIT, Google Sheets, My Events, the team
// spotlight and Twitch prediction polling used to be bare setInterval calls: fixed cadence, runs
// stacking up behind a slow API, every desk hitting the platform in lockstep. This gives each of
// them no-overlap, jitter and exponential backoff on a throw, without the cloud breaker (these
// are not Nameless calls, so one platform's outage must not quiet the others). Unlike cloudLoop
// the handle can be stopped, because these polls follow a checkbox.
//   const h = pollLoop('challonge', tick, 30000, { runNow: true });  ...  h.stop();
// fn may swallow its own errors (most do); a throw backs this loop off on its own.
// Every integration poll, by name, for the panel: only FAILING ones are broadcast (pollFailures), so a
// healthy show adds nothing to the payload and the operator sees which integration is down, why, and
// when it last worked.
const _pollLoops = new Map();
function pollFailures() {
  const out = [];
  _pollLoops.forEach((l) => { if (!l.stopped && l.fails > 0) out.push({ name: l.name, fails: l.fails, lastError: String(l.lastError || '').slice(0, 200), lastOkAt: l.lastOkAt }); });
  return out;
}
function pollLoop(name, fn, baseMs, opts = {}) {
  const maxMs = opts.maxMs || Math.max(baseMs * 8, 5 * 60 * 1000);
  const spread = (opts.jitter == null ? 0.15 : opts.jitter);
  const jitter = (ms) => Math.max(1000, Math.round(ms * (1 + (Math.random() * 2 - 1) * spread)));
  const st = { name, baseMs, fails: 0, lastRunAt: 0, lastOkAt: 0, lastError: '', nextAt: 0, running: false, stopped: false, timer: null };
  _pollLoops.set(name, st);   // a restarted loop replaces its old entry
  const arm = (ms) => { if (st.stopped) return; st.nextAt = Date.now() + ms; st.timer = setTimeout(run, ms); };
  async function run() {
    if (st.stopped) return;
    st.timer = null;
    st.running = true;
    let next = baseMs;
    try {
      st.lastRunAt = Date.now();
      // fn gets the loop handle: after an await it can check handle.stopped, because stop() only
      // cancels the NEXT run, and a run already in flight (switching start.gg events, say) would
      // otherwise apply the old source's data on top of the new one.
      await fn(st);
      st.lastOkAt = Date.now();
      if (st.fails) { console.log(`[poll:${name}] recovered after ${st.fails} failure(s)`); tl('poll.recovered', { poll: name, after: st.fails }); st.fails = 0; st.lastError = ''; try { broadcastFullState(); } catch (e) {} }
      st.lastError = '';
    } catch (e) {
      st.fails++;
      st.lastError = (e && e.message) || String(e);
      if (st.fails === 1) { console.warn(`[poll:${name}] failed, backing off:`, st.lastError); tl('poll.failing', { poll: name, error: st.lastError }); }
      if (st.fails === 3) { try { broadcastFullState(); } catch (e2) {} }   // the panel's warning starts at 3 in a row
      next = Math.min(baseMs * Math.pow(2, Math.min(st.fails, 6)), maxMs);
    } finally {
      st.running = false;
      arm(jitter(next));
    }
  }
  st.stop = () => { st.stopped = true; if (st.timer) { clearTimeout(st.timer); st.timer = null; } if (_pollLoops.get(name) === st) _pollLoops.delete(name); };
  if (opts.runNow) run(); else arm(jitter(baseMs));
  return st;
}

// ── Station check-ins → the desk, automatically ──────────────────────────────
// Polls the org's website stations and fills claimed CASTER feeds straight into the caster
// library + desk lineup (web slot N → desk slot N, never bumping an occupied slot) and links/
// creates the crew record — so a caster clicking a join link shows up in the browser sources
// and overlays with zero producer clicks. Additive only: a caster leaving never yanks anyone
// off air. Toggleable via casters.autoFillFromStations (default ON when cloud-linked).
let _stationSyncBusy = false;
async function stationAutoSync(opts) {
  // force: producer clicked "Re-sync desk to live feeds" — re-identify EVERY slot (manual entries
  // included) to whoever's actually in it now, overriding the "manual entries are never renamed" rule.
  const forceReident = !!(opts && opts.force);
  if (_stationSyncBusy) return;
  try {
    if (state.casters && state.casters.autoFillFromStations === false && !forceReident) return;
    if (!cloud || typeof cloud.authed !== 'function' || !cloud.authed()) return;
    const s = cloud.getSession() || {};
    const orgId = s.workspaceId;
    if (!orgId || String(orgId).startsWith('user:')) return;
    _stationSyncBusy = true;
    const [{ feeds }, liveStations] = await Promise.all([
      cloud.listStationFeeds(orgId),
      cloud.listStations(orgId).catch(() => null),
    ]);
    // Station binding: with several desks running, only THIS app's bound station may fill the
    // desk — otherwise two stations' "Caster 1"s race for slot 1. '' = follow all (single-desk orgs).
    let bind = (state.casters && state.casters.stationId) || '';
    const activeStations = (liveStations || []).filter((st) => st && st.status === 'active');
    // STALE binding self-heal: stations get deleted/recreated during setup; a binding pointing
    // at a dead station filtered EVERY feed out and auto-fill died silently ("casters stopped
    // landing on the overlays"). If the bound station no longer exists, clear the binding.
    if (bind && liveStations && !liveStations.some((st) => st && st.id === bind)) {
      console.warn('[Stations] Bound station no longer exists — clearing the binding');
      state.casters.stationId = '';
      bind = '';
      saveAppState();
      broadcastFullState();
    }
    // ISOLATION: several stations active but this app is UNBOUND → do nothing rather than pull
    // every desk's casters into one app (two producers' "Caster 1"s would fight). The panel's
    // Cloud Stations section tells the producer to pick their station; a single active station
    // auto-follows as before.
    if (!bind && activeStations.length > 1) return;
    const allCasterFeeds = (feeds || []).filter((f) => f && f.kind === 'caster' && f.obsViewUrl && (!bind || f.stationId === bind));
    // Auto-fill suppression: casters the producer explicitly pulled off the desk stay off (see
    // suppressAutoFill). Prune the list to people STILL checked in — someone who dropped and
    // re-checks-in is a fresh signal, so they become eligible to auto-fill again.
    if (Array.isArray(state.casters.autoFillSuppress) && state.casters.autoFillSuppress.length) {
      const liveKeys = new Set(allCasterFeeds.map((f) => (f.personName || '').trim().toLowerCase()).filter(Boolean));
      const kept = state.casters.autoFillSuppress.filter((k) => liveKeys.has(k));
      if (kept.length !== state.casters.autoFillSuppress.length) {
        state.casters.autoFillSuppress = kept;
        saveAppState();
        broadcastFullState();
      }
    }
    const suppressed = new Set(state.casters.autoFillSuppress || []);
    const casters = allCasterFeeds.filter((f) => !suppressed.has((f.personName || '').trim().toLowerCase()));
    if (!casters.length) return;
    // Live feed URLs — used below to displace STALE auto-created occupants (a recreated room
    // mints new view URLs; the old auto-entry kept the desk slot with a dead feed, blocking
    // the fresh check-in from ever reaching the overlay).
    const liveUrls = new Set((feeds || []).map((f) => f && f.obsViewUrl).filter(Boolean));
    if (!Array.isArray(state.casters.library)) state.casters.library = [];
    if (!Array.isArray(state.casters.lineup)) state.casters.lineup = [];
    let changed = false;
    for (const f of casters) {
      const nm = (f.personName || '').trim();
      const key = nm.toLowerCase();
      // Self-entered on-air profile from the join page (new casters with no crew profile yet) —
      // { realName, country, social, socialHandle }. Fills the desk nameplate + crew twin so the
      // overlays show their info. Producer edits downstream always win; nm is treated as the gamertag.
      const prof = (f.profile && typeof f.profile === 'object') ? f.profile : null;
      let entry = state.casters.library.find((c) => c && (c.camUrl === f.obsViewUrl || c.vdoOverride === f.obsViewUrl));
      if (!entry && key) {
        // SAME PERSON already in the library (added via Crew/DCC/Show Deck)? Adopt that entry
        // and point it at the station feed instead of creating a name-twin — duplicates made
        // the Show Deck/DCC (which resolve by NAME) and auto-fill (which resolved by URL)
        // fight over two records of one caster, and castercam went dark whenever the twin
        // without the feed URL won a slot. An explicit vdoOverride still wins untouched.
        entry = state.casters.library.find((c) => c && ((c.name || '').toLowerCase() === key || (c.handle || '').toLowerCase() === key));
        if (entry && !entry.vdoOverride && entry.camUrl !== f.obsViewUrl) {
          entry.camUrl = f.obsViewUrl;
          changed = true;
        }
      }
      if (!entry) {
        // Crew twin: the join page offers crew profiles by name, so a name match means that
        // crew member checked in (mark on shift); an unknown name gets a fresh crew profile.
        if (!Array.isArray(state.crew)) state.crew = [];
        let cm = key ? state.crew.find((c) => c && ((c.name || '').toLowerCase() === key || (c.handle || '').toLowerCase() === key)) : null;
        if (!cm && nm) {
          // New self-serve caster: gamertag → handle, self-entered real name → name (falls back to
          // gamertag), socials/country from their profile so the overlays aren't blank.
          cm = { id: Math.random().toString(36).slice(2, 11), name: (prof && prof.realName) || nm, handle: prof ? nm : '', role: '', group: 'casters', social: (prof && prof.social) || 'none', socialHandle: (prof && prof.socialHandle) || '', defaultCam: '', country: (prof && prof.country) || '', paypal: '', notes: '', active: true, workedEvent: true };
          state.crew.push(cm);
        } else if (cm) {
          cm.active = true; cm.workedEvent = true;
          // A returning caster who self-filled backfills BLANKS on their crew twin — never overwrites
          // anything the producer already set.
          if (prof) {
            if (prof.socialHandle && !cm.socialHandle) cm.socialHandle = prof.socialHandle;
            if (prof.social && (!cm.social || cm.social === 'none')) cm.social = prof.social;
            if (prof.country && !cm.country) cm.country = prof.country;
            if (prof.realName && (!cm.name || cm.name.toLowerCase() === key)) cm.name = prof.realName;
          }
        }
        entry = {
          id: 'cs_' + Math.random().toString(36).slice(2, 11),
          name: (cm && cm.name) || (prof && prof.realName) || nm || 'Caster', handle: (cm && cm.handle) || (prof ? nm : ''), role: '',
          camUrl: f.obsViewUrl,
          social: (cm && cm.social) || (prof && prof.social) || 'none',
          socialHandle: (cm && cm.socialHandle) || (prof && prof.socialHandle) || '',
          country: (cm && cm.country) || (prof && prof.country) || '',
          kind: 'caster'
        };
        state.casters.library.push(entry);
        changed = true;
      } else if (key) {
        // TAKE-OVER: web slots keep their stream id, so when a DIFFERENT person claims the same
        // placement the feed URL matches the previous occupant's auto entry — the video changed
        // but the desk kept the old name/socials. Re-identify auto-managed (cs_) entries to the
        // new person; manual entries are never renamed AUTOMATICALLY (a gamertag feed legitimately
        // maps to a real-name manual entry by URL) — only a forced "Re-sync desk" renames them.
        const entryKeys = [entry.name, entry.handle].map((v) => (v || '').toLowerCase()).filter(Boolean);
        if ((forceReident || String(entry.id || '').startsWith('cs_')) && !entryKeys.includes(key)) {
          const twin = (state.crew || []).find((c) => c && ((c.name || '').toLowerCase() === key || (c.handle || '').toLowerCase() === key)) || null;
          entry.name = (twin && twin.name) || (prof && prof.realName) || nm;
          entry.handle = (twin && twin.handle) || (prof ? nm : '');
          entry.socialHandle = (twin && twin.socialHandle) || (prof && prof.socialHandle) || '';
          entry.social = (twin && twin.social) || (prof && prof.social) || 'none';
          entry.country = (twin && twin.country) || (prof && prof.country) || '';
          changed = true;
          console.log('[Stations] Web slot take-over — desk entry re-identified to', nm);
        }
        // Adopted or URL-matched entry: still mark the crew twin on shift for the Show Deck.
        const cm = (state.crew || []).find((c) => c && ((c.name || '').toLowerCase() === key || (c.handle || '').toLowerCase() === key));
        if (cm && (!cm.active || !cm.workedEvent)) { cm.active = true; cm.workedEvent = true; changed = true; }
      }
      // Heal twins earlier passes already created (same person, auto-created cs_ id, same feed):
      // merge them into the surviving entry and re-point any desk slots they held.
      if (key) {
        const twinIds = new Set(state.casters.library
          .filter((c) => c && c !== entry && String(c.id || '').startsWith('cs_')
            && (c.name || '').toLowerCase() === key && c.camUrl === f.obsViewUrl)
          .map((c) => c.id));
        if (twinIds.size) {
          state.casters.library = state.casters.library.filter((c) => !twinIds.has(c.id));
          (state.casters.lineup || []).forEach((l) => { if (l && twinIds.has(l.libraryId)) { l.libraryId = entry.id; l.streamId = entry.id; } });
          changed = true;
        }
      }
      const targetSlot = (Number(f.idx) || 0) + 1;
      if (targetSlot >= 1 && targetSlot <= 4) {
        // THE WEB PLACEMENT IS AUTHORITATIVE for auto-managed casters: whoever the website says
        // is Caster N sits in desk slot N — take-overs switch, placement moves follow. Only a
        // MANUAL occupant (an entry the producer created themselves — non-cs_ id) holds a slot
        // against the web; ghosts (no library entry) and any auto (cs_) occupant are displaced.
        const occupant = state.casters.lineup.find((l) => l && Number(l.slot) === targetSlot && l.libraryId !== entry.id);
        if (occupant) {
          const occEntry = state.casters.library.find((c) => c && c.id === occupant.libraryId);
          const occAuto = !occEntry || String(occEntry.id || '').startsWith('cs_');
          if (occAuto) {
            state.casters.lineup = state.casters.lineup.filter((l) => l !== occupant);
            changed = true;
            console.log('[Stations] Desk slot ' + targetSlot + ': displaced ' + (occEntry ? ('auto occupant "' + (occEntry.name || '?') + '"') : 'GHOST') + ' — web says ' + (entry.name || '?'));
          }
        }
        const blocked = state.casters.lineup.some((l) => l && Number(l.slot) === targetSlot && l.libraryId !== entry.id);
        if (!blocked) {
          const mine = state.casters.lineup.find((l) => l && l.libraryId === entry.id);
          if (mine) {
            if (Number(mine.slot) !== targetSlot) {
              mine.slot = targetSlot;   // caster switched placements on the web — follow them
              changed = true;
            }
          } else {
            state.casters.lineup.push({ libraryId: entry.id, slot: targetSlot, roomId: '', streamId: entry.id });
            changed = true;
          }
        }
      }
    }
    if (changed) {
      resolveLineupToList();
      saveAppState();
      broadcastFullState();
      console.log('[Stations] Auto-filled the desk from station check-ins');
    }
  } catch (_) { /* transient cloud errors — next poll retries */ }
  finally { _stationSyncBusy = false; }
}
cloudLoop('stations', () => stationAutoSync(), 20000);

// ── Camera check-ins → facecams, automatically ───────────────────────────────
// A player who picked their IN-GAME player on the website camera page arrives with ingameName —
// map their feed straight into savedFacecams (keyed by in-game name) so RL/CS2 facecam overlays
// follow them with zero producer clicks. The producer's hand still wins: an existing facecam
// entry with a link is NEVER overwritten (set it in Match — Teams ▸ player Edit as always).
let _cameraSyncBusy = false;
async function cameraFacecamAutoSync() {
  if (_cameraSyncBusy) return;
  try {
    if (state.casters && state.casters.autoFillFromStations === false) return;   // same master switch
    if (!cloud || typeof cloud.authed !== 'function' || !cloud.authed()) return;
    const s = cloud.getSession() || {};
    const orgId = s.workspaceId;
    if (!orgId || String(orgId).startsWith('user:')) return;
    _cameraSyncBusy = true;
    const feeds = await cloud.listCameraFeeds(orgId);
    let changed = false;
    for (const f of (feeds || [])) {
      const gn = (f && f.ingameName ? String(f.ingameName) : '').trim();
      if (!gn || !f.obsViewUrl) continue;
      const idx = savedFacecams.findIndex((fc) => fc && fc.name === gn);
      if (idx >= 0) {
        // Producer's mapping wins — including an explicit clear-to-blank (manuallySet), not just
        // a non-empty link. A plain `if (link)` truthy check treated "cleared to blank" the same
        // as "never mapped" and silently reinstated the auto-fed link on the next tick.
        if (savedFacecams[idx].link || savedFacecams[idx].manuallySet) continue;
        savedFacecams[idx] = { ...savedFacecams[idx], link: f.obsViewUrl };
        changed = true;
      } else {
        savedFacecams.push({ name: gn, platform: '', platformId: '', link: f.obsViewUrl, nickname: (f.personName || gn) });
        changed = true;
      }
    }
    if (changed) {
      saveFacecams();
      broadcastFullState();
      console.log('[Cameras] Auto-mapped facecams from camera check-ins');
    }
  } catch (_) { /* transient — next poll retries */ }
  finally { _cameraSyncBusy = false; }
}
cloudLoop('cameras', () => cameraFacecamAutoSync(), 20000);

// ── AI telemetry upload (Phase 2, opt-in) ──────────────────────────────────────
// Batches already-recorded local Decision Records (backend/telemetry/recorder.js) to the shared
// cloud training dataset. _telemetryUploader is created at engine init (below, alongside the
// recorder) since dataDir isn't known this early; this function is a no-op until then.
let _telemetryUploader = null;
let _telemetryUploadBusy = false;
async function telemetryAutoSync() {
  if (_telemetryUploadBusy) return;
  try {
    if (!_telemetryUploader) return;
    if (!cloud || typeof cloud.authed !== 'function' || !cloud.authed()) return;
    if (!state.ai?.telemetry?.uploadEnabled) return;
    _telemetryUploadBusy = true;
    const { records, pendingCursor } = _telemetryUploader.collectUnsentBatch();
    if (!records.length) return;
    const result = await cloud.uploadTelemetryBatch(records);
    if (result && result.ok) {
      _telemetryUploader.commit(pendingCursor);
      state.ai.telemetry.lastUploadAt = Date.now();
      state.ai.telemetry.lastUploadCount = (state.ai.telemetry.lastUploadCount || 0) + (result.inserted || 0);
      saveAppState();
      broadcastFullState();
    }
    // result not ok (shouldn't normally happen — cloud.uploadTelemetryBatch throws on non-2xx) —
    // cursor simply isn't committed, so the same records are retried next tick.
  } catch (_) { /* transient — next poll retries; cursor NOT advanced, nothing lost */ }
  finally { _telemetryUploadBusy = false; }
}

// ── Org Library sync (teams / brand kits / facecams / casters) ────────────────
// PUSH: debounced upload of THIS app's own library as the producer's workspace-shared profile, so
// every org-mate's app can pull it. Fire-and-forget; only runs when signed into a real org and the
// autoSync toggle is on. See buildProfileBundle() (_own filter) + orgLibrary state.
let _orgPushT = null;
function syncProfileToCloud() {
  try {
    if (!state.orgLibrary || state.orgLibrary.autoSync === false) return;
    if (!cloud.authed()) return;   // push for ANY signed-in user (this fills their OWN Team Library on
                                   // the website); org sharing below is the only org-gated part.
    clearTimeout(_orgPushT);
    _orgPushT = setTimeout(() => { pushProfileNow().catch(() => {}); }, 4000);
  } catch (_) { /* cloud not configured */ }
}
// Immediate (un-debounced) push — used by syncProfileToCloud's timer, the initial startup/sign-in
// push, and the manual "Share my library" button. Saves the producer's own library to their default
// cloud profile (which is exactly what the website Team Library page renders) and, when they're in a
// real org, shares it to the workspace so org-mates can pull it.
async function pushProfileNow() {
  if (!cloud.authed()) return { ok: false, message: 'Not signed in.' };
  const s = cloud.getSession() || {};
  const orgId = s.workspaceId;
  const isOrg = !!(orgId && !String(orgId).startsWith('user:'));
  const saved = await cloud.saveProfile(buildProfileBundle(), { id: state.orgLibrary.profileId || undefined });
  if (saved && saved.id) {
    const firstShare = state.orgLibrary.profileId !== saved.id;
    state.orgLibrary.profileId = saved.id;
    state.orgLibrary.lastPush = Date.now();
    if (isOrg && firstShare) await cloud.shareProfile(saved.id, 'workspace').catch(() => {});   // make it org-visible (idempotent)
    saveAppState();
  }
  return { ok: true, isOrg };
}
// Initial push once the session has loaded — so a producer's EXISTING teams reach the website without
// having to edit one first (the on-change trigger only fires on a fresh save). Fire-and-forget.
setTimeout(() => { syncProfileToCloud(); }, 6000);

// PULL: fold every org-mate's workspace-shared library into ours, TAGGED _org so it lands in the
// "From organization" category (searchable everywhere, never re-pushed as ours). Rebuilds the whole
// _org-tagged subset each run — additive to local items, never clobbers a same-named local one.
let _orgPullBusy = false;
let _orgLibSig = '';
// Incremental pull state. /api/profiles returns METADATA ONLY (see the website's ProfileMeta) and
// every row already carries a monotonic `rev`, so we can tell what changed without downloading
// anything. The bundles themselves — which carry base64 logos inline — are only fetched for
// profiles whose rev moved.
//
// Before this, every tick downloaded EVERY org-mate's full bundle: at 60 sites that is 59 bundles
// a minute, per desk, bypassing the LIVE/LIBRARY payload tiering and the image vault that exist
// precisely to keep blobs off the wire. Steady state is now one small metadata request a minute.
let _orgRevSig = '';                      // id:rev of every mate on the last completed pull
const _orgBundles = new Map();            // profileId -> { rev, owner, data, bytes }
let _orgBundleBytes = 0;
const ORG_BUNDLE_BUDGET = 24 * 1024 * 1024;   // cap the cache; over budget we re-fetch instead of hoarding

async function pullOrgLibrary(opts = {}) {
  if (_orgPullBusy) return { changed: false };
  try {
    if (!cloud.authed()) return { changed: false };
    const s = cloud.getSession() || {};
    const orgId = s.workspaceId;
    if (!orgId || String(orgId).startsWith('user:')) return { changed: false };
    _orgPullBusy = true;
    const profiles = await cloud.listProfiles();
    const mates = (profiles || []).filter((p) => p && p.mine === false);

    // Forget mates who left the org / deleted a profile, so the cache can't grow without bound and
    // a departed producer's teams don't linger in the union.
    const liveIds = new Set(mates.map((p) => p.id));
    for (const [id, hit] of _orgBundles) {
      if (!liveIds.has(id)) { _orgBundleBytes -= hit.bytes || 0; _orgBundles.delete(id); }
    }

    // Nothing anyone owns has changed since the last pull → the union cannot have changed either.
    // This is the overwhelmingly common case, and it costs exactly one metadata request.
    // 'none' rather than '' so a solo producer in an org (no mates) also early-outs instead of
    // rebuilding the union from nothing every minute.
    const revSig = mates.length ? mates.map((p) => `${p.id}:${p.rev == null ? '?' : p.rev}`).sort().join('|') : 'none';
    if (revSig && revSig === _orgRevSig && !opts.force) {
      state.orgLibrary.lastPull = Date.now();
      return { changed: false, skipped: 'unchanged', mates: mates.length };
    }

    const bundles = [];
    let fetched = 0, reused = 0, failed = 0;
    for (const p of mates) {
      const owner = p.ownerName || 'A producer';
      const hit = _orgBundles.get(p.id);
      // rev is a monotonic counter bumped on every save, so equal rev = byte-identical bundle.
      if (hit && p.rev != null && hit.rev === p.rev && !opts.force) {
        reused++;
        bundles.push({ owner, data: hit.data });
        continue;
      }
      try {
        const full = await cloud.getProfile(p.id);
        const data = (full.bundle || full || {}).data || {};
        fetched++;
        bundles.push({ owner, data });
        if (hit) { _orgBundleBytes -= hit.bytes || 0; _orgBundles.delete(p.id); }
        if (p.rev != null) {
          let bytes = 0;
          try { bytes = JSON.stringify(data).length; } catch (_) { bytes = 0; }
          // Only cache what we can afford. Over budget we simply don't remember this one and
          // re-fetch it next time its rev moves — correctness never depends on the cache.
          if (bytes && _orgBundleBytes + bytes <= ORG_BUNDLE_BUDGET) {
            _orgBundles.set(p.id, { rev: p.rev, owner, data, bytes });
            _orgBundleBytes += bytes;
          }
        }
      } catch (_) { failed++; /* skip unreadable — revSig is not latched below, so we retry next tick */ }
    }
    if (fetched) console.log(`[OrgLibrary] pulled ${fetched} changed bundle(s), reused ${reused} cached`);
    // Drop the previous org-tagged set; local (untagged) items always win on name/id collision.
    savedTeams     = savedTeams.filter((t) => !t || !t._org);
    savedBrandKits = savedBrandKits.filter((k) => !k || !k._org);
    savedFacecams  = savedFacecams.filter((f) => !f || !f._org);
    if (!Array.isArray(state.casters.library)) state.casters.library = [];
    state.casters.library = state.casters.library.filter((c) => !c || !c._org);
    const teamKey = (t) => (t.name || '').trim().toLowerCase();
    const kitKey  = (k) => String(k.id || k.name || '').toLowerCase();
    const faceKey = (f) => `${f.platform || ''}:${f.platformId || ''}`;
    const castKey = (c) => String(c.id || c.name || '').toLowerCase();
    const seenTeam = new Set(savedTeams.map(teamKey).filter(Boolean));
    const seenKit  = new Set(savedBrandKits.map(kitKey).filter(Boolean));
    const seenFace = new Set(savedFacecams.map(faceKey));
    const seenCast = new Set(state.casters.library.map(castKey).filter(Boolean));
    for (const { owner, data } of bundles) {
      (data.teams || []).forEach((t) => { const k = teamKey(t); if (!k || seenTeam.has(k)) return; seenTeam.add(k); savedTeams.push({ ...t, _org: true, _orgOwner: owner }); });
      (data.brandKits || []).forEach((x) => { const k = kitKey(x); if (!k || seenKit.has(k)) return; seenKit.add(k); savedBrandKits.push({ ...x, _org: true, _orgOwner: owner }); });
      (data.facecams || []).forEach((f) => { const k = faceKey(f); if (seenFace.has(k)) return; seenFace.add(k); savedFacecams.push({ ...f, _org: true, _orgOwner: owner }); });
      (data.castersLibrary || []).forEach((c) => { const k = castKey(c); if (!k || seenCast.has(k)) return; seenCast.add(k); state.casters.library.push({ ...c, _org: true, _orgOwner: owner }); });
    }
    savedBrandKits.forEach(ensureKitPackages);
    // Latch the signature only when every mate's bundle actually made it in. If one 404'd or the
    // link dropped mid-pull, leaving it unset is what makes the next tick try again instead of
    // treating a partial union as complete.
    _orgRevSig = failed ? '' : revSig;
    state.orgLibrary.lastPull = Date.now();
    // Only persist + re-broadcast when the org-tagged set actually changed — otherwise the 60s poll
    // would fire a full library-tier broadcast every tick (base64 logos are heavy — see perf notes).
    const orgTeams = savedTeams.filter((t) => t._org);
    const orgKits = savedBrandKits.filter((k) => k._org);
    const sig = JSON.stringify([
      orgTeams.map((t) => (t.name || '') + ':' + (t._orgOwner || '') + ':' + (t.logo ? t.logo.length : 0) + ':' + (t.players || []).length),
      orgKits.map((k) => (k.name || k.id || '') + ':' + (k._orgOwner || '')),
      savedFacecams.filter((f) => f._org).map((f) => faceKey(f))
    ]);
    if (sig !== _orgLibSig) {
      _orgLibSig = sig;
      savedTeamsVer++; brandKitsVer++;
      try { safeWriteJson(teamsFile, savedTeams); safeWriteJson(brandsFile, savedBrandKits); safeWriteJson(facecamsFile, savedFacecams); } catch (_) {}
      broadcastFullState();
    }
    return { changed: true, orgTeams: orgTeams.length, orgKits: orgKits.length };
  } catch (e) { return { changed: false, error: e.message }; }
  finally { _orgPullBusy = false; }
}
cloudLoop('org-library', () => pullOrgLibrary(), 60000, { startAfterMs: 8000 });

// In-app promo strip feed (Nameless events / paid sponsors). Hourly, public endpoint, silent on failure.
// Served to the control panel only via GET /api/promos — deliberately NOT part of state/buildLiveState.
const appPromos = promosData.create({ getDataDir: () => dataDir, fetchFeed: () => cloud.getPromos() });
cloudLoop('promos', () => appPromos.refresh(), 60 * 60 * 1000, { startAfterMs: 20000 });   // first pull once the session has loaded
// Home page content from the website (backend/site-home.js): the public half every 10 minutes, the
// signed-in producer's own communities and events every 5. Panel-only (GET /api/site-home).
const _siteUserId = () => { const u = cloud.getSession().user || {}; return u.siteUserId || u.discordId || ''; };
const siteHome = siteHomeData.create({
  getDataDir: () => dataDir,
  fetchHome: () => cloud.getSiteHome(),
  fetchMe: () => cloud.getSiteMe(),
  isSignedIn: () => cloud.authed(),
  userId: _siteUserId,
});
let _siteHomePulledAt = 0;   // throttles the Home page's manual Refresh to one pull per 30s
cloudLoop('site-home', () => siteHome.refreshHome(), 10 * 60 * 1000, { startAfterMs: 4000 });
// The same /api/broadcast/me pull carries the Studio plan (cloud.getPlan()). When it changes, re-send
// cloud_status to the control panel so Settings shows the plan name and any "Founding producer" badge.
// Display only: nothing is locked on the plan.
let _lastPlanKey = 'null';
function _pushPlanIfChanged() {
  const s = cloud.getSession();
  const key = JSON.stringify(s.plan || null);
  if (key === _lastPlanKey) return;
  _lastPlanKey = key;
  const msg = JSON.stringify({ type: 'cloud_status', data: s });
  bridgeClients.forEach((c) => { if (c._role === 'control') { try { c.send(msg); } catch (e) { /* client went away */ } } });
}
cloudLoop('site-me', () => siteHome.refreshMe().then((r) => { _pushPlanIfChanged(); return r; }), 5 * 60 * 1000, { startAfterMs: 6000 });

// ── In-app Stations manager: re-fetch the org's full nested station list and push it to the panel.
// Called after every station/room/slot mutation so the manager UI always reflects the website state.
async function sendStationsFull(ws, msg) {
  try {
    if (!cloud.authed()) { ws.send(JSON.stringify({ type: 'cloud_stations_full', data: { ok: false, message: 'Sign in to the cloud first.', stations: [] } })); return; }
    const orgId = (cloud.getSession() || {}).workspaceId;
    if (!orgId || String(orgId).startsWith('user:')) { ws.send(JSON.stringify({ type: 'cloud_stations_full', data: { ok: false, message: 'Stations need an organization workspace.', stations: [] } })); return; }
    const res = await cloud.listStationsFull(orgId);
    ws.send(JSON.stringify({ type: 'cloud_stations_full', data: { ok: true, ...res } }));
  } catch (e) {
    // sendWs, not a bare ws.send: this is the catch of an ASYNC handler, so a throw here (closed
    // socket) escapes into main.js's unhandledRejection logger — the exact case sendWs exists for.
    sendWs(ws, { type: 'cloud_stations_full', data: { ok: false, message: e.message, stations: [] } });
  }
}

// ── Show-state heartbeat → the casters' show bar ─────────────────────────────
// Publishes a tiny, secret-free snapshot (event/round, team names + scores, break countdown,
// on-air graphic) to the org so the website's station join pages can show casters what the
// producer sees. Change-detected: quiet shows cost one keepalive per few minutes.
function buildShowStateForCloud() {
  const b = (state.teams && state.teams.blue) || {};
  const o = (state.teams && state.teams.orange) || {};
  const br = state.breakScreen || {};
  // Rosters ride along (names only) so the website's PLAYER join pages can offer
  // "which team are you on → which player are you" straight from the ACTIVE match.
  const roster = (t) => (Array.isArray(t.players) ? t.players : [])
    .map((p) => ({ name: (p && p.name ? String(p.name) : '').trim() }))
    .filter((p) => p.name)
    .slice(0, 12);
  // LIVE in-game lists per side (RL: team 0=blue/1=orange; CS2: CT=a/T=b) — the join page's
  // "which in-game player are you" step, which drives facecam auto-mapping back here.
  const rl = Array.isArray(state.players) ? state.players : [];
  const cs = (state.csgo && Array.isArray(state.csgo.players)) ? state.csgo.players : [];
  const ingameFor = (side) => {
    const list = rl.length
      ? rl.filter((p) => p && (side === 'a' ? Number(p.team) === 0 : Number(p.team) === 1))
      : cs.filter((p) => p && (side === 'a' ? p.team === 'CT' : p.team === 'T'));
    return list.map((p) => ({ name: (p.name ? String(p.name) : '').trim() })).filter((p) => p.name).slice(0, 8);
  };
  return {
    // Which website station THIS producer's app is bound to — join pages under that station
    // prefer this row, so two concurrent producers' shows never bleed into each other's pages.
    stationId: (state.casters && state.casters.stationId) || '',
    eventName: state.eventName || '',
    roundLabel: state.roundLabel || '',
    gameLabel: state.gameLabel || '',
    teams: {
      a: { name: b.name || '', score: Number(b.score) || 0, players: roster(b), ingame: ingameFor('a') },
      b: { name: o.name || '', score: Number(o.score) || 0, players: roster(o), ingame: ingameFor('b') }
    },
    bestOf: state.bestOf || null,
    gfxActive: state.gfxActive || '',
    countdown: (br.visible && br.endsAt) ? { endsAt: Number(br.endsAt) || null, title: br.title || 'Starting soon' } : null
  };
}
let _showStatePrev = '';
let _showStateLastPush = 0;
let _showStateBusy = false;
async function showStateHeartbeat() {
  if (_showStateBusy) return;
  try {
    if (!cloud || typeof cloud.authed !== 'function' || !cloud.authed()) return;
    const s = cloud.getSession() || {};
    const orgId = s.workspaceId;
    if (!orgId || String(orgId).startsWith('user:')) return;
    const data = buildShowStateForCloud();
    const sig = JSON.stringify(data);
    const now = Date.now();
    // Push on change, or every 3 min as a keepalive (readers treat >10 min as stale).
    if (sig === _showStatePrev && (now - _showStateLastPush) < 180000) return;
    _showStateBusy = true;
    await cloud.pushShowState(orgId, data);
    _showStatePrev = sig;
    _showStateLastPush = now;
  } catch (_) { /* transient — next beat retries */ }
  finally { _showStateBusy = false; }
}
cloudLoop('show-state', () => showStateHeartbeat(), 12000);

// Every stored credential, restored in ONE guarded step BEFORE the rest of the state.
// loadState() is a single 500-line try block: one throw anywhere in it silently skips every
// restore below the throw, and the next auto-save then writes those losses to disk — which is
// exactly how a producer's start.gg token, Challonge/NXGEN/FACEIT keys and OBS password all
// vanished at once on a restart (everything restored above the throw survived, everything below
// it came back as a factory default and was saved that way). Credentials are the one thing that
// cannot be re-derived, so they load first and behind their own catch.
function restoreSecrets(saved) {
  if (!saved || typeof saved !== 'object') return;
  const take = (key, apply) => {
    try { if (typeof saved[key] === 'string') apply(decryptSecret(saved[key])); }
    catch (e) { console.error('[secrets] could not restore ' + key + ':', e.message); }
  };
  take('startggApiToken',      (v) => { startggApiToken = v; });
  take('challongeApiKey',      (v) => { challongeApiKey = v; });
  take('challengermodeRefreshKey', (v) => { challengermodeRefreshKey = v; });
  take('nxgenApiKey',          (v) => { nxgenApiKey = v; });
  take('faceitApiKey',         (v) => { faceitApiKey = v; });
  take('liquipediaApiKey',     (v) => { liquipediaApiKey = v; });
  take('riotApiKey',           (v) => { riotApiKey = v; });
  take('ballchasingApiKey',    (v) => { ballchasingApiKey = v; });
  take('bedwarsToken',         (v) => { bedwarsToken = v; });
  take('sheetsServiceAccount', (v) => { sheetsServiceAccount = v; });
  take('competitionApiKey',    (v) => { competitionApiKey = v; });
  take('competitionFeedTokens', (v) => { try { const o = JSON.parse(v || '{}'); competitionFeedTokens = o && typeof o === 'object' ? o : {}; } catch (_) { competitionFeedTokens = {}; } });
  take('obsPassword',          (v) => { obsPassword = v; });
  take('slobsToken',           (v) => { slobsToken = v; });
}

// Set when loadState() aborts part-way: the raw file as it was on disk, plus the error. While set,
// _saveAppStateNow() refuses to save a list EMPTY that was non-empty on disk — the fields below the
// throw are sitting at their empty defaults, and saving them is how a whole crew roster vanished.
let _stateLoadAbort = null;

function loadState() {
  let saved = null;
  try {
    saved = safeReadJson(stateFile, null);
    if (saved) {
      restoreSecrets(saved);
      stateSchema.restoreTyped(state, saved);   // plain typed settings (load: 'typed' in backend/state-schema.js)
      if (saved.activeGame && GAMES[saved.activeGame]) state.activeGame = saved.activeGame;
      if (saved.themesByGame && typeof saved.themesByGame === 'object') {
        Object.keys(GAMES).forEach((g) => {
          if (saved.themesByGame[g] != null) {
            state.themesByGame[g] = migrateThemeId(g, saved.themesByGame[g]);
          }
        });
      }
      if (typeof saved.activeBrandKitId === 'string') state.activeBrandKitId = saved.activeBrandKitId;
      if (typeof saved.useBrandColors === 'boolean') state.useBrandColors = saved.useBrandColors;
      // Colour mode: prefer the explicit field; migrate from the old useBrandColors flag otherwise.
      if (saved.colorMode === 'team' || saved.colorMode === 'brand' || saved.colorMode === 'default' || saved.colorMode === 'game') {
        state.colorMode = saved.colorMode;
      } else if (typeof saved.useBrandColors === 'boolean') {
        state.colorMode = saved.useBrandColors ? 'brand' : 'team';
      }
      state.useBrandColors = (state.colorMode === 'brand');
      // Use the saved value whenever it's a string (including '' — a deliberately cleared
      // title must NOT snap back to the factory default on reload).
      if (typeof saved.eventNameSlug === 'string') state.eventNameSlug = saved.eventNameSlug;
      if (saved.speedUnit === 'mph' || saved.speedUnit === 'kmh') state.speedUnit = saved.speedUnit;
      if (saved.dateFormat === 'us' || saved.dateFormat === 'intl') state.dateFormat = saved.dateFormat;
      if (saved.teamRecord && typeof saved.teamRecord === 'object') state.teamRecord = { ...state.teamRecord, ...saved.teamRecord };
      // (Legacy manual-record migration runs AFTER state.teams is restored below — see migrateTeamRecordManual.)
      // Spread onto the live object rather than replacing it: only the two settings are persisted,
      // and count/ver are runtime fields the control panel uses to know when to re-fetch.
      if (saved.teamVault && typeof saved.teamVault === 'object') {
        state.teamVault = { ...state.teamVault, ...saved.teamVault, count: 0, ver: 0, enrich: null };
      }
      if (saved.startggLeagueStandings && typeof saved.startggLeagueStandings === 'object') {
        state.startggLeagueStandings = { ...state.startggLeagueStandings, ...saved.startggLeagueStandings };
      } else if (saved.leagueStandings && typeof saved.leagueStandings === 'object') {
        // Migration shim: older state.json files still use the pre-rename key.
        state.startggLeagueStandings = { ...state.startggLeagueStandings, ...saved.leagueStandings };
      }
      if (saved.fontFamily) state.fontFamily = saved.fontFamily;
      // One-time migration: if saved font is still the old generic default, promote to brand font.
      if (state.fontFamily === 'Bourgeois') state.fontFamily = 'Industry';
      if (typeof saved.followSetGame === 'boolean') state.followSetGame = saved.followSetGame;
      if (saved.worldsSidebar && typeof saved.worldsSidebar === 'object') state.worldsSidebar = sanitizeWorldsSidebar(saved.worldsSidebar);
      // Merged field-by-field, not assigned wholesale: a state.json written before this feature
      // existed has no seriesStats at all, and one written by a newer build must not be able to
      // drop `games` into a non-array and break the overlay's reduce.
      if (saved.seriesStats && typeof saved.seriesStats === 'object') {
        const sv = saved.seriesStats, ss = state.seriesStats;
        if (typeof sv.enabled === 'boolean') ss.enabled = sv.enabled;
        if (typeof sv.visible === 'boolean') ss.visible = sv.visible;
        if (typeof sv.design === 'string' && SERIES_STATS_DESIGNS.includes(sv.design)) ss.design = sv.design;
        if (Array.isArray(sv.games)) ss.games = sv.games.filter((g) => g && Array.isArray(g.players)).slice(-9);
        if (typeof sv.liveBanked === 'boolean') ss.liveBanked = sv.liveBanked;
      }
      if (saved.facecamsEnabled !== undefined) state.facecamsEnabled = saved.facecamsEnabled;
      if (saved.lanSeats && typeof saved.lanSeats === 'object') state.lanSeats = lanSeats.normalize(saved.lanSeats);
      if (saved.replayCams !== undefined) state.replayCams = saved.replayCams;
      if (saved.sceneBg && typeof saved.sceneBg === 'object') state.sceneBg = { ...saved.sceneBg };
      if (saved.scenePresets && typeof saved.scenePresets === 'object') {
        state.scenePresets = saved.scenePresets;
        // A '__preview__' preset is an unsaved live-preview scratchpad — if the app closed while
        // one was active it would silently override brand colours on air forever. Reset to Default.
        Object.values(state.scenePresets).forEach((sp) => {
          if (sp && sp.active === '__preview__') sp.active = 'Default';
        });
      }
      if (saved.brand && typeof saved.brand === 'object') state.brand = saved.brand;
      if (Array.isArray(saved.preshowPresets)) state.preshowPresets = saved.preshowPresets;
      if (saved.banner) state.banner = saved.banner;
      if (saved.credits && Array.isArray(saved.credits.sponsors)) state.credits = { sponsors: saved.credits.sponsors, talent: Array.isArray(saved.credits.talent) ? saved.credits.talent : [] };
      // The end-card text and the side-rail switches are saved with credits but were never read back,
      // so "Thanks For Watching" came back on every restart. (visible stays off: graphics start off-air.)
      if (saved.credits && typeof saved.credits === 'object') {
        if (!state.credits) state.credits = { visible: false, sponsors: [], talent: [], endText: '' };
        if (typeof saved.credits.endText === 'string') state.credits.endText = saved.credits.endText.slice(0, 80);
        if (typeof saved.credits.showTop8 === 'boolean') state.credits.showTop8 = saved.credits.showTop8;
        if (typeof saved.credits.showActivity === 'boolean') state.credits.showActivity = saved.credits.showActivity;
      }
      if (saved.casters && typeof saved.casters === 'object') {
        state.casters = {
          visible: !!saved.casters.visible,
          showCountry: !!saved.casters.showCountry,
          nameMode: saved.casters.nameMode === 'name' ? 'name' : 'gamertag',   // desks default to the gamertag/handle
          showRoles: (saved.casters.showRoles && typeof saved.casters.showRoles === 'object')
            ? { host: saved.casters.showRoles.host || '', observer: saved.casters.showRoles.observer || '' }
            : { host: '', observer: '' },
          shifts: Array.isArray(saved.casters.shifts) ? saved.casters.shifts : [],
          // Prev shift undo history (capped at 10 by the shift handler) survives a restart too.
          shiftHistory: Array.isArray(saved.casters.shiftHistory) ? saved.casters.shiftHistory.slice(-10) : [],
          activeShiftId: typeof saved.casters.activeShiftId === 'string' ? saved.casters.activeShiftId : '',
          // Show Deck support crew — EVENT-scoped [{crewId, role}] so deck add/remove never
          // rewrites the crew record's durable group. Non-array → migrated from crew groups below.
          support: Array.isArray(saved.casters.support) ? saved.casters.support : null,
          // Website station check-ins auto-fill the desk (default ON; only an explicit off sticks).
          autoFillFromStations: saved.casters.autoFillFromStations !== false,
          // Which website STATION this app follows ('' = all of the org's stations). With several
          // desks running, each producer binds their app to their own station so two different
          // "Caster 1"s never fight over the same desk slot.
          stationId: typeof saved.casters.stationId === 'string' ? saved.casters.stationId : '',
          lowerThird: typeof saved.casters.lowerThird === 'string' ? saved.casters.lowerThird : '',
          list: Array.isArray(saved.casters.list) ? saved.casters.list : [],
          library: Array.isArray(saved.casters.library) ? saved.casters.library : [],
          vdo: (saved.casters.vdo && saved.casters.vdo.room) ? saved.casters.vdo : { room: '', password: '' },
          guestsVdo: (saved.casters.guestsVdo && saved.casters.guestsVdo.room) ? saved.casters.guestsVdo : { room: '', password: '' },
          observersVdo: (saved.casters.observersVdo && saved.casters.observersVdo.room) ? saved.casters.observersVdo : { room: '', password: '' },
          rooms: Array.isArray(saved.casters.rooms) ? saved.casters.rooms : [],
          lineup: Array.isArray(saved.casters.lineup) ? saved.casters.lineup : [],
          activeLayout: typeof saved.casters.activeLayout === 'string' ? saved.casters.activeLayout : '',
          interview: (saved.casters.interview && saved.casters.interview.room) ? saved.casters.interview : { room: '', password: '' },
          apiKey: typeof saved.casters.apiKey === 'string' ? saved.casters.apiKey : '',
          interviewee: (saved.casters.interviewee && typeof saved.casters.interviewee === 'object') ? saved.casters.interviewee : null,
          playerCam: (saved.casters.playerCam && typeof saved.casters.playerCam === 'object') ? saved.casters.playerCam : null,
          deskRoomId: typeof saved.casters.deskRoomId === 'string' ? saved.casters.deskRoomId : '',
          slotLabels: (function() {
            const sl = saved.casters.slotLabels;
            if (!sl || typeof sl !== 'object') return { 1: 'Caster 1', 2: 'Caster 2', 3: 'Caster 3', 4: 'Caster 4', 5: 'Player' };
            return { 1: String(sl[1] || 'Caster 1').slice(0, 30), 2: String(sl[2] || 'Caster 2').slice(0, 30), 3: String(sl[3] || 'Caster 3').slice(0, 30), 4: String(sl[4] || 'Caster 4').slice(0, 30), 5: String(sl[5] || 'Player').slice(0, 30) };
          })()
        };
      }
      if (saved.ticker && typeof saved.ticker === 'object') {
        state.ticker = {
          visible: !!saved.ticker.visible,
          messages: Array.isArray(saved.ticker.messages) ? saved.ticker.messages : [],
          speed: Number(saved.ticker.speed) > 0 ? Number(saved.ticker.speed) : 10,
          source: ['startgg', 'nxgen', 'br'].includes(saved.ticker.source) ? saved.ticker.source : 'manual',
          sponsor: typeof saved.ticker.sponsor === 'string' ? saved.ticker.sponsor : '',
          feed: []
        };
      }
      if (saved.overtime && typeof saved.overtime === 'object') {
        state.overtime = {
          label: typeof saved.overtime.label === 'string' ? saved.overtime.label : 'OVERTIME',
          logo: saved.overtime.logo || null,
          bg: saved.overtime.bg || '#e0202a',
          color: saved.overtime.color || '#ffffff'
        };
      }
      if (saved.replay && typeof saved.replay === 'object') {
        state.replay = {
          ...state.replay,   // keep the runtime program/preview buses — only the transition look persists
          label: typeof saved.replay.label === 'string' ? saved.replay.label : 'REPLAY',
          logo: saved.replay.logo || null,
          outroLogo: saved.replay.outroLogo || null,
          colorMode: ['mono', 'brand'].includes(saved.replay.colorMode) ? saved.replay.colorMode : 'team',
          skin: saved.replay.skin || null,
          style: REPLAY_STYLES.includes(saved.replay.style) ? saved.replay.style : 'slam'
        };
      }
      if (saved.scoreboardAd && typeof saved.scoreboardAd === 'object') {
        state.scoreboardAd = {
          label: typeof saved.scoreboardAd.label === 'string' ? saved.scoreboardAd.label : 'PRESENTED BY',
          logo: saved.scoreboardAd.logo || null,
          background: saved.scoreboardAd.background || null
        };
      }
      if (saved.rlStatsScreen && typeof saved.rlStatsScreen === 'object') {
        const RL_STATS_DESIGNS = ['default', 'glass', 'block', 'radar', 'compare'];
        state.rlStatsScreen = {
          showStats: saved.rlStatsScreen.showStats !== false,
          design: RL_STATS_DESIGNS.includes(saved.rlStatsScreen.design) ? saved.rlStatsScreen.design : 'default'
        };
      }
      if (saved.deskFooter && Array.isArray(saved.deskFooter.logos)) {
        state.deskFooter = { logos: saved.deskFooter.logos.filter((l) => typeof l === 'string' && l) };
      }
      if (saved.preshow && typeof saved.preshow === 'object') {
        state.preshow = {
          headline: typeof saved.preshow.headline === 'string' ? saved.preshow.headline : '',
          topics: Array.isArray(saved.preshow.topics)
            ? saved.preshow.topics.filter((t) => t && typeof t === 'object').map((t) => ({
                text: typeof t.text === 'string' ? t.text : '',
                sceneName: typeof t.sceneName === 'string' ? t.sceneName : ''
              }))
            : [],
          activeTopicIndex: Math.max(0, parseInt(saved.preshow.activeTopicIndex, 10) || 0),
          homeScene: typeof saved.preshow.homeScene === 'string' ? saved.preshow.homeScene : '',
          predictions: Array.isArray(saved.preshow.predictions)
            ? [0, 1].map((i) => sanitizePreshowPick(saved.preshow.predictions[i]))
            : ['', '']
          // headline/topics restored above are transient — syncActivePreshowTopics() (called once
          // brand kits finish loading) overwrites them from the active package right after boot.
        };
      }
      if (saved.vdo && typeof saved.vdo === 'object') {
        state.vdo = { ...state.vdo, ...saved.vdo };
      }
      if (saved.breakScreen && typeof saved.breakScreen === 'object') {
        state.breakScreen = {
          visible: !!saved.breakScreen.visible,
          title: saved.breakScreen.title || 'STARTING SOON',
          message: saved.breakScreen.message || '',
          finalMessage: saved.breakScreen.finalMessage || "WE'RE LIVE!",
          // Don't restore a stale countdown (or its pending auto-switch) across restarts
          endsAt: null,
          frozenSeconds: null,
          thenScene: ''
        };
      }
      // Momentary production graphics: restore content, but never auto-show on restart.
      if (saved.winner && typeof saved.winner === 'object') {
        state.winner = {
          visible: false,
          side: saved.winner.side || '',
          name: saved.winner.name || '',
          logo: saved.winner.logo || null,
          color: saved.winner.color || '',
          subtitle: saved.winner.subtitle || '',
          // This rebuild is wholesale, so any field not listed here is silently lost on every
          // restart — style included, which would quietly snap a producer back to the default.
          style: WINNER_STYLES.includes(saved.winner.style) ? saved.winner.style : 'slam'
        };
      }
      if (saved.veto && typeof saved.veto === 'object') {
        state.veto = {
          visible: false,
          title: saved.veto.title || '',
          maps: Array.isArray(saved.veto.maps) ? saved.veto.maps : []
        };
      }
      if (saved.intro && typeof saved.intro === 'object') {
        state.intro = {
          visible: false,
          side: (saved.intro.side === 'orange' || saved.intro.side === 'blue') ? saved.intro.side : 'blue',
          title: saved.intro.title || '',
          style: [1, 2].includes(Number(saved.intro.style)) ? Number(saved.intro.style) : 1,
          showFooter: false,  // always reset — was auto-true before; opt-in via checkbox now
          showRealName: saved.intro.showRealName !== false   // was dropped on every restart (persist-roundtrip test)
        };
      }
      if (saved.owMatch && typeof saved.owMatch === 'object') {
        state.owMatch = {
          visible: typeof saved.owMatch.visible === 'boolean' ? saved.owMatch.visible : true,
          format: ['FT2','FT3','FT4'].includes(saved.owMatch.format) ? saved.owMatch.format : 'FT3',
          currentMapIdx: typeof saved.owMatch.currentMapIdx === 'number' ? saved.owMatch.currentMapIdx : 0,
          bansByMap: Array.isArray(saved.owMatch.bansByMap) ? saved.owMatch.bansByMap : [],
          gameMode: typeof saved.owMatch.gameMode === 'string' ? saved.owMatch.gameMode : 'escort',
          showMapLabels: typeof saved.owMatch.showMapLabels === 'boolean' ? saved.owMatch.showMapLabels : true,
          mapWinners: Array.isArray(saved.owMatch.mapWinners) ? saved.owMatch.mapWinners : [],
          mapModes:   Array.isArray(saved.owMatch.mapModes)   ? saved.owMatch.mapModes   : [],
          attackSide: saved.owMatch.attackSide || null,
          showAttack: !!saved.owMatch.showAttack,
          // Centre-pill format label: 'ft' = first to N wins (FT3), 'bo' = best of N maps (BO5).
          seriesLabel: saved.owMatch.seriesLabel === 'bo' ? 'bo' : 'ft'
        };
      }
      if (saved.mrMatch && typeof saved.mrMatch === 'object') {
        state.mrMatch = {
          visible: typeof saved.mrMatch.visible === 'boolean' ? saved.mrMatch.visible : true,
          format: typeof saved.mrMatch.format === 'string' ? saved.mrMatch.format : 'BO5',
          bansByMap: Array.isArray(saved.mrMatch.bansByMap) ? saved.mrMatch.bansByMap : [],
          gameMode: typeof saved.mrMatch.gameMode === 'string' ? saved.mrMatch.gameMode : 'convergence',
          showMapLabels: typeof saved.mrMatch.showMapLabels === 'boolean' ? saved.mrMatch.showMapLabels : true,
          mapWinners: Array.isArray(saved.mrMatch.mapWinners) ? saved.mrMatch.mapWinners : [],
          mapModes:   Array.isArray(saved.mrMatch.mapModes)   ? saved.mrMatch.mapModes   : [],
          gepData: null
        };
      }
      if (saved.customOverlayLayouts && typeof saved.customOverlayLayouts === 'object') {
        state.customOverlayLayouts = saved.customOverlayLayouts;
      }
      if (Array.isArray(saved.pointMatrices)) {
        state.pointMatrices = saved.pointMatrices.slice(0, 100).map(sanitizePointMatrix).filter((m) => !m.builtin);
      }
      if (saved.gameConfigs && typeof saved.gameConfigs === 'object') {
        state.gameConfigs = saved.gameConfigs;
      }
      if (saved.gameConfigVersions && typeof saved.gameConfigVersions === 'object' && !Array.isArray(saved.gameConfigVersions)) {
        const out = {};
        for (const [g, list] of Object.entries(saved.gameConfigVersions)) {
          if (Array.isArray(list)) out[g] = list.filter((v) => v && typeof v.name === 'string' && v.bundle && typeof v.bundle === 'object').slice(0, GAME_CONFIG_VERSION_CAP);
        }
        state.gameConfigVersions = out;
      }
      if (saved.gameConfigFrom && typeof saved.gameConfigFrom === 'object' && !Array.isArray(saved.gameConfigFrom)) {
        state.gameConfigFrom = saved.gameConfigFrom;
      }
      if (saved.bestOf) state.bestOf = saved.bestOf;
      if (saved.teams) {
        state.teams = saved.teams;
        // Ensure team colors exist for older saves
        if (state.teams.blue && !state.teams.blue.color) state.teams.blue.color = '#055fdb';
        if (state.teams.orange && !state.teams.orange.color) state.teams.orange.color = '#e97139';
        // Self-heal a sponsor left behind by an older save. Every writer used to fill `org` and
        // none cleared it, so a side could still be carrying the org of an entrant two matches ago.
        // Only touched when start.gg supplied the WHOLE roster: their `prefix` is the sponsor, so
        // an all-start.gg roster with no prefixes means this entrant has no sponsor, full stop.
        // A manually-built or vault-branded team is left exactly as the producer set it.
        ['blue', 'orange'].forEach((side) => {
          const t = state.teams[side];
          if (!t || !t.org) return;
          const roster = Array.isArray(t.players) ? t.players : [];
          if (!roster.length || !roster.every((x) => x && x.platform === 'startgg')) return;
          const real = entrantOrgName(roster);
          if (real !== t.org) t.org = real;
        });
      }
      // Migrate legacy side-keyed manual team records → keyed by team name, using the NOW-restored
      // teams (must run after state.teams is set above, or it copies nothing and records orphan).
      // Idempotent + self-healing: only fills a team's key when unset, so real edits are never lost.
      if (state.teamRecord) {
        if (!state.teamRecord.manualByName) state.teamRecord.manualByName = {};
        const legacy = state.teamRecord.manual || {};
        ['blue', 'orange'].forEach((side) => {
          const nm = ((state.teams[side] && state.teams[side].name) || '').trim().toLowerCase();
          const rec = legacy[side];
          if (nm && !state.teamRecord.manualByName[nm] && rec && (rec.w || rec.l || rec.pts != null || rec.place != null)) {
            state.teamRecord.manualByName[nm] = { ...rec };
          }
        });
      }
      if (saved.series) state.series = saved.series;
      if (saved.activePlayer && typeof saved.activePlayer === 'object') {
        state.activePlayer = {
          blue: String(saved.activePlayer.blue || ''),
          orange: String(saved.activePlayer.orange || '')
        };
      }
      if (saved.observedPlayer && typeof saved.observedPlayer === 'object'
          && (saved.observedPlayer.side === 'blue' || saved.observedPlayer.side === 'orange')) {
        state.observedPlayer = { side: saved.observedPlayer.side, playerId: String(saved.observedPlayer.playerId || '') };
      }
      if (saved.smash && typeof saved.smash === 'object') {
        const clampS = (v, d) => Math.max(0, Math.min(9, Number.isFinite(+v) ? Math.round(+v) : d));
        const start = Math.max(1, Math.min(9, Math.round(Number(saved.smash.startStocks) || 3)));
        const crew = Math.max(1, Math.min(8, Math.round(Number(saved.smash.crewSize) || 4)));
        const side = (s) => {
          const players = Array.isArray(s && s.players) && s.players.length
            ? s.players.slice(0, crew).map((v) => clampS(v, start))
            : Array.from({ length: crew }, () => start);
          while (players.length < crew) players.push(start);
          const characters = (Array.isArray(s && s.characters) ? s.characters : [])
            .slice(0, crew).map((v) => String(v || '').slice(0, 40));
          while (characters.length < crew) characters.push('');
          return { stocks: clampS(s && s.stocks, start), character: String((s && s.character) || '').slice(0, 40), players, characters };
        };
        state.smash = {
          title: String(saved.smash.title || '').slice(0, 40),
          titleManual: !!saved.smash.titleManual,
          startggTitle: String(saved.smash.startggTitle || '').slice(0, 40),
          autoAdvance: saved.smash.autoAdvance !== false,
          startStocks: start,
          mode: normalizeSmashMode(saved.smash.mode),
          startggFormat: String(saved.smash.startggFormat || ''),
          crewSize: crew,
          // Was never restored, so the rail snapped back to the bottom on every relaunch. A saved
          // 'bottom' predates 'auto' (it was the only default), so it migrates to auto: singles
          // still sits at the bottom, doubles/crew stop covering the player HUDs.
          railPos: saved.smash.railPos === 'topleft' ? 'topleft' : 'auto',
          blue: side(saved.smash.blue),
          orange: side(saved.smash.orange)
        };
        // side() sizes to the crew; doubles is always two a side.
        if (state.smash.mode === 'doubles') resizeSmashSides(2);
      }
      // Brawlhalla. Everything is clamped/rebuilt rather than spread from the save: this runs
      // inside loadState(), where ONE throw abandons the rest of the restore (see
      // test/loadstate-restore.test.js), so a hand-edited or older state file must not be able to
      // reach in with a string where a number goes.
      if (saved.brawlhalla && typeof saved.brawlhalla === 'object') {
        const b = saved.brawlhalla;
        const start = Math.max(1, Math.min(9, Math.round(Number(b.startStocks) || 3)));
        const clampS = (v) => Math.max(0, Math.min(9, Number.isFinite(+v) ? Math.round(+v) : start));
        const seat = (x) => ({
          stocks: clampS(x && x.stocks),
          legend: String((x && x.legend) || '').slice(0, 40),
          bhId: Math.max(0, Math.round(Number(x && x.bhId) || 0)),
          // Cards are a CACHE of a remote pull, not producer input — never restored from disk, so a
          // board can't go on air quoting an ELO from three weeks ago. They refill on first lookup.
          card: null
        });
        const side = (x) => {
          const seats = (Array.isArray(x && x.players) ? x.players : []).slice(0, 2).map(seat);
          while (seats.length < 2) seats.push({ stocks: start, legend: '', bhId: 0, card: null });
          return { stocks: clampS(x && x.stocks), legend: String((x && x.legend) || '').slice(0, 40), players: seats };
        };
        state.brawlhalla = {
          startStocks: start,
          mode: b.mode === '2v2' ? '2v2' : '1v1',
          rankMode: b.rankMode === 'ranked_3v3' ? 'ranked_3v3' : 'ranked_1v1',
          region: BH_REGIONS.includes(String(b.region || '').toUpperCase()) ? String(b.region).toUpperCase() : 'ALL',
          title: String(b.title || '').slice(0, 40),
          titleManual: !!b.titleManual,
          autoAdvance: b.autoAdvance !== false,
          showRank: b.showRank !== false,
          showLegend: b.showLegend !== false,
          railPos: b.railPos === 'topleft' ? 'topleft' : 'auto',
          blue: side(b.blue),
          orange: side(b.orange),
          lastError: '', lastLookupAt: 0
        };
      }
      if (saved.tokon && typeof saved.tokon === 'object') {
        const rp = saved.tokon.railPos;
        // A layout saved for an older board shape (no layoutV / an older one) is dropped for the new
        // defaults: the defaults were persisted on every save, so otherwise a redesign's new
        // positions would never reach anyone who had run the old board.
        state.tokon = { railPos: (rp === 'bottomleft' || rp === 'bottomright') ? rp : 'meters',
                        layoutV: 2,
                        layout: saved.tokon.layoutV === 2 ? normalizeTokonLayout(saved.tokon.layout) : normalizeTokonLayout() };
      }
      if (saved.chatCommands && typeof saved.chatCommands === 'object') {
        state.chatCommands = {
          enabled: saved.chatCommands.enabled !== false,
          discord: String(saved.chatCommands.discord || '').slice(0, 300)
        };
      }
      if (saved.pulse && typeof saved.pulse === 'object') state.pulse = {
        publish: !!saved.pulse.publish,
        feedViewUrl: String(saved.pulse.feedViewUrl || ''),
        channel: String(saved.pulse.channel || ''),
        label: String(saved.pulse.label || '')
      };
      if (saved.matchTitles && typeof saved.matchTitles === 'object') {
        const mtw = saved.matchTitles.twitch || {}, mtv = saved.matchTitles.vod || {};
        state.matchTitles.twitch = {
          auto: !!mtw.auto,
          template: (typeof mtw.template === 'string' && mtw.template.trim()) ? mtw.template.slice(0, 300) : matchTitle.DEFAULT_TWITCH_TEMPLATE
        };
        state.matchTitles.vod = {
          rename: !!mtv.rename,
          template: (typeof mtv.template === 'string' && mtv.template.trim()) ? mtv.template.slice(0, 300) : matchTitle.DEFAULT_VOD_TEMPLATE,
          eventFolder: mtv.eventFolder !== false,
          datePrefix: mtv.datePrefix !== false,
          csv: mtv.csv !== false
        };
        state.matchTitles.stripSponsors = saved.matchTitles.stripSponsors !== false;
        state.matchTitles.vodLog = Array.isArray(saved.matchTitles.vodLog)
          ? saved.matchTitles.vodLog.filter((e) => e && typeof e === 'object').slice(0, 30) : [];
        // A rename still 'pending' when the app closed never finishes; Retry and Clear both skip
        // pending rows, so without this the row would be stuck for good.
        state.matchTitles.vodLog.forEach((e) => { if (e.status === 'pending') { e.status = 'error'; e.error = e.error || 'The app closed before this recording was renamed. Retry to finish it.'; } });
      }
      if (saved.match && typeof saved.match === 'object') {
        state.match = {
          format: saved.match.format || '',
          division: saved.match.division || '',
          maps: Array.isArray(saved.match.maps) ? saved.match.maps : [],
          seriesVisible: typeof saved.match.seriesVisible === 'boolean' ? saved.match.seriesVisible : true
        };
      }
      if (Array.isArray(saved.leagues)) state.leagues = saved.leagues.map(migrateLeague);
      if (saved.competition && typeof saved.competition === 'object') state.competition = normalizeCompetitionSettings(saved.competition);
      if (saved.siteEvent && typeof saved.siteEvent === 'object') { state.siteEvent = { ...state.siteEvent, ...saved.siteEvent, lastReport: '' }; siteEventState(); }
      if (Array.isArray(saved.myEvents)) state.myEvents = saved.myEvents;
      if (saved.perfMode && typeof saved.perfMode === 'object') {
        const sp = saved.perfMode;
        state.perfMode.enabled = sp.enabled !== false;
        state.perfMode.always = !!sp.always;
        state.perfMode.reduceAnimations = !!sp.reduceAnimations;
        state.perfMode.pausePreviews = !!sp.pausePreviews;
        state.perfMode.resourceWarnings = sp.resourceWarnings !== false;
        if (['smooth', 'balanced', 'light'].includes(sp.broadcastRate)) state.perfMode.broadcastRate = sp.broadcastRate;
      }
      if (saved.orgLibrary && typeof saved.orgLibrary === 'object') {
        state.orgLibrary.autoSync = saved.orgLibrary.autoSync !== false;
        if (saved.orgLibrary.profileId) state.orgLibrary.profileId = saved.orgLibrary.profileId;
      }
      if (saved.eventOps && typeof saved.eventOps === 'object') {
        // Rows saved by the first release were objects ({team,player,…}); the store is
        // now the full spreadsheet (headers + string-array rows). Drop the legacy shape.
        const legacy = Array.isArray(saved.eventOps.rows) && saved.eventOps.rows.some((r) => r && !Array.isArray(r));
        state.eventOps = {
          headers: Array.isArray(saved.eventOps.headers) ? saved.eventOps.headers : [],
          rows: (!legacy && Array.isArray(saved.eventOps.rows)) ? saved.eventOps.rows : [],
          roleMap: (saved.eventOps.roleMap && typeof saved.eventOps.roleMap === 'object') ? saved.eventOps.roleMap : {},
          seeds: Array.isArray(saved.eventOps.seeds) ? saved.eventOps.seeds : [],
          eventSlug: saved.eventOps.eventSlug || '',
          importedAt: saved.eventOps.importedAt || 0,
          seededAt: saved.eventOps.seededAt || 0
        };
      }
      if (saved.game && typeof saved.game.number === 'number') {
        state.game.number = saved.game.number;
      }
      if (saved.startgg && typeof saved.startgg === 'object') {
        state.startgg = {
          ...state.startgg,
          ...saved.startgg,
          // transient queue data — refetch on poll; keep selected event + teams + user toggles
          queue: [],
          streams: [],
          lastPushedSetId: null,
          streamOffQueue: false,   // recomputed on the first poll
          autoFollowHold: null,    // nothing is on air yet, so nothing to hold
          connected: false,
          queueFetchedAt: null,
          autoFollow: !!saved.startgg.autoFollow,
          autoFollowChosen: !!saved.startgg.autoFollowChosen,
          // Which stream/station this producer is on. Persisted: on a multi-station championship
          // losing it to a restart silently reverts auto-follow to "any stream", which is how
          // another station's match ends up on your broadcast.
          streamName: typeof saved.startgg.streamName === 'string' ? saved.startgg.streamName : '',
          queueEnabled: !!saved.startgg.queueEnabled,
          // keep selectedEvent and eventTeams from disk if present (lightweight)
          selectedEvent: saved.startgg.selectedEvent || null,
          eventTeams: Array.isArray(saved.startgg.eventTeams) ? saved.startgg.eventTeams : [],
          // name→logo map persists (so logos survive a restart); pending picker is transient
          logoMap: (saved.startgg.logoMap && typeof saved.startgg.logoMap === 'object') ? saved.startgg.logoMap : {},
          pendingEvents: []
        };
      }
      if (saved.challengermode && typeof saved.challengermode === 'object') {
        const c = saved.challengermode;
        state.challengermode = {
          ...state.challengermode,
          enabled: !!c.enabled,
          tournamentId: String(c.tournamentId || ''),
          selectedTournament: (c.selectedTournament && typeof c.selectedTournament === 'object') ? c.selectedTournament : null,
          logoMap: (c.logoMap && typeof c.logoMap === 'object') ? c.logoMap : {},
          autoFollow: !!c.autoFollow,
          gameId: String(c.gameId || ''),
          spaceId: String(c.spaceId || ''),
          pollSec: Math.max(10, Math.min(600, Math.round(Number(c.pollSec) || 30)))
        };
      }
      if (saved.challonge && typeof saved.challonge === 'object') {
        state.challonge = {
          ...state.challonge,
          enabled: !!saved.challonge.enabled,
          tournamentSlug: saved.challonge.tournamentSlug || '',
          selectedTournament: saved.challonge.selectedTournament || null,
          logoMap: (saved.challonge.logoMap && typeof saved.challonge.logoMap === 'object') ? saved.challonge.logoMap : {},
          autoFollow: !!saved.challonge.autoFollow,
          gameId: String(saved.challonge.gameId || ''),
          // 15s floor: anything faster spends the whole free monthly quota in an hour.
          pollSec: Math.max(15, Math.min(600, Math.round(Number(saved.challonge.pollSec) || 30))),
          budget: (saved.challonge.budget && typeof saved.challonge.budget === 'object')
            ? { month: String(saved.challonge.budget.month || ''), used: Math.max(0, Math.round(Number(saved.challonge.budget.used) || 0)),
                limit: Math.max(0, Math.round(Number(saved.challonge.budget.limit) || 500)), warned: !!saved.challonge.budget.warned }
            : { month: '', used: 0, limit: 500, warned: false },
          connected: false, lastError: null, queue: [], matchFeed: [], queueFetchedAt: null, eventTeams: [], lastAutoFollowMatchId: null
        };
      }
      if (saved.nxgen && typeof saved.nxgen === 'object') {
        state.nxgen = {
          ...state.nxgen,
          enabled: !!saved.nxgen.enabled,
          eventSlug: saved.nxgen.eventSlug || '',
          selectedEvent: saved.nxgen.selectedEvent || null,
          logoMap: (saved.nxgen.logoMap && typeof saved.nxgen.logoMap === 'object') ? saved.nxgen.logoMap : {},
          autoFollow: !!saved.nxgen.autoFollow,
          connected: false, lastError: null, queue: [], eventTeams: [], queueFetchedAt: null, lastAutoFollowMatchId: null
        };
      }
      if (saved.faceit && typeof saved.faceit === 'object') {
        state.faceit = {
          ...state.faceit,
          enabled: !!saved.faceit.enabled,
          competitionId: saved.faceit.competitionId || '',
          competitionType: saved.faceit.competitionType === 'hub' ? 'hub' : 'championship',
          organizerId: saved.faceit.organizerId || '',
          organizerName: saved.faceit.organizerName || '',
          selectedEvent: saved.faceit.selectedEvent || null,
          logoMap: (saved.faceit.logoMap && typeof saved.faceit.logoMap === 'object') ? saved.faceit.logoMap : {},
          autoFollow: !!saved.faceit.autoFollow
        };
      }
      if (saved.riot && typeof saved.riot === 'object') {
        if (riot.REGIONS.includes(saved.riot.region)) state.riot.region = saved.riot.region;
        if (riot.PLATFORMS[saved.riot.platform]) state.riot.platform = saved.riot.platform;
      }
      state.riot.keyKind = riot.keyKind(riotApiKey);
      if (saved.background && typeof saved.background === 'object') {
        const bg = saved.background;
        if (['solid', 'gradient', 'image'].includes(bg.type)) state.background.type = bg.type;
        if (typeof bg.color1 === 'string') state.background.color1 = bg.color1.slice(0, 20);
        if (typeof bg.color2 === 'string') state.background.color2 = bg.color2.slice(0, 20);
        if (typeof bg.angle === 'number') state.background.angle = Math.max(0, Math.min(360, bg.angle));
        if (typeof bg.imageUrl === 'string') state.background.imageUrl = bg.imageUrl.slice(0, 2000);
      }
      if (saved.liquipedia && typeof saved.liquipedia === 'object') {
        const lq = saved.liquipedia;
        state.liquipedia.enabled = !!lq.enabled;
        if (typeof lq.wiki === 'string' && lq.wiki) state.liquipedia.wiki = lq.wiki;
        if (typeof lq.contact === 'string') state.liquipedia.contact = lq.contact;
      }
      _lpBudget = liquipedia.RateBudget.fromJSON(saved.liquipediaBudget);
      _lpCache = new liquipedia.LiquipediaCache(saved.liquipediaCache);
      state.liquipedia.attribution = liquipedia.LIQUIPEDIA_ATTRIBUTION;
      lpSyncBudget();
      if (saved.ballchasing && typeof saved.ballchasing === 'object') {
        state.ballchasing = { ...state.ballchasing, ...saved.ballchasing };
      }
      if (saved.r6 && typeof saved.r6 === 'object') {
        state.r6 = { autoScore: !!saved.r6.autoScore, gepData: null };
      }
      if (saved.bedwars && typeof saved.bedwars === 'object') {
        state.bedwars = { autoScore: !!saved.bedwars.autoScore, data: null };
      }
      if (saved.sheets && typeof saved.sheets === 'object') {
        state.sheets = {
          ...state.sheets,
          enabled: !!saved.sheets.enabled,
          sheetUrl: saved.sheets.sheetUrl || '',
          sheetId: saved.sheets.sheetId || '',
          title: saved.sheets.title || '',
          saEmail: saved.sheets.saEmail || '',
          autoSyncSec: Number(saved.sheets.autoSyncSec) || 0,
          maps: {
            teams:     { ...state.sheets.maps.teams,     ...(saved.sheets.maps && saved.sheets.maps.teams) },
            schedule:  { ...state.sheets.maps.schedule,  ...(saved.sheets.maps && saved.sheets.maps.schedule) },
            brResults: { ...state.sheets.maps.brResults, ...(saved.sheets.maps && saved.sheets.maps.brResults) },
            brPlayers: { ...state.sheets.maps.brPlayers, ...(saved.sheets.maps && saved.sheets.maps.brPlayers) },
            standings: { ...state.sheets.maps.standings, ...(saved.sheets.maps && saved.sheets.maps.standings) }
          },
          connected: false, lastError: null, tabs: []   // runtime — re-established on connect
        };
      }
      if (saved.activeEvent && typeof saved.activeEvent === 'object') {
        state.activeEvent = { ...state.activeEvent, ...saved.activeEvent };
      }
      // Overlay header rename: existing installs carry the old default title.
      if (state.upcoming && state.upcoming.title === 'UPCOMING MATCHES') state.upcoming.title = 'SCHEDULE';
      if (saved.obs && typeof saved.obs === 'object') {
        state.obs = {
          ...state.obs,
          enabled: !!saved.obs.enabled,
          app: saved.obs.app === 'streamlabs' ? 'streamlabs' : 'obs',
          url: saved.obs.url || state.obs.url,
          slobsUrl: saved.obs.slobsUrl || state.obs.slobsUrl,
          autoSwitch: saved.obs.autoSwitch !== false,
          autoReplayOnGoal: !!saved.obs.autoReplayOnGoal,
          postGameToCastersSec: Number(saved.obs.postGameToCastersSec) || 0,
          kickoff: {
            enabled: !!(saved.obs.kickoff && saved.obs.kickoff.enabled),
            scene: (saved.obs.kickoff && saved.obs.kickoff.scene) || '',
            transition: (saved.obs.kickoff && saved.obs.kickoff.transition) || ''
          },
          scoreboardScene: {
            enabled: !!(saved.obs.scoreboardScene && saved.obs.scoreboardScene.enabled),
            scene: (saved.obs.scoreboardScene && saved.obs.scoreboardScene.scene) || '',
            transition: (saved.obs.scoreboardScene && saved.obs.scoreboardScene.transition) || ''
          },
          postGame: {
            enabled: !!(saved.obs.postGame && saved.obs.postGame.enabled),
            scene: (saved.obs.postGame && saved.obs.postGame.scene) || '',
            delaySec: Number(saved.obs.postGame && saved.obs.postGame.delaySec) || 20,
            transition: (saved.obs.postGame && saved.obs.postGame.transition) || ''
          },
          commercialAutoReturn: saved.obs.commercialAutoReturn !== false,
          scenes: { ...state.obs.scenes, ...(saved.obs.scenes || {}) },
          // runtime fields are not restored
          connected: false,
          lastError: null,
          availableScenes: [],
          availableTransitions: []
        };
      }
      // The OBS stinger the REPLAYS page uses between clips — restored so its video is servable
      // (and its transition point known) from the moment the app starts, without OBS being asked.
      if (saved.obsStinger && typeof saved.obsStinger === 'object') {
        state.obsStinger = {
          name: String(saved.obsStinger.name || ''),
          path: String(saved.obsStinger.path || ''),
          point: Number(saved.obsStinger.point) || 0,
          lengthMs: Number(saved.obsStinger.lengthMs) || 0
        };
      }
      if (saved.vmix && typeof saved.vmix === 'object') {
        state.vmix.enabled = !!saved.vmix.enabled;
        if (typeof saved.vmix.host === 'string' && saved.vmix.host.trim()) state.vmix.host = saved.vmix.host.trim();
        if (Number(saved.vmix.port) > 0) state.vmix.port = Number(saved.vmix.port);
      }
      if (saved.switcher && (saved.switcher.target === 'vmix' || saved.switcher.target === 'obs')) {
        state.switcher.target = saved.switcher.target;
      }
      if (typeof saved.csgoCfgPath === 'string') {
        state.csgo.cfgPath = saved.csgoCfgPath;
      }
      if (typeof saved.csgoAutoWinner === 'boolean') state.csgo.autoWinner = saved.csgoAutoWinner;
      if (typeof saved.csgoShowHistory === 'boolean') state.csgo.showHistory = saved.csgoShowHistory;
      if (typeof saved.csgoBuiltinRadar === 'boolean') state.csgo.builtinRadar = saved.csgoBuiltinRadar;
      if (saved.csgoProLayout === 'stacked' || saved.csgoProLayout === 'wide') state.csgo.proLayout = saved.csgoProLayout;
      if (typeof saved.csgoAutoHud === 'boolean') state.csgo.autoHud = saved.csgoAutoHud;
      if (typeof saved.csgoObserverAssist === 'boolean') state.csgo.observerAssist = saved.csgoObserverAssist;
      state.csgo.radarLayout = cleanRadarLayout(saved.csgoRadarLayout);
      if (saved.csgoCinematic && typeof saved.csgoCinematic === 'object') {
        const c = saved.csgoCinematic;
        state.csgo.cinematic.enabled = !!c.enabled;
        if (Number(c.port) > 0 && Number(c.port) < 65536) state.csgo.cinematic.port = Number(c.port);
        if (c.shots && typeof c.shots === 'object') state.csgo.cinematic.shots = c.shots;
      }
      if (saved.bracket && typeof saved.bracket === 'object') {
        state.bracket = {
          ...state.bracket,
          ...saved.bracket,
          // arrays default safely if an older save lacks them
          winners: Array.isArray(saved.bracket.winners) ? saved.bracket.winners : [],
          losers: Array.isArray(saved.bracket.losers) ? saved.bracket.losers : [],
          finals: Array.isArray(saved.bracket.finals) ? saved.bracket.finals : [],
          standings: Array.isArray(saved.bracket.standings) ? saved.bracket.standings : [],
          schedule: Array.isArray(saved.bracket.schedule) ? saved.bracket.schedule : [],
          roster: Array.isArray(saved.bracket.roster) ? saved.bracket.roster : [],
          matches: Array.isArray(saved.bracket.matches) ? saved.bracket.matches : [],
          phases: Array.isArray(saved.bracket.phases) ? saved.bracket.phases : [],
          activePhaseId: saved.bracket.activePhaseId || '',
          pools: Array.isArray(saved.bracket.pools) ? saved.bracket.pools : [],
          activePoolId: saved.bracket.activePoolId || '',
          matrix: saved.bracket.matrix || null,
          lastError: null
        };
        // Self-heal saves made before the NXGEN importer stopped appending: NXGEN and Challonge
        // are single-phase sources, so any OTHER phase in the list is an orphan from a previously
        // imported event and would render as a stray phase chip on bracket.html.
        // Challengermode is deliberately ABSENT here: it is genuinely multi-phase (one phase per
        // stage — groups, then playoffs), so pruning to a single id would delete real stages.
        const soleId = state.bracket.source === 'nxgen' ? 'nxgen-main'
                     : state.bracket.source === 'challonge' ? 'challonge-main'
                     : state.bracket.source === 'faceit' ? 'faceit-main' : '';
        if (soleId && state.bracket.phases.length > 1 && state.bracket.phases.some((p) => p && p.id === soleId)) {
          state.bracket.phases = state.bracket.phases.filter((p) => p && p.id === soleId);
          state.bracket.activePhaseId = soleId;
        }
      }
      if (saved.upcoming && typeof saved.upcoming === 'object') {
        state.upcoming = { ...state.upcoming, ...saved.upcoming, visible: false, matches: Array.isArray(saved.upcoming.matches) ? saved.upcoming.matches : [] };
      }
      if (saved.standings && typeof saved.standings === 'object') {
        state.standings = { ...state.standings, ...saved.standings, visible: false, rows: Array.isArray(saved.standings.rows) ? saved.standings.rows : [] };
      }
      if (saved.watchlist && typeof saved.watchlist === 'object') {
        state.watchlist = {
          ...state.watchlist, ...saved.watchlist, visible: false,
          fields: Array.isArray(saved.watchlist.fields) && saved.watchlist.fields.length ? saved.watchlist.fields : state.watchlist.fields,
          teams: Array.isArray(saved.watchlist.teams) ? saved.watchlist.teams : []
        };
      }
      if (saved.teamSpotlight && typeof saved.teamSpotlight === 'object') {
        state.teamSpotlight = { ...state.teamSpotlight, ...saved.teamSpotlight, visible: false,
          players: Array.isArray(saved.teamSpotlight.players) ? saved.teamSpotlight.players : [] };
      }
      if (saved.director && typeof saved.director === 'object') {
        state.director = {
          ...state.director,
          enabled: saved.director.enabled !== false,
          sensitivity: typeof saved.director.sensitivity === 'number' ? saved.director.sensitivity : 0.5,
          autoSwitch: !!saved.director.autoSwitch,
          lockTarget: null,
          primary: null,
          alternates: [],
          feed: []
        };
      }
      if (saved.ai && typeof saved.ai === 'object') {
        state.ai = {
          shield: !!saved.ai.shield,
          telemetry: {
            enabled: saved.ai.telemetry?.enabled !== false,
            uploadEnabled: !!saved.ai.telemetry?.uploadEnabled,
            lastUploadAt: saved.ai.telemetry?.lastUploadAt || null,
            lastUploadCount: saved.ai.telemetry?.lastUploadCount || 0
          }
        };
      }
      if (saved.clips && typeof saved.clips === 'object') {
        // Fallback 'manual' (opt-in): an install with no explicit clip mode must NOT auto-drive OBS's
        // replay buffer. A producer who chose 'auto'/'prompt' keeps it (it's preserved above).
        const mode = ['auto', 'prompt', 'manual'].includes(saved.clips.captureMode) ? saved.clips.captureMode : 'manual';
        state.clips = {
          ...state.clips,
          captureMode: mode,
          autoCapture: mode === 'auto',
          autoMontage: !!saved.clips.autoMontage,
          replayFolder: saved.clips.replayFolder || '',
          captureRules: { ...state.clips.captureRules, ...(saved.clips.captureRules || {}) }
        };
      }
      // Restore the measured replay length (sane-range guarded) so goal 1 is timed correctly.
      if (typeof saved.rlReplayLenMs === 'number' && saved.rlReplayLenMs >= 3000 && saved.rlReplayLenMs <= 15000) {
        state.rlReplayLenMs = Math.round(saved.rlReplayLenMs);
      }
      if (saved.rlSpectatorUi && typeof saved.rlSpectatorUi === 'object') {
        state.rlSpectatorUi = { ...rlSpectatorUi.DEFAULTS, ...saved.rlSpectatorUi };
      }
      if (Array.isArray(saved.flows)) {
        state.flows = saved.flows;
      }
      if (Array.isArray(saved.crew)) {
        // workedEvent is new — backfill from active so anyone already on shift stays creditable
        // instead of silently vanishing from credits the moment this field starts being read.
        state.crew = saved.crew.map((c) => (c && typeof c.workedEvent !== 'boolean') ? { ...c, workedEvent: !!c.active } : c);
      }
      // One-time migration: the Show Deck support column used to be "crew whose group is a support
      // role" — seed the new event-scoped list from that so nobody's chip disappears on update.
      if (!Array.isArray(state.casters.support)) {
        state.casters.support = (state.crew || [])
          .filter((c) => c && TD_SUPPORT_GROUPS.includes(c.group))
          .map((c) => ({ crewId: c.id, role: c.role || TD_SUPPORT_LABELS[c.group] || '' }));
      }
      // Clean any duplicates already sitting in a saved list (migrated entries, same-name crew
      // twins, chips whose crew record has since been deleted) rather than only guarding new adds.
      dedupeSupport();
      if (Array.isArray(saved.adProofSessions)) {
        state.adProofSessions = saved.adProofSessions;
      }
      if (saved.playerProfiles && typeof saved.playerProfiles === 'object') {
        state.playerProfiles = saved.playerProfiles;
        // Back-fill countryCode from the stored country name for profiles saved before the country
        // map was expanded — so overlays (credits/intro flags) get a code without re-syncing the event.
        try {
          Object.values(state.playerProfiles).forEach((p) => {
            if (p && !p.countryCode && p.country) { const cc = _countryCode(p.country); if (cc) p.countryCode = cc; }
          });
          // Stamp the resolved country onto EXISTING start.gg event-team + saved-team player objects
          // (older syncs didn't carry it) so the credits/lineup overlays read it straight off the
          // player — no live playerProfiles match needed.
          const prof = (nm) => state.playerProfiles[(nm || '').trim().toLowerCase()] || null;
          const stamp = (pl) => { if (pl && pl.name && !pl.countryCode) { const pr = prof(pl.name); if (pr && (pr.countryCode || pr.country)) { pl.countryCode = pr.countryCode || _countryCode(pr.country) || ''; pl.country = pl.country || pr.country || ''; } } };
          ((state.startgg && state.startgg.eventTeams) || []).forEach((t) => (t.players || []).forEach(stamp));
          (savedTeams || []).forEach((t) => (t.players || []).forEach(stamp));
        } catch (e) {}
      }
      if (saved.draftLook && typeof saved.draftLook === 'object') Object.assign(state.draft, draftLookPrefs(saved.draftLook));
      if (saved.dota && typeof saved.dota === 'object') {
        if (typeof saved.dota.cfgPath === 'string') state.dota.cfgPath = saved.dota.cfgPath;
        state.dota.autoDraft = saved.dota.autoDraft !== false;
        state.dota.radiantSide = saved.dota.radiantSide === 'b' ? 'b' : 'a';
      }
      if (saved.draftAuto && typeof saved.draftAuto === 'object') {
        if (!state.draft.auto) state.draft.auto = { enabled: false, status: 'off', statusDetail: '', lockfilePath: '' };
        state.draft.auto.enabled = !!saved.draftAuto.enabled;
        state.draft.auto.lockfilePath = (saved.draftAuto.lockfilePath || '').toString();
      }
      if (saved.lolHudMode && ['full', 'minimal', 'auto'].includes(saved.lolHudMode)) {
        state.lol.hudMode = saved.lolHudMode;
      }
      if (saved.lolOcr && typeof saved.lolOcr === 'object') {
        state.lol.ocr.enabled = !!saved.lolOcr.enabled;
        state.lol.ocr.displayId = (saved.lolOcr.displayId || '').toString();
        if (saved.lolOcr.regions) ['blue', 'red'].forEach((s) => {
          if (saved.lolOcr.regions[s]) ['x', 'y', 'w', 'h'].forEach((k) => {
            const v = Number(saved.lolOcr.regions[s][k]);
            if (!isNaN(v)) state.lol.ocr.regions[s][k] = Math.max(0, Math.round(v));
          });
        });
      }
      // Battle-royale series. Raw results are restored and the derived boards recomputed, so a
      // scoring-table edit made before a restart is reflected in the totals on boot.
      if (saved.br && typeof saved.br === 'object') {
        const b = saved.br;
        state.br.enabled = !!b.enabled;
        if (typeof b.game === 'string' && GAMES[b.game]) state.br.game = b.game;
        if (b.event && typeof b.event === 'object') state.br.event = { ...state.br.event, ...b.event };
        if (b.format && typeof b.format === 'object') state.br.format = { ...state.br.format, ...b.format };
        if (typeof b.scoringPreset === 'string') brApplyScoringPreset(b.scoringPreset);
        if (b.scoring && typeof b.scoring === 'object') {
          if (Array.isArray(b.scoring.placementPoints)) state.br.scoring.placementPoints = b.scoring.placementPoints.map((n) => Math.max(0, Math.round(Number(n) || 0)));
          if (b.scoring.killPoints != null) state.br.scoring.killPoints = Math.max(0, Number(b.scoring.killPoints) || 0);
          if (b.scoring.killCap != null) state.br.scoring.killCap = Math.max(0, parseInt(b.scoring.killCap, 10) || 0);
        }
        if (Array.isArray(b.results)) state.br.results = b.results.slice(0, 4000);
        if (Array.isArray(b.playerResults)) state.br.playerResults = b.playerResults.slice(0, 8000);
        if (typeof b.source === 'string') state.br.source = b.source;
        // Lobby model. The field is the expensive thing to rebuild by hand mid-event, so it is
        // restored through the same sanitizer the live handlers use — a hand-edited state file
        // can't inject a shape the panel then chokes on.
        if (typeof b.mode === 'string') state.br.mode = b.mode;
        if (typeof b.matrixId === 'string') state.br.matrixId = b.matrixId;
        if (b.liveMatch != null) state.br.live.match = Math.max(1, Math.min(40, parseInt(b.liveMatch, 10) || 1));
        if (b.matchMultipliers && typeof b.matchMultipliers === 'object') state.br.matchMultipliers = b.matchMultipliers;
        if (typeof b.teamFormat === 'string') state.br.teamFormat = b.teamFormat;
        if (Array.isArray(b.lobby)) state.br.lobby = b.lobby.slice(0, 200).map(sanitizeBrEntrant).filter((e) => e.name);
        if (b.dropmap && typeof b.dropmap === 'object') {
          state.br.dropmap = { ...state.br.dropmap, ...b.dropmap, visible: false };   // never boot with a graphic live
        }
        // compare/victory/live are per-show transients — deliberately not restored.
      }
      // Keep the two representations of squad size in lockstep on boot: teamFormat is what the
      // panel drives, format.teamSize is what the sheet template and roster checks already read.
      state.br.format.teamSize = brFormatSize(state.br.teamFormat);
      // Restore the league binding LAST — leagues are loaded above, so brBinding() can actually
      // resolve here. A binding whose league or cup was deleted between runs is dropped rather
      // than left dangling, and a live one re-mirrors so the board boots with the cup's results.
      if (saved.br && typeof saved.br === 'object') {
        state.br.leagueId = String(saved.br.leagueId || '');
        state.br.seriesId = String(saved.br.seriesId || '');
        if (state.br.leagueId && !brSyncFromLeague()) { state.br.leagueId = ''; state.br.seriesId = ''; }
      }
      (state.leagues || []).forEach(recomputeBrSeason);
      if (!Array.isArray(state.br.scoring.placementPoints) || !state.br.scoring.placementPoints.length) {
        brApplyScoringPreset(state.br.scoringPreset || 'fncs');
      }
      computeBrStandings();
      if (saved.apex && typeof saved.apex === 'object') {
        const a = saved.apex;
        if (a.scoring && Array.isArray(a.scoring.placementPoints)) {
          state.apex.scoring.placementPoints = a.scoring.placementPoints.map((n) => Math.max(0, Math.round(Number(n) || 0)));
          state.apex.scoring.killPoints = Math.max(0, Number(a.scoring.killPoints) || 0);
        }
        if (a.teamMap && typeof a.teamMap === 'object') state.apex.teamMap = a.teamMap;
        if (a.event && typeof a.event === 'object') state.apex.event = { title: String(a.event.title || ''), match: String(a.event.match || ''), split: String(a.event.split || '') };
        if (Array.isArray(a.games)) state.apex.games = a.games;
        if (Number(a.port)) state.apex.port = Number(a.port);
      }
    }
  } catch (e) {
    // A throw anywhere in the restore above skips every remaining field, and the next auto-save
    // then writes that partial state straight over the good file — permanent, silent data loss.
    // Credentials are already safe (restoreSecrets ran first); keep a copy of the file as it was
    // on disk so the rest is recoverable, and say so loudly instead of one console line.
    console.error('Error loading state:', e);
    _stateLoadAbort = { saved: (saved && typeof saved === 'object') ? saved : null, error: (e && e.message) || String(e) };
    console.error('[state] RESTORE ABORTED PART-WAY — every setting below the failure is back at '
      + 'its default and will be saved that way. Fix the cause before continuing.');
    try {
      const rescue = stateFile + '.loadfail-' + new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(stateFile, rescue);
      console.error('[state] previous state file preserved at ' + rescue);
    } catch (e2) { console.error('[state] could not preserve the previous state file:', e2.message); }
  }
}

// The persisted shape of the app: everything loadState() restores. Pure (no I/O) so the save/load
// round trip can be tested (test/persist-roundtrip.test.js).
function buildSaveSnapshot() {
  return {
    // Keys saved as-is (save: 'plain' in backend/state-schema.js); the serializers below cover the rest.
    ...stateSchema.plainSnapshot(state),
    followSetGame: !!state.followSetGame,
    eventNameSlug: state.eventNameSlug || '',
    perfMode: (function () { const pm = state.perfMode || {}; return {
      enabled: pm.enabled !== false, always: !!pm.always,
      reduceAnimations: !!pm.reduceAnimations, pausePreviews: !!pm.pausePreviews,
      broadcastRate: pm.broadcastRate || 'smooth' }; })(),
    orgLibrary: (function () { const o = state.orgLibrary || {}; return { autoSync: o.autoSync !== false, profileId: o.profileId || null }; })(),
    // Settings only — the vault's records live in team-db.json (see backend/team-db.js).
    teamVault: (function () { const v = state.teamVault || {}; return { enabled: v.enabled !== false, autoLink: v.autoLink !== false, autoEnrich: v.autoEnrich !== false }; })(),
    lanSeats: (() => { const { seats, seen, agentError, ...keep } = state.lanSeats || {}; return keep; })(),
    draftAuto: { enabled: !!(state.draft && state.draft.auto && state.draft.auto.enabled), lockfilePath: (state.draft && state.draft.auto && state.draft.auto.lockfilePath) || '' },
    draftLook: draftLookPrefs(state.draft),
    dota: { cfgPath: state.dota.cfgPath || '', autoDraft: state.dota.autoDraft !== false, radiantSide: state.dota.radiantSide === 'b' ? 'b' : 'a' },
    lolHudMode: (state.lol && state.lol.hudMode) || 'auto',
    lolOcr: { enabled: !!(state.lol && state.lol.ocr && state.lol.ocr.enabled), displayId: (state.lol && state.lol.ocr && state.lol.ocr.displayId) || '', regions: (state.lol && state.lol.ocr && state.lol.ocr.regions) || undefined },
    br: {
      enabled: state.br.enabled, game: state.br.game, event: state.br.event, format: state.br.format,
      scoringPreset: state.br.scoringPreset, scoring: state.br.scoring,
      results: state.br.results, playerResults: state.br.playerResults, source: state.br.source,
      // Lobby: mode/format/field are event setup and must survive a restart mid-show. The
      // graphics (compare/victory) and live counters are not saved — they're this-moment state.
      mode: state.br.mode, teamFormat: state.br.teamFormat, lobby: state.br.lobby,
      dropmap: state.br.dropmap,
      leagueId: state.br.leagueId, seriesId: state.br.seriesId,
      matrixId: state.br.matrixId, matchMultipliers: state.br.matchMultipliers,
      liveMatch: (state.br.live && state.br.live.match) || 1
    },
    pointMatrices: state.pointMatrices || [],
    apex: { scoring: state.apex && state.apex.scoring, teamMap: (state.apex && state.apex.teamMap) || {}, event: (state.apex && state.apex.event) || {}, games: (state.apex && state.apex.games) || [], port: (state.apex && state.apex.port) || 7777 },
    // Settings only. gepData/data are live payloads from a spectator client or MC server —
    // restoring a stale scoreboard on boot would be worse than starting empty.
    r6: { autoScore: !!(state.r6 && state.r6.autoScore) },
    bedwars: { autoScore: !!(state.bedwars && state.bedwars.autoScore) },
    bedwarsToken: encryptSecret(bedwarsToken),
    adProofSessions: state.adProofSessions || [],
    playerProfiles: state.playerProfiles || {},
    replay: (({ program, preview, ...look }) => look)(state.replay || {}),   // buses are runtime-only
    // Post-game board style (Default/Glass/Block/Radar/Compare) + show-stats. loadState() already
    // restored this, but it was never written, so the pick reset to Default on every restart.
    breakScreen: {
      visible: state.breakScreen.visible,
      title: state.breakScreen.title,
      message: state.breakScreen.message,
      finalMessage: state.breakScreen.finalMessage
    },
    // Persist content for the momentary production graphics; visibility is reset on restart.
    winner: { side: state.winner.side, name: state.winner.name, logo: state.winner.logo, color: state.winner.color, subtitle: state.winner.subtitle, style: state.winner.style },
    veto: { title: state.veto.title, maps: state.veto.maps },
    intro: { side: state.intro.side, title: state.intro.title, style: state.intro.style, showFooter: state.intro.showFooter, showRealName: state.intro.showRealName !== false },
    owMatch: { visible: !!state.owMatch.visible, format: state.owMatch.format, currentMapIdx: state.owMatch.currentMapIdx, bansByMap: state.owMatch.bansByMap, attackSide: state.owMatch.attackSide || null, showAttack: !!state.owMatch.showAttack, gameMode: state.owMatch.gameMode || 'escort', showMapLabels: state.owMatch.showMapLabels !== false, mapWinners: Array.isArray(state.owMatch.mapWinners) ? state.owMatch.mapWinners : [], mapModes: Array.isArray(state.owMatch.mapModes) ? state.owMatch.mapModes : [], seriesLabel: state.owMatch.seriesLabel === 'bo' ? 'bo' : 'ft' },
    mrMatch: (function(){ const m=state.mrMatch||{}; return { visible: m.visible !== false, format: m.format || 'BO5', bansByMap: m.bansByMap || [], gameMode: m.gameMode || 'convergence', showMapLabels: m.showMapLabels !== false, mapWinners: Array.isArray(m.mapWinners)?m.mapWinners:[], mapModes: Array.isArray(m.mapModes)?m.mapModes:[], gepData: m.gepData||null }; })(),
    customOverlayLayouts: state.customOverlayLayouts || {},
    gameConfigs: state.gameConfigs || {},
    gameConfigVersions: state.gameConfigVersions || {},
    gameConfigFrom: state.gameConfigFrom || {},
    matchTitles: { twitch: state.matchTitles.twitch, vod: state.matchTitles.vod, stripSponsors: state.matchTitles.stripSponsors, vodLog: state.matchTitles.vodLog },
    game: { number: state.game.number },
    startggApiToken: encryptSecret(startggApiToken),
    challonge: { enabled: state.challonge.enabled, tournamentSlug: state.challonge.tournamentSlug, selectedTournament: state.challonge.selectedTournament, logoMap: state.challonge.logoMap, autoFollow: state.challonge.autoFollow, gameId: state.challonge.gameId, pollSec: state.challonge.pollSec, budget: state.challonge.budget },
    challengermode: { enabled: state.challengermode.enabled, tournamentId: state.challengermode.tournamentId,
      selectedTournament: state.challengermode.selectedTournament, logoMap: state.challengermode.logoMap,
      autoFollow: state.challengermode.autoFollow, gameId: state.challengermode.gameId,
      pollSec: state.challengermode.pollSec, spaceId: state.challengermode.spaceId },
    challengermodeRefreshKey: encryptSecret(challengermodeRefreshKey),
    challongeApiKey: encryptSecret(challongeApiKey),
    nxgen: { enabled: state.nxgen.enabled, eventSlug: state.nxgen.eventSlug, selectedEvent: state.nxgen.selectedEvent, logoMap: state.nxgen.logoMap, autoFollow: state.nxgen.autoFollow },
    nxgenApiKey: encryptSecret(nxgenApiKey),
    liquipediaApiKey: encryptSecret(liquipediaApiKey),
    riot: { region: state.riot.region, platform: state.riot.platform },
    riotApiKey: encryptSecret(riotApiKey),
    // Persisted so the rolling hour survives a restart (Liquipedia's window keeps running
    // regardless) and so cached results are re-used, which their terms explicitly ask for.
    liquipediaBudget: _lpBudget.toJSON(),
    liquipediaCache: _lpCache.toJSON(),
    faceit: { enabled: state.faceit.enabled, competitionId: state.faceit.competitionId, competitionType: state.faceit.competitionType, organizerId: state.faceit.organizerId, organizerName: state.faceit.organizerName, selectedEvent: state.faceit.selectedEvent, logoMap: state.faceit.logoMap, autoFollow: state.faceit.autoFollow },
    faceitApiKey: encryptSecret(faceitApiKey),
    ballchasingApiKey: encryptSecret(ballchasingApiKey),
    sheets: { enabled: state.sheets.enabled, sheetUrl: state.sheets.sheetUrl, sheetId: state.sheets.sheetId,
      title: state.sheets.title, saEmail: state.sheets.saEmail, autoSyncSec: state.sheets.autoSyncSec, maps: state.sheets.maps },
    sheetsServiceAccount: encryptSecret(sheetsServiceAccount),
    competitionApiKey: encryptSecret(competitionApiKey),
    competitionFeedTokens: Object.keys(competitionFeedTokens).length ? encryptSecret(JSON.stringify(competitionFeedTokens)) : '',
    obs: {
      enabled: state.obs.enabled,
      app: state.obs.app,
      url: state.obs.url,
      slobsUrl: state.obs.slobsUrl,
      autoSwitch: state.obs.autoSwitch,
      autoReplayOnGoal: state.obs.autoReplayOnGoal,
      postGameToCastersSec: state.obs.postGameToCastersSec,
      kickoff: state.obs.kickoff,
      scoreboardScene: state.obs.scoreboardScene,
      postGame: state.obs.postGame,
      commercialAutoReturn: state.obs.commercialAutoReturn,
      scenes: state.obs.scenes
    },
    obsPassword: encryptSecret(obsPassword),
    slobsToken: encryptSecret(slobsToken),
    vmix: { enabled: state.vmix.enabled, host: state.vmix.host, port: state.vmix.port },
    switcher: { target: state.switcher.target },
    // Persist the full bracket so it renders instantly on restart (then refreshes)
    brand: state.brand || null,                 // global accent fallback (Settings ▸ Appearance) when no kit is active
    preshowPresets: state.preshowPresets || [], // Desk Show named topic rundowns
    csgoCfgPath: state.csgo.cfgPath,
    csgoAutoWinner: state.csgo.autoWinner !== false,
    csgoShowHistory: !!state.csgo.showHistory,
    csgoBuiltinRadar: state.csgo.builtinRadar !== false,
    csgoProLayout: state.csgo.proLayout === 'stacked' ? 'stacked' : 'wide',
    csgoAutoHud: state.csgo.autoHud !== false,
    csgoObserverAssist: state.csgo.observerAssist !== false,
    csgoRadarLayout: state.csgo.radarLayout || null,
    csgoCinematic: { enabled: !!state.csgo.cinematic.enabled, port: state.csgo.cinematic.port, shots: state.csgo.cinematic.shots || {} },
    director: {
      enabled: state.director?.enabled !== false,
      sensitivity: state.director?.sensitivity ?? 0.5,
      autoSwitch: !!state.director?.autoSwitch
    },
    ai: {
      shield: !!state.ai?.shield,
      telemetry: {
        enabled: state.ai?.telemetry?.enabled !== false,
        uploadEnabled: !!state.ai?.telemetry?.uploadEnabled,
        lastUploadAt: state.ai?.telemetry?.lastUploadAt || null,
        lastUploadCount: state.ai?.telemetry?.lastUploadCount || 0
      }
    },
    clips: {
      captureMode: state.clips?.captureMode || 'manual',
      autoCapture: state.clips?.captureMode === 'auto',   // derived from the mode; default OFF, never forced on
      autoMontage: !!state.clips?.autoMontage,
      replayFolder: state.clips?.replayFolder || '',
      captureRules: state.clips?.captureRules || {}
    },
    rlSpectatorUi: state.rlSpectatorUi || rlSpectatorUi.DEFAULTS,
    // Persist the measured goal-replay length so the FIRST goal of a session is timed off the real
    // value instead of the overlay's 6000ms fallback (that's why goal 1 was off and the rest fine).
    rlReplayLenMs: state.rlReplayLenMs || 0,
    flows: state.flows || [],
    sceneBg: state.sceneBg || {},
    scenePresets: state.scenePresets || {},
    crew: state.crew || [],
    // Read back by loadState() but never written before 2026-10-13 (persist-roundtrip test):
    dateFormat: state.dateFormat === 'intl' ? 'intl' : 'us',
    liquipedia: { enabled: !!state.liquipedia.enabled, wiki: state.liquipedia.wiki || '', contact: state.liquipedia.contact || '' },
    liquipediaBudget: _lpBudget ? _lpBudget.toJSON() : undefined,   // keeps the rate limit across restarts
  };
}
function _saveAppStateNow(sync = false) {
  let toSave = null;   // hoisted so the catch can diagnose it on a serialization failure
  try {
    toSave = buildSaveSnapshot();
    if (_stateLoadAbort && _stateLoadAbort.saved) {
      const disk = _stateLoadAbort.saved;
      Object.keys(toSave).forEach((k) => {
        if (Array.isArray(toSave[k]) && !toSave[k].length && Array.isArray(disk[k]) && disk[k].length) toSave[k] = disk[k];
      });
    }
    safeWriteJson(stateFile, toSave, sync);
    saveTwitchData(sync);
  } catch (e) {
    console.error('Error saving state:', e);
    // A "Maximum call stack size exceeded" here means a circular/too-deep object reached the persisted
    // state (the raw bracket/startgg blobs live here). Log where, so the same paste that broke the live
    // broadcast is diagnosable from the save path too. Only runs on failure — never on the hot path.
    if (e && /call stack|circular/i.test(e.message || '')) {
      let where; try { where = _diagnoseSerialization(toSave); } catch (_) { where = 'diagnosis walk failed'; }
      _logSerializeFailure(`saveAppState: ${e.message} — data-path signal: ${where}`, e);
    }
  }
}

// Debounced public wrapper — collapses rapid successive saves (e.g. during RL match events)
// into one disk write after 500ms of quiet. Use _saveAppStateNow() for immediate flush.
let _saveTimer = null;
function saveAppState() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_saveAppStateNow, 500);
}

// ─── VDO.Ninja talent workflow ─────────────────────────────────────────────
// (moved to backend/vdo/talent.js)
const { vdoRandom, vdoSlug, ensureTeamVdo, ensureCasterVdo, ensureGuestsVdo, ensureObserversVdo, ensureRoomVdo, ensureInterviewVdo, buildCasterJoinUrlFromVdo, buildCasterObsUrlFromVdo, chatCommandReply, dedupeSupport, resolveLineupToList, suppressAutoFill, unsuppressAutoFill, findTeamPlayer, playerStreamId, sanitizeVdoAudio, VDO_CRED_STRIP, vdoBase, buildObsViewUrl, buildPlayerInterviewViewUrl, buildListenInUrl, buildRoomListenInUrl, buildCasterObsUrl, crewGamertagFor, deskLineupPeople, deskSlotNames, clearDeskSlots, seatDeskSlots, deskRoomVdo, ensureDirectorApiKey, buildTalentJoinUrl, buildPlayerInterviewJoinUrl, buildRoomJoinUrl, buildDirectorUrl, buildTalentGroup, buildCasterJoinUrl } = require('./backend/vdo/talent')({
  https, state
});
// ─── Broadcasting to panels and overlays ─────────────────────────────────────
function broadcast(clients, msg) {
  broadcastRaw(clients, JSON.stringify(msg));
}
// Send an already-serialized message string (lets callers stringify once and reuse it, e.g. the
// live-payload dedup in _flushFullState).
function broadcastRaw(clients, str) {
  clients.forEach(ws => {
    // Per-client try/catch, not one around the loop: readyState can go stale between the check and
    // the send (a browser source closing, an overlay machine dropping off), and a bare ws.send()
    // then THROWS out of forEach — so every client positioned after the bad one silently missed
    // that broadcast. On a multi-source show that reads as "some overlays froze and others didn't".
    // Same hazard sendWs() documents below, which this loop did not have.
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(str);
    } catch (e) { /* dead socket — its own 'close' handler removes it from the set */ }
  });
}
// Reply to ONE client, safely. Long-running handlers (start.gg imports run for minutes) finish
// against a socket the producer may have closed by reloading the panel — a bare ws.send() then
// throws, and in a catch block that re-sends it throws AGAIN, escaping the async handler into
// main.js's unhandledRejection crash logger. Never throws; returns whether it went out.
function sendWs(ws, msg) {
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  } catch (e) { return false; }
}

function formatTime(seconds) {
  if (seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// The live, frequently-changing payload sent on EVERY broadcast. Deliberately excludes the
// big control-panel-only libraries (savedTeams, brandKits) and the static champion list —
// those are sent separately so live broadcasts stay tiny and fluid during production.
// Live overlay browser sources connected to the WS bridge, by page — drives the pre-flight
// "overlays reachable" check (0 ⇒ no graphics will reach the stream). Cheap: a Set walk.
function overlayClientInfo() {
  let count = 0; const pages = {};
  for (const ws of bridgeClients) {
    if (ws._role !== 'overlay') continue;
    // A wrapper source (gfx.html) carries its embedded overlays over ONE socket; each registers its
    // own page on it, so count pages, not sockets.
    const list = ws._pages && ws._pages.size ? Array.from(ws._pages) : [ws._page || 'overlay'];
    list.forEach((p) => { count++; pages[p] = (pages[p] || 0) + 1; });
  }
  return { count, pages };
}
let _lastOverlayCount = -1;
function maybeBroadcastOverlayCount() {
  const n = overlayClientInfo().count;
  if (n === _lastOverlayCount) return;       // only push when the count actually changes (avoid reconnect churn)
  _lastOverlayCount = n;
  // A tiny message, NOT a full_state. This fired on every overlay connect/disconnect, and every
  // Graphics scene switch swaps the preview's overlay (one disconnect + one connect), so browsing
  // scenes pushed the whole ~330KB live state to the panel, the dock pop-out and every overlay,
  // and each redrew everything: the "app freezes when navigating" report. Refreshing OBS sources
  // mid-show did the same. Nothing renders the count any more (the pre-flight panel was removed);
  // it still rides every snapshot as state.overlays for anything that wants it.
  broadcast(bridgeClients, { type: 'overlay_count', data: overlayClientInfo() });
}

// Resolve the season/league record for one team name. Season W/L + points + placement
// come from the manually-managed league standings (state.leagues); "this week" W/L comes
// from the live start.gg event standings (state.bracket.standings). Returns null when the
// team isn't found in any league AND has no start.gg standing — overlay then shows nothing.
// source: 'stats' (in-app leagues) | 'startgg' (tournament platform league + live event).
function resolveOneTeamRecord(name, source) {
  const key = String(name == null ? '' : name).trim().toLowerCase();
  if (!key) return null;
  const out = { seasonW: null, seasonL: null, pts: null, place: null, weekW: null, weekL: null, gamesW: null, gamesL: null };
  const src = source || 'stats';

  // In-app manual league standings → season W/L, points, placement. Prefer a league for the
  // active game; fall back to the first league that contains a team with this name.
  if (src === 'stats') {
    const leagues = Array.isArray(state.leagues) ? state.leagues : [];
    const chosenId = (state.teamRecord && state.teamRecord.leagueId) || '';
    // Use the producer-selected league when set; otherwise auto-pick (active game first).
    const ordered = chosenId
      ? leagues.filter((l) => String(l.id) === String(chosenId))
      : leagues.slice().sort((a, b) => (b.game === state.activeGame ? 1 : 0) - (a.game === state.activeGame ? 1 : 0));
    for (const lg of ordered) {
      // League teams may be references ({id, teamName}) or copies ({id, name}) — match either.
      const team = (lg.teams || []).find((t) => String(t.teamName || t.name || '').trim().toLowerCase() === key);
      if (!team) continue;
      const st = (lg.standings || []).find((s) => s.teamId === team.id);
      if (st) {
        out.seasonW = st.w || 0;
        out.seasonL = st.l || 0;
        out.pts = st.pts || 0;
        out.gamesW = st.subW || 0;
        out.gamesL = st.subL || 0;
        const ranked = (lg.standings || []).slice().sort((a, b) =>
          (b.pts || 0) - (a.pts || 0) || ((b.w || 0) - (b.l || 0)) - ((a.w || 0) - (a.l || 0)));
        const idx = ranked.findIndex((s) => s.teamId === team.id);
        if (idx >= 0) out.place = idx + 1;
      } else { out.seasonW = 0; out.seasonL = 0; out.pts = 0; out.gamesW = 0; out.gamesL = 0; }
      // "This week" W/L, from the same in-app league's schedule — mirrors what the 'startgg'
      // source already provides via the live event standings, just sourced from lg.schedule instead.
      const weekSel = (state.teamRecord && state.teamRecord.week) || '';
      const targetWeek = weekSel || autoPickLatestCompletedWeek(lg);
      if (targetWeek) {
        const wkMatches = (lg.schedule || []).filter((m) =>
          String(m.week || '') === String(targetWeek) &&
          (m.teamA === team.id || m.teamB === team.id) &&
          m.result && m.result.scoreA != null && m.result.scoreB != null);
        let ww = 0, wl = 0;
        for (const m of wkMatches) {
          const isA = m.teamA === team.id;
          const mine = isA ? m.result.scoreA : m.result.scoreB;
          const theirs = isA ? m.result.scoreB : m.result.scoreA;
          if (mine > theirs) ww++; else if (theirs > mine) wl++;
        }
        out.weekW = ww; out.weekL = wl;
      }
      break;
    }
  }

  // Tournament platform (start.gg): LEAGUE standings → season points + placement, and the
  // live start.gg event standings → "this week" W/L (computed from played sets).
  if (src === 'startgg') {
    const lt = ((state.startggLeagueStandings && state.startggLeagueStandings.teams) || [])
      .find((t) => String(t.name || '').trim().toLowerCase() === key);
    if (lt) { if (lt.points != null) out.pts = lt.points; if (lt.place != null) out.place = lt.place; }
    const wk = (state.bracket && Array.isArray(state.bracket.standings) ? state.bracket.standings : [])
      .find((s) => String(s.name || '').trim().toLowerCase() === key);
    if (wk) { out.weekW = wk.wins || 0; out.weekL = wk.losses || 0; out.seasonW = out.seasonW ?? (wk.wins || 0); out.seasonL = out.seasonL ?? (wk.losses || 0); }
  }

  const hasAny = ['seasonW', 'pts', 'place', 'weekW'].some((k) => out[k] != null);
  return hasAny ? out : null;
}

// Format a resolved record into the single line the overlay shows, per the chosen metric.
function formatTeamRecord(rec, metric) {
  if (!rec) return '';
  const dot = ' ' + String.fromCharCode(0xB7) + ' ';
  const season = (rec.seasonW != null) ? `${rec.seasonW}-${rec.seasonL}` : '';
  const week = (rec.weekW != null) ? `${rec.weekW}-${rec.weekL}` : '';
  const pts = (rec.pts != null) ? `${rec.pts} PTS` : '';
  const place = (rec.place != null) ? `#${rec.place}` : '';
  const games = (rec.gamesW != null) ? `${rec.gamesW}-${rec.gamesL}` : '';
  switch (metric) {
    case 'week':   return week;
    case 'pts':    return pts;
    case 'place':  return place;
    case 'games':  return games;
    case 'record-pts': return [season, pts].filter(Boolean).join(dot);
    case 'season':
    default:       return season;
  }
}

// Tiny per-broadcast blob of the resolved records for the two live teams (no logos/blobs).
// Per-side standing from the IN-APP leagues (ESPORTS ▸ Leagues), always computed — deliberately
// independent of the teamRecord DISPLAY toggle. Overlays use this as a fallback when there's no
// bracket standing for a team: plenty of producers don't run start.gg at all, and without this the
// Lineup card's record/seed rows simply vanish for them. Tiny blob, so it rides the live tier
// (state.leagues itself is 'library' and never reaches overlays).
function resolveLeagueStandings() {
  const one = (name) => {
    if (!name) return null;
    const r = resolveOneTeamRecord(name, 'stats');
    if (!r) return null;
    if (r.seasonW == null && r.seasonL == null && r.place == null) return null;
    // A league with no games played yet ranks everyone 0-0, so `place` is nothing but tie-break
    // order — putting "#3" on air off an unplayed season is worse than showing nothing. Only
    // surface a standing once the team actually has a result (or points) behind it.
    const played = (Number(r.seasonW) || 0) + (Number(r.seasonL) || 0);
    if (played <= 0 && !(Number(r.pts) > 0)) return null;
    return { w: r.seasonW ?? null, l: r.seasonL ?? null, place: r.place ?? null, pts: r.pts ?? null };
  };
  return {
    blue: one(state.teams.blue && state.teams.blue.name),
    orange: one(state.teams.orange && state.teams.orange.name)
  };
}

function resolveTeamRecords() {
  const tr = state.teamRecord || {};
  const source = tr.source || 'stats';
  if (!tr.enabled) return { enabled: false, source, metric: tr.metric || 'season', leagueId: tr.leagueId || '', blue: '', orange: '', rawBlue: {}, rawOrange: {} };
  const metric = tr.metric || 'season';
  const numOrNull = (v) => (v == null || v === '' || isNaN(v)) ? null : Number(v);
  const recFor = (side, name) => {
    if (source === 'manual') {
      // Keyed by team NAME ONLY, so the record is tied to the team profile and follows it across side
      // swaps/reassignments. (NO side-keyed fallback — that pinned records to Blue/Orange and was
      // exactly why they didn't switch. Legacy records are migrated to manualByName once on load.)
      const m = (tr.manualByName && tr.manualByName[(name || '').trim().toLowerCase()]) || {};
      const w = numOrNull(m.w), l = numOrNull(m.l);
      return { seasonW: w, seasonL: l, weekW: w, weekL: l, pts: numOrNull(m.pts), place: numOrNull(m.place) };
    }
    return resolveOneTeamRecord(name, source) || {};
  };
  const fmt = (rec) => (['seasonW', 'pts', 'place'].some((k) => rec[k] != null)) ? formatTeamRecord(rec, metric) : '';
  const raw = (rec) => ({ w: rec.seasonW ?? null, l: rec.seasonL ?? null, pts: rec.pts ?? null, place: rec.place ?? null });
  const bRec = recFor('blue', state.teams.blue && state.teams.blue.name);
  const oRec = recFor('orange', state.teams.orange && state.teams.orange.name);
  return {
    enabled: true, source, metric, leagueId: tr.leagueId || '',
    blue: fmt(bRec), orange: fmt(oRec),
    rawBlue: raw(bRec), rawOrange: raw(oRec)   // per-side numbers so the team boxes can prefill/edit
  };
}

// Derive the active preset's config for each scene — small flat object broadcast to overlays.
function buildSceneConfig() {
  const out = {};
  for (const [key, sp] of Object.entries(state.scenePresets || {})) {
    const cfg = ((sp.presets || {})[sp.active || 'Default'] || {}).config || {};
    if (Object.keys(cfg).some((k) => cfg[k])) out[key] = cfg;
  }
  return out;
}

// ── Broadcast tiers ──────────────────────────────────────────────────────────
// Declared per key in backend/state-schema.js (one table with saving and loading).
const stateSchema = require('./backend/state-schema');
const BROADCAST_TIERS = stateSchema.broadcastTiers();
const _untieredWarned = new Set();
function stripByTier(payload) {
  for (const k of Object.keys(payload)) {
    const tier = BROADCAST_TIERS[k];
    if (tier === 'library' || tier === 'local') { payload[k] = undefined; continue; }
    if (!tier && !_untieredWarned.has(k)) {
      _untieredWarned.add(k);
      console.warn(`[broadcast] state.${k} has NO BROADCAST_TIERS entry — it is riding every live broadcast. Declare it 'live', 'library' or 'local' in server.js BROADCAST_TIERS.`);
    }
  }
  return payload;
}

// Points tables for the formats producers actually run. placementPoints[0] is 1st place; a field
// deeper than the table scores 0. killPoints is per elimination; killCap 0 = uncapped.
const BR_SCORING_PRESETS = {
  // Fortnite 2026. Epic runs a DIFFERENT elim value per stage — 3 points in Groups/Heats, 4 in
  // Finals — which is the single most-missed detail when a TO copies one table for a whole event,
  // so the two stages ship as separate presets rather than one "FNCS" entry.
  // The placement tables track the published 2026 Finals distribution; Epic re-tunes them between
  // seasons, so they stay fully editable (any hand edit flips scoringPreset to 'custom').
  fncsFinals: { label: 'Fortnite — FNCS Finals (4/elim)', placementPoints: [30, 26, 24, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1], killPoints: 4, killCap: 0 },
  fncsGroups: { label: 'Fortnite — FNCS Groups (3/elim)', placementPoints: [30, 26, 24, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1], killPoints: 3, killCap: 0 },
  fncsReload: { label: 'Fortnite — Reload path',          placementPoints: [25, 20, 16, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1, 1, 1], killPoints: 3, killCap: 0 },
  fncs:    { label: 'Fortnite (FNCS legacy)',  placementPoints: [40, 32, 28, 26, 24, 22, 20, 18, 16, 14, 12, 10, 8, 6, 4, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1], killPoints: 2, killCap: 0 },
  fncsCup: { label: 'Fortnite (Victory Cup)', placementPoints: [30, 25, 22, 20, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1, 1, 1], killPoints: 1, killCap: 0 },
  algs:    { label: 'Apex (ALGS)',            placementPoints: [12, 9, 7, 5, 4, 3, 3, 2, 2, 2, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], killPoints: 1, killCap: 0 },
  pubg:    { label: 'PUBG (Esports)',         placementPoints: [10, 6, 5, 4, 3, 2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0], killPoints: 1, killCap: 0 },
  warzone: { label: 'Warzone (Kill Race)',    placementPoints: [10, 8, 6, 5, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0], killPoints: 1, killCap: 0 },
  custom:  { label: 'Custom',                 placementPoints: [10, 8, 6, 5, 4, 3, 2, 1, 0, 0], killPoints: 1, killCap: 0 }
};
function brApplyScoringPreset(id) {
  const p = BR_SCORING_PRESETS[id] || BR_SCORING_PRESETS.fncs;
  state.br.scoringPreset = BR_SCORING_PRESETS[id] ? id : 'fncs';
  state.br.scoring = { placementPoints: p.placementPoints.slice(), killPoints: p.killPoints, killCap: p.killCap };
}

// ─── Point matrices ──────────────────────────────────────────────────────────
// FNCS is ONE format among many. Most orgs run their own points table, and it changes per
// tournament and per season — so a matrix is a first-class, named, reusable object, not a
// preset id baked into the series.
//
// Resolution order for what a cup actually scores under:
//   cup.scoring (snapshot)  ←  cup.matrixId  ←  league.brMatrixId  ←  app default
// The SNAPSHOT is what scores. Pointing a cup at a matrix copies that matrix in; editing the
// matrix afterwards does NOT silently re-score cups already played (which would rewrite a
// finished season's history) — the panel surfaces a "matrix changed — re-apply?" instead.
//
// Beyond placement + elims, the fields here are the ones real BR formats actually use:
//   killCap      cap on scoring elims per match (common in kill-race formats)
//   vrBonus      flat bonus for a Victory Royale on top of the 1st-place points
//   minPlacement lowest placement that scores at all (0 = the table's own length decides)
function brNewMatrixId() { return 'mx-' + Math.random().toString(36).slice(2, 9); }
function sanitizePointMatrix(raw) {
  const m = (raw && typeof raw === 'object') ? raw : {};
  return {
    id: String(m.id || '').trim() || brNewMatrixId(),
    name: String(m.name || 'Point matrix').slice(0, 60),
    notes: String(m.notes || '').slice(0, 200),
    builtin: !!m.builtin,
    placementPoints: (Array.isArray(m.placementPoints) ? m.placementPoints : [])
      .slice(0, 150).map((n) => Math.max(0, Math.round(Number(n) || 0))),
    killPoints: Math.max(0, Number(m.killPoints) || 0),
    killCap: Math.max(0, parseInt(m.killCap, 10) || 0),
    vrBonus: Math.max(0, Number(m.vrBonus) || 0)
  };
}
// Built-ins are seeds a producer can copy and edit — never the only option, and never
// silently imposed. Anything a real org runs that isn't here is a two-click custom matrix.
function builtinMatrices() {
  return Object.entries(BR_SCORING_PRESETS).map(([id, p]) => sanitizePointMatrix({
    id: 'builtin-' + id, name: p.label, builtin: true,
    placementPoints: p.placementPoints, killPoints: p.killPoints, killCap: p.killCap
  }));
}
function allMatrices() {
  const custom = Array.isArray(state.pointMatrices) ? state.pointMatrices : [];
  return builtinMatrices().concat(custom);
}
function findMatrix(id) {
  return allMatrices().find((m) => m.id === String(id || '')) || null;
}
// Turn a matrix into the scoring object a cup stores and scores against.
function matrixToScoring(m) {
  return {
    placementPoints: (m.placementPoints || []).slice(),
    killPoints: m.killPoints,
    killCap: m.killCap,
    vrBonus: m.vrBonus || 0
  };
}
// Has the source matrix drifted from the cup's snapshot? Drives the "re-apply?" prompt.
function matrixDiffersFromSnapshot(matrixId, scoring) {
  const m = findMatrix(matrixId);
  if (!m || !scoring) return false;
  const a = matrixToScoring(m), b = scoring;
  return JSON.stringify([a.placementPoints, a.killPoints, a.killCap, a.vrBonus])
    !== JSON.stringify([b.placementPoints || [], b.killPoints || 0, b.killCap || 0, b.vrBonus || 0]);
}
// Split the two halves out, because the FNCS-style board shows them as separate columns
// (PLCMNT PTS vs PTS) and a total alone can't be decomposed back into them after the fact.
// Takes the scoring table explicitly so a league's PAST cups keep scoring under the table they
// were played on — Epic re-tunes the points between stages and seasons, and silently re-scoring
// week 1 with week 8's table would rewrite history every time the producer changes a preset.
function brPointsSplitWith(sc, placement, elims, multiplier) {
  sc = sc || {};
  const table = Array.isArray(sc.placementPoints) ? sc.placementPoints : [];
  const pl = Math.max(0, parseInt(placement, 10) || 0);
  let place = (pl >= 1 && pl <= table.length) ? (Number(table[pl - 1]) || 0) : 0;
  // Victory Royale bonus sits ON TOP of 1st-place points — several formats pay a flat bonus for
  // the win rather than folding it into the table, and the two are not interchangeable once a
  // tiebreak on placement points is involved.
  if (pl === 1) place += Number(sc.vrBonus) || 0;
  let k = Math.max(0, parseInt(elims, 10) || 0);
  if (sc.killCap > 0) k = Math.min(k, sc.killCap);
  let kill = k * (Number(sc.killPoints) || 0);
  // Per-match multiplier (a double-points final is common). Applied to BOTH halves, and rounded
  // once at the end so a x1.5 can't leak fractional points onto the board.
  const mult = Number(multiplier);
  if (mult > 0 && mult !== 1) { place = Math.round(place * mult); kill = Math.round(kill * mult); }
  return { place, kill, total: place + kill };
}
// Per-match weighting, e.g. a double-points final. Keyed by match number.
function brMultiplier(mults, match) {
  const m = (mults && typeof mults === 'object') ? Number(mults[String(match)]) : 0;
  return (m > 0) ? m : 1;
}
// The live series' own table — what the on-air board and the lobby panel score against.
function brPointsSplit(placement, elims, match) {
  return brPointsSplitWith(state.br.scoring, placement, elims, brMultiplier(state.br.matchMultipliers, match));
}
function brPointsFor(placement, elims, match) {
  return brPointsSplit(placement, elims, match).total;
}

// ── Lobby helpers ────────────────────────────────────────────────────────────
let _brUidC = 0;
function brUid() { return 'br' + (Date.now().toString(36)) + (++_brUidC).toString(36); }
// One shape for an entrant, applied on EVERY write path (manual add, start.gg pull, league send,
// state restore). Without this the panel has to defend against four different half-shapes.
function sanitizeBrEntrant(raw) {
  const e = raw && typeof raw === 'object' ? raw : {};
  const players = (Array.isArray(e.players) ? e.players : [])
    .slice(0, 8)
    .map((p) => {
      const o = (p && typeof p === 'object') ? p : { name: p };
      return { name: String(o.name || '').trim().slice(0, 60), epic: String(o.epic || '').trim().slice(0, 60) };
    })
    .filter((p) => p.name);
  return {
    id: String(e.id || '').trim() || brUid(),
    name: String(e.name || '').trim().slice(0, 80),
    seed: Math.max(0, parseInt(e.seed, 10) || 0),
    players,
    drop: String(e.drop || '').trim().slice(0, 40),   // POI id or free-text landing spot
    note: String(e.note || '').trim().slice(0, 80),
    out: !!e.out                                      // producer marked them eliminated this match
  };
}
// ── League-backed BR series ──────────────────────────────────────────────────
// A Fortnite circuit is many cups across a season (Week 1 Cup, Week 2 Cup, Major…), so the
// season store is the LEAGUE, and each cup is one entry in lg.brSeries. state.br.leagueId +
// seriesId bind the live board to one of those cups; while bound, state.br.results is a MIRROR
// of that cup and every write lands in the league. Unbound, state.br.results is standalone —
// which is what keeps the old sheet-fed Apex/PUBG path working exactly as before.
function brNewSeries(name, matches) {
  return {
    id: srvLgUid('brs'),
    name: String(name || 'Cup').slice(0, 60),
    date: '',
    matches: Math.max(1, Math.min(40, parseInt(matches, 10) || 6)),
    matrixId: state.br.matrixId || '',
    // Where this cup's results come in from. All three are peers — a producer might type week 1
    // by hand, pull week 2 off the scorekeeper's sheet, and take week 3 off a live game feed.
    source: 'manual',
    sheetTab: '',
    matchMultipliers: {},
    scoringPreset: state.br.scoringPreset || 'fncsFinals',
    // Snapshot the table, don't reference it — see brPointsSplitWith: a past cup must keep
    // scoring under the table it was played on.
    scoring: {
      placementPoints: (state.br.scoring.placementPoints || []).slice(),
      killPoints: state.br.scoring.killPoints,
      killCap: state.br.scoring.killCap,
      vrBonus: state.br.scoring.vrBonus || 0
    },
    results: []   // [{ match, team, placement, elims }] — same row shape as state.br.results
  };
}
function sanitizeBrSeries(s) {
  const o = (s && typeof s === 'object') ? s : {};
  const sc = (o.scoring && typeof o.scoring === 'object') ? o.scoring : {};
  return {
    id: String(o.id || '').trim() || srvLgUid('brs'),
    name: String(o.name || 'Cup').slice(0, 60),
    date: String(o.date || '').slice(0, 30),
    matches: Math.max(1, Math.min(40, parseInt(o.matches, 10) || 6)),
    scoringPreset: String(o.scoringPreset || 'fncsFinals').slice(0, 30),
    matrixId: String(o.matrixId || '').slice(0, 40),
    source: ['manual', 'sheets', 'live'].includes(o.source) ? o.source : 'manual',
    sheetTab: String(o.sheetTab || '').slice(0, 80),
    matchMultipliers: (function () {
      const src = (o.matchMultipliers && typeof o.matchMultipliers === 'object') ? o.matchMultipliers : {};
      const out = {};
      Object.keys(src).slice(0, 40).forEach((k) => {
        const n = Math.max(1, Math.min(40, parseInt(k, 10) || 0));
        const v = Number(src[k]);
        if (n && v > 0 && v !== 1) out[String(n)] = Math.round(v * 100) / 100;
      });
      return out;
    })(),
    scoring: {
      placementPoints: (Array.isArray(sc.placementPoints) ? sc.placementPoints : []).slice(0, 100).map((n) => Math.max(0, Math.round(Number(n) || 0))),
      killPoints: Math.max(0, Number(sc.killPoints) || 0),
      killCap: Math.max(0, parseInt(sc.killCap, 10) || 0),
      vrBonus: Math.max(0, Number(sc.vrBonus) || 0)
    },
    results: (Array.isArray(o.results) ? o.results : []).slice(0, 4000).map((r) => ({
      match: Math.max(1, parseInt(r && r.match, 10) || 1),
      team: String((r && r.team) || '').trim().slice(0, 80),
      placement: Math.max(0, parseInt(r && r.placement, 10) || 0),
      elims: Math.max(0, parseInt(r && r.elims, 10) || 0)
    })).filter((r) => r.team)
  };
}
// Resolve whichever cup a write is aimed at: an explicit { leagueId, seriesId } (the league
// page's grid, editing a cup that is NOT on air) or the live binding.
function brResolveSeries(leagueId, seriesId) {
  const lid = String(leagueId || state.br.leagueId || '');
  const sid = String(seriesId || state.br.seriesId || '');
  if (!lid || !sid) return null;
  const lg = (state.leagues || []).find((l) => l && l.id === lid);
  if (!lg) return null;
  const series = (lg.brSeries || []).find((s) => s && s.id === sid);
  return series ? { lg, series } : null;
}
function brBinding() { return brResolveSeries(state.br.leagueId, state.br.seriesId); }
// Pull the bound cup into the live board. Scoring comes with it, so switching cups mid-show
// switches the table too rather than scoring week 8 with week 1's numbers.
function brSyncFromLeague() {
  const b = brBinding();
  if (!b) return false;
  state.br.results = b.series.results.map((r) => ({ ...r }));
  state.br.scoringPreset = b.series.scoringPreset;
  state.br.scoring = {
    placementPoints: (b.series.scoring.placementPoints || []).slice(),
    killPoints: b.series.scoring.killPoints,
    killCap: b.series.scoring.killCap,
    vrBonus: b.series.scoring.vrBonus || 0
  };
  state.br.matrixId = b.series.matrixId || '';
  state.br.matchMultipliers = { ...(b.series.matchMultipliers || {}) };
  state.br.format.matches = b.series.matches;
  // The cup owns where results come from; 'league' alone told the producer nothing useful.
  state.br.source = b.series.source || 'manual';
  // A sheets-sourced cup re-points the Sheets sync at its OWN tab, so week 1 and week 2 can be
  // separate tabs of the same workbook and switching cups switches which one is read.
  if (b.series.source === 'sheets' && b.series.sheetTab && state.sheets && state.sheets.maps) {
    state.sheets.maps.brResults = { direction: 'import', tab: b.series.sheetTab };
  }
  return true;
}
// Season rollup, stored on the league as DERIVED data so the league page renders it without
// reimplementing the scorer (which is exactly how a second, subtly-different points engine gets
// born). Each cup scores under its own table, then the season totals them.
function recomputeBrSeason(lg) {
  if (!lg || !Array.isArray(lg.brSeries)) return;
  const byTeam = new Map();
  const perSeries = [];
  for (const s of lg.brSeries) {
    const cup = new Map();
    for (const r of (s.results || [])) {
      const name = String(r.team || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const sp = brPointsSplitWith(s.scoring, r.placement, r.elims, brMultiplier(s.matchMultipliers, r.match));
      for (const bag of [cup, byTeam]) {
        let t = bag.get(key);
        if (!t) { t = { name, pts: 0, placePts: 0, elimPts: 0, elims: 0, wins: 0, played: 0 }; bag.set(key, t); }
        t.pts += sp.total; t.placePts += sp.place; t.elimPts += sp.kill;
        t.elims += Math.max(0, parseInt(r.elims, 10) || 0);
        t.played++;
        if ((parseInt(r.placement, 10) || 0) === 1) t.wins++;
      }
    }
    const order = (a, b) => (b.pts - a.pts) || (b.wins - a.wins) || (b.elims - a.elims) || a.name.localeCompare(b.name);
    const rows = [...cup.values()].sort(order);
    perSeries.push({
      id: s.id, name: s.name, date: s.date, matches: s.matches,
      played: (s.results || []).reduce((m, r) => Math.max(m, parseInt(r.match, 10) || 0), 0),
      winner: (rows[0] && rows[0].name) || '',
      points: Object.fromEntries(rows.map((t) => [t.name.toLowerCase(), t.pts]))
    });
  }
  const order = (a, b) => (b.pts - a.pts) || (b.wins - a.wins) || (b.elims - a.elims) || a.name.localeCompare(b.name);
  const season = [...byTeam.values()].sort(order).map((t, i) => ({ rank: i + 1, ...t }));
  lg.brSeason = { standings: season, series: perSeries, updatedAt: Date.now() };

  // standingsMode 'points' makes the season table the league's REAL standings, so everything
  // already built on lg.standings — the Standings overlay's League source, the team-record line
  // on the HUDs, the overview KPIs — works off placement points with no further wiring. Without
  // this the season table would be an island the rest of the app can't see.
  if (lg.standingsMode !== 'points') return;
  const byName = new Map();
  (lg.teams || []).forEach((tm) => {
    const n = String((tm && tm.name) || '').trim().toLowerCase();
    if (n && tm.id) byName.set(n, tm.id);
  });
  const rows = [];
  for (const t of season) {
    const teamId = byName.get(String(t.name || '').trim().toLowerCase());
    if (!teamId) continue;   // a result for a team not on the roster stays out of the table
    // Reuse the existing row so hand-set fields the producer added survive a recompute.
    const prev = (lg.standings || []).find((s) => s && s.teamId === teamId) || {};
    rows.push({
      ...prev, teamId,
      pts: t.pts,
      // In a placement circuit "wins" is event victories; there is no opponent to have lost to,
      // so losses stay 0 rather than being invented from events played.
      w: t.wins, l: 0, t: 0,
      gf: t.elims, ga: 0,
      played: t.played
    });
  }
  // Teams with no results yet still belong in the table, at the bottom on 0.
  (lg.teams || []).forEach((tm) => {
    if (tm && tm.id && !rows.some((r) => r.teamId === tm.id)) {
      const prev = (lg.standings || []).find((s) => s && s.teamId === tm.id) || {};
      rows.push({ ...prev, teamId: tm.id, pts: 0, w: 0, l: 0, t: 0, gf: 0, ga: 0, played: 0 });
    }
  });
  lg.standings = rows;
  // A League-sourced Standings board follows this league live, so recording a tournament result
  // has to re-mirror it — otherwise the on-air board keeps showing the snapshot it was pushed
  // with. Same reason the schedule path calls this; it's a no-op unless that source is active.
  if (state.standings && state.standings.source === 'league' && state.standings.leagueId === lg.id) {
    refreshLeagueStandingsMirror();
  }
}

// Build an entrant name from its players when the source didn't give one — a duo of
// "PETERBOT" + "POLLO" reads as "PETERBOT + POLLO", which is exactly how the FNCS board shows it.
function brNameFromPlayers(players) {
  return (players || []).map((p) => (p && p.name) || '').filter(Boolean).join(' + ');
}
// Merge entrants into the lobby WITHOUT losing producer edits: an entrant already in the field
// (matched on name) keeps its drop POI, note and seed. Re-pulling the field after a roster change
// is therefore safe mid-show, which is the whole reason the pull button exists.
function brMergeLobby(incoming, { replace = false } = {}) {
  const existing = replace ? [] : (Array.isArray(state.br.lobby) ? state.br.lobby : []);
  const byName = new Map(existing.map((e) => [e.name.toLowerCase(), e]));
  let added = 0, updated = 0;
  for (const raw of (incoming || [])) {
    const ent = sanitizeBrEntrant(raw);
    if (!ent.name) continue;
    const prev = byName.get(ent.name.toLowerCase());
    if (prev) {
      prev.players = ent.players.length ? ent.players : prev.players;
      if (ent.seed) prev.seed = ent.seed;
      updated++;
    } else {
      byName.set(ent.name.toLowerCase(), ent);
      added++;
    }
  }
  state.br.lobby = [...byName.values()].slice(0, 200);
  return { added, updated, total: state.br.lobby.length };
}
// Derive standings / player board / last-match card from the raw results. Tiebreakers run in the
// order the formats themselves use: points, then match wins, then total elims, then best finish,
// then name - so two teams on equal points never swap places at random between renders.
function computeBrStandings() {
  const br = state.br;
  const rows = Array.isArray(br.results) ? br.results : [];
  const byTeam = new Map();
  let maxMatch = 0;
  const blank = (name) => ({ name, pts: 0, placePts: 0, elimPts: 0, elims: 0, wins: 0, best: null, played: 0, matches: {} });
  // Seed the board with the WHOLE lobby so a 25-duo field is on screen at 0 points before match 1
  // is even played — a board that only grows as results arrive is useless as a pre-show graphic.
  // Untouched when there's no lobby (sheet-fed Apex/PUBG series), so those boards behave as before.
  for (const e of (Array.isArray(br.lobby) ? br.lobby : [])) {
    const name = ((e && e.name) || '').toString().trim();
    if (name && !byTeam.has(name.toLowerCase())) byTeam.set(name.toLowerCase(), blank(name));
  }
  for (const r of rows) {
    const name = ((r && r.team) || '').toString().trim();
    if (!name) continue;
    const m = Math.max(0, parseInt(r.match, 10) || 0);
    if (m > maxMatch) maxMatch = m;
    let t = byTeam.get(name.toLowerCase());
    if (!t) { t = blank(name); byTeam.set(name.toLowerCase(), t); }
    const placement = Math.max(0, parseInt(r.placement, 10) || 0);
    const elims = Math.max(0, parseInt(r.elims, 10) || 0);
    const sp = brPointsSplit(placement, elims, m);
    t.pts += sp.total; t.placePts += sp.place; t.elimPts += sp.kill;
    t.elims += elims; t.played++;
    if (placement === 1) t.wins++;
    if (placement > 0 && (t.best === null || placement < t.best)) t.best = placement;
    t.matches[m] = { placement, elims, pts: sp.total, placePts: sp.place };
  }
  const order = (a, b) => (b.pts - a.pts) || (b.wins - a.wins) || (b.elims - a.elims)
    || ((a.best || 999) - (b.best || 999)) || a.name.localeCompare(b.name);
  // Standing BEFORE the latest match, so the board can show movement (up 2 / down 1) - the thing
  // that makes a BR leaderboard readable at a glance.
  const prev = [...byTeam.values()].map((t) => {
    let pts = 0, elims = 0, wins = 0, best = null;
    for (const [m, g] of Object.entries(t.matches)) {
      if (Number(m) >= maxMatch) continue;
      pts += g.pts; elims += g.elims; if (g.placement === 1) wins++;
      if (g.placement > 0 && (best === null || g.placement < best)) best = g.placement;
    }
    return { name: t.name, pts, elims, wins, best };
  }).sort(order);
  const prevRank = {}; prev.forEach((t, i) => { prevRank[t.name.toLowerCase()] = i + 1; });

  // Lobby metadata (players, seed, drop POI) keyed by entrant name, so an overlay can render the
  // two gamertags of a duo without every board reimplementing the lookup.
  const lobbyByName = new Map();
  for (const e of (Array.isArray(br.lobby) ? br.lobby : [])) {
    const n = ((e && e.name) || '').toString().trim().toLowerCase();
    if (n) lobbyByName.set(n, e);
  }
  br.standings = [...byTeam.values()].sort(order).map((t, i) => {
    const key = t.name.toLowerCase();
    const was = prevRank[key] || 0;
    const ent = lobbyByName.get(key) || null;
    return {
      rank: i + 1, name: t.name, pts: t.pts, elims: t.elims, wins: t.wins,
      // wins doubles as VRS (Victory RoyaleS) on the Fortnite board — same number, and splitting
      // placement points out lets that board show PLCMNT PTS next to the total.
      placePts: t.placePts, elimPts: t.elimPts,
      best: t.best, played: t.played,
      players: ent ? (ent.players || []).map((p) => p.name).filter(Boolean) : [],
      seed: ent ? (ent.seed || 0) : 0,
      drop: ent ? (ent.drop || '') : '',
      move: (was && t.played > 0) ? (was - (i + 1)) : 0,   // +ve = climbed
      matches: t.matches
    };
  });

  // Player elim leaderboard (kept separate: a solo event has no team rows at all).
  const byPlayer = new Map();
  for (const r of (Array.isArray(br.playerResults) ? br.playerResults : [])) {
    const name = ((r && r.player) || '').toString().trim();
    if (!name) continue;
    const key = name.toLowerCase();
    let pl = byPlayer.get(key);
    if (!pl) { pl = { name, team: (r.team || '').toString(), elims: 0, played: 0 }; byPlayer.set(key, pl); }
    pl.elims += Math.max(0, parseInt(r.elims, 10) || 0);
    pl.played++;
    if (!pl.team && r.team) pl.team = r.team.toString();
  }
  br.playerBoard = [...byPlayer.values()]
    .sort((a, b) => (b.elims - a.elims) || a.name.localeCompare(b.name))
    .map((pl, i) => ({ rank: i + 1, ...pl }));

  // Most recent match, as its own result card.
  if (maxMatch > 0) {
    const inMatch = rows.filter((r) => (parseInt(r.match, 10) || 0) === maxMatch)
      .map((r) => {
        const sp = brPointsSplit(r.placement, r.elims, maxMatch);
        const ent = lobbyByName.get((r.team || '').toString().trim().toLowerCase()) || null;
        return {
          team: (r.team || '').toString(),
          placement: Math.max(0, parseInt(r.placement, 10) || 0),
          elims: Math.max(0, parseInt(r.elims, 10) || 0),
          pts: sp.total, placePts: sp.place,
          players: ent ? (ent.players || []).map((p) => p.name).filter(Boolean) : []
        };
      })
      .sort((a, b) => (a.placement || 999) - (b.placement || 999));
    br.lastMatch = { match: maxMatch, results: inMatch, winner: (inMatch[0] && inMatch[0].placement === 1) ? inMatch[0].team : '' };
  } else {
    br.lastMatch = null;
  }
  br.lastUpdate = Date.now();
  // The ticker reads a prebuilt line list, so refresh it here rather than making every caller
  // remember to (results arrive from three different places).
  if (state.ticker && state.ticker.source === 'br') state.ticker.feed = brTickerFeed();
}
// Standings as ticker lines: "1. TEAM 84 (12 elims)". Capped so one long field can't turn the
// ticker into a five-minute loop.
function brTickerFeed() {
  return (state.br.standings || []).slice(0, 24).map((t) =>
    `${t.rank}. ${(t.name || '').toUpperCase()}  ${t.pts} PTS${t.elims ? ` (${t.elims} elims)` : ''}`);
}

// Fresh installs never run the restore path below, so seed the default table at load time; a
// saved series overwrites it during loadAppState().
brApplyScoringPreset('fncsFinals');

function buildLiveState() {
  const publicStartgg = { ...state.startgg, hasToken: !!startggApiToken };
  const publicChallonge = { ...state.challonge, hasKey: !!challongeApiKey };
  const publicChallengermode = { ...state.challengermode, hasKey: !!challengermodeRefreshKey };
  const publicNxgen = { ...state.nxgen, hasKey: !!nxgenApiKey };
  // Deliberately NOT a spread of state.liquipedia. The raw pulls (standings/rankings/squad/
  // tournament) are working data the server uses to fill a graphic on request — putting those
  // arrays on the live broadcast would ship them to every overlay on every tick, which is exactly
  // the payload bloat the LIVE/LIBRARY split exists to prevent. Overlays need none of it; the
  // panel needs the settings, the budget and a count of what is ready to apply.
  // Key itself never travels — only whether one is saved, and what KIND it is (a development
  // key expires every 24h, which is the answer to most "it worked yesterday" reports).
  const publicRiot = { ...state.riot, hasKey: !!riotApiKey, keyKind: riot.keyKind(riotApiKey) };
  const publicLiquipedia = {
    enabled: state.liquipedia.enabled,
    wiki: state.liquipedia.wiki,
    contact: state.liquipedia.contact,
    hasKey: !!liquipediaApiKey,
    budgetRemaining: state.liquipedia.budgetRemaining,
    budgetResetInMs: state.liquipedia.budgetResetInMs,
    lastFetchAt: state.liquipedia.lastFetchAt,
    lastError: state.liquipedia.lastError,
    attribution: state.liquipedia.attribution,
    counts: {
      standings: (state.liquipedia.standings || []).length,
      rankings: (state.liquipedia.rankings || []).length,
      squad: (state.liquipedia.squad || []).length,
      tournament: state.liquipedia.tournament ? 1 : 0
    }
  };
  const publicFaceit = { ...state.faceit, hasKey: !!faceitApiKey };
  const publicSheets = { ...state.sheets, hasKey: !!sheetsServiceAccount };
  const publicBedwars = { ...state.bedwars, hasToken: !!bedwarsToken };
  const publicBallchasing = { ...state.ballchasing, hasKey: !!ballchasingApiKey };
  // Every scene picker in the panel (moment mapping, RL cuts, countdown "then", flows, deck) reads
  // obs.availableScenes. With vMix in charge it lists vMix input titles instead, so the same pickers
  // map moments to vMix inputs. Server-side state.obs.availableScenes stays OBS's own list.
  // Same for currentScene, which every "on program" highlight reads (panel chips, Stream Deck keys).
  const _vm = switcherIsVmix();
  const publicObs = { ...state.obs, hasPassword: !!obsPassword, hasSlobsToken: !!slobsToken,
    availableScenes: _vm ? vmixSourceNames() : state.obs.availableScenes,
    currentScene: _vm ? switcherProgramName() : state.obs.currentScene };
  // Secrets never ride the broadcast: every overlay / remote WS client receives this payload, and
  // nothing client-side reads these fields.
  const { apiToken: _twTok, refreshToken: _twRef, webhookSecret: _twHook, ...publicTwitch } = state.twitch || {};
  publicTwitch.hasToken = !!_twTok;
  const { apiKey: _castKey, ...publicCasters } = state.casters || {};
  const publicDiscord = {
    connected: state.discord.connected,
    userId: state.discord.userId,
    username: state.discord.username,
    discriminator: state.discord.discriminator,
    globalName: state.discord.globalName,
    avatarUrl: state.discord.avatarUrl,
    lastError: state.discord.lastError || ''
  };
  // Effective side colours for the active mode — overlays read teams.x.color; the control
  // panel can still see each team's own colour via teams.x.ownColor.
  const eff = effectiveTeamColors();
  // Heavy / rarely-changing keys (bracket ≈ 0.9MB logos, replay ≈ 0.4MB thumbnails, leagues,
  // clips, the raw brand fallback…) are stripped by stripByTier() per BROADCAST_TIERS above and
  // re-sent only on change via libraryData(). Clients backfill from the last library snapshot.
  return stripByTier({
    ...state,
    teams: {
      blue:   { ...state.teams.blue,   color: eff.blue,   ownColor: state.teams.blue.color },
      orange: { ...state.teams.orange, color: eff.orange, ownColor: state.teams.orange.color }
    },
    colorMode: state.colorMode || 'team',
    cloudRole: currentCloudRole(),   // org-seat role (null = local/full access) — drives view-only UX
    startgg: publicStartgg,
    challonge: publicChallonge,
    challengermode: publicChallengermode,
    nxgen: publicNxgen,
    liquipedia: publicLiquipedia,
    riot: publicRiot,
    faceit: publicFaceit,
    sheets: publicSheets,
    bedwars: publicBedwars,   // token stripped; only hasToken travels
    lanHost: lanHost,        // for "point your Minecraft server here" style hints
    ballchasing: publicBallchasing,
    // Desk Show caster picks: the stored pick snapshots the team LOGO (so the badge survives a
    // rename/delete), but that snapshot is full-size base64 — 50KB+ riding in every single live
    // broadcast for an image no overlay draws (preshow.html renders the NAME only). Ship the name
    // live; the control panel's pick chip resolves the logo out of its own team library.
    preshow: (function () {
      const pre = state.preshow || {};
      if (!Array.isArray(pre.predictions) || !pre.predictions.some((p) => p && p.logo)) return pre;
      return { ...pre, predictions: pre.predictions.map((p) => (p && p.logo) ? { ...p, logo: '' } : p) };
    })(),
    activeEvent: state.activeEvent,
    // BR registries the panel and the drop-map overlay need to render their pickers. Static
    // tables (a few hundred bytes), so they ride live rather than needing a library round-trip —
    // and the POI set is resolved server-side so producer edits in gameConfigs win everywhere at
    // once instead of each surface reimplementing the override.
    brMeta: {
      lobbyGames: BR_LOBBY_GAMES,
      modes: brModesFor(state.br.game),
      formats: BR_TEAM_FORMATS,
      mode: brModeMeta(state.br.game, state.br.mode),
      // `poi` = the set for the mode currently being played (what the overlay draws).
      // `poiSets` = EVERY island for this game, so the POI editor can load one the producer
      // isn't currently playing (updating the Reload island mid-BR-series is normal prep work).
      poi: brPoiSet(state.br.game, state.br.mode),
      // Built-ins + the producer's own, already resolved — the panel renders one list and never
      // has to know which half a matrix came from.
      matrices: allMatrices(),
      // Does the live cup's snapshot still match the matrix it came from? Drives the
      // "matrix changed — re-apply?" prompt instead of silently re-scoring played matches.
      matrixDrift: matrixDiffersFromSnapshot(state.br.matrixId, state.br.scoring),
      poiSets: (function () {
        const out = {};
        Object.keys(BR_POI_SETS[state.br.game] || {}).forEach((k) => {
          out[k] = brPoiSet(state.br.game, k === 'reload' ? 'reload' : 'br-build');
        });
        return out;
      })()
    },
    obs: publicObs,
    twitch: publicTwitch,
    casters: publicCasters,
    discord: publicDiscord,
    // Cloud reachability + the state of every background poll. Tiny, and it is the only way the
    // panel can say "station auto-fill is paused because the backend is down" instead of the
    // producer discovering it when a caster never lands on the desk.
    cloudHealth: (typeof cloud.health === 'function') ? cloud.health() : null,
    cloudLoops: Array.from(_cloudLoops.values()).map((l) => ({ name: l.name, fails: l.fails, lastOkAt: l.lastOkAt, lastError: l.lastError, nextAt: l.nextAt })),
    pollFailures: pollFailures(),
    games: (function() {
      const out = {};
      const custom = state.customOverlayLayouts || {};
      Object.keys(GAMES).forEach((id) => {
        const extra = custom[id] || [];
        out[id] = extra.length ? { ...GAMES[id], themes: GAMES[id].themes.concat(extra) } : GAMES[id];
      });
      return out;
    })(),
    customOverlayLayouts: state.customOverlayLayouts || {},
    gameConfigs: state.gameConfigs || {},
    vetoPools: vetoData.mergedMapPools(state.gameConfigs),   // per-game map pools, built-in + active Game Config merged by id
    vetoMeta: vetoData.VETO_META,    // per-game terminology (map/stage, Ban/Strike)
    draftGames: draftData.draftGames(),   // games with a champion-draft format
    theme: state.themesByGame[state.activeGame] || migrateThemeId(state.activeGame, 'default'),
    themesByGame: state.themesByGame,   // every game's chosen layout, so a game can be set up before it goes on air
    activeOverlay: activeOverlayPath(state.activeGame),
    overlayLayout: resolveOverlayLayout(state.activeGame, state.themesByGame[state.activeGame]),
    presets: savedPresets.map((p) => ({ id: p.id, name: p.name, game: p.game })),
    facecams: savedFacecams,
    formattedTime: formatTime(state.game.time),
    teamRecords: resolveTeamRecords(),   // resolved season/league record line per side (tiny)
    leagueStandings: resolveLeagueStandings(),   // in-app league W/L+place per side — overlay fallback when no bracket
    flows: state.flows || [],
    flowVars: state.flowVars || {},
    flowFireLog: _flowFireLog,
    autoLog: _autoLog,   // unified automation timeline (What's Armed panel)
    showRoster: state.showRoster || [],
    background: state.background,
    overlays: overlayClientInfo(),   // live overlay browser-source count for the pre-flight checklist
    streamdeck: { connected: Array.from(bridgeClients || []).some((c) => c._client === 'streamdeck') },
    // Multichat source config for the panel — token itself is NEVER sent, only whether one is set.
    multichat: {
      kickChannel: state.multichat.kickChannel || '',
      discordChannelId: state.multichat.discordChannelId || '',
      hasDiscordToken: !!state.multichat.discordBotToken,
      kickConnected: !!(kickChat && kickChat.connected),
      discordConnected: !!(discordChat && discordChat.connected)
    },
    sceneConfig: buildSceneConfig()  // active preset config per scene, applied by SceneBase.applySceneConfig
  });
}

// Heavy blobs that change rarely → sent on connect, then re-sent only when they change.
//   savedTeams / brandKits: control-panel libraries (base64 logos, tens-to-hundreds of KB).
//   brand / banner / mainBanner: derived from the active brand kit (base64 sponsor + banner
//     images, ~1MB) and read by overlays too — both sides backfill these when a light broadcast
//     omits them. This keeps live broadcasts at a few hundred bytes instead of ~2.6MB.
// Merge profile data for one player into the registry (ignores empty fields).
let playerProfilesVer = 0;
// Bumped on every leagues/clips mutation so librarySig re-sends them without stringifying
// their base64 payloads per broadcast.
let leaguesVer = 0;
let clipsVer = 0;
let eventOpsVer = 0;   // bumped on Event Ops roster/seed mutations (library-tier re-send)
let questionsVer = 0;  // bumped on every Q&A queue mutation (library-tier re-send)
let cloudCompetitionsVer = 0;   // bumped when the website competition list changes (library-tier re-send)
// ── Custom overlays (Overlays ▸ Builder) ──
// Layouts live in data/custom-overlays.json (backend/custom-overlays.js), opened on first use because
// dataDir is only known once start() runs. The list rides the library tier; each overlay's updatedAt
// rides the live tier (customOverlayRevs) so an open custom.html source reloads its layout on save.
let customOverlaysVer = 0;
let _coStore = null;
function coStore() {
  if (!_coStore && dataDir) {
    _coStore = customOverlays.createStore(dataDir);
    _coStore.all().forEach((o) => { state.customOverlayRevs[o.id] = o.updatedAt; });
  }
  return _coStore;
}
let gameConfigsVer = 0;   // bumped when custom game content or its saved versions change (re-sends draftRosters + versions)
// My Events (saved tournaments + their full entrant rosters) is control-panel-only data — the
// seeding studio and Events page read it, no overlay ever does — but it sat in the LIVE tier, so
// 244KB of rosters rode along on EVERY broadcast to every OBS browser source. It's library-tier
// now; this counter is what tells librarySig() it moved. touchMyEvents() must be called by anything
// that mutates state.myEvents (the sig also folds in the entry count and latest sync stamp, so an
// add/remove/refresh still re-sends even if a future edit path forgets to call it).
let myEventsVer = 0;
function touchMyEvents() { myEventsVer++; }
function upsertPlayerProfile(gamerTag, patch) {
  const key = (gamerTag || '').trim().toLowerCase();
  if (!key || !patch) return;
  if (!state.playerProfiles) state.playerProfiles = {};
  const cur = state.playerProfiles[key] || { gamerTag };
  const next = { ...cur, gamerTag: cur.gamerTag || gamerTag };
  if (patch.startggSlug) next.startggSlug = String(patch.startggSlug).slice(0, 160);
  if (patch.startggPlayerId) next.startggPlayerId = String(patch.startggPlayerId).slice(0, 40);
  if (patch.twitch) next.twitch = String(patch.twitch).slice(0, 80);
  if (patch.twitter) next.twitter = String(patch.twitter).slice(0, 80);
  if (patch.country) next.country = String(patch.country).slice(0, 80);
  if (patch.countryCode) next.countryCode = String(patch.countryCode).slice(0, 4).toLowerCase();
  if (patch.image) next.image = String(patch.image).slice(0, 400);   // start.gg profile image URL
  if (patch.realName) next.realName = String(patch.realName).slice(0, 160); // start.gg display/legal name
  // Producer-verified tracker.gg account (platform + username) — start.gg rarely gives us the connected
  // account, so once someone corrects/confirms the handle we remember it here keyed on gamerTag and
  // prefill it on future events instead of falling back to the tournament gamerTag.
  if (patch.tracker && patch.tracker.username) {
    next.tracker = {
      platform: String(patch.tracker.platform || 'epic').slice(0, 20).toLowerCase(),
      username: String(patch.tracker.username).slice(0, 80)
    };
  }
  if (patch.sixmans) {
    const s = patch.sixmans;
    next.sixmans = {
      ...(cur.sixmans || {}),
      name: String(s.name || (cur.sixmans && cur.sixmans.name) || '').slice(0, 80),
      elo: (s.elo != null && !isNaN(s.elo)) ? Number(s.elo) : (cur.sixmans && cur.sixmans.elo) || null,
      rank: String(s.rank || (cur.sixmans && cur.sixmans.rank) || '').slice(0, 10),
      region: String(s.region || (cur.sixmans && cur.sixmans.region) || '').slice(0, 6),
      platform: String(s.platform || (cur.sixmans && cur.sixmans.platform) || '').slice(0, 10),
    };
  }
  next.updatedAt = Date.now();
  state.playerProfiles[key] = next;
  playerProfilesVer++;
  // Write-through to the persistent player DB so data survives state resets
  playerDb.upsert(gamerTag, { displayName: next.gamerTag, realName: next.realName || null, startggSlug: next.startggSlug || null, startggId: next.startggPlayerId || null, sixmans: next.sixmans || null, twitch: next.twitch || null, twitter: next.twitter || null, country: next.country || null, countryCode: next.countryCode || null, image: next.image || null });
}

function libraryData() {
  return {
    savedTeams,
    playerProfiles: state.playerProfiles || {},   // per-player start.gg + 6mans links
    brandKits: savedBrandKits,
    brandKitsVer,                                 // lets the client detect ANY brand-kit change cheaply
    // Active kit wins; with no kit, fall back to the producer's global accent colour
    // (Settings ▸ Appearance, set_global_accent) so that control actually reaches overlays.
    brand: activeBrand() || ((state.brand && state.brand.color) ? { color: state.brand.color, accent: state.brand.accent || null } : null),
    banner: bannerForBroadcast(),
    mainBanner: state.banner,
    bracket: state.bracket,   // manual bracket (embedded team logos) — backfilled by bracket overlay + panel
    replay: state.replay,     // replay-monitor thumbnails — backfilled by the replays page
    crew: state.crew || [],   // unified crew profiles (hosts/guests/casters/observers)
    leagues: state.leagues || [],   // league rosters/standings (base64 team logos) — control panel only
    clips: state.clips || null,     // clip/playlist library metadata — control panel only (live pushes go via clips_update)
    eventOps: state.eventOps || { rows: [], seeds: [] },   // Event Ops CSV roster + true seeds — control panel only
    myEvents: state.myEvents || [],   // saved tournaments + entrant rosters — seeding studio / Events page only
    questions: state.questions || { list: [], settings: {} },   // Q&A mailbag — control panel only
    questionSources: questionStore.SOURCES,   // source keys/labels/dots, so the panel picker never drifts from the store
    cloudCompetitions: state.cloudCompetitions || [],   // Nameless website competitions (Data source picker) — control panel only
    cloudEventsMeta: state.cloudEventsMeta || { createUrl: '' },
    customOverlays: coStore() ? coStore().summaries() : [],
    // Built-in + custom characters. Also sent on connect (staticData), but custom content changes
    // it at runtime, so it rides the library channel too (re-sent only when gameConfigsVer moves).
    draftRosters: draftData.mergedRosters(state.gameConfigs),
    gameConfigVersions: state.gameConfigVersions || {}   // saved custom-content versions — control panel only
  };
}
// Per-key library signatures. The library bundle runs 1.5-5MB (brand kits, player profiles,
// leagues, bracket, replay thumbnails), and it used to be all-or-nothing: ONE key changing
// re-sent EVERY key to EVERY client. The replay monitor's own program field ticks on its own,
// so a measured idle show was re-blasting the whole bundle to every browser source several
// times a minute — that is what made scenes (Desk Show especially) stutter. Clients already
// backfill library keys they don't receive (scene-base BACKFILL_KEYS / applyState in app.js)
// and new clients get the whole bundle from getFullState() on connect, so sending only the
// keys that actually changed is safe.
let _libKeySigs = {};
function _libKeySig(v) {
  try {
    // Collapse long strings to their length — never stringify the base64 itself (this runs
    // whenever the library changes, and one kit's logos alone are megabytes).
    const raw = JSON.stringify(v, (k, x) => (typeof x === 'string' && x.length > 200) ? ('len' + x.length) : x) || '';
    return raw.length + ':' + _imgHash(raw);
  } catch (e) {
    return 'nosig:' + Date.now();   // unserializable → treat as changed rather than skip it
  }
}
function libraryDelta() {
  const full = libraryData();
  const out = {};
  for (const k of Object.keys(full)) {
    const sig = _libKeySig(full[k]);
    if (_libKeySigs[k] === sig) continue;
    _libKeySigs[k] = sig;
    out[k] = full[k];
  }
  return out;
}
// Static config that never changes after startup → sent on connect only.
function staticData() {
  return { draftRosters: draftData.mergedRosters(state.gameConfigs) };   // per-game champion/hero rosters (id/name/portrait), built-in + active Game Config merged by id
}
// Cheap signature (no base64 stringify — only lengths/counts) to detect library changes between
// broadcasts. Captures team name/colour/logo/roster and brand name/colours/logo/sponsors/banners.
function librarySig() {
  const t = savedTeams.map((t) => {
    const logoFp = t.logo ? (t.logo.slice(20, 44) + ':' + t.logo.length) : '0';
    const pSig = (t.players || []).map(p => (p.name || '') + ':' + ((p.photo || p.image || '').slice(20, 44))).join(';');
    return t.name + ':' + (t.color || '') + ':' + logoFp + ':' + pSig;
  }).join(',');
  const b = savedBrandKits.map((k) => {
    const pkg = activePackage(k) || {};
    const sp = (pkg.sponsors || []).reduce((a, s) => a + ((s && s.logo || '').length) + ((s && s.name || '').length), 0);
    const bn = (pkg.bannerImages || []).reduce((a, img) => a + ((img || '').length), 0);
    const pl = (pkg.sponsors || []).map((s) => SPONSOR_SPOTS.filter((spot) => s.placements && s.placements[spot]).join('+')).join(',');
    return k.id + ':' + (k.name || '') + ':' + (k.color || '') + ':' + (k.accent || '') + ':' + (k.logo ? k.logo.length : 0)
      + ':' + (k.activePackageId || '') + ':' + ((k.packages || []).length)
      + ':' + (pkg.sponsors || []).length + ':' + sp + ':' + bn + ':' + pl;
  }).join(',');
  // …plus active-kit selection + banner toggle/images so brand/banner/mainBanner re-send when they change.
  const bn = (state.banner.images || []).reduce((a, i) => a + ((i || '').length), 0);
  // bracket + replay carry big base64 logos/thumbnails — sign their STRUCTURE + scalar fields but
  // collapse any long string to its length so we never stringify the base64 (this runs per-broadcast).
  const lite = (o) => { try { return JSON.stringify(o, (k, v) => (typeof v === 'string' && v.length > 200) ? ('len' + v.length) : v) || ''; } catch { return ''; } };
  const extra = '|ab:' + (state.activeBrandKitId || '') + '|bv:' + (state.banner.visible ? 1 : 0) + '|bi:' + bn
    + '|brk:' + lite(state.bracket) + '|rpl:' + lite(state.replay) + '|crew:' + (state.crew || []).length
    + '|pp:' + playerProfilesVer + '|bk:' + brandKitsVer + '|st:' + savedTeamsVer
    + '|lgv:' + leaguesVer + '|clv:' + clipsVer + '|eov:' + eventOpsVer + '|qv:' + questionsVer + '|ccv:' + cloudCompetitionsVer + '|cov:' + customOverlaysVer
    + '|gcv:' + gameConfigsVer
    // Belt AND braces: the explicit counter plus cheap content facts, so a missed touchMyEvents()
    // still can't strand the panel on a stale roster.
    + '|mev:' + myEventsVer + ':' + (state.myEvents || []).length
    + ':' + (state.myEvents || []).reduce((a, e) => a + ((e && e.lastSync) || 0), 0)
    // Global accent fallback lives in library brand now (stripped from live) — re-send on change.
    + '|gac:' + ((state.brand && state.brand.color) || '') + ':' + ((state.brand && state.brand.accent) || '')
  return savedTeams.length + '#' + t + '||' + savedBrandKits.length + '#' + b + extra;
}

// Full payload (live + static + library) — sent on connect and on request_state so a client
// starts with everything; later broadcasts stay light and the client backfills the rest.
function getFullState() {
  return { type: 'full_state', data: { ...buildLiveState(), ...staticData(), ...libraryData() } };
}

function extractEntrantPlayers(name) {
  if (!name) return [];
  return name
    .split(/\s*\/\s*|\s*&\s*|\s*,\s*/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 4);
}

// Normalize a pasted start.gg league reference into the bare slug the API wants.
// Accepts a full URL (https://www.start.gg/league/<slug>) or a "league/<slug>" / "<slug>" form.
function normalizeLeagueSlug(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/start\.gg\/league\/([^/?#]+)/i);
  if (m) return m[1];
  s = s.replace(/^https?:\/\/[^/]+\//i, '');   // strip any host
  s = s.replace(/^league\//i, '');             // strip a leading league/
  return s.split(/[/?#]/)[0];
}

// Fetch season standings (placement + league points) for a start.gg LEAGUE. Tries the bare
// slug first, then the "league/<slug>" form (start.gg accepts the latter for some leagues).
async function fetchLeagueStandings(rawSlug) {
  if (!startggApiToken) throw new Error('Missing Start.gg API token');
  const slug = normalizeLeagueSlug(rawSlug);
  if (!slug) throw new Error('Missing league slug');
  const client = createStartGgClient(startggApiToken);
  const query = `query LeagueStandings($slug:String!){
    league(slug:$slug){ id name
      standings(query:{page:1,perPage:200}){ nodes{ placement totalPoints entrant{ id name } } } } }`;
  let league = null;
  for (const candidate of [slug, 'league/' + slug]) {
    const res = await client.request(query, { slug: candidate });
    if (res && res.league) { league = res.league; break; }
  }
  if (!league) throw new Error('League not found (check the slug/URL)');
  const teams = ((league.standings && league.standings.nodes) || [])
    .filter((n) => n && n.entrant && n.entrant.name)
    .map((n) => ({ name: n.entrant.name, place: n.placement || null, points: (typeof n.totalPoints === 'number') ? n.totalPoints : null }))
    .sort((a, b) => (a.place || 9999) - (b.place || 9999));
  return { name: league.name || '', teams };
}

// ── start.gg league search + sync helpers ─────────────────────────────────

async function searchStartggLeagues(name) {
  if (!startggApiToken) throw new Error('Missing Start.gg API token');
  const client = createStartGgClient(startggApiToken);
  const data = await client.request(
    `query SearchLeagues($name:String){leagues(query:{filter:{name:$name},perPage:10}){nodes{id name slug}}}`,
    { name }
  );
  return ((data && data.leagues && data.leagues.nodes) || []).filter(Boolean);
}

// Lightweight league info: name + tournament list (no sets).
async function fetchLeagueInfo(rawSlug) {
  if (!startggApiToken) throw new Error('Missing Start.gg API token');
  const slug = normalizeLeagueSlug(rawSlug);
  if (!slug) throw new Error('Missing league slug');
  const client = createStartGgClient(startggApiToken);
  const query = `query LeagueInfo($slug:String!){
    league(slug:$slug){
      id name slug
      tournaments(query:{perPage:50,sortBy:"startAt asc"}){
        nodes{id name slug startAt numAttendees}
      }
    }
  }`;
  let league = null;
  for (const candidate of [slug, 'league/' + slug]) {
    try {
      const data = await client.request(query, { slug: candidate });
      if (data && data.league) { league = data.league; break; }
    } catch (_) {}
  }
  if (!league) throw new Error('League not found (check the slug/URL)');
  return {
    id: league.id,
    name: league.name || '',
    slug,
    tournaments: ((league.tournaments && league.tournaments.nodes) || []).filter(Boolean)
  };
}

// Fetch completed sets for a single tournament, used during league sync.
async function fetchTournamentSets(tournamentSlug) {
  if (!startggApiToken) throw new Error('Missing Start.gg API token');
  const client = createStartGgClient(startggApiToken);
  const data = await client.request(
    `query TournamentSets($slug:String!){
      tournament(slug:$slug){
        id name startAt
        events{
          id name
          sets(filters:{state:3},perPage:100){
            nodes{id displayScore winnerId fullRoundText slots{entrant{id name}}}
          }
        }
      }
    }`,
    { slug: tournamentSlug }
  );
  const t = data && data.tournament;
  if (!t) throw new Error('Tournament not found: ' + tournamentSlug);
  return { id: t.id, name: t.name || '', startAt: t.startAt || null, events: (t.events || []).filter(Boolean) };
}

// Highest schedule week where every match has a recorded result — used as the default "this week"
// for team-record weekW/weekL when the producer hasn't picked an explicit week.
function autoPickLatestCompletedWeek(lg) {
  const sched = (lg && lg.schedule) || [];
  const weeks = [...new Set(sched.map((m) => String(m.week || '')).filter(Boolean))];
  const completed = weeks.filter((wk) =>
    sched.filter((m) => String(m.week || '') === wk).every((m) => m.result && m.result.scoreA != null && m.result.scoreB != null));
  if (!completed.length) return '';
  completed.sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
  return completed[completed.length - 1];
}

// Resolve a schedule match's series score (games won per side) + real per-side totals — mirrors
// client-side lgMatchTally. When a per-game breakdown (m.games) is provided, the series score is
// derived by counting games won and totals are summed from the individual game scores; otherwise
// both come directly from the single result.scoreA/scoreB entry (the breakdown is optional).
function srvLgMatchTally(m) {
  const r = m.result || {};
  const hasGames = Array.isArray(m.games) && m.games.length > 0;
  if (hasGames) {
    let sa = 0, sb = 0, totA = 0, totB = 0;
    for (const g of m.games) {
      const ga = Number(g.scoreA) || 0, gb = Number(g.scoreB) || 0;
      totA += ga; totB += gb;
      if (ga > gb) sa++; else if (gb > ga) sb++;
    }
    return { sa, sb, totA, totB };
  }
  const sa = Number(r.scoreA) || 0, sb = Number(r.scoreB) || 0;
  return { sa, sb, totA: sa, totB: sb };
}

// Server-side standings recalc — mirrors client-side lgAggregateFromSchedule.
function lgRecalcServer(lg) {
  const sc = lg.scoring || {};
  const ptWin = sc.win ?? 3, ptLoss = sc.loss ?? 0, ptDraw = sc.draw ?? 1, ptOtw = sc.otw ?? ptWin;
  const map = {};
  (lg.teams || []).forEach(tm => { map[tm.id] = { teamId: tm.id, w: 0, l: 0, t: 0, gf: 0, ga: 0, pts: 0, subW: 0, subL: 0, form: [], h2h: {} }; });
  for (const m of (lg.schedule || [])) {
    const r = m.result;
    const hasGames = Array.isArray(m.games) && m.games.length > 0;
    if (!hasGames && (!r || r.scoreA == null || r.scoreB == null)) continue;
    const a = map[m.teamA], b = map[m.teamB]; if (!a || !b) continue;
    const { sa, sb, totA, totB } = srvLgMatchTally(m);
    a.gf += totA; a.ga += totB; b.gf += totB; b.ga += totA;
    a.subW += sa; a.subL += sb; b.subW += sb; b.subL += sa;
    const winPts = (r && r.ot) ? ptOtw : ptWin;
    if (sa > sb) {
      a.w++; a.pts += winPts; a.form.push('W'); a.h2h[m.teamB] = (a.h2h[m.teamB] || 0) + 1;
      b.l++; b.pts += ptLoss; b.form.push('L');
    } else if (sb > sa) {
      b.w++; b.pts += winPts; b.form.push('W'); b.h2h[m.teamA] = (b.h2h[m.teamA] || 0) + 1;
      a.l++; a.pts += ptLoss; a.form.push('L');
    } else {
      a.t++; a.pts += ptDraw; a.form.push('D');
      b.t++; b.pts += ptDraw; b.form.push('D');
    }
  }
  const calcStreak = (form) => {
    if (!form.length) return '';
    const last = form[form.length - 1]; let n = 0;
    for (let i = form.length - 1; i >= 0 && form[i] === last; i--) n++;
    return last + n;
  };
  const tb = lg.tiebreak || 'gd';
  const standings = Object.values(map).map((s) => ({
    teamId: s.teamId, w: s.w, l: s.l, t: s.t, gf: s.gf, ga: s.ga, pts: s.pts,
    subW: s.subW, subL: s.subL, form: s.form.slice(-5), streak: calcStreak(s.form), h2h: s.h2h
  }));
  standings.sort((a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    if (tb === 'h2h') {
      const ah = (a.h2h && a.h2h[b.teamId]) || 0, bh = (b.h2h && b.h2h[a.teamId]) || 0;
      if (ah !== bh) return bh - ah;
    }
    const gdDiff = ((b.gf - b.ga) - (a.gf - a.ga));
    if (gdDiff !== 0) return gdDiff;
    return b.gf - a.gf;
  });
  lg.standings = standings;
}

// ── Spectated-match capture (producer-armed) ─────────────────────────────────
// Append one finished game's score to the armed capture, mapping the live blue/orange scores onto
// the fixture's A/B orientation. Clinches → finalize automatically.
function lgCaptureAppendGame(blue, orange) {
  const cap = state.leagueCapture; if (!cap.active) return;
  const a = cap.aSide === 'orange' ? orange : blue;
  const b = cap.aSide === 'orange' ? blue : orange;
  cap.games.push({ scoreA: Number(a) || 0, scoreB: Number(b) || 0 });
  const sa = cap.games.filter((g) => g.scoreA > g.scoreB).length;
  const sb = cap.games.filter((g) => g.scoreB > g.scoreA).length;
  cap.lastNote = `Recording ${cap.teamA} vs ${cap.teamB}: ${sa}-${sb} (game ${cap.games.length})`;
  const need = Math.floor((cap.bestOf || 5) / 2) + 1;
  if (sa >= need || sb >= need) lgCaptureFinalize('series clinched');
  else siteReportCapture(cap.leagueId, cap.matchId, cap.games.slice(), false);
}
// Write the captured games + derived series score into the league fixture, recalc standings, disarm.
function lgCaptureFinalize(reason) {
  const cap = state.leagueCapture; if (!cap.active) return;
  const lg = (state.leagues || []).find((l) => l.id === cap.leagueId);
  const m = lg && (lg.schedule || []).find((x) => x.id === cap.matchId);
  if (lg && m && cap.games.length) {
    m.games = cap.games.map((g) => ({ scoreA: g.scoreA, scoreB: g.scoreB }));
    const sa = cap.games.filter((g) => g.scoreA > g.scoreB).length;
    const sb = cap.games.filter((g) => g.scoreB > g.scoreA).length;
    m.result = { scoreA: sa, scoreB: sb, ot: false };
    lgRecalcServer(lg);
    siteReportCapture(lg.id, m.id, cap.games.slice(), true);
    leaguesVer++;
    logAuto('league', `Captured ${cap.teamA} ${sa}-${sb} ${cap.teamB} into "${lg.name}" (${reason}).`);
  }
  state.leagueCapture = { active: false, leagueId: '', matchId: '', aSide: 'blue', teamA: '', teamB: '', bestOf: 5, games: [], startedAt: 0, lastNote: '' };
  refreshCompetitionFeed();
  saveAppState();
  broadcastFullState();
}

let _srvLgUidC = Date.now();
function srvLgUid(prefix) { return prefix + '-' + (++_srvLgUidC).toString(36); }

// Reject oversized base64 logos (league or per-team) rather than silently persisting/broadcasting
// them — leagues is a 'library' broadcast tier item re-sent on every leaguesVer bump, and giant
// embedded images here previously cost hundreds of KB per broadcast before tiering existed.
const LEAGUE_LOGO_MAX_BYTES = 500 * 1024;
function _capLogoField(obj, key) {
  const v = obj && obj[key];
  if (typeof v !== 'string' || !v.startsWith('data:')) return;
  const approxBytes = Math.floor(v.length * 0.75); // base64 payload is ~4/3 the decoded byte size
  if (approxBytes > LEAGUE_LOGO_MAX_BYTES) {
    obj[key] = null;
    obj._logoWarning = 'Logo removed — file was too large (' + Math.round(approxBytes / 1024) + 'KB, max ' + Math.round(LEAGUE_LOGO_MAX_BYTES / 1024) + 'KB).';
  }
}
function capLeagueLogo(lg) {
  _capLogoField(lg, 'logo');
  (lg.teams || []).forEach((tm) => _capLogoField(tm, 'logo'));
  return lg;
}

// Backfill defaults for fields added to the league shape over time, so every league object is
// fully-formed regardless of when/how it entered state (disk load, profile import, set_leagues).
// Idempotent — safe to call repeatedly on an already-migrated league.
function migrateLeague(lg) {
  if (!lg || typeof lg !== 'object') return lg;
  if (!lg.id) lg.id = srvLgUid('lg');
  if (!lg.status) lg.status = 'active';
  if (!lg.type) lg.type = 'team';
  lg.scoring = { win: 3, loss: 0, draw: 1, otw: 2, ...(lg.scoring && typeof lg.scoring === 'object' ? lg.scoring : {}) };
  if (!lg.tiebreak) lg.tiebreak = 'gd';
  if (typeof lg.starterCount !== 'number') lg.starterCount = 3;
  if (typeof lg.playoffN !== 'number') lg.playoffN = 4;
  if (typeof lg.abbr !== 'string') lg.abbr = '';
  if (!Array.isArray(lg.teams)) lg.teams = [];
  if (!Array.isArray(lg.freeAgents)) lg.freeAgents = [];
  if (!Array.isArray(lg.standings)) lg.standings = [];
  if (!Array.isArray(lg.schedule)) lg.schedule = [];
  if (!Array.isArray(lg.seasonHistory)) lg.seasonHistory = [];
  // Battle-royale cups. A Fortnite circuit is many cups across a season, so the league holds
  // them all and lg.brSeason is the derived rollup the league page renders (see
  // recomputeBrSeason — one scorer, never a second implementation on the client).
  // Season default matrix — a new cup in this league starts from it. Per-cup override wins.
  if (typeof lg.brMatrixId !== 'string') lg.brMatrixId = '';
  if (!Array.isArray(lg.brSeries)) lg.brSeries = [];
  lg.brSeries = lg.brSeries.slice(0, 60).map(sanitizeBrSeries);
  if (!lg.stats || typeof lg.stats !== 'object' || Array.isArray(lg.stats)) lg.stats = {};   // per-team in-game stats (Stats tab)
  // Ballchasing.com — Rocket League replay stats (Ballchasing tab). A SEPARATE sink from lg.stats
  // above: never overwrites the producer's manual entry. lg.ballchasing.groupId links this league
  // to one ballchasing.com group (created via the API — the producer never visits ballchasing.com).
  if (!lg.ballchasing || typeof lg.ballchasing !== 'object' || Array.isArray(lg.ballchasing)) {
    lg.ballchasing = { groupId: '', groupUrl: '', enabledAt: 0, playerLinks: [], pendingReplays: [], lastSyncedAt: null, lastRefreshNote: '' };
  }
  if (!Array.isArray(lg.ballchasing.playerLinks)) lg.ballchasing.playerLinks = [];
  if (!Array.isArray(lg.ballchasing.pendingReplays)) lg.ballchasing.pendingReplays = [];
  // MVP only exists per-replay (not on the group-cumulative endpoint), so counts are tracked here,
  // separately from ballchasingPlayers, since that object gets fully rebuilt on every refresh.
  if (!lg.ballchasing.mvpCounts || typeof lg.ballchasing.mvpCounts !== 'object' || Array.isArray(lg.ballchasing.mvpCounts)) lg.ballchasing.mvpCounts = {};
  if (!Array.isArray(lg.ballchasing.processedReplayIds)) lg.ballchasing.processedReplayIds = [];
  if (!lg.ballchasingStats || typeof lg.ballchasingStats !== 'object' || Array.isArray(lg.ballchasingStats)) lg.ballchasingStats = {};    // per-team, same shape as lg.stats
  if (!lg.ballchasingPlayers || typeof lg.ballchasingPlayers !== 'object' || Array.isArray(lg.ballchasingPlayers)) lg.ballchasingPlayers = {};  // per-player leaderboard, keyed "platform:id"
  // Website sync (opt-in, per league) — absent/empty means never pushed, zero cloud footprint.
  if (typeof lg.cloudLeagueId !== 'string') lg.cloudLeagueId = '';
  // Where this league's data comes from (Esports > league > Data source). Secrets (a feed's bearer
  // token) are NOT stored here — leagues reach every panel; they live in competitionFeedTokens.
  {
    const src = lg.source && typeof lg.source === 'object' && !Array.isArray(lg.source) ? lg.source : {};
    const tabs = src.tabs && typeof src.tabs === 'object' ? src.tabs : {};
    lg.source = {
      type: ['manual', 'sheet', 'feed', 'push', 'cloud'].includes(src.type) ? src.type : 'manual',
      sheetUrl: typeof src.sheetUrl === 'string' ? src.sheetUrl.slice(0, 500) : '',
      // 'cloud' = a tournament/league hosted on the Nameless website (its id there). Read-only here.
      cloudCompetitionId: typeof src.cloudCompetitionId === 'string' ? src.cloudCompetitionId.slice(0, 200) : '',
      tabs: {
        teams: typeof tabs.teams === 'string' ? tabs.teams.slice(0, 100) : 'Teams',
        matches: typeof tabs.matches === 'string' ? tabs.matches.slice(0, 100) : 'Matches',
        standings: typeof tabs.standings === 'string' ? tabs.standings.slice(0, 100) : '',
      },
      feedUrl: typeof src.feedUrl === 'string' ? src.feedUrl.slice(0, 1000) : '',
      intervalSec: Math.min(3600, Math.max(30, Number(src.intervalSec) || 60)),
      auto: src.auto !== false,
      prune: src.prune !== false,
    };
  }
  lg.teams.forEach((tm) => { if (tm && !tm.id) tm.id = srvLgUid('tm'); });
  lg.schedule.forEach((m) => { if (m && !Array.isArray(m.games)) m.games = []; });
  return capLeagueLogo(lg);
}

// ── League → standings board mirror ──────────────────────────────────────────
// The Standings graphic's "League" source used to be a one-shot snapshot: the panel built rows at
// push time and the board then showed frozen numbers, so OUR points went stale on air the moment a
// result was recorded. This recomputes state.standings.rows from the live league whenever the
// league data changes, exactly the way the panel builds them (buildLeagueStandingsRows), including
// resolving a team REFERENCE ({teamName}) against savedTeams for its name/logo.
function resolveLeagueTeam(tm) {
  const key = ((tm && (tm.teamName || tm.name)) || '').trim().toLowerCase();
  const saved = key ? savedTeams.find((s) => (s.name || '').trim().toLowerCase() === key) : null;
  if (saved) return { name: saved.name, logo: saved.logo || null };
  return { name: (tm && (tm.name || tm.teamName)) || 'Team', logo: (tm && tm.logo) || null };
}

function buildLeagueStandingsRows(leagueId) {
  const lg = leagueId && (state.leagues || []).find((l) => l.id === leagueId);
  if (!lg) return null;
  const byId = {};
  (lg.standings || []).forEach((s) => { if (s && s.teamId) byId[s.teamId] = s; });
  const teamsById = {};
  (lg.teams || []).forEach((t) => { if (t && t.id) teamsById[t.id] = t; });
  // Stored standings order wins (it respects a manual drag); otherwise sort by points.
  const ordered = (lg.standings && lg.standings.length)
    ? lg.standings.map((s) => teamsById[s.teamId]).filter(Boolean)
    : (lg.teams || []).slice().sort((a, b) => ((byId[b.id] || {}).pts || 0) - ((byId[a.id] || {}).pts || 0));
  // Divisions / conferences. The league model already carries them (lg.divisions + team.divisionId)
  // and the Leagues tab groups by them, but the mirror flattened everything into one table — so a
  // two-conference league could never be put on air as the two-column board every league broadcast
  // uses. Rank is per DIVISION when they exist (each conference counts 1..n), which is also what
  // makes the playoff cut mean anything.
  const divs = Array.isArray(lg.divisions) ? lg.divisions : [];
  const divName = (tm) => {
    const d = divs.find((x) => x && x.id && x.id === (tm && tm.divisionId));
    return d ? d.name : '';
  };
  const playoffN = Number(lg.playoffN) || 0;
  const seen = {};
  return ordered.map((tm, i) => {
    const s = byId[tm.id] || {};
    const r = resolveLeagueTeam(tm);
    const division = divs.length ? (divName(tm) || 'Unassigned') : '';
    // Placement counts within the division; with no divisions it is the flat table position.
    const rank = division ? (seen[division] = (seen[division] || 0) + 1) : i + 1;
    return {
      placement: rank, name: r.name, logo: r.logo,
      wins: s.w || 0, losses: s.l || 0, points: s.pts || 0,
      division,
      qualified: playoffN > 0 && rank <= playoffN,
    };
  });
}

/** Re-mirror the followed league into the standings board. No-op unless the League source is active. */
function refreshLeagueStandingsMirror() {
  if ((state.standings.source || '') !== 'league') return false;
  const rows = buildLeagueStandingsRows(state.standings.leagueId);
  if (!rows) return false;
  // division/qualified ride in the signature too — without them, moving a team between conferences
  // or changing the playoff cut would never reach the overlay.
  const key = (r) => [r.placement, r.name, r.wins, r.losses, r.points, r.division, r.qualified];
  const sig = JSON.stringify(rows.map(key));
  const prev = JSON.stringify((state.standings.rows || []).map(key));
  state.standings.rows = rows;
  return sig !== prev;
}

// ══ Live competition ═════════════════════════════════════════════════════════════════════════
// ONE league is "the live competition", and every competition scene follows it: the ticker (live /
// next / final), the schedule board, standings, starting-soon (upcoming.matches[0]) and the BRB
// "up next" strip. A league's data can come from anywhere — typed in, a Google Sheet, a league
// website's JSON feed, the local /api/v1 write API, CSV — and every source goes through
// backend/competition.js into the league, so the scenes never care where it came from.
// Spec for outside developers: docs/competition-api.md.
function normalizeCompetitionSettings(c) {
  const src = c && typeof c === 'object' ? c : {};
  const f = src.feeds && typeof src.feeds === 'object' ? src.feeds : {};
  const t = src.ticker && typeof src.ticker === 'object' ? src.ticker : {};
  return {
    leagueId: typeof src.leagueId === 'string' ? src.leagueId : '',
    feeds: { ticker: f.ticker !== false, schedule: f.schedule !== false, standings: f.standings !== false, brb: f.brb !== false },
    ticker: { live: t.live !== false, upcoming: t.upcoming !== false, results: t.results !== false, max: Math.min(30, Math.max(3, Number(t.max) || 12)) },
    showResultsOnSchedule: src.showResultsOnSchedule !== false,
  };
}
function competitionLeague() {
  const id = state.competition && state.competition.leagueId;
  return id ? ((state.leagues || []).find((l) => l.id === id) || null) : null;
}
function compResolveTeam(tm) {
  const key = ((tm && (tm.teamName || tm.name)) || '').trim().toLowerCase();
  const saved = key ? savedTeams.find((s) => (s.name || '').trim().toLowerCase() === key) : null;
  if (saved) return { name: saved.name, logo: saved.logo || null, linked: true };
  return { name: (tm && (tm.name || tm.teamName)) || 'Team', logo: (tm && tm.logo) || null, linked: false };
}
// A fixture is live when the producer armed it for capture — that IS the match on air.
function competitionLiveIds(lg) {
  const ids = new Set();
  const cap = state.leagueCapture;
  if (cap && cap.active && lg && cap.leagueId === lg.id && cap.matchId) ids.add(cap.matchId);
  return ids;
}
// Schedule-board rows (state.upcoming.matches shape) from the feed: live, then upcoming, then the
// latest results when the board keeps finished matches. `state` mirrors start.gg's 1/2/3 so
// schedule.html badges them the same way.
function competitionScheduleRows(feed) {
  if (!feed) return [];
  const keep = !!(state.competition && state.competition.showResultsOnSchedule) && !!state.upcoming.showResults;
  const row = (m, st) => ({
    id: m.id, round: m.round || '', teamA: m.teamA, teamB: m.teamB,
    teamALogo: (feed.logos && feed.logos[m.teamA]) || null, teamBLogo: (feed.logos && feed.logos[m.teamB]) || null,
    date: m.date || '', time: m.time || '', stream: !!m.stream, state: st, live: st === 2,
    scoreA: m.scoreA, scoreB: m.scoreB,
  });
  return [].concat(
    feed.live.map((m) => row(m, 2)),
    feed.upcoming.map((m) => row(m, 1)),
    keep ? feed.results.slice(0, 4).map((m) => row(m, 3)) : []
  ).slice(0, 12);
}
/** Rebuild state.compFeed from the live league and re-mirror the boards bound to it. */
function refreshCompetitionFeed() {
  if (!state.competition) state.competition = normalizeCompetitionSettings(null);
  const lg = competitionLeague();
  if (state.competition.leagueId && !lg) state.competition.leagueId = '';   // league deleted — unbind
  const before = JSON.stringify(state.compFeed || null);
  state.compFeed = lg ? competition.buildFeed(lg, { resolveTeam: compResolveTeam, liveIds: competitionLiveIds(lg) }) : null;
  if (lg && state.upcoming.source === 'league' && state.upcoming.leagueId === lg.id) {
    state.upcoming.matches = competitionScheduleRows(state.compFeed);
  }
  if (state.standings && state.standings.source === 'league') refreshLeagueStandingsMirror();
  return JSON.stringify(state.compFeed || null) !== before;
}
/** Make a league the live competition and point the chosen scenes at it. leagueId '' = off air. */
function competitionGoLive(leagueId) {
  const c = state.competition = normalizeCompetitionSettings(state.competition);
  const lg = leagueId ? (state.leagues || []).find((l) => l.id === leagueId) : null;
  c.leagueId = lg ? lg.id : '';
  if (lg) {
    if (c.feeds.schedule) {
      state.upcoming.source = 'league'; state.upcoming.leagueId = lg.id;
      // Title once, at go-live — never on refresh, or a producer's own title ("WEEK 11") is clobbered.
      state.upcoming.title = [lg.name, lg.season].filter(Boolean).join(' — ') || state.upcoming.title;
    }
    if (c.feeds.standings) {
      state.standings.source = 'league'; state.standings.leagueId = lg.id;
      state.standings.title = [lg.name, lg.season].filter(Boolean).join(' — ') || state.standings.title;
    }
    if (c.feeds.ticker) state.ticker.source = 'competition';
  } else {
    // Off air: release every board that was following a league so none keeps a stale competition.
    if (state.upcoming.source === 'league') { state.upcoming.source = 'event'; state.upcoming.leagueId = ''; state.upcoming.matches = []; }
    if (state.ticker.source === 'competition') state.ticker.source = 'manual';
  }
  refreshCompetitionFeed();
  return lg;
}

/** Validate a document from any source and merge it into a league. */
function applyCompetitionDoc(lg, raw, opts = {}) {
  const v = competition.validateDoc(raw);
  if (!v.doc) return { ok: false, errors: v.errors, warnings: v.warnings };
  const report = competition.applyDoc(lg, v.doc, { uid: srvLgUid, prune: !!opts.prune, protect: (m) => typeof siteReportHeld === 'function' && siteReportHeld(lg.id, m.id) });
  if (report.needsRecalc && (!lg.standingsMode || lg.standingsMode === 'schedule')) lgRecalcServer(lg);
  migrateLeague(lg);
  if (report.changed) {
    leaguesVer++;
    refreshCompetitionFeed();
    saveAppState();
    broadcastFullState();
  }
  return { ok: true, report, warnings: v.warnings };
}

// ── Pull sources (Google Sheet / JSON feed) ─────────────────────────────────
function compSyncStatus(lgId) {
  if (!state.compSync || typeof state.compSync !== 'object') state.compSync = {};
  if (!state.compSync[lgId]) state.compSync[lgId] = { running: false, lastSyncAt: 0, lastOkAt: 0, lastError: '', warnings: [], summary: '', fails: 0 };
  return state.compSync[lgId];
}
const _compEtags = {};   // leagueId -> ETag of the last feed body applied (server-only)
// ── Nameless website competitions (source.type === 'cloud') ──
// The website hosts its own tournaments and leagues and is the source of truth for them: the
// app reads the ne-competition document through the signed-in cloud session (same Bearer +
// org scope as the org-library pull) and never writes back. Fetches are ETag-gated here and
// rev-gated by pullOrgCompetitions below, so an unchanged competition costs one list call a minute.
const CLOUD_COMP_SIGNIN = 'Sign in to the Nameless website again (Settings > Profile) to keep syncing this league.';
// The person-scoped routes (/api/broadcast/competitions) are the current contract. A website that
// predates them answers the LIST with 404; from then on (until restart) the org-scoped routes are used.
let _compRoutesLegacy = false;
function cloudGetCompetition(id, etag) {
  return _compRoutesLegacy ? cloud.getOrgCompetition(id, { orgId: cloudOrgId(), etag }) : cloud.getMyCompetition(id, { etag });
}
async function cloudListCompetitions() {
  if (!_compRoutesLegacy) {
    try { return await cloud.listMyCompetitions(); }
    catch (e) { if (!(e && e.status === 404)) throw e; _compRoutesLegacy = true; }
  }
  const orgId = cloudOrgId();
  if (!orgId) return { competitions: [], createUrl: '' };
  return { competitions: await cloud.listOrgCompetitions(orgId), createUrl: '' };
}
function cloudOrgId() {
  if (!cloud.authed()) return '';
  const s = cloud.getSession() || {};
  const id = s.workspaceId;
  return (!id || String(id).startsWith('user:')) ? '' : String(id);
}
// Turn a cloud-client error into the sentence the Data source tab shows. 401/403 = the session
// is dead (the website answered, so the breaker stays closed) — only a fresh sign-in fixes it.
function cloudCompError(e) {
  const st = e && e.status;
  if (st === 401 || st === 403) return new Error(CLOUD_COMP_SIGNIN);
  if (st === 404) return new Error('This competition is no longer on the Nameless website.');
  return new Error('The Nameless website answered: ' + ((e && e.message) || 'request failed'));
}
async function readLeagueSource(lg) {
  const s = lg.source || {};
  if (s.type === 'cloud') {
    if (!s.cloudCompetitionId) throw new Error('Pick a competition from the Nameless website first.');
    if (!cloud.authed()) throw new Error(CLOUD_COMP_SIGNIN);
    let out;
    try { out = await cloudGetCompetition(s.cloudCompetitionId, _compEtags[lg.id] || ''); }
    catch (e) { throw cloudCompError(e); }
    if (out.notModified) return { notModified: true };
    // The website owns this league outright: fixtures it no longer lists are removed, like a feed.
    return { raw: out.doc, warnings: [], prune: true, etag: out.etag };
  }
  if (s.type === 'sheet') {
    let sa = null;
    if (sheetsServiceAccount) { try { sa = sheets.parseServiceAccount(sheetsServiceAccount); } catch (_) { sa = null; } }
    const out = await competitionSources.readSheet({ sheetUrl: s.sheetUrl, tabs: s.tabs || {}, sheets, sa });
    return { raw: out.doc, warnings: out.warnings, prune: !!out.tabsRead.matches };
  }
  if (s.type === 'feed') {
    if (!s.feedUrl) throw new Error('Add the feed URL first.');
    const out = await competitionSources.readFeed({ url: s.feedUrl, token: competitionFeedTokens[lg.id] || '', etag: _compEtags[lg.id] || '' });
    if (out.notModified) return { notModified: true };
    return { raw: out.raw, warnings: [], prune: s.prune !== false, etag: out.etag };
  }
  if (s.type === 'push') throw new Error('This league is fed by the API — there is nothing to pull.');
  throw new Error('This league is entered by hand — there is nothing to sync.');
}
function describeSyncReport(r) {
  const bits = [];
  if (r.teamsCreated && r.teamsCreated.length) bits.push(r.teamsCreated.length + ' new team' + (r.teamsCreated.length === 1 ? '' : 's'));
  if (r.matchesAdded) bits.push(r.matchesAdded + ' match' + (r.matchesAdded === 1 ? '' : 'es') + ' added');
  if (r.matchesUpdated) bits.push(r.matchesUpdated + ' updated');
  if (r.matchesRemoved) bits.push(r.matchesRemoved + ' removed');
  if (r.standingsRows) bits.push(r.standingsRows + ' standings rows');
  return bits.length ? bits.join(', ') : 'Already up to date';
}
async function syncLeagueSource(lgId, { dryRun = false } = {}) {
  const lg = (state.leagues || []).find((l) => l.id === lgId);
  if (!lg) return { ok: false, error: 'League not found.' };
  const st = compSyncStatus(lg.id);
  if (st.running && !dryRun) return { ok: false, error: 'A sync is already running.' };
  if (!dryRun) { st.running = true; broadcastFullState(); }
  try {
    const got = await readLeagueSource(lg);
    if (got.notModified) {
      if (!dryRun) { st.lastSyncAt = st.lastOkAt = Date.now(); st.lastError = ''; st.fails = 0; st.summary = 'Already up to date'; }
      return { ok: true, summary: 'Already up to date' };
    }
    if (dryRun) {
      const v = competition.validateDoc(got.raw);
      if (!v.doc) return { ok: false, error: v.errors.join(' '), warnings: (got.warnings || []).concat(v.warnings) };
      const trial = JSON.parse(JSON.stringify(lg));
      const r = competition.applyDoc(trial, v.doc, { uid: srvLgUid, prune: got.prune });
      return { ok: true, preview: true, counts: { teams: v.doc.teams.length, matches: v.doc.matches.length, standings: v.doc.standings ? v.doc.standings.length : 0 },
        summary: describeSyncReport(r), warnings: (got.warnings || []).concat(v.warnings).slice(0, 20) };
    }
    const out = applyCompetitionDoc(lg, got.raw, { prune: got.prune });
    if (!out.ok) throw new Error(out.errors.join(' '));
    if (got.etag) _compEtags[lg.id] = got.etag;
    st.lastSyncAt = st.lastOkAt = Date.now(); st.lastError = ''; st.fails = 0;
    st.summary = describeSyncReport(out.report);
    st.warnings = (got.warnings || []).concat(out.warnings || []).slice(0, 20);
    return { ok: true, summary: st.summary, warnings: st.warnings };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (!dryRun) { st.lastSyncAt = Date.now(); st.lastError = msg; st.fails++; }
    return { ok: false, error: msg };
  } finally {
    if (!dryRun) { st.running = false; broadcastFullState(); }
  }
}
// One self-rescheduling tick (never setInterval a network call — see cloud-loop-backoff). Each
// league keeps its own schedule and its own backoff, so one broken sheet can't slow the rest.
function startCompetitionSyncLoop() {
  const TICK = 10000;
  const tick = async () => {
    try {
      const now = Date.now();
      for (const lg of (state.leagues || [])) {
        const s = lg && lg.source;
        // 'cloud' leagues are NOT on this timer: pullOrgCompetitions syncs them when the website's rev moves.
        if (!s || (s.type !== 'sheet' && s.type !== 'feed') || s.auto === false) continue;
        if (s.type === 'sheet' && !s.sheetUrl) continue;
        if (s.type === 'feed' && !s.feedUrl) continue;
        const st = compSyncStatus(lg.id);
        const every = Math.max(30, Number(s.intervalSec) || 60) * 1000;
        const wait = st.fails ? Math.min(every * Math.pow(2, Math.min(st.fails, 5)), 15 * 60 * 1000) : every;
        if (st.running || (st.lastSyncAt && now - st.lastSyncAt < wait)) continue;
        await syncLeagueSource(lg.id);
      }
    } catch (e) {
      console.warn('[competition] sync tick failed:', (e && e.message) || e);
    } finally {
      setTimeout(tick, TICK);
    }
  };
  setTimeout(tick, 5000);
}

// ── Website competition list → linked 'cloud' leagues ──────────────────────────────────────
// One cheap list call a minute (ids + rev + live flag, no fixtures) drives everything for leagues
// whose source is the Nameless website: the picker list (state.cloudCompetitions, library tier),
// a document sync only for a league whose rev moved, and "put it on air" when the website flags a
// linked competition live and nothing is on air here. Runs under cloudLoop (breaker + backoff —
// never setInterval a cloud call). Separate from the per-league timer above on purpose: polling N
// documents every interval is exactly the per-desk traffic the rev-gated org-library pull removed.
const _compCloudRevs = {};        // leagueId -> rev key applied by the last successful sync
const _compCloudLiveArmed = {};   // leagueId -> rev key at which the website's live flag put it on air
function httpUrlOnly(v, max) { const s = String(v || ''); return /^https?:\/\//i.test(s) ? s.slice(0, max) : ''; }
function cloudCompetitionsSig(list) {
  return (list || []).map((c) => [c.id, c.kind, c.name, c.season, c.game, c.rev, c.updatedAt, c.live ? 1 : 0, c.status, c.logo, c.teams, c.nextMatchAt, c.role].join(':')).join('|');
}
async function pullOrgCompetitions() {
  const linked = (state.leagues || []).filter((l) => l && l.source && l.source.type === 'cloud' && l.source.cloudCompetitionId);
  if (!cloud.authed()) {
    // Signed out / session expired / no org: empty the picker and tell every linked league why — once.
    let touched = false;
    if (state.cloudEventsMeta && state.cloudEventsMeta.signedIn !== false) { state.cloudEventsMeta.signedIn = false; state.cloudEventsMeta.loaded = true; cloudCompetitionsVer++; touched = true; }
    if ((state.cloudCompetitions || []).length) { state.cloudCompetitions = []; cloudCompetitionsVer++; touched = true; }
    if (cloud.configured()) {
      linked.forEach((lg) => { const st = compSyncStatus(lg.id); if (st.lastError !== CLOUD_COMP_SIGNIN) { st.lastError = CLOUD_COMP_SIGNIN; st.lastSyncAt = Date.now(); touched = true; } });
    }
    if (touched) broadcastFullState();
    return { skipped: 'signed-out' };
  }
  if (state.cloudEventsMeta.signedIn !== true || !state.cloudEventsMeta.loaded) { state.cloudEventsMeta.signedIn = true; state.cloudEventsMeta.loaded = true; cloudCompetitionsVer++; }
  let list;
  try { const got = await cloudListCompetitions(); list = got.competitions; if (state.cloudEventsMeta.error) { state.cloudEventsMeta.error = ''; cloudCompetitionsVer++; } if (got.createUrl && state.cloudEventsMeta.createUrl !== got.createUrl) { state.cloudEventsMeta.createUrl = String(got.createUrl).slice(0, 500); cloudCompetitionsVer++; } }
  catch (e) {
    const err = cloudCompError(e);
    let touched = false;
    // The panel showed "No events yet" for a list that simply failed to load: say why instead.
    if (state.cloudEventsMeta.error !== err.message) { state.cloudEventsMeta.error = String(err.message || 'request failed').slice(0, 200); cloudCompetitionsVer++; touched = true; }
    linked.forEach((lg) => { const st = compSyncStatus(lg.id); if (st.lastError !== err.message) { st.lastError = err.message; st.lastSyncAt = Date.now(); touched = true; } });
    if (touched) broadcastFullState();
    throw err;   // cloudLoop backs this loop off on its own
  }
  const clean = (list || []).filter((c) => c && c.id != null).slice(0, 500).map((c) => ({
    id: String(c.id).slice(0, 200),
    kind: c.kind === 'tournament' ? 'tournament' : 'league',
    name: String(c.name || '').slice(0, 120),
    season: String(c.season || '').slice(0, 60),
    game: String(c.game || '').slice(0, 40),
    rev: c.rev == null ? null : c.rev,
    updatedAt: c.updatedAt || null,
    live: !!c.live,
    // Display-only extras from the person-scoped list (absent on the older org route).
    status: String(c.status || '').slice(0, 20),
    logo: httpUrlOnly(c.logo, 1000),
    url: httpUrlOnly(c.url, 500),
    consoleUrl: httpUrlOnly(c.consoleUrl, 500),
    role: String(c.role || '').slice(0, 20),
    host: String(c.host || '').slice(0, 80),
    teams: Number(c.teams) || 0,
    startsAt: Number(c.startsAt) || null,
    nextMatchAt: Number(c.nextMatchAt) || null,
    canReport: !!c.canReport,
  }));
  if (cloudCompetitionsSig(clean) !== cloudCompetitionsSig(state.cloudCompetitions)) {
    state.cloudCompetitions = clean;
    cloudCompetitionsVer++;
    broadcastFullState();
  }
  const byId = new Map(clean.map((c) => [c.id, c]));
  let synced = 0;
  for (const lg of linked) {
    const s = lg.source;
    const st = compSyncStatus(lg.id);
    const c = byId.get(String(s.cloudCompetitionId));
    if (!c) {
      const msg = 'This competition is no longer on the Nameless website.';
      if (st.lastError !== msg) { st.lastError = msg; st.lastSyncAt = Date.now(); broadcastFullState(); }
      continue;
    }
    if (s.auto === false || st.running) continue;
    // rev is the website's change counter (the contract requires it); updatedAt is the fallback.
    // With neither we still sync each tick (the ETag makes that cheap) but never auto go-live —
    // there is no way to tell "the website flagged it live again" from "still flagged".
    const revKey = c.rev != null ? 'r' + c.rev : (c.updatedAt ? 'u' + c.updatedAt : '');
    const now = Date.now();
    if (!revKey || _compCloudRevs[lg.id] !== revKey) {
      // Same backoff shape as the per-league timer, so one broken competition can't hammer the website.
      const wait = st.fails ? Math.min(60000 * Math.pow(2, Math.min(st.fails, 5)), 15 * 60 * 1000) : 0;
      if (st.fails && st.lastSyncAt && now - st.lastSyncAt < wait) continue;
      const r = await syncLeagueSource(lg.id);
      if (!r.ok) continue;
      synced++;
      if (revKey) _compCloudRevs[lg.id] = revKey;
    }
    siteEventFollow(lg);
    // The website says this one is live and nothing is on air here → put it on air, once per rev.
    // A producer who takes it off air stays in charge until the website's rev moves again.
    const onAir = state.competition && state.competition.leagueId;
    if (revKey && c.live && !onAir && _compCloudLiveArmed[lg.id] !== revKey) {
      _compCloudLiveArmed[lg.id] = revKey;
      competitionGoLive(lg.id);
      saveAppState();
      broadcastFullState();
      console.log(`[competition] "${lg.name}" put on air by the Nameless website`);
    }
  }
  return { competitions: clean.length, linked: linked.length, synced };
}
cloudLoop('org-competitions', () => pullOrgCompetitions(), 60000, { startAfterMs: 10000 });

// ── Website events: load one like a start.gg event, follow its live match, report scores ──
// The website (league + tournament creation) is the source of truth. Loading an event mirrors it
// into a read-only league (source.type 'cloud', synced by pullOrgCompetitions), copies its teams and
// rosters into the team library, puts it on air (ticker, schedule, standings, BRB) and, with
// auto-follow on, loads whichever match the website marks live onto the scoreboard. The series the
// desk records is reported back so the website's bracket and standings move on their own.
function siteEventState() {
  const d = { id: '', leagueId: '', autoFollow: true, autoReport: true, matchId: '', lastReport: '', lastReportOk: true };
  if (!state.siteEvent || typeof state.siteEvent !== 'object') state.siteEvent = d;
  for (const k of Object.keys(d)) if (state.siteEvent[k] === undefined) state.siteEvent[k] = d[k];
  return state.siteEvent;
}
function wsSend(ws, type, data) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, data })); } catch (_) {} }
function siteEventLeague() {
  const se = siteEventState();
  return se.leagueId ? ((state.leagues || []).find((l) => l.id === se.leagueId) || null) : null;
}
function siteTeamName(t) { return String((t && (t.teamName || t.name)) || '').trim(); }
// Website rosters into the team library. Teams the website owns (siteId) take its roster and crest;
// a same-named team the producer built by hand only has its gaps filled.
function mergeSiteTeamsIntoLibrary(lg) {
  let changed = 0;
  for (const t of (lg.teams || [])) {
    const name = siteTeamName(t);
    if (!name) continue;
    const players = (t.players || []).map((p) => ({ name: p.name, role: p.role || '', image: p.photo || '', country: p.country || '' }));
    let saved = (t.extId && savedTeams.find((s) => s.siteId === t.extId)) || savedTeams.find((s) => (s.name || '').toLowerCase() === name.toLowerCase());
    if (!saved) {
      savedTeams.push({ name, logo: t.logo || null, abbr: t.abbr || '', players, siteId: t.extId || '' });
      changed++;
      continue;
    }
    const own = !!(saved.siteId && saved.siteId === t.extId);
    if (!saved.siteId && t.extId) { saved.siteId = t.extId; changed++; }
    if (t.logo && (own || !saved.logo) && saved.logo !== t.logo) { saved.logo = t.logo; changed++; }
    if (players.length && (own || !(saved.players || []).length) && JSON.stringify(saved.players) !== JSON.stringify(players)) { saved.players = players; changed++; }
  }
  if (changed) saveTeams();
  return changed;
}
function siteAdoptGame(game) {
  const g = String(game || '').trim();
  if (!g) return;
  if (GAMES[g]) { if (state.activeGame !== g) applyActiveGame(g); return; }
  adoptEventGame(g.replace(/[-_]+/g, ' '));
}
async function loadSiteEvent(compId, { goLive = true } = {}) {
  if (!cloud.authed()) throw new Error('Sign in to the Nameless website first (Settings > Profile).');
  const id = String(compId || '').slice(0, 200);
  if (!id) throw new Error('Pick an event.');
  const c = (state.cloudCompetitions || []).find((x) => x.id === id) || { id, name: '', season: '', game: '', kind: 'league' };
  let lg = (state.leagues || []).find((l) => l && l.source && l.source.type === 'cloud' && l.source.cloudCompetitionId === id);
  if (!lg) {
    lg = migrateLeague({ id: srvLgUid('lg'), name: c.name || 'Website event', season: c.season || '', game: c.game || '',
      source: { type: 'cloud', cloudCompetitionId: id, intervalSec: 60, auto: true } });
    state.leagues.push(lg);
    leaguesVer++;
  }
  delete _compEtags[lg.id];   // a load is always a full fetch
  const r = await syncLeagueSource(lg.id);
  if (!r.ok) throw new Error(r.error || 'The website did not answer.');
  if (c.rev != null) _compCloudRevs[lg.id] = 'r' + c.rev;
  mergeSiteTeamsIntoLibrary(lg);
  const se = siteEventState();
  se.id = id; se.leagueId = lg.id;
  if (goLive) competitionGoLive(lg.id);
  state.activeEvent = {
    platform: 'nameless', slug: id, name: c.name || lg.name, gameName: (GAMES[c.game] && GAMES[c.game].name) || c.game || '',
    numEntrants: (lg.teams || []).length, format: c.kind === 'tournament' ? 'Tournament' : 'League',
    url: c.url || '', logo: c.logo || '', loadedAt: new Date().toISOString(),
  };
  adoptEventName('site:' + id, c.name || lg.name);
  setActivePlatform('nameless');
  siteAdoptGame(c.game || lg.game);
  siteEventFollow(lg);
  saveAppState();
  broadcastFullState();
  return { ok: true, leagueId: lg.id, summary: r.summary, teams: (lg.teams || []).length, matches: (lg.schedule || []).length };
}
// Put one of the event's matches on the scoreboard: teams, logos, rosters, round, best-of, and the
// series armed to record into that fixture (which is what reports it back to the website).
function putSiteMatchOnAir(matchId) {
  const lg = siteEventLeague();
  if (!lg) throw new Error('Load a website event first.');
  const m = (lg.schedule || []).find((x) => x.id === matchId || (x.extId && x.extId === matchId));
  if (!m) throw new Error('That match is no longer in the event.');
  const se = siteEventState();
  const isNew = se.matchId !== m.id;
  if (isNew) finalizeAndResetSeries();
  const byId = (tid) => (lg.teams || []).find((t) => t.id === tid) || null;
  const ta = byId(m.teamA), tb = byId(m.teamB);
  [['blue', ta], ['orange', tb]].forEach(([side, t]) => {
    const name = siteTeamName(t) || 'TBD';
    const T = state.teams[side];
    T.name = name.toUpperCase();
    T.nameRaw = name;
    T.seed = 0; T.entrantId = ''; T.org = '';
    T.logo = (t && t.logo) || logoForTeamName(name) || '';
    T.abbr = cleanTeamAbbr((t && t.abbr) || '') || abbrForTeamName(name);
    T.players = ((t && t.players) || []).map((p) => ({
      id: p.id || Math.random().toString(36).slice(2, 11), name: p.name, platform: 'nameless', platformId: p.extId || '',
      assignedCamera: null, country: p.country || '', countryCode: '', prefix: '', realName: '', twitter: '', twitch: '', image: p.photo || '',
    }));
  });
  rebuildCombinedPlayers();
  if (m.round || m.week) state.roundLabel = String(m.round || ('Week ' + m.week)).toUpperCase();
  else if (isNew) state.roundLabel = '';
  const bo = Number(String(m.format || '').replace(/\D/g, '')) || 0;
  if (bo) state.bestOf = Math.max(1, Math.min(9, bo));
  if (isNew || !(state.leagueCapture && state.leagueCapture.active && state.leagueCapture.matchId === m.id)) {
    state.leagueCapture = {
      active: true, leagueId: lg.id, matchId: m.id, aSide: 'blue',
      teamA: siteTeamName(ta) || 'Team A', teamB: siteTeamName(tb) || 'Team B', bestOf: state.bestOf || bo || 5,
      games: [], startedAt: Date.now(),
      lastNote: 'Recording ' + (siteTeamName(ta) || 'Team A') + ' vs ' + (siteTeamName(tb) || 'Team B') + '. Scores go to the website as each game ends.',
    };
  }
  se.matchId = m.id;
  refreshCompetitionFeed();
  saveAppState();
  broadcastFullState();
  return m;
}
// The match the website says belongs on this stream right now: one being played (live), else the
// one the organiser featured / put first in the stream queue.
function siteOnStreamMatch(lg) {
  const live = ((lg && lg.schedule) || []).filter((m) => m.status === 'live');
  if (!live.length) return null;
  // A tournament plays many matches at once: the one on a stream queue (first in line) or featured
  // is the broadcast's. With no queue set on the website, follow only when exactly one is live.
  const queued = live.filter((m) => m.onStream || m.featured)
    .sort((a, b) => (a.queuePos == null ? 99 : a.queuePos) - (b.queuePos == null ? 99 : b.queuePos));
  if (queued.length) return queued[0];
  return live.length === 1 ? live[0] : null;
}
// Auto-follow: the website marks a match live → it goes on the scoreboard. A series the desk is in
// the middle of recording is never yanked away; the switch waits until it finishes.
function siteEventFollow(lg) {
  const se = siteEventState();
  if (!se.autoFollow || !lg || se.leagueId !== lg.id) return;
  const live = siteOnStreamMatch(lg);
  if (!live || live.id === se.matchId) return;
  const cap = state.leagueCapture;
  const busy = cap && cap.active && cap.leagueId === lg.id && cap.matchId === se.matchId && (cap.games || []).length > 0;
  if (busy) return;
  try { putSiteMatchOnAir(live.id); logAuto('event', 'The website marked a match live: loaded onto the scoreboard.'); }
  catch (e) { console.warn('[site-event] auto-follow failed:', (e && e.message) || e); }
}
// Report the recorded series for a website fixture. final=false after each game, true when it clinches.
// Score reports to the website, one match at a time and in order. Each finished game sends the
// whole series so far; they used to be fire-and-forget, so a slow "game 2" could land after the
// "final" and the website showed the older score. Now a match has one sender: a newer report
// replaces any not yet sent, and the latest one is always the last to land.
const _siteReports = new Map();   // "lgId|matchId" -> { next: {games, final} | null, running }
// Matches whose result the app recorded recently: a competition sync fetched before the report
// landed must not roll them back (see competition.applyDoc opts.protect).
const _siteReportHold = new Map(); // "lgId|matchId" -> hold-until ms (Infinity while sending)
function siteReportCapture(lgId, matchId, games, final) {
  const key = lgId + '|' + matchId;
  let q = _siteReports.get(key);
  if (!q) { q = { next: null, running: false }; _siteReports.set(key, q); }
  q.next = { games, final };
  _siteReportHold.set(key, Infinity);
  if (q.running) return Promise.resolve();
  q.running = true;
  return (async () => {
    try {
      while (q.next) {
        const job = q.next; q.next = null;
        await _siteReportSend(lgId, matchId, job.games, job.final);
      }
    } finally {
      q.running = false;
      _siteReports.delete(key);
      _siteReportHold.set(key, Date.now() + 120000);   // give the source two minutes to catch up
    }
  })();
}
function siteReportHeld(lgId, matchId) {
  const t = _siteReportHold.get(lgId + '|' + matchId);
  if (t == null) return false;
  if (t < Date.now()) { _siteReportHold.delete(lgId + '|' + matchId); return false; }
  return true;
}
async function _siteReportSend(lgId, matchId, games, final) {
  const se = siteEventState();
  if (!se.autoReport || !cloud.authed()) return;
  const lg = (state.leagues || []).find((l) => l.id === lgId);
  if (!lg || !lg.source || lg.source.type !== 'cloud') return;
  const m = (lg.schedule || []).find((x) => x.id === matchId);
  if (!m || !m.extId) return;
  const sa = games.filter((g) => g.scoreA > g.scoreB).length, sb = games.filter((g) => g.scoreB > g.scoreA).length;
  try {
    await cloud.reportCompetitionMatch(lg.source.cloudCompetitionId, m.extId, {
      games: games.map((g) => ({ scoreA: g.scoreA, scoreB: g.scoreB })), scoreA: sa, scoreB: sb, final: !!final, source: 'broadcast-studio',
    });
    se.lastReport = (final ? 'Final ' : 'Game ' + games.length + ': ') + sa + '-' + sb + ' sent to the website';
    se.lastReportOk = true;
  } catch (e) {
    se.lastReport = (e && e.status === 403) ? 'The website did not take the score: you are not staff on this event.' : 'Could not send the score to the website: ' + ((e && e.message) || 'request failed');
    se.lastReportOk = false;
  }
  broadcastFullState();
}

// ── Ballchasing group → league stats aggregation ─────────────────────────────
// Turns a ballchasing.com group's cumulative stats (client.getGroup) into the league's
// ballchasingStats (per-team) + ballchasingPlayers (per-player leaderboard). This is a SEPARATE sink
// from lg.stats — it never touches the producer's manual entry (see migrateLeague's note).
let _bcGroupShapeLogged = false;
function _bcNorm(s) { return String(s == null ? '' : s).trim().toLowerCase().replace(/[^a-z0-9]/g, ''); }
// A league team's roster gamertags (resolved through savedTeams, since lg.teams are name refs).
function srvLgTeamRoster(tm) {
  const nm = _bcNorm(tm && (tm.teamName || tm.name));
  if (!nm) return [];
  const saved = savedTeams.find((s) => _bcNorm(s.name) === nm);
  const players = (saved && Array.isArray(saved.players) ? saved.players : (tm && Array.isArray(tm.players) ? tm.players : []));
  return players.map((p) => _bcNorm(typeof p === 'string' ? p : (p && (p.name || p.gamerTag || p.gamertag)))).filter(Boolean);
}
// Defensive extraction — ballchasing nests the numbers under cumulative.core / cumulative.demo, but
// builds/plans vary, so fall back through game_average and a flat shape. Unknown → 0.
function _bcCore(p) {
  const cum = (p && (p.cumulative || p.stats)) || {};
  const core = cum.core || (p && p.game_average && p.game_average.core) || cum || {};
  const demo = cum.demo || (p && p.game_average && p.game_average.demo) || {};
  const n = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : 0);
  return {
    games: n(cum.games != null ? cum.games : p && p.games),
    wins: n(cum.wins != null ? cum.wins : p && p.wins),
    goals: n(core.goals), assists: n(core.assists), saves: n(core.saves), shots: n(core.shots),
    score: n(core.score), mvps: n(core.mvp != null ? core.mvp : core.mvps),
    demos: n(demo.inflicted != null ? demo.inflicted : (core.demos != null ? core.demos : 0)),
    shootingPct: n(core.shooting_percentage != null ? core.shooting_percentage : core.shootingPercentage)
  };
}
function bcAggregateGroupIntoLeague(lg, group) {
  if (!group || typeof group !== 'object') return { players: 0, teamsMatched: 0, unassigned: 0 };
  if (!_bcGroupShapeLogged) {   // one-time real-shape reveal, mirrors _rlPacketShapeLogged
    _bcGroupShapeLogged = true;
    try { console.log('[Ballchasing] group shape sample:', JSON.stringify(group).slice(0, 1200)); } catch (_) {}
  }
  const groupPlayers = Array.isArray(group.players) ? group.players : [];
  const teams = (lg.teams || []);
  // Pre-index each league team's roster gamertags for fast player→team assignment.
  const rosters = teams.map((tm) => ({ id: tm.id, set: new Set(srvLgTeamRoster(tm)) }));
  const manualLinks = {};   // bcKey -> teamId, from lg.ballchasing.playerLinks (producer overrides)
  (lg.ballchasing.playerLinks || []).forEach((lk) => { if (lk && lk.bcKey && lk.teamId) manualLinks[lk.bcKey] = lk.teamId; });

  const players = {};                 // "platform:id" -> leaderboard row
  const teamStats = {};               // teamId -> summed core stats
  const autoLinks = [];
  let matchedTeams = new Set(), unassigned = 0;

  groupPlayers.forEach((p) => {
    const key = `${p.platform || 'unknown'}:${p.id || _bcNorm(p.name)}`;
    const core = _bcCore(p);
    const nm = _bcNorm(p.name);
    // Assign to a league team: manual link wins, else roster gamertag match.
    let teamId = manualLinks[key] || '';
    if (!teamId) { const hit = rosters.find((r) => r.set.has(nm)); if (hit) teamId = hit.id; }
    if (teamId) { matchedTeams.add(teamId); } else { unassigned++; }
    autoLinks.push({ bcKey: key, bcName: p.name || '', teamId });
    const teamRef = teamId ? teams.find((t) => t.id === teamId) : null;
    const teamName = teamRef ? (teamRef.teamName || teamRef.name || '') : '';
    players[key] = {
      name: p.name || 'Player', platform: p.platform || '', id: p.id || '',
      teamId, teamName: teamName || '',
      games: core.games, wins: core.wins, goals: core.goals, assists: core.assists,
      saves: core.saves, shots: core.shots, score: core.score, mvps: core.mvps, demos: core.demos,
      shootingPct: core.shootingPct
    };
    if (teamId) {
      const t = teamStats[teamId] || (teamStats[teamId] = { goals: 0, assists: 0, saves: 0, shots: 0, mvps: 0, demos: 0, score: 0 });
      t.goals += core.goals; t.assists += core.assists; t.saves += core.saves;
      t.shots += core.shots; t.mvps += core.mvps; t.demos += core.demos; t.score += core.score;
    }
  });

  lg.ballchasingStats = teamStats;
  lg.ballchasingPlayers = players;
  lg.ballchasing.playerLinks = autoLinks;   // persisted so a future manual-override UI can edit them
  lg.ballchasing.lastSyncedAt = Date.now();
  lg.ballchasing.lastRefreshNote = `Synced ${groupPlayers.length} player${groupPlayers.length === 1 ? '' : 's'} across ${matchedTeams.size} team${matchedTeams.size === 1 ? '' : 's'}` + (unassigned ? ` (${unassigned} unmatched — check gamertags)` : '');
  return { players: groupPlayers.length, teamsMatched: matchedTeams.size, unassigned };
}

// ── MVP sync (per-replay detail fetch) ───────────────────────────────────────
// Ballchasing's group-cumulative endpoint (bcAggregateGroupIntoLeague, above) has NO mvp field —
// MVP only exists per-replay, on GET /replays/{id} (blue/orange.players[].mvp). Since group-cumulative
// fully REBUILDS lg.ballchasingPlayers on every refresh, MVP counts are tracked in a separate,
// persistent lg.ballchasing.mvpCounts map (survives rebuilds) and folded back in by bcApplyMvpCounts.
// Only replays not already in lg.ballchasing.processedReplayIds are detail-fetched, so a refresh after
// the first only pays for whatever's new — capped per click (free tier is 2 req/s) with the rest
// picked up on the next Refresh Stats click.
const BC_MVP_FETCH_CAP = 100;
const BC_MVP_FETCH_PACE_MS = 550;
let _bcReplayShapeLogged = false;
function _bcReplayPlayerKey(p) {
  // Group-cumulative player objects are flat ({platform,id}); replay-detail objects have been seen
  // nesting the same fields under `id` ({id:{platform,id}}) — handle both defensively.
  const platform = p.platform || (p.id && typeof p.id === 'object' && p.id.platform) || 'unknown';
  const pid = (p.id && typeof p.id === 'object') ? p.id.id : p.id;
  return `${platform}:${pid || _bcNorm(p.name)}`;
}
async function bcSyncMvps(lg, client) {
  lg.ballchasing.mvpCounts = (lg.ballchasing.mvpCounts && typeof lg.ballchasing.mvpCounts === 'object') ? lg.ballchasing.mvpCounts : {};
  const processed = new Set(Array.isArray(lg.ballchasing.processedReplayIds) ? lg.ballchasing.processedReplayIds : []);

  let list;
  try {
    list = await client.listGroupReplays(lg.ballchasing.groupId);
  } catch (e) {
    console.warn('[Ballchasing] MVP sync: could not list group replays —', e.message);
    return { fetched: 0, truncated: false };
  }
  const replays = (list && list.data && Array.isArray(list.data.list)) ? list.data.list : [];
  const toFetch = replays.filter((r) => r && r.id && r.status === 'ok' && !processed.has(r.id));
  const truncated = toFetch.length > BC_MVP_FETCH_CAP;
  const batch = toFetch.slice(0, BC_MVP_FETCH_CAP);

  for (let i = 0; i < batch.length; i++) {
    try {
      const detail = await client.getReplay(batch[i].id);
      if (!_bcReplayShapeLogged) {   // one-time real-shape reveal, mirrors _bcGroupShapeLogged
        _bcReplayShapeLogged = true;
        try { console.log('[Ballchasing] replay detail shape sample:', JSON.stringify(detail.data).slice(0, 1200)); } catch (_) {}
      }
      [detail.data && detail.data.blue, detail.data && detail.data.orange].filter(Boolean).forEach((side) => {
        (side.players || []).forEach((p) => {
          if (p && p.mvp) {
            const key = _bcReplayPlayerKey(p);
            lg.ballchasing.mvpCounts[key] = (lg.ballchasing.mvpCounts[key] || 0) + 1;
          }
        });
      });
      processed.add(batch[i].id);
    } catch (e) {
      console.warn('[Ballchasing] MVP detail fetch failed for replay', batch[i].id, '—', e.message);
      // left unprocessed — retried on the next refresh
    }
    if (i < batch.length - 1) await new Promise((resolve) => setTimeout(resolve, BC_MVP_FETCH_PACE_MS));
  }
  lg.ballchasing.processedReplayIds = Array.from(processed);
  return { fetched: batch.length, truncated };
}
// Folds the persistent mvpCounts map into the just-rebuilt ballchasingPlayers/ballchasingStats
// (bcAggregateGroupIntoLeague always resets mvps to 0 since group-cumulative doesn't carry it).
function bcApplyMvpCounts(lg) {
  const counts = lg.ballchasing.mvpCounts || {};
  const teamMvps = {};
  Object.keys(lg.ballchasingPlayers || {}).forEach((key) => {
    const mvps = counts[key] || 0;
    lg.ballchasingPlayers[key].mvps = mvps;
    const teamId = lg.ballchasingPlayers[key].teamId;
    if (teamId) teamMvps[teamId] = (teamMvps[teamId] || 0) + mvps;
  });
  Object.keys(lg.ballchasingStats || {}).forEach((teamId) => {
    lg.ballchasingStats[teamId].mvps = teamMvps[teamId] || 0;
  });
}

// Upload a batch of .replay files into a league's ballchasing group, one result per input path.
// Shared by the manual-upload WS handler, the auto-upload folder watcher, and the replay-rename
// batch tool. Records each replay id into lg.ballchasing.pendingReplays (a 409 = already uploaded
// still yields the existing id).
async function bcUploadReplaysDetailed(lg, paths) {
  const client = createBallchasingClient(ballchasingApiKey);
  const results = [];
  for (const fp of paths) {
    try {
      const res = await client.uploadReplay(fp, lg.ballchasing.groupId);
      const rid = res && res.data && res.data.id;
      if (rid && !lg.ballchasing.pendingReplays.includes(rid)) lg.ballchasing.pendingReplays.push(rid);
      results.push({ path: fp, ok: true, dup: res && res.status === 409, replayId: rid || null });
    } catch (e) {
      console.warn('[Ballchasing] upload', fp, e.message);
      results.push({ path: fp, ok: false, dup: false, error: e.message });
    }
  }
  return results;
}
// Thin {ok,dup,fail} tally wrapper over bcUploadReplaysDetailed — kept for the two existing call
// sites (_bcAutoUploadOne, the ballchasing_upload_replays WS case) so neither has to change.
async function bcUploadReplays(lg, paths) {
  const detailed = await bcUploadReplaysDetailed(lg, paths);
  let ok = 0, dup = 0, fail = 0;
  detailed.forEach((r) => { if (!r.ok) fail++; else if (r.dup) dup++; else ok++; });
  return { ok, dup, fail };
}

// ── Auto-upload folder watcher (opt-in) ──────────────────────────────────────
// A single watcher instance; syncBallchasingAutoUpload() starts/stops it to match
// state.ballchasing.autoUpload. Each newly-appeared .replay is uploaded into the CURRENTLY-active
// league's group (state.ballchasing.autoUpload.activeLeagueId).
let _bcWatcher = null;
// Rename-history batch tool's match window — a replay file's mtime must fall within this of a
// recorded game's ended_at/started_at to be matched. Not producer-tunable in v1.
const REPLAY_RENAME_TOLERANCE_MS = 10 * 60 * 1000;
async function _bcAutoUploadOne(absPath) {
  // Every early return here used to resolve silently — the watcher's retry path only fires on a
  // REJECTED promise (see ballchasing-watcher.js's settleThenUpload), so "no key yet" / "no active
  // league" / a genuine upload failure all looked like success to it: the file got marked seen and
  // was never retried, even after the producer fixed the underlying problem. Throw in every case
  // instead, so the watcher's existing retry bookkeeping actually engages.
  if (!ballchasingApiKey) throw new Error('No Ballchasing API key saved yet.');
  const au = state.ballchasing.autoUpload || {};
  const lg = (state.leagues || []).find((l) => l.id === au.activeLeagueId);
  if (!lg || !lg.ballchasing || !lg.ballchasing.groupId) {
    logAuto('ballchasing', 'Auto-upload skipped — no active league with a group.');
    throw new Error('No active league with a Ballchasing group.');
  }
  // bcUploadReplays swallows its own per-file errors (network/API failures) and always resolves —
  // check the tally ourselves so a real upload failure still surfaces as a rejection here too.
  const result = await bcUploadReplays(lg, [absPath]);
  leaguesVer++;
  saveAppState();
  broadcastFullState();
  if (result.fail > 0) throw new Error('Ballchasing upload failed — will retry.');
}
function syncBallchasingAutoUpload() {
  const au = state.ballchasing.autoUpload || {};
  if (!_bcWatcher) _bcWatcher = createBallchasingWatcher({ onUpload: _bcAutoUploadOne, log: (m) => logAuto('ballchasing', m) });
  if (au.enabled && au.folder && ballchasingApiKey) _bcWatcher.start(au.folder);
  else _bcWatcher.stop();
}

// ── Website league sync (bidirectional, opt-in per league — see CompeteLeague on the website) ──
// Shapes a local league into the website's push payload. Team/match ids travel as externalId so
// a later push/pull recognizes "this is the same team/match" without adopting cloud-generated ids.
// Returns null for a league whose source IS the website (source.type 'cloud'): that data is the
// website's own, read-only here, and pushing it back would overwrite the source of truth with a copy.
function buildLeaguePushPayload(lg) {
  if (lg && lg.source && lg.source.type === 'cloud') return null;
  const teams = (lg.teams || []).map((t) => ({
    externalId: t.id,
    name: (t.teamName || t.name || '').toString().slice(0, 80),
    seed: typeof t.seed === 'number' ? t.seed : null,
    wins: typeof t.wins === 'number' ? t.wins : 0,
    losses: typeof t.losses === 'number' ? t.losses : 0,
    draws: typeof t.draws === 'number' ? t.draws : 0,
    points: typeof t.points === 'number' ? t.points : 0,
    status: t.status || 'active',
  }));
  const matches = (lg.schedule || []).map((m) => {
    const wk = parseInt(m.week, 10);
    return {
      externalId: m.id,
      teamAExternalId: m.teamA,
      teamBExternalId: m.teamB,
      format: m.format || null,
      week: isNaN(wk) ? null : wk,
      scoreA: m.result && typeof m.result.scoreA === 'number' ? m.result.scoreA : null,
      scoreB: m.result && typeof m.result.scoreB === 'number' ? m.result.scoreB : null,
      status: (m.result && (m.result.scoreA != null || m.result.scoreB != null)) ? 'completed' : 'scheduled',
      games: Array.isArray(m.games) ? m.games : [],
    };
  });
  // The app's status vocabulary (active/offseason/playoffs/complete) is richer than the
  // website's (upcoming/active/completed) — collapse lossily on push; the app stays authoritative.
  const status = lg.status === 'complete' ? 'completed' : (lg.status === 'upcoming' ? 'upcoming' : 'active');
  return {
    externalId: lg.id,
    name: lg.name || 'Untitled League',
    game: lg.game || null,
    status,
    scoring: lg.scoring || {},
    tiebreak: lg.tiebreak || 'gd',
    starterCount: typeof lg.starterCount === 'number' ? lg.starterCount : 3,
    playoffN: typeof lg.playoffN === 'number' ? lg.playoffN : 4,
    abbr: lg.abbr || '',
    teams, matches,
  };
}

function cloudTeamToLocal(ct) {
  return {
    id: ct.externalId || srvLgUid('tm'),
    teamName: ct.name || '',
    seed: typeof ct.seed === 'number' ? ct.seed : null,
    wins: ct.wins || 0, losses: ct.losses || 0, draws: ct.draws || 0, points: ct.points || 0,
    status: ct.status || 'active',
  };
}
function cloudMatchToLocal(cm, teamIdByCloudId) {
  return {
    id: cm.externalId || srvLgUid('m'),
    teamA: teamIdByCloudId.get(cm.teamAId) || cm.teamAId,
    teamB: teamIdByCloudId.get(cm.teamBId) || cm.teamBId,
    format: cm.format || 'BO3',
    week: cm.week != null ? String(cm.week) : '',
    date: '', time: '',
    result: { scoreA: cm.scoreA ?? null, scoreB: cm.scoreB ?? null, ot: false },
    games: Array.isArray(cm.games) ? cm.games : [],
  };
}
// A brand-new local league from a website-authored CompeteLeague this app has never seen.
function cloudLeagueToLocal(cloudLg) {
  const teamIdByCloudId = new Map();
  const teams = (cloudLg.teams || []).map((t) => {
    const local = cloudTeamToLocal(t);
    teamIdByCloudId.set(t.id, local.id);
    return local;
  });
  const schedule = (cloudLg.matches || []).map((m) => cloudMatchToLocal(m, teamIdByCloudId));
  return {
    id: cloudLg.externalId || srvLgUid('lg'),
    name: cloudLg.name || 'Untitled League',
    status: cloudLg.status === 'completed' ? 'complete' : (cloudLg.status || 'active'),
    type: 'team',
    scoring: (cloudLg.scoring && typeof cloudLg.scoring === 'object') ? cloudLg.scoring : undefined,
    tiebreak: cloudLg.tiebreak || 'gd',
    starterCount: cloudLg.starterCount, playoffN: cloudLg.playoffN, abbr: cloudLg.abbr || '',
    teams, schedule,
  };
}
// Pull a website league into the local leagues array — non-destructive, mergeAtTop philosophy:
// an already-linked local league only gains teams/matches it doesn't already have (matched by
// externalId, else name); existing local rows are never overwritten. A genuinely new
// website-authored league (no local link) is added as a brand-new local league.
function mergePulledLeague(cloudLg) {
  if (!cloudLg || !cloudLg.id) return '0 leagues pulled';
  if (!Array.isArray(state.leagues)) state.leagues = [];
  const existing = state.leagues.find((l) => l.cloudLeagueId === cloudLg.id || (cloudLg.externalId && l.id === cloudLg.externalId));
  if (existing) {
    existing.teams = existing.teams || [];
    existing.schedule = existing.schedule || [];
    const teamIdByCloudId = new Map();
    let addedTeams = 0, addedMatches = 0, updatedTeams = 0, updatedMatches = 0;
    (cloudLg.teams || []).forEach((ct) => {
      const already = existing.teams.find((t) => t.id === ct.externalId || (t.teamName || t.name) === ct.name);
      if (already) {
        teamIdByCloudId.set(ct.id, already.id);
        // A "Pull in" click is an explicit, single-shot, producer-requested action — unlike the
        // automatic background syncs elsewhere, the producer clicking Pull clearly means "make my
        // copy match the website," so the cloud row should win here. It used to only ever ADD
        // teams/matches that didn't exist locally yet, silently ignoring any edit made to an
        // EXISTING row on the website (a score correction, a status change) — the pull would
        // report success ("+0 teams, +0 matches") while actually changing nothing, giving false
        // confidence the two were in sync. Only touch fields the cloud actually carries.
        if (ct.name) already.teamName = ct.name;
        if (typeof ct.seed === 'number') already.seed = ct.seed;
        if (typeof ct.wins === 'number') already.wins = ct.wins;
        if (typeof ct.losses === 'number') already.losses = ct.losses;
        if (typeof ct.draws === 'number') already.draws = ct.draws;
        if (typeof ct.points === 'number') already.points = ct.points;
        if (ct.status) already.status = ct.status;
        updatedTeams++;
        return;
      }
      const local = cloudTeamToLocal(ct);
      existing.teams.push(local);
      teamIdByCloudId.set(ct.id, local.id);
      addedTeams++;
    });
    (cloudLg.matches || []).forEach((cm) => {
      const alreadyM = existing.schedule.find((m) => m.id === cm.externalId);
      if (alreadyM) {
        // Cloud carries no date/time (see cloudMatchToLocal) — never touch those, or a producer's
        // locally-scheduled time would get silently wiped back to blank on every pull.
        if (cm.format) alreadyM.format = cm.format;
        if (cm.week != null) alreadyM.week = String(cm.week);
        if (Array.isArray(cm.games)) alreadyM.games = cm.games;
        alreadyM.result = alreadyM.result || { scoreA: null, scoreB: null, ot: false };
        if (cm.scoreA !== undefined) alreadyM.result.scoreA = cm.scoreA;
        if (cm.scoreB !== undefined) alreadyM.result.scoreB = cm.scoreB;
        updatedMatches++;
        return;
      }
      existing.schedule.push(cloudMatchToLocal(cm, teamIdByCloudId));
      addedMatches++;
    });
    existing.cloudLeagueId = existing.cloudLeagueId || cloudLg.id;
    leaguesVer++;
    saveAppState();
    const parts = [];
    if (addedTeams || addedMatches) parts.push(`+${addedTeams} teams, +${addedMatches} matches`);
    if (updatedTeams || updatedMatches) parts.push(`${updatedTeams} teams, ${updatedMatches} matches updated`);
    return `Updated "${existing.name}" (${parts.join(', ') || 'no changes'})`;
  }
  const fresh = migrateLeague(cloudLeagueToLocal(cloudLg));
  fresh.cloudLeagueId = cloudLg.id;
  state.leagues = mergeAtTop(state.leagues, [fresh], (a, b) => a.id === b.id);
  leaguesVer++;
  saveAppState();
  return `Pulled "${fresh.name}" as a new league`;
}

async function testStartGgConnection() {
  if (!startggApiToken) {
    throw new Error('Missing Start.gg API token');
  }

  const client = createStartGgClient(startggApiToken);
  const query = `
    query TestStartggConnection {
      currentUser {
        id
        slug
      }
    }
  `;

  const res = await client.request(query);
  const user = res?.currentUser;
  if (!user) {
    throw new Error('Invalid Start.gg token or API response');
  }

  return user;
}

// Close out the current series (stats match + scores + game number) — shared by the
// reset_series WS case and the start.gg push/auto-follow paths, so advancing to the
// next set never carries the previous match's score or game number onto the overlay.
function finalizeAndResetSeries() {
  // A recording running across the change keeps the finished series' label, final score included.
  if (_recLabel && _recLabel.epoch === _seriesEpoch) _recLabel.fields = currentMatchFields();
  _seriesEpoch++;
  if (statsCurrentMatchId) {
    stats.endMatch(statsCurrentMatchId, {
      scoreA: state.series.blue,
      scoreB: state.series.orange,
      winner: state.series.blue > state.series.orange ? 'a'
            : state.series.orange > state.series.blue ? 'b' : null
    });
    try { analytics.event('match_complete'); } catch (e) {}
  }
  statsCurrentMatchId = null;
  statsCurrentGameId  = null;
  statsCs2GameId      = null;
  statsValGameId      = null;
  state.game.number = 1;
  state.series.blue = 0;
  state.series.orange = 0;
  // A fresh series showed the last game's score (3-1 next to series 0-0) until the next kickoff.
  // Clear it unless a Rocket League game is being played right now (its feed owns the score then).
  const rlGameLive = state.activeGame === 'rocket-league' && state.rlConnected && !state.awaitingKickoff;
  if (!rlGameLive) {
    state.game.blueScore = 0;
    state.game.orangeScore = 0;
    state.game.isOT = false;
  }
  // Hero bans belong to the series — a fresh series starts with none on any map.
  clearAllOwBans();
  // New series = new stat sheet. This is the shared close-out (reset_series WS case, start.gg push,
  // auto-follow), so the board can never carry the previous match's numbers onto the next one.
  if (state.seriesStats) { state.seriesStats.games = []; state.seriesStats.liveBanked = false; }
  // Clear OW map winners so the next match recounts from a clean slate.
  if (state.owMatch) state.owMatch.mapWinners = [];
  // Map Pool results belong to the match too (the maps themselves stay): a draw left over from the
  // last match would otherwise push this match's game number on by one.
  if (state.veto && Array.isArray(state.veto.maps)) state.veto.maps.forEach((m) => { if (m) { m.winner = ''; m.score = { a: 0, b: 0 }; } });
}

// Maps played to a draw on the Map Pool. A draw is a map played with no winner, so the game number
// (maps played + 1) counts it even though neither side's series score moved.
function vetoDraws() {
  return ((state.veto && state.veto.maps) || []).filter((m) => m && m.winner === 'draw').length;
}

// Which Smash an event is, derived from start.gg's event/videogame names ("Ultimate Singles",
// "Melee Doubles", "Smash 64"). Written to state.smash.title as the label the boards print under
// the centre medallion. The format also drives state.smash.mode: a doubles event lays the board out
// for doubles (both players on each plate, the rail moved off the four player HUDs).
const SMASH_TITLES = [
  [/\bultimate\b|\bssbu\b/i, 'Ultimate'],
  [/\bmelee\b|\bssbm\b/i, 'Melee'],
  [/\bbrawl\b/i, 'Brawl'],
  [/\bproject\s*\+?m\b|\bp\+\b/i, 'Project M'],
  [/\b64\b|\bssb64\b/i, 'Smash 64'],
  [/\brivals\b/i, 'Rivals']
];
function applySmashTitleFromEvent(event, slots) {
  if (!event) return;
  const evName = String((event && event.name) || '');
  const gameName = String((event && event.videogame && event.videogame.name) || '');
  const hay = gameName + ' ' + evName;
  const hit = SMASH_TITLES.find(([re]) => re.test(hay));
  // The ENTRANTS are the surest tell: a doubles entrant has two participants. Event names are only
  // a fallback - "Fight Night #1" says nothing about the format, and that is how a doubles bracket
  // went on air as singles ("1/G GRAB" - the pair's team name squeezed into an org tag).
  const sizes = (slots || []).map((sl) => ((sl && sl.entrant && sl.entrant.participants) || []).length).filter((n) => n > 0);
  const byEntrants = sizes.length ? (sizes.every((n) => n === 2) ? 'Doubles' : (sizes.every((n) => n === 1) ? 'Singles' : '')) : '';
  const format = byEntrants
    || (/\bdoubles\b|\b2v2\b|\bteams?\b|\bcrew\b/i.test(evName) ? 'Doubles' : 'Singles');
  const title = [hit ? hit[1] : '', format].filter(Boolean).join(' ');
  if (!title) return;
  state.smash.startggTitle = title;
  // Only auto-fill while the producer has not typed their own label.
  if (!state.smash.titleManual) state.smash.title = title;
  // Follow the event's format - but only when it CHANGES, so a producer who flips the mode by hand
  // keeps it for every later set of the same event. Crew battles are never guessed (start.gg
  // "teams" events are nearly always doubles), and a crew board is left alone.
  if (format !== state.smash.startggFormat) {
    state.smash.startggFormat = format;
    if (state.smash.mode !== 'team') setSmashMode(format === 'Doubles' ? 'doubles' : 'singles');
  }
}

let _sggPushSeq = 0;
async function syncStartGgSet(setId) {
  if (!startggApiToken) {
    throw new Error('Missing Start.gg API token');
  }
  if (!setId) {
    throw new Error('Missing Start.gg set ID');
  }

  const client = createStartGgClient(startggApiToken);
  const query = `
    query SyncStartggSet($setId: ID!) {
      set(id: $setId) {
        id
        fullRoundText
        event { name slug videogame { name } }
        slots {
          entrant {
            id
            name
            initialSeedNum
            participants { gamerTag prefix player { id prefix user { slug name images { url type } authorizations { type externalUsername } location { country } } } }
            team { images { url type } }
          }
        }
      }
    }
  `;

  // Newest request wins. A poll tick's push and the producer's manual push (or two quick manual
  // pushes) race the network; the older reply landing last zeroed the live series score and put the
  // stale set's teams on air. Only the latest call may apply.
  const mySeq = ++_sggPushSeq;
  const res = await client.request(query, { setId });
  if (mySeq !== _sggPushSeq) {
    console.log(`[start.gg] dropped a late reply for set ${setId} (a newer set push superseded it)`);
    tl('api.stale', { source: 'start.gg', what: 'set ' + setId });
    return { superseded: true };
  }
  const set = res?.set;
  if (!set) {
    throw new Error('Set not found');
  }

  // Advancing to a DIFFERENT set: close out and reset the previous series first
  // (same as the bracket builder's Go Live). Re-pushing the same set keeps the
  // in-progress score untouched.
  const isNewSet = String(state.startgg.lastPushedSetId || '') !== String(setId);
  if (isNewSet) {
    finalizeAndResetSeries();
  }

  // Opt-in (Settings > Broadcast > Follow the bracket's game). A stream queue can mix brackets from one tournament (Ultimate singles, then a Rocket League
  // set). The first set from a DIFFERENT event switches the app to that event's game, exactly as
  // loading the event would. Keyed on the event, not the set, so a producer who overrides the game
  // by hand keeps their pick for every later set of the same bracket.
  const setEventSlug = String((set.event && set.event.slug) || '').toLowerCase();
  if (state.followSetGame && isNewSet && setEventSlug && setEventSlug !== _gameAdoptedForEventSlug) {
    _gameAdoptedForEventSlug = setEventSlug;
    const gName = (set.event.videogame && set.event.videogame.name) || set.event.name || '';
    if (gName) adoptEventGame(gName);
  }

  // Keep slot POSITIONS: slot 0 → blue, slot 1 → orange. Do NOT filter out empty slots — a set with
  // only one entrant resolved (the opponent hasn't advanced out of their bracket yet) must show TBD
  // on the empty side, not collapse the array so the known team shifts across and the other side is
  // left showing the previous match's team. (Producer feedback: auto-queue "loads one team to both
  // sides pre-actively… we should have a TBD placeholder while waiting for the second team.")
  const slots = set.slots || [];
  const blueEntrant = slots[0]?.entrant || null;
  const orangeEntrant = slots[1]?.entrant || null;
  const entrants = [blueEntrant, orangeEntrant].filter(Boolean);
  indexEntrantLogos(entrants);

  state.teams.blue.name = (blueEntrant?.name || 'TBD').toUpperCase();
  state.teams.orange.name = (orangeEntrant?.name || 'TBD').toUpperCase();
  // start.gg's own casing, for titles and VOD names ("Team Liquid", not "TEAM LIQUID").
  state.teams.blue.nameRaw = String(blueEntrant?.name || '');
  state.teams.orange.nameRaw = String(orangeEntrant?.name || '');
  // Seed travels with the entrant, not the roster - a scoreboard chip ("SEED 13") is the one
  // piece of bracket context start.gg gives us for free on every push.
  state.teams.blue.seed = Number(blueEntrant?.initialSeedNum) > 0 ? Number(blueEntrant.initialSeedNum) : 0;
  state.teams.orange.seed = Number(orangeEntrant?.initialSeedNum) > 0 ? Number(orangeEntrant.initialSeedNum) : 0;
  // Entrant id rides along so the reported-character lookup can key on it exactly instead of
  // matching entrant NAMES, which sponsor prefixes and tag changes make unreliable.
  state.teams.blue.entrantId = String(blueEntrant?.id || '');
  state.teams.orange.entrantId = String(orangeEntrant?.id || '');
  // Which Smash this is, straight off the event ("Ultimate Singles", "Melee Doubles"). Producers
  // never had to type it and the boards were showing nothing; a manual set_smash_title still wins.
  applySmashTitleFromEvent(set.event, set.slots);

  // Auto-update the overlay round/stage label from this set's bracket round (e.g. "Winners Finals"),
  // so it tracks the teams whenever a set is pushed onto the overlay (auto-follow or manual).
  if (set.fullRoundText) {
    state.roundLabel = String(set.fullRoundText).toUpperCase();
    state.startgg.roundLabelAuto = true;
    state.startgg.roundLabelSetId = String(setId);
  } else if (isNewSet) {
    // Advancing to a DIFFERENT set that start.gg gives no round text for → clear the label. Don't
    // inherit the PREVIOUS match's round, which showed e.g. "QUARTERFINALS" while the semifinal
    // teams were already on screen. (A same-set re-push keeps the current label, incl. a manual one.)
    state.roundLabel = '';
    state.startgg.roundLabelAuto = true;
    state.startgg.roundLabelSetId = String(setId);
  }

  // Auto-apply logos/rosters — the activated event's REAL rosters (eventTeams) first, then
  // the local team library, matching the autofill_stream_teams precedence so Push and
  // Auto-fill produce the same result. Always reset all three first so a stale logo, roster OR org
  // from the previous push never silently carries over onto the new team.
  let gotRealRoster = false;
  [['blue', blueEntrant], ['orange', orangeEntrant]].forEach(([side, ent]) => {
    const tn = (state.teams[side].name || '').toUpperCase();
    const entId = (ent && ent.id != null) ? String(ent.id) : '';
    state.teams[side].logo = '';
    state.teams[side].players = [];
    // The org is reset with them. Every writer below is a `if (org) …` fill, so an unsponsored
    // entrant left the PREVIOUS entrant's sponsor sitting on the side — the scoreboard read
    // "AGENCY DREDAWG" a match after Agency | Morris played on that half.
    state.teams[side].org = '';
    // Match the EXACT entrant by its start.gg id first — team NAMES collide (two different orgs can
    // both be "Tarnished"), and matching by name alone grabbed whichever was saved first, pulling the
    // wrong roster/logo. Fall back to name only when there's no id to match on. (Producer feedback:
    // "it autoset them to the regular tarnished team" instead of this event's Tarnished.)
    const byId = (arr) => entId ? (arr || []).find((t) => t.startggId && String(t.startggId) === entId) : null;
    const byName = (arr) => (arr || []).find((t) => (t.name || '').toUpperCase() === tn);
    const et = byId(state.startgg.eventTeams) || byName(state.startgg.eventTeams);
    // Library fallback: prefer an id match. A NAME match whose start.gg id is set but DIFFERENT from
    // this entrant is a same-name-different-team collision — skip it rather than pull the wrong org's
    // roster. (A saved team with no id was never imported from start.gg, so allow best-effort by name.)
    let saved = byId(savedTeams);
    if (!saved) {
      const nm = byName(savedTeams);
      if (nm && !(nm.startggId && entId && String(nm.startggId) !== entId)) saved = nm;
    }
    const src = (et && Array.isArray(et.players) && et.players.length) ? et
              : (saved && Array.isArray(saved.players) && saved.players.length) ? saved
              : (et || saved || null);
    if (src) {
      if (src.logo) state.teams[side].logo = src.logo;
      if (Array.isArray(src.players) && src.players.length) {
        state.teams[side].players = src.players;
        gotRealRoster = true;
      }
      if (!state.teams[side].seed && Number(src.seed) > 0) state.teams[side].seed = Number(src.seed);
      if (src.org) state.teams[side].org = src.org;
    }
    // Nothing in the library for this entrant - build the roster from the SET's own participants.
    // Pushing a set for an event that was never imported used to land a bare team name on the
    // scoreboard: no gamertag, no country flag, no org, no socials.
    if (!state.teams[side].players.length && ent && (ent.participants || []).length) {
      const live = (ent.participants || []).map(startggPlayerFromParticipant).filter((x) => x.name);
      if (live.length) {
        state.teams[side].players = live;
        gotRealRoster = true;
        const org = entrantOrgName(live);
        if (org) state.teams[side].org = org;
      }
    }
    if (!state.teams[side].org) state.teams[side].org = '';
    if (!state.teams[side].logo) {
      const logo = pickEntrantLogo(ent) || logoForTeamName(state.teams[side].name);
      if (logo) state.teams[side].logo = logo;
    }
  });

  if (gotRealRoster) {
    // Real rosters landed on the team cards — mirror them into the flat overlay list.
    rebuildCombinedPlayers();
  } else {
    // No roster found anywhere: fall back to splitting the entrant NAME. This is only
    // meaningful for doubles-style entrants ("A / B"); a plain team-name entrant would
    // produce a bogus one-player roster named after the team, so skip that case.
    const bluePlayers = extractEntrantPlayers(blueEntrant?.name).map((name) => ({
      name, primaryid: null, team: 0, score: 0, goals: 0, assists: 0, saves: 0,
      shots: 0, demos: 0, boost: 0, isPrimary: false, isDemolished: false
    }));
    const orangePlayers = extractEntrantPlayers(orangeEntrant?.name).map((name) => ({
      name, primaryid: null, team: 1, score: 0, goals: 0, assists: 0, saves: 0,
      shots: 0, demos: 0, boost: 0, isPrimary: false, isDemolished: false
    }));
    const looksLikeNameList = bluePlayers.length > 1 || orangePlayers.length > 1;
    const combinedPlayers = [...bluePlayers, ...orangePlayers];
    if (looksLikeNameList && combinedPlayers.length > 0) {
      state.players = combinedPlayers;
      // Same rule as rebuildCombinedPlayers: a start.gg re-sync must never wipe stats out from
      // under a live game. Auto-follow re-syncs the on-air set while the match is being played.
      if (!rlMatchInProgress()) state.playerCache = {};
      combinedPlayers.forEach((p) => {
        const prev = state.playerCache[p.name];
        if (prev && RL_CUMULATIVE_STATS.some((k) => (Number(prev[k]) || 0) > 0)) return;
        state.playerCache[p.name] = { ...p };
      });
    }
  }

  state.startgg.lastSyncAt = new Date().toISOString();
  state.startgg.lastSyncStatus = 'ok';
  state.startgg.lastError = null;
  saveAppState();
  broadcastFullState();

  return {
    setId: set.id,
    fullRoundText: set.fullRoundText || '',
    entrants: entrants.map(e => e.name).filter(Boolean)
  };
}

// Rebuild the overlay's flat `state.players` list from the two team rosters
// (used after assigning rosters out of band, e.g. autofill from the stream queue).
function rebuildCombinedPlayers() {
  const toP = (p, team) => ({
    name: (p.name || '').toString(),
    primaryid: p.primaryid || null,
    team, score: 0, goals: 0, assists: 0, saves: 0, shots: 0, demos: 0, boost: 0,
    isPrimary: false, isDemolished: false
  });
  const blue = (state.teams.blue.players || []).map((p) => toP(p, 0));
  const orange = (state.teams.orange.players || []).map((p) => toP(p, 1));
  const combined = [...blue, ...orange];
  if (combined.length) {
    state.players = combined;
    // Rebuilding the roster used to WIPE playerCache and refill it with zero-stat rows. Fired
    // mid-match (a stream-queue autofill, an auto-follow re-sync, a roster edit) that erased every
    // stat the live game had accumulated, and the post-game board came up empty. Keep any cached
    // player who already has real stats; only seed rows for names we've never seen.
    if (!rlMatchInProgress()) state.playerCache = {};
    combined.forEach((p) => {
      const prev = state.playerCache[p.name];
      if (prev && RL_CUMULATIVE_STATS.some((k) => (Number(prev[k]) || 0) > 0)) return;   // keep live stats
      state.playerCache[p.name] = { ...p };
    });
  }
}

// True while an RL game is actually being played/spectated — used to protect live match data from
// out-of-band roster rebuilds. Deliberately broad: any accumulated stat counts as "in progress".
function rlMatchInProgress() {
  if (!state.rlConnected) return false;
  if (state.inReplay || state.awaitingKickoff) return true;
  return Object.values(state.playerCache || {})
    .some((p) => RL_CUMULATIVE_STATS.some((k) => (Number(p && p[k]) || 0) > 0));
}

function mapStartggSetToFeedItem(set, extra) {
  const slots = (set && set.slots) || [];
  const vA = slots[0]?.standing?.stats?.score?.value;
  const vB = slots[1]?.standing?.stats?.score?.value;
  let scoreA = typeof vA === 'number' && vA >= 0 ? vA : (typeof set.scoreA === 'number' && set.scoreA >= 0 ? set.scoreA : null);
  let scoreB = typeof vB === 'number' && vB >= 0 ? vB : (typeof set.scoreB === 'number' && set.scoreB >= 0 ? set.scoreB : null);
  const st = Number(set.state);
  let status = 'upcoming';
  if (extra?.live || st === 2) status = 'live';
  else if (st === 3) status = 'done';
  const teamA = (set.teamA || slots[0]?.entrant?.name || 'TBD').toString();
  const teamB = (set.teamB || slots[1]?.entrant?.name || 'TBD').toString();
  // start.gg quirks the standing scores can't express on their own:
  //   -1 = DQ/forfeit; null + a winnerId = reported winner-only. displayScore
  //   ("Team A 2 - Team B 1" or "DQ") is the reliable human-entered fallback.
  const ds = (set.displayScore || '').toString().trim();
  const dq = vA === -1 || vB === -1 || /^dq$/i.test(ds);
  let winSide = null;
  const winnerId = set.winnerId != null ? String(set.winnerId) : '';
  if (winnerId) {
    if (String(slots[0]?.entrant?.id || '') === winnerId) winSide = 'a';
    else if (String(slots[1]?.entrant?.id || '') === winnerId) winSide = 'b';
  }
  if (status === 'done' && !dq && (scoreA == null || scoreB == null) && ds && ds !== 'DQ') {
    // Parse "Name A 2 - Name B 1" (names may contain anything; scores are the
    // final digit runs on each side of the last " - ").
    const m = ds.match(/(\d+)\s+-\s+.*?(\d+)$/) || ds.match(/(\d+)\s*-\s*(?:.*\s)?(\d+)$/);
    if (m) { scoreA = Number(m[1]); scoreB = Number(m[2]); }
  }
  return {
    setId: String(set.id || set.setId || ''),
    round: (set.fullRoundText || set.round || '').toString(),
    teamA, teamB,
    scoreA, scoreB,
    dq,
    winSide,
    status,
    stream: (extra?.stream || set.stream || '').toString(),
    // Logo URLs (from the start.gg name->logo map — kept tiny, no base64 in the broadcast).
    logoA: state.startgg.logoMap[teamA.trim().toLowerCase()] || '',
    logoB: state.startgg.logoMap[teamB.trim().toLowerCase()] || ''
  };
}

// Format the start.gg match feed into ticker scorelines: "LIVE   Team A  2-1  Team B".
// start.gg has no mid-set scores until games are reported, so a scoreless live set reads
// "A vs B" instead of a fake 0-0; DQ/forfeit finals read W-DQ instead of 0-0.
function formatTickerFeed(feed) {
  return (feed || []).filter((m) => m && (m.status === 'live' || m.status === 'done')).map((m) => {
    const a = (typeof m.scoreA === 'number') ? m.scoreA : null;
    const b = (typeof m.scoreB === 'number') ? m.scoreB : null;
    if (m.status === 'live') {
      const mid = (a || b) ? `  ${a || 0}-${b || 0}  ` : '  vs  ';
      return 'LIVE   ' + m.teamA + mid + m.teamB;
    }
    if (m.dq) {
      const mid = m.winSide === 'b' ? '  DQ-W  ' : m.winSide === 'a' ? '  W-DQ  ' : '  DQ  ';
      return 'FINAL   ' + m.teamA + mid + m.teamB;
    }
    if (a == null && b == null && m.winSide) {
      const mid = m.winSide === 'a' ? '  W-L  ' : '  L-W  ';   // winner-only report, no game scores
      return 'FINAL   ' + m.teamA + mid + m.teamB;
    }
    return 'FINAL   ' + m.teamA + '  ' + (a || 0) + '-' + (b || 0) + '  ' + m.teamB;
  });
}
// The start.gg set currently being streamed (manual selection or auto-follow), resolved to its
// id + real team names + tournament. Used to link live RL player stats to the official set record
// so a streamed series becomes one row (official result + player stats) instead of two.
function currentStreamedSetLink() {
  const sg = state.startgg || {};
  const setId = sg.setId || sg.lastPushedSetId || null;
  if (!setId) return null;
  const item = (sg.queue || []).find((x) => String(x.setId) === String(setId))
            || (sg.matchFeed || []).find((x) => String(x.setId) === String(setId));
  const real = (s) => (s && s !== 'TBD' && s !== 'Unknown') ? s : null;
  return {
    setId: String(setId),
    teamA: item ? real(item.teamA) : null,
    teamB: item ? real(item.teamB) : null,
    tournament: (sg.selectedEvent && (sg.selectedEvent.tournamentName || sg.selectedEvent.name)) || null
  };
}
function buildStartggMatchFeed(queue, recentSets) {
  const seen = new Set();
  const live = [];
  const done = [];
  const consider = (item) => {
    if (!item || !item.teamA || !item.teamB || item.teamA === 'TBD' || item.teamB === 'TBD') return;
    const key = item.setId || `${item.teamA}|${item.teamB}|${item.round}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (item.status === 'live') live.push(item);
    else if (item.status === 'done') done.push(item);
  };
  // Live = every in-progress (state 2) set, on a stream or not. The producer's actual on-air match
  // is force-added by ensureOnAirLiveInFeed() even when the TO never flipped it to in-progress.
  // Scope to the ACTIVE event: a start.gg tournament shares its streams across multiple events, so the
  // tournament-wide queue carried sibling events' live sets into the ticker. Skip a queue item only
  // when we KNOW its event (q.eventSlug resolved) and it differs from the active one — if either is
  // unknown/blank, fall through and include it (never blank the ticker on a mapping miss).
  //
  // On an UNATTRIBUTED set (q.eventSlug null) the old rule was "include it" — but that is what let
  // sibling events onto the ticker, because a miss is silent. Split the two cases properly:
  //   • the phase→event map RESOLVED for this poll  → we can attribute confidently, so a set we
  //     still can't place is not ours: drop it.
  //   • the map came back EMPTY (query shape changed, permissions) → we know nothing, so fall
  //     through and show everything rather than blanking the ticker mid-show.
  const _activeEvSlug = (state.startgg.eventSlug || '').trim().toLowerCase();
  const _canAttribute = _activeEvSlug && (queue || []).some((q) => q && q.eventSlug);
  let _dropped = 0;
  (queue || []).forEach((q) => {
    if (_activeEvSlug) {
      const qs = String(q.eventSlug || '').trim().toLowerCase();
      if (qs && qs !== _activeEvSlug) { _dropped++; return; }          // known, and not this event
      if (!qs && _canAttribute) { _dropped++; return; }                // unattributable while the map works
    }
    consider(mapStartggSetToFeedItem(q, { live: q.live, stream: q.stream }));
  });
  if (_dropped) console.log(`[start.gg] ticker: kept ${(queue || []).length - _dropped}/${(queue || []).length} queued set(s) for ${_activeEvSlug} (dropped ${_dropped} from other events)`);
  (recentSets || []).forEach((s) => {
    const st = Number(s.state);
    if (st === 2 || st === 3) consider(mapStartggSetToFeedItem(s));   // 2 → live, 3 → done
  });
  // Compose: LIVE matches lead. Fill the rest with the most-recent FINALS up to a target size — so a
  // freshly-finished match shows as FINAL for a few loops then rotates out as newer results arrive,
  // and when there are few live matches (late in the bracket) the ticker fills with final scores.
  const TARGET = 10;
  const finalsToShow = Math.max(3, TARGET - live.length);
  return live.concat(done.slice(0, finalsToShow)).slice(0, 14);   // done is RECENT-ordered (newest first)
}

// A couple of NON-stream upcoming (state 1) matches to supplement the schedule/upcoming board in
// event-queue mode — the overlay already renders the stream-queue rows (state.startgg.queue), so this
// only adds not-yet-started sets that aren't queued on a stream. Returned WITHOUT a setId so the
// schedule overlay appends them as extra rows (setId items there only override existing queue rows).
function buildEventUpcomingExtras(queue, allSets) {
  const queued = new Set((queue || []).map((q) => String(q.setId)));
  const bad = (n) => !n || n === 'TBD';
  const out = [];
  for (const s of (allSets || [])) {
    if (out.length >= 3) break;
    if (Number(s.state) !== 1) continue;
    const m = mapStartggSetToFeedItem(s);
    if (queued.has(String(m.setId))) continue;
    if (bad(m.teamA) && bad(m.teamB)) continue;
    out.push({
      round: m.round || '', teamA: m.teamA, teamB: m.teamB,
      teamALogo: m.logoA || '', teamBLogo: m.logoB || '',
      date: '', time: '', stream: false, scoreA: m.scoreA ?? null, scoreB: m.scoreB ?? null,
      week: '', note: ''
    });
  }
  return out;
}

// Safety net + enrichment for the on-air match. The event feed already pulls in-progress (state 2)
// sets, but this guarantees the set the producer PUSHED (state.startgg.setId) is present as LIVE even
// if start.gg hasn't flipped it to state 2 yet, and overrides its score with the producer's live
// series score (more current than start.gg's standing). Idempotent.
function ensureOnAirLiveInFeed() {
  const sg = state.startgg;
  if (!sg) return;
  const setId = (sg.setId || sg.lastPushedSetId || '').toString().trim();
  if (!setId) return;                       // only force-live an explicitly pushed set
  const feed = sg.matchFeed || (sg.matchFeed = []);
  const link = currentStreamedSetLink();
  const teamA = (link && link.teamA) || (state.teams.blue && state.teams.blue.name) || '';
  const teamB = (link && link.teamB) || (state.teams.orange && state.teams.orange.name) || '';
  if (!teamA || !teamB) return;             // nothing meaningful on air
  const idx = feed.findIndex((m) => String(m.setId) === setId);
  const qItem = (sg.queue || []).find((q) => q && String(q.setId) === setId);
  // Once start.gg has REPORTED the set, its result wins. This used to pin the pushed set to
  // 'live' unconditionally, so a finished match sat on the desk rail and the ticker badged LIVE
  // — frozen on the producer's series score, with no winner highlight — until the next set was
  // pushed. state 3 = complete; the poll also lands it in the feed as 'done'.
  if ((idx >= 0 && feed[idx].status === 'done') || (qItem && Number(qItem.state) === 3)) return;
  const numOr = (v, fb) => (typeof v === 'number' ? v : fb);
  const item = {
    setId,
    // The stream queue knows the round even for a set the event-sets poll didn't return (a called
    // set the TO hasn't started), so the forced row isn't left with a blank round label.
    round: (idx >= 0 && feed[idx].round) || (qItem && qItem.round) || '',
    teamA, teamB,
    // Prefer the live series score the producer is tracking; fall back to start.gg's standing score.
    scoreA: numOr(state.series && state.series.blue,   idx >= 0 ? feed[idx].scoreA : null),
    scoreB: numOr(state.series && state.series.orange, idx >= 0 ? feed[idx].scoreB : null),
    status: 'live',
    stream: idx >= 0 ? feed[idx].stream : '',
    logoA: sg.logoMap[teamA.trim().toLowerCase()] || (idx >= 0 ? feed[idx].logoA : '') || '',
    logoB: sg.logoMap[teamB.trim().toLowerCase()] || (idx >= 0 ? feed[idx].logoB : '') || ''
  };
  if (idx >= 0) feed[idx] = item; else feed.unshift(item);
  const rank = (st) => (st === 'live' ? 0 : st === 'done' ? 1 : 2);
  sg.matchFeed = feed.sort((a, b) => rank(a.status) - rank(b.status)).slice(0, 10);
}

// Pull the event's IN-PROGRESS sets (start.gg state 2) and its most-recently-COMPLETED sets
// (state 3) explicitly via the state filter — RECENT sort alone can bury live sets behind a flood
// of just-reported finals. Returns a combined node list (each carries its own `state`).
async function fetchRecentEventSets(client, eventSlug) {
  const slug = parseEventSlug(eventSlug);
  if (!slug) return [];
  const setFields = `
    nodes {
      id
      fullRoundText
      state
      winnerId
      displayScore
      slots {
        entrant { id name }
        standing { stats { score { value } } }
      }
    }`;
  const query = `
    query FeedSets($slug: String!) {
      event(slug: $slug) {
        live:   sets(perPage: 24, page: 1, filters: { state: [2] }) { ${setFields} }
        recent: sets(perPage: 20, page: 1, sortType: RECENT, filters: { state: [3] }) { ${setFields} }
        soon:   sets(perPage: 16, page: 1, sortType: CALL_ORDER, filters: { state: [1] }) { ${setFields} }
      }
    }`;
  try {
    const res = await client.request(query, { slug });
    const ev = (res && res.event) || {};
    const liveNodes = (ev.live && ev.live.nodes) || [];
    const doneNodes = (ev.recent && ev.recent.nodes) || [];
    const soonNodes = (ev.soon && ev.soon.nodes) || [];
    return [...liveNodes, ...doneNodes, ...soonNodes];
  } catch (e) {
    // Fallback for any event/permission that rejects the state filter: RECENT sweep, split by state.
    const q2 = `query RecentSets($slug: String!) { event(slug: $slug) { sets(perPage: 40, page: 1, sortType: RECENT) { ${setFields} } } }`;
    const res = await client.request(q2, { slug });
    return (res && res.event && res.event.sets && res.event.sets.nodes) || [];
  }
}

// Fetch the tournament's STREAM QUEUE — the sets a TO has marked for each stream.
// The first set in a stream's queue is the one currently on that stream.
// Drop a ticker feed that was built for a DIFFERENT event than the one now active. The feed is
// rewritten only by a successful stream-queue poll, so a switch followed by a failed poll (rate
// limit, network, a tournament with no stream queue) otherwise left the old event's matches
// scrolling on air indefinitely. Cheap enough to call before every poll.
function pruneStaleMatchFeed() {
  const sg = state.startgg;
  if (!sg) return false;
  const active = (sg.eventSlug || '').trim().toLowerCase();
  const built = (sg.matchFeedEventSlug || '').trim().toLowerCase();
  if (!active || !built || built === active) return false;
  console.log(`[start.gg] ticker feed was built for ${built} but the active event is ${active} — clearing it`);
  sg.matchFeed = [];
  sg.queue = [];
  sg.streams = [];
  sg.matchFeedEventSlug = '';
  if (state.ticker.source === 'startgg') state.ticker.feed = [];
  if (state.upcoming.source === 'event') state.upcoming.matches = [];
  return true;
}


// Pick the set auto-follow should put on air. When the producer has SELECTED a stream (a
// championship runs several stations at once), never fall back to a different one — putting
// station 2's match on station 1's broadcast is worse than putting nothing on. The
// live → cued-up fallback still applies, but only WITHIN the chosen stream. With no stream
// selected ('' = any), behaviour is unchanged: first live set anywhere, else first cued up.
//
// `currentSetId` (what is on the overlay right now) makes the pick STICKY: while that set is
// still on the producer's own station queue and start.gg hasn't reported it, auto-follow keeps
// it and returns it unchanged. Without this, anything that reshuffles the head of the raw stream
// queue — a TO stacking the next set, a bracket re-seed, a Smash station where nobody marks sets
// in-progress — pulled the scoreboard onto the NEXT match mid-set, and since advancing to a new
// set runs finalizeAndResetSeries() that wiped the live series score too.
function pickAutoFollowSet(queue, wantStream, currentSetId) {
  const q = Array.isArray(queue) ? queue : [];
  const mine = wantStream ? q.filter((s) => s && s.stream === wantStream) : q;
  // A set whose BOTH sides are still unresolved is not something to put on air, nor to hold on air.
  // Once the match on air is reported, the head of the queue is very often the next round's empty
  // shell (Losers Final / Grand Final sitting at TBD vs TBD until the feeders report), and
  // auto-follow used to take the scoreboard straight to it — blanking a match that was still on
  // screen. One TBD side is fine and deliberate (the opponent hasn't advanced out of their half of
  // the bracket yet); two is nothing at all.
  const resolved = (s) => {
    const a = String(s.teamA || '').trim().toUpperCase();
    const b = String(s.teamB || '').trim().toUpperCase();
    return (a && a !== 'TBD') || (b && b !== 'TBD');
  };
  const cur = currentSetId ? mine.find((s) => String(s.setId) === String(currentSetId)) : null;
  if (cur && resolved(cur) && Number(cur.state) !== 3 && cur.winnerId == null) return cur;   // still being played — hold
  const playable = mine.filter(resolved);
  return playable.find((s) => s.live) || playable.find((s) => s.onStream) || null;
}

// Accumulate the archive of matches that went on air / finished on the followed stream, so the queue's
// past stays browsable after the event. Upserts by setId: DONE sets (state 3) and the current on-air
// set from the (already stream-scoped) queue, plus final scores from the event's recent-finals list
// (matched by setId, so a set that dropped off the queue still gets its final score). Capped + per-event.
function archiveStartggFromPoll(scopedQueue, recentSets) {
  const sg = state.startgg;
  if (!Array.isArray(sg.queueArchive)) sg.queueArchive = [];
  const arch = sg.queueArchive;
  const upsert = (item, done) => {
    if (!item || item.setId == null) return;
    if ((item.teamA === 'TBD' || !item.teamA) && (item.teamB === 'TBD' || !item.teamB)) return;   // unresolved
    const id = String(item.setId);
    const i = arch.findIndex((a) => String(a.setId) === id);
    const prev = i >= 0 ? arch[i] : null;
    const entry = {
      setId: id, stream: item.stream || (prev && prev.stream) || '',
      round: item.round || (prev && prev.round) || '',
      teamA: item.teamA || (prev && prev.teamA) || 'TBD',
      teamB: item.teamB || (prev && prev.teamB) || 'TBD',
      scoreA: item.scoreA != null ? item.scoreA : (prev ? prev.scoreA : null),   // never wipe a known score with null
      scoreB: item.scoreB != null ? item.scoreB : (prev ? prev.scoreB : null),
      done: !!done || (prev && prev.done) || false,
      ts: (prev && prev.ts) || Date.now()
    };
    if (i >= 0) arch[i] = entry; else arch.push(entry);
  };
  (scopedQueue || []).forEach((q) => {
    if (Number(q.state) === 3) upsert(q, true);                 // played out
    else if (q.setId === sg.lastPushedSetId) upsert(q, false);  // currently on air — capture it now
  });
  // Final scores for any archived set from the event's recent finals (matched by id → keeps its stream).
  (recentSets || []).forEach((s) => {
    const id = String(s && (s.id != null ? s.id : s.setId) || '');
    if (!id || Number(s.state) !== 3) return;
    if (!arch.some((a) => String(a.setId) === id)) return;   // only enrich sets we already broadcast
    const m = mapStartggSetToFeedItem(s);
    if (m) upsert({ setId: id, teamA: m.teamA, teamB: m.teamB, scoreA: m.scoreA, scoreB: m.scoreB, round: m.round }, true);
  });
  sg.queueArchive = arch.slice(-60);   // keep the last 60 — plenty for a full event day
}

// Latched once start.gg rejects the optional `streamSource` field — see the retry in
// fetchStreamQueue(). Session-scoped on purpose: a restart re-tries the richer query.
let _sggQueueNoPlatform = false;
async function fetchStreamQueue(tournamentSlug) {
  pruneStaleMatchFeed();   // never carry the previous event's feed into this poll
  if (!startggApiToken) throw new Error('No start.gg API token yet. Add it under Apps > start.gg.');
  const slug = (tournamentSlug || state.startgg.tournamentSlug || '').trim()
    .replace(/^https?:\/\/(www\.)?start\.gg\//i, '')
    .replace(/^tournament\//i, '').split('/')[0];
  if (!slug) throw new Error('Enter a tournament slug first');

  const client = createStartGgClient(startggApiToken);
  const query = `
    query StreamQueue($slug: String!) {
      tournament(slug: $slug) {
        id
        # Stage order comes from the event's own phases[] LISTING order, not phaseOrder — see
        # _phaseRank below and the matching note in buildPhases().
        events { id slug phases { id } }
        streamQueue {
          stream { streamName streamSource }
          sets {
            id
            fullRoundText
            round
            state
            startAt
            winnerId
            displayScore
            phaseGroup { id phase { id phaseOrder } }
            slots {
              entrant { id name team { images { url type } } }
              standing { stats { score { value } } }
            }
          }
        }
      }
    }`;
  // `streamSource` is only there to badge the channel with its platform logo — cosmetic. But an
  // unknown field fails the WHOLE GraphQL document, which would take the producer's stream queue
  // off the air for a logo. If start.gg ever rejects it, drop the field and carry on without the
  // platform (the overlays fall back to sniffing the channel name, then to a generic mark), and
  // remember that for the session so we stop paying for the failed request every poll.
  let res;
  try {
    res = await client.request(_sggQueueNoPlatform ? query.replace(' streamSource', '') : query,
                               { slug: `tournament/${slug}` });
  } catch (e) {
    if (_sggQueueNoPlatform || !/streamSource/i.test(String((e && e.message) || ''))) throw e;
    console.warn('[start.gg] streamQueue: streamSource rejected — retrying without the platform field');
    _sggQueueNoPlatform = true;
    res = await client.request(query.replace(' streamSource', ''), { slug: `tournament/${slug}` });
  }
  // The producer switched events while this request was out: applying it would put the OLD event's
  // queue (and, via auto-follow, its match) over the new one. Drop it; the new event's poll follows.
  const nowSlug = (state.startgg.tournamentSlug || '').trim()
    .replace(/^https?:\/\/(www\.)?start\.gg\//i, '').replace(/^tournament\//i, '').split('/')[0];
  if (nowSlug && nowSlug !== slug) {
    console.log(`[start.gg] dropped a stream-queue reply for "${slug}" (now following "${nowSlug}")`);
    tl('api.stale', { source: 'start.gg', what: 'queue ' + slug });
    return { streams: [], count: (state.startgg.queue || []).length, stale: true };
  }
  const sq = res?.tournament?.streamQueue || [];
  // Map each phase → its event slug, so the tournament-wide stream queue can be scoped to the ACTIVE
  // event. Sibling events (e.g. Singles + Doubles) share streams, and their live sets were leaking
  // into the ticker as the "wrong event". Used by buildStartggMatchFeed via each queue item's eventSlug.
  const _phaseToEventSlug = {};
  (res?.tournament?.events || []).forEach((ev) => (ev?.phases || []).forEach((ph) => {
    if (ph?.id != null) _phaseToEventSlug[String(ph.id)] = ev.slug || null;
  }));

  // start.gg returns a stream queue in bracket-GENERATION order (all winners rounds, then the
  // named ones, then losers, then grand finals), which reads as scrambled to a producer — e.g.
  // WR1, WQF, WF, WR2, WR3, WSF, LF, GF. Re-order it into double-elim PLAY order.
  //
  // Anchor on start.gg's `round` int (winners 1..N, losers -1..-M, grand finals N+1/N+2), because
  // fullRoundText alone can't tell you where "Winners Quarter-Final" sits without knowing N.
  // Losers round L is played right after winners round floor(L/2)+1, which reproduces the real
  // sequence: W1 · L1 · W2 · L2 · L3 · W3 · L4 · L5 · WF · LF · GF.
  // Which STAGE a set belongs to, for multi-stage events (pools → swiss → playoff bracket).
  //
  // This used to read `phase.phaseOrder` — the one field the bracket importer explicitly refuses
  // to trust, because a REBUILT phase gets a high id AND a high phaseOrder (RLCS NA Open 6: "Day 2"
  // reports phaseOrder 7 while "Day 3" reports 3). The queue and the bracket therefore disagreed
  // about stage order on exactly the events where it matters, floating a later day's semis and
  // finals above an earlier day's. Rank by the event's own phases[] LISTING order instead — the
  // same source buildPhases() uses — so both agree. phaseOrder stays as the fallback for a phase
  // the tournament query didn't list.
  const _phaseIndex = new Map();   // phase id -> rank across the whole tournament
  ((res?.tournament?.events) || []).forEach((ev, evIdx) => {
    ((ev && ev.phases) || []).forEach((ph, phIdx) => {
      if (ph && ph.id != null) _phaseIndex.set(String(ph.id), evIdx * 1000 + phIdx);
    });
  });
  const _phaseRank = (set) => {
    const id = set?.phaseGroup?.phase?.id;
    if (id != null && _phaseIndex.has(String(id))) return _phaseIndex.get(String(id));
    const phase = set?.phaseGroup?.phase?.phaseOrder;
    return Number.isFinite(phase) ? phase : 0;
  };
  // Grand Final (and its reset) always CLOSE a bracket — nothing in the phase plays after them,
  // Losers Final least of all. Treat that as a hard rank rather than something derived from the
  // round int, so a queue with an odd/pruned round numbering can never float GF above LF.
  const _isGrand = (set) => /grand\s*final/i.test(String(set?.fullRoundText || ''));
  // Per-phase anchors: the deepest WINNERS round and the deepest LOSERS round on the queue.
  // start.gg doesn't always number losers rounds as exactly 2N-2 (partial first rounds and pruned
  // empty rounds shift it), so a fixed floor(L/2)+1 can land Losers Final in the wrong wave.
  // Normalising against the deepest losers round pins LF to the winners-final wave, where it plays.
  const _anchors = new Map();
  sq.flatMap((q) => q?.sets || []).forEach((set) => {
    const r = Number(set?.round);
    if (!Number.isFinite(r) || r === 0 || _isGrand(set)) return;
    const p = _phaseRank(set);
    const a = _anchors.get(p) || { wMax: 0, lMax: 0 };
    if (r > 0) a.wMax = Math.max(a.wMax, r); else a.lMax = Math.max(a.lMax, Math.abs(r));
    _anchors.set(p, a);
  });
  const _playOrderKey = (set) => {
    const phaseRank = _phaseRank(set);
    const grand = _isGrand(set) ? 1 : 0;   // 0 = plays inside the bracket, 1 = closes it
    const r = Number(set?.round);
    let wave;      // which winners-round "wave" this set plays in
    let side;      // 0 = winners/finals (plays first in the wave), 1 = losers
    let within;    // tiebreak inside a wave
    if (grand) {
      // GF then GF reset — the round int orders them when present.
      wave = 0; side = 0;
      within = Number.isFinite(r) ? r : (/reset/i.test(String(set?.fullRoundText || '')) ? 1 : 0);
    } else if (Number.isFinite(r) && r !== 0) {
      if (r > 0) { wave = r; side = 0; within = 0; }
      else {
        const a = _anchors.get(phaseRank) || { wMax: 0, lMax: 0 };
        const l = Math.abs(r);
        wave = a.lMax ? (Math.floor(l / 2) - Math.floor(a.lMax / 2) + a.wMax) : (Math.floor(l / 2) + 1);
        side = 1; within = l;
      }
    } else {
      // No round int (manual/partial data) — fall back to the round TEXT. Numbered rounds keep
      // their number; the named end-of-bracket rounds sort after every numbered one, in the
      // order quarter → semi → final, with each losers round trailing its winners counterpart.
      const t = String(set?.fullRoundText || '').toLowerCase();
      const losers = /^l|losers?/.test(t);
      const num = (t.match(/round\s*(\d+)/) || [])[1];
      if (num) { wave = Number(num); side = losers ? 1 : 0; within = Number(num); }
      else if (/quarter/.test(t)) { wave = 9000; side = losers ? 1 : 0; within = 0; }
      else if (/semi/.test(t)) { wave = 9001; side = losers ? 1 : 0; within = 0; }
      else if (/final/.test(t)) { wave = 9002; side = losers ? 1 : 0; within = 0; }
      else { wave = 9500; side = losers ? 1 : 0; within = 0; }
    }
    return [phaseRank, grand, wave, side, within];
  };
  const _byPlayOrder = (a, b) => {
    const ka = _playOrderKey(a); const kb = _playOrderKey(b);
    for (let i = 0; i < ka.length; i++) { if (ka[i] !== kb[i]) return ka[i] - kb[i]; }
    return 0;
  };

  const streams = [];
  const queue = [];
  sq.forEach((q) => {
    const streamName = q?.stream?.streamName || 'Stream';
    // Platform the stream is on (TWITCH / YOUTUBE / …) so overlays can badge the channel — a
    // multi-stream event runs matches across different channels/platforms at once.
    const streamPlatform = q?.stream?.streamSource || '';
    if (!streams.includes(streamName)) streams.push(streamName);
    const sets = q?.sets || [];
    // Capture any team logos start.gg returns directly on the queue entrants.
    indexEntrantLogos(sets.flatMap((set) => (set.slots || []).map((s) => s?.entrant).filter(Boolean)));
    // "On stream now" is the HEAD of start.gg's raw queue — capture it before re-ordering, so the
    // display sort below can never change which set auto-follow pushes on air.
    const liveSetId = sets.length ? String(sets[0].id) : null;
    const sorted = sets.slice().sort(_byPlayOrder);
    sorted.forEach((set) => {
      // Keep slot POSITIONS (slot 0 → A, slot 1 → B) so a not-yet-resolved opponent shows TBD on the
      // correct side instead of the known team shifting across. (Matches syncStartggSet above.)
      const setSlots = set.slots || [];
      const scoreA = setSlots[0]?.standing?.stats?.score?.value;
      const scoreB = setSlots[1]?.standing?.stats?.score?.value;
      const teamA = setSlots[0]?.entrant?.name || 'TBD';
      const teamB = setSlots[1]?.entrant?.name || 'TBD';
      // Scheduled start time from start.gg (epoch seconds → local date/time strings the overlays
      // format). Lets the schedule graphic + pairings card show the TO's set times.
      let _date = '', _time = '';
      if (set.startAt) {
        const _d = new Date(set.startAt * 1000);
        const _p = (n) => String(n).padStart(2, '0');
        _date = _d.getFullYear() + '-' + _p(_d.getMonth() + 1) + '-' + _p(_d.getDate());
        _time = _p(_d.getHours()) + ':' + _p(_d.getMinutes());
      }
      queue.push({
        setId: String(set.id),
        stream: streamName,
        platform: streamPlatform,         // TWITCH / YOUTUBE / … (from start.gg streamSource)
        startAt: set.startAt || null,     // epoch seconds
        date: _date,                      // YYYY-MM-DD (local)
        time: _time,                      // HH:MM (local, 24h — overlays reformat per region)
        eventSlug: _phaseToEventSlug[String(set.phaseGroup?.phase?.id)] || null,   // which event this set belongs to
        round: set.fullRoundText || '',
        state: set.state,                 // 1 not started, 2 in progress, 3 done
        teamA,
        teamB,
        logoA: logoForTeamName(teamA),
        logoB: logoForTeamName(teamB),
        scoreA: typeof scoreA === 'number' && scoreA >= 0 ? scoreA : null,
        scoreB: typeof scoreB === 'number' && scoreB >= 0 ? scoreB : null,
        winnerId: set.winnerId != null ? set.winnerId : null,
        displayScore: set.displayScore || null,
        slots: set.slots,
        // LIVE means start.gg says the set is IN PROGRESS (state 2). It used to mean "head of the
        // raw stream queue", which lit the wrong set green whenever the earlier rounds had already
        // been played out — e.g. quarter-finals cleared off the queue left an unstarted semi-final
        // sitting at the head, badged LIVE while start.gg still had it as not started.
        live: Number(set.state) === 2,
        // What the TO has cued up NEXT on this stream (head of start.gg's raw queue order). Kept
        // as its own flag so auto-follow can still fall back to it for TOs who never mark sets
        // in-progress, without the queue UI claiming it is already on air.
        onStream: liveSetId != null && String(set.id) === liveSetId
      });
    });
  });

  let recentSets = [];
  const evSlug = (state.startgg.eventSlug || '').trim();
  if (evSlug) {
    try { recentSets = await fetchRecentEventSets(client, evSlug); } catch (e) { /* optional */ }
  }

  // The producer's STATION IS STICKY. start.gg only lists a stream while it has sets attached, so a
  // station drops off the queue between matches, while a TO re-stacks it, or when the last set on it
  // is reported. When that happened the name vanished from the picker, the panel silently fell back
  // to "All streams" — and the very next poll could put another station's match on this producer's
  // broadcast. Keep the chosen station pinned in the list (cached) so the choice survives the gap;
  // the only way off a station is the producer picking a different one.
  const _pinStream = (state.startgg.streamName || '').trim();
  if (_pinStream && !streams.includes(_pinStream)) {
    streams.push(_pinStream);
    state.startgg.streamOffQueue = true;   // panel note: "no sets on your station right now"
  } else {
    state.startgg.streamOffQueue = false;
  }
  state.startgg.streams = streams;
  state.startgg.queue = queue;   // FULL list — the panel + its "All streams" selector need every stream
  // Overlay feeds follow the producer's CHOSEN stream/station: on a multi-station championship the
  // ticker + schedule board must show only THIS station's matches, not every stream. streamName '' =
  // follow all (unchanged). state.startgg.queue stays full so the panel can still switch streams.
  const _wantStream = (state.startgg.streamName || '').trim();
  const scopedQueue = _wantStream ? queue.filter((q) => q && q.stream === _wantStream) : queue;
  // Archive the followed stream's played/on-air matches so the queue's past is browsable after the
  // event. Reset the archive when the EVENT changes (not on series reset — the producer reviews it
  // through the whole event).
  if (state.startgg.archiveEventSlug !== evSlug) { state.startgg.queueArchive = []; state.startgg.archiveEventSlug = evSlug; }
  archiveStartggFromPoll(scopedQueue, recentSets);
  // Include the on-air set in the feed too — it's the LIVE match, and the ticker should show it
  // (previously excluding state.startgg.setId meant a single-stream event's only live match was
  // filtered out, leaving the ticker showing FINAL results only).
  state.startgg.matchFeed = buildStartggMatchFeed(scopedQueue, recentSets);
  // Stamp the feed with the event it was built for. The feed is only ever rewritten by a SUCCESSFUL
  // poll, so without a stamp there is no way to tell a current feed from one left behind by the
  // previous event after a failed poll — see pruneStaleMatchFeed().
  state.startgg.matchFeedEventSlug = evSlug;
  ensureOnAirLiveInFeed();   // force the pushed on-air match to appear as LIVE
  if (state.ticker.source === 'startgg') state.ticker.feed = formatTickerFeed(state.startgg.matchFeed);
  // Event-queue mode: keep the upcoming/schedule board following the stream queue, adding a couple of
  // non-stream upcoming matches. (Team mode leaves upcoming.matches to the last team search.)
  if (state.upcoming.source === 'event') state.upcoming.matches = buildEventUpcomingExtras(scopedQueue, recentSets);
  state.startgg.queueFetchedAt = new Date().toISOString();
  state.startgg.connected = true;
  state.startgg.lastError = null;
  broadcastFullState();
  return { streams, count: queue.length };
}

// Fetch a team's upcoming sets from start.gg without needing tournament-admin access.
async function fetchTeamQueue(teamName, tournamentSlug) {
  if (!startggApiToken) throw new Error('No start.gg API token yet. Add it under Apps > start.gg.');
  const slug = (tournamentSlug || state.startgg.tournamentSlug || '').trim()
    .replace(/^https?:\/\/(www\.)?start\.gg\//i, '')
    .replace(/^tournament\//i, '').split('/')[0];
  if (!slug) throw new Error('Enter a tournament URL or slug.');
  if (!teamName) throw new Error('Enter a team name.');
  const client = createStartGgClient(startggApiToken);
  // Entrant has no direct `sets` field in start.gg's schema — sets live on Event and must be
  // filtered by entrantIds, which we only know after resolving the matching entrants. Two-step:
  // 1) find entrants matching the team name per event, 2) fetch that event's sets filtered to them.
  const entrantsQuery = `query TeamEntrants($slug: String!, $name: String!) {
    tournament(slug: $slug) {
      events {
        id
        name
        entrants(query: { filter: { name: $name }, perPage: 8 }) { nodes {
          id name
        }}
      }
    }
  }`;
  const eRes = await client.request(entrantsQuery, { slug: `tournament/${slug}`, name: teamName });
  const events = eRes?.tournament?.events || [];
  const raw = [];
  const allEntrants = [];
  for (const ev of events) {
    const entrantIds = (ev.entrants?.nodes || []).map(e => e.id).filter((id) => id != null);
    if (!entrantIds.length) continue;
    // Pull full participant data (gamerTag, country, images, socials) per entrant — not just
    // name/logo — so both teams in every queued match get merged into the team/player library
    // the same way a full event import would, and overlay scenes have what they need to render.
    const setsQuery = `query TeamSets($eventId: ID!, $entrantIds: [ID]) {
      event(id: $eventId) {
        sets(filters: { entrantIds: $entrantIds }, perPage: 20) { nodes {
          id fullRoundText state
          slots {
            entrant {
              id name initialSeedNum
              participants { gamerTag prefix player { id prefix user { slug name images { url type } authorizations { type externalUsername } location { country } } } }
              team { images { url type } }
            }
            standing { stats { score { value } } }
          }
        }}
      }
    }`;
    const sRes = await client.request(setsQuery, { eventId: ev.id, entrantIds });
    const sets = sRes?.event?.sets?.nodes || [];
    for (const set of sets) {
      if (set.state === 3) continue;
      const slots = set.slots || [];
      const ents = slots.map(s => s?.entrant).filter(Boolean);
      allEntrants.push(...ents);
      raw.push({
        setId: String(set.id),
        stream: ev.name || '',
        round: set.fullRoundText || '',
        state: set.state,
        teamA: ents[0]?.name || 'TBD',
        teamB: ents[1]?.name || 'TBD',
        scoreA: slots[0]?.standing?.stats?.score?.value ?? null,
        scoreB: slots[1]?.standing?.stats?.score?.value ?? null,
        slots,
        live: set.state === 2
      });
    }
  }
  const seen = new Set();
  const deduped = raw.filter(q => !seen.has(q.setId) && seen.add(q.setId));
  deduped.sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0));
  // mergeEntrantsIntoLibrary populates savedTeams rosters + playerProfiles (country/twitch/image)
  // and also overwrites state.startgg.eventTeams — but here we've only seen the queued team's
  // opponents, not the full event, so union it back with whatever picker list already existed
  // instead of shrinking it.
  const prevEventTeams = state.startgg.eventTeams || [];
  mergeEntrantsIntoLibrary(allEntrants);
  if (prevEventTeams.length) {
    const byName = new Map(prevEventTeams.map(t => [t.name, t]));
    (state.startgg.eventTeams || []).forEach(t => byName.set(t.name, t));
    state.startgg.eventTeams = [...byName.values()];
  }
  deduped.forEach(q => { q.logoA = logoForTeamName(q.teamA); q.logoB = logoForTeamName(q.teamB); });
  state.startgg.teamQueue = deduped;
  state.startgg.focusTeam = teamName;
  state.upcoming.source = 'team';   // upcoming/schedule board now follows this team's matches
  state.upcoming.matches = deduped.map(q => ({
    id: q.setId, setId: q.setId, round: q.round || '',
    teamA: q.teamA || 'TBD', teamB: q.teamB || 'TBD',
    teamALogo: q.logoA || '', teamBLogo: q.logoB || '',
    date: '', time: '', stream: !!q.live, state: q.state, live: !!q.live,
    scoreA: q.scoreA ?? null, scoreB: q.scoreB ?? null,
    week: '', note: ''
  }));
  saveAppState();
  broadcastFullState();
  return { count: deduped.length };
}

// Grace period before auto-follow hands the scoreboard to the NEXT match once the on-air set
// stops looking live. start.gg drops a set off the stream queue the instant a TO reports it, and
// on a Smash station that routinely happens while the set is still playing out on stream (or the
// queue simply flaps for a poll). Advancing runs finalizeAndResetSeries(), so a wrong move wipes
// the live series score. So the handover waits ~45s (two poll ticks) from the last time the match
// on air still looked live; a queue that flaps for one poll never moves the scoreboard at all.
const AUTOFOLLOW_HOLD_MS = 45000;
let _sggOnAirSince = 0;   // last moment the match on air still looked like a live match to us
// Mark the on-air match as ours to protect for the next AUTOFOLLOW_HOLD_MS. Called every poll the
// match is still on the queue unreported, and on a manual push (the producer's own pick gets the
// same protection, even for a set that isn't on the queue at all — an Archive re-push, say).
function touchAutoFollowHold() {
  _sggOnAirSince = Date.now();
  if (state.startgg) state.startgg.autoFollowHold = null;   // not holding anything back right now
}
function resetAutoFollowHold() {
  _sggOnAirSince = 0;
  if (state.startgg) state.startgg.autoFollowHold = null;
}
// True = keep the current match on air for now. Nothing on air (or a match we never saw live, e.g.
// straight after a restart) hands over immediately — the hold only protects a match we watched go live.
function autoFollowHeld(nextSetId) {
  if (!state.startgg.lastPushedSetId || !_sggOnAirSince) { resetAutoFollowHold(); return false; }
  if (Date.now() - _sggOnAirSince < AUTOFOLLOW_HOLD_MS) {
    state.startgg.autoFollowHold = { setId: state.startgg.lastPushedSetId, nextSetId: String(nextSetId || ''), since: _sggOnAirSince };
    return true;
  }
  resetAutoFollowHold();
  return false;
}

// Stream queue polling — driven by Settings API token + tournament slug + queueEnabled toggle.
let _startggPollTimer = null;
async function startggPollTick() {
  if (!state.startgg.queueEnabled) return;
  if (!startggApiToken) {
    state.startgg.connected = false;
    state.startgg.lastError = 'Missing Start.gg API token (Settings → start.gg)';
    broadcastFullState();
    return;
  }
  const slug = (state.startgg.tournamentSlug || '').trim();
  if (!slug) {
    state.startgg.connected = false;
    state.startgg.lastError = 'Set a tournament slug under Apps > start.gg';
    broadcastFullState();
    return;
  }
  try {
    await fetchStreamQueue(slug);
    if (state.startgg.autoFollow) {
      // Prefer a set start.gg actually marks IN PROGRESS; fall back to the stream's cued-up head
      // (plenty of TOs never flip sets to in-progress). Scoped to the selected stream, and sticky
      // on the match already on air — see pickAutoFollowSet.
      const live = pickAutoFollowSet(state.startgg.queue, state.startgg.streamName, state.startgg.lastPushedSetId);
      const heldBefore = !!state.startgg.autoFollowHold;
      if (live && live.setId && live.setId !== state.startgg.lastPushedSetId && !autoFollowHeld(live.setId)) {
        const pushed = await syncStartGgSet(live.setId);
        if (pushed && pushed.superseded) return;   // the producer pushed a set meanwhile: theirs stands
        state.startgg.lastPushedSetId = live.setId;
        touchAutoFollowHold();     // the match we just put on air is now the one being protected
        ensureOnAirLiveInFeed();   // reflect the newly auto-followed match as LIVE in the ticker
        if (state.ticker.source === 'startgg') state.ticker.feed = formatTickerFeed(state.startgg.matchFeed);
        console.log(`[Start.gg] Auto-followed live set ${live.setId}: ${live.teamA} vs ${live.teamB}`);
        // Tell the producer their scoreboard just changed by itself (auto-follow is silently
        // enabled on event activation — without this it looks like a haunted scoreboard).
        broadcast(bridgeClients, { type: 'autofollow-pushed', data: {
          message: `Auto-follow: now showing ${live.teamA || 'TBD'} vs ${live.teamB || 'TBD'} (live on stream). Series score reset.`
        } });
      } else if (live && live.setId === state.startgg.lastPushedSetId) {
        // The match on air is still the right one (pickAutoFollowSet held it) — keep its protection
        // topped up so the 45s handover clock only ever starts once it stops looking live.
        touchAutoFollowHold();
      }
      // fetchStreamQueue already broadcast this poll's state, so the panel would otherwise learn
      // about a hold starting (or ending) a whole poll late.
      if (!!state.startgg.autoFollowHold !== heldBefore) broadcastFullState();
    }
    await syncBracketToActiveEvent();
    // Real finish order for the linked event. Deliberately OUTSIDE syncBracketToActiveEvent():
    // that function is gated on `bracket.mode !== 'manual'` and has its own big-event throttle,
    // so nesting this call meant a producer running a manual bracket (or a 400+ set event) got
    // no placement refresh at all — which is the one thing this feature exists to do. It only
    // needs startgg.eventSlug, and carries its own ~60s throttle.
    await refreshStartggPlacements();
  } catch (e) {
    state.startgg.connected = false;
    state.startgg.lastError = e.message;
    broadcastFullState();
  }
}
let _standingsMirrorSig = '';
let _startggBracketTick = 0;
let _lastBracketFetchSlug = '';

// The Bracket scene's "Tournament Organizer" source FOLLOWS the active event (Dashboard ▸ Event
// panel) unless the producer typed a different slug into the bracket panel (followActive=false)
// or built a manual bracket — a stale eventSlug here used to re-import the wrong event (e.g. a
// 400-team LCQ) forever. Called on the regular ~20s poll tick AND immediately whenever the active
// start.gg event changes (activateStartggEvent), so switching events in the Dashboard reflects on
// the Bracket scene right away instead of waiting up to 20s for the next tick.
async function syncBracketToActiveEvent() {
  if (state.bracket.mode !== 'manual' && state.bracket.followActive !== false) {
    const activeSlug = (state.startgg.eventSlug || '').trim();
    if (activeSlug && (state.bracket.eventSlug || '').trim() !== activeSlug) {
      console.log(`[Bracket] Following active event: ${activeSlug} (was ${state.bracket.eventSlug || 'none'})`);
      state.bracket.eventSlug = activeSlug;
    }
  }
  if ((state.bracket.eventSlug || '').trim() && state.bracket.mode !== 'manual') {
    // Scale-aware cadence: small events refresh every tick (~20s); major-scale ones
    // (hundreds of sets) every 3rd tick (~60s) so a 1500-set fetch isn't back-to-back.
    // A slug change always fetches immediately regardless of the throttle.
    const slugChanged = state.bracket.eventSlug !== _lastBracketFetchSlug;
    const bigEvent = (state.bracket.matches || []).length > 400;
    _startggBracketTick++;
    if (!slugChanged && bigEvent && _startggBracketTick % 3 !== 0) return;
    _lastBracketFetchSlug = state.bracket.eventSlug;
    try { await fetchBracket(state.bracket.eventSlug); } catch (e) { /* non-fatal */ }
    // start.gg-sourced standings mirror the live event standings each refresh, so the
    // standings overlay updates as scores come in (manual/league rows are never touched).
    if ((state.standings?.source || '') === 'startgg' && (state.bracket.standings || []).length) {
      const mirrorSig = JSON.stringify(state.bracket.standings.map((r) => [r.placement, r.name, r.wins, r.losses]));
      if (mirrorSig !== _standingsMirrorSig) {
        _standingsMirrorSig = mirrorSig;
        state.standings.rows = state.bracket.standings.map((r) => ({ ...r }));
        broadcastFullState();
      }
    }
  }
}

// Fighter name registry, shared with the overlays. Loaded defensively: it is a browser-first
// script and a failure here must not take the server down.
let smashFighters = null;
try { smashFighters = require('./overlay/smash-fighters.js').SmashFighters || null; }
catch (e) { console.warn('[Smash] fighter registry unavailable:', e.message); }

// Marvel Tokon board position (overlay/tokon.html), set in Match ▸ Teams ▸ Marvel Tokon ▸ Position.
// Pixels on the 1920x1080 frame; the defaults line the board up with Tokon's own HUD. Unknown keys
// are dropped and every value is clamped, so a bad input can't push the board off screen.
// A function DECLARATION on purpose: the state literal calls it before this line is reached.
function normalizeTokonLayout(raw) {
  const LIMITS = {                       // key: [default, min, max]
    top: [2, 0, 400], w: [1140, 800, 1700], gutter: [340, 200, 700],
    spony: [1017, 0, 1060], sponw: [130, 60, 400], barlift: [0, 0, 400]
  };
  const src = (raw && typeof raw === 'object') ? raw : {};
  const out = {};
  Object.keys(LIMITS).forEach((k) => {
    const [d, lo, hi] = LIMITS[k];
    const n = Number(src[k]);
    out[k] = (src[k] == null || src[k] === '' || !isFinite(n)) ? d : Math.max(lo, Math.min(hi, Math.round(n)));
  });
  return out;
}

let _placementsTick = 0;
let _placementsSig = '';
// Pull the linked event's finish order and, when the board on air is following it, re-mirror the
// rows so a top 8 updates itself as the bracket resolves instead of freezing at push time.
async function refreshStartggPlacements() {
  const slug = (state.startgg.eventSlug || '').trim();
  if (!slug || !startggApiToken) return;
  const slugChanged = slug !== state.startggPlacements.slug;
  _placementsTick++;
  if (!slugChanged && _placementsTick % 3 !== 0) return;
  try {
    const r = await fetchEventPlacements(startggApiToken, slug, 32);
    state.startggPlacements = { slug, rows: r.rows, complete: r.complete, fetchedAt: Date.now(), error: '' };
  } catch (e) {
    const prevErr = state.startggPlacements.error;
    state.startggPlacements = { ...state.startggPlacements, slug, error: e.message, fetchedAt: Date.now() };
    // Broadcast only on a CHANGE of error, so a persistent failure doesn't push state every 60s.
    if (prevErr !== e.message) broadcastFullState();
    return;
  }
  const sig = JSON.stringify(state.startggPlacements.rows.map((r) => [r.placement, r.name]));
  const orderChanged = sig !== _placementsSig;
  _placementsSig = sig;

  // Auto-fill each finisher's fighter from start.gg's reported character selections.
  //
  // Deliberately OUTSIDE the "did the order change" early-return this used to sit behind: that
  // made a failed or empty character scan permanent, because once the finish order settled the
  // sig never moved again and the scan never re-ran. Retry whenever we still have nothing, so a
  // transient error — or characters reported after the placements settled — is picked up on a
  // later tick. Once every finisher has a fighter it stops scanning.
  const top = state.startggPlacements.rows.slice(0, 8);
  const filled = top.filter((r) => (r.character || '').trim()).length;
  // The two entrants currently on the scoreboard ride along in the SAME scan — the matchup card
  // wants their character too, and they are usually deep in the bracket rather than in the top 8
  // while the event is still running.
  const liveIds = ['blue', 'orange'].map((k) => String((state.teams[k] || {}).entrantId || '')).filter(Boolean);
  const liveMissing = liveIds.length && !(state.startggCharacters.blue && state.startggCharacters.orange);
  if (smashFighters && (top.length || liveIds.length) && (orderChanged || filled < top.length || liveMissing)) {
    const wantIds = top.map((r) => r.entrantId).concat(liveIds);
    const res = await fetchEventCharacters(startggApiToken, slug, wantIds, 3);
    top.forEach((r) => { const c = res.map.get(String(r.entrantId)); if (c) r.character = c; });
    ['blue', 'orange'].forEach((k) => {
      const id = String((state.teams[k] || {}).entrantId || '');
      const c = id && res.map.get(id);
      if (c) state.startggCharacters[k] = c;
    });
    state.startggCharacters.fetchedAt = Date.now();
    state.startggPlacements.reportedCharacters = top.filter((r) => (r.character || '').trim()).length;
    state.startggPlacements.charError = res.error || '';
    state.startggPlacements.charShape = res.shape || '';
    state.startggPlacements.setsScanned = res.scanned || 0;
    if (res.error) console.warn('[Smash] character pull:', res.error, '(sets scanned:', res.scanned + ')');
  }
  if (!orderChanged && !state.startggPlacements.charError) { broadcastFullState(); return; }
  // A board pushed from this source keeps following it. Producer-entered fighters are keyed by
  // entrant name, so re-mirroring must PRESERVE them — otherwise every poll would wipe the
  // character art off a top 8 the producer had just finished assigning.
  if ((state.standings.source || '') === 'startgg-placements') {
    const keep = {};
    (state.standings.rows || []).forEach((r) => { if (r && r.name) keep[String(r.name).toLowerCase()] = r; });
    state.standings.rows = state.startggPlacements.rows.slice(0, 8).map((r) => {
      const prev = keep[String(r.name).toLowerCase()] || {};
      // A fighter the producer set by hand outranks the reported one — they are watching the
      // match and start.gg's report can be missing, stale or just wrong.
      return { ...prev, placement: r.placement, name: r.name,
               players: (r.players && r.players.length) ? r.players : (prev.players || []),
               countryCode: r.countryCode || prev.countryCode || '',
               character: prev.character || r.character || '' };
    });
  }
  broadcastFullState();
}

function setStartggQueuePolling(enabled) {
  state.startgg.queueEnabled = !!enabled;
  if (_startggPollTimer) { _startggPollTimer.stop(); _startggPollTimer = null; }
  if (state.startgg.queueEnabled && startggApiToken && (state.startgg.tournamentSlug || '').trim()) {
    _startggPollTimer = pollLoop('startgg-queue', startggPollTick, 20000, { runNow: true });
  }
  saveAppState();
  broadcastFullState();
}

function applyStartggAutomation() {
  const ready = state.startgg.enabled && startggApiToken && (state.startgg.tournamentSlug || '').trim();
  if (ready && state.startgg.queueEnabled) {
    setStartggQueuePolling(true);
  } else if (!state.startgg.queueEnabled) {
    setStartggQueuePolling(false);
  }
}

function setStartggAutoFollow(enabled) {
  state.startgg.autoFollow = !!enabled;
  state.startgg.autoFollowChosen = true;   // producer has an opinion now — event activation must respect it
  saveAppState();
  broadcastFullState();
}

// ─── Google Sheets integration ────────────────────────────────────────────────
// (moved to backend/platforms/sheets.js)
const { applySheetsAutoSync, brWriteSheetTemplate, sheetsConnect, syncSheets } = require('./backend/platforms/sheets')({
  get sheetsServiceAccount() { return sheetsServiceAccount; },
  get savedTeams() { return savedTeams; },
  get leaguesVer() { return leaguesVer; },
  set_leaguesVer(v) { leaguesVer = v; },
  sheets, state, saveTeams, pollLoop, saveAppState, brPointsFor, brBinding, brSyncFromLeague, recomputeBrSeason, computeBrStandings, broadcastFullState
});
// ─── Challonge integration ───────────────────────────────────────────────────
// (moved to backend/platforms/challonge.js)
const { challongePlacements, pushEntrantToSide, setChallongePolling, loadChalongeTournament, refreshChallongeLive, challongePartMap } = require('./backend/platforms/challonge')({
  get challongeApiKey() { return challongeApiKey; },
  get savedTeams() { return savedTeams; },
  get setActivePlatform() { return setActivePlatform; },
  https, createChallongeClient, GAMES, state, saveTeams, adoptEventGame, pollLoop, saveAppState, get retuneRoundLabel() { return retuneRoundLabel; }, get syncActiveBracketPhase() { return syncActiveBracketPhase; }, get adoptEventName() { return adoptEventName; }, broadcastFullState
});
// ─── Challengermode integration ──────────────────────────────────────────────
// (moved to backend/platforms/challengermode.js)
const { challengermodeClient, setChallengermodePolling, loadChallengermodeTournament, refreshChallengermodeLive, fetchChallengermodeTournament } = require('./backend/platforms/challengermode')({
  get challengermodeRefreshKey() { return challengermodeRefreshKey; },
  get savedTeams() { return savedTeams; },
  get setActivePlatform() { return setActivePlatform; },
  https, createChallengermodeClient, get parseChallengermodeId() { return parseChallengermodeId; }, cmData, state, saveTeams, adoptEventGame, pollLoop, saveAppState, pushEntrantToSide, get retuneRoundLabel() { return retuneRoundLabel; }, get syncActiveBracketPhase() { return syncActiveBracketPhase; }, get adoptEventName() { return adoptEventName; }, broadcastFullState
});
// ─── Challonge real-time match sync ──────────────────────────────────────────
// (moved to backend/platforms/challonge-sync.js)
const { syncAllLinkedChallongeTournaments, buildChallongeParticipantMap, syncLinkedChallongeTournament, resolveChallongeParticipant } = require('./backend/platforms/challonge-sync')({
  get challongeApiKey() { return challongeApiKey; },
  createChallongeClient, state, saveAppState, touchMyEvents, broadcastFullState
});
// ─── NXGEN integration ────────────────────────────────────────────────────────
// (moved to backend/platforms/nxgen-faceit.js)
const { setNxgenPolling, setActivePlatform, refreshMyEvent, refreshAllMyEvents, startMyEventsAutoSync, setFaceitPolling, loadNxgenEvent, refreshNxgenLive, loadFaceitCompetition, refreshFaceitLive } = require('./backend/platforms/nxgen-faceit')({
  get startggApiToken() { return startggApiToken; },
  get nxgenApiKey() { return nxgenApiKey; },
  get faceitApiKey() { return faceitApiKey; },
  https, getNxgenEventLive, faceit, state, adoptEventGame, pollLoop, saveAppState, touchMyEvents, upsertPlayerProfile, finalizeAndResetSeries, formatTickerFeed, setStartggQueuePolling, setChallongePolling, setChallengermodePolling, get logoForTeamName() { return logoForTeamName; }, get retuneRoundLabel() { return retuneRoundLabel; }, get syncActiveBracketPhase() { return syncActiveBracketPhase; }, get fetchEventSeeding() { return fetchEventSeeding; }, get adoptEventName() { return adoptEventName; }, get pickEventImage() { return pickEventImage; }, broadcastFullState
});
// ─── Start.gg bracket ────────────────────────────────────────────────────────
// (moved to backend/platforms/startgg-bracket.js)
const { _stripStartggWhitespace, parseEventSlug, parseStartggInput, indexEntrantLogos, cleanTeamAbbr, abbrForTeamName, logoForTeamName, swapTeamSides, GENERIC_TEAM_RE, applyGameTeamName, activePlatformSets, platformRoundLabel, retuneRoundLabel, buildPhases, syncActiveBracketPhase, fetchEntrantSeedList, fetchAllEntrants, fetchEventSeeding, fetchEventPlacements, fetchEventCharacters, bracketNormName, bracketNameScore, fetchEntrantTrueSeeds, fetchAllSets } = require('./backend/platforms/startgg-bracket')({
  get startggApiToken() { return startggApiToken; },
  get savedTeams() { return savedTeams; },
  get smashFighters() { return smashFighters; },
  get startggRequestWithBackoff() { return startggRequestWithBackoff; },
  get STARTGG_PAGE_DELAY_MS() { return STARTGG_PAGE_DELAY_MS; },
  get _countryCode() { return _countryCode; },
  get pickEntrantLogo() { return pickEntrantLogo; },
  https, createStartGgClient, teamDb, state, upsertPlayerProfile
});
// ─── Single-team spotlight: deep-dive on one entrant (placement / seed / record / sets) ───
// (moved to backend/platforms/startgg.js)
const { enrichSpotlightSeeding, refreshTeamSpotlight, startTeamSpotlightAutoSync, fetchMyTournaments, fetchTournamentDetail, fetchTournamentEvents, startggPlayerFromParticipant, entrantOrgName, mapEntrantsToTeams, vaultTouch, startggRequestWithBackoff, STARTGG_PAGE_DELAY_MS, fetchBracket, _countryCode, mergeEntrantsIntoLibrary, importStartggTeams, adoptEventName, loadStartggEventTeams, pickEntrantLogo, saveEventTeamToLibrary, applyVaultToLibrary, refreshVaultTeamFromStartgg, importStartggTeamBySlug, vaultEnrichTargets, enrichVaultFromStartgg, propagateVaultCrest, persistMatchCrest, pickEventImage, fetchStartggEventImage, activateStartggEvent, resolveStartggUrl, loadEvent } = require('./backend/platforms/startgg')({
  get startggApiToken() { return startggApiToken; },
  get savedTeams() { return savedTeams; },
  get _gameAdoptedForEventSlug() { return _gameAdoptedForEventSlug; },
  get bridgeClients() { return bridgeClients; },
  set__gameAdoptedForEventSlug(v) { _gameAdoptedForEventSlug = v; },
  https, createStartGgClient, teamDb, state, saveTeams, adoptEventGame, pollLoop, saveAppState, broadcast, upsertPlayerProfile, fetchStreamQueue, resetAutoFollowHold, setStartggQueuePolling, syncAllLinkedChallongeTournaments, setActivePlatform, _stripStartggWhitespace, parseEventSlug, parseStartggInput, indexEntrantLogos, buildPhases, syncActiveBracketPhase, fetchAllEntrants, broadcastFullState
});
// ─── Liquipedia (LPDB v3) ────────────────────────────────────────────────────
// 60 requests per HOUR is the entire allowance, so this never polls. The producer presses
// Refresh; everything else reads the cache. Budget and cache are persisted because the hour keeps
// running across an app restart, and because Liquipedia's terms require re-using cached results.
let _lpBudget = new liquipedia.RateBudget();
let _lpCache = new liquipedia.LiquipediaCache();

function lpCtx() {
  return { apiKey: liquipediaApiKey, cache: _lpCache, budget: _lpBudget, now: Date.now };
}
/** Mirror the live budget into state so the panel can show "41/55 left this hour". */
function lpSyncBudget() {
  state.liquipedia.budgetRemaining = _lpBudget.remaining();
  state.liquipedia.budgetResetInMs = _lpBudget.retryAfterMs();
}
/** Every precondition Liquipedia's terms put on us, in one place. */
function lpReady() {
  if (!state.liquipedia.enabled) return 'Liquipedia is off — enable it in Settings ▸ Integrations.';
  if (!liquipediaApiKey) return 'No Liquipedia API key. Access is not self-service — request one from Liquipedia, then paste it under Apps > Liquipedia.';
  if (!String(state.liquipedia.contact || '').trim()) return 'Liquipedia requires a contact (email or URL) in the User-Agent so they can reach the key holder. Add one under Apps > Liquipedia.';
  return null;
}

/** One cache-first pull. `force` is the producer pressing Refresh; it still respects the budget. */
async function lpQuery(datapoint, params, force) {
  const blocked = lpReady();
  if (blocked) throw new Error(blocked);
  const res = await liquipedia.queryCached(lpCtx(), datapoint, params, {
    force: !!force,
    contact: state.liquipedia.contact
  });
  lpSyncBudget();
  state.liquipedia.lastFetchAt = new Date().toISOString();
  state.liquipedia.lastError = res.error || null;
  return res;
}

// The four datapoints the producer asked for. Datapoint NAMES follow Liquipedia's documented
// LPDB tables; the response FIELD names are only published to approved key holders, which is why
// the normalisers probe several spellings rather than assuming one.
async function lpFetchStandings(tournamentPage, force) {
  const res = await lpQuery('standingsentry', {
    wiki: state.liquipedia.wiki,
    conditions: tournamentPage ? '[[parent::' + tournamentPage + ']]' : '',
    limit: 40, order: 'placement ASC'
  }, force);
  state.liquipedia.standings = liquipedia.normaliseStandings(res.data);
  return { rows: state.liquipedia.standings, fromCache: res.fromCache, stale: !!res.stale, ageMs: res.ageMs };
}
async function lpFetchRankings(force) {
  const res = await lpQuery('teamranking', { wiki: state.liquipedia.wiki, limit: 40, order: 'rank ASC' }, force);
  state.liquipedia.rankings = liquipedia.normaliseStandings(res.data);
  return { rows: state.liquipedia.rankings, fromCache: res.fromCache, stale: !!res.stale, ageMs: res.ageMs };
}
async function lpFetchSquad(teamPage, force) {
  const res = await lpQuery('squadplayer', {
    wiki: state.liquipedia.wiki,
    conditions: teamPage ? '[[teampagename::' + teamPage + ']]' : '',
    limit: 40
  }, force);
  state.liquipedia.squad = liquipedia.rowsOf(res.data);
  return { rows: state.liquipedia.squad, fromCache: res.fromCache, stale: !!res.stale, ageMs: res.ageMs };
}
async function lpFetchTournament(tournamentPage, force) {
  const res = await lpQuery('tournament', {
    wiki: state.liquipedia.wiki,
    conditions: tournamentPage ? '[[pagename::' + tournamentPage + ']]' : '',
    limit: 1
  }, force);
  state.liquipedia.tournament = liquipedia.rowsOf(res.data)[0] || null;
  return { row: state.liquipedia.tournament, fromCache: res.fromCache, stale: !!res.stale, ageMs: res.ageMs };
}

// ─── CS2 Game State Integration ──────────────────────────────────────────────
const GSI_TOKEN = 'ne-broadcast-suite';
const GSI_CFG = `"NE Broadcast Suite GSI"
{
  "uri"       "http://localhost:${HTTP_PORT}/gsi"
  "timeout"   "5.0"
  "buffer"    "0.1"
  "throttle"  "0.1"
  "heartbeat" "10.0"
  "auth"
  {
    "token" "${GSI_TOKEN}"
  }
  "data"
  {
    "provider"                "1"
    "map"                     "1"
    "round"                   "1"
    "player_id"               "1"
    "player_state"            "1"
    "player_weapons"          "1"
    "player_match_stats"      "1"
    "player_position"         "1"
    "allplayers_id"           "1"
    "allplayers_state"        "1"
    "allplayers_match_stats"  "1"
    "allplayers_weapons"      "1"
    "allplayers_position"     "1"
    "bomb"                    "1"
    "phase_countdowns"        "1"
    "allgrenades"             "1"
  }
  "output"
  {
    "precision_time"      "3"
    "precision_position"  "2"
    "precision_vel"       "2"
  }
}
`;

// Parse a GSI "x, y, z" position string into {x, y} world coords (for the radar).
function parseVec(str) {
  if (typeof str !== 'string') return null;
  const a = str.split(',').map((s) => parseFloat(s));
  if (a.length < 2 || isNaN(a[0]) || isNaN(a[1])) return null;
  // z (height) decides which radar level a position is on — Nuke, Vertigo, Train and Palais
  // have stacked levels, and a lower-level player drawn on the upper map is simply wrong.
  return isNaN(a[2]) ? { x: a[0], y: a[1] } : { x: a[0], y: a[1], z: a[2] };
}

// Normalise the GSI 'grenades' block into radar markers. Smokes/infernos persist;
// frag/flash/decoy are mostly in-flight. Inferno (fire) reports a 'flames' set
// rather than a single position, so we use the centroid of the flames.
function parseGrenades(grenades) {
  const out = [];
  // `id` is the GSI grenade key, stable for the grenade's life, so the overlay radar can keep
  // one marker per grenade instead of rebuilding them every tick.
  Object.keys(grenades || {}).forEach((id) => {
    const g = grenades[id] || {};
    const type = g.type || '';
    if ((type === 'inferno' || type === 'firebomb') && g.flames) {
      const pts = Object.values(g.flames).map(parseVec).filter(Boolean);
      if (pts.length) {
        const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
        const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
        out.push({ id, type: 'inferno', x: cx, y: cy });
      }
    } else {
      const p = parseVec(g.position);
      if (p) out.push({ id, type, x: p.x, y: p.y, effecttime: g.effecttime !== undefined ? Number(g.effecttime) : null });
    }
  });
  return out;
}

// Grenades in the order a caster reads a loadout (the same order JT's HUD uses), so the
// icon row holds still instead of following GSI's arbitrary slot order.
const CS_NADE_ORDER = ['smokegrenade', 'hegrenade', 'molotov', 'incgrenade', 'flashbang', 'decoy'];
const CS_NADE_LIMIT = { flashbang: 2 };   // every other grenade is one per player
// Item types that are never a player's primary gun. Zeus is matched by name instead —
// its GSI entry doesn't carry a dependable type.
const CS_NOT_PRIMARY = new Set(['C4', 'Pistol', 'Knife', 'Grenade', 'StackableItem', 'Melee']);

// Pull the loadout from a GSI weapons object. `weapon` stays the ACTIVE item (+ its ammo) —
// firing detection and the killfeed depend on that. `primary`/`secondary`/`hasTaser` are what
// the player OWNS: overlays show those, because in freezetime everyone runs with a knife out
// and an active-weapon board turns into a row of knives.
function parseWeapons(weapons) {
  const out = { weapon: '', clip: null, reserve: null, nades: [], hasBomb: false,
                primary: '', secondary: '', hasTaser: false, activeNade: '',
                clips: {} };   // every carried gun's magazine, active or not → which gun just fired
  const nadeCount = {};
  Object.keys(weapons || {}).forEach((slot) => {
    const w = weapons[slot] || {};
    const name = (w.name || '').replace('weapon_', '');
    if (!name) return;
    const type = w.type || '';
    if (type === 'C4') out.hasBomb = true;
    else if (type === 'Grenade') {
      // Two flashbangs can arrive as ONE entry with ammo_reserve 2 — count both.
      nadeCount[name] = (nadeCount[name] || 0) + Math.max(1, Number(w.ammo_reserve) || 0);
      if (w.state === 'active') out.activeNade = name;
    }
    else if (name === 'taser') out.hasTaser = true;
    else if (type === 'Pistol') { if (!out.secondary) out.secondary = name; }
    else if (type && !CS_NOT_PRIMARY.has(type)) { if (!out.primary) out.primary = name; }
    if (typeof w.ammo_clip === 'number' && type !== 'Grenade' && type !== 'C4' && type !== 'Knife' && type !== 'Melee') out.clips[name] = w.ammo_clip;
    if (w.state === 'active') {
      out.weapon = name;   // raw GSI base name (lowercase), e.g. "ak47", "m4a1_silencer"
      if (w.ammo_clip !== undefined) out.clip = w.ammo_clip;
      if (w.ammo_reserve !== undefined) out.reserve = w.ammo_reserve;
    }
  });
  // Raw base names → the overlay renders the SVGs. Known grenades in reading order (clamped
  // to what the game allows), then anything unrecognised once, so nothing is dropped.
  CS_NADE_ORDER.forEach((n) => {
    for (let i = Math.min(nadeCount[n] || 0, CS_NADE_LIMIT[n] || 1); i > 0; i--) out.nades.push(n);
  });
  Object.keys(nadeCount).forEach((n) => { if (!CS_NADE_ORDER.includes(n)) out.nades.push(n); });
  return out;
}

let csgoStaleTimer = null;

// ─── Dota 2 Game State Integration ──────────────────────────────────────────────
const dotaGsi = require('./backend/dota-gsi');
const DOTA_GSI_TOKEN = 'ne-broadcast-suite-dota';
let _dotaStaleT = null, _dotaBcastT = null, _dotaBcastAt = 0, _dotaFirstPick = '', _dotaMatch = '';
// HUD ticks ride a partial state_update (the HUD opts in with SceneBase.liveUpdates('dota')), at most
// four a second; connect / disconnect and draft changes go out as a full state.
function broadcastDota() {
  const send = () => { _dotaBcastT = null; _dotaBcastAt = Date.now(); broadcast(bridgeClients, { type: 'state_update', data: { dota: state.dota } }); };
  const wait = 250 - (Date.now() - _dotaBcastAt);
  if (wait <= 0) send(); else if (!_dotaBcastT) _dotaBcastT = setTimeout(send, wait);
}
// The in-game Captains Mode draft, mirrored onto the Pick & Ban board while Dota 2 is the active game.
// Radiant / Dire map to the app's sides by state.dota.radiantSide; the first-pick team is the side
// on the clock when the draft starts (remembered per match, so joining late still works).
function dotaMirrorDraft(dr, matchId) {
  if (!state.dota.autoDraft || state.activeGame !== 'dota2' || !dr) return false;
  const sideOf = state.dota.radiantSide === 'b' ? { a: 'dire', b: 'radiant' } : { a: 'radiant', b: 'dire' };
  const appSide = (team) => (sideOf.a === team ? 'a' : 'b');
  if (matchId !== _dotaMatch) { _dotaMatch = matchId; _dotaFirstPick = ''; }
  const made = dr.radiant.picks.length + dr.radiant.bans.length + dr.dire.picks.length + dr.dire.bans.length;
  if (!_dotaFirstPick && made === 0 && dr.activeTeam) _dotaFirstPick = appSide(dr.activeTeam);
  if (!_dotaFirstPick && made > 0) {
    // Joined mid-draft: Captains Mode opens with two first-pick bans, so whoever has more bans led.
    const ra = dr.radiant.bans.length, di = dr.dire.bans.length;
    if (ra !== di) _dotaFirstPick = appSide(ra > di ? 'radiant' : 'dire');
  }
  const teamStart = _dotaFirstPick || (state.draft && state.draft.teamStart) || 'a';
  if (!state.draft || state.draft.game !== 'dota2' || state.draft.teamStart !== teamStart || !(state.draft.sequence || []).length) {
    draftStart({ game: 'dota2', teamStart });
  }
  const d = state.draft;
  const ops = dotaGsi.draftOps(d.sequence, dr, sideOf).map((o) => {
    const hero = draftData.roster('dota2').find((c) => c.id === o.hero);
    return { name: hero ? hero.name : o.hero, action: o.action, by: o.by, image: hero ? hero.image : '' };
  });
  const sig = JSON.stringify(ops);
  if (sig === JSON.stringify((d.ops || []).map((o) => ({ name: o.name, action: o.action, by: o.by, image: o.image })))) return false;
  d.ops = ops;
  rebuildDraftTurn();
  return true;
}
function handleDotaGsi(body) {
  const live = dotaGsi.parse(body);
  // Display names from the hero roster (Valve's internal names are not what is on screen).
  const roster = draftData.roster('dota2');
  ['radiant', 'dire'].forEach((t) => (live.players[t] || []).forEach((p) => { const h = roster.find((c) => c.id === p.hero); p.heroName = h ? h.name : p.hero.replace(/-/g, ' '); }));
  const wasConnected = state.dota.connected;
  state.dota.connected = true;
  state.dota.lastUpdate = Date.now();
  state.dota.live = live;
  if (_dotaStaleT) clearTimeout(_dotaStaleT);
  _dotaStaleT = setTimeout(() => { state.dota.connected = false; broadcastFullState(); }, 30000);
  let full = !wasConnected;
  if (live.draft && dotaMirrorDraft(live.draft, live.map.matchId)) full = true;
  if (full) broadcastFullState(); else broadcastDota();
}

function markCsgoActivity() {
  state.csgo.connected = true;
  state.csgo.lastUpdate = Date.now();
  if (csgoStaleTimer) clearTimeout(csgoStaleTimer);
  csgoStaleTimer = setTimeout(() => {
    if (state.csgo.connected) try { analytics.event('disconnect', { what: 'CS2 GSI' }); } catch (e) {}
    state.csgo.connected = false;
    // The next GSI frame after a gap (restart, alt-tab, network) re-baselines the killfeed instead
    // of diffing against the frame before the gap, which minted a burst of phantom kill rows and
    // cs2_kill / cs2_ace flow triggers.
    killPrev = null;
    broadcastCsgo();
  }, 15000);
}

function broadcastCsgo() {
  broadcast(bridgeClients, { type: 'csgo_update', data: state.csgo });
}

// ── CS2 scripted freezetime camera (network console) ──
// Last player the observer was on (slot), so the camera can hand back to them after the shots.
let _csLastObsSlot = null;
const cs2Netcon = createNetcon({
  onStatus: (status, detail) => {
    state.csgo.cinematic.status = status; state.csgo.cinematic.statusDetail = detail;
    if (status === 'connected') _csHudSpec = null;   // the next GSI tick sets the HUD for whatever the client is doing
    broadcastCsgo();
  }
});
const cs2Cinematic = createCinematic({
  netcon: cs2Netcon,
  getConfig: () => state.csgo.cinematic,
  onStatus: (s) => { state.csgo.cinematic.playing = s && s.playing ? { shot: s.shot, name: s.name } : null; broadcastCsgo(); },
  // Back to a player before the round goes live: the Director's pick if it has one, else whoever
  // the observer was on before freezetime. Observer slot keys are the proven way to land in-eye.
  onReturn: () => {
    if (aiShielded()) return;
    const prim = state.director && state.director.primary && state.director.primary.target;
    const p = prim && (state.csgo.players || []).find((x) => x.steamid === prim.id);
    const slot = p && p.slot != null && p.slot <= 9 ? p.slot : _csLastObsSlot;
    if (slot != null && slot >= 0 && slot <= 9) autoSwitch.sendKey(String((slot + 1) % 10));
  }
});
// The CS2 console link (-netconport) runs while scripted freezetime cameras are on, or while CS2 is
// the active game with the automatic observer HUD on. Off otherwise (it would only retry forever).
function csCinematicApply() {
  const c = state.csgo.cinematic;
  if (!c.enabled) cs2Cinematic.stop();
  if (c.enabled || (state.csgo.autoHud !== false && state.activeGame === 'csgo')) cs2Netcon.start(c.port); else cs2Netcon.stop();
}
// Automatic observer HUD: the moment GSI shows the client spectating (allplayers arrives), hide CS2's
// own HUD and crosshair over the console; when it is playing again, put them back. Only on a change,
// so a producer who flips it by hand (F9) is not fought every tick.
// Radar position/size from the panel: whole pixels on the 1920x1080 canvas, kept on screen.
function cleanRadarLayout(l) {
  if (!l || typeof l !== 'object') return null;
  const size = Math.round(Math.max(160, Math.min(800, Number(l.size) || 380)));
  const x = Math.round(Math.max(0, Math.min(1920 - size, Number(l.x) || 0)));
  const y = Math.round(Math.max(0, Math.min(1080 - size, Number(l.y) || 0)));
  return { x, y, size };
}
let _csHudSpec = null;
// cl_obs_interp_enable 0: switching players is a hard cut, not CS2's camera glide between them.
const CS_HUD_CLEAN = 'cl_drawhud 0; crosshair 0; cl_obs_interp_enable 0';
const CS_HUD_NORMAL = 'cl_drawhud 1; crosshair 1';
function csAutoHud(payload) {
  if (state.csgo.autoHud === false || !cs2Netcon.isConnected()) return;
  const spec = cs2Setup.isSpectating(payload);
  if (spec === _csHudSpec) return;
  _csHudSpec = spec;
  cs2Netcon.send(spec ? CS_HUD_CLEAN : CS_HUD_NORMAL);
  logAuto('cs2', spec ? 'Spectating: hid the CS2 HUD and crosshair' : 'Playing: CS2 HUD and crosshair back on');
}

// ── Valorant live data — Overwolf GEP relay ──────────────────────────
// Fed by POST /api/val-gep from companion-overwolf, the same relay already carrying Overwatch,
// Marvel Rivals and R6. See backend/integrations/valorant-gep.js for the field-by-field contract
// and, importantly, for what Valorant does NOT expose (per-player health, utility charges).
//
// This replaced a poller aimed at https://127.0.0.1:2999/liveclientdata/allgamedata. That port is
// the LEAGUE client's; Valorant never served it, so the HUD could not connect — and with League
// running on the same PC the poll SUCCEEDED and fed League data into a Valorant scoreboard.

function broadcastValorant() {
  broadcast(bridgeClients, { type: 'valorant_update', data: state.valorant });
}

// The relay posts on a 1.5s cadence. Three missed beats and the game (or the relay) is gone —
// the HUD then shows its "not detected" badge rather than freezing on the last live round.
const VAL_GEP_STALE_MS = 6000;
let _valStaleTimer = null;

function applyValorantGep(body) {
  state.valorant = valGep.applyGepUpdate(state.valorant, body);
  try { _valorantStats(state.valorant); } catch (e) {}
  broadcastValorant();
}

// Valorant has no map.phase signal like CS2's GSI, so we derive the game
// lifecycle from the live scoreline: a fresh live game with players present
// opens a stats game; reaching 13 with a 2-round lead closes it (once).
function _valorantStats(v) {
  const o = v.order.score || 0, c = v.chaos.score || 0;
  const gameOver = (o >= 13 || c >= 13) && Math.abs(o - c) >= 2;
  const live = v.connected && v.map && v.map.name && (v.players || []).length > 0;
  const mapName = v.map.displayName || v.map.name || '';

  // New game: a live game in progress with no stats game already open.
  if (live && !statsValGameId && !gameOver) {
    if (!statsCurrentMatchId) {
      statsCurrentMatchId = stats.startMatch({
        gameType: 'valorant',
        teamA: state.teams?.blue?.name || 'Team A',
        teamB: state.teams?.orange?.name || 'Team B',
        bestOf: state.bestOf,
        startggSetId: state.startgg?.setId || null,
        tournament: state.startgg?.selectedEvent?.tournamentName || null
      });
    }
    statsValGameId = stats.startGame({
      matchId: statsCurrentMatchId,
      gameNumber: state.game?.number || 1,
      gameType: 'valorant',
      map: mapName
    });
  }

  // Game over: finalize once, then wait for the next map to reset the scoreline.
  if (statsValGameId && gameOver) {
    stats.endGame(statsValGameId, {
      scoreA: o, scoreB: c,
      winner: o > c ? 'a' : c > o ? 'b' : null,
      map: mapName
    });
    try { analytics.event('game_complete'); } catch (e) {}
    const players = (v.players || []).map(p => ({
      name: p.name,
      team: p.team === 'CHAOS' ? 'b' : 'a',   // ORDER=a, CHAOS=b (fixed team identities)
      agent: p.agentName || p.agent || '',
      kills: p.kills || 0, deaths: p.deaths || 0, assists: p.assists || 0
    }));
    stats.saveValorantPlayerStats(statsValGameId, players);
    statsValGameId = null;
  }
}

function startValorantWatchdog() {
  if (_valStaleTimer) return;
  _valStaleTimer = setInterval(() => {
    const v = state.valorant;
    if (v.connected && Date.now() - (v.lastUpdate || 0) > VAL_GEP_STALE_MS) {
      v.connected = false;
      try { analytics.event('disconnect', { what: 'Valorant' }); } catch (e) {}
      broadcastValorant();
    }
  }, 2000);
}
function stopValorantWatchdog() {
  if (_valStaleTimer) { clearInterval(_valStaleTimer); _valStaleTimer = null; }
  if (state.valorant.connected) { state.valorant.connected = false; broadcastValorant(); }
}

// ── League of Legends Live Client Data (port 2999, spectator) ────────────────
// Drives the automated in-game LoL HUD. Polls /liveclientdata/allgamedata once a
// second when League is the active game (the scoreboard changes far slower than a
// shooter, so 1s is plenty and keeps broadcast churn low). See backend/lol-live.js.
function broadcastLol() {
  broadcast(bridgeClients, { type: 'lol_update', data: state.lol });
}

// Last fresh OCR read of team gold; overrides the estimate while recent.
let _lolOcrGold = null;   // { blue, red, ts }

function handleLolData(data) {
  const norm = lolLive.normalizeGameData(data);
  const wasConnected = state.lol.connected;
  Object.assign(state.lol, norm, { lastUpdate: Date.now() });  // preserves ocr / hudMode (not in norm)
  // Real gold from OCR overrides the estimate when enabled and fresh (<8s old).
  const o = state.lol.ocr;
  if (o.enabled && _lolOcrGold && (Date.now() - _lolOcrGold.ts) < 8000 && _lolOcrGold.blue != null && _lolOcrGold.red != null) {
    state.lol.blue.gold = _lolOcrGold.blue;
    state.lol.red.gold  = _lolOcrGold.red;
    state.lol.goldDiff  = _lolOcrGold.blue - _lolOcrGold.red;
    o.source = 'ocr';
  } else {
    o.source = 'est';
  }
  if (!wasConnected) { try { analytics.event('connect', { what: 'League' }); } catch (e) {} }
  broadcastLol();
}

// ── League gold OCR (optional override of the estimate) ──────────────────────
let _lolOcrStop = null;
// Language data ships in assets/ocr (unpacked from the asar); the worker cache must live in
// userData because the install dir is read-only. Idempotent, cheap — called before any OCR use.
function lolOcrConfigure() {
  lolOcr.configure({ langPath: path.join(__dirname, 'assets', 'ocr'), cachePath: path.join(dataDir || os.tmpdir(), 'ocr-cache') });
}
function lolOcrStatusMsg() {
  const o = state.lol.ocr;
  return { type: 'lol_ocr_status', status: o.status, detail: o.statusDetail, lastBlue: o.lastBlue, lastRed: o.lastRed,
    blueConf: o.lastBlueConf, redConf: o.lastRedConf, reason: o.lastReason, capture: o.capture, source: o.source };
}
function startLolOcr() {
  if (_lolOcrStop) return;
  lolOcrConfigure();
  state.lol.ocr.available = lolOcr.tessAvailable();
  _lolOcrStop = lolOcr.startOcr({
    intervalMs: 1000,
    getRegions: () => state.lol.ocr.regions,
    getDisplayId: () => state.lol.ocr.displayId,
    onResult: (res) => {
      const o = state.lol.ocr;
      o.lastBlue = res.blue; o.lastRed = res.red;
      o.lastBlueConf = res.blueConf || 0; o.lastRedConf = res.redConf || 0;
      o.lastReason = res.reason || { blue: '', red: '' };
      o.capture = res.capture || '';
      // The tracker hands back its last GOOD value while it holds over a bad frame, so the
      // override stays fresh through a misread instead of flickering back to the estimate.
      if (res.blue != null && res.red != null) _lolOcrGold = { blue: res.blue, red: res.red, ts: Date.now() };
    },
    onStatus: (status, detail) => {
      state.lol.ocr.status = status;
      state.lol.ocr.statusDetail = detail;
      broadcast(bridgeClients, lolOcrStatusMsg());
    }
  });
}
function stopLolOcr() {
  if (_lolOcrStop) { _lolOcrStop(); _lolOcrStop = null; }
  _lolOcrGold = null;
  state.lol.ocr.status = 'off';
  state.lol.ocr.source = 'est';
}

let _lolPollTimer = null, _lolPollGen = 0;
function startLolPolling() {
  if (_lolPollTimer) return;
  if (state.lol.ocr.enabled) startLolOcr();
  // One request at a time, and only the current polling session may apply its answer: the 1s
  // interval ran against a 1.5s request timeout, so requests overlapped and an older response could
  // land after a newer one; a reply arriving after stopLolPolling() also flipped connected back on.
  const gen = ++_lolPollGen;
  let busy = false;
  _lolPollTimer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const data = await lolLive.fetchAllGameData();
      if (gen !== _lolPollGen) return;
      handleLolData(data);
    } catch {
      if (gen !== _lolPollGen) return;
      if (state.lol.connected) {
        try { analytics.event('disconnect', { what: 'League' }); } catch (e) {}
        state.lol.connected = false;
        broadcastLol();
      }
    } finally { busy = false; }
  }, 1000);
}
function stopLolPolling() {
  _lolPollGen++;
  if (_lolPollTimer) { clearInterval(_lolPollTimer); _lolPollTimer = null; }
  stopLolOcr();
  if (state.lol.connected) { state.lol.connected = false; broadcastLol(); }
}

// ── Apex Legends LiveAPI (WS server; the game connects to US) ─────────────────
// Unlike LoL/Valorant (we poll them) and Overwatch (Overwolf pushes HTTP to us),
// Apex dials OUT to a websocket server we host. We stand it up while Apex is the
// active game, accumulate the match via the pure reducer, and broadcast a trimmed
// view to overlays on each frame. See backend/apex-live.js.
let _apexServer = null;        // { server, close() }
let _apexAcc = null;           // full reducer state (keyed squads); state.apex holds the broadcast view
let _apexBroadcastTimer = null;

function broadcastApex() {
  broadcast(bridgeClients, { type: 'apex_update', data: state.apex });
}
// Recompute the broadcast view immediately after a producer config change (scoring/teamMap/
// event/series edits) and push it, whether or not a live reducer accumulator exists.
function recomputeApexBroadcast() {
  if (_apexAcc) {
    const view = apexLive.toBroadcast(_apexAcc, { scoring: state.apex.scoring });
    Object.assign(state.apex, view, { port: state.apex.port, scoring: state.apex.scoring, teamMap: state.apex.teamMap, event: state.apex.event, games: _apexAcc.games });
  } else {
    // No game connected — still reflect config + a points-only standings from persisted games.
    const tmp = apexLive.initialState();
    tmp.games = (state.apex.games || []).map((g) => ({ ...g }));
    tmp.matchState = 'postmatch';
    state.apex.standings = apexLive.computeStandings(tmp, state.apex.scoring);
    state.apex.gamesPlayed = tmp.games.length;
  }
  broadcastApex();
}
// Frames can burst (multiple stat changes per kill). Coalesce broadcasts to ~4/s.
let _apexGamesSig = '';
function scheduleApexBroadcast() {
  if (_apexBroadcastTimer) return;
  _apexBroadcastTimer = setTimeout(() => {
    _apexBroadcastTimer = null;
    if (!_apexAcc) return;
    const view = apexLive.toBroadcast(_apexAcc, { scoring: state.apex.scoring });
    // Preserve producer-owned fields (not part of the reducer view).
    Object.assign(state.apex, view, { port: state.apex.port, scoring: state.apex.scoring, teamMap: state.apex.teamMap, event: state.apex.event, games: _apexAcc.games });
    // Persist when the completed-games set changes, so a mid-series crash recovers.
    const sig = String((_apexAcc.games || []).length);
    if (sig !== _apexGamesSig) { _apexGamesSig = sig; saveAppState(); }
    broadcastApex();
  }, 250);
}

function startApexServer() {
  if (_apexServer) return;
  _apexAcc = apexLive.initialState();
  // Restore an in-progress series (completed games) from persisted state.
  if (Array.isArray(state.apex.games) && state.apex.games.length) {
    _apexAcc.games = state.apex.games.map((g) => ({ ...g }));
    _apexAcc.gameNumber = state.apex.games.length + 1;
  }
  _apexGamesSig = String((_apexAcc.games || []).length);
  const port = (state.apex && state.apex.port) || 7777;
  try {
    _apexServer = apexLive.createServer({
      port,
      onStatus: (status, err) => {
        if (status === 'connected') {
          if (!state.apex.connected) { try { analytics.event('connect', { what: 'Apex' }); } catch (e) {} }
          state.apex.connected = true;
          scheduleApexBroadcast();
        } else if (status === 'disconnected') {
          state.apex.connected = false;
          if (_apexAcc) _apexAcc.connected = false;
          scheduleApexBroadcast();
        } else if (status === 'error') {
          console.warn('[apex] LiveAPI server error:', err && err.message);
        }
      },
      onFrame: (frame) => {
        apexLive.applyEvent(_apexAcc, frame, Date.now());
        scheduleApexBroadcast();
      },
      onRaw: (info) => {
        if (info.binary) console.warn('[apex] received BINARY frame (' + info.bytes + 'B) — set cl_liveapi_use_protobuf 0 for JSON');
        else { try { console.log('[apex] sample frame:', JSON.stringify(info.frame).slice(0, 400)); } catch (e) {} }
      },
    });
    console.log('[apex] LiveAPI server listening on ws://127.0.0.1:' + port);
  } catch (e) {
    console.error('[apex] failed to start LiveAPI server on port ' + port + ':', e.message);
    _apexServer = null;
  }
}
function stopApexServer() {
  if (_apexBroadcastTimer) { clearTimeout(_apexBroadcastTimer); _apexBroadcastTimer = null; }
  if (_apexServer) { try { _apexServer.close(); } catch (e) {} _apexServer = null; }
  _apexAcc = null;
  if (state.apex.connected) { state.apex.connected = false; broadcastApex(); }
}

function mergeDirectorRuntime(out) {
  return {
    ...out,
    lastAutoSwitch: state.director?.lastAutoSwitch || null
  };
}

function broadcastDirectorUpdate() {
  if (!state.director) return;
  broadcast(bridgeClients, { type: 'director_update', data: state.director });
}

function broadcastClipsUpdate() {
  if (!state.clips) return;
  broadcast(bridgeClients, { type: 'clips_update', data: { ...state.clips, encode: state.encode } });
}

function feedDirectorCsgo() {
  if (!directorEngine || !gameHasFeature('csgo', 'director')) return;
  if (state.activeGame !== 'csgo') return;
  directorEngine.onGameUpdate('csgo', {
    ...state.csgo,
    series: state.series,
    bestOf: state.bestOf,
    teams: state.teams,
    spotlight: state.spotlight
  });
}

function feedDirectorRL() {
  if (!directorEngine || !gameHasFeature('rocket-league', 'director')) return;
  if (state.activeGame !== 'rocket-league') return;
  directorEngine.onGameUpdate('rocket-league', {
    players: state.players,
    game: state.game,
    ball: state.rlBall || null,
    spectatedPlayer: state.spectatedPlayer,
    lastTouch: state.rlLastTouch || null,   // most recent ball toucher (BallHit) → who has the play
    series: state.series,
    bestOf: state.bestOf,
    teams: state.teams,
    spotlight: state.spotlight
  });
}

function feedDirectorBroadcast() {
  if (!directorEngine || !gameHasFeature(state.activeGame, 'director')) return;
  if (state.activeGame === 'csgo' || state.activeGame === 'rocket-league') return;
  if (Date.now() - lastGenericDirectorFeed < 500) return;
  lastGenericDirectorFeed = Date.now();
  directorEngine.onGameUpdate(state.activeGame, {
    game: state.game,
    series: state.series,
    bestOf: state.bestOf,
    teams: state.teams,
    spotlight: state.spotlight,
    breakScreen: state.breakScreen,
    spectatedPlayer: state.spectatedPlayer,
    players: state.players
  });
}

function getDirectorGameState() {
  if (state.activeGame === 'csgo') return state.csgo;
  if (state.activeGame === 'rocket-league') {
    return { players: state.players, game: state.game, spectatedPlayer: state.spectatedPlayer };
  }
  return {
    game: state.game,
    series: state.series,
    teams: state.teams,
    spotlight: state.spotlight
  };
}

// AI Shield — the master kill-switch. When true, every automated AI action is blocked.
// Gate every auto-action site with this so a misbehaving automation can be killed instantly.
function aiShielded() { return !!(state.ai && state.ai.shield); }

// Lightweight "tick context" for telemetry — score/clock/scene/spectated at this instant.
// Deliberately small (NO base64 logos/blobs) so the decision log stays cheap to write.
function buildTelemetryContext() {
  const g = state.activeGame;
  let score = null, clock = null, spectated = null;
  if (g === 'csgo' && state.csgo) {
    score = { a: state.csgo.ct?.score ?? null, b: state.csgo.t?.score ?? null };
    clock = { phase: state.csgo.round?.phase || state.csgo.phase || null, round: state.csgo.round?.number ?? null };
    spectated = state.csgo.observed?.steamid || null;
  } else if (g === 'valorant' && state.valorant) {
    score = { a: state.valorant.order?.score ?? null, b: state.valorant.chaos?.score ?? null };
    clock = { phase: state.valorant.round?.phase || null, round: state.valorant.round?.number ?? null };
    spectated = state.valorant.observed?.name || null;
  } else if (g === 'league' && state.lol) {
    score = { a: state.lol.blue?.kills ?? null, b: state.lol.red?.kills ?? null };
    clock = { seconds: state.lol.gameTime ?? null, goldDiff: state.lol.goldDiff ?? null };
    spectated = state.lol.observed?.name || null;
  } else if (g === 'apex' && state.apex) {
    score = { a: state.apex.squadsAlive ?? null, b: state.apex.squadsTotal ?? null };  // squads remaining / total
    clock = { seconds: null, matchState: state.apex.matchState };
    spectated = state.apex.observed?.name || null;
  } else {
    score = { a: state.game?.blueScore ?? null, b: state.game?.orangeScore ?? null };
    clock = { seconds: state.game?.time ?? null, isOT: !!state.game?.isOT };
    spectated = state.spectatedPlayer || null;
  }
  const p = state.director?.primary || null;
  return {
    game: g || null,
    matchId: statsCurrentMatchId,
    gameId: statsCurrentGameId || statsCs2GameId || statsValGameId || null,
    context: {
      score, clock, spectated,
      scene: state.obs?.currentScene || null,
      recording: !!state.obs?.recording,
      streaming: !!state.obs?.streaming,
      director: p ? { type: p.type || null, targetId: p.target?.id || null, confidence: state.director?.confidence ?? null } : null,
    },
  };
}

// Snapshot the director's current recommendation for a decision record.
function currentDirectorRec() {
  const p = state.director?.primary;
  if (!p) return null;
  return {
    target: p.target || null,
    type: p.type || null,
    confidence: state.director?.confidence ?? null,
    reason: p.reason || null,
    alternates: (state.director?.alternates || []).slice(0, 3).map((a) => ({
      targetId: a.target?.id || null, type: a.type || null, confidence: a.confidence ?? null,
    })),
  };
}

// Log a producer decision on the current director recommendation.
function recordDirectorDecision(decision, opts = {}) {
  if (!telemetry) return;
  telemetry.directorDecision({
    recommendation: currentDirectorRec(),
    decision,
    chosen: opts.chosen || null,
    note: opts.note || null,
    latencyMs: _directorRecShownAt ? (Date.now() - _directorRecShownAt) : null,
  });
}

const DIRECTOR_CAPTURE_TYPES = new Set([
  'goal', 'save', 'ace', 'clutch', 'demo', 'shot', 'kickoff', 'multi_kill', 'defuse', 'match_point'
]);

function buildCaptureMetaFromEvent(event, gameId) {
  const tctx = buildTelemetryContext().context || {};
  return {
    type: event.type,
    game: gameId,
    player: event.target?.name || '',
    reason: event.reason || '',
    label: `${event.type} — ${event.target?.name || 'highlight'}`,
    captureKey: `${event.type}:${event.target?.id || event.target?.name}:${event.ts}`,
    feedTs: event.ts,
    // AI training alignment — tie this clip to the exact game moment that triggered it.
    eventTargetId: event.target?.id || null,
    gameClock: event.gameTime || (tctx.clock || null),
    scoreAtEvent: tctx.score || null
  };
}

// Merge the clip-manager's state into state.clips while preserving the
// server-only fields (captureMode / autoMontage / autoMontageId).
function syncClipsState() {
  if (!clipSystem) return;
  const cur = state.clips || {};
  state.clips = {
    ...clipSystem.getState(),
    encode: state.encode,
    captureMode: cur.captureMode || 'manual',   // default = NO auto-clipping; never silently force 'auto'
    autoMontage: !!cur.autoMontage,
    autoMontageId: cur.autoMontageId || null
  };
  clipsVer++;
}

// Which match a capture belongs to ("FRT vs EMB", game 3), so the Replays page can group moments
// by match instead of listing bare timestamps.
function clipMatchContext() {
  const tag = (t, fb) => {
    t = t || {};
    if (t.abbr) return String(t.abbr).trim();
    const n = String(t.name || '').trim();
    return n || fb;
  };
  const a = tag(state.teams && state.teams.blue, ''), b = tag(state.teams && state.teams.orange, '');
  return { match: a && b ? a + ' vs ' + b : '', gameNumber: (state.game && Number(state.game.number)) || null };
}
async function triggerClipCapture(meta) {
  if (!clipSystem) return null;
  const ctx = clipMatchContext();
  meta = { ...meta, match: meta.match || ctx.match, gameNumber: meta.gameNumber || ctx.gameNumber };
  const clip = await clipSystem.onHighlightEvent(meta);
  if (clip) try { analytics.event('clip'); } catch (e) {}
  syncClipsState();
  broadcastClipsUpdate();
  return clip;
}

// Append a captured clip to the rolling "Live Montage" (auto-montage mode).
function maybeAutoMontage(clip) {
  if (!clip || !clip.path || !state.clips?.autoMontage || !clipSystem) return;
  let m = state.clips.autoMontageId
    ? clipSystem.getState().montages.find((x) => x.id === state.clips.autoMontageId)
    : null;
  if (!m) {
    m = clipSystem.manager.createMontage({ name: 'Live Montage', clipIds: [], template: 'highlights' });
    state.clips.autoMontageId = m.id;
  }
  clipSystem.manager.reorderMontage(m.id, (m.clipIds || []).concat(clip.id));
  syncClipsState();
  broadcastClipsUpdate();
}

function onDirectorEvents(gameId, events) {
  if (!events.length) return;
  if (aiShielded()) return;   // shield blocks all auto-clipping
  const mode = state.clips?.captureMode || 'manual';   // unset = NO clipping (never default to silent auto)

  events.forEach((event) => {
    if (mode === 'manual') return;
    if (!DIRECTOR_CAPTURE_TYPES.has(event.type)) return;
    if (state.clips.captureRules[event.type] === false) return;
    const meta = buildCaptureMetaFromEvent(event, gameId);

    if (mode === 'prompt') {
      // Ask the producer before clipping (replay buffer still holds the moment).
      broadcast(bridgeClients, {
        type: 'clip_prompt',
        data: { id: `prompt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, meta,
          label: meta.label, type: meta.type, player: meta.player || '', game: gameId, ts: Date.now() }
      });
    } else {
      // 'auto' — clip silently, optionally appending to the live montage.
      triggerClipCapture(meta).then((clip) => {
        maybeAutoMontage(clip);
        // Telemetry: an auto-clip was produced from this event (ground truth for the clip model).
        if (clip && telemetry) telemetry.clipDecision({
          clipId: clip.id, decision: 'auto',
          trigger: { type: event.type, targetId: event.target?.id || null, confidence: event.priority ?? null, ts: event.ts },
        });
      }).catch((e) => console.error('[Clips] Capture error:', e.message));
    }
  });
}

// ── Kill feed ─────────────────────────────────────────────────────────────
// GSI has no per-kill event, so we infer kills by diffing cumulative counters:
// a player whose `deaths` ticked up died; a player whose `roundKills` ticked up
// got the frag (weapon = their active weapon; headshot if `roundHs` ticked up).
// Firing detection: GSI has no "shooting" flag, so we infer it — a player's active-weapon
// ammo clip dropping (same weapon, no reload) means they just fired. Set per tick; the
// overlay latches the effect for a short window so sustained fire reads as a steady pulse.
let prevFire = {};               // steamid -> { clip, weapon }
// The gun each player last FIRED, from any carried weapon's magazine dropping (not only the active
// one). Kills are credited to this: AWPers switch to the knife straight after a shot, so by the GSI
// tick that carries the kill the ACTIVE weapon is often already the knife — which put "knife" on
// the kill feed for AWP kills.
let prevClips = {};              // steamid -> { weaponName: ammo_clip }
const lastShot = {};             // steamid -> { weapon, ts }
const SHOT_WINDOW_MS = 2500;     // a kill within this long of the last shot belongs to that gun
function trackShots(players, now) {
  const cur = {};
  (players || []).forEach((p) => {
    const clips = p._clips || {};
    const prev = prevClips[p.steamid] || {};
    Object.keys(clips).forEach((name) => {
      if (typeof prev[name] === 'number' && clips[name] < prev[name] && (prev[name] - clips[name]) <= 40) {
        lastShot[p.steamid] = { weapon: name, ts: now };
      }
    });
    cur[p.steamid] = clips;
    delete p._clips;   // internal only — never broadcast
  });
  prevClips = cur;
}
function killWeapon(p, now) {
  const ls = lastShot[p.steamid];
  return (ls && now - ls.ts < SHOT_WINDOW_MS) ? ls.weapon : (p.weapon || '');
}
function detectFiring(players) {
  const cur = {};
  (players || []).forEach((p) => {
    const prev = prevFire[p.steamid];
    const clip = (typeof p.clip === 'number') ? p.clip : null;
    p.firing = !!(prev && p.alive && clip !== null && typeof prev.clip === 'number'
      && p.weapon === prev.weapon && clip < prev.clip && (prev.clip - clip) <= 40);
    cur[p.steamid] = { clip, weapon: p.weapon };
  });
  prevFire = cur;
}

// CS2 auto team names: the game's CT|T team names when the producer last pressed Swap. While the
// game still reports exactly those names, auto-naming holds off so the manual swap sticks.
let _csManualSwapKey = null;

// CS2 auto team names (CT = blue side, T = orange side), matched to the saved library for logos.
// Also moves whole teams across when the game reports a side change, and respects a manual Swap.
function csApplyAutoTeams(ctInfo, tInfo) {
  if (state.autoTeamsFromGame) {
    const gameKey = csGameTeamsKey();
    if (_csManualSwapKey && _csManualSwapKey === gameKey) {
      // The producer pressed Swap: keep their sides until the game reports different team names.
    } else {
      _csManualSwapKey = null;
      // The game says the teams changed sides (halftime / overtime): move the WHOLE team across —
      // logo, colour, series score, players — not just the name. Renaming alone left each name next
      // to the other team's logo whenever a team wasn't in the saved library.
      const norm = (x) => String(x == null ? '' : x).trim().toLowerCase();
      const ct = norm(ctInfo.name), t = norm(tInfo.name);
      if (ct && t && ct !== t && !GENERIC_TEAM_RE.test(ct) && !GENERIC_TEAM_RE.test(t)
          && ct === norm(state.teams.orange && state.teams.orange.name) && t === norm(state.teams.blue && state.teams.blue.name)) {
        swapTeamSides();
      }
      applyGameTeamName('blue', ctInfo.name); applyGameTeamName('orange', tInfo.name);
      retuneRoundLabel();   // teams changed without a set push — don't leave the old round on screen
    }
  }
}

// Victory screen when a CS2 map ends. The HUD's CT panel is always the BLUE team and T the ORANGE
// one (auto team names keep that true across halftime), so the side with more rounds is the winner.
// Only an auto-shown winner is auto-hidden, so one the producer put up by hand is never pulled.
let _csAutoWinnerShown = false;
function csShowAutoWinner() {
  if (state.csgo.autoWinner === false || !WS_HANDLERS.set_winner) return;
  const ct = Number(state.csgo.ct && state.csgo.ct.score) || 0;
  const t = Number(state.csgo.t && state.csgo.t.score) || 0;
  if (ct === t) return;   // a draw has no winner to show
  WS_HANDLERS.set_winner({ data: { side: ct > t ? 'blue' : 'orange', visible: true, subtitle: Math.max(ct, t) + '–' + Math.min(ct, t) } });
  _csAutoWinnerShown = true;
}
function csHideAutoWinner() {
  if (!_csAutoWinnerShown) return;
  _csAutoWinnerShown = false;
  if (state.winner && state.winner.visible && WS_HANDLERS.set_winner) WS_HANDLERS.set_winner({ data: { visible: false } });
}
function csGameTeamsKey() {
  const n = (x) => String(x == null ? '' : x).trim().toLowerCase();
  return n(state.csgo.ct && state.csgo.ct.name) + '|' + n(state.csgo.t && state.csgo.t.name);
}

let killPrev = null;             // steamid -> { deaths, roundKills, roundHs }
const KILL_TTL = 7000;           // ms a kill stays on the feed
const KILL_MAX = 6;              // most rows kept

function updateKillfeed(players) {
  const now = Date.now();
  const cur = {};
  players.forEach(p => { cur[p.steamid] = p; });

  if (killPrev) {
    const victims = [];          // players who just died
    const kills = [];            // { p, hs } per frag credited this tick
    players.forEach(p => {
      const pp = killPrev[p.steamid];
      if (!pp) return;
      if ((p.deaths || 0) > (pp.deaths || 0)) victims.push(p);
      const dk = (p.roundKills || 0) - (pp.roundKills || 0);
      const dhs = (p.roundHs || 0) - (pp.roundHs || 0);
      for (let i = 0; i < dk; i++) kills.push({ p, hs: i < dhs });   // mark the headshot frags first
      // cs2_ace — fires once, the tick a player's round kill count crosses into a 5-kill round
      // (a multi-kill tick can jump straight from e.g. 3 to 5, so check the boundary, not ===5).
      if ((pp.roundKills || 0) < 5 && (p.roundKills || 0) >= 5) {
        flowBus.emit('cs2_ace', { player: p.name, team: p.team });
      }
    });

    if (victims.length || kills.length) {
      const used = new Set();
      const pickVictim = (killerTeam) => {
        let i = victims.findIndex((v, idx) => !used.has(idx) && v.team !== killerTeam);   // prefer an enemy
        if (i === -1) i = victims.findIndex((v, idx) => !used.has(idx));                   // else any unclaimed
        if (i === -1) return null; used.add(i); return victims[i];
      };
      // CS2 can report the victim's death and the killer's frag in DIFFERENT updates (often on
      // kills with assists, where several players' stats change at once). Join them back into one
      // row: a frag with no victim this tick fills a recent killer-less row, and a death with no
      // frag fills a recent victim-less row, from the other team, within KILL_JOIN_MS.
      const KILL_JOIN_MS = 1500;
      const openRow = (want, team) => {
        for (let i = state.csgo.killfeed.length - 1; i >= 0; i--) {
          const r = state.csgo.killfeed[i];
          if (now - r.ts > KILL_JOIN_MS) break;
          if (want === 'killer' && !r.killer && r.victim && r.victimTeam !== team) return r;
          if (want === 'victim' && r.killer && !r.victim && r.killerTeam !== team) return r;
        }
        return null;
      };
      kills.forEach(k => {
        const v = pickVictim(k.p.team);
        const weapon = killWeapon(k.p, now);
        if (!v) {
          const r = openRow('killer', k.p.team);
          if (r) {
            Object.assign(r, { killer: k.p.name, killerTeam: k.p.team, weapon, hs: !!k.hs });
            flowBus.emit('cs2_kill', { killer: k.p.name, killerTeam: k.p.team, victim: r.victim, victimTeam: r.victimTeam, weapon, headshot: !!k.hs });
            if (k.hs) flowBus.emit('cs2_headshot_kill', { killer: k.p.name, killerTeam: k.p.team, victim: r.victim });
            return;
          }
        }
        flowBus.emit('cs2_kill', {
          killer: k.p.name, killerTeam: k.p.team, victim: v ? v.name : '',
          victimTeam: v ? v.team : '', weapon, headshot: !!k.hs
        });
        if (k.hs) flowBus.emit('cs2_headshot_kill', { killer: k.p.name, killerTeam: k.p.team, victim: v ? v.name : '' });
        state.csgo.killfeed.push({
          killer: k.p.name, killerTeam: k.p.team, weapon,
          hs: !!k.hs, victim: v ? v.name : '', victimTeam: v ? v.team : '', ts: now
        });
      });
      // Deaths with no matching frag → world / suicide (fall damage, bomb, leaving)
      victims.forEach((v, idx) => {
        if (used.has(idx)) return;
        const r = openRow('victim', v.team);
        if (r) { r.victim = v.name; r.victimTeam = v.team; return; }
        state.csgo.killfeed.push({ killer: '', killerTeam: '', weapon: '', hs: false, victim: v.name, victimTeam: v.team, ts: now });
      });
    }
  }

  // Expire + cap
  state.csgo.killfeed = state.csgo.killfeed.filter(k => now - k.ts < KILL_TTL).slice(-KILL_MAX);
  killPrev = {};
  players.forEach(p => { killPrev[p.steamid] = { deaths: p.deaths || 0, roundKills: p.roundKills || 0, roundHs: p.roundHs || 0 }; });
}

// Normalise a CS2 GSI payload into our csgo state.
function handleGsi(payload) {
  if (!payload || typeof payload !== 'object') return;

  const map = payload.map || {};
  const round = payload.round || {};
  const ctInfo = map.team_ct || {};
  const tInfo = map.team_t || {};

  state.csgo.map = { name: map.name || '', phase: map.phase || '', mode: map.mode || '' };
  const sideInfo = (info) => ({
    name: info.name || '',
    score: info.score ?? 0,
    lossBonus: info.consecutive_round_losses ?? 0,   // loss-streak (drives buy economy)
    timeouts: info.timeouts_remaining ?? 0,
    seriesWins: info.matches_won_this_series ?? 0
  });
  state.csgo.ct = { ...sideInfo(ctInfo), name: ctInfo.name || 'COUNTER-TERRORISTS' };
  state.csgo.t  = { ...sideInfo(tInfo),  name: tInfo.name  || 'TERRORISTS' };
  csApplyAutoTeams(ctInfo, tInfo);   // auto team names + side changes (see the function)
  state.csgo.round = {
    number: (typeof map.round === 'number') ? map.round + 1 : (state.csgo.round.number || 0),
    phase: round.phase || map.phase || '',
    bomb: round.bomb || '',
    winTeam: round.win_team || ''                     // 'CT' | 'T' at round end
  };
  const prov = payload.provider || {};
  state.csgo.provider = { version: prov.version ?? null, timestamp: prov.timestamp ?? null };

  // Players (allplayers is keyed by steamid; only present when observing)
  const all = payload.allplayers || {};
  const players = Object.keys(all).map((steamid) => {
    const p = all[steamid] || {};
    const st = p.state || {};
    const ms = p.match_stats || {};

    const wp = parseWeapons(p.weapons);
    return {
      steamid,
      name: p.name || '?',
      team: p.team || '',          // 'CT' | 'T'
      slot: p.observer_slot ?? 99,
      health: st.health ?? 0,
      armor: st.armor ?? 0,
      helmet: !!st.helmet,
      money: st.money ?? 0,
      kills: ms.kills ?? 0,
      assists: ms.assists ?? 0,
      deaths: ms.deaths ?? 0,
      mvps: ms.mvps ?? 0,
      score: ms.score ?? 0,          // scoreboard points — sidebar sorts by this
      roundKills: st.round_kills ?? 0,
      roundHs: st.round_killhs ?? 0,  // headshot kills this round
      roundDmg: st.round_totaldmg ?? 0,
      alive: (st.health ?? 0) > 0,
      equip: st.equip_value ?? 0,     // current loadout value (gun+armor+nades)
      flashed: st.flashed ?? 0,       // 0–255 blind intensity
      burning: st.burning ?? 0,       // 0–255 on fire
      smoked: st.smoked ?? 0,         // 0–255 obscured by smoke
      pos: parseVec(p.position),      // world {x,y} for the radar (observer GSI only)
      fwd: parseVec(p.forward),       // view/forward {x,y} → facing arrow on the radar
      weapon: wp.weapon,
      clip: wp.clip,                  // active-weapon ammo → firing detection (clip drop)
      nades: wp.nades,
      primary: wp.primary,            // owned loadout — what overlays show (never the knife)
      secondary: wp.secondary,
      hasTaser: wp.hasTaser,
      activeNade: wp.activeNade,      // grenade currently in hand, '' if none
      hasKit: !!st.defusekit,
      hasBomb: wp.hasBomb,
      firing: false,                  // set by detectFiring() below
      _clips: wp.clips                // every carried gun's magazine — read + removed by trackShots()
    };
  }).sort((a, b) => a.slot - b.slot);
  trackShots(players, Date.now());   // before the killfeed: which gun just fired (strips _clips)
  detectFiring(players);
  if (players.length) state.csgo.players = players;

  if (players.length) updateKillfeed(players);

  // Observed/spectated player (bottom focus panel) — GSI 'player' block
  const obs = payload.player;
  if (obs && obs.state) {
    const ost = obs.state;
    const oms = obs.match_stats || {};
    const owp = parseWeapons(obs.weapons);
    state.csgo.observed = {
      steamid: obs.steamid || '',
      name: obs.name || '',
      team: obs.team || '',
      health: ost.health ?? 0,
      armor: ost.armor ?? 0,
      helmet: !!ost.helmet,
      money: ost.money ?? 0,
      kills: oms.kills ?? 0,
      assists: oms.assists ?? 0,
      deaths: oms.deaths ?? 0,
      mvps: oms.mvps ?? 0,
      score: oms.score ?? 0,
      roundKills: ost.round_kills ?? 0,
      roundHs: ost.round_killhs ?? 0,
      roundDmg: ost.round_totaldmg ?? 0,
      armorHelmet: !!ost.helmet,
      flashed: ost.flashed ?? 0,
      smoked: ost.smoked ?? 0,
      burning: ost.burning ?? 0,
      alive: (ost.health ?? 0) > 0,
      weapon: owp.weapon,
      clip: owp.clip,
      reserve: owp.reserve,
      nades: owp.nades,
      primary: owp.primary,
      secondary: owp.secondary,
      hasTaser: owp.hasTaser,
      activeNade: owp.activeNade,
      hasKit: !!ost.defusekit,
      hasBomb: owp.hasBomb
    };
  } else {
    state.csgo.observed = null;
  }

  // Round-win history (map.round_wins: { "1": "ct_win_elimination", ... })
  const rw = map.round_wins || {};
  state.csgo.roundHistory = Object.keys(rw)
    .map((k) => ({ round: parseInt(k, 10), result: rw[k] || '' }))
    .filter((r) => !isNaN(r.round))
    .sort((a, b) => a.round - b.round)
    .map((r) => ({
      round: r.round,
      winner: r.result.startsWith('ct') ? 'CT' : 'T',
      method: r.result.split('_').slice(2).join('_') || r.result.replace(/^(ct|t)_win_?/, '')
    }));

  // Bomb + phase countdown
  if (payload.bomb) {
    state.csgo.bomb = {
      state: payload.bomb.state || '',
      countdown: payload.bomb.countdown ?? null,
      pos: parseVec(payload.bomb.position),
      player: payload.bomb.player || ''   // steamid planting/defusing (→ kit-aware defuse time)
    };
  } else if (round.bomb) {
    state.csgo.bomb = { state: round.bomb, countdown: null, pos: null, player: '' };
  } else {
    state.csgo.bomb = { state: '', countdown: null, pos: null, player: '' };
  }
  const pc = payload.phase_countdowns || {};
  state.csgo.phase = pc.phase || '';
  state.csgo.phaseEndsIn = (pc.phase_ends_in !== undefined) ? Number(pc.phase_ends_in) : null;

  state.csgo.grenades = parseGrenades(payload.grenades);

  markCsgoActivity();
  if (state.csgo.observed && !cs2Cinematic.isPlaying()) {
    const op = (state.csgo.players || []).find((x) => x.steamid === state.csgo.observed.steamid);
    if (op && op.slot != null && op.slot <= 9) _csLastObsSlot = op.slot;
  }
  try { cs2Cinematic.onCsgo(state.csgo); } catch (e) { console.error('[CS2 cinematic]', e.message); }
  try { csAutoHud(payload); } catch (e) { console.error('[CS2 auto HUD]', e.message); }
  broadcastCsgo();
  feedDirectorCsgo();

  // CS2 OBS scene cuts on map phase changes (when auto-switch is on)
  const mapPhase = (state.csgo.map && state.csgo.map.phase) || '';
  if (state.activeGame === 'csgo' && mapPhase && mapPhase !== _csgoLastMapPhase) {
    const prev = _csgoLastMapPhase;
    _csgoLastMapPhase = mapPhase;

    if (mapPhase === 'live' && prev && prev !== 'live') {
      csHideAutoWinner();   // next map is live: take down the winner we put up at the last gameover
      obsSwitch('inGame');
      // Stats: start CS2 match + game
      if (!statsCurrentMatchId) {
        statsCurrentMatchId = stats.startMatch({
          gameType: 'cs2',
          teamA: state.csgo.ct?.name || 'CT',
          teamB: state.csgo.t?.name  || 'T',
          bestOf: state.bestOf,
          startggSetId: state.startgg?.setId || null,
          tournament: state.startgg?.selectedEvent?.tournamentName || null
        });
      }
      statsCs2GameId = stats.startGame({
        matchId: statsCurrentMatchId,
        gameNumber: state.game?.number || 1,
        gameType: 'cs2',
        map: state.csgo.map?.name || ''
      });
    } else if (mapPhase === 'gameover') {
      obsSwitch('postGame');
      csShowAutoWinner();
      csRecordVetoResult();
      // Stats: finalize CS2 game
      if (statsCs2GameId) {
        const ctScore = state.csgo.ct?.score || 0;
        const tScore  = state.csgo.t?.score  || 0;
        stats.endGame(statsCs2GameId, {
          scoreA: ctScore, scoreB: tScore,
          winner: ctScore > tScore ? 'a' : tScore > ctScore ? 'b' : null,
          map: state.csgo.map?.name || ''
        });
        try { analytics.event('game_complete'); } catch (e) {}
        (state.csgo.roundHistory || []).forEach(r => {
          stats.logCs2Round(statsCs2GameId, {
            roundNumber: r.round,
            winner: r.winner,
            winCondition: r.method,
            bombPlanted:  ['bomb', 'defuse'].includes(r.method),
            bombDefused:  r.method === 'defuse'
          });
        });
        const cs2Players = (state.csgo.players || []).map(p => ({
          steamId: p.steamid,
          name:    p.name,
          team:    p.team === 'CT' ? 'a' : 'b',
          kills:   p.kills   || 0,
          deaths:  p.deaths  || 0,
          assists: p.assists  || 0,
          mvps:    p.mvps    || 0,
          score:   p.score   || 0
        }));
        stats.saveCs2PlayerStats(statsCs2GameId, cs2Players);
        statsCs2GameId = null;
      }
    } else if (mapPhase === 'intermission') {
      flowBus.emit('cs2_half_time', {});
    } else if (mapPhase === 'warmup' && prev !== 'warmup') {
      csHideAutoWinner();
      obsSwitch('break');
    }
    if (mapPhase === 'gameover') flowBus.emit('cs2_match_ended', { ctScore: state.csgo.ct && state.csgo.ct.score || 0, tScore: state.csgo.t && state.csgo.t.score || 0 });
  }

  // CS2 per-round and bomb flow triggers
  if (state.activeGame === 'csgo') {
    const _cs2Rp = (state.csgo.round && state.csgo.round.phase) || '';
    if (_cs2Rp !== _csgoLastRoundPhase) {
      if (_cs2Rp === 'live' && (_csgoLastRoundPhase === 'freezetime' || _csgoLastRoundPhase === '')) {
        flowBus.emit('cs2_round_start', { round: state.csgo.round && state.csgo.round.number });
        _cs2ClutchFired = false;   // re-arm the once-per-round clutch check for the new round
      }
      if (_cs2Rp === 'over') {
        // Enrich with the round's win method (elimination/bomb/defuse/time) if roundHistory has
        // already parsed it by this tick — falls back to '' if it lands a tick later.
        const _rh = (state.csgo.roundHistory || []).find(r => r.round === (state.csgo.round && state.csgo.round.number));
        flowBus.emit('cs2_round_end', {
          winner: state.csgo.round && state.csgo.round.winTeam,
          round: state.csgo.round && state.csgo.round.number,
          method: _rh ? _rh.method : ''
        });
      }
      _csgoLastRoundPhase = _cs2Rp;
    }

    // cs2_clutch_situation — fires once per round, the moment one team drops to exactly one
    // player alive while the OTHER team still has 2+ (a genuine 1vX clutch, not just the last
    // 1v1 duel of an ordinary round). Gated to a live round so warmup/freezetime alive-counts
    // (often stale/zero) can't false-positive.
    if (_cs2Rp === 'live' && !_cs2ClutchFired) {
      const csgoPlayers = state.csgo.players || [];
      const ctAlive = csgoPlayers.filter(p => p.team === 'CT' && p.alive).length;
      const tAlive  = csgoPlayers.filter(p => p.team === 'T'  && p.alive).length;
      if ((ctAlive === 1 && tAlive >= 2) || (tAlive === 1 && ctAlive >= 2)) {
        const clutchTeam = ctAlive === 1 ? 'CT' : 'T';
        const lone = csgoPlayers.find(p => p.alive && p.team === clutchTeam);
        flowBus.emit('cs2_clutch_situation', {
          team: clutchTeam, player: lone ? lone.name : '', vsAlive: clutchTeam === 'CT' ? tAlive : ctAlive
        });
        _cs2ClutchFired = true;
      }
    }

    const _cs2Bomb = (state.csgo.bomb && state.csgo.bomb.state) || '';
    if (_cs2Bomb !== _csgoLastBombState) {
      if (_cs2Bomb === 'planted')  flowBus.emit('cs2_bomb_planted',  { round: state.csgo.round && state.csgo.round.number });
      if (_cs2Bomb === 'defused')  flowBus.emit('cs2_bomb_defused',  { round: state.csgo.round && state.csgo.round.number });
      if (_cs2Bomb === 'exploded') flowBus.emit('cs2_bomb_exploded', { round: state.csgo.round && state.csgo.round.number });
    }
    _csgoLastBombState = _cs2Bomb;
  }
}

// ── Map-veto engine ─────────────────────────────────────────────────────────
// Builds state.veto from a game's map pool + competitive format, then guides the
// ban/pick step-by-step. The overlay (mapscreen.html) already renders state.veto.maps,
// so the engine's job is to keep that board (+ a `turn` prompt) in sync.

// Rebuild the overlay board (maps[]) + turn prompt from the working pool/sequence/ops.
function rebuildVetoBoard() {
  const v = state.veto;
  if (!v || !Array.isArray(v.pool)) return;
  const opByMap = {};
  (v.ops || []).forEach(o => { opByMap[o.mapId] = o; });
  const complete = (v.ops || []).length >= (v.sequence || []).length;
  // Preserve any entered result (winner/score) across rebuilds, keyed by map id.
  const prevById = {};
  (v.maps || []).forEach(m => { if (m._id) prevById[m._id] = m; });

  v.maps = v.pool.map(m => {
    const op = opByMap[m.id];
    const prev = prevById[m.id] || {};
    let action = '', by = '';
    if (op) { action = op.action; by = op.by; }
    else if (complete) { action = 'decider'; by = ''; }       // leftover map(s) = decider
    return {
      _id: m.id, name: m.name, mode: m.type || '', image: m.image || '',
      action, by,
      winner: prev.winner || '', score: { a: Number(prev.score?.a) || 0, b: Number(prev.score?.b) || 0 }
    };
  });

  // Whose turn / what action next (null once the veto is complete).
  const next = (v.sequence || [])[(v.ops || []).length] || null;
  v.turn = next ? { team: next.by, action: next.action } : null;
  v.complete = complete;
}

function vetoStart({ game, bestOf, teamStart, title, strikeFrom }) {
  const pools = vetoData.mergedMapPools(state.gameConfigs);   // built-in + active Game Config maps
  const hasPool = (id) => (pools[id] || []).length > 0;
  const g = hasPool(game) ? game : (hasPool(state.activeGame) ? state.activeGame : 'csgo');
  const fullPool = pools[g] || [];
  if (!fullPool.length) throw new Error('No map pool defined for ' + g);
  // Some rulesets strike from a SUBSET of the pool (Smash game 1 = Starters). The producer picks
  // which tier per event — rulesets differ, and '' / 'all' means strike the whole pool. The rest
  // of the pool still exists for the Series editor's per-game counterpicks.
  const wantTier = typeof strikeFrom === 'string' ? strikeFrom : vetoData.getMeta(g).strikeFrom;
  const subset = (wantTier && wantTier !== 'all') ? fullPool.filter((m) => m && m.tier === wantTier) : [];
  const pool = subset.length >= 2 ? subset : fullPool;
  const bo = [1, 3, 5, 7].includes(Number(bestOf)) ? Number(bestOf) : 1;
  const ts = teamStart === 'b' ? 'b' : 'a';
  const seq = vetoData.buildSequence(g, bo, pool.length)
    .map(s => ({ action: s.action, by: vetoData.resolveSide(s.teamIdx, ts) }));
  const meta = vetoData.getMeta(g);
  state.veto = {
    visible: !!(state.veto && state.veto.visible),
    title: typeof title === 'string' ? title : (state.veto && state.veto.title) || '',
    game: g, bestOf: bo, teamStart: ts,
    kind: meta.kind, banWord: meta.banWord, unit: meta.unit, strikeFrom: wantTier || '',
    pool, sequence: seq, ops: [], maps: [], turn: null, complete: false
  };
  rebuildVetoBoard();
}

function vetoApply(mapId) {
  const v = state.veto;
  if (!v || !Array.isArray(v.sequence)) return;
  if (v.ops.length >= v.sequence.length) return;             // veto already done
  if (!v.pool.some(m => m.id === mapId)) return;             // not a pool map
  if (v.ops.some(o => o.mapId === mapId)) return;            // already acted on
  const step = v.sequence[v.ops.length];
  v.ops.push({ mapId, action: step.action, by: step.by });
  rebuildVetoBoard();
}

function vetoUndo() {
  const v = state.veto;
  if (!v || !Array.isArray(v.ops) || !v.ops.length) return;
  v.ops.pop();
  rebuildVetoBoard();
}

function vetoReset() {
  const v = state.veto;
  if (!v) return;
  v.ops = [];
  rebuildVetoBoard();
}

// Record a played-map result (winner side + score) on a decided map.
function vetoResult(mapId, winner, score) {
  const v = state.veto;
  if (!v || !Array.isArray(v.maps)) return;
  const m = v.maps.find(x => x._id === mapId);
  if (!m) return;
  m.winner = ['a', 'b', 'draw'].includes(winner) ? winner : '';
  if (score) m.score = { a: Number(score.a) || 0, b: Number(score.b) || 0 };
}

// Load an imported veto (FACEIT room / HLTV match page) as a finished board: the pool is exactly
// the maps acted on, the sequence is the order they were acted on, leftovers become the decider,
// and any map results on the page land on the board too.
function vetoLoad(imp, { game = 'csgo', title } = {}) {
  const pools = vetoData.mergedMapPools(state.gameConfigs);
  const g = (pools[game] || []).length ? game : 'csgo';
  const known = {};
  (pools[g] || []).forEach((m) => { if (m && m.id) known[m.id] = m; });
  const steps = (imp.steps || []).filter((s) => s && s.mapId);
  if (!steps.length) throw new Error('Nothing to import');
  const pool = steps.map((s) => known[s.mapId] || { id: s.mapId, name: s.map || s.mapId, image: s.image || '' });
  const manual = steps.filter((s) => s.action === 'ban' || s.action === 'pick');
  const side = (by) => (by === 1 ? 'b' : 'a');
  const meta = vetoData.getMeta(g);
  state.veto = {
    visible: !!(state.veto && state.veto.visible),
    title: typeof title === 'string' ? title : (state.veto && state.veto.title) || '',
    game: g, bestOf: [1, 3, 5, 7].includes(Number(imp.bestOf)) ? Number(imp.bestOf) : 3,
    teamStart: imp.teamStart === 'b' ? 'b' : 'a',
    kind: meta.kind, banWord: meta.banWord, unit: meta.unit, strikeFrom: '',
    pool,
    sequence: manual.map((s) => ({ action: s.action, by: side(s.by) })),
    ops: manual.map((s) => ({ mapId: s.mapId, action: s.action, by: side(s.by) })),
    maps: [], turn: null, complete: false,
    imported: { source: imp.source || '', at: Date.now() },
  };
  rebuildVetoBoard();
  (imp.results || []).forEach((r) => {
    if (!r || !r.mapId) return;
    const w = r.winner === 0 ? 'a' : r.winner === 1 ? 'b' : (r.score && r.score.a === r.score.b ? 'draw' : '');
    vetoResult(r.mapId, w, r.score);
  });
}

// The map CS2 just finished gets its result on the veto board without the producer typing it.
// CT is always the blue team (csApplyAutoTeams keeps that true across halves), so CT rounds = a.
function csRecordVetoResult() {
  const v = state.veto;
  if (!v || !Array.isArray(v.maps) || v.game !== 'csgo') return;
  const id = vetoImport.mapIdFromName(state.csgo.map && state.csgo.map.name);
  if (!id) return;
  const m = v.maps.find((x) => x && x.action !== 'ban' && vetoImport.mapIdFromName(x._id || x.name) === id);
  if (!m) return;
  const ct = Number(state.csgo.ct && state.csgo.ct.score) || 0, t = Number(state.csgo.t && state.csgo.t.score) || 0;
  if (!ct && !t) return;
  vetoResult(m._id, ct === t ? 'draw' : (ct > t ? 'a' : 'b'), { a: ct, b: t });
  console.log('[veto] ' + m.name + ' recorded ' + ct + '-' + t + ' from CS2 game state');
}

// HLTV sits behind Cloudflare. A plain request is tried once (it is what works when it works);
// a hidden or visible Electron 18 window never clears the browser check (tried 2026-10-11), so
// there is no window fallback: the import error tells the producer to paste the veto text.
async function fetchPageHtml(url) {
  const r = await vetoImport.httpGet(url);
  if (r.status < 400 && /veto-box|class="teamName"/.test(r.body)) return r.body;
  return '';
}

// ── Champion/hero draft engine ───────────────────────────────────────────────
// Same step model as the veto, but ops carry the typed champion name. The overlay
// (draft.html) renders state.draft into a blue/red pick-ban board.
function rebuildDraftTurn() {
  const d = state.draft;
  if (!d || !Array.isArray(d.sequence)) return;
  const next = d.sequence[(d.ops || []).length] || null;
  d.turn = next ? { team: next.by, action: next.action } : null;
  d.complete = (d.ops || []).length >= d.sequence.length;
}
// ── Overwatch hero bans are PER MAP ──
// owMatch.bansByMap[mapIdx] is the store (mapIdx = game.number - 1). state.draft is the editor for
// the CURRENT map only: when the map changes, its ops are reloaded from that map's stored bans, so
// map 1's bans no longer stay on the HUD during map 2, and stepping back to map 1 shows them again.
function owMapIdx() { return Math.max(0, ((state.game && state.game.number) || 1) - 1); }
function owDraftLoadMap() {
  const d = state.draft;
  if (!d || d.game !== 'overwatch' || !Array.isArray(d.sequence)) return;
  const idx = owMapIdx();
  const entry = ((state.owMatch && state.owMatch.bansByMap) || [])[idx] || {};
  const left = { a: [], b: [] };
  ['a', 'b'].forEach((side) => {
    const v = entry[side];
    const arr = Array.isArray(v) ? v : (v && v.hero ? [v] : []);
    left[side] = arr.filter((x) => x && x.hero);
  });
  // Replay the stored bans in sequence order; stop at the first slot that has none (ops are a prefix).
  const ops = [];
  for (const step of d.sequence) {
    const ban = step.action === 'ban' ? left[step.by].shift() : null;
    if (!ban) break;
    ops.push({ name: ban.hero, action: 'ban', by: step.by, role: ban.role || draftData.roleFor('overwatch', ban.hero, state.gameConfigs),
      image: draftData.imageFor('overwatch', ban.hero, state.gameConfigs) });
  }
  d.ops = ops;
  d.mapIdx = idx;
  rebuildDraftTurn();
}
// Called before every full-state flush: cheap no-op unless the map changed under an OW draft.
function syncOwDraftMap() {
  const d = state.draft;
  if (d && d.game === 'overwatch' && Array.isArray(d.sequence) && d.sequence.length && d.mapIdx !== owMapIdx()) owDraftLoadMap();
}
function clearOwMapBans(idx) {
  const bansByMap = [...((state.owMatch && state.owMatch.bansByMap) || [])];
  if (bansByMap[idx]) { bansByMap[idx] = {}; state.owMatch = { ...state.owMatch, bansByMap }; }
}
// Wipe the hero bans on EVERY map of the series, then reload the live board (it is map-scoped,
// so it comes back empty). The map pool and HUD read bansByMap directly, so stale entries on
// other maps would otherwise keep showing after the board looks clear.
function clearAllOwBans() {
  if (state.owMatch) state.owMatch = { ...state.owMatch, bansByMap: [] };
  const d = state.draft;
  if (d && d.game === 'overwatch' && Array.isArray(d.sequence)) { d.ops = []; owDraftLoadMap(); }
}
// Overwatch ban order for a total ban count: one each (A, B) or snake two each (A, B, B, A).
function owBanSequence(count, teamStart) {
  const steps = count >= 4 ? [0, 1, 1, 0] : [0, 1];
  return steps.map(t => ({ action: 'ban', by: draftData.resolveSide(t, teamStart || 'a') }));
}
// Rebuild a started draft's pick/ban ORDER from its current settings (who goes first, OW ban count).
function rebuildDraftSequence(d) {
  if (!d || !Array.isArray(d.sequence) || !d.sequence.length || !draftData.hasDraft(d.game)) return;
  d.sequence = d.game === 'overwatch' ? owBanSequence(d.owBanCount, d.teamStart)
    : draftData.buildDraft(d.game).map(s => ({ action: s.action, by: draftData.resolveSide(s.teamIdx, d.teamStart || 'a') }));
}
// The draft board's look preferences, carried over whenever the board itself is rebuilt.
function draftLookPrefs(prev) {
  const p = prev || {};
  const DRAFT_LAYOUTS = ['auto', 'strip', 'board'];   // local: callable at any point of boot (no TDZ)
  const secs = Number(p.turnSeconds);
  return {
    layout: DRAFT_LAYOUTS.includes(p.layout) ? p.layout : 'auto',
    stripPos: p.stripPos === 'bottom' ? 'bottom' : 'top',
    turnSeconds: Number.isFinite(secs) ? Math.max(-1, Math.min(180, Math.round(secs))) : 0
  };
}
function draftStart({ game, teamStart, title, subtitle, owBanCount }) {
  const g = draftData.hasDraft(game) ? game : (draftData.hasDraft(state.activeGame) ? state.activeGame : 'league');
  if (!draftData.hasDraft(g)) throw new Error('No draft format defined for ' + g);
  const ts = teamStart === 'b' ? 'b' : (teamStart === 'a' ? 'a' : ((state.draft && state.draft.teamStart) || 'a'));
  // Overwatch ban count is configurable: 2 (one per team, the default) or 4 (two per team, snake A-B-B-A).
  let owCount = Number(owBanCount) || (state.draft && state.draft.owBanCount) || 2;
  owCount = owCount >= 4 ? 4 : 2;
  const seq = g === 'overwatch' ? owBanSequence(owCount, ts)
    : draftData.buildDraft(g).map(s => ({ action: s.action, by: draftData.resolveSide(s.teamIdx, ts) }));
  state.draft = {
    visible: !!(state.draft && state.draft.visible),
    title:    typeof title === 'string'    ? title    : (state.draft && state.draft.title)    || '',
    subtitle: typeof subtitle === 'string' ? subtitle : (state.draft && state.draft.subtitle) || '',
    game: g, teamStart: ts, owBanCount: owCount, ...draftLookPrefs(state.draft), sequence: seq, ops: [], turn: null, complete: false,
    auto: (state.draft && state.draft.auto) || { enabled: false, status: 'off', statusDetail: '', lockfilePath: '' }
  };
  // A fresh Overwatch start wipes THIS map's stored bans (other maps keep theirs).
  if (g === 'overwatch') { clearOwMapBans(owMapIdx()); state.draft.mapIdx = owMapIdx(); }
  rebuildDraftTurn();
}
// The in-game HUD overlay (overlay/overwatch.html) shows hero bans from state.owMatch.bansByMap,
// NOT from state.draft — a separate, older per-map ban tracker. Mirror every Overwatch draft ban
// into it (keyed to the current map, side, and ban slot) so bans made from the Draft panel actually
// show up on the broadcast HUD, matching which team banned which hero.
function setOwBanSlot(side, slot, hero, role) {
  if (slot > 1) return; // OW_HERO_BANS caps each side at 2 bans — nothing to mirror past that
  const mapIdx = Math.max(0, ((state.game && state.game.number) || 1) - 1);
  const bansByMap = [...(state.owMatch.bansByMap || [])];
  while (bansByMap.length <= mapIdx) bansByMap.push({});
  const entry = { ...(bansByMap[mapIdx] || {}) };
  const prevArr = Array.isArray(entry[side]) ? entry[side] : [];
  const arr = [prevArr[0] || { hero: '', role: '' }, prevArr[1] || { hero: '', role: '' }];
  arr[slot] = { hero: hero || '', role: role || '' };
  entry[side] = arr;
  bansByMap[mapIdx] = entry;
  state.owMatch = { ...state.owMatch, bansByMap };
}
function draftAction(name) {
  const d = state.draft;
  if (!d || !Array.isArray(d.sequence)) return;
  if (d.ops.length >= d.sequence.length) return;
  const champ = (name || '').toString().slice(0, 40).trim();
  if (!champ) return;
  const step = d.sequence[d.ops.length];
  if (step.action === 'ban' && !draftData.roleLimitOk(d.game, d.ops, champ, state.gameConfigs)) {
    const role = draftData.roleFor(d.game, champ, state.gameConfigs);
    throw new Error(`Role limit reached — 2 ${role} heroes are already banned`);
  }
  const role = draftData.roleFor(d.game, champ, state.gameConfigs);
  const priorBans = d.ops.filter((o) => o.by === step.by && o.action === 'ban').length;
  d.ops.push({ name: champ, action: step.action, by: step.by, image: draftData.imageFor(d.game, champ, state.gameConfigs), role });
  rebuildDraftTurn();
  if (d.game === 'overwatch' && step.action === 'ban') setOwBanSlot(step.by, priorBans, champ, role);
}
function draftUndo() {
  const d = state.draft;
  if (d && d.ops && d.ops.length) {
    const removed = d.ops.pop();
    if (d.game === 'overwatch' && removed.action === 'ban') {
      const priorBans = d.ops.filter((o) => o.by === removed.by && o.action === 'ban').length;
      setOwBanSlot(removed.by, priorBans, '', '');
    }
    rebuildDraftTurn();
  }
}
function draftReset() {
  const d = state.draft;
  if (d) {
    if (d.game === 'overwatch') { clearOwMapBans(owMapIdx()); d.mapIdx = owMapIdx(); }
    d.ops = [];
    // Rebuild the order from the current settings, so changing Goes first / ban count and pressing
    // Reset actually changes the board (it used to keep whatever the draft was started with).
    rebuildDraftSequence(d);
    rebuildDraftTurn();
  }
}

// ── LoL champ-select automation: poll the League Client and mirror the live draft ──────────
let _lolDraftStop = null;
function _draftSig() { const d = state.draft || {}; return (d.game || '') + '#' + (d.ops || []).map((o) => o.name).join('|'); }
function syncDraftFromLcu(norm) {
  if (!norm) return;                                  // no champ select active → leave the board as-is
  const done = norm.done || [];
  let d = state.draft;
  // Ensure a LoL draft is initialised (don't clobber an in-progress one of the right shape).
  if (!d || d.game !== 'league' || !Array.isArray(d.sequence) || !d.sequence.length) {
    draftStart({ game: 'league', teamStart: (d && d.teamStart) || 'a', title: (d && d.title) || '' });
    d = state.draft;
  }
  if (done.length < d.ops.length) draftReset();       // champ select restarted → rebuild
  for (let i = d.ops.length; i < done.length && i < d.sequence.length; i++) draftAction(done[i].name);
}
function startLolDraftAuto() {
  if (_lolDraftStop) return;
  _lolDraftStop = lolChampSelect.startPoller({
    getLockfilePath: () => (state.draft && state.draft.auto && state.draft.auto.lockfilePath) || '',
    onUpdate: (norm) => {
      try {
        const before = _draftSig();
        syncDraftFromLcu(norm);
        if (_draftSig() !== before) { saveAppState(); broadcastFullState(); }
      } catch (e) {}
    },
    onStatus: (status, detail) => {
      if (!state.draft.auto) state.draft.auto = {};
      state.draft.auto.status = status; state.draft.auto.statusDetail = detail;
      broadcast(bridgeClients, { type: 'lol_draft_status', data: { status, detail } });
    }
  });
  console.log('[LoL Draft] Auto champ-select polling started');
}
function stopLolDraftAuto() {
  if (_lolDraftStop) { try { _lolDraftStop(); } catch (e) {} _lolDraftStop = null; }
  if (state.draft && state.draft.auto) { state.draft.auto.status = 'off'; state.draft.auto.statusDetail = ''; }
  broadcast(bridgeClients, { type: 'lol_draft_status', data: { status: 'off', detail: '' } });
}

// Clean-observer config — hides the native CS2 HUD so only our overlay shows.
// All commands here are either harmless client render toggles (cl_drawhud / crosshair)
// or sv_cheats-gated (inert online), so it's effectively private-match-only and VAC-safe.
const SPECTATOR_CFG = [
  '// cs2-spectator.cfg — clean observer view for NE Broadcast Suite (installed by the control panel).',
  '// Runs when CS2 is started with Launch CS2 for observing (or: exec cs2-spectator in the console).',
  '// F9 = clean observer view, F10 = normal HUD. Both keys are SAVED by CS2, so after this file has',
  '// run once they work in every later session, however CS2 is started.',
  '',
  '// Saved by CS2, safe for your own games too: switching players is a hard cut, not a camera glide.',
  'cl_obs_interp_enable 0',
  '',
  '// CS2 only honours cl_drawhud while cheats are on, and cheats reset with every new match, so the',
  '// keys turn them on first. That works where YOU host (practice, bots, a private match you started).',
  '// On a server with cheats off, cl_draw_only_deathnotices strips the HUD to the kill feed instead.',
  '// (Nothing here changes your crosshair, and the startup lines below are not saved by CS2.)',
  'sv_cheats 1',
  'cl_drawhud 0',
  'bind "F9" "sv_cheats 1; cl_drawhud 0; cl_draw_only_deathnotices 1"',
  'bind "F10" "cl_drawhud 1; cl_draw_only_deathnotices 0"',
  '',
  'echo "[NE Broadcast Suite] observer config loaded -- F9 clean observer view, F10 normal HUD"',
  ''
].join('\n');

// Write cs2-spectator.cfg into the CS2 cfg folder (reuses the GSI folder path).
function installSpectatorCfg(rawPath) {
  const raw = (rawPath || state.csgo.cfgPath || '').trim();
  if (!raw) throw new Error('Press Set up CS2, or enter your CS2 folder.');
  const dir = cs2Setup.resolveCfgDir(raw);
  if (!dir) throw new Error('CS2 cfg folder not found under ' + raw);
  const file = path.join(dir, 'cs2-spectator.cfg');
  fs.writeFileSync(file, SPECTATOR_CFG);
  return file;
}

function installGsiConfig(rawPath) {
  const raw = (rawPath || '').trim();
  if (!raw) throw new Error('Press Set up CS2, or enter your CS2 folder.');
  // The cfg folder, the CS2 install folder or a Steam library folder all work.
  const dir = cs2Setup.resolveCfgDir(raw);
  if (!dir) throw new Error('CS2 cfg folder not found under ' + raw);
  const file = path.join(dir, 'gamestate_integration_ne_broadcast_suite.cfg');
  fs.writeFileSync(file, GSI_CFG);
  state.csgo.cfgPath = dir;
  saveAppState();
  broadcastFullState();
  return file;
}

// ─── Flow Automation Engine ────────────────────────────────────────────────
// (moved to backend/flows/engine.js)
const { flowBus, _flowFireLog, initFlowEngine, _executeFlowAction, armSceneDwellFlows, _onObsVolumeMeters, _syncFlowIntervals, _flowSeqState, _evalCondition, _substituteTokens } = require('./backend/flows/engine')({
  get obsClient() { return obsClient; },
  get twitchClient() { return twitchClient; },
  get predictionManager() { return predictionManager; },
  get bridgeClients() { return bridgeClients; },
  get RL_SCENE_FAIL_MESSAGES() { return RL_SCENE_FAIL_MESSAGES; },
  get chatManager() { return chatManager; },
  axios, powerMonitor, EventEmitter, matchTitle, tl, state, saveAppState, broadcast, aiShielded, tagObsSwitch, syncReplayBufferAvailability, replayBufferErrorMessage, logAuto, setGfxActive, vmixDo, switcherIsVmix, switcherAutoCut, vmixMarkReplay, currentMatchFields, clearBreakAutoSwitch, scheduleBreakAutoSwitch, broadcastFullState
});
// ─── OBS WebSocket integration ──────────────────────────────────────────────
// Telemetry attribution for scene_change records (AI Producer training data). OBS WebSocket only
// reports "the program scene is now X" — it never says who/what caused it. Every code path in this
// file that ISSUES a switch calls tagObsSwitch() right before it; onSceneChange then attributes the
// resulting event to that hint if it arrives promptly for the same scene, otherwise the change came
// from outside our own switch calls (a producer clicking directly in OBS, an OBS hotkey, a 3rd-party
// tool) and is genuinely 'manual' with no more specific attribution available.
let _lastObsSwitchHint = null;   // { scene, source, ts } | null
function tagObsSwitch(sceneName, source) {
  _lastObsSwitchHint = { scene: (sceneName || '').trim(), source, ts: Date.now() };
}
// ─── OBS settings audit ──────────────────────────────────────────────────────
// Producers report "OBS keeps resetting my settings" and the only way to answer it
// used to be reading their OBS log — intrusive, and impossible for anyone running a
// custom/locked-down OBS. So the app keeps its own record instead: obs-client.js
// snapshots the values behind OBS's Settings > Output/Video dialog on connect and
// every 30s, and everything below turns a change into a timestamped, shareable line.
// We never write any of those values, so every entry here is something ELSE on that
// machine — which is exactly the question being argued about.
const OBS_AUDIT_MAX = 200;
let obsSettingsAudit = [];          // newest-last ring buffer, served by /api/obs/settings-audit
let obsSettingsCurrent = null;      // most recent snapshot

function obsAuditFile()     { return dataDir ? path.join(dataDir, 'obs-settings-audit.log') : ''; }
function obsAuditLastFile() { return dataDir ? path.join(dataDir, 'obs-settings-last.json') : ''; }

// Human-readable names for the raw OBS parameter keys, so a producer reading the
// audit sees "Video encoder" rather than "advEncoder".
const OBS_AUDIT_LABELS = {
  obsVersion: 'OBS version', platform: 'Platform', profile: 'Profile',
  profileCount: 'Profile count', sceneCollection: 'Scene collection',
  baseRes: 'Base (canvas) resolution', outputRes: 'Output (scaled) resolution', fps: 'FPS',
  outputMode: 'Output mode', advEncoder: 'Video encoder (advanced)',
  advRescale: 'Rescale output', advRescaleRes: 'Rescale resolution', advTrack: 'Audio track',
  simpleEncoder: 'Video encoder (simple)', simpleVBitrate: 'Video bitrate',
  simpleABitrate: 'Audio bitrate', simplePreset: 'Encoder preset',
};
const obsAuditLabel = (k) => OBS_AUDIT_LABELS[k] || k;

// OBS demotes a hardware encoder to software x264 when the hardware one fails to
// initialise at launch (driver update, GPU swapped, laptop woke on the iGPU) and
// WRITES that demotion into the profile — which is what a producer experiences as
// "OBS reset my settings". We surface it loudly and do NOTHING about it: putting the
// encoder back would be this app changing the producer's OBS, which it must never
// do. Which encoder they run is their call, on their machine.
const OBS_SOFTWARE_ENCODERS = /^(obs_)?x264/i;
const OBS_HARDWARE_ENCODERS = /(nvenc|amf|qsv|apple|videotoolbox|vaapi)/i;
function encoderDemotion(changes) {
  return changes.find((c) => (c.key === 'advEncoder' || c.key === 'simpleEncoder')
    && OBS_HARDWARE_ENCODERS.test(c.from || '') && OBS_SOFTWARE_ENCODERS.test(c.to || ''));
}

function recordObsAudit(entry) {
  obsSettingsAudit.push(entry);
  if (obsSettingsAudit.length > OBS_AUDIT_MAX) obsSettingsAudit = obsSettingsAudit.slice(-OBS_AUDIT_MAX);
  const file = obsAuditFile();
  if (!file) return;
  const lines = entry.changes.map((c) => `    ${obsAuditLabel(c.key)}: ${c.from}  ->  ${c.to}`).join('\n');
  fs.appendFile(file, `[${entry.at}] ${entry.title}\n${lines}\n`, () => {});
}

function handleObsSettingsSnapshot({ snapshot, changes, first, reason }) {
  obsSettingsCurrent = snapshot;

  // A probe that could not be read is stated, not swallowed — otherwise a failing
  // read is indistinguishable from a setting that simply did not change, and the
  // audit quietly stops covering that value while still looking healthy.
  if (snapshot && snapshot._errors) {
    Object.entries(snapshot._errors).forEach(([key, why]) => {
      console.warn(`[OBS audit] could not read ${obsAuditLabel(key)} — ${why} (this value is NOT being watched)`);
    });
  }

  if (first) {
    // First read of this connection. Compare against the snapshot we persisted when we
    // last saw this OBS: that gap covers OBS's own startup, which is where a fallback
    // (a hardware encoder that failed to load, a profile that didn't come back) lands.
    let prev = null;
    try { if (obsAuditLastFile() && fs.existsSync(obsAuditLastFile())) prev = JSON.parse(fs.readFileSync(obsAuditLastFile(), 'utf8')); } catch (e) {}
    const acrossSessions = obsClient ? obsClient.diffSettings(prev && prev.snapshot, snapshot) : [];
    if (acrossSessions.length) {
      console.warn('[OBS audit] Settings differ from the last time we saw this OBS (changed while we were NOT connected):');
      acrossSessions.forEach((c) => console.warn(`  ${obsAuditLabel(c.key)}: ${c.from} -> ${c.to}`));
      const demoted = encoderDemotion(acrossSessions);
      if (demoted) console.warn(`[OBS audit] OBS DEMOTED THE ENCODER at startup: ${demoted.from} -> ${demoted.to}. The hardware encoder failed to initialise and OBS wrote the fallback into the profile. This app will not change it back — that is the producer's to set.`);
      recordObsAudit({
        at: new Date().toISOString(), changes: acrossSessions, whileConnected: false,
        encoderDemoted: demoted ? `${demoted.from} -> ${demoted.to}` : null,
        title: demoted
          ? `OBS demoted the encoder at startup (${demoted.from} -> ${demoted.to}) — the hardware encoder failed to load and OBS wrote the fallback into the profile. Not this app; not fixed by this app.`
          : `Changed while the app was NOT connected (since ${(prev && prev.at) || 'the last session'}) — OBS restart, profile switch, or another tool.`,
      });
    }
  } else if (changes.length) {
    // Changed under our nose, on a live socket. We sent no such request (they are
    // blocked at the socket), so this is another client, a plugin, or the producer.
    console.warn('[OBS audit] Settings changed WHILE CONNECTED — not by this app:');
    changes.forEach((c) => console.warn(`  ${obsAuditLabel(c.key)}: ${c.from} -> ${c.to}`));
    const demoted = encoderDemotion(changes);
    if (demoted) console.warn(`[OBS audit] ENCODER DEMOTED mid-session: ${demoted.from} -> ${demoted.to}.`);
    recordObsAudit({
      at: new Date().toISOString(), changes, whileConnected: true,
      encoderDemoted: demoted ? `${demoted.from} -> ${demoted.to}` : null,
      title: demoted
        ? `Encoder demoted mid-session (${demoted.from} -> ${demoted.to}) — the hardware encoder dropped out. Not this app; not fixed by this app.`
        : 'Changed while the app was connected — another OBS client, a plugin, or someone in the Settings dialog.',
    });
  }

  if (obsAuditLastFile()) {
    fs.writeFile(obsAuditLastFile(), JSON.stringify({ at: new Date().toISOString(), snapshot }, null, 2), () => {});
  }
}

let _obsClientGen = 0;   // a dropped client's late status callbacks are ignored
function obsAppName() { return obsAppIsStreamlabs() ? 'Streamlabs' : 'OBS'; }
// Every callback of a client that has since been replaced (OBS <-> Streamlabs) is ignored, so its
// late disconnect / scene-cleared events can't overwrite the new client's state.
function guardObsCallbacks(gen, cbs) {
  const out = {};
  Object.keys(cbs).forEach((k) => {
    const fn = cbs[k];
    out[k] = typeof fn === 'function' ? (...a) => (gen === _obsClientGen ? fn(...a) : undefined) : fn;
  });
  return out;
}
function obsAppIsStreamlabs() { return state.obs.app === 'streamlabs'; }
// The client for whichever app fills the OBS slot. Switching app drops the old client first.
function obsClientFactory() { return obsAppIsStreamlabs() ? createSlobsClient : createObsClient; }
function setupObsClient() {
  if (obsClient && (obsClient.kind === 'streamlabs') !== obsAppIsStreamlabs()) {
    const old = obsClient; obsClient = null;
    old.disconnect().catch(() => {});
  }
  const factory = obsClientFactory();
  if (!factory || obsClient) return;
  const gen = ++_obsClientGen;
  obsClient = factory(guardObsCallbacks(gen, {
    onSettingsSnapshot: handleObsSettingsSnapshot,
    onStatus: ({ connected, lastError }) => {
      const wasConnected = state.obs.connected;
      state.obs.connected = connected;
      state.obs.lastError = lastError || null;
      if (!connected) {
        state.obs.currentScene = '';
        state.obs.replayBufferActive = false;
        // Stream/record flags only change on OBS events, so a drop would leave them frozen at
        // whatever they last were: a dead "LIVE" light during an outage.
        state.obs.streaming = false;
        state.obs.recording = false;
        state.obs.streamStartedAt = 0;
        state.obs.recordStartedAt = 0;
        // Otherwise every mute/volume on-air pill keeps showing whatever it last knew — which
        // reads as "still accurate" — for the entire outage AND, without the reconnect refresh
        // below, forever after too (a mic muted/unmuted in OBS's own UI during the drop would
        // never be reflected). Blanking it here at least makes a live outage visibly show
        // "no info" instead of confidently-wrong stale state.
        state.obs.audioInputs = [];
        state.obs.sources = [];
      }
      if (wasConnected && !connected) try { analytics.event('disconnect', { what: 'OBS' }); } catch (e) {}
      if (wasConnected !== connected) tl(connected ? 'obs.connected' : 'obs.disconnected', connected ? undefined : { error: lastError || '' });
      // obs-client.js's own internal auto-reconnect (after a crash/restart/network blip) calls
      // this same onStatus on success — but only _doConnectObs (the producer's explicit Connect
      // click) ever called refreshObsAudio itself. Scenes/sources already self-heal via
      // onSceneListChange; audio never did, so a producer could believe a mic is muted/unmuted
      // for the rest of the show after ANY auto-reconnect, with zero visual indication.
      if (connected && !wasConnected) {
        refreshObsAudio().then(broadcastFullState).catch(() => {});
        refreshObsOutputs().then(broadcastFullState).catch(() => {});
        scheduleBrowserSourceRecovery();   // OBS restarted: any source that came up blank gets one refresh
      }
      broadcastFullState();
    },
    // The OBS program scene = the authoritative "what's on air" signal.
    onSceneChange: (sceneName) => {
      const prev = state.obs.currentScene || '';
      // obs-client reports a cut twice (optimistically after SetCurrentProgramScene, then OBS's own
      // CurrentProgramSceneChanged): the repeat ran every obs_scene_changed flow a second time, so a
      // toggle undid itself and a cut action fired twice. Only a real change counts.
      if ((sceneName || '') === prev) return;
      state.obs.currentScene = sceneName || '';
      console.log('[Scene] program: "' + prev + '" -> "' + (sceneName || '') + '"');
      tl('scene.program', { from: prev, to: sceneName || '' });
      // A disconnect reports '' (program unknown). That is not a scene: it must not become
      // "previous scene" (obs_scene_previous went dead after every reconnect) nor run scene flows.
      if (!sceneName) { broadcastFullState(); return; }
      if (prev) state.obs.previousScene = prev;   // for the obs_scene_previous flow action
      if (telemetry && (sceneName || '') !== prev) {
        let source = 'manual';
        if (_lastObsSwitchHint && _lastObsSwitchHint.scene === (sceneName || '').trim() && Date.now() - _lastObsSwitchHint.ts < 3000) {
          source = _lastObsSwitchHint.source;
        }
        _lastObsSwitchHint = null;
        telemetry.sceneChange({ scene: sceneName || '', prevScene: prev, source });
      }
      if ((sceneName || '') !== prev) try { analytics.event('scene_change', { scene: sceneName || '' }); } catch (e) {}
      flowBus.emit('obs_scene_changed', { scene: sceneName || '' });
      armSceneDwellFlows(sceneName || '');
      broadcastFullState();
    },
    // Live mirror of the connected OBS profile's scene collection.
    onSceneListChange: (scenes) => {
      state.obs.availableScenes = filterSwitchableScenes(scenes);
      refreshObsSources().then(broadcastFullState).catch(() => {});   // scene items changed with the list
      broadcastFullState();
    },
    // A media (commercial video) finished — auto-cut back to program if enabled.
    onMediaEnded: (inputName) => {
      // Only a media source in the commercial scene ends the commercial; a stinger or any other clip
      // finishing elsewhere used to cut back early.
      if (state.commercial.active && state.obs.commercialAutoReturn) {
        const cs = ((state.obs.scenes || {}).commercial || (state.obs.scenes || {}).break || '').trim();
        const inCommercial = (state.obs.sources || []).some((s) => s.scene === cs && s.source === inputName);
        const known = (state.obs.sources || []).some((s) => s.scene === cs);
        const elsewhere = (state.obs.sources || []).some((s) => s.scene !== cs && s.source === inputName);
        if (inCommercial || !known || !elsewhere) endCommercial();
      }
      flowBus.emit('obs_media_ended', { inputName: inputName || '' });
    },
    onMediaStarted: (inputName) => {
      flowBus.emit('obs_media_started', { inputName: inputName || '' });
    },
    onInputMuteChanged: ({ inputName, muted }) => {
      const inp = (state.obs.audioInputs || []).find((i) => i.name === inputName);
      if (inp) { inp.muted = !!muted; broadcastFullState(); }
      else refreshObsAudio().then(broadcastFullState).catch(() => {});   // input we hadn't inventoried yet
      flowBus.emit(muted ? 'obs_input_muted' : 'obs_input_unmuted', { inputName });
    },
    onInputVolumeChanged: ({ inputName, volumeDb }) => {
      const inp = (state.obs.audioInputs || []).find((i) => i.name === inputName);
      if (inp) { inp.volumeDb = Math.round((volumeDb || 0) * 10) / 10; broadcastObsVolume(); }
    },
    onSourceVisibilityChanged: ({ sceneName, sourceName, enabled }) => {
      const src = (state.obs.sources || []).find((s) => s.scene === sceneName && s.source === sourceName);
      if (src) { src.enabled = !!enabled; broadcastFullState(); }
      flowBus.emit(enabled ? 'obs_source_shown' : 'obs_source_hidden', { sceneName, sourceName });
    },
    onStreamStateChanged: ({ active, state: s }) => {
      state.obs.streaming = active;
      state.obs.streamStartedAt = active ? (state.obs.streamStartedAt || Date.now()) : 0;   // program-bar uptime
      if (s === 'OBS_WEBSOCKET_OUTPUT_STARTED') flowBus.emit('obs_stream_started', {});
      if (s === 'OBS_WEBSOCKET_OUTPUT_STOPPED') flowBus.emit('obs_stream_stopped', {});
      broadcastFullState();
    },
    onRecordStateChanged: ({ active, state: s, outputPath }) => {
      state.obs.recording = active;
      state.obs.recordStartedAt = active ? (state.obs.recordStartedAt || Date.now()) : 0;
      if (s === 'OBS_WEBSOCKET_OUTPUT_STARTED') { onRecordStartedForTitles(); flowBus.emit('obs_recording_started', {}); }
      if (s === 'OBS_WEBSOCKET_OUTPUT_STOPPED') { onRecordStoppedForTitles(outputPath); flowBus.emit('obs_recording_stopped', {}); }
      broadcastFullState();
    },
    onReplayBufferSaved: ({ path }) => {
      try { analytics.event('replay_saved'); } catch (e) {}
      flowBus.emit('obs_replay_saved', { path });
    },
    onReplayBufferStateChanged: ({ active }) => {
      state.obs.replayBufferActive = active;
      syncReplayBufferAvailability();
      broadcastFullState();
    },
    onVolumeMeters: _onObsVolumeMeters,
  }));
}

// ── Commercial break: cut to the Commercial scene, then return to program ────
function startCommercial() {
  const scenes = state.obs.scenes || {};
  const target = (scenes.commercial || scenes.break || '').trim();
  const vm = switcherIsVmix();
  const ready = vm ? (state.vmix.enabled && state.vmix.connected) : (obsClient && obsClient.isConnected());
  if (!ready || !target) {
    return { ok: false, message: !target ? `Map a Commercial ${vm ? 'input' : 'scene'} under Apps > Streaming software first.` : (vm ? 'vMix is not reachable.' : `Not connected to ${obsAppName()}.`) };
  }
  // A second Start while one is running kept cutting but overwrote returnScene with the commercial
  // scene itself, so End "returned" to the commercial and the show was stranded there.
  if (state.commercial && state.commercial.active) { tl('commercial.repeat-ignored'); return { ok: true, message: 'The commercial is already running.' }; }
  state.commercial = { active: true, returnScene: (switcherProgramName() || scenes.inGame || '').trim() };
  // Clear any stuck break overlay so it can't sit over the HUD — must also clear gfxActive
  // (not just .visible), or the break graphic stays live on gfx.html's layer over the commercial.
  setExclusiveGfxVisible('break', false);
  if (vm) switcherCut(target);
  else { tagObsSwitch(target, 'manual'); obsClient.switchScene(target); }
  broadcastFullState();
  return { ok: true, message: `Commercial — cut to "${target}".` };
}
function endCommercial() {
  const scenes = state.obs.scenes || {};
  const back = (state.commercial.returnScene || scenes.inGame || '').trim();
  state.commercial = { active: false, returnScene: '' };
  if (back && switcherIsVmix()) switcherCut(back);
  else if (obsClient && obsClient.isConnected() && back) { tagObsSwitch(back, 'manual'); obsClient.switchScene(back); }
  broadcastFullState();
  return { ok: true, message: back ? `Back to "${back}".` : 'Commercial ended.' };
}

// OBS's Replay Buffer can be switched off in OBS itself (Settings > Output > Replay Buffer), and
// then every replay request fails with "Replay buffer is not available.". Only the producer can turn
// it on — the suite never changes OBS settings — so say exactly where, once, instead of echoing the
// raw error on every click and every auto-capture.
const OBS_RB_OFF_MSG = 'OBS Replay Buffer is turned off in OBS. Turn it on in OBS: Settings > Output > Replay Buffer > Enable Replay Buffer, then Apply.';
function syncReplayBufferAvailability() {
  const v = obsClient && obsClient.isReplayBufferAvailable ? obsClient.isReplayBufferAvailable() : null;
  const avail = v === false ? false : v === true ? true : null;
  if (state.obs.replayBufferAvailable === avail) return false;
  state.obs.replayBufferAvailable = avail;
  return true;
}
function replayBufferErrorMessage(fallback) {
  if (obsClient && obsClient.isReplayBufferAvailable && obsClient.isReplayBufferAvailable() === false) return OBS_RB_OFF_MSG;
  return (obsClient && obsClient.getLastError()) || fallback;
}

// Serialize concurrent connect attempts: if a connect is already in flight,
// callers share its promise rather than starting a second overlapping connect.
let _obsConnectQueue = null;
async function connectObs() {
  if (_obsConnectQueue) return _obsConnectQueue;
  _obsConnectQueue = _doConnectObs().finally(() => { _obsConnectQueue = null; });
  return _obsConnectQueue;
}
async function _doConnectObs() {
  if (!obsClientFactory()) return false;
  setupObsClient();
  if (!obsClient) return false;
  try {
    if (obsClient.kind === 'streamlabs') await obsClient.connect({ url: state.obs.slobsUrl, password: slobsToken });
    else await obsClient.connect({ url: state.obs.url, password: obsPassword });
    state.obs.availableScenes = filterSwitchableScenes(await obsClient.getScenes());
    state.obs.availableTransitions = await obsClient.getTransitions();
    await refreshObsInventory();   // mixer + scene items for the on-air audio/source pills
    await refreshObsOutputs();     // already live/recording when the app opened? say so
    state.obs.lastError = null;
    try {
      state.obs.replayBufferActive = await obsClient.isReplayBufferActive();
    } catch (e) { state.obs.replayBufferActive = false; }
    syncReplayBufferAvailability();   // tells the panel up front if OBS has Replay Buffer switched off
    // DO NOT start OBS's replay buffer here. This ran on every CONNECT — i.e. the moment the suite
    // opened — and starting the buffer forces OBS to spin up a second encoder session. On a setup
    // where that session can't initialise (NVENC already held by the stream/recording, mismatched
    // replay-buffer output settings), OBS silently falls back and rewrites its own output config:
    // which is what "opening the program resets my OBS encoder settings / drops me to CPU" is.
    // Nothing is lost by not starting it: every capture path arms the buffer lazily first
    // (clip-manager ensureReplayBuffer, /api/twitch/clip, the Replays panel's buffer toggle).
    if (state.clips?.autoCapture && !state.obs.replayBufferActive) {
      console.log('[Clips] Auto-capture is on but OBS\'s Replay Buffer is off — it will be started on the first capture, not at connect (starting it here rewrote OBS output settings on some setups).');
    }
    broadcastFullState();
    scheduleBrowserSourceRecovery();
    return true;
  } catch (e) {
    console.warn('[OBS] Connect failed:', e && e.message ? e.message : e);
    return false;
  }
}

// ── Browser sources that never loaded ─────────────────────────────────────────────────────────
// Every recovery path for an overlay (WS reconnect, reload_overlays, "Reload OBS") needs the page to
// be running. When OBS starts before the app, or a source is (re)loaded while the app restarts, CEF
// shows its error page and nothing ever refreshes it: the source stays blank all show. After OBS
// connects we look at OBS's browser sources that point at THIS server and refresh only the ones whose
// page has never been fetched this session and has no live overlay socket: a source that loaded is
// never touched (no blink on air). Each source is refreshed at most twice per session. Refreshing a
// source is the same as its own "Refresh" button; it changes no OBS setting.
const _pagesServed = new Set();
const _bsRefreshCount = {};
let _bsRecoveryTimer = null;
function scheduleBrowserSourceRecovery() {
  if (_bsRecoveryTimer) clearTimeout(_bsRecoveryTimer);
  // Give freshly (re)connected sources time to load first.
  _bsRecoveryTimer = setTimeout(() => { _bsRecoveryTimer = null; recoverFailedBrowserSources().catch((e) => console.warn('[OBS] browser source check failed:', e && e.message)); }, 20000);
}
function _ourOverlayPath(url) {
  let u;
  try { u = new URL(String(url || '')); } catch (e) { return ''; }
  if (u.protocol !== 'http:') return '';
  if (String(u.port || '80') !== String(HTTP_PORT)) return '';
  const h = u.hostname.replace(/^\[|\]$/g, '');
  if (!(h === 'localhost' || h === '127.0.0.1' || h === '::1' || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || !h.includes('.'))) return '';
  return /\.html$/i.test(u.pathname) ? u.pathname.toLowerCase() : '';
}
async function recoverFailedBrowserSources() {
  if (!obsClient || obsClient.kind === 'streamlabs' || !obsClient.isConnected()) return;
  const list = await obsClient.call('GetInputList', { inputKind: 'browser_source' });
  const inputs = (list && list.inputs) || [];
  const live = overlayClientInfo().pages || {};
  const livePaths = new Set(Object.keys(live).map((p) => String(p).toLowerCase()));
  for (const inp of inputs) {
    const name = inp.inputName;
    if (!name || (_bsRefreshCount[name] || 0) >= 2) continue;
    const st = await obsClient.call('GetInputSettings', { inputName: name });
    const s = (st && st.inputSettings) || {};
    if (s.is_local_file) continue;
    const path = _ourOverlayPath(s.url);
    if (!path || _pagesServed.has(path) || livePaths.has(path)) continue;
    _bsRefreshCount[name] = (_bsRefreshCount[name] || 0) + 1;
    console.log('[OBS] browser source "' + name + '" (' + path + ') never loaded this session: refreshing it');
    tl('source.refresh', { source: name, page: path, attempt: _bsRefreshCount[name] });
    await obsClient.call('PressInputPropertiesButton', { inputName: name, propertyName: 'refreshnocache' });
  }
}

// Scenes a producer can actually cut to — drops the generated collection's blank
// "═══ DIVIDER ═══" separators and the "=> Cam" utility scenes (cutting to either
// puts a black frame / a lone cam on program).
function filterSwitchableScenes(scenes) {
  return (Array.isArray(scenes) ? scenes : []).filter((s) => !/^═/.test(s) && !/^=>/.test(s));
}

// ── OBS mixer + scene-item inventory (for the on-air audio/source control pills) ──
// Live snapshot in state.obs.audioInputs / state.obs.sources; kept fresh by connect + OBS events.
async function refreshObsAudio() {
  if (!obsClient || !obsClient.isConnected()) { state.obs.audioInputs = []; return; }
  try {
    const list = await obsClient.call('GetInputList');
    const out = [];
    for (const inp of ((list && list.inputs) || [])) {
      const name = inp.inputName;
      try {
        const vol = await obsClient.call('GetInputVolume', { inputName: name });
        const mute = await obsClient.call('GetInputMute', { inputName: name });
        out.push({ name, muted: !!(mute && mute.inputMuted), volumeDb: (vol && typeof vol.inputVolumeDb === 'number') ? Math.round(vol.inputVolumeDb * 10) / 10 : 0 });
      } catch (e) { /* input has no audio track — skip it */ }
    }
    state.obs.audioInputs = out;
  } catch (e) { /* keep last-known on a transient error */ }
}
const OBS_SOURCES_CAP = 300;   // guard against a pathological scene collection
async function refreshObsSources() {
  if (!obsClient || !obsClient.isConnected()) { state.obs.sources = []; return; }
  try {
    const out = [];
    for (const scene of (state.obs.availableScenes || [])) {
      if (out.length >= OBS_SOURCES_CAP) break;
      try {
        const r = await obsClient.call('GetSceneItemList', { sceneName: scene });
        for (const it of ((r && r.sceneItems) || [])) {
          if (!it.sourceName) continue;
          out.push({ scene, source: it.sourceName, enabled: !!it.sceneItemEnabled });
          if (out.length >= OBS_SOURCES_CAP) break;
        }
      } catch (e) { /* scene vanished mid-refresh */ }
    }
    state.obs.sources = out;
  } catch (e) { /* keep last-known */ }
}
// Stream + record state are otherwise only learned from OBS *change* events, so an app opened while
// OBS was already live showed "off air" until the next start/stop.
async function refreshObsOutputs() {
  if (!obsClient || !obsClient.isConnected()) { state.obs.streaming = false; state.obs.recording = false; state.obs.streamStartedAt = 0; state.obs.recordStartedAt = 0; return; }
  // outputDuration (ms) back-dates the start, so uptime is right even when the app opened mid-show.
  try {
    const ss = await obsClient.call('GetStreamStatus');
    if (ss) { state.obs.streaming = !!ss.outputActive; state.obs.streamStartedAt = ss.outputActive ? Date.now() - (ss.outputDuration || 0) : 0; }
  } catch (e) {}
  try {
    const rs = await obsClient.call('GetRecordStatus');
    if (rs) { state.obs.recording = !!rs.outputActive; state.obs.recordStartedAt = rs.outputActive ? Date.now() - (rs.outputDuration || 0) : 0; }
  } catch (e) {}
}
async function refreshObsInventory() { await refreshObsAudio(); await refreshObsSources(); }

// Volume events fire rapidly while a fader is dragged — coalesce the broadcasts.
let _obsVolTimer = null, _obsVolPending = false;
function broadcastObsVolume() {
  if (_obsVolTimer) { _obsVolPending = true; return; }
  broadcastFullState();
  _obsVolTimer = setTimeout(() => { _obsVolTimer = null; if (_obsVolPending) { _obsVolPending = false; broadcastFullState(); } }, 150);
}

// ── Unified automation activity log ─────────────────────────────────────────
// One timeline of every action AUTOMATION took (RL cuts, countdown handoffs, flow fires,
// flow scene switches) so producers can always answer "why did the scene just change?".
// Session-only ring buffer, broadcast in live state, rendered by the What's Armed panel.
const _autoLog = [];
function logAuto(kind, message) {
  _autoLog.unshift({ ts: Date.now(), kind, message: String(message).slice(0, 200) });
  if (_autoLog.length > 50) _autoLog.length = 50;
}

// Unified graphics overlay (gfx.html) active-scene switch — the ONE place every "push a graphic
// live" surface should route through (qrail Put-On-Air, deck, main Push Live, and now Flows).
// gfx.html only ever renders one layer (state.gfxActive), but each graphic also carries its own
// .visible flag, so this mirrors .visible to gfxActive: the active layer's flag on, every other
// EXCLUSIVE layer's flag off. Persistent overlays (Ticker, Sponsor, Casters/Desk, Teams-to-Watch)
// are deliberately not in this map — they're meant to stack alongside a punch-up graphic.
// Extracted from the 'set_gfx_active' WS case so a Flow action can call it directly server-side.
const GFX_EXCLUSIVE_VISIBLE = {
  break: 'breakScreen', winner: 'winner', intro: 'intro', veto: 'veto', draft: 'draft',
  bracket: 'bracket', schedule: 'upcoming', upcoming: 'upcoming', standings: 'standings', credits: 'credits',
  seriesstats: 'seriesStats',
  // Battle-royale graphics. These live UNDER state.br rather than at the top level (they're part
  // of the BR series model, not standalone scenes), hence the dotted paths — gfxObj() below
  // resolves both forms so every existing flat entry above keeps working untouched.
  brdrop: 'br.dropmap', brcompare: 'br.compare', brvictory: 'br.victory'
  // matchup has no independent .visible flag (it's active purely via gfxActive) — nothing to clear.
  // The spotlight/watchlist/teamSpotlight family is deliberately left out: the gfx key 'spotlight'
  // is wired to watchlist.visible in one surface and spotlight.visible in another, so auto-clearing
  // by key could hide the one that's actually live. They're niche and stay independent.
};
// Resolve a GFX_EXCLUSIVE_VISIBLE value to the state object holding the .visible flag.
// Accepts a plain top-level key ('winner') or a dotted path ('br.dropmap').
function gfxObj(objName) {
  if (!objName) return null;
  let cur = state;
  for (const part of String(objName).split('.')) {
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[part];
  }
  return (cur && typeof cur === 'object') ? cur : null;
}
function setGfxActive(scene) {
  state.gfxActive = scene && typeof scene === 'string' ? scene : null;
  const activeObj = GFX_EXCLUSIVE_VISIBLE[state.gfxActive] || null;
  Object.keys(GFX_EXCLUSIVE_VISIBLE).forEach((k) => {
    const objName = GFX_EXCLUSIVE_VISIBLE[k];
    if (objName === activeObj) return;                       // leave the now-active layer alone
    const o = gfxObj(objName);
    if (o && o.visible) o.visible = false;
  });
  const ao = gfxObj(activeObj);
  if (ao) ao.visible = true;
  broadcastFullState();
}

// Toggling one of the exclusive punch-up scenes' own .visible flag (draft/bracket/upcoming/
// standings/credits/etc.) must ALSO drive gfxActive, or the change never reaches overlay/gfx.html
// — it gates purely on gfxActive, not any individual scene's .visible flag. Several handlers used
// to set .visible directly and nothing else, so pushing them live from the On-Air Elements panel
// silently showed nothing on stream, and "Hide all" / an auto-cut clearing .visible left the
// graphic live on gfx.html's layer. Centralized here so every call site (current and future)
// gets the exclusivity dance right instead of reimplementing it inline.
function setExclusiveGfxVisible(key, visible) {
  if (visible) { setGfxActive(key); return; }
  if (state.gfxActive === key) { setGfxActive(null); return; }
  const o = gfxObj(GFX_EXCLUSIVE_VISIBLE[key]);
  if (o) o.visible = false;
}

async function disconnectObs() {
  if (!obsClient) return;
  try { await obsClient.disconnect(); } catch (e) { /* ignore */ }
  state.obs.connected = false;
  state.obs.availableScenes = [];
  state.obs.availableTransitions = [];
  state.obs.audioInputs = [];
  state.obs.sources = [];
  broadcastFullState();
}

let _csgoLastMapPhase = '';
let _csgoLastRoundPhase = '';
let _csgoLastBombState = '';
let _cs2ClutchFired = false;   // re-armed each round (see handleGsi) so cs2_clutch_situation fires once per round

// Switch OBS to the scene mapped to a broadcast moment, if auto-switch is on.
// TEMPORARY: all automatic OBS scene switching is disabled (per request). The app performs NO
// game-event-driven scene cuts (kickoff / in-game / post-game / replay / break / casters / bracket /
// Smart Triggers). Manual switching via the 'obs_switch_scene' message is unaffected. Set this back
// to false to restore auto scene switching.
const OBS_AUTO_SWITCH_DISABLED = true;
function obsSwitch(sceneKey) {
  if (OBS_AUTO_SWITCH_DISABLED || aiShielded()) return;
  // The moment map (state.obs.scenes) and the auto-switch toggle are shared by both switchers:
  // with vMix in charge the mapped names are vMix input titles.
  if (switcherIsVmix()) {
    if (!state.obs.autoSwitch) return;
    const name = (state.obs.scenes && state.obs.scenes[sceneKey] || '').trim();
    if (!name) { console.log(`[vMix] Auto-switch skipped — no input mapped for "${sceneKey}"`); return; }
    const r = switcherAutoCut(name);
    if (!r.ok) console.log(`[vMix] Auto-switch to "${name}" skipped — ${RL_SCENE_FAIL_MESSAGES[r.reason] || r.reason}`);
    return;
  }
  if (!obsClient || !state.obs.enabled || !state.obs.autoSwitch) return;
  if (!obsClient.isConnected()) return;
  const sceneName = (state.obs.scenes && state.obs.scenes[sceneKey] || '').trim();
  if (!sceneName) {
    console.log(`[OBS] Auto-switch skipped — no scene mapped for "${sceneKey}"`);
    return;
  }
  console.log(`[OBS] Auto-switch → ${sceneName} (${sceneKey})`);
  tagObsSwitch(sceneName, 'auto');
  obsClient.switchScene(sceneName);
}


// ── vMix control (full alternative backend) ────────────────────────────────────────────────
// Fire a vMix function via the HTTP API using the configured host/port. No-op unless enabled.
async function vmixDo(fn, params) {
  if (!state.vmix.enabled) return { ok: false, reason: 'vmix_disabled' };
  try {
    await vmix.vmixCall(state.vmix.host, state.vmix.port, fn, params || {});
    return { ok: true };
  } catch (e) {
    state.vmix.lastError = e.message;
    return { ok: false, reason: e.message };
  }
}

// Poll vMix state (~1.5s) while enabled; broadcast only when something meaningful changes so we
// don't spam full_state. Marks connected/disconnected + lastError.
let _vmixSig = '';
async function pollVmix() {
  if (!state.vmix.enabled) {
    if (state.vmix.connected) { state.vmix.connected = false; broadcastFullState(); }
    return;
  }
  try {
    const s = await vmix.vmixState(state.vmix.host, state.vmix.port);
    // Remember what was on program before a change, for the "previous scene" flow action.
    if (state.vmix.connected && state.vmix.active != null && s.active != null && String(s.active) !== String(state.vmix.active)) {
      const was = switcherProgramName();
      if (was) state.vmix.previousTitle = was;
    }
    Object.assign(state.vmix, {
      connected: true, lastError: null,
      version: s.version, edition: s.edition, active: s.active, preview: s.preview,
      streaming: s.streaming, recording: s.recording, inputs: s.inputs, overlays: s.overlays
    });
  } catch (e) {
    state.vmix.connected = false;
    state.vmix.lastError = e.code === 'ECONNREFUSED' ? 'vMix not reachable (is it running with the Web API on?)' : e.message;
  }
  const sig = JSON.stringify({
    c: state.vmix.connected, a: state.vmix.active, p: state.vmix.preview,
    st: state.vmix.streaming, rec: state.vmix.recording, e: state.vmix.lastError,
    n: state.vmix.inputs.map((i) => i.number + ':' + i.title + ':' + (i.volume == null ? '' : Math.round(i.volume)) + ':' + (i.muted ? 1 : 0)).join(','),
    ov: state.vmix.overlays.map((o) => o.input).join(','),
    ver: state.vmix.version
  });
  if (sig !== _vmixSig) { _vmixSig = sig; broadcastFullState(); }
}
setInterval(() => { pollVmix().catch(() => {}); }, 1500);

// Lightweight vMix VU-meter push — only while the Switcher page is open + vMix is the backend.
// Sends a tiny 'vmix-meters' message (~2fps) so the mixer shows live level movement without
// broadcasting full state. OBS exposes no meters over its WS API, so this is vMix-only.
setInterval(async () => {
  if (!_switcherWatching || state.switcher.target !== 'vmix' || !state.vmix.enabled) return;
  try {
    const s = await vmix.vmixState(state.vmix.host, state.vmix.port);
    const levels = s.inputs.filter((i) => i.audio).map((i) => ({ n: i.number, m: Math.max(i.meterF1 || 0, i.meterF2 || 0), vol: i.volume, muted: i.muted }));
    broadcast(bridgeClients, { type: 'vmix-meters', data: { levels } });
  } catch (e) { /* non-fatal */ }
}, 500);

// ── Production switcher routing (OBS or vMix — mutually exclusive) ────────────
// Cut PROGRAM to a target on the ACTIVE backend. OBS: scene NAME. vMix: input (matched by
// number / name / GUID). vMix matches inputs by title, so as long as vMix input titles mirror
// the OBS scene names, every existing obs_switch_scene caller in the app works on BOTH backends
// with no per-caller changes. No-op when the active backend isn't ready.
function switcherIsVmix() { return !!(state.switcher && state.switcher.target === 'vmix'); }
function vmixSourceNames() { return ((state.vmix && state.vmix.inputs) || []).map((i) => i.title).filter(Boolean); }
// The scene the active switcher has on program right now (OBS scene name / vMix input title).
function switcherProgramName() {
  if (switcherIsVmix()) {
    const a = String(state.vmix.active == null ? '' : state.vmix.active);
    const hit = (state.vmix.inputs || []).find((i) => String(i.number) === a);
    return hit ? hit.title : '';
  }
  return (state.obs.currentScene || '').trim();
}
// vMix transition functions; an OBS transition name means nothing to vMix, so anything else cuts.
const VMIX_TRANSITIONS = /^(Cut|Fade|Zoom|Wipe|Slide|Fly|CrossZoom|FlyRotate|Cube|CubeZoom|VerticalWipe|VerticalSlide|Merge|WipeReverse|SlideReverse|VerticalWipeReverse|VerticalSlideReverse|Stinger[1-4])$/;
// Cut program for an AUTOMATED moment (game events, RL kickoff / post-game, countdown end,
// commercial) on whichever switcher is in charge. Validates first, because an automated cut that
// silently does nothing is the hardest show failure to diagnose. Returns { ok, reason }.
function switcherAutoCut(name, transitionName) {
  const r = _switcherAutoCut(name, transitionName);
  tl(r.ok ? 'scene.cut.request' : 'scene.cut.refused', { to: (name || '').trim(), transition: (transitionName || '').trim(), by: 'automation', reason: r.reason });
  return r;
}
function _switcherAutoCut(name, transitionName) {
  const target = (name || '').trim();
  if (!target) return { ok: false, reason: 'no_scene' };
  if (aiShielded()) return { ok: false, reason: 'ai_shielded' };
  const tn = (transitionName || '').trim();
  if (switcherIsVmix()) {
    if (!state.vmix.enabled) return { ok: false, reason: 'vmix_disabled' };
    if (!state.vmix.connected) return { ok: false, reason: 'vmix_not_connected' };
    const names = vmixSourceNames();
    if (names.length && !names.includes(target) && !/^\d+$/.test(target)) return { ok: false, reason: 'input_missing' };
    console.log(`[vMix] Auto-cut → ${target}${tn ? ' (' + tn + ')' : ''}`);
    vmixDo(VMIX_TRANSITIONS.test(tn) ? tn : 'Cut', { Input: target })
      .then((r) => { if (!r.ok) console.warn('[vMix] auto-cut failed:', r.reason); });
    return { ok: true };
  }
  if (!obsClient) return { ok: false, reason: 'obs_not_connected' };
  if (!state.obs.enabled) return { ok: false, reason: 'obs_disabled' };
  if (!obsClient.isConnected()) return { ok: false, reason: 'obs_not_connected' };
  // The scene must still exist in OBS: renaming or deleting it is the most common reason automated
  // cuts "silently stop working". Only validated once a scene list has been fetched.
  const scenes = state.obs.availableScenes || [];
  if (scenes.length && !scenes.includes(target)) return { ok: false, reason: 'scene_missing' };
  tagObsSwitch(target, 'auto');
  if (tn) obsClient.switchSceneWithTransition(target, tn);
  else obsClient.switchScene(target);
  return { ok: true };
}

// The vMix calls backend/vmix-place.js needs (run a function / read state).
function vmixApi() {
  return { call: (fn, params) => vmixDo(fn, params), state: () => vmix.vmixState(state.vmix.host, state.vmix.port) };
}

// vMix's equivalent of "save the replay buffer": mark the last N seconds of its replay recording as
// an event, which then appears in vMix's replay event list ready to play. Needs vMix's Replay
// feature recording (vMix 4K/Pro editions).
const VMIX_REPLAY_SECONDS = 10;
function vmixMarkReplay() { return vmixDo('ReplayMarkLast', { Value: VMIX_REPLAY_SECONDS }); }

// Bumped by every operator cut; a cut that awaits something first checks it is still the latest.
let _manualCutSeq = 0;
function switcherCut(target, opts) {
  target = (target == null ? '' : String(target)).trim();
  if (!target) return;
  if (state.switcher.target === 'vmix') {
    if (!state.vmix.enabled) return;
    const fn = (opts && opts.transition) || 'Cut';
    const params = { Input: target };
    if (opts && opts.duration) params.Duration = opts.duration;
    vmixDo(fn, params).catch((e) => console.warn('[vmix: transition failed]', (e && e.message) || e));
    return;
  }
  if (obsClient && obsClient.isConnected()) { tagObsSwitch(target, 'manual'); obsClient.switchScene(target); }
}

// Set the PREVIEW (next) source on the active backend. OBS needs Studio Mode on.
// Studio Mode auto-enable is intentionally disabled (Switcher page — the only caller — is hidden
// from nav): this now silently no-ops on OBS unless Studio Mode was already turned on some other,
// deliberate way, so it can never flip a live show into Studio Mode by accident.
async function switcherSetPreview(target) {
  target = (target == null ? '' : String(target)).trim(); if (!target) return;
  if (state.switcher.target === 'vmix') { if (state.vmix.enabled) vmixDo('PreviewInput', { Input: target }); return; }
  if (!obsClient || !obsClient.isConnected()) return;
  if (!state.obs.studioMode) return;
  try {
    await obsClient.call('SetCurrentPreviewScene', { sceneName: target });
    state.obs.currentPreviewScene = target;
    broadcastFullState();
  } catch (e) { /* non-fatal */ }
}

// TAKE preview → program. mode 'cut' | 'fade'. OBS uses Studio Mode transition; vMix Cut/Fade.
// TAKE preview → program. transition: 'Cut' | 'Fade' | 'Stinger1..4' | 'Wipe' | 'Slide' | ...
// Studio Mode auto-enable disabled — see switcherSetPreview above; no-ops on OBS unless already on.
async function switcherTake(transition, durationMs) {
  transition = transition || 'Cut';
  const isCut = transition === 'Cut';
  if (state.switcher.target === 'vmix') {
    if (!state.vmix.enabled) return;
    vmixDo(transition, (!isCut && durationMs) ? { Duration: durationMs } : {}).catch((e) => console.warn('[vmix: transition failed]', (e && e.message) || e));
    return;
  }
  if (!obsClient || !obsClient.isConnected()) return;
  if (!state.obs.studioMode) return;
  try {
    // Map the requested transition onto OBS's configured transitions (Cut/Fade are always present;
    // Stinger/Wipe only if the OBS profile has one — fall back to Fade, else Cut).
    const avail = state.obs.availableTransitions || [];
    let trans = 'Cut';
    if (!isCut) {
      const want = /stinger/i.test(transition) ? avail.find((t) => /stinger/i.test(t)) : avail.find((t) => t.toLowerCase() === transition.toLowerCase());
      trans = want || avail.find((t) => /fade|dissolve/i.test(t)) || 'Fade';
    }
    if (typeof obsClient.withBorrowedTransition === 'function') {
      // Borrowed for this Take only; the producer's own transition comes back once it has played.
      await obsClient.withBorrowedTransition(trans, (!isCut && durationMs) ? durationMs : 0, () => obsClient.call('TriggerStudioModeTransition'));
    } else {
      try { await obsClient.call('SetCurrentSceneTransition', { transitionName: trans }); } catch (e) {}
      if (!isCut && durationMs) try { await obsClient.call('SetCurrentSceneTransitionDuration', { transitionDuration: durationMs }); } catch (e) {}
      await obsClient.call('TriggerStudioModeTransition');
    }
  } catch (e) { /* non-fatal */ }
}

// Stream / record / fade-to-black / replay — routed to the active backend.
// `ws` (optional) gets a toast when OBS refuses: a Go live with no stream key set must not look
// like a dead button.
function switcherOutputFail(ws, what, e) {
  if (!ws || ws.readyState !== 1) return;
  const why = (e && e.message) || 'OBS refused the request';
  try { ws.send(JSON.stringify({ type: 'obs-result', data: { ok: false, toast: true, message: 'Could not ' + what + ': ' + why } })); } catch (_) {}
}
function switcherStream(on, ws) {
  if (state.switcher.target === 'vmix') { if (state.vmix.enabled) vmixDo(on ? 'StartStreaming' : 'StopStreaming'); return; }
  if (obsClient && obsClient.isConnected()) obsClient.call(on ? 'StartStream' : 'StopStream').catch((e) => switcherOutputFail(ws, on ? 'start the stream' : 'stop the stream', e));
  else switcherOutputFail(ws, on ? 'start the stream' : 'stop the stream', { message: 'OBS is not connected' });
}
function switcherRecord(on, ws) {
  if (state.switcher.target === 'vmix') { if (state.vmix.enabled) vmixDo(on ? 'StartRecording' : 'StopRecording'); return; }
  if (obsClient && obsClient.isConnected()) obsClient.call(on ? 'StartRecord' : 'StopRecord').catch((e) => switcherOutputFail(ws, on ? 'start recording' : 'stop recording', e));
  else switcherOutputFail(ws, on ? 'start recording' : 'stop recording', { message: 'OBS is not connected' });
}
// ── Match titles: Twitch auto-title + VOD naming (backend/match-title.js) ──────────────────────
// One template engine, two outputs. The Twitch title follows the match on air: it is rebuilt every
// 2s, but only SENT once it has held still for 4s (typing a team name is not ten title changes) and
// never more than once per 10s. A failure is not retried for the same title (a 401/403 would only
// repeat), so the next match change, a settings save or Update now is what tries again.
function currentMatchFields() {
  return matchTitle.matchFields(state, {
    gameName: (GAMES[state.activeGame] && GAMES[state.activeGame].name) || '',
    stripSponsors: state.matchTitles.stripSponsors !== false
  });
}
function matchTitlePreviews() {
  const f = currentMatchFields();
  return {
    twitch: matchTitle.buildTitle(state.matchTitles.twitch.template, f, matchTitle.TWITCH_TITLE_MAX),
    vod: matchTitle.buildTitle(state.matchTitles.vod.template, f)
  };
}
let _mtPending = '', _mtPendingSince = 0, _mtApplied = '', _mtFailed = '', _mtBusy = false, _mtLastCallAt = 0, _mtPreviewKey = '';
function resetTwitchAutoTitle() { _mtApplied = ''; _mtFailed = ''; _mtPending = ''; _mtLastCallAt = 0; }
async function matchTitleTick() {
  const mt = state.matchTitles;
  if (_recLabel && state.obs.recording && _recLabel.epoch === _seriesEpoch) _recLabel.fields = currentMatchFields();
  const pv = matchTitlePreviews();
  const pvKey = pv.twitch + '\n' + pv.vod;
  if (pvKey !== _mtPreviewKey) { _mtPreviewKey = pvKey; mt.preview = pv; broadcastFullState(); }
  if (!mt.twitch.auto || _mtBusy) return;
  if (!twitchClient || !state.twitch.connected || !state.twitch.channelId) return;
  const title = pv.twitch;
  if (!title || title === _mtApplied || title === _mtFailed) { _mtPending = ''; return; }
  const now = Date.now();
  if (title !== _mtPending) { _mtPending = title; _mtPendingSince = now; return; }
  if (now - _mtPendingSince < 4000 || now - _mtLastCallAt < 10000) return;
  _mtBusy = true; _mtLastCallAt = now;
  try {
    await twitchClient.updateChannel(state.twitch.channelId, { title });
    _mtApplied = title; _mtFailed = '';
    mt.status = { twitchTitle: title, twitchAt: Date.now(), twitchError: '' };
    console.log('[match-titles] Twitch title -> ' + title);
  } catch (e) {
    const code = e && e.response && e.response.status;
    _mtFailed = title;
    mt.status.twitchError = code === 401 ? 'Twitch login expired. Reconnect Twitch to keep the title updating.'
      : code === 403 ? 'This Twitch login is not allowed to edit the channel title. Reconnect Twitch as the channel owner.'
      : ((e && e.response && e.response.data && e.response.data.message) || (e && e.message) || 'Title update failed');
    console.warn('[match-titles] Twitch title failed:', mt.status.twitchError);
  } finally {
    _mtBusy = false;
    broadcastFullState();
  }
}
setInterval(() => { matchTitleTick().catch((e) => console.warn('[match-titles] tick:', e && e.message)); }, 2000);

function onRecordStartedForTitles() {
  _recLabel = { epoch: _seriesEpoch, fields: currentMatchFields(), startedAt: Date.now() };
}
function onRecordStoppedForTitles(outputPath) {
  const snap = _recLabel;
  _recLabel = null;
  const mt = state.matchTitles;
  if (!mt.vod.rename || !outputPath) return;
  const fields = (snap && snap.fields) || currentMatchFields();
  const entry = {
    id: 'vod_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: Date.now(), status: 'pending', error: '', csvError: '',
    title: matchTitle.buildTitle(mt.vod.template, fields) || 'Recording',
    from: outputPath, path: '', filename: '', fields,
    durationSec: snap ? Math.round((Date.now() - snap.startedAt) / 1000) : 0
  };
  mt.vodLog.unshift(entry);
  mt.vodLog.length = Math.min(mt.vodLog.length, 30);
  broadcastFullState();
  finalizeVod(entry);
}

const _vodWait = (ms) => new Promise((r) => setTimeout(r, ms));
const _vodExists = (p) => fsp.access(p).then(() => true, () => false);
async function _vodUniquePath(dir, base, ext, self) {
  let cand = path.join(dir, base + ext);
  for (let i = 2; (await _vodExists(cand)) && cand.toLowerCase() !== String(self || '').toLowerCase(); i++) {
    cand = path.join(dir, `${base} (${i})${ext}`);
  }
  return cand;
}
// OBS can hold the file for a moment after stopping, and an auto-remux reads it for as long as the
// remux takes. Windows refuses to rename an open file, so wait it out (up to 15 minutes).
async function _vodRename(from, to) {
  const deadline = Date.now() + 15 * 60 * 1000;
  for (;;) {
    try { await fsp.rename(from, to); return; }
    catch (e) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(e.code) || Date.now() > deadline) throw e;
      await _vodWait(2000);
    }
  }
}

async function finalizeVod(entry) {
  const mt = state.matchTitles;
  const f = entry.fields || {};
  entry.status = 'pending'; entry.error = '';
  try {
    await _vodWait(3000);
    let src = entry.from;
    const ext = path.extname(src);
    const srcBase = src.slice(0, src.length - ext.length);
    // OBS's "Automatically remux to mp4" leaves (or replaces the original with) <name>.mp4.
    if (!(await _vodExists(src)) && ext.toLowerCase() !== '.mp4' && (await _vodExists(srcBase + '.mp4'))) src = srcBase + '.mp4';
    if (!(await _vodExists(src))) throw new Error('OBS recording not found: ' + src);
    const folder = mt.vod.eventFolder && f.event ? matchTitle.sanitizeFilename(f.event, 80) : '';
    const srcDir = path.dirname(entry.from);
    const dir = folder && path.basename(srcDir) !== folder ? path.join(srcDir, folder) : srcDir;
    const base = matchTitle.sanitizeFilename((mt.vod.datePrefix && f.date ? f.date + ' ' : '') + entry.title)
      || ('Recording ' + matchTitle.localDate());
    await fsp.mkdir(dir, { recursive: true });
    const target = await _vodUniquePath(dir, base, path.extname(src), src);
    if (target !== src) await _vodRename(src, target);
    entry.path = target;
    entry.filename = path.basename(target);
    entry.status = 'saved';
    console.log('[match-titles] recording saved as ' + target);
    broadcastFullState();
    if (mt.vod.csv) {
      const csvPath = path.join(dir, 'recordings.csv');
      try {
        const head = (await _vodExists(csvPath)) ? '' : matchTitle.CSV_HEADER.map(matchTitle.csvCell).join(',') + '\r\n';
        await fsp.appendFile(csvPath, head + matchTitle.csvRow(entry) + '\r\n', 'utf8');
        entry.csvError = '';
      } catch (e) {
        // Usually the sheet is open in Excel. The video is named either way; Retry re-appends.
        entry.csvError = 'Could not write recordings.csv (' + (e.code || e.message) + '). Close it if it is open in Excel, then Retry.';
      }
    }
    entry.row = matchTitle.tsvRow(entry);
    saveAppState();
    broadcastFullState();
    // A remux that finished after our rename leaves its mp4 under the OBS name; give it the same name.
    if (src === entry.from && ext.toLowerCase() !== '.mp4') {
      for (let i = 0; i < 20; i++) {
        await _vodWait(3000);
        if (await _vodExists(srcBase + '.mp4')) {
          const mp4 = await _vodUniquePath(dir, base, '.mp4');
          await _vodRename(srcBase + '.mp4', mp4).catch(() => {});
          break;
        }
      }
    }
    return;
  } catch (e) {
    entry.status = 'error';
    entry.error = (e && e.message) || String(e);
    console.warn('[match-titles] could not rename recording:', entry.error);
  }
  entry.row = matchTitle.tsvRow(entry);
  saveAppState();
  broadcastFullState();
}

function switcherFtb() {
  if (state.switcher.target === 'vmix') { if (state.vmix.enabled) vmixDo('FadeToBlack'); return; }
  // OBS has no native FTB — cut to a scene named Black/FTB if one exists.
  const black = (state.obs.availableScenes || []).find((s) => /^(black|ftb|fade to black)$/i.test(s.trim()));
  if (black && obsClient && obsClient.isConnected()) { tagObsSwitch(black, 'manual'); obsClient.switchScene(black); }
}
async function switcherReplay() {
  if (state.switcher.target === 'vmix') { if (state.vmix.enabled) vmixDo('ReplayPlayLastEvent'); return; }
  if (obsClient && obsClient.isConnected()) try { await obsClient.call('SaveReplayBuffer'); } catch (e) {}
}

// Adjust audio on a source. OBS: SetInputVolume(dB) / SetInputMute. vMix: SetVolume(0-100) / Audio.
async function switcherAudioSet(id, opts) {
  opts = opts || {};
  if (state.switcher.target === 'vmix') {
    if (!state.vmix.enabled) return;
    if (opts.volume != null) vmixDo('SetVolume', { Input: id, Value: Math.max(0, Math.min(100, Math.round(opts.volume))) });
    if (opts.muted != null) vmixDo(opts.muted ? 'AudioOff' : 'AudioOn', { Input: id });
    return;
  }
  if (!obsClient || !obsClient.isConnected()) return;
  try {
    if (opts.volume != null) await obsClient.call('SetInputVolume', { inputName: id, inputVolumeDb: Math.max(-60, Math.min(0, opts.volume)) });
    if (opts.muted != null) await obsClient.call('SetInputMute', { inputName: id, inputMuted: !!opts.muted });
  } catch (e) { /* non-fatal */ }
}

// Poll OBS program/preview/studio-mode while the Switcher page is open (client toggles _switcherWatching).
let _switcherWatching = false;
let _obsPreviewSig = '';
async function pollObsPreview() {
  if (!_switcherWatching || state.switcher.target !== 'obs') return;
  if (!obsClient || !obsClient.isConnected()) return;
  try {
    const sm = await obsClient.call('GetStudioModeEnabled');
    state.obs.studioMode = !!(sm && sm.studioModeEnabled);
    if (state.obs.studioMode) {
      const pv = await obsClient.call('GetCurrentPreviewScene');
      state.obs.currentPreviewScene = (pv && (pv.sceneName || pv.currentPreviewSceneName)) || '';
    }
    const sig = state.obs.studioMode + '|' + state.obs.currentPreviewScene;
    if (sig !== _obsPreviewSig) { _obsPreviewSig = sig; broadcastFullState(); }
  } catch (e) { /* non-fatal */ }
}
setInterval(() => { pollObsPreview().catch(() => {}); }, 1500);

// Opt-in RL scene automation (kickoff / post-game). These are per-trigger, producer-enabled cuts, so
// they fire regardless of the blanket OBS_AUTO_SWITCH_DISABLED — but still respect the OBS connection,
// obs.enabled, and AI-director shielding. The caller already checked the trigger's own enable flag.
// Returns { ok, reason } instead of failing silently — callers broadcast this so a producer can see
// exactly why an expected cut didn't happen, instead of just "nothing happened."
function rlSwitchScene(name, reason, transitionName) {
  const r = switcherAutoCut(name, transitionName);
  if (r.ok) console.log(`[switcher] auto-cut → ${(name || '').trim()} (${reason || 'rl'})`);
  return r;
}
const RL_SCENE_FAIL_MESSAGES = {
  no_scene: 'no scene selected',
  obs_not_connected: 'OBS is not connected',
  obs_disabled: 'OBS is turned off (Apps > Streaming software)',
  ai_shielded: 'AI director shield is active',
  scene_missing: 'that scene no longer exists in OBS (renamed/deleted) — re-pick it in Match ▸ Teams gear',
  vmix_disabled: 'vMix is the switcher but is turned off (Apps > vMix)',
  vmix_not_connected: 'vMix is not reachable (is it running with the Web API on?)',
  input_missing: 'vMix has no input with that title (renamed/deleted) — re-pick it'
};
const RL_SCENE_PHASE_LABELS = { kickoff: 'Kickoff', scoreboard: 'Scoreboard', 'post-game': 'Post-game', countdown: 'Countdown' };
function broadcastRlSceneResult(phase, sceneName, result) {
  const phaseLabel = RL_SCENE_PHASE_LABELS[phase] || 'Scene';
  const message = result.ok
    ? `Cut to "${sceneName}" (${phase})`
    : `${phaseLabel} cut to "${sceneName}" skipped — ${RL_SCENE_FAIL_MESSAGES[result.reason] || result.reason}`;
  logAuto('rl-scene', message);
  // A failed cut here is a real problem the producer should fix (wrong scene name, OBS off, shield) —
  // flag it for the notification bell so it isn't missed with the gear panel closed.
  broadcast(bridgeClients, { type: 'rl-scene-result', data: { ok: !!result.ok, phase, message, notify: !result.ok } });
}

// Reset the held post-game scoreboard back to the live HUD (drop the frozen board). Used by the manual
// "Clear Scoreboard" button and by the post-game auto-switch (once we've cut away, the board resets so
// cutting back shows the live HUD, not the stale board).
function clearPostGameBoard() {
  if (_postGameTimer) { clearTimeout(_postGameTimer); _postGameTimer = null; }
  if (_boardLingerTimer) { clearTimeout(_boardLingerTimer); _boardLingerTimer = null; }
  state.view = 'hud';
  state.scoreboard = null;
  broadcast(bridgeClients, { type: 'clear_scoreboard', data: {} });
  broadcastFullState();
}

// When the break countdown has both a target time AND a "then" scene, schedule the cut.
// Only the thenScene case auto-hides the break — without one, the overlay keeps showing its
// "WE'RE LIVE!" final message and the producer hides it manually (unchanged behaviour).
let _breakAutoTimer = null;
function clearBreakAutoSwitch() {
  if (_breakAutoTimer) { clearTimeout(_breakAutoTimer); _breakAutoTimer = null; }
}
function scheduleBreakAutoSwitch() {
  clearBreakAutoSwitch();
  const b = state.breakScreen;
  // Armed by a RUNNING countdown + a target scene. Visibility is deliberately NOT required: the
  // producer's segment timer (top bar / timer popover Start) sends seconds without ever setting
  // `visible`, so requiring it meant a preset timer counted all the way down and then did nothing
  // unless the countdown GRAPHIC also happened to be on air. "When this timer ends, cut there" is
  // about the timer, not about which graphic is up. Pausing clears endsAt, which disarms it.
  // Armed for ANY running countdown now, not only one with a target scene: a bare segment timer
  // still has to be retired at zero (see the no-thenScene branch below).
  if (!b || !b.endsAt) return;
  const remaining = b.endsAt - Date.now();
  // Never fire retroactively. Picking a "then" scene against a countdown that already ran out
  // would otherwise cut the moment the dropdown changed. A small grace keeps a countdown that
  // just hit zero working normally.
  if (remaining < -2000) return;
  const thenScene = b.thenScene;
  const delay = Math.max(0, remaining);
  _breakAutoTimer = setTimeout(() => {
    _breakAutoTimer = null;
    if (!thenScene) {
      // A bare segment timer with nowhere to cut. Retire it, or the clocks that BORROW this timer
      // (replay-desk, preshow, countdown-bar) sit at 00:00 for the rest of the show. The countdown
      // GRAPHIC is the exception: countdown.html needs a finished target in state to swap in its
      // "WE'RE LIVE!" final message, so a visible break screen keeps its endsAt.
      if (!state.breakScreen.visible) {
        state.breakScreen.endsAt = null;
        saveAppState();
        broadcastFullState();
      }
      return;
    }
    flowBus.emit('timer_countdown_end', {});
    // Clear gfxActive too (not just .visible) if break is still the live graphic — otherwise it
    // stays punched up on gfx.html's layer, now overlaid on whatever OBS just cut to. If some
    // OTHER graphic already took over in the meantime, this only clears breakScreen's own state
    // and leaves the new active graphic alone. Skipped entirely when the countdown graphic was
    // never up (a bare segment timer) — there is nothing to take down, but the cut still happens.
    if (state.breakScreen.visible) setExclusiveGfxVisible('break', false);
    state.breakScreen.endsAt = null;
    state.breakScreen.thenScene = '';
    saveAppState();
    broadcastFullState();
    // Reuse rlSwitchScene's validation (scene still exists in OBS / OBS connected+enabled / not
    // AI-shielded) instead of switching blind — this used to fail completely silently, which is
    // exactly what made "the countdown scene cut isn't working" impossible to diagnose.
    broadcastRlSceneResult('countdown', thenScene, rlSwitchScene(thenScene, 'countdown'));
  }, delay);
}

// Fire-and-forget: save an OBS replay clip when a goal is scored (if enabled).
function obsAutoReplay() {
  if (aiShielded()) return;
  if (switcherIsVmix()) {
    if (state.obs.autoReplayOnGoal && state.vmix.enabled && state.vmix.connected) vmixMarkReplay().catch(() => {});
    return;
  }
  if (!obsClient || !state.obs.enabled || !state.obs.autoReplayOnGoal) return;
  if (!obsClient.isConnected()) return;
  obsClient.saveReplayBuffer().catch(() => { /* harmless if buffer is off */ });
}

// ─── RL TCP Client ─────────────────────────────────────────────────────────────
const net = require('net');
let rlSocket = null;
let bridgeClients = new Set();
// Auto-update bridge: main.js owns electron-updater (same process) and registers handlers here;
// the control panel drives it over the WS and shows status pushed via broadcastUpdateStatus.
let _updateHandlers = null;
let _lastUpdateStatus = null;
let rlBuffer = '';
let rlReconnectTimer = null;
let rlEventSeen = {};      // diagnostic: tally of RL event types seen since connect
let _rlTouchLog = {};      // one-shot full-payload dump counter for BallHit/StatfeedEvent (auto-spectate feasibility)
let rlLoggedFirstData = false;

// The game feed went away while a goal replay was on: no bReplay:false will ever arrive, so the
// 'goal' view (and the REPLAY tag) would stay on air. Drop back to the HUD.
function rlLeaveStuckReplay() {
  if (state.view !== 'goal' && !state.inReplay) return;
  state.inReplay = false;
  state.currentGoal = null;
  if (state.view === 'goal') { state.view = 'hud'; broadcast(bridgeClients, { type: 'view_change', data: { view: 'hud' } }); }
  console.log('[RL] feed lost during a replay: back to the HUD');
  tl('rl.replay.abandoned');
  broadcastFullState();
}
function disconnectRL() {
  if (rlReconnectTimer) { clearTimeout(rlReconnectTimer); rlReconnectTimer = null; }
  if (rlSocket) { try { rlSocket.destroy(); } catch (e) {} rlSocket = null; }
  rlStaleCheck(true);
  rlLeaveStuckReplay();
  if (state.rlConnected) { state.rlConnected = false; broadcast(bridgeClients, { type: 'rl_status', data: { connected: false } }); }
  setPerfActive(false);
}

// ── Game performance mode (see state.perfMode) ──────────────────────────────
// Engaged at the RL kickoff, released at match end / RL disconnect. main.js registers
// the priority callback (drops every app process below-normal while the game is live).
let _perfPriorityCb = null, _lastShed = null;
// Load is shed while a match is live (auto mode) OR permanently (always-on lean mode).
function perfShedActive() { const pm = state.perfMode || {}; return !!((pm.active && pm.enabled !== false) || pm.always); }
function perfCoalesceMs() {
  const pm = state.perfMode || {};
  if (perfShedActive()) return 250;
  return pm.broadcastRate === 'light' ? 250 : pm.broadcastRate === 'balanced' ? 120 : 40;
}
function applyPerfSideEffects() {
  const shed = perfShedActive();
  if (shed === _lastShed) return;
  _lastShed = shed;
  try { if (typeof _perfPriorityCb === 'function') _perfPriorityCb(shed); } catch (e) { console.warn('[Perf] priority change failed:', e.message); }
  console.log('[Perf] load shedding', shed ? 'ON' : 'off');
}
function setPerfActive(on) {
  const pm = state.perfMode || (state.perfMode = { enabled: true, active: false });
  const want = !!on && pm.enabled !== false;
  if (!!pm.active === want) return;
  pm.active = want;
  applyPerfSideEffects();
  broadcastFullState();
}

function connectToRL() {
  if (state.activeGame !== 'rocket-league') return;
  if (rlSocket) return;
  if (rlReconnectTimer) {
    clearTimeout(rlReconnectTimer);
    rlReconnectTimer = null;
  }
  
  rlSocket = new net.Socket();
  // Every handler below belongs to THIS socket. A destroyed socket's 'close' fires asynchronously;
  // without this guard it nulled a newer socket (fast game toggle), a second one was opened 3s later
  // and every event, MatchEnded included, was then handled twice.
  const sock = rlSocket;
  let wasConnected = false;

  rlSocket.connect(RL_STATS_PORT, '127.0.0.1', () => {
    if (rlSocket !== sock) { try { sock.destroy(); } catch (e) {} return; }
    console.log('[RL] Connected to Stats API (TCP) on port ' + RL_STATS_PORT);
    tl('rl.connected');
    wasConnected = true;
    state.rlConnected = true;
    rlEventSeen = {}; rlLoggedFirstData = false;   // reset diagnostics per connection
    rlBuffer = '';   // a partial object left by the previous connection would swallow this one's first message
    broadcast(bridgeClients, { type: 'rl_status', data: { connected: true } });
  });

  // Decode as UTF-8 on the stream so a multibyte character split across TCP reads (player names)
  // isn't turned into U+FFFD, which minted phantom players in the cache.
  rlSocket.setEncoding('utf8');
  rlSocket.on('data', (data) => {
    if (rlSocket !== sock) return;
    noteRlPacket();
    if (!rlLoggedFirstData) { rlLoggedFirstData = true;
      if (IS_DEV()) console.log('[RL] first data after connect (' + data.length + ' bytes):', JSON.stringify(data.slice(0, 400))); }
    const framed = frameJson(rlBuffer + data);
    rlBuffer = framed.rest;
    if (rlBuffer.length > 4 * 1024 * 1024) rlBuffer = '';   // runaway partial (should never happen) — don't grow forever
    for (const chunk of framed.messages) {
      let msg;
      try { msg = JSON.parse(chunk); } catch (e) { continue; }   // a genuinely malformed packet
      // Handler faults are logged, not swallowed: a throw here leaves half-applied state.
      try { handleRLEvent(msg); } catch (e) { console.error('[RL] handler error on ' + (msg && msg.Event) + ':', (e && e.stack) || e); }
    }
  });

  rlSocket.on('close', () => {
    if (rlSocket !== sock) return;   // an older socket closing late: the current one is not ours to touch
    if (wasConnected || state.rlConnected) {
      console.log('[RL] Disconnected from Stats API');
      tl('rl.disconnected');
    }
    if (state.rlConnected) {
      try { analytics.event('disconnect', { what: 'RL API' }); } catch (e) {}
      state.rlConnected = false;
      broadcast(bridgeClients, { type: 'rl_status', data: { connected: false } });
    }
    rlSocket = null;
    rlBuffer = '';
    rlStaleCheck(true);
    rlLeaveStuckReplay();
    _rlMatchEndedHandled = false;   // the next match must be able to end even if its MatchCreated is missed
    // A pause can't outlive the lobby: the next match must not open showing "Paused".
    if (state.rlPaused) { state.rlPaused = false; broadcastFullState(); }
    // The match can end without a MatchEnded reaching us (observer leaves, RL crashes): release
    // the load-shedding/priority drop so the app doesn't stay throttled until the next match.
    setPerfActive(false);
    scheduleRLReconnect();
  });

  // Node always emits 'close' right after 'error': the close handler does the cleanup and the
  // reconnect. Nulling rlSocket here made close think the socket was not its own and skip all of it
  // (rlConnected stayed true, a replay stayed on air, the app stayed throttled after an RL crash).
  rlSocket.on('error', (e) => {
    if (rlSocket !== sock) return;
    if (IS_DEV()) console.log('[RL] socket error:', e && e.code);
  });
}

// Silence detection. rlConnected is only the TCP socket: it stays true while Rocket League sits in a
// menu, hangs, or a half-open socket delivers nothing, and overlays kept showing frozen values as
// live. _rlLastPacketAt is the last byte received; state.rlStale is true after RL_STALE_MS of
// silence while connected (the panel shows it; nothing on air changes).
const RL_STALE_MS = 15000;
let _rlStaleTimer = null, _rlLastPacketAt = 0;   // module-level: a per-packet timestamp in state would defeat the full_state dedupe
function noteRlPacket() {
  _rlLastPacketAt = Date.now();
  if (state.rlStale) { state.rlStale = false; console.log('[RL] data flowing again'); tl('rl.flowing'); broadcast(bridgeClients, { type: 'rl_status', data: { connected: true, stale: false, lastPacketAt: _rlLastPacketAt } }); broadcastFullState(); }
  if (!_rlStaleTimer) _rlStaleTimer = setInterval(() => rlStaleCheck(false), 5000);
}
function rlStaleCheck(stop) {
  if (stop || !state.rlConnected) {
    if (_rlStaleTimer) { clearInterval(_rlStaleTimer); _rlStaleTimer = null; }
    if (state.rlStale) state.rlStale = false;
    return;
  }
  const silent = Date.now() - (_rlLastPacketAt || 0) > RL_STALE_MS;
  if (silent && !state.rlStale) {
    state.rlStale = true;
    console.warn('[RL] no data for ' + Math.round(RL_STALE_MS / 1000) + 's while connected (menu, paused feed or hung socket)');
    tl('rl.silent', { view: state.view, awaitingKickoff: !!state.awaitingKickoff });
    broadcast(bridgeClients, { type: 'rl_status', data: { connected: true, stale: true, lastPacketAt: _rlLastPacketAt } }); broadcastFullState();
  }
}

// The Stats API socket is BIDIRECTIONAL (2026 update): write {"Command":name,"Data":{...}} back on the
// same TCP connection. Only used for SetMatchPaused (pause/resume) now — the camera (ChangePOV) and
// HUD (SetHUDVisibility) commands were removed. One compact JSON object per command; false if disconnected.
function sendRlCommand(name, data) {
  if (!rlSocket || rlSocket.destroyed || !state.rlConnected) return false;
  try {
    // Newline-DELIMITED: the Stats API reads back commands as line-delimited JSON, same framing it
    // uses to emit concatenated events. Writing compact JSON with NO trailing "\n" left every command
    // unterminated, so RL never parsed one — the silent cause of "auto-spectate does nothing" and the
    // SetHUDVisibility hide never taking. The "\n" is the message terminator.
    rlSocket.write(JSON.stringify({ Command: name, Data: data || {} }) + '\n');
    if (IS_DEV()) console.log('[RL cmd] ' + name + ' ' + JSON.stringify(data || {}));
    return true;
  } catch (e) { console.warn('[RL cmd] write failed:', e.message); return false; }
}

function scheduleRLReconnect() {
  if (state.activeGame !== 'rocket-league') return;
  if (rlReconnectTimer) return;
  rlReconnectTimer = setTimeout(() => {
    rlReconnectTimer = null;
    connectToRL();
  }, RL_RECONNECT_INTERVAL);
}

/** Tracks RL clock/scores between packets for kickoff + goal inference. */
const rlGameTrack = { gameTime: null, blueScore: 0, orangeScore: 0 };

// True once the observer is spectating a lobby (live players present). Drives the "hide RL's native
// UI the moment spectating begins" behaviour — see handleUpdateState. Re-armed each match.
let _rlSpectatingActive = false;
// One-shot per match: logged the spectating-vs-playing determination (see handleUpdateState). Re-armed
// each match so a role change between games is re-logged.
let _rlPlayingLogged = false;
// Camera Target.TeamNum from the previous UpdateState. The official Stats API has no spectator
// flag, but on the exact packet where the LOCAL user switches from a team to spectator, the camera
// target is themselves with TeamNum 255 (the spectator "team") — verified by live capture 2026-07.
// The rising edge into >=2 is the only mid-match "I just entered spectate" signal the feed carries.
let _rlPrevTargetTeam = 0;

// Previous tick's per-player saves/demos, keyed by player name — the RL Stats API has no discrete
// "save happened"/"demo happened" event, only cumulative counters, so rl_save/rl_demo flow triggers
// are synthesized by diffing this against each new tick (see handleUpdateState). Reset every match
// (handleMatchCreated) so a fresh game never diffs against the previous game's counts.
let _rlPrevPlayerStats = {};   // { [playerName]: { saves, demos } }
// Peak simultaneous players seen per team THIS match (0=Blue, 1=Orange). This is the real roster size
// that played — used to cap the post-game board so a player who LEAVES before match end (which shrinks
// the live state.players count) isn't sliced off the scoreboard. Reset each match in handleMatchCreated.
let _rlPeakTeamCount = { 0: 0, 1: 0 };
// Counters that only climb over a match — the ones a rejoining player's fresh packet resets to 0.
// Deliberately NOT boost/isDemolished/isPrimary: those are live state and must follow the packet.
const RL_CUMULATIVE_STATS = ['score', 'goals', 'assists', 'saves', 'shots', 'demos'];
const SERIES_STATS_DESIGNS = ['table', 'cards', 'leaders', 'matrix'];

// Snapshot the finished game's per-player stats into the series store. Called from handleMatchEnded,
// i.e. BEFORE handleMatchCreated wipes playerCache for the next game. Keyed by game number and
// idempotent: the Stats API can repeat MatchEnded, and a repeat must replace the entry rather than
// double-count it onto the series totals.
// Series stats belong to ONE matchup. If the two teams change (a new series/matchup begins), the
// previously-banked games are from a DIFFERENT series and must be dropped — otherwise the board piles
// up players from prior series (producer: "series score is not showing the current series of players";
// e.g. a "GAME 7" lingering in a Bo3, 6 players/team in a 2v2). Keyed on the team names so games of the
// SAME series (unchanged teams) accumulate normally, but a new matchup resets the sheet.
// Normalised player key for roster comparison. The RL Stats API is the only source that is always
// present in a live match, so it is what series identity hangs off.
function _rlNameKey(n) { return String(n == null ? '' : n).toLowerCase().replace(/[^a-z0-9]+/g, ''); }

// Every distinct player banked in the current series so far.
function _seriesBankedNames(ss) {
  const out = new Set();
  ((ss && ss.games) || []).forEach((g) => ((g && g.players) || []).forEach((pl) => {
    const k = _rlNameKey(pl && pl.name); if (k) out.add(k);
  }));
  return out;
}

// Who is in the lobby right now, from the live feed (falling back to the cache mid-game).
function _rlLobbyNames() {
  const out = new Set();
  const rows = (Array.isArray(state.players) && state.players.length)
    ? state.players
    : Object.values(state.playerCache || {});
  rows.forEach((pl) => { const k = _rlNameKey(pl && pl.name); if (k) out.add(k); });
  return out;
}

// Series stats belong to ONE matchup. When a new series starts, the previously-banked games are from
// a DIFFERENT series and must be dropped, or the board piles up every player of the night (producer:
// nine names per side in a 2v2, a "GAME 7" sitting in a Bo3).
//
// This used to key on the producer-typed TEAM NAMES alone, and returned early when neither was set —
// so a producer who never fills in the Match panel (or runs with auto-teams-from-game off) got no
// reset at all and the board accumulated across every series of the event. That is the reported bug:
// the guard existed, it just could not see anything to key on.
//
// The LOBBY ROSTER is the reliable key. Rocket League reports who is in the match whatever the
// producer has typed, so: the series is still the same series while the lobby shares at least one
// player with what has been banked (which tolerates a mid-series substitution), and is a new series
// the moment the roster is completely different. Team names stay as a second signal, for the case
// where the same players rematch under different orgs.
function syncSeriesStatsMatchup() {
  const ss = state.seriesStats;
  if (!ss) return;
  let reason = '';

  const blue = (state.teams && state.teams.blue && state.teams.blue.name || '').trim();
  const orange = (state.teams && state.teams.orange && state.teams.orange.name || '').trim();
  if (blue || orange) {
    const key = blue + '\u0001' + orange;
    if (ss._matchup && ss._matchup !== key) reason = 'teams changed';
    ss._matchup = key;
  }

  // Roster check. Only meaningful once a lobby is visible AND something is banked to compare against
  // — handleMatchCreated wipes playerCache before calling this, so an empty lobby proves nothing.
  if (!reason && (ss.games || []).length) {
    const lobby = _rlLobbyNames();
    if (lobby.size) {
      const banked = _seriesBankedNames(ss);
      let shared = 0;
      lobby.forEach((k) => { if (banked.has(k)) shared++; });
      if (shared === 0) reason = 'a completely different lobby';
    }
  }

  if (reason) {
    ss.games = [];
    ss.liveBanked = false;
    ss._roster = [];
    console.log('[seriesStats] New series (' + reason + ') - cleared the previous series banked games.');
    // The reset can be detected inside handleUpdateState, which only sends a state_update. Without a
    // full_state the board kept the OLD banked games and added the NEW players' live line on top.
    saveAppState();
    broadcastFullState();
  }
}

function captureSeriesStatsGame() {
  const ss = state.seriesStats;
  if (!ss || !ss.enabled) return;
  syncSeriesStatsMatchup();   // drop stale games if the matchup changed since the last bank
  // Bank the CAPPED roster (same as the post-game scoreboard), not the raw playerCache — otherwise
  // reconnects / name-variants / brief transients pile up as extra series-stats rows.
  const players = Object.values(scoreboardRoster())
    .filter((p) => p && p.name)
    .map((p) => {
      const row = { name: String(p.name), team: Number(p.team) === 1 ? 1 : 0 };
      RL_CUMULATIVE_STATS.forEach((k) => { row[k] = Number(p[k]) || 0; });
      if (p.touches != null) row.touches = Number(p.touches) || 0;
      return row;
    });
  if (!players.length) return;   // nothing played (feed never connected) — don't bank an empty game
  const entry = {
    number: Number(state.game.number) || (ss.games.length + 1),
    blueScore: Number(state.game.blueScore) || 0,
    orangeScore: Number(state.game.orangeScore) || 0,
    endedAt: Date.now(),
    players
  };
  const at = ss.games.findIndex((g) => g && g.number === entry.number);
  if (at >= 0) ss.games[at] = entry; else ss.games.push(entry);
  // A Bo3 holding a "game 7" is holding another series' data, and the board printed it as real.
  // BO9 stays the ceiling for when bestOf isn't set.
  const cap = Math.min(9, Math.max(1, Number(state.bestOf) || 9));
  ss.games = ss.games.filter((g) => g && (!g.number || g.number <= cap)).slice(-cap);
  ss._roster = [..._seriesBankedNames(ss)];
  ss.liveBanked = true;            // playerCache is now represented in games[] — stop adding it live
}

function resetRlGameTrack() {
  rlGameTrack.gameTime = state.game?.time ?? 300;
  rlGameTrack.blueScore = state.game?.blueScore ?? 0;
  rlGameTrack.orangeScore = state.game?.orangeScore ?? 0;
}


function inferGoalFromScoreDiff(prevPlayers, players) {
  const bs = state.game.blueScore ?? 0;
  const os = state.game.orangeScore ?? 0;
  const prevBs = rlGameTrack.blueScore;
  const prevOs = rlGameTrack.orangeScore;
  if (bs <= prevBs && os <= prevOs) return null;

  const team = bs > prevBs ? 0 : 1;
  let scorer = '';
  let assisterName = null;
  for (const p of players) {
    const prevP = (prevPlayers || []).find((x) => x.name === p.name);
    if (prevP && (p.goals || 0) > (prevP.goals || 0)) {
      scorer = p.name;
      break;
    }
  }
  if (!scorer) {
    const side = team === 0 ? 0 : 1;
    const candidate = [...players]
      .filter((p) => Number(p.team) === side)
      .sort((a, b) => (b.goals || 0) - (a.goals || 0))[0];
    scorer = candidate?.name || '';
  }
  return { scorer, assisterName, speed: 0, team };
}

function handleRLEvent(msg) {
  const event = msg.Event || msg.event || '';
  let data  = msg.Data  || msg.data  || {};

  // DefaultStatsAPI sometimes stringifies the Data field
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (e) { }
  }

  // diagnostic: log each event type the first time it's seen + periodic player count
  if (!(event in rlEventSeen)) { rlEventSeen[event] = 0;
    console.log('[RL] event type:', event || '(none)', '— keys:', Object.keys(data).slice(0, 8).join(',')); }
  rlEventSeen[event]++;
  // One-shot FULL payload for the ball-touch events — feasibility check for auto-spectate-on-touch:
  // does BallHit / StatfeedEvent name the player who touched the ball, and how? (first two of each)
  if ((event === 'BallHit' || event === 'StatfeedEvent' || event === 'game:ball_hit') && (_rlTouchLog[event] = (_rlTouchLog[event] || 0) + 1) <= 2) {
    console.log(`[RL touch] ${event} #${_rlTouchLog[event]} payload:`, JSON.stringify(data).slice(0, 800));
  }
  if ((event === 'UpdateState' || event === 'game:update_state') && rlEventSeen[event] % 120 === 1) {
    console.log('[RL] UpdateState players=' + (data.Players || data.players || []).length +
      ' target=' + ((data.Game || data.game || {}).Target?.Name || (data.Game || data.game || {}).Target?.name || '-')); }

  switch (event) {
    case 'UpdateState':
    case 'game:update_state':
      handleUpdateState(data);
      break;
    case 'GoalScored':
    case 'game:goal_scored':
      handleGoalScored(data);
      break;
    case 'ClockUpdatedSeconds':
    case 'game:clock_updated_seconds':
      handleClock(data);
      break;
    case 'RoundStarted':        // official RL Stats API — active gameplay begins (the real kickoff)
    case 'ClockStarted':        // legacy / SOS aliases (kept for compatibility)
    case 'game:clock_started':
      // Play has begun → return from the post-game scoreboard to the in-game overlay. Gated on
      // awaitingKickoff, so it's a no-op mid-game; fires at the real kickoff, not the "choose teams" timer.
      returnToInGameForKickoff();
      broadcast(bridgeClients, { type: 'rl_kickoff', data: { phase: 'live' } });   // Worlds HUD: name plates → logos
      break;
    case 'BallHit':
    case 'game:ball_hit':
      handleBallHit(data);
      break;
    case 'GoalReplayStart':
    case 'ReplayStart':
    case 'game:replay_start':
      handleGoalReplayStart();
      break;
    case 'GoalReplayWillEnd':   // RL SOS — replay is ABOUT to end (fires a beat before ReplayEnd)
    case 'ReplayWillEnd':
    case 'game:replay_will_end':
      handleGoalReplayWillEnd();
      break;
    case 'GoalReplayEnd':
    case 'ReplayEnd':
    case 'game:replay_end':
      handleGoalReplayEnd();
      break;
    case 'CountdownBegin':      // official RL Stats API — kickoff countdown begins
    case 'PreCountdownBegin':   // legacy / SOS aliases (kept for compatibility)
    case 'game:pre_countdown_begin':
    case 'PostCountdownBegin':
    case 'game:post_countdown_begin':
      handleCountdownBegin();   // a kickoff countdown — the OVERTIME kickoff is our event-driven OT cue
      broadcast(bridgeClients, { type: 'rl_kickoff', data: { phase: 'countdown' } });   // Worlds HUD: logos → name plates
      break;
    case 'MatchEnded':
    case 'game:match_ended':
      handleMatchEnded(data);
      break;
    case 'MatchCreated':
    case 'game:match_created':
      handleMatchCreated(data);
      break;
    case 'MatchDestroyed':
      _rlMatchEndedHandled = false;
      // An abandoned game (remake, lobby closed before MatchEnded) must not be reused by the next one.
      statsCurrentGameId = null;
      // The lobby was torn down (observer left, forfeit, crash) — MatchEnded may never have arrived, and
      // without this the app stayed throttled (load shedding + lowered priority) until the next match.
      // Torn down mid-replay: no further bReplay:false will come, so the REPLAY view would stay on air.
      if (state.view === 'goal') { try { handleGoalReplayEnd(); } catch (e) { console.warn('[RL] replay end on destroy failed:', e.message); } }
      if (state.view === 'goal') { state.view = 'hud'; broadcast(bridgeClients, { type: 'view_change', data: { view: 'hud' } }); }
      state.inReplay = false;
      state.currentGoal = null;
      if (state.rlPaused) state.rlPaused = false;
      setPerfActive(false);
      broadcastFullState();
      break;
    case 'MatchPaused':
    case 'game:match_paused':
      // Reflect pause state whether WE paused (SetMatchPaused) or it was paused in-game, so the
      // control-panel Pause/Resume button always shows the true state.
      if (state.rlPaused !== true) { state.rlPaused = true; broadcastFullState(); }
      break;
    case 'MatchUnpaused':
    case 'game:match_unpaused':
      if (state.rlPaused !== false) { state.rlPaused = false; broadcastFullState(); }
      break;
    default:
      break;
  }
}

// ── Overtime trigger ─────────────────────────────────────────────────────────
// Rocket League only flips its own bOverTime / IsOT flag at the OT KICKOFF (after the countdown),
// which is too late for broadcast graphics. The OVERTIME animation should land the moment OT is
// actually triggered: regulation expired (clock at 0:00), score tied, and the ball settling to the
// ground. We detect that here and push isOT to the overlays early.
const OT_BALL_GROUND_Z = 140;    // ball radius ≈ 93uu; z ≤ 140 ≈ on / about to touch the floor (SOS/BakkesMod variants only)
function resetOvertimeTrigger() {
  state.otTriggered = false;
}
function fireOvertime() {
  if (state.otTriggered) return;
  state.otTriggered = true;
  state.game.isOT = true;
  flowBus.emit('rl_overtime', {});
  broadcast(bridgeClients, {
    type: 'state_update',
    data: {
      game: { ...state.game, formattedTime: formatTime(state.game.time) },
      players: state.players,
      spectatedPlayer: state.spectatedPlayer,
      facecams: savedFacecams
    }
  });
}
// PRIMARY (event-driven) OT cue: a kickoff countdown is starting. Countdowns fire before EVERY
// kickoff, so we only treat it as overtime when regulation has expired with the score tied (or RL
// has already flagged OT). The OT countdown begins right after the ground-touch / OVERTIME banner
// and before the ball is touched — exactly when the graphic should land. fireOvertime is latched,
// so this is a no-op if the state-derived fallback already fired.
// Bring up the in-game (RL overlay) OBS scene now that gameplay is starting — but only if we were
// parked in post-game waiting for it. Called from the kickoff countdown (primary) and the first
// live clock tick (fallback, in case the API build doesn't emit countdown events).
let _kickoffBailReportedAt = 0;
function returnToInGameForKickoff() {
  // A kickoff means a game is being played: it may end. (MatchCreated alone re-armed this, and a
  // missed MatchCreated — attaching mid-lobby, a reconnect between games — swallowed the next real end.)
  _rlMatchEndedHandled = false;
  setPerfActive(true);   // a match is live — shed app load until it ends (no-op if disabled)
  if (_rlReplayT0) { console.log(`[RL replay] kickoff (return)  +${Date.now() - _rlReplayT0}ms from replay start`); _rlReplayT0 = 0; }
  if (!state.awaitingKickoff) {
    // This bail was SILENT, and it is the one way the kickoff cut can stop working while every
    // setting still looks correct: `awaitingKickoff` is armed only by MatchCreated / MatchEnded, so
    // it is false for the game that is already in progress when the app attaches to the Stats API
    // (or if MatchCreated never arrives). RoundStarted then lands here and returns — no cut, no
    // log, nothing in the panel. Every OTHER RL auto-cut reports why it didn't fire; now so does
    // this one. Rate-limited because RoundStarted/CountdownBegin arrive as a burst per kickoff.
    const kt = state.obs.kickoff;
    if (kt && kt.enabled && kt.scene && Date.now() - _kickoffBailReportedAt > 15000) {
      _kickoffBailReportedAt = Date.now();
      const message = 'Kickoff cut to "' + kt.scene + '" skipped — no new match was detected, so this game was never flagged as awaiting kickoff (the app attached mid-match). It fires from the next match.';
      logAuto('rl-scene', message);
      broadcast(bridgeClients, { type: 'rl-scene-result', data: { ok: false, phase: 'kickoff', message, notify: true } });
    }
    return;
  }
  flowBus.emit('rl_round_started', {});
  state.awaitingKickoff = false;
  state.scoreboard = null;          // new game kicking off → drop the frozen post-game scoreboard
  const wasBoard = (state.view === 'scoreboard');
  // If the next kickoff arrives before the post-game→casters timer fired, that timer's own
  // `state.view === 'scoreboard'` guard (below, in handleMatchEnded) would silently no-op once we
  // flip state.view to 'hud' here — so cancel it explicitly and say why, instead of letting it
  // expire later doing nothing with no explanation.
  if (_postGameTimer) {
    clearTimeout(_postGameTimer);
    _postGameTimer = null;
    broadcast(bridgeClients, { type: 'rl-scene-result', data: { ok: false, phase: 'postgame', message: 'Post-game cut to casters cancelled — the next kickoff started first.' } });
  }
  if (_boardLingerTimer) { clearTimeout(_boardLingerTimer); _boardLingerTimer = null; }
  if (_boardNewMatchTimer) { clearTimeout(_boardNewMatchTimer); _boardNewMatchTimer = null; }
  // Same idea, one step earlier: the winning-goal replay's end (or the fallback timer) never got a
  // chance to even arm the post-game timer before this kickoff arrived — cancel the wait outright.
  if (_pendingPostGameFinalize) {
    _pendingPostGameFinalize = false;
    if (_pendingFinalizeFallbackTimer) { clearTimeout(_pendingFinalizeFallbackTimer); _pendingFinalizeFallbackTimer = null; }
    broadcast(bridgeClients, { type: 'rl-scene-result', data: { ok: false, phase: 'postgame', message: 'Post-game cut to casters cancelled — the next kickoff started before the post-game board was even shown.' } });
  }
  // _pendingFinalizeDirectTimer (the 800ms "no replay" timer) is intentionally NOT cancelled here:
  // if it fires after this kickoff, finalizePostGameBoard checks awaitingKickoff and bails out early.
  // Cancelling it would also cancel it for cases like RoundStarted firing quickly after MatchEnded.
  state.view = 'hud';
  state.inReplay = false;
  broadcastFullState();
  // Always send game_reset at between-game kickoffs so overlays reset their HUD state.
  // wasBoard check was removed: after a caster switch clearPostGameBoard already set view='hud',
  // so wasBoard would be false even though a new game IS starting and the overlay needs resetting.
  broadcast(bridgeClients, { type: 'game_reset', data: { gameNumber: state.game.number } });
  // Smart Trigger: at the kickoff countdown, cut to the producer-chosen scene if set; otherwise the
  // mapped In-Game scene. (Both respect the master autoSwitch + OBS connection state.)
  const kt = state.obs.kickoff;
  if (kt && kt.enabled && kt.scene) broadcastRlSceneResult('kickoff', kt.scene, rlSwitchScene(kt.scene, 'kickoff', kt.transition));   // opt-in RL kickoff cut (bypasses the disabled global auto-switch)
  else obsSwitch('inGame');   // the RL overlay scene comes up at kickoff, not during "choose teams"
  // NO auto-hide here: the native-UI hide fires when the observer JOINS SPECTATE (players appear in
  // handleUpdateState), not at kickoff. The UI is already hidden by kickoff, and since the key is a
  // toggle a kickoff press flipped it back ON. The latch re-arms per game via handleMatchCreated.
}
// Kickoff fallback for stats APIs that don't emit clock_started / countdown events: when we're
// awaiting kickoff and the MATCH clock is running DOWN near 5:00 (>= 150s — so the separate ~60s
// "choose teams" timer can never trigger it), the game has begun → return to the in-game overlay.
// Called from BOTH handleClock and handleUpdateState, since some APIs send the clock via UpdateState
// (game.SecondsRemaining) rather than ClockUpdatedSeconds.
function maybeReturnForKickoff(prevTime) {
  if (!state.awaitingKickoff) return;
  // Don't trigger while the post-game board is pending or visible: RL fires match_created almost
  // immediately after game end and the lobby clock starts ticking (300→299) before finalizePostGameBoard
  // has had a chance to run. Without this guard, maybeReturnForKickoff fires prematurely, clears
  // _pendingPostGameFinalize, and the caster-cut timer is never armed for subsequent games.
  // CountdownBegin / RoundStarted bypass all of these guards (they call returnToInGameForKickoff directly).
  if (state.view === 'scoreboard' || _pendingPostGameFinalize || _pendingFinalizeDirectTimer) return;
  const t = state.game.time;
  if (typeof t === 'number' && typeof prevTime === 'number' && t < prevTime && t >= 150) {
    console.log('[RL] Kickoff inferred from the running match clock (' + t + 's) — returning to the in-game overlay.');
    returnToInGameForKickoff();
  }
}
function handleCountdownBegin() {
  // A kickoff countdown means gameplay is about to start.
  returnToInGameForKickoff();   // post-game → bring the RL overlay scene back at the kickoff
  // mid-game OT kickoff: fire the OVERTIME graphic if regulation expired tied (latched / no-op otherwise)
  const tied    = (state.game.blueScore ?? 0) === (state.game.orangeScore ?? 0);
  const regOver = (state.game.time ?? 999) <= 0;
  if (state.game.isOT || (regOver && tied)) fireOvertime();
}
function maybeTriggerOvertime() {
  if (state.view === 'scoreboard') return;             // match already over
  if (state.game.isOT) { fireOvertime(); return; }     // RL confirmed OT itself → make sure it's broadcast
  if (state.otTriggered) return;
  const tied    = (state.game.blueScore ?? 0) === (state.game.orangeScore ?? 0);
  const regOver = (state.game.time ?? 999) <= 0;
  if (!regOver || !tied) return;                       // outside the OT-pending window
  // Regulation expired with the score tied → OT is PENDING but NOT yet confirmed. Fire ONLY once the
  // ball actually TOUCHES THE GROUND (its height, exposed only by SOS/BakkesMod variants). We must
  // NOT fire on a timer: after 0:00 the ball can stay airborne for several seconds and a last-second
  // buzzer-beater unties the score → NO overtime. When ball height isn't exposed (the official Stats
  // API doesn't provide it), we wait for a reliable OT signal instead — RL's own bOvertime flag or the
  // OT-kickoff countdown (handleCountdownBegin), both of which only occur once OT has actually started.
  const z = (state.rlBall && typeof state.rlBall.z === 'number') ? state.rlBall.z : null;
  if (z !== null && z <= OT_BALL_GROUND_Z) fireOvertime();
}

function handleClock(data) {
  const prevTime = (typeof state.game.time === 'number') ? state.game.time : null;
  if ('TimeSeconds' in data) state.game.time = data.TimeSeconds;
  else if ('time_seconds' in data) state.game.time = data.time_seconds;

  if ('bOvertime' in data) state.game.isOT = !!data.bOvertime || !!state.otTriggered;   // RL's late false must not undo fireOvertime()
  maybeTriggerOvertime();   // detect the 0:00 ground-touch OT trigger (before RL's own late flag)

  rlGameTrack.gameTime = state.game.time;

  // Post-game scoreboard → in-game overlay: PRIMARY path is the 'clock_started' / countdown events
  // (handleRLEvent + handleCountdownBegin); this is the running-clock fallback for APIs without them.
  maybeReturnForKickoff(prevTime);

  // Clock ticks during live play mean replay is over; don't cut short while bReplay is active.
  if (state.view === 'goal' && !state.inReplay) {
    handleGoalReplayEnd();
  }

  feedDirectorRL();

  // Broadcast the new time to clients
  broadcast(bridgeClients, {
    type: 'state_update',
    data: {
      game: { ...state.game, formattedTime: formatTime(state.game.time) },
      players: state.players,
      spectatedPlayer: state.spectatedPlayer,
      facecams: savedFacecams
    }
  });
}

// Normalise an RL Stats API team colour to a #rrggbb hex. Handles "0000FF", "#0000FF", "0x0000FF",
// 8-digit ARGB/RGBA (drops alpha), 3-digit shorthand, and a raw 24-bit number. Returns '' if unknown.
function normRlColor(v) {
  if (v == null) return '';
  if (typeof v === 'number' && isFinite(v)) { const h = (v >>> 0).toString(16).padStart(6, '0'); return '#' + h.slice(-6); }
  let s = String(v).trim(); if (!s) return '';
  s = s.replace(/^0x/i, '').replace(/^#/, '');
  if (/^[0-9a-f]{8}$/i.test(s)) s = s.slice(-6);            // ARGB/RGBA → drop alpha
  if (/^[0-9a-f]{6}$/i.test(s)) return '#' + s.toLowerCase();
  if (/^[0-9a-f]{3}$/i.test(s)) return '#' + s.split('').map((c) => c + c).join('').toLowerCase();
  return '';
}
let _rlTeamColorLogged = false;   // one-shot diagnostic so we can confirm the live feed's colour field/format
let _rlPacketShapeLogged = false; // one-shot diagnostic: dump the FULL key set the RL Stats API sends
function handleUpdateState(data) {
  const game = data.Game || data.game || {};
  const players = data.Players || data.players || [];

  // One-shot: dump the complete shape of a live RL Stats API packet so we know EXACTLY which
  // per-player + game fields are available (drives which stats the stats screen can show — no
  // guessing). Logs top-level keys and one level of nesting (Location/Stats/etc.).
  if (!_rlPacketShapeLogged && players[0]) {
    _rlPacketShapeLogged = true;
    const p0 = players[0];
    console.log('[RL] Packet shape — PLAYER keys:', Object.keys(p0).join(','));
    Object.keys(p0).forEach((k) => {
      const v = p0[k];
      if (v && typeof v === 'object') console.log('[RL]   player.' + k + ' →', Object.keys(v).join(',') || '(empty obj)');
    });
    console.log('[RL] Packet shape — GAME keys:', Object.keys(game).join(','));
    console.log('[RL] Packet shape — sample PLAYER JSON:', JSON.stringify(p0).slice(0, 900));
  }
  const prevTime = (typeof state.game.time === 'number') ? state.game.time : null;

  // Update game clock — official RL Stats API field is Game.TimeSeconds (legacy aliases kept).
  if ('TimeSeconds' in game) state.game.time = game.TimeSeconds;
  else if ('SecondsRemaining' in game) state.game.time = game.SecondsRemaining;
  else if ('time_seconds' in game) state.game.time = game.time_seconds;

  // Secondary kickoff fallback (RoundStarted / CountdownBegin events are the primary path): if those
  // events are ever missed, detect the running match clock here. No-op mid-game; gated on
  // awaitingKickoff + clock ticking down near 5:00 (so the ~60s "choose teams" timer can't trigger it).
  maybeReturnForKickoff(prevTime);

  // official RL Stats API OT flag. RL only sets it AFTER the OT kickoff countdown, so a false must not undo
  // the early fireOvertime() latch (the overlay's OT swipe is edge-driven and replayed on the flicker).
  if ('bOvertime' in game) state.game.isOT = !!game.bOvertime || !!state.otTriggered;
  else if ('IsOT' in game) state.game.isOT = !!game.IsOT || !!state.otTriggered;
  else if ('isOT' in game) state.game.isOT = !!game.isOT || !!state.otTriggered;

  // Scores from teams array or direct fields
  const teams = game.Teams || game.teams || [];
  if (teams.length >= 2) {
    teams.forEach(t => {
      // Private-match paint colours reported by the RL Stats API (ColorPrimary; other field
      // names/formats tolerated). Kept in gameTeams.*Color for the "Game colours" mode.
      const col = normRlColor(t.ColorPrimary ?? t.colorPrimary ?? t.color_primary ?? t.Color ?? t.color);
      if ((t.TeamNum === 0 || t.teamNum === 0)) {
        state.game.blueScore   = t.Score ?? t.score ?? 0;
        state.gameTeams.blue   = t.Name || t.name || 'BLUE';
        if (col) state.gameTeams.blueColor = col;
        if (state.autoTeamsFromGame) applyGameTeamName('blue', t.Name || t.name);
      }
      if ((t.TeamNum === 1 || t.teamNum === 1)) {
        state.game.orangeScore = t.Score ?? t.score ?? 0;
        state.gameTeams.orange = t.Name || t.name || 'ORANGE';
        if (col) state.gameTeams.orangeColor = col;
        if (state.autoTeamsFromGame) applyGameTeamName('orange', t.Name || t.name);
      }
    });
    // Both sides applied — rebind the round label to whoever the game says is on court, so a
    // stale round from the last pushed set can't sit over a different match.
    if (state.autoTeamsFromGame) retuneRoundLabel();
    // One-shot diagnostic: confirm the live feed's colour field name + format so "Game colours" mode
    // can be verified. Shows the team object's keys + the raw ColorPrimary + what we parsed.
    if (!_rlTeamColorLogged && teams[0]) {
      _rlTeamColorLogged = true;
      console.log('[RL] Team colours — keys:', Object.keys(teams[0]).join(','),
        '| raw ColorPrimary=', JSON.stringify(teams[0].ColorPrimary ?? teams[0].colorPrimary ?? teams[0].color_primary ?? null),
        '| parsed blue=', state.gameTeams.blueColor || '(none)', 'orange=', state.gameTeams.orangeColor || '(none)');
    }
  } else {
    if ('BlueScore'   in game) state.game.blueScore   = game.BlueScore;
    if ('OrangeScore' in game) state.game.orangeScore = game.OrangeScore;
  }

  // Ball state — the official Stats API nests this under Game.Ball and only exposes Speed (it does
  // NOT provide continuous ball/player positions). x/y/z are kept for SOS/other variants but are null
  // on the official API, so the OT "ball on the ground" cue falls back to the bOvertime flag + settle
  // timer (see maybeTriggerOvertime).
  const ballRaw = game.Ball || game.ball || data.Ball || data.ball || null;
  if (ballRaw && typeof ballRaw === 'object') {
    state.rlBall = {
      x: ballRaw.X ?? ballRaw.x ?? null,
      y: ballRaw.Y ?? ballRaw.y ?? null,
      z: ballRaw.Z ?? ballRaw.z ?? null,
      speed: ballRaw.Speed ?? ballRaw.speed ?? null,
      teamNum: ballRaw.TeamNum ?? ballRaw.teamNum ?? null   // last team to touch (255 = untouched) — possession
    };
  }
  // Game-level 2026 fields for the scoreboard / director / match-end.
  if ('Winner' in game) state.game.winner = game.Winner || '';
  if ('bHasWinner' in game) state.game.hasWinner = !!game.bHasWinner;
  if ('Arena' in game) state.game.arena = game.Arena || '';

  // Players — normalise field names (Stats API PascalCase + legacy snake_case)
  const normalised = players.map(p => ({
    name:    p.Name    || p.name    || '?',
    primaryid: p.PrimaryId ?? p.primaryId ?? null,
    shortcut: p.Shortcut ?? p.shortcut ?? null,   // spectator number (kept on rlLastTouch for the AI Director)
    team:    p.TeamNum ?? p.teamNum ?? 0,
    score:   p.Score   ?? p.score   ?? 0,
    goals:   p.Goals   ?? p.goals   ?? 0,
    assists: p.Assists ?? p.assists ?? 0,
    saves:   p.Saves   ?? p.saves   ?? 0,
    shots:   p.Shots   ?? p.shots   ?? 0,
    demos:   p.Demos   ?? p.demos   ?? 0,
    touches: p.Touches ?? p.touches ?? null,       // total ball touches (2026 field)
    carTouches: p.CarTouches ?? p.carTouches ?? null,
    boost:   p.Boost   ?? p.boost   ?? null,        // SPECTATOR-only — absent while the user is playing
    speed:   p.Speed   ?? p.speed   ?? null,        // SPECTATOR-only
    bBoosting: p.bBoosting ?? null, bSupersonic: p.bSupersonic ?? null, bOnGround: p.bOnGround ?? null,
    attacker: (p.Attacker && (p.Attacker.Name || p.Attacker.name)) || null,   // who demolished this player
    isPrimary: p.IsPrimary ?? p.isPrimary ?? false,
    isDemolished: p.bDemolished ?? p.isDemolished ?? false,
    pos: (p.Location || p.location || p.Position || p.position) ? {
      x: (p.Location || p.location || p.Position || p.position).X ?? (p.Location || p.location || p.Position || p.position).x ?? 0,
      y: (p.Location || p.location || p.Position || p.position).Y ?? (p.Location || p.location || p.Position || p.position).y ?? 0,
      z: (p.Location || p.location || p.Position || p.position).Z ?? (p.Location || p.location || p.Position || p.position).z ?? 0
    } : null
  }));

  // rl_save / rl_demo — the RL Stats API has no discrete event for either, only the cumulative
  // saves/demos counters above, so synthesize one flow-trigger emit per increment by diffing
  // against last tick's snapshot (_rlPrevPlayerStats). Must run BEFORE state.players is
  // overwritten below — that reassignment is what makes "last tick's snapshot" unavailable
  // afterward, which is why this can't just read the outgoing state.players instead.
  normalised.forEach(p => {
    const prev = _rlPrevPlayerStats[p.name];
    if (prev) {
      const dSaves = Math.max(0, (p.saves || 0) - (prev.saves || 0));
      for (let i = 0; i < dSaves; i++) flowBus.emit('rl_save', { player: p.name, team: p.team });
      const dDemos = Math.max(0, (p.demos || 0) - (prev.demos || 0));
      for (let i = 0; i < dDemos; i++) flowBus.emit('rl_demo', { player: p.name, team: p.team });
    }
    // No `else` emit on first sighting — a reconnect/observer-target switch would otherwise
    // read as a burst of saves/demos that didn't actually just happen.
    _rlPrevPlayerStats[p.name] = { saves: p.saves || 0, demos: p.demos || 0 };
  });

  const _prevPlayersForGoal = state.players;   // captured BEFORE the overwrite so scorer inference can diff goals
  state.players = normalised;
  lanSeatsOnPlayers(normalised);

  // Track the peak per-team headcount this match (Blue=0 / Orange=1). Used to cap the post-game board
  // by the roster that ACTUALLY played, so a player who leaves before match end doesn't shrink the cap
  // and get sliced off the scoreboard (see scoreboardRoster).
  const _blueN = normalised.filter(p => Number(p.team) !== 1).length;
  const _orangeN = normalised.filter(p => Number(p.team) === 1).length;
  if (_blueN > _rlPeakTeamCount[0]) _rlPeakTeamCount[0] = _blueN;
  if (_orangeN > _rlPeakTeamCount[1]) _rlPeakTeamCount[1] = _orangeN;

  // Series identity can only be judged once a lobby is visible. handleMatchCreated wipes the cache
  // before it gets the chance, so the check runs HERE, on the first packets of the new game —
  // otherwise a brand-new series renders the PREVIOUS series' players until its first game banks.
  if (state.seriesStats && state.seriesStats.enabled && normalised.length) syncSeriesStatsMatchup();

  // Update playerCache (persist players across game/disconnect).
  //
  // MERGE, never overwrite wholesale. A player who leaves mid-match and rejoins comes back through
  // the Stats API with their cumulative counters reset to 0 — a blind `= {...p}` wrote those zeros
  // over everything they'd earned, so the post-game board showed them on 0 (or dropped them, since
  // the board picks top-N by score). Cumulative stats therefore only ever go UP within a match;
  // live-state fields (boost, demolished, spectator flags) always take the fresh value. The cache
  // is cleared on MatchCreated, so a genuinely new game still re-baselines from zero.
  normalised.forEach(p => {
    const prev = state.playerCache[p.name];
    const merged = { ...p };
    if (prev) {
      RL_CUMULATIVE_STATS.forEach((k) => {
        const a = Number(prev[k]) || 0, b = Number(p[k]) || 0;
        if (a > b) merged[k] = a;
      });
    }
    state.playerCache[p.name] = merged;
  });

  // Spectating just began — the observer joined the lobby and players are now present. Hide RL's
  // native spectator UI NOW, so the pre-kickoff "choose teams" wait isn't broadcast with RL's own
  // UI on screen. This is the ONLY auto-hide moment — kickoff never presses (the key is a toggle;
  // pressing again at kickoff flipped the already-hidden UI back on). Latched so the toggle isn't
  // spammed; re-armed each match (handleMatchCreated) and when players clear.
  // Only auto-hide when the LOCAL user is actually SPECTATING a private match being cast — NEVER when
  // they're playing their own game with the studio left open. The plugin feeds UpdateState during the
  // producer's own casual/ranked games too, and blindly pressing hh into live gameplay was the reported
  // bug. IsPrimary marks the local machine's OWN participant entry: it's present only when PLAYING (a
  // pure spectator isn't in the players list, so nothing is primary). "Some player IsPrimary" therefore
  // means "I'm playing, not observing" → suppress the auto-hide entirely (the manual F9 / button still
  // works if the producer ever wants to hide the UI in an edge case).
  const localIsPlaying = normalised.some(p => p.isPrimary);
  if (!_rlPlayingLogged && normalised.length > 0) {
    _rlPlayingLogged = true;
    console.log('[RL UI] Match role: ' + (localIsPlaying
      ? 'PLAYING (a player is IsPrimary) — auto-hide suppressed (this is your own game, not a cast).'
      : 'SPECTATING (no IsPrimary participant) — auto-hide armed.'));
  }
  // NOTE: auto-hiding RL's native HUD was REMOVED (2026-08) — Rocket League now ships its own
  // in-game "Hide UI" option, so the suite no longer drives SetHUDVisibility on spectate-detect.
  // The spectate latch is kept only as a lightweight state signal; it fires no HUD command.
  const nowSpectating = normalised.length > 0 && !localIsPlaying;
  if (nowSpectating && !_rlSpectatingActive) {
    _rlSpectatingActive = true;
    console.log('[RL UI] Spectate detected (players=' + normalised.length + ').');
  } else if (!nowSpectating && _rlSpectatingActive) {
    _rlSpectatingActive = false;
  }
  const rawTarget = (game.bHasTarget !== false && game.Target && typeof game.Target === 'object') ? game.Target : null;
  const targetTeam = rawTarget ? Number(rawTarget.TeamNum ?? rawTarget.teamNum ?? 0) : 0;
  _rlPrevTargetTeam = targetTeam;

  // Detect the spectated/observed player. The official RL Stats API does NOT expose a reliable target
  // name; instead, SPECTATOR-only fields (e.g. Boost) are present ONLY for the player the observer
  // camera is currently on — so "Boost is present" identifies the spectated player. Game.Target /
  // IsPrimary are kept as fallbacks for SOS and other API variants.
  let spec = null;
  if (game.bHasTarget !== false && game.Target && typeof game.Target === 'object') {
    spec = game.Target.Name || game.Target.name || null;
  }
  if (!spec) {
    const observed = normalised.find(p => p.boost != null);   // Boost present → the camera's current player
    if (observed) spec = observed.name;
  }
  if (!spec) {
    const primary = normalised.find(p => p.isPrimary);
    if (primary) spec = primary.name;
  }
  state.spectatedPlayer = spec;

  // Infer goal from score diff when GoalScored event was missed or arrived late.
  // (prevPlayers used to be read AFTER state.players was reassigned, so it always diffed the packet
  // against itself and fell back to "top-goals player on the scoring team".)
  if (!state.currentGoal) {
    const inferred = inferGoalFromScoreDiff(_prevPlayersForGoal, normalised);
    if (inferred) state.currentGoal = inferred;
  }

  rlGameTrack.gameTime = state.game.time;
  rlGameTrack.blueScore = state.game.blueScore ?? 0;
  rlGameTrack.orangeScore = state.game.orangeScore ?? 0;

  // Detect transition to replay to trigger goal banner if not already shown
  if (game.bReplay === true && !state.inReplay && state.view !== 'goal' && state.view !== 'scoreboard') {
    handleGoalReplayStart();
  }

  // Track replay state so we don't prematurely close the goal banner
  if (game.bReplay === true) {
    state.inReplay = true;
  } else if (game.bReplay === false && state.inReplay) {
    state.inReplay = false;
    if (state.view === 'goal') {
      handleGoalReplayEnd();
    }
  }

  // Broadcast state to all clients
  broadcast(bridgeClients, {
    type: 'state_update',
    data: {
      game: { ...state.game, formattedTime: formatTime(state.game.time) },
      players: normalised,
      spectatedPlayer: state.spectatedPlayer,
      facecams: savedFacecams
    }
  });
  // Native-UI auto-hide is fired once at the kickoff (returnToInGameForKickoff) — no per-packet
  // retries: the key is a toggle, so repeated blind presses risk flipping the UI the wrong way.

  maybeTriggerOvertime();   // fire the OVERTIME graphic at the 0:00 ground-touch, not RL's late kickoff flag
  feedDirectorRL();
}

// Best-effort "last man back": the deepest defender on the CONCEDING team at the moment of the goal.
// Needs player positions (and ideally the ball) from the Stats API — returns null if unavailable.
function computeLastManBack(scoringTeam) {
  const conceding = scoringTeam === 0 ? 1 : 0;
  const defenders = (state.players || []).filter(p => p && p.team === conceding && p.pos && typeof p.pos.y === 'number');
  if (!defenders.length) return null;
  // Which net does the conceding team defend? Prefer the ball's long-axis position at the goal;
  // otherwise infer from where the defenders are sitting (they camp near their own goal on defense).
  const ball = state.rlBall || {};
  let netSign;
  if (typeof ball.y === 'number' && Math.abs(ball.y) > 1500) netSign = ball.y > 0 ? 1 : -1;
  else {
    const avgY = defenders.reduce((s, p) => s + p.pos.y, 0) / defenders.length;
    netSign = avgY >= 0 ? 1 : -1;
  }
  let best = null;
  for (const p of defenders) {
    if (!best || (netSign > 0 ? p.pos.y > best.pos.y : p.pos.y < best.pos.y)) best = p;
  }
  return best ? best.name : null;
}

let _lastGoalKey = '', _lastGoalAt = 0;
function handleGoalScored(data) {
  // Safety: a goal can only happen in live play. If we're still holding the post-game scoreboard
  // (the kickoff countdown event never arrived), a goal means the game is clearly underway → return.
  if (state.awaitingKickoff) returnToInGameForKickoff();

  const scorer   = data.Scorer   || data.scorer   || {};
  const assister = data.Assister || data.assister || null;
  const speed    = data.GoalSpeedKPH ?? data.goalSpeedKPH ?? data.GoalSpeed ?? data.goalSpeed ?? 0;
  const team     = scorer.TeamNum ?? scorer.teamNum ?? scorer.team ?? data.teamnum ?? 0;

  // The Stats API can repeat an event. The overlay already dedupes the goal banner, but flows (scene
  // cuts, sounds), the Director and goal_scored listeners would fire twice: drop a repeat of the same
  // scorer for the same team within 3s (two real goals by one player can't be 3s apart: kickoff).
  const goalKey = (scorer.Name || scorer.name || '') + '|' + team;
  if (_lastGoalKey === goalKey && Date.now() - _lastGoalAt < 3000) { console.log('[RL] duplicate GoalScored ignored (' + goalKey + ')'); tl('rl.event.duplicate', { event: 'GoalScored', scorer: goalKey }); return; }
  _lastGoalKey = goalKey; _lastGoalAt = Date.now();
  tl('rl.goal', { scorer: scorer.Name || scorer.name || '', team });

  state.currentGoal = {
    scorer:   scorer.Name   || scorer.name   || '',
    assisterName: assister ? (assister.Name || assister.name || '') : null,
    speed:    Math.round(speed),
    team:     team,
    lastManBack: computeLastManBack(team)
  };

  // Tell overlays the instant the ball hits the net (BEFORE the replay starts), so
  // goal-triggered animations fire at the goal, not when the replay kicks in.
  try { analytics.event('goal'); } catch (e) {}
  broadcast(bridgeClients, { type: 'goal_scored', data: { team: state.currentGoal.team, goal: state.currentGoal } });
  flowBus.emit('rl_goal', { team: state.currentGoal.team, scorer: state.currentGoal.scorer });

  if (directorEngine) {
    directorEngine.onDiscreteEvent('rocket-league', {
      type: 'goal',
      scorer: state.currentGoal.scorer,
      assister: state.currentGoal.assisterName,
      gameTime: formatTime(state.game.time)
    });
  }
  // Clip capture also fires via director discrete event (deduped in clip-manager).
}

// ── Ball touch → auto-spectate (2026 bidirectional command API) ───────────────
// BallHit's authoritative payload is Data.Players[] = the player(s) who hit the ball that frame, each
// {Name, Shortcut, TeamNum}. We record the toucher (name/shortcut/team) into state.rlLastTouch for the
// AI Director's scene-suggestion loop. (These helpers resolve a name's shortcut/team from state.players.)
function shortcutForPlayer(name) { const p = (state.players || []).find((x) => x.name === name); return (p && p.shortcut != null) ? p.shortcut : null; }
function teamNumForPlayer(name)  { const p = (state.players || []).find((x) => x.name === name); return p ? Number(p.team) : null; }

// Fallback toucher resolution for odd/legacy BallHit shapes (the authoritative path uses Data.Players[]).
function extractTouchPlayer(data) {
  if (!data || typeof data !== 'object') return null;
  const nameCand = data.PlayerName || data.playerName || data.Name || data.name
    || (data.Player && (data.Player.Name || data.Player.name)) || (data.player && (data.player.name || data.player.Name));
  if (typeof nameCand === 'string' && nameCand.trim()) return nameCand.trim();
  const id = data.PlayerId ?? data.playerId ?? data.PrimaryId ?? data.primaryId;
  if (id != null) { const m = (state.players || []).find((p) => p.primaryid != null && String(p.primaryid) === String(id)); if (m) return m.name; }
  return null;
}

function handleBallHit(data) {
  const hitters = Array.isArray(data && data.Players) ? data.Players : [];
  const h = hitters[0];
  let name = (h && (h.Name || h.name)) || extractTouchPlayer(data) || state.spectatedPlayer || null;
  if (!name) return;
  const shortcut = (h && (h.Shortcut ?? h.shortcut)) ?? shortcutForPlayer(name);
  const team = (h && (h.TeamNum ?? h.teamNum)) ?? teamNumForPlayer(name);
  state.rlLastTouch = { name, shortcut: shortcut ?? null, team: (team ?? null), ts: Date.now() };
  feedDirectorRL();                 // let the Director factor in who has the ball
}

// RL auto-spectate + cinematic first-kickoff camera (ChangePOV Focus/Perspective) were REMOVED 2026-08:
// the spectator-camera automation never worked reliably on live feeds. The app no longer sends any
// ChangePOV command. (The AI Director's scene-suggestion loop above — feedDirectorRL/rlLastTouch — is a
// separate feature and stays.) SetMatchPaused (pause) is the only RL command still sent.

// Diagnostic: capture the real replay-cycle timeline on the live feed (does GoalReplayWillEnd fire?
// what are the ReplayStart→WillEnd→End→kickoff gaps?) so the overlay's outro timing can be tuned to
// actual numbers instead of assumptions. Logs one line per replay stage.
let _rlReplayT0 = 0;
function handleGoalReplayStart() {
  // Already started via the bReplay path (or a duplicate event): don't re-emit the flow trigger or
  // re-take the replay-length anchor.
  if (state.view === 'goal' && state.inReplay) return;
  flowBus.emit('rl_replay_start', {});
  _rlReplayT0 = Date.now();
  console.log('[RL replay] GoalReplayStart (t=0)');
  // The post-game board is already up (the winning goal's replay can start after it finalizes): keep
  // holding it. Flipping to 'goal' here made the end handler's scoreboard guard miss, cutting OBS back
  // to the in-game scene while the board should still be showing.
  if (state.view === 'scoreboard') { state.inReplay = true; return; }

  if (!state.currentGoal) {
    const inferred = inferGoalFromScoreDiff(state.players, state.players);
    if (inferred) state.currentGoal = inferred;
  }
  if (!state.currentGoal) {
    state.currentGoal = { scorer: '', assisterName: null, speed: 0, team: 0 };
  }

  state.view = 'goal';
  state.inReplay = true;
  broadcast(bridgeClients, { type: 'view_change', data: { view: 'goal', goal: state.currentGoal } });
  obsSwitch('replay');
}

// RL's "replay will end" cue — fires a beat BEFORE the replay actually ends and the game cuts back
// to the kickoff countdown. Driving the transition-OUT (logo outro wipe) from here means the wipe
// MASKS the cut back to gameplay, instead of the outro landing on top of the countdown — which is
// exactly what the ReplayEnd/kickoff-timed path did before (producer feedback: "it's triggering on
// countdown instead of the 'replay will end' trigger"). Purely additive: feeds that never emit this
// event (e.g. the plain Stats API) fall back to the ReplayEnd/kickoff outro as before.
function handleGoalReplayWillEnd() {
  flowBus.emit('rl_replay_will_end', {});
  if (_rlReplayT0) console.log(`[RL replay] GoalReplayWillEnd  +${Date.now() - _rlReplayT0}ms from replay start`);
  // Only cue the outro for a normal goal replay that returns to gameplay. If the match just ended
  // (the WINNING goal's replay), handleGoalReplayEnd finalizes the post-game board instead — an
  // outro wipe there would wrongly fire right before the WINNER screen.
  if (!state.inReplay || _pendingPostGameFinalize) return;
  broadcast(bridgeClients, { type: 'replay_will_end', data: {} });
}

function handleGoalReplayEnd() {
  // Nothing to end (the bReplay:false path already did it): no second flow trigger, no second
  // length measurement skewing the smoothed replay length.
  if (state.view !== 'goal' && !state.inReplay && !_pendingPostGameFinalize) return;
  flowBus.emit('rl_replay_end', {});
  if (_rlReplayT0) {
    const len = Date.now() - _rlReplayT0;
    console.log(`[RL replay] GoalReplayEnd      +${len}ms from replay start`);
    // Measure the (fixed) goal-replay length and feed it to the overlay so its outro fires from ONE
    // consistent anchor (ReplayStart + measured length − lead) instead of a guessed default — sane-range
    // guarded, lightly smoothed. Propagates on the next kickoff's full_state; re-measures each session.
    if (len >= 3000 && len <= 15000) {
      const prev = state.rlReplayLenMs || 0;
      state.rlReplayLenMs = prev ? Math.round(prev * 0.4 + len * 0.6) : len;
      // Persist only when it actually moves (first measurement, then the odd drift) — so the next
      // session's FIRST goal is timed off the real length, without writing state every goal.
      if (Math.abs(state.rlReplayLenMs - prev) > 100) saveAppState();
    }
  }
  // If the winning-goal replay ends while the post-game scoreboard is already showing (the finalize
  // already ran, e.g. via the fallback timer), don't reset the view — it should keep holding.
  if (state.view === 'scoreboard') { state.inReplay = false; state.currentGoal = null; return; }

  state.inReplay = false;
  state.currentGoal = null;
  // MatchEnded fired while this replay was still playing — THIS is the actual end of the winning
  // goal's replay, so finalize the post-game board + arm the caster-cut timer now (see handleMatchEnded).
  if (_pendingPostGameFinalize) {
    finalizePostGameBoard();
    return;
  }

  state.view = 'hud';
  broadcast(bridgeClients, { type: 'view_change', data: { view: 'hud' } });
  obsSwitch('inGame');
}

let _postGameTimer = null;
// Post-game board leaves the moment the NEXT MATCH IS CREATED (producer, 2026-10-10: it used to hold
// through "choose teams" until the kickoff countdown). No minimum time on screen: back-to-back games
// go straight on. A match created before the board even went up skips the board entirely.
let _boardShownAt = 0;               // when the post-game board went up
let _newMatchSinceEnd = false;       // MatchCreated arrived after the last MatchEnded
let _boardNewMatchTimer = null;
function clearBoardForNewMatch() {
  if (_boardNewMatchTimer) { clearTimeout(_boardNewMatchTimer); _boardNewMatchTimer = null; }
  if (state.view !== 'scoreboard') return;
  if (_postGameTimer) {
    broadcast(bridgeClients, { type: 'rl-scene-result', data: { ok: false, phase: 'postgame', message: 'Post-game cut to casters cancelled: the next match was created first.' } });
  }
  clearPostGameBoard();
  broadcast(bridgeClients, { type: 'game_reset', data: { gameNumber: state.game.number } });
  logAuto('rl-scene', 'Post-game scoreboard cleared: the next match was created.');
}
let _boardLingerTimer = null;           // 2s delay after OBS cut so the overlay holds through the transition
let _pendingPostGameFinalize = false;   // MatchEnded fired but the winning-goal replay is still playing
let _pendingFinalizeFallbackTimer = null;
let _pendingFinalizeDirectTimer = null; // tracks the 800ms "no replay" setTimeout so it can be cancelled at kickoff
let _pendingFinalizeScores = null;      // final score frozen at MatchEnded (handleMatchCreated zeroes state.game before the board finalizes)
let _pendingFinalizeRoster = null;      // roster snapshot taken at MatchEnded, consumed by finalizePostGameBoard

// Post-game roster for the scoreboard. playerCache accumulates EVERY name seen this game — reconnects,
// name-variant strings (e.g. "PHYNR" vs "PHYNR †"), coaches, and brief transients — which pile up as
// extra 0-stat rows and inflate the board. Cap each team to its actual roster size (top by score) so
// only the players who really played show. rosterSize is the upper bound; the live packet's per-team
// count refines it (2v2 vs 3v3), with a fallback to rosterSize when the packet is momentarily empty.
function scoreboardRoster() {
  const teamNum = (p) => (Number(p.team) === 1 ? 1 : 0);
  const live = Array.isArray(state.players) ? state.players : [];
  const rs = (GAMES[state.activeGame] && GAMES[state.activeGame].rosterSize) || 3;
  // Cap by the roster that ACTUALLY played (peak headcount this match), not who's still connected — a
  // player who left before match end shrinks `live` but must still appear on the final board.
  const capFor = (t) => {
    const n = Math.max(live.filter((p) => teamNum(p) === t).length, _rlPeakTeamCount[t] || 0);
    return n > 0 ? Math.min(n, rs) : rs;
  };
  const all = Object.values(state.playerCache || {}).map((p) => ({ ...p }));
  const pick = (t) => all
    .filter((p) => teamNum(p) === t)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, capFor(t));
  const out = {};
  [...pick(0), ...pick(1)].forEach((p) => { out[p.name] = p; });
  return out;
}

// Freeze the final scoreboard and arm the post-game→casters cut. Called either almost immediately
// (no replay was in progress when MatchEnded fired) or from handleGoalReplayEnd() once the winning
// goal's replay actually finishes — NOT a fixed guess at how long that replay takes. Real RL replay
// durations vary widely (~5-20s+ depending on the play and highlight settings); anchoring to the
// actual replay-end event is both what was asked for and the only way the delay the producer
// configured means what they think it means (measured from when they can actually see the board).
function finalizePostGameBoard() {
  if (_pendingFinalizeFallbackTimer) { clearTimeout(_pendingFinalizeFallbackTimer); _pendingFinalizeFallbackTimer = null; }
  _pendingPostGameFinalize = false;
  _pendingFinalizeDirectTimer = null;   // clear in case called from the replay path while the direct timer still refs
  // If the kickoff already fired (RoundStarted / CountdownBegin arrived before this ran), skip:
  // we'd set view='scoreboard' mid-game and arm a stale caster-cut timer.
  if (!state.awaitingKickoff) {
    logAuto('rl-scene', 'Post-game board skipped — the next kickoff started before it could finalize.');
    return;
  }

  // The next match was already created while this board was pending (back-to-back games): skip it.
  if (_newMatchSinceEnd) {
    logAuto('rl-scene', 'Post-game board skipped: the next match was already created.');
    return;
  }
  state.view = 'scoreboard';
  _boardShownAt = Date.now();
  // Snapshot the final scoreboard so it survives the next match_created (which clears the live cache)
  // and so the overlay can re-render it from a full_state on reload/reconnect (not just the view_change).
  const roster = _pendingFinalizeRoster || scoreboardRoster();
  _pendingFinalizeRoster = null;
  const _finalScores = _pendingFinalizeScores || { blue: state.game.blueScore ?? 0, orange: state.game.orangeScore ?? 0 };
  _pendingFinalizeScores = null;
  state.scoreboard = {
    players: Object.values(roster).map(p => ({ ...p })),
    blueScore: _finalScores.blue,
    orangeScore: _finalScores.orange,
    series: { ...state.series }
  };
  broadcast(bridgeClients, {
    type: 'view_change',
    data: { view: 'scoreboard', series: state.series, playerCache: roster, blueScore: _finalScores.blue, orangeScore: _finalScores.orange }
  });
  obsSwitch('postGame');

  // FIRST post-game cut (opt-in): at match end, transition OBS to a dedicated SCOREBOARD scene if the
  // producer armed one (Match ▸ Teams gear ▸ Post Game ▸ Scoreboard). This is where the board shows;
  // the After-Scoreboard cut below then fires after its delay. Uses rlSwitchScene so it bypasses the
  // disabled global auto-switch, same as kickoff/post-game. (Producer request: end of game → cut to
  // the scoreboard scene → wait X → cut again if After-Scoreboard is set.)
  const sbScene = state.obs.scoreboardScene;
  if (sbScene && sbScene.enabled && sbScene.scene) {
    broadcastRlSceneResult('scoreboard', sbScene.scene, rlSwitchScene(sbScene.scene, 'scoreboard', sbScene.transition));
  }

  // Cancel any stray timer left over from a previous cycle before setting the new one.
  if (_postGameTimer) { clearTimeout(_postGameTimer); _postGameTimer = null; }
  // Opt-in RL post-game scene cut: after the board has been up for delaySec, cut OBS to the chosen
  // scene (e.g. caster desk). Only switches the OBS scene — the overlay scoreboard keeps holding
  // until returnToInGameForKickoff() fires at the next kickoff (which broadcasts game_reset and
  // clears the board). Cutting back to the RL overlay scene then shows the live HUD, not stale data.
  // Arm the "cut away from the post-game board to <scene> after <delaySec>s" timer. Shared by the RL
  // gear automation (state.obs.postGame) and the simpler Settings ▸ OBS "auto-switch to Casters in N
  // seconds" (postGameToCastersSec) fallback below — whichever the producer configured.
  const armPostGameCut = (scene, delaySec, transition) => {
    broadcast(bridgeClients, { type: 'rl-scene-result', data: { ok: true, phase: 'postgame', message: `Post-game cut to "${scene}" armed for ${delaySec}s.` } });
    _postGameTimer = setTimeout(() => {
      _postGameTimer = null;
      // Fire only while we're genuinely in the POST-GAME window — i.e. still awaiting the next
      // kickoff. This is robust to the winning-goal REPLAY briefly flipping state.view to 'goal'
      // after the board shows (the old `view === 'scoreboard'` guard rejected that, so the cut
      // never fired — this is the "view was goal not scoreboard" skip). It still can't fire
      // mid-game: the timer is only armed post-game (finalize guards on awaitingKickoff) and
      // returnToInGameForKickoff() cancels it the instant the next game kicks off.
      if (state.awaitingKickoff) {
        const result = rlSwitchScene(scene, 'post-game', transition);
        broadcastRlSceneResult('postgame', scene, result);
        if (result.ok) {
          // Set server state immediately so all guards (maybeReturnForKickoff, finalizePostGameBoard)
          // work correctly for the next game. Delay only the overlay broadcasts so the scoreboard
          // content stays visible on the overlay through the OBS transition (stinger/fade).
          state.view = 'hud';
          state.scoreboard = null;
          _boardLingerTimer = setTimeout(() => {
            _boardLingerTimer = null;
            broadcast(bridgeClients, { type: 'clear_scoreboard', data: {} });
            broadcastFullState();
          }, 2000);
        }
      } else {
        // The next game kicked off before the delay elapsed — returnToInGameForKickoff() normally
        // cancels this timer outright, so this is just a belt-and-suspenders report.
        broadcast(bridgeClients, { type: 'rl-scene-result', data: { ok: false, phase: 'postgame', message: `Post-game cut to "${scene}" skipped — the next game already kicked off.` } });
      }
    }, delaySec * 1000);
  };

  const pg = state.obs.postGame;
  const castersScene = (state.obs.scenes && state.obs.scenes.casters) || '';
  const castersSec = Number(state.obs.postGameToCastersSec) || 0;
  if (pg && pg.enabled && pg.scene && pg.delaySec > 0) {
    // RL gear automation wins when explicitly configured (a producer-chosen scene + delay).
    armPostGameCut(pg.scene, pg.delaySec, pg.transition);
  } else if (pg && pg.enabled && !pg.scene) {
    // Toggle is on but no scene chosen — that's silent misconfiguration; say so.
    broadcast(bridgeClients, { type: 'rl-scene-result', data: { ok: false, phase: 'postgame', notify: true, message: 'Post-game cut is ON but no scene is selected — pick one in Match ▸ Teams gear.' } });
  } else if (castersSec > 0) {
    // Settings ▸ OBS "After post-game, auto-switch to Casters in N seconds" — this used to be stored
    // but NEVER fired (the code only read state.obs.postGame). Now it cuts to the mapped Casters scene.
    // (Producer feedback: "it didn't auto cut to cams for me for whatever reason.")
    if (castersScene) {
      armPostGameCut(castersScene, castersSec, '');
    } else {
      broadcast(bridgeClients, { type: 'rl-scene-result', data: { ok: false, phase: 'postgame', notify: true, message: 'Auto-switch to Casters is set, but no Casters/Cams scene is mapped — map one in Settings ▸ OBS scene mapping.' } });
    }
  }
}

// Why is an auto-prediction not firing right now? Returns a human reason, or null if all gates pass.
// Every gate here fails SILENTLY in the create/resolve paths, so this is the single source of truth
// producers can see (surfaced in the panel via state.twitch.predictions.lastAuto).
function autoPredSkipReason() {
  if (!state.twitch.predictions.settings.autoCreate) return 'Auto-create is OFF — enable it in Twitch → Predictions';
  if (!state.twitch.connected || _twitchTokenInvalid)  return 'Twitch not connected — reconnect on the Twitch tab (token may have expired)';
  if (!predictionManager)                              return 'Twitch prediction manager not ready — reconnect Twitch';
  return null;
}
// Record + broadcast the last auto-prediction outcome so the panel can show it (and it hits the log).
function setAutoPredStatus(kind, message) {
  console.log(`[AutoPred] ${kind}: ${message}`);
  try {
    state.twitch.predictions.lastAuto = { kind, message, ts: new Date().toISOString() };
    broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
  } catch (_) {}
}
// Classify a Twitch API error so the producer gets an actionable message (and we flip `connected`
// off on a 401 so the UI stops claiming a dead token is live).
function explainTwitchApiError(e) {
  const status = e && (e.status || e.statusCode || (e.response && e.response.status));
  if (status === 401) {
    _twitchTokenInvalid = true;
    state.twitch.connected = false;
    // Self-heal: with a refresh token stored this is recoverable with no reconnect at all —
    // kick a refresh now (it clears the flags on success) and tell the producer to just retry.
    if (state.twitch.refreshToken) {
      refreshTwitchToken().catch((err) => console.warn('[Twitch] auto-refresh after 401 failed:', err.message));
      return 'Twitch token expired (401) — auto-refreshing now, try again in a few seconds.';
    }
    return 'Twitch token expired (401) — reconnect Twitch. Implicit-grant tokens cannot auto-refresh.';
  }
  if (status === 403) return 'Twitch rejected it (403) — Channel Points Predictions require an Affiliate or Partner channel.';
  if (status === 429) return 'Twitch rate-limited it (429) — try again shortly.';
  return (e && e.message) || 'Unknown Twitch API error';
}

// The Stats API can repeat MatchEnded. Applied twice it credited the series a second game, banked the
// same players as a phantom game N+1 in series stats and the league capture, and re-sent series_ended.
// One MatchEnded per match: the latch is cleared by MatchCreated.
let _rlMatchEndedHandled = false;
function handleMatchEnded(data) {
  if (_rlMatchEndedHandled) { console.log('[RL] duplicate MatchEnded ignored (no MatchCreated since the last one)'); tl('rl.event.duplicate', { event: 'MatchEnded' }); return; }
  _rlMatchEndedHandled = true;
  tl('rl.match.ended', { blue: state.game.blueScore, orange: state.game.orangeScore, game: state.game.number, seriesBefore: { blue: state.series.blue, orange: state.series.orange } });
  setPerfActive(false);     // match over — restore previews/animations/priority
  // NOTE: the OT latch is deliberately NOT cleared here. RL keeps sending UpdateState after MatchEnded with
  // isOT still true, and clearing the latch made maybeTriggerOvertime() re-fire rl_overtime (a second
  // 'scene cut on overtime' at game end). handleMatchCreated() resets it for the next game.
  state.awaitingKickoff = true;   // we're in post-game — return to the in-game overlay on the next kickoff (clock_started)
  _newMatchSinceEnd = false;
  // Stats: finalize this game before series scores are updated
  if (statsCurrentGameId) {
    const winner = state.game.blueScore > state.game.orangeScore ? 'a'
                 : state.game.orangeScore > state.game.blueScore ? 'b' : null;
    stats.endGame(statsCurrentGameId, {
      scoreA: state.game.blueScore,
      scoreB: state.game.orangeScore,
      winner,
      overtime: state.game.isOT
    });
    try { analytics.event('game_complete'); } catch (e) {}
    // p.team is the numeric TeamNum (0 blue / 1 orange) — comparing to 'blue' saved every player as side 'b'.
    // Use the capped roster so rejoin/name-variant ghosts don't inflate the games count.
    const rlPlayers = Object.values(scoreboardRoster()).map(p => ({
      ...p, team: Number(p.team) === 1 ? 'b' : 'a'
    }));
    stats.saveRlPlayerStats(statsCurrentGameId, rlPlayers);
    statsCurrentGameId = null;
  }

  // Bank this game's per-player line for the series board. Must run while playerCache still holds
  // the game that just finished and state.game.number still points at it (both change below).
  captureSeriesStatsGame();

  // Determine winner by score (more reliable than relying on potentially missing fields)
  const _scoreWinnerSide = state.game.blueScore > state.game.orangeScore ? 'blue'
                         : state.game.orangeScore > state.game.blueScore ? 'orange' : null;
  if (_scoreWinnerSide === 'blue') {
    state.series.blue++;
  } else if (_scoreWinnerSide === 'orange') {
    state.series.orange++;
  }
  // Auto-advance the current game to (games played + 1).
  state.game.number = Math.max(1, Math.min(state.bestOf, (state.series.blue || 0) + (state.series.orange || 0) + 1));

  // Producer-armed league capture: record this finished game's score into the armed fixture.
  if (state.leagueCapture && state.leagueCapture.active) {
    try { lgCaptureAppendGame(state.game.blueScore, state.game.orangeScore); } catch (e) { console.warn('[LeagueCapture]', e.message); }
  }

  // Auto-prediction: resolve by score immediately at game end
  if (_scoreWinnerSide && state.twitch.connected && predictionManager && state.twitch.predictions.settings.autoCreate) {
    const current = state.twitch.predictions.current;
    if (current && current.state !== 'RESOLVED' && current.state !== 'CANCELLED') {
      const winnerName = state.teams[_scoreWinnerSide]?.name || _scoreWinnerSide;
      const outcome = current.outcomes?.find(o =>
        o.title.toLowerCase().includes(winnerName.toLowerCase()) ||
        winnerName.toLowerCase().includes(o.title.toLowerCase())
      );
      if (outcome) {
        stopPredictionPolling();
        predictionManager.resolvePrediction(outcome.id, current.id)
          .then(result => {
            const resolvedId = current.id;
            const resolved = result
              ? normalizePrediction(result, 0)
              : { ...current, state: 'RESOLVED', winningOutcomeId: outcome.id };
            state.twitch.predictions.current = resolved;
            broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
            saveTwitchData();
            setAutoPredStatus('resolved', `Match end — resolved to winner "${winnerName}"`);
            setTimeout(() => {
              if (state.twitch.predictions.current?.id === resolvedId) {
                state.twitch.predictions.history.unshift(state.twitch.predictions.current);
                if (state.twitch.predictions.history.length > 50) state.twitch.predictions.history.pop();
                state.twitch.predictions.current = null;
                broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
                saveTwitchData();
              }
            }, 18000);
          })
          .catch(e => setAutoPredStatus('error', `Resolve failed — ${explainTwitchApiError(e)}`));
      } else {
        setAutoPredStatus('error', `Couldn't auto-resolve — no prediction outcome matched winner "${winnerName}". Use the panel to resolve manually.`);
      }
    }
  }

  // Emit flow triggers after series is updated
  flowBus.emit('rl_match_ended', { winner: _scoreWinnerSide });
  const _winsNeeded = Math.ceil(state.bestOf / 2);
  if (_scoreWinnerSide && state.series[_scoreWinnerSide] >= _winsNeeded) {
    flowBus.emit('series_ended', { winner: _scoreWinnerSide });
  }

  saveAppState();
  broadcastFullState();

  // Snapshot the roster NOW before handleMatchCreated can clear state.playerCache. The finalize
  // timer below fires 800ms later, by which time playerCache may already be empty.
  _pendingFinalizeRoster = scoreboardRoster();
  _pendingFinalizeScores = { blue: state.game.blueScore ?? 0, orange: state.game.orangeScore ?? 0 };

  // Finalize once the winning-goal replay actually ends — not a fixed guess. If no replay is in
  // progress right now (MatchEnded arrived after ReplayEnd already fired, or there's no replay to
  // show), there's nothing to wait for, so finalize almost immediately (a short buffer for any
  // trailing stat updates to land, same as the old delay's intent — just far shorter, since we're
  // no longer trying to also outlast an in-progress replay with it).
  if (state.inReplay || state.view === 'goal') {
    _pendingPostGameFinalize = true;
    // Safety net: if the API never sends a clean replay-end for this particular replay, finalize
    // anyway after a generous ceiling so post-game→casters automation can't be stuck waiting forever.
    _pendingFinalizeFallbackTimer = setTimeout(() => {
      if (_pendingPostGameFinalize) {
        console.log('[RL] Winning-goal replay-end never arrived — finalizing post-game board via fallback timer.');
        finalizePostGameBoard();
      }
    }, 20000);
  } else {
    _pendingFinalizeDirectTimer = setTimeout(() => {
      _pendingFinalizeDirectTimer = null;
      finalizePostGameBoard();
    }, 800);
  }
}

// Normalize a raw Twitch API prediction result into our internal shape.
// The API uses 'status' (not 'state'), 'locks_at' (not 'endsAt'),
// and 'channel_points' / 'users' on outcomes (not 'votes').
function normalizePrediction(result, durationSeconds, fallbackOutcomes = []) {
  const rawStatus = result.status || result.state || 'ACTIVE';
  // EventSub uses "CANCELED"/"ARCHIVED"; internal/overlay code uses "CANCELLED"
  const statusMap = { ACTIVE: 'ACTIVE', LOCKED: 'LOCKED', RESOLVED: 'RESOLVED', CANCELED: 'CANCELLED', ARCHIVED: 'CANCELLED' };
  return {
    id:    result.id,
    title: result.title,
    state: statusMap[rawStatus] || rawStatus,
    outcomes: (result.outcomes || fallbackOutcomes.map((o, i) => ({
      id:    `fallback-${i}`,
      title: typeof o === 'string' ? o : o.title,
      votes: 0,
      users: 0
    }))).map(o => ({
      id:    o.id,
      title: o.title,
      votes: o.channel_points ?? o.votes ?? 0,
      users: o.users ?? 0
    })),
    endsAt:    result.locks_at || result.endsAt || new Date(Date.now() + (durationSeconds || 300) * 1000).toISOString(),
    createdAt: result.created_at || new Date().toISOString(),
    winningOutcomeId: result.winning_outcome_id || result.winningOutcomeId || null
  };
}

function normalizePoll(data) {
  const total = (data.choices || []).reduce((s, c) =>
    s + (c.votes || 0) + (c.bits_votes || 0) + (c.channel_points_votes || 0), 0);
  return {
    id:        data.id,
    title:     data.title,
    choices:   (data.choices || []).map(c => ({
      id:    c.id,
      title: c.title,
      votes: (c.votes || 0) + (c.bits_votes || 0) + (c.channel_points_votes || 0)
    })),
    total,
    status:    data.status || 'ACTIVE',
    startedAt: data.started_at,
    endsAt:    data.ends_at,
    endedAt:   data.ended_at || null
  };
}

function buildGameAnnouncement(game) {
  if (!game) return null;
  const secs = Math.round((game.duration || 30000) / 1000);
  switch (game.type) {
    case 'trivia':
      return `🎮 TRIVIA (${secs}s): "${game.question}" — Type A, B, C or D in chat!`;
    case 'vote':
      return `🎮 VOTE (${secs}s): "${game.question}" — ${(game.options || []).map((o, i) => `!vote ${i+1} = ${o.title}`).join(' | ')}`;
    case 'prediction':
      return `🎮 PREDICTION (${secs}s): "${game.question}" — ${(game.options || []).map((o, i) => `!predict ${i+1} = ${o.title}`).join(' | ')}`;
    case 'spin':
      return `🎮 RAFFLE (${secs}s): Type anything in chat to enter the spin!`;
    case 'number_guess':
      return `🎮 GUESS THE NUMBER (${secs}s): "${game.question}" — Type !guess [number] in chat!`;
    case 'fastest_finger':
      return `🎮 FASTEST FINGER: First to type "${game.keywordDisplay}" in chat wins! GO! ⚡`;
    case 'score_prediction':
      return `🎮 SCORE PREDICTION (${secs}s): "${game.question}" — Type !score [A]-[B] (e.g. !score 3-1) to predict!`;
    default:
      return null;
  }
}

function _logActivity(entry) {
  if (!state.twitch) return;
  if (!state.twitch.activityLog) state.twitch.activityLog = [];
  state.twitch.activityLog.push({ ...entry, timestamp: Date.now() });
  // Keep last 500 entries; don't broadcast full state (perf)
  if (state.twitch.activityLog.length > 500) state.twitch.activityLog.splice(0, state.twitch.activityLog.length - 500);
  // Feed the broadcast-analytics recorder (follow/subscribe/raid/bits counters).
  try { analytics.event(entry && entry.type, entry); } catch (e) {}
  broadcast(bridgeClients, { type: 'twitch_activity', data: entry });
}

function announceGameResult(result) {
  if (!chatManager?.isConnected || !result) return;
  let msg = '';
  if (result.type === 'trivia') {
    const correct = result.answers?.[result.correctAnswerIndex] || '?';
    const winners = result.winners || [];
    msg = winners.length > 0
      ? `🎮 Trivia over! Answer: "${correct}" | Winner${winners.length > 1 ? 's' : ''}: ${winners.slice(0, 3).map(w => '@' + w.username).join(', ')}`
      : `🎮 Trivia over! Answer was "${correct}" — nobody got it!`;
  } else if (result.type === 'prediction' || result.type === 'vote') {
    if (result.winner) {
      msg = `🎮 ${result.type === 'vote' ? 'Vote' : 'Prediction'} over! "${result.winner.title}" wins with ${result.winner.votes} vote${result.winner.votes !== 1 ? 's' : ''}!`;
    }
  } else if (result.type === 'spin') {
    msg = result.winner
      ? `🎮 Raffle spin over! Winner: @${result.winner.username} — congrats! 🎉`
      : '🎮 Raffle spin over! No entries this round.';
  } else if (result.type === 'number_guess') {
    const w = result.winner;
    msg = w
      ? `🎮 Number Guess over! The answer was ${result.targetNumber}. @${w.username} was closest (guessed ${w.guess})! 🏆`
      : `🎮 Number Guess over! The answer was ${result.targetNumber}. No guesses submitted.`;
  } else if (result.type === 'fastest_finger') {
    const w = result.winner;
    msg = w
      ? `⚡ Fastest Finger: @${w.username} typed "${result.keywordDisplay}" first! 🏆`
      : `⚡ Fastest Finger: Nobody typed "${result.keywordDisplay}" in time!`;
  } else if (result.type === 'score_prediction') {
    const score = result.actualScore ? `${result.actualScore[0]}-${result.actualScore[1]}` : '?-?';
    const w = result.winner;
    msg = w
      ? `🎮 Score Prediction: Final score was ${score}. @${w.username} predicted ${w.raw}! 🏆`
      : `🎮 Score Prediction over! Final score: ${score}. No predictions matched.`;
  }
  if (msg) chatManager.sendMessage(msg);
}

function stopPredictionPolling() {
  if (_predPollTimer) { _predPollTimer.stop(); _predPollTimer = null; }
}

function startPredictionPolling() {
  stopPredictionPolling();
  _predPollTimer = pollLoop('twitch-prediction', async () => {
    const cur = state.twitch.predictions.current;
    if (!cur || !twitchClient || !state.twitch.channelId) { stopPredictionPolling(); return; }
    if (cur.state === 'RESOLVED' || cur.state === 'CANCELLED') { stopPredictionPolling(); return; }
    try {
      const result = await twitchClient.getPrediction(state.twitch.channelId, cur.id);
      if (!result) return;
      // The prediction on screen changed while this request was out (a new one opened, or it was
      // resolved/cancelled through EventSub): this older reply must not overwrite it.
      const now = state.twitch.predictions.current;
      if (!now || now.id !== cur.id) return;
      const RANK = { ACTIVE: 0, LOCKED: 1, RESOLVED: 2, CANCELED: 2, CANCELLED: 2, ARCHIVED: 2 };
      if ((RANK[String(result.status || '').toUpperCase()] ?? 0) < (RANK[String(now.state || '').toUpperCase()] ?? 0)) return;   // never move backwards
      const normalized = normalizePrediction(result, 0);
      state.twitch.predictions.current = normalized;
      broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
      if (normalized.state === 'RESOLVED' || normalized.state === 'CANCELLED') {
        stopPredictionPolling();
        setTimeout(() => {
          if (state.twitch.predictions.current?.id === normalized.id) {
            state.twitch.predictions.history.unshift(normalized);
            if (state.twitch.predictions.history.length > 50) state.twitch.predictions.history.pop();
            state.twitch.predictions.current = null;
            broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
            saveTwitchData();
          }
        }, 18000);
      }
    } catch (e) {
      console.warn('[PredPoll]', e.message);
    }
  }, 5000);
}

function handleMatchCreated(data) {
  // New game starts — reset game data, keep series. Do NOT cancel _postGameTimer here:
  // RL fires match_created almost immediately after game end, before the post-game delay
  // has elapsed. Do NOT cancel _postGameTimer here — let it run so OBS cuts to the caster
  // scene on schedule. If the kickoff fires first, state.view flips to 'hud' and the timer
  // guard prevents a stale mid-game switch.
  // If a game just finished, the post-game scoreboard is up: it leaves now that the next match has
  // been created (clearBoardForNewMatch, no minimum time). It used to hold through
  // "choose teams" until the kickoff; the producer wants it gone at match creation.
  const holdBoard = (state.view === 'scoreboard');
  tl('rl.match.created', { view: state.view, series: { blue: state.series.blue, orange: state.series.orange } });
  _rlMatchEndedHandled = false;   // this match may end once
  _lastGoalKey = '';
  if (state.rlPaused) state.rlPaused = false;
  // Per-match leftovers that fed the Director / overlays the previous game's values until refreshed.
  state.rlLastTouch = null;
  state.spectatedPlayer = null;
  if ('winner' in state.game) state.game.winner = null;
  if ('hasWinner' in state.game) state.game.hasWinner = false;
  state.game.blueScore   = 0;
  state.game.orangeScore = 0;
  state.game.time        = 300;
  state.game.isOT        = false;
  resetOvertimeTrigger();   // a fresh game can trigger its own overtime later
  state.awaitingKickoff = true;   // wait for THIS game's kickoff (clock_started) before showing the in-game overlay
  // Current game = games already played + 1 (idempotent with handleMatchEnded).
  state.game.number = Math.max(1, Math.min(state.bestOf, (state.series.blue || 0) + (state.series.orange || 0) + 1));
  state.players    = [];
  state.playerCache = {};
  if (state.seriesStats) state.seriesStats.liveBanked = false;   // fresh cache — count it live again
  state.inReplay   = false;
  state.currentGoal = null;
  _rlPrevPlayerStats = {};   // fresh match — don't diff demo/save counts against the last game's players
  _rlPeakTeamCount = { 0: 0, 1: 0 };   // fresh match — recount the peak roster for the post-game cap
  flowBus.emit('rl_match_created', {});
  syncSeriesStatsMatchup();      // new game → if the teams changed, drop the prior series' banked stats
  _rlSpectatingActive = false;   // re-arm the "hide native UI on spectate" latch for this new lobby
  _rlPlayingLogged = false;      // re-log the spectating-vs-playing determination for this new match
  // Single authoritative re-arm for the auto-hide press: ONLY a genuinely new game clears the
  // one-press-per-game guard. The latch site must NOT reset it — the key is a toggle, and a
  // players-flicker re-arming mid-game would fire a second press that flips the UI back ON.
  rlSpectatorUi.resetAutoTracking();
  resetRlGameTrack();
  saveAppState();
  if (!holdBoard) {
    // first game / not on the board → go straight to the in-game overlay; reset the HUD now
    state.view = 'hud';
    broadcastFullState();
    broadcast(bridgeClients, { type: 'game_reset', data: { gameNumber: state.game.number } });
  }
  // else: the board is up — it leaves now that the next match exists (after its minimum time on
  //       screen). The kickoff still does the scene cut and its own game_reset.
  _newMatchSinceEnd = true;
  if (holdBoard) clearBoardForNewMatch();

  // Auto-prediction: create "Who will win?" using the active team names
  const _apSkip = autoPredSkipReason();
  if (_apSkip) {
    setAutoPredStatus('skip', `Match start — no prediction opened: ${_apSkip}`);
  } else {
    const blueTeam   = (state.teams.blue.name   || 'Blue').slice(0, 25);
    const orangeTeam = (state.teams.orange.name || 'Orange').slice(0, 25);
    const title = state.twitch.predictions.settings.template === 'teams'
      ? `Game ${state.game.number}: Who will win?`
      : 'Who will win this game?';
    const durationSecs = Math.round((state.twitch.predictions.settings.cooldown || 300000) / 1000);

    const doCreate = () => {
      predictionManager.createPrediction(title, [blueTeam, orangeTeam], durationSecs)
        .then(result => {
          if (!result) return;
          state.twitch.predictions.current = normalizePrediction(result, durationSecs, [blueTeam, orangeTeam]);
          broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
          saveTwitchData();
          // EventSub (channel.prediction.progress/lock/end) now delivers real-time updates.
          // Polling kept only as fallback in case EventSub disconnects mid-prediction.
          startPredictionPolling();
          setAutoPredStatus('created', `Opened "${title}" (${blueTeam} vs ${orangeTeam}) for ${durationSecs}s`);
          // Fallback: auto-cancel if still unresolved 60s after voting ends
          const msUntilEnd = durationSecs * 1000 + 60000;
          setTimeout(() => {
            const cur = state.twitch.predictions.current;
            if (cur && cur.id === result.id && cur.state !== 'RESOLVED') {
              console.warn('[AutoPred] Voting ended with no resolve — cancelling prediction', cur.id);
              stopPredictionPolling();
              predictionManager.cancelPrediction(cur.id)
                .then(() => {
                  state.twitch.predictions.current = null;
                  broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
                  saveTwitchData();
                })
                .catch(e => console.warn('[AutoPred] Fallback cancel failed:', e.message));
            }
          }, msUntilEnd);
        })
        .catch(e => setAutoPredStatus('error', `Create failed — ${explainTwitchApiError(e)}`));
    };

    // If there's a leftover active prediction from the previous game, cancel it first
    const prev = state.twitch.predictions.current;
    if (prev && prev.state !== 'RESOLVED' && prev.state !== 'CANCELLED') {
      console.log('[AutoPred] Cancelling leftover prediction before creating new one:', prev.id);
      stopPredictionPolling();
      predictionManager.cancelPrediction(prev.id)
        .then(() => {
          state.twitch.predictions.current = null;
          doCreate();
        })
        .catch(e => {
          console.warn('[AutoPred] Could not cancel old prediction:', e.message);
          state.twitch.predictions.current = null;
          doCreate();
        });
    } else {
      doCreate();
    }
  }

  // Auto Twitch chat announcement on match start
  if (chatManager?.isConnected && state.twitch.automations?.announceOnMatchStart) {
    const msg = state.twitch.automations.announceOnMatchStart
      .replace('{blue}', state.teams.blue.name || 'Blue')
      .replace('{orange}', state.teams.orange.name || 'Orange')
      .replace('{game}', state.activeGame || '');
    chatManager.sendMessage(msg);
  }

  // NOTE: do NOT switch OBS to the in-game scene here. A new match is created during the "choose
  // teams" phase — nobody needs to see the RL overlay yet. We bring up the in-game scene at the
  // KICKOFF (handleCountdownBegin), or the first live clock tick as a fallback. See awaitingKickoff.
  // The native-UI auto-hide, however, now fires as soon as the observer is spectating (first
  // UpdateState with players, handleUpdateState) so the pre-kickoff lobby wait isn't broadcast with
  // RL's UI showing; the kickoff re-hides since RL re-shows its UI when gameplay actually starts.

  // Stats: lazy-create a match record the first time a game starts in a series.
  // Link to the start.gg set being streamed (manual setId OR the auto-followed one) so the live
  // player stats land on the same record as the official result — see stats.startMatch reuse.
  if (!statsCurrentMatchId) {
    const link = currentStreamedSetLink();
    statsCurrentMatchId = stats.startMatch({
      gameType: 'rl',
      teamA: (link && link.teamA) || state.teams.blue.name,
      teamB: (link && link.teamB) || state.teams.orange.name,
      logoA: state.teams.blue.logo,
      logoB: state.teams.orange.logo,
      bestOf: state.bestOf,
      startggSetId: (link && link.setId) || null,
      tournament: (link && link.tournament) || state.startgg?.selectedEvent?.tournamentName || null
    });
  }
  // A repeated MatchCreated (the Stats API can repeat events) opened a second game record and left
  // the first one orphaned in the stats database. One open game at a time.
  if (!statsCurrentGameId) {
    statsCurrentGameId = stats.startGame({
      matchId: statsCurrentMatchId,
      gameNumber: state.game.number,
      gameType: 'rl'
    });
  }
}

// Hide RL's native HUD via the 2026 SetHUDVisibility COMMAND — a direct set on the Stats API socket.
// This replaces the old keybd_event "hh" toggle entirely: no window focus, no keybind, and because
// it's a set (not a toggle) it can't flip the UI back on, so no retries/latching are needed.
function scheduleRlHideNativeUi(gameNumber) {
  if (state.activeGame !== 'rocket-league') {
    console.log('[RL UI] Hide skipped — active game is "' + state.activeGame + '", not rocket-league.');
    return;
  }
  const ok = sendRlCommand('SetHUDVisibility', { bVisible: false });
  broadcast(bridgeClients, {
    type: 'rl-ui-result',
    data: { ok, auto: true, message: ok ? "Spectate detected — hid RL's HUD (SetHUDVisibility)" : 'Could not hide RL HUD — Stats API socket not connected' }
  });
}

async function triggerRlHideNativeUi() {
  const ok = sendRlCommand('SetHUDVisibility', { bVisible: false });
  broadcast(bridgeClients, {
    type: 'rl-ui-result',
    data: { ok, auto: false, message: ok ? "Hid RL's HUD (SetHUDVisibility)" : 'Could not hide — is the RL Stats API connected?' }
  });
  return { ok };
}

// ─── WS Bridge Server (port 3001) ────────────────────────────────────────────
function startBridgeServer() {
  // Loopback by default: every control message mutates producer state with no auth, so the
  // bridge must not be reachable from the LAN. Multi-PC setups (overlay sources on another
  // machine) can opt back in with WS_HOST=0.0.0.0 in .env.local — they accept the exposure.
  const wsHost = process.env.WS_HOST || '127.0.0.1';
  // Only enforce the token when the bridge is actually LAN-exposed (WS_HOST set to anything
  // but loopback). At least a dozen overlay scenes predate scene-base.js and open their own
  // raw WebSocket without fetching a token — gating on wsHost means the default single-PC
  // setup (the overwhelming common case) never breaks, including for any of those un-migrated
  // scenes or a future one that forgets to fetch it. The opt-in multi-PC case (WS_HOST=0.0.0.0)
  // is the one the audit actually flagged as unauthenticated-control-from-the-LAN — that's the
  // case this protects, and every current overlay + the control panel has been updated to send
  // the token so it keeps working there too.
  const enforceToken = wsHost !== '127.0.0.1' && wsHost !== 'localhost';
  bridgeWss = new WebSocket.Server({
    host: wsHost, port: WS_PORT,
    // Reject the handshake itself (before 'connection' fires) unless the caller has the
    // token handed out by GET /api/ws-token. Clients fetch the token once over HTTP (same
    // trust boundary as the rest of the API) and append it as ?token=…
    verifyClient: (info, cb) => {
      // Browsers let ANY page open ws://127.0.0.1:3001, and on the default loopback bind no token is
      // required, so the Origin check is what keeps a random website from driving the show.
      const origin = info.req.headers.origin;
      if (!isAllowedOrigin(origin, info.req.headers.host, info.req.headers['user-agent'] || '')) {
        console.warn('[security] refused WS bridge connection from origin ' + origin);
        return cb(false, 403, 'Forbidden');
      }
      if (!enforceToken) return cb(true);
      let token = '';
      try { token = new URL(info.req.url, 'http://bridge').searchParams.get('token') || ''; } catch (e) {}
      if (token && token === wsAuthToken) return cb(true);
      cb(false, 401, 'Unauthorized');
    }
  });
  // Same bind-failure gap as the HTTP server above — a port conflict here otherwise leaves the
  // control panel with no live-state connection at all (every WS-dependent screen hangs loading).
  bridgeWss.on('error', (err) => {
    console.error('[Bridge] WS server error:', err);
    if (err && err.code === 'EADDRINUSE') {
      dialog.showErrorBox(
        'Broadcast Studio — Port already in use',
        `Port ${WS_PORT} is already being used by another program on this PC, so the app's live-update bridge can't start.\n\nClose whatever else is using port ${WS_PORT} (check Task Manager, or run "netstat -ano | findstr :${WS_PORT}" in a command prompt) and relaunch Broadcast Studio.`
      );
      _electronApp.quit();
    }
  });

  // IPv6 loopback twin, for the same reason the HTTP server has one. An overlay opened as
  // http://localhost:3000/... builds ws://localhost:3001 from its own hostname, and "localhost" is
  // ::1 FIRST on Windows — with only the IPv4 bind above, the socket had to fail over to 127.0.0.1
  // (slow), or was answered by whatever other program held :3001 on IPv6 (never connects). Both
  // spellings were published in OBS URLs, so both must reach the bridge. Upgrades are handed to the
  // SAME bridgeWss, so verifyClient, the client set and every handler are shared. Best-effort only.
  if (wsHost.indexOf(':') < 0) {
    try {
      bridgeHttp6 = require('http').createServer((req, res) => { res.writeHead(426); res.end(); });
      bridgeHttp6.on('upgrade', (req, socket, head) => {
        if (!bridgeWss) { try { socket.destroy(); } catch (e) {} return; }
        bridgeWss.handleUpgrade(req, socket, head, (ws) => bridgeWss.emit('connection', ws, req));
      });
      bridgeHttp6.on('error', (err) => {
        console.warn('[Bridge] IPv6 loopback listener unavailable (' + (err && err.code || err) + ')');
        try { bridgeHttp6.close(); } catch (e) {}
        bridgeHttp6 = null;
      });
      bridgeHttp6.listen(WS_PORT, '::1');
    } catch (e) { bridgeHttp6 = null; }
  }

  bridgeWss.on('connection', (ws) => {
    bridgeClients.add(ws);
    ws.isAlive = true;
    ws._role = 'unknown';   // set via a 'register' message: 'overlay' (browser source) | 'control' (panel)
    ws._page = '';          // overlay page path (e.g. /ticker.html) — drives the pre-flight "overlays reachable" check
    ws._imgvault = false;   // set true via 'imgvault_ready' — opt into compact @img: image refs
    ws.on('pong', () => { ws.isAlive = true; });
    // Send full state immediately on connect. Guarded, like the update_status send below it:
    // getFullState() can throw on a payload that will not serialize (the circular-ref /
    // "Maximum call stack size exceeded" case _flushFullState diagnoses), and the socket can die
    // between accept and first write. Unguarded, either threw inside the connection handler and the
    // newly-connected browser source got NO snapshot at all — it would sit blank while every
    // already-connected overlay carried on updating.
    try { const snap = JSON.stringify(getFullState()); ws.send(snap); _seedImgSent(ws, snap); }
    catch (e) { console.error('[bridge] initial snapshot failed for a client:', (e && e.message) || e); }
    if (_lastUpdateStatus) { try { ws.send(JSON.stringify({ type: 'update_status', data: _lastUpdateStatus })); } catch (e) {} }
    // A part-way restore must never be silent — the producer needs to know before they carry on.
    if (_stateLoadAbort) { try { ws.send(JSON.stringify({ type: 'crash_alert', data: { message: 'Some saved settings failed to load (' + _stateLoadAbort.error + '). Your saved lists are protected from being overwritten, and a copy of the file was kept as state.json.loadfail-*. Please report this.' } })); } catch (e) {} }

    ws.on('message', (raw) => {
      let msg = null;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }   // malformed frame — drop quietly
      const _role = currentCloudRole();
      if (msg && msg.type && !wsRoleAllows(msg.type, _role)) {
        try { ws.send(JSON.stringify({ type: 'perm-denied', data: { type: msg.type, role: _role } })); } catch (e) {}
        return;
      }
      try {
        handleControlMessage(msg, ws);
      } catch (e) {
        // A handler crash used to be indistinguishable from a malformed frame — both vanished
        // into one silent catch. Log the message type so broken controls leave a trail.
        console.error(`[bridge] handler crashed for '${msg && msg.type}':`, e && e.message);
      }
    });

    ws.on('close', () => { const was = ws._role; const wasSd = ws._client === 'streamdeck'; bridgeClients.delete(ws); if (was === 'overlay') maybeBroadcastOverlayCount(); if (wasSd) broadcastFullState(); });
    ws.on('error', () => { const was = ws._role; const wasSd = ws._client === 'streamdeck'; bridgeClients.delete(ws); if (was === 'overlay') maybeBroadcastOverlayCount(); if (wasSd) broadcastFullState(); });
  });

  // Heartbeat: ping every client; drop any that didn't pong since last round. This evicts
  // half-open/dead sockets so we don't keep "broadcasting" into the void (which looked like
  // the control panel freezing while overlays kept updating on their own live sockets).
  if (_bridgeHeartbeat) clearInterval(_bridgeHeartbeat);
  _bridgeHeartbeat = setInterval(() => {
    for (const ws of bridgeClients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} bridgeClients.delete(ws); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) {}
    }
  }, 15000);

  console.log(`[Bridge] WS server on :${WS_PORT}`);
}

// ── WS handler registry ──────────────────────────────────────────────────────
// The incremental exit from the 296-case switch below: message types registered here
// dispatch directly (same (msg, ws) contract as the switch); everything else falls
// through to the legacy switch. Migrate cases group-by-group — veto_*/draft_* are the
// template: move the case body verbatim into registerWsHandlers({ type(msg, ws) {…} })
// and delete the case. Handler crashes are caught + logged by the ws.on('message') wrapper.
// ── Org-seat role enforcement ────────────────────────────────────────────────
// The cloud session's role comes from the producer's org SEAT (Licenses & Seats
// on the studio site). owner/admin/producer = full control. operator = full
// production but no credential/token mutations. talent/analyst = VIEW-ONLY (the
// app is their monitor + camera, not a control surface). Local sign-ins without
// a cloud session carry no role → never gated, so the local-first app can't be
// locked out by an outage.
const WS_VIEW_SAFE = new Set([
  'request_state', 'check_for_update', 'install_update', 'cloud_status'
]);
function wsRoleAllows(type, role) {
  if (!role || role === 'owner' || role === 'admin' || role === 'producer') return true;
  if (role === 'operator') return !/token|api_?key|secret|license/i.test(type);
  return WS_VIEW_SAFE.has(type);   // talent / analyst
}
function currentCloudRole() {
  try { const s = cloud.getSession(); return (s.authed && s.role) ? String(s.role) : null; } catch (_) { return null; }
}

// ── LAN seat cameras (backend/lan-seats.js) ──────────────────────────────────
// Rebuild the derived seat list (links) and push any link change into the seat-owned facecams.
function lanSeatsSync(opts) {
  const ls = state.lanSeats = lanSeats.normalize(state.lanSeats);
  if (ls.enabled || (opts && opts.rooms)) lanSeats.ensureRooms(ls, () => ({ room: 'ne' + vdoRandom(9), password: vdoRandom(12) }), !!(opts && opts.newRooms));
  lanSeats.rebuild(ls, { base: vdoBase(), lang: state.vdo?.lang || 'en-US', pushExtra: state.vdo?.pushParams || '' });
  return lanSeats.refreshSeatCams(ls, savedFacecams);
}
function lanSeatsCommit(camsChanged) {
  if (camsChanged) saveFacecams();
  lanAgentApply();
  saveAppState();
  broadcastFullState();
}
// Returning players sit back down in their last seat on their own (empty seats only).
let _lanSeatSig = '';
function lanSeatsOnPlayers(players) {
  const ls = state.lanSeats;
  if (!ls || !ls.enabled) return;
  const sig = (players || []).map((p) => p && p.name).filter(Boolean).sort().join('|');
  if (sig === _lanSeatSig) return;
  _lanSeatSig = sig;
  if (lanSeats.autoSeat(ls, savedFacecams, players)) { lanSeats.rebuild(ls, { base: vdoBase(), lang: state.vdo?.lang || 'en-US', pushExtra: state.vdo?.pushParams || '' }); lanSeatsCommit(true); }
}

// Seat helpers report over the LAN to this small listener: POST /seat {token, seat, name}. It is a
// separate port from the app (which stays on 127.0.0.1), only runs while seat helpers are on, and
// accepts nothing but seat check-ins carrying the token baked into each helper.
let _lanAgentServer = null, _lanAgentPort = 0;
function lanAgentApply() {
  const ls = state.lanSeats; if (!ls) return;
  const ag = ls.agent || (ls.agent = { enabled: false, port: 3005, token: '' });
  const want = !!(ag.enabled && ls.enabled);
  if (want && !ag.token) { ag.token = require('crypto').randomBytes(16).toString('hex'); saveAppState(); }
  if (_lanAgentServer && (!want || _lanAgentPort !== ag.port)) { try { _lanAgentServer.close(); } catch (e) {} _lanAgentServer = null; _lanAgentPort = 0; ls.agentError = ''; }
  if (!want || _lanAgentServer) return;
  const srv = http.createServer((req, res) => {
    const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && req.url === '/ping') return reply(200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/seat') return reply(404, { ok: false });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) { reply(413, { ok: false }); req.destroy(); } });
    req.on('end', () => {
      let d; try { d = JSON.parse(body || '{}'); } catch (e) { return reply(400, { ok: false }); }
      const cur = state.lanSeats || {};
      const tok = String(d.token || ''), want = String((cur.agent && cur.agent.token) || '');
      const crypto = require('crypto');
      if (!want || tok.length !== want.length || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(want))) return reply(403, { ok: false });
      const seat = String(d.seat || ''), name = String(d.name || '').trim().slice(0, 64);
      if (!lanSeats.seatIds(cur.perSide || 3).includes(seat) || !name) return reply(400, { ok: false });
      cur.seen = cur.seen || {};
      cur.seen[seat] = { name, at: Date.now() };
      const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (norm(cur.assign && cur.assign[seat]) !== norm(name)) {
        lanSeats.assign(cur, savedFacecams, seat, name);
        lanSeats.rebuild(cur, { base: vdoBase(), lang: state.vdo?.lang || 'en-US', pushExtra: state.vdo?.pushParams || '' });
        console.log('[lan seats] ' + seat + ' reported ' + name);
        lanSeatsCommit(true);
      } else broadcastFullState();
      reply(200, { ok: true });
    });
  });
  srv.on('error', (e) => {
    state.lanSeats.agentError = e.code === 'EADDRINUSE' ? ('Port ' + ag.port + ' is already in use on this PC. Pick another.') : (e.message || 'Could not start');
    _lanAgentServer = null; _lanAgentPort = 0;
    broadcastFullState();
  });
  // NE_LAN_AGENT_HOST: tests keep the listener on loopback (no firewall prompt on the dev PC).
  srv.listen(ag.port, process.env.NE_LAN_AGENT_HOST || '0.0.0.0', () => { state.lanSeats.agentError = ''; broadcastFullState(); });
  _lanAgentServer = srv; _lanAgentPort = ag.port;
}

const WS_HANDLERS = Object.create(null);
function registerWsHandlers(map) {
  for (const k of Object.keys(map)) {
    if (WS_HANDLERS[k]) console.warn(`[bridge] duplicate WS handler registered for '${k}' — the later one wins`);
    WS_HANDLERS[k] = map[k];
  }
}

registerWsHandlers({
  // { enabled?, perSide?, names?: { seatId: label } }
  lan_seats_set(msg) {
    const d = msg.data || {};
    const ls = state.lanSeats = lanSeats.normalize(state.lanSeats);
    if (typeof d.enabled === 'boolean') ls.enabled = d.enabled;
    if (d.perSide != null) ls.perSide = Math.max(1, Math.min(6, Math.round(Number(d.perSide) || ls.perSide)));
    if (d.names && typeof d.names === 'object') Object.keys(d.names).forEach((id) => {
      const v = String(d.names[id] || '').trim().slice(0, 32);
      if (v) ls.names[id] = v; else delete ls.names[id];
    });
    lanSeatsCommit(lanSeatsSync());
  },
  // { seatId, name } — name '' empties the seat.
  lan_seat_assign(msg) {
    const d = msg.data || {};
    lanSeatsSync();
    if (!lanSeats.assign(state.lanSeats, savedFacecams, String(d.seatId || ''), d.name)) return;
    lanSeats.rebuild(state.lanSeats, { base: vdoBase(), lang: state.vdo?.lang || 'en-US', pushExtra: state.vdo?.pushParams || '' });
    lanSeatsCommit(true);
  },
  // { seatId, link } — a seat's own camera link (capture card, NDI page…); '' = its VDO.ninja link.
  lan_seat_link(msg) {
    const d = msg.data || {};
    const id = String(d.seatId || ''), link = String(d.link || '').trim();
    if (!lanSeats.seatIds(6).includes(id)) return;
    if (link && !/^https?:\/\//i.test(link)) return;
    if (link) state.lanSeats.links[id] = link.slice(0, 2000); else delete state.lanSeats.links[id];
    lanSeatsCommit(lanSeatsSync());
  },
  lan_seats_clear() {
    lanSeats.clearAll(state.lanSeats, savedFacecams);
    lanSeatsSync();
    lanSeatsCommit(true);
  },
  lan_seats_autoseat() {
    lanSeatsSync();
    const n = lanSeats.autoSeat(state.lanSeats, savedFacecams, state.players || []);
    lanSeatsSync();
    lanSeatsCommit(n > 0);
  },
  // Seat helpers on/off: { enabled?, port? }
  lan_seats_agent(msg) {
    const d = msg.data || {};
    const ls = state.lanSeats = lanSeats.normalize(state.lanSeats);
    if (typeof d.enabled === 'boolean') ls.agent.enabled = d.enabled;
    if (d.port != null) ls.agent.port = Math.max(1024, Math.min(65535, Math.round(Number(d.port) || ls.agent.port)));
    lanSeatsSync();
    lanSeatsCommit(false);
  },
  // New side rooms: every seat link changes (old ones stop working).
  lan_seats_new_rooms() {
    lanSeatsCommit(lanSeatsSync({ newRooms: true, rooms: true }));
  },
});

// ── Map veto + champion draft handlers (first groups migrated out of the switch) ──
registerWsHandlers({
  set_veto(msg) {
    const v = msg.data || {};
    const cur = state.veto || {};
    const maps = Array.isArray(v.maps) ? v.maps.slice(0, 7).map((m) => ({
      name: (m.name || '').toString().slice(0, 40),
      mode: (m.mode || '').toString().slice(0, 40),
      image: (m.image || '').toString().slice(0, 2000),
      action: ['ban', 'pick', 'decider'].includes(m.action) ? m.action : '',
      by: ['a', 'b'].includes(m.by) ? m.by : '',
      winner: ['a', 'b', 'draw'].includes(m.winner) ? m.winner : '',   // 'draw' = played, nobody won
      score: { a: Number(m.score?.a) || 0, b: Number(m.score?.b) || 0 }
    })) : cur.maps;
    const vetoVisible = ('visible' in v) ? !!v.visible : !!cur.visible;
    state.veto = {
      visible: vetoVisible,
      title: typeof v.title === 'string' ? v.title : (cur.title ?? ''),
      maps
    };
    // Keeps gfxActive in sync with .visible — see setExclusiveGfxVisible's own doc.
    if ('visible' in v) setExclusiveGfxVisible('veto', vetoVisible);
    saveAppState();
    broadcastFullState();
  },
  // Guided multi-game map veto
  veto_start(msg, ws) {
    try {
      const d = msg.data || {};
      vetoStart({ game: d.game, bestOf: d.bestOf, teamStart: d.teamStart, title: d.title, strikeFrom: d.strikeFrom });
      if (typeof d.visible === 'boolean') setExclusiveGfxVisible('veto', d.visible);
      saveAppState(); broadcastFullState();
    } catch (e) {
      ws.send(JSON.stringify({ type: 'csgo-result', data: { ok: false, message: e.message } }));
    }
  },
  veto_action(msg) {   // apply the current ban/pick step to a map
    vetoApply((msg.data && msg.data.mapId) || '');
    saveAppState(); broadcastFullState();
  },
  veto_undo()  { vetoUndo();  saveAppState(); broadcastFullState(); },
  veto_reset() { vetoReset(); saveAppState(); broadcastFullState(); },
  veto_result(msg) {   // record a played-map score/winner
    const d = msg.data || {};
    vetoResult(d.mapId, d.winner, d.score);
    saveAppState(); broadcastFullState();
  },
  veto_visible(msg) {
    // Through the exclusive-graphics gate so gfxActive stays in step — setting .visible directly
    // left Hide unable to take the board down (gfxActive still said "veto").
    if (state.veto) setExclusiveGfxVisible('veto', !!(msg.data && msg.data.visible));
    saveAppState(); broadcastFullState();
  },
  // Champion/hero draft
  draft_start(msg, ws) {
    try {
      const d = msg.data || {};
      draftStart({ game: d.game, teamStart: d.teamStart, title: d.title, subtitle: d.subtitle, owBanCount: d.owBanCount });
      if (typeof d.visible === 'boolean') setExclusiveGfxVisible('draft', d.visible);
      saveAppState(); broadcastFullState();
    } catch (e) {
      ws.send(JSON.stringify({ type: 'draft-result', data: { ok: false, message: e.message } }));
    }
  },
  // Live-edit the draft scene's title / subtext, and the which-team-starts preference — no restart.
  // (teamStart only re-shapes the order at the NEXT draft_start; stored here so the front UI owns it.)
  set_draft_meta(msg) {
    if (!state.draft) return;
    const d = msg.data || {};
    if (typeof d.title === 'string')    state.draft.title    = d.title.slice(0, 80);
    if (typeof d.subtitle === 'string') state.draft.subtitle = d.subtitle.slice(0, 120);
    if (d.teamStart === 'a' || d.teamStart === 'b') state.draft.teamStart = d.teamStart;
    // Overwatch ban-count preference. Applies straight away while no ban has been made yet;
    // mid-draft it waits for Reset / the next Start Draft (both rebuild the slots from it).
    if (d.owBanCount != null) state.draft.owBanCount = Number(d.owBanCount) >= 4 ? 4 : 2;
    // Board look: layout / strip edge / shot clock. Pure presentation, applies at once.
    if (d.layout != null || d.stripPos != null || d.turnSeconds != null) {
      Object.assign(state.draft, draftLookPrefs({ ...draftLookPrefs(state.draft), ...(d.layout != null ? { layout: d.layout } : {}), ...(d.stripPos != null ? { stripPos: d.stripPos } : {}), ...(d.turnSeconds != null ? { turnSeconds: d.turnSeconds } : {}) }));
    }
    // Goes first / ban count re-shape the board straight away while nothing has been banned yet;
    // once bans exist they wait for Reset (which rebuilds from these settings).
    if ((d.teamStart === 'a' || d.teamStart === 'b' || d.owBanCount != null) && !(state.draft.ops || []).length) {
      rebuildDraftSequence(state.draft);
      rebuildDraftTurn();
    }
    saveAppState(); broadcastFullState();
  },
  // Performance preferences (Settings ▸ Performance) — every knob is wired:
  // enabled (auto game mode), always (permanent lean), reduceAnimations,
  // pausePreviews (panel-side), broadcastRate (coalesce width).
  set_perf_mode(msg) {
    const pm = state.perfMode || (state.perfMode = { enabled: true, active: false });
    const d = msg.data || {};
    if ('enabled' in d) pm.enabled = !!d.enabled;
    if ('always' in d) pm.always = !!d.always;
    if ('reduceAnimations' in d) pm.reduceAnimations = !!d.reduceAnimations;
    if ('pausePreviews' in d) pm.pausePreviews = !!d.pausePreviews;
    if ('resourceWarnings' in d) pm.resourceWarnings = !!d.resourceWarnings;
    if ('broadcastRate' in d && ['smooth', 'balanced', 'light'].includes(d.broadcastRate)) pm.broadcastRate = d.broadcastRate;
    if (pm.enabled === false && pm.active) pm.active = false;
    applyPerfSideEffects();
    saveAppState(); broadcastFullState();
  },
  // ── Event Ops (ESPORTS ▸ Event Ops): universal CSV table store + true-seed pull ──
  // Client-authoritative full replace, like set_leagues. The FULL spreadsheet is kept
  // (every header + every cell) so the panel can offer a sortable/filterable table of
  // ANY export; roleMap marks which columns mean team/player/email/challonge/flags
  // for the grouped-by-team view and the Challonge copy helpers.
  set_event_ops(msg) {
    const d = msg.data || {};
    const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
    const headers = (Array.isArray(d.headers) ? d.headers : []).slice(0, 80).map((h) => clean(h, 100));
    const rows = (Array.isArray(d.rows) ? d.rows : []).slice(0, 3000)
      .map((r) => (Array.isArray(r) ? r.slice(0, Math.max(headers.length, 1)).map((c) => clean(c, 300)) : null))
      .filter((r) => r && r.some((c) => c));
    const rm = (d.roleMap && typeof d.roleMap === 'object') ? d.roleMap : {};
    const roleMap = {};
    ['team', 'team2', 'player', 'email', 'challonge', 'flags'].forEach((k) => {
      const n = Number(rm[k]);
      roleMap[k] = Number.isInteger(n) && n >= 0 && n < headers.length ? n : -1;
    });
    state.eventOps = {
      ...state.eventOps,
      headers, rows, roleMap,
      eventSlug: typeof d.eventSlug === 'string' ? d.eventSlug.trim().slice(0, 200) : (state.eventOps.eventSlug || ''),
      importedAt: rows.length ? Date.now() : 0
    };
    eventOpsVer++;
    saveAppState(); broadcastFullState();
  },
  eventops_fetch_seeds(msg, ws) {
    const reply = (ok, message, count) => {
      try { ws.send(JSON.stringify({ type: 'eventops-result', data: { ok, message, count: count || 0 } })); } catch (_) {}
    };
    // Accept a full start.gg URL or a bare event slug; fall back to the linked bracket/event.
    let slug = String((msg.data && msg.data.slug) || '').trim()
      .replace(/^https?:\/\/(www\.)?start\.gg\//i, '').replace(/\/+$/, '');
    if (!slug) slug = state.bracket.eventSlug || state.startgg.eventSlug || '';
    if (!slug) return reply(false, 'No start.gg event — paste an event slug/URL or link a bracket first.');
    (async () => {
      try {
        const seeds = await fetchEntrantSeedList(slug);
        state.eventOps = { ...state.eventOps, seeds, eventSlug: slug, seededAt: Date.now() };
        eventOpsVer++;
        saveAppState(); broadcastFullState();
        reply(true, `Pulled ${seeds.length} seeds from start.gg.`, seeds.length);
      } catch (e) {
        reply(false, (e && e.message) || 'Seed fetch failed.');
      }
    })();
  },
  draft_action(msg, ws) {
    try {
      draftAction((msg.data && msg.data.name) || '');
      saveAppState(); broadcastFullState();
    } catch (e) {
      ws.send(JSON.stringify({ type: 'draft-result', data: { ok: false, message: e.message } }));
    }
  },
  draft_undo()       { draftUndo();  saveAppState(); broadcastFullState(); },
  draft_reset()      { draftReset(); saveAppState(); broadcastFullState(); },
  draft_clear_all()  { clearAllOwBans(); saveAppState(); broadcastFullState(); },
  draft_visible(msg) { if (state.draft) setExclusiveGfxVisible('draft', !!(msg.data && msg.data.visible)); saveAppState(); broadcastFullState(); }
});

// ── Stream Credits (overlay/stream-credits.html) — plain visibility, Push Live like any other gfx.html scene ──
registerWsHandlers({
  // Single source of truth for the Stream Credits state (this registry entry shadows any switch-case
  // 'set_credits'). Every field is updated ONLY when present, so editing sponsors/talent/endText never
  // clobbers visibility (a bare set_credits used to force visible=false and drop the roll off-air).
  set_credits(msg) {
    const d = msg.data || {};
    if (!state.credits) state.credits = { visible: false, sponsors: [], talent: [], endText: '' };
    if (typeof d.visible === 'boolean') setExclusiveGfxVisible('credits', d.visible);
    if (typeof d.endText === 'string') state.credits.endText = d.endText.slice(0, 80);
    // Side rails on the credits roll (event Top 8 / this stream's Twitch activity). Absent = shown.
    if (typeof d.showTop8 === 'boolean') state.credits.showTop8 = d.showTop8;
    if (typeof d.showActivity === 'boolean') state.credits.showActivity = d.showActivity;
    if (Array.isArray(d.talent)) {
      // Manual talent credits — crew from other shifts who still deserve the roll.
      state.credits.talent = d.talent.filter((t) => t && t.name).slice(0, 40).map((t) => ({
        name: (t.name || '').toString().slice(0, 60),
        role: (t.role || '').toString().slice(0, 60),
        group: ['casters', 'hosts', 'production', 'operations', 'observers'].includes(t.group) ? t.group : ''
      }));
    }
    if (Array.isArray(d.sponsors)) {
      state.credits.sponsors = d.sponsors.filter((s) => s && (s.name || s.logo)).slice(0, 40).map((s) => ({
        name: (s.name || '').toString().slice(0, 60),
        logo: (s.logo || '').toString().slice(0, 500000),
        tier: (s.tier || '').toString().slice(0, 40)
      }));
    }
    saveAppState(); broadcastFullState();
  }
});

// ── Overwatch 2 series scoreboard handlers ──
registerWsHandlers({
  ow_set_match(msg) {
    const d = msg.data || {};
    const cur = state.owMatch || {};
    state.owMatch = {
      ...cur,   // keep mapWinners / mapModes / attack side / labels, which this message does not carry
      visible: typeof d.visible === 'boolean' ? d.visible : !!cur.visible,
      format: ['FT2','FT3','FT4'].includes(d.format) ? d.format : (cur.format || 'FT3'),
      currentMapIdx: typeof d.currentMapIdx === 'number' ? d.currentMapIdx : (cur.currentMapIdx || 0),
      bansByMap: Array.isArray(d.bansByMap) ? d.bansByMap : (cur.bansByMap || [])
    };
    saveAppState(); broadcastFullState();
  },
  ow_visible(msg) {
    if (!state.owMatch) state.owMatch = { visible: false, format: 'FT3', currentMapIdx: 0, bansByMap: [] };
    state.owMatch.visible = !!(msg.data && msg.data.visible);
    saveAppState(); broadcastFullState();
  },
  ow_set_game_mode(msg) {
    const VALID_MODES = ['escort','hybrid','control','push','flashpoint','clash'];
    const mode = msg.data && msg.data.mode;
    if (VALID_MODES.includes(mode)) {
      if (!state.owMatch) state.owMatch = { visible: false, format: 'FT3', currentMapIdx: 0, bansByMap: [] };
      state.owMatch.gameMode = mode;
      saveAppState(); broadcastFullState();
    }
  },
  ow_set_series_label(msg) {
    if (!state.owMatch) state.owMatch = { visible: false, format: 'FT3', currentMapIdx: 0, bansByMap: [] };
    state.owMatch.seriesLabel = (msg.data && msg.data.label) === 'bo' ? 'bo' : 'ft';
    saveAppState(); broadcastFullState();
  },
  ow_set_map_labels(msg) {
    if (!state.owMatch) state.owMatch = { visible: false, format: 'FT3', currentMapIdx: 0, bansByMap: [] };
    state.owMatch.showMapLabels = !!(msg.data && msg.data.show);
    saveAppState(); broadcastFullState();
  },
  ow_set_map_mode(msg) {
    if (!state.owMatch) state.owMatch = { visible: false, format: 'FT3', currentMapIdx: 0, bansByMap: [] };
    if (!Array.isArray(state.owMatch.mapModes)) state.owMatch.mapModes = [];
    const mmIdx = msg.data && typeof msg.data.mapIdx === 'number' ? msg.data.mapIdx : -1;
    const mmVal = msg.data && msg.data.mode;
    const VALID_MM = ['escort','hybrid','control','push','flashpoint','clash'];
    if (mmIdx >= 0 && mmIdx < 9 && VALID_MM.includes(mmVal)) {
      while (state.owMatch.mapModes.length <= mmIdx) state.owMatch.mapModes.push(null);
      state.owMatch.mapModes[mmIdx] = mmVal;
      saveAppState(); broadcastFullState();
    }
  },
  ow_set_map_winner(msg) {
    if (!state.owMatch) state.owMatch = { visible: false, format: 'FT3', currentMapIdx: 0, bansByMap: [] };
    if (!Array.isArray(state.owMatch.mapWinners)) state.owMatch.mapWinners = [];
    const mwIdx = msg.data && typeof msg.data.mapIdx === 'number' ? msg.data.mapIdx : -1;
    const mwVal = msg.data && msg.data.winner; // 'a' | 'b' | null
    if (mwIdx >= 0 && mwIdx < 9) {
      while (state.owMatch.mapWinners.length <= mwIdx) state.owMatch.mapWinners.push(null);
      state.owMatch.mapWinners[mwIdx] = mwVal || null;
      // Clearing a result also wipes the bans for that map so the ban display resets.
      if (!mwVal && Array.isArray(state.owMatch.bansByMap)) {
        state.owMatch.bansByMap[mwIdx] = {};
      }
      // Recount series from the full mapWinners array. reset_series clears mapWinners
      // so this is always a clean count relative to the current match.
      const winsA = state.owMatch.mapWinners.filter(w => w === 'a').length;
      const winsB = state.owMatch.mapWinners.filter(w => w === 'b').length;
      if (!state.series) state.series = {};
      state.series.blue   = winsA;
      state.series.orange = winsB;
      if (!state.game) state.game = {};
      state.game.number = Math.max(1, Math.min(state.bestOf || 5, winsA + winsB + vetoDraws() + 1));
      saveAppState(); broadcastFullState();
    }
  },
  ow_ban_hero(msg) {
    const d = msg.data || {};
    const cur = state.owMatch || {};
    const idx  = Number(d.mapIdx) || 0;
    const side = d.side === 'b' ? 'b' : 'a';
    const slot = d.slot === 1 ? 1 : 0;
    const bansByMap = [...(cur.bansByMap || [])];
    while (bansByMap.length <= idx) bansByMap.push({});
    const entry = { ...(bansByMap[idx] || {}) };
    // Normalise legacy single-object format → 2-element array
    const prev = entry[side];
    const arr = Array.isArray(prev) ? [...prev] : (prev && prev.hero ? [prev, { hero:'', role:'' }] : [{ hero:'', role:'' }, { hero:'', role:'' }]);
    while (arr.length < 2) arr.push({ hero:'', role:'' });
    const hero = String(d.hero || '');
    arr[slot] = { hero, role: String(d.role || (hero ? draftData.roleFor('overwatch', hero, state.gameConfigs) : '') || '') };
    entry[side] = arr;
    bansByMap[idx] = entry;
    state.owMatch = { ...cur, bansByMap };
    // The Pick / Ban board shows the map the scoreboard's game number points at; if that is the map
    // just edited (from a Map Pool card), reload it so both places agree.
    if (idx === owMapIdx()) owDraftLoadMap();
    saveAppState(); broadcastFullState();
  },
  // Map Pool cards were reordered / one was removed: per-map Overwatch data (bans, results, modes)
  // is stored by map POSITION, so it has to move with the cards.
  ow_move_map(msg) {
    const d = msg.data || {};
    const from = Number(d.from), to = Number(d.to);
    if (!state.owMatch || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from > 8 || to > 8 || from === to) return;
    const move = (list) => {
      if (!Array.isArray(list) || from >= list.length) return list;
      const out = list.slice();
      while (out.length <= to) out.push(null);
      const [it] = out.splice(from, 1);
      out.splice(to, 0, it);
      return out;
    };
    state.owMatch = { ...state.owMatch,
      bansByMap: (move(state.owMatch.bansByMap) || []).map((x) => x || {}),
      mapWinners: move(state.owMatch.mapWinners), mapModes: move(state.owMatch.mapModes) };
    if (state.draft && state.draft.game === 'overwatch') state.draft.mapIdx = -1;   // reload the board on the next flush
    saveAppState(); broadcastFullState();
  },
  ow_remove_map(msg) {
    const idx = Number(msg.data && msg.data.idx);
    if (!state.owMatch || !Number.isInteger(idx) || idx < 0 || idx > 8) return;
    const drop = (list) => (Array.isArray(list) && idx < list.length) ? list.filter((_, i) => i !== idx) : list;
    state.owMatch = { ...state.owMatch, bansByMap: drop(state.owMatch.bansByMap),
      mapWinners: drop(state.owMatch.mapWinners), mapModes: drop(state.owMatch.mapModes) };
    if (state.draft && state.draft.game === 'overwatch') state.draft.mapIdx = -1;
    saveAppState(); broadcastFullState();
  },
  ow_set_map(msg) {
    const d = msg.data || {};
    if (!state.owMatch) state.owMatch = { visible: false, format: 'FT3', currentMapIdx: 0, bansByMap: [], attackSide: null };
    if (typeof d.currentMapIdx === 'number') state.owMatch.currentMapIdx = d.currentMapIdx;
    if (['FT2','FT3','FT4'].includes(d.format)) state.owMatch.format = d.format;
    saveAppState(); broadcastFullState();
  },
  ow_set_attack(msg) {
    if (!state.owMatch) state.owMatch = { visible: false, format: 'FT3', currentMapIdx: 0, bansByMap: [], attackSide: null, showAttack: false };
    const side = (msg.data && msg.data.side) || null;
    state.owMatch.attackSide = ['a','b'].includes(side) ? side : null;
    saveAppState(); broadcastFullState();
  },
  ow_show_attack(msg) {
    if (!state.owMatch) state.owMatch = { visible: false, format: 'FT3', currentMapIdx: 0, bansByMap: [], attackSide: null, showAttack: false };
    state.owMatch.showAttack = !!(msg.data && msg.data.visible);
    saveAppState(); broadcastFullState();
  }
});

// ── Marvel Rivals series scoreboard handlers ──
registerWsHandlers({
  mr_set_match(msg) {
    const d = msg.data || {};
    const cur = state.mrMatch || {};
    state.mrMatch = {
      visible: typeof d.visible === 'boolean' ? d.visible : !!cur.visible,
      format: typeof d.format === 'string' ? d.format : (cur.format || 'BO5'),
      bansByMap: Array.isArray(d.bansByMap) ? d.bansByMap : (cur.bansByMap || []),
      gameMode: typeof d.gameMode === 'string' ? d.gameMode : (cur.gameMode || 'convergence'),
      showMapLabels: typeof d.showMapLabels === 'boolean' ? d.showMapLabels : (cur.showMapLabels !== false),
      mapWinners: Array.isArray(d.mapWinners) ? d.mapWinners : (cur.mapWinners || []),
      mapModes: Array.isArray(d.mapModes) ? d.mapModes : (cur.mapModes || []),
      gepData: cur.gepData || null
    };
    saveAppState(); broadcastFullState();
  },
  mr_visible(msg) {
    if (!state.mrMatch) state.mrMatch = { visible: false, format: 'BO5', bansByMap: [], gameMode: 'convergence', showMapLabels: true, mapWinners: [], mapModes: [], gepData: null };
    state.mrMatch.visible = !!(msg.data && msg.data.visible);
    saveAppState(); broadcastFullState();
  },
  mr_set_game_mode(msg) {
    const MR_VALID_MODES = ['convergence','domination','convoy'];
    const mrMode = msg.data && msg.data.mode;
    if (MR_VALID_MODES.includes(mrMode)) {
      if (!state.mrMatch) state.mrMatch = { visible: false, format: 'BO5', bansByMap: [], gameMode: 'convergence', showMapLabels: true, mapWinners: [], mapModes: [], gepData: null };
      state.mrMatch.gameMode = mrMode;
      saveAppState(); broadcastFullState();
    }
  },
  mr_set_map_labels(msg) {
    if (!state.mrMatch) state.mrMatch = { visible: false, format: 'BO5', bansByMap: [], gameMode: 'convergence', showMapLabels: true, mapWinners: [], mapModes: [], gepData: null };
    state.mrMatch.showMapLabels = !!(msg.data && msg.data.show);
    saveAppState(); broadcastFullState();
  },
  mr_set_map_mode(msg) {
    if (!state.mrMatch) state.mrMatch = { visible: false, format: 'BO5', bansByMap: [], gameMode: 'convergence', showMapLabels: true, mapWinners: [], mapModes: [], gepData: null };
    if (!Array.isArray(state.mrMatch.mapModes)) state.mrMatch.mapModes = [];
    const mrMmIdx = msg.data && typeof msg.data.mapIdx === 'number' ? msg.data.mapIdx : -1;
    const mrMmVal = msg.data && msg.data.mode;
    const MR_VALID_MM = ['convergence','domination','convoy'];
    if (mrMmIdx >= 0 && mrMmIdx < 9 && MR_VALID_MM.includes(mrMmVal)) {
      while (state.mrMatch.mapModes.length <= mrMmIdx) state.mrMatch.mapModes.push(null);
      state.mrMatch.mapModes[mrMmIdx] = mrMmVal;
      saveAppState(); broadcastFullState();
    }
  },
  mr_set_map_winner(msg) {
    if (!state.mrMatch) state.mrMatch = { visible: false, format: 'BO5', bansByMap: [], gameMode: 'convergence', showMapLabels: true, mapWinners: [], mapModes: [], gepData: null };
    if (!Array.isArray(state.mrMatch.mapWinners)) state.mrMatch.mapWinners = [];
    const mrMwIdx = msg.data && typeof msg.data.mapIdx === 'number' ? msg.data.mapIdx : -1;
    const mrMwVal = msg.data && msg.data.winner;
    if (mrMwIdx >= 0 && mrMwIdx < 9) {
      while (state.mrMatch.mapWinners.length <= mrMwIdx) state.mrMatch.mapWinners.push(null);
      state.mrMatch.mapWinners[mrMwIdx] = mrMwVal || null;
      if (!mrMwVal && Array.isArray(state.mrMatch.bansByMap)) {
        state.mrMatch.bansByMap[mrMwIdx] = {};
      }
      const mrWinsA = state.mrMatch.mapWinners.filter(function(w) { return w === 'a'; }).length;
      const mrWinsB = state.mrMatch.mapWinners.filter(function(w) { return w === 'b'; }).length;
      if (!state.series) state.series = {};
      state.series.blue   = mrWinsA;
      state.series.orange = mrWinsB;
      if (!state.game) state.game = {};
      state.game.number = Math.max(1, Math.min(state.bestOf || 5, mrWinsA + mrWinsB + 1));
      saveAppState(); broadcastFullState();
    }
  },
  mr_ban_hero(msg) {
    const d = msg.data || {};
    const cur = state.mrMatch || {};
    const idx  = Number(d.mapIdx) || 0;
    const side = d.side === 'b' ? 'b' : 'a';
    const slot = Math.min(3, Math.max(0, Number(d.slot) || 0));
    const bansByMap = [...(cur.bansByMap || [])];
    while (bansByMap.length <= idx) bansByMap.push({});
    const entry = { ...(bansByMap[idx] || {}) };
    const prev = entry[side];
    const arr = Array.isArray(prev) ? [...prev] : [{ hero:'', role:'' },{ hero:'', role:'' },{ hero:'', role:'' },{ hero:'', role:'' }];
    while (arr.length < 4) arr.push({ hero:'', role:'' });
    arr[slot] = { hero: String(d.hero || ''), role: String(d.role || '') };
    entry[side] = arr;
    bansByMap[idx] = entry;
    state.mrMatch = { ...cur, bansByMap };
    saveAppState(); broadcastFullState();
  }
});

// ── Simple graphics setters (winner screen + team-lineup/intro card) ──
registerWsHandlers({
  set_winner(msg) {
    const w = msg.data || {};
    const cur = state.winner || {};
    let side = ('side' in w) ? (w.side || '') : (cur.side ?? '');
    // 'auto' resolves to the side leading the series, so a Stream Deck button / flow / any caller can
    // fire the winner WITHOUT pre-picking a team (mirrors the control panel's auto-winner).
    if (side === 'auto') {
      side = state.series.blue > state.series.orange ? 'blue'
           : state.series.orange > state.series.blue ? 'orange'
           : (cur.side || 'blue');
    }
    // Fired by SIDE without a name (Stream Deck / toggle / 'auto'): clear name/logo/colour so the
    // overlay resolves the champion fresh from that team — winner.html prefers an explicit name over
    // the side, so a leftover name from a previous winner would otherwise show the wrong team.
    const sideFired = ('side' in w) && (side === 'blue' || side === 'orange') && typeof w.name !== 'string';
    const winnerVisible = ('visible' in w) ? !!w.visible : !!cur.visible;
    // Subtitle: the control panel always sends one (it auto-suggests the series score); a SIDE-only
    // fire — Stream Deck, a Flow, 'auto' — sends none, and the leftover subtitle from the LAST match
    // then went on air under the new champion ("1–0" while Match — Teams read 1–3). Refresh it from
    // the live series score whenever the stored one is empty or still looks auto-generated ("3–1"),
    // and leave a producer-typed line ("2026 Spring Champions") alone.
    const seriesSubtitle = () => {
      const b = Number(state.series && state.series.blue) || 0;
      const o = Number(state.series && state.series.orange) || 0;
      if (b + o <= 0) return '';
      const [hi, lo] = side === 'blue' ? [b, o] : side === 'orange' ? [o, b] : [Math.max(b, o), Math.min(b, o)];
      return hi + '–' + lo;   // en-dash, same shape as the panel's _winnerSeriesScore
    };
    let subtitle = typeof w.subtitle === 'string' ? w.subtitle : (cur.subtitle ?? '');
    if (sideFired && typeof w.subtitle !== 'string' && (!subtitle || /^\s*\d+\s*[–—-]\s*\d+\s*$/.test(subtitle))) {
      subtitle = seriesSubtitle();
    }
    state.winner = {
      visible: winnerVisible,
      side,
      name: typeof w.name === 'string' ? w.name : (sideFired ? '' : (cur.name ?? '')),
      logo: ('logo' in w) ? (w.logo || null) : (sideFired ? null : (cur.logo ?? null)),
      color: ('color' in w) ? (w.color || '') : (sideFired ? '' : (cur.color ?? '')),
      subtitle,
      // The look survives a side-only fire (Stream Deck / flow / 'auto') — it is a per-event design
      // choice, not part of the individual result.
      style: WINNER_STYLES.includes(w.style) ? w.style : (WINNER_STYLES.includes(cur.style) ? cur.style : 'slam')
    };
    // Keeps gfxActive in sync with .visible — see setExclusiveGfxVisible's own doc.
    if ('visible' in w) setExclusiveGfxVisible('winner', winnerVisible);
    saveAppState();
    broadcastFullState();

    // Auto-prediction: resolve with the winning team's outcome. Only when this message actually
    // PUTS THE WINNER ON AIR — a style change, a subtitle edit or a hide used to run this too, and
    // with no side set it fell back to the orange team and paid out the wrong outcome (irreversible).
    if (('visible' in w) && winnerVisible && state.twitch.connected && predictionManager && state.twitch.predictions.settings.autoCreate) {
      const winnerName = state.winner.name
        || (state.winner.side === 'blue' ? state.teams.blue.name : state.winner.side === 'orange' ? state.teams.orange.name : '');
      const current = state.twitch.predictions.current;
      // Skip if already resolved by score in handleMatchEnded
      if (current && current.state !== 'RESOLVED' && current.state !== 'CANCELLED' && winnerName) {
        const outcome = current.outcomes?.find(o =>
          o.title.toLowerCase().includes(winnerName.toLowerCase()) ||
          winnerName.toLowerCase().includes(o.title.toLowerCase())
        );
        if (outcome) {
          stopPredictionPolling();
          predictionManager.resolvePrediction(outcome.id, current.id)
            .then(result => {
              const resolvedId = current.id;
              const resolved = result
                ? normalizePrediction(result, 0)
                : { ...current, state: 'RESOLVED', winningOutcomeId: outcome.id };
              state.twitch.predictions.current = resolved;
              broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
              saveTwitchData();
              console.log('[AutoPred] Resolved with winner:', winnerName);
              setTimeout(() => {
                if (state.twitch.predictions.current?.id === resolvedId) {
                  state.twitch.predictions.history.unshift(state.twitch.predictions.current);
                  if (state.twitch.predictions.history.length > 50) state.twitch.predictions.history.pop();
                  state.twitch.predictions.current = null;
                  broadcast(bridgeClients, { type: 'full_state', data: buildLiveState() });
                  saveTwitchData();
                }
              }, 18000);
            })
            .catch(e => console.warn('[AutoPred] Resolve failed:', e.message));
        } else {
          console.warn('[AutoPred] No matching outcome for winner:', winnerName, '— outcomes:', current.outcomes?.map(o => o.title));
        }
      }
    }
  },
  set_intro(msg) {
    const i = msg.data || {};
    const cur = state.intro || {};
    const introVisible = ('visible' in i) ? !!i.visible : !!cur.visible;
    state.intro = {
      visible: introVisible,
      side: (i.side === 'orange' || i.side === 'blue') ? i.side : (cur.side ?? 'blue'),
      title: typeof i.title === 'string' ? i.title : (cur.title ?? ''),
      style: [1, 2].includes(Number(i.style)) ? Number(i.style) : (cur.style ?? 1),
      showFooter: ('showFooter' in i) ? !!i.showFooter : (cur.showFooter ?? false),
      showRealName: ('showRealName' in i) ? !!i.showRealName : (cur.showRealName ?? false)
    };
    // Keeps gfxActive in sync with .visible — see setExclusiveGfxVisible's own doc.
    if ('visible' in i) setExclusiveGfxVisible('intro', introVisible);
    saveAppState();
    broadcastFullState();
  }
});

// ── Sponsor / announcement ticker ──
registerWsHandlers({
  set_ticker(msg) {
    const p = msg.data || {};
    if (typeof p.visible === 'boolean') state.ticker.visible = p.visible;
    if (typeof p.source === 'string') state.ticker.source = ['startgg', 'nxgen', 'br', 'competition'].includes(p.source) ? p.source : 'manual';
    if (typeof p.sponsor === 'string') state.ticker.sponsor = p.sponsor.slice(0, 400000);   // small logo (downscaled client-side)
    if (Array.isArray(p.messages)) {
      state.ticker.messages = p.messages
        .map((m) => (m || '').toString().trim())
        .filter(Boolean)
        .slice(0, 30);
    }
    if (Number(p.speed) > 0) state.ticker.speed = Math.min(600, Math.max(3, Number(p.speed)));
    if (state.ticker.source === 'startgg') state.ticker.feed = formatTickerFeed(state.startgg.matchFeed);   // build now; refreshes each poll
    if (state.ticker.source === 'nxgen') state.ticker.feed = formatTickerFeed(state.nxgen.matchFeed);
    if (state.ticker.source === 'br') state.ticker.feed = brTickerFeed();
    saveAppState();
    broadcastFullState();
  }
});

// ── Live competition (Esports ▸ Competitions) ──
// Replies that only the asking panel needs go back on its own socket as competition_result.
function compReply(ws, op, data) {
  try { ws && ws.send(JSON.stringify({ type: 'competition_result', data: { op, ...data } })); } catch (_) {}
}
function ensureCompetitionApiKey(regenerate) {
  if (!competitionApiKey || regenerate) {
    competitionApiKey = 'nek_' + require('crypto').randomBytes(24).toString('hex');
    saveAppState();
  }
  return competitionApiKey;
}
// OBS audio / source controls sent straight from the panel (pinned pills, Production Deck tiles,
// the volume slider) and the Stream Deck plugin. They share the Flow actions' implementation, so a
// button and an automation flow can never drift apart.
registerWsHandlers(Object.fromEntries(
  ['obs_input_mute', 'obs_input_unmute', 'obs_source_show', 'obs_source_hide', 'obs_set_volume'].map((type) => [type, (msg) => {
    _executeFlowAction({ type, params: (msg && msg.data) || {} }, {}).catch((e) => console.warn('[OBS] ' + type + ' failed:', e.message));
  }])
));

registerWsHandlers({
  // Make a league the live competition ('' = take it off air).
  competition_set_live(msg, ws) {
    const d = msg.data || {};
    const lg = competitionGoLive(String(d.leagueId || ''));
    if (d.leagueId && !lg) compReply(ws, 'set_live', { ok: false, error: 'League not found.' });
    saveAppState();
    broadcastFullState();
  },
  // Which scenes follow the live competition, and what the ticker shows.
  competition_set_options(msg) {
    const d = msg.data || {};
    const cur = normalizeCompetitionSettings(state.competition);
    const next = normalizeCompetitionSettings({
      ...cur, ...d, leagueId: cur.leagueId,
      feeds: { ...cur.feeds, ...(d.feeds || {}) },
      ticker: { ...cur.ticker, ...(d.ticker || {}) },
    });
    state.competition = next;
    // Turning a feed ON while live binds that board now; turning one OFF releases it.
    if (next.leagueId) {
      const f = d.feeds || {};
      if (f.schedule === true) { state.upcoming.source = 'league'; state.upcoming.leagueId = next.leagueId; }
      if (f.schedule === false && state.upcoming.source === 'league') { state.upcoming.source = 'event'; state.upcoming.leagueId = ''; state.upcoming.matches = []; }
      if (f.standings === true) { state.standings.source = 'league'; state.standings.leagueId = next.leagueId; }
      if (f.ticker === true) state.ticker.source = 'competition';
      if (f.ticker === false && state.ticker.source === 'competition') state.ticker.source = 'manual';
    }
    refreshCompetitionFeed();
    saveAppState();
    broadcastFullState();
  },
  // Mark a fixture live / postponed / cancelled / back to normal.
  competition_match_status(msg) {
    const d = msg.data || {};
    const lg = (state.leagues || []).find((l) => l.id === d.leagueId);
    const m = lg && (lg.schedule || []).find((x) => x.id === d.matchId);
    if (!m) return;
    if (['live', 'cancelled', 'postponed'].includes(d.status)) {
      // Only one fixture per league reads LIVE from a manual toggle — the previous one steps down.
      if (d.status === 'live') (lg.schedule || []).forEach((x) => { if (x !== m && x.status === 'live') delete x.status; });
      m.status = d.status;
    } else delete m.status;
    leaguesVer++;
    refreshCompetitionFeed();
    saveAppState();
    broadcastFullState();
  },
  competition_sync_now(msg, ws) {
    const d = msg.data || {};
    syncLeagueSource(String(d.leagueId || ''), { dryRun: !!d.dryRun })
      .then((r) => compReply(ws, d.dryRun ? 'test' : 'sync', { leagueId: d.leagueId, ...r }))
      .catch((e) => compReply(ws, 'sync', { leagueId: d.leagueId, ok: false, error: e.message }));
  },
  // Paste / file import (JSON document or CSV) into a league. Merges — never prunes.
  competition_import(msg, ws) {
    const d = msg.data || {};
    const lg = (state.leagues || []).find((l) => l.id === d.leagueId);
    if (!lg) return compReply(ws, 'import', { ok: false, error: 'Select a league first.' });
    const text = String(d.text || '');
    let raw = null;
    if (/^\s*[{[]/.test(text)) {
      try { raw = JSON.parse(text); } catch (e) { return compReply(ws, 'import', { ok: false, error: 'That is not valid JSON: ' + e.message }); }
    } else {
      const out = competition.csvToDoc(text);
      if (!out.doc) return compReply(ws, 'import', { ok: false, error: out.error });
      raw = out.doc;
    }
    const r = applyCompetitionDoc(lg, raw, { prune: false });
    if (!r.ok) return compReply(ws, 'import', { ok: false, error: r.errors.join(' '), warnings: r.warnings });
    compReply(ws, 'import', { ok: true, leagueId: lg.id, summary: describeSyncReport(r.report), warnings: r.warnings });
  },
  // Dashboard ▸ Event ▸ My league: paste a Google Sheet or a league feed link → a league that syncs
  // from it, synced once right away and (by default) put on air. Pasting a link that is already
  // linked reuses that league instead of creating a duplicate. Nothing is created if the link
  // can't be read or holds no teams/matches — the producer gets the reason instead.
  competition_link(msg, ws) {
    const d = msg.data || {};
    const type = d.type === 'sheet' ? 'sheet' : 'feed';
    const url = String(d.url || '').trim().slice(0, 1000);
    if (!/^https?:\/\//i.test(url)) return compReply(ws, 'link', { ok: false, error: 'Paste a full link starting with https://' });
    (async () => {
      try {
        let sa = null;
        if (sheetsServiceAccount) { try { sa = sheets.parseServiceAccount(sheetsServiceAccount); } catch (_) { sa = null; } }
        const sameSource = (l) => l && l.source && l.source.type === type && (type === 'sheet'
          ? competitionSources.sheetIdFrom(l.source.sheetUrl) === competitionSources.sheetIdFrom(url)
          : l.source.feedUrl === url);
        const existing = (state.leagues || []).find(sameSource);
        let title = '';
        let source = { type, sheetUrl: type === 'sheet' ? url : '', feedUrl: type === 'feed' ? url : '' };
        if (type === 'sheet' && !existing) {
          const found = await competitionSources.detectSheet({ sheetUrl: url, sheets, sa });
          if (!found.tabs.teams && !found.tabs.matches) {
            throw new Error('Opened the sheet, but found no Teams or Matches tab with the expected columns (Team, or Team A / Team B). See Apps > API for the layout.');
          }
          title = found.title;
          source.tabs = found.tabs;
        }
        const lg = existing || migrateLeague({ id: srvLgUid('lg'), name: '', game: state.activeGame || '', status: 'active', type: 'team',
          teams: [], schedule: [], standings: [], source });
        const got = await readLeagueSource(lg);
        const v = competition.validateDoc(got.raw);
        if (!v.doc) throw new Error(v.errors.join(' '));
        if (!v.doc.teams.length && !v.doc.matches.length) throw new Error(type === 'sheet' ? 'The sheet has no teams or matches yet.' : 'The feed has no teams or matches.');
        if (!existing) state.leagues = (state.leagues || []).concat([lg]);
        const out = applyCompetitionDoc(lg, got.raw, { prune: got.prune });
        if (!lg.name) lg.name = v.doc.competition.name || title || (type === 'sheet' ? 'Google Sheet league' : 'Linked league');
        if (got.etag) _compEtags[lg.id] = got.etag;
        const st = compSyncStatus(lg.id);
        st.lastSyncAt = st.lastOkAt = Date.now(); st.lastError = ''; st.fails = 0;
        st.summary = describeSyncReport(out.report);
        st.warnings = (out.warnings || []).slice(0, 20);
        leaguesVer++;
        if (d.goLive !== false) competitionGoLive(lg.id);
        saveAppState();
        broadcastFullState();
        compReply(ws, 'link', { ok: true, leagueId: lg.id, name: lg.name, created: !existing, live: d.goLive !== false,
          teams: (lg.teams || []).length, matches: (lg.schedule || []).length, warnings: st.warnings });
      } catch (e) {
        compReply(ws, 'link', { ok: false, error: (e && e.message) || String(e) });
      }
    })();
  },
  // Feed bearer token — stored server-side only; the panel just learns whether one is set.
  competition_set_feed_token(msg, ws) {
    const d = msg.data || {};
    const id = String(d.leagueId || '');
    if (!id) return;
    if (d.clear || !String(d.token || '').trim()) delete competitionFeedTokens[id];
    else competitionFeedTokens[id] = String(d.token).trim().slice(0, 2000);
    delete _compEtags[id];
    saveAppState();
    compReply(ws, 'feed_token', { leagueId: id, ok: true, hasToken: !!competitionFeedTokens[id] });
  },
  competition_feed_token_status(msg, ws) {
    const id = String((msg.data && msg.data.leagueId) || '');
    compReply(ws, 'feed_token', { leagueId: id, ok: true, hasToken: !!competitionFeedTokens[id] });
  },
  // The /api/v1 key. Sent to the asking socket only — never broadcast. Operators can't read it
  // (wsRoleAllows blocks message types containing "api_key").
  competition_api_key(msg, ws) {
    const key = ensureCompetitionApiKey(!!(msg.data && msg.data.regenerate));
    compReply(ws, 'api_key', { ok: true, key });
  },
});

// ── Upcoming-matches + standings overlays ──
registerWsHandlers({
  set_upcoming(msg) {
    const p = msg.data || {};
    if (typeof p.visible === 'boolean') setExclusiveGfxVisible('upcoming', p.visible);
    if (typeof p.title === 'string') state.upcoming.title = p.title;
    if (typeof p.eyebrow === 'string') state.upcoming.eyebrow = p.eyebrow;
    if (['cards', 'board', 'single', 'dual'].includes(p.layout)) state.upcoming.layout = p.layout;
    if (typeof p.showResults === 'boolean') state.upcoming.showResults = p.showResults;
    if (Array.isArray(p.matches)) state.upcoming.matches = p.matches;
    // A league-sourced board follows that league from here on (refreshCompetitionFeed re-mirrors it
    // on every change) and replaces the start.gg queue instead of being merged into it.
    if (['event', 'team', 'manual', 'league'].includes(p.source)) {
      state.upcoming.source = p.source;
      state.upcoming.leagueId = p.source === 'league' ? String(p.leagueId || '') : '';
      if (p.source === 'league' && state.upcoming.leagueId) {
        const lg = (state.leagues || []).find((l) => l.id === state.upcoming.leagueId);
        const feed = lg ? competition.buildFeed(lg, { resolveTeam: compResolveTeam, liveIds: competitionLiveIds(lg) }) : null;
        if (feed) state.upcoming.matches = competitionScheduleRows(feed);
      }
    }
    saveAppState();
    broadcastFullState();
  },
  set_standings(msg) {
    const p = msg.data || {};
    if (typeof p.visible === 'boolean') setExclusiveGfxVisible('standings', p.visible);
    if (typeof p.title === 'string') state.standings.title = p.title;
    if (typeof p.subtitle === 'string') state.standings.subtitle = p.subtitle;
    if (typeof p.showRecord === 'boolean') state.standings.showRecord = p.showRecord;
    if (['auto', 'podium', 'placement'].includes(p.layout)) state.standings.layout = p.layout;
    if (typeof p.source === 'string') state.standings.source = p.source;
    if (typeof p.gamesLabel === 'string') state.standings.gamesLabel = p.gamesLabel;   // "Games" / "Maps" for the game-aware column
    if (typeof p.leagueId === 'string') state.standings.leagueId = p.leagueId;
    if (Array.isArray(p.rows)) state.standings.rows = p.rows;
    // A League-sourced board tracks the league from here on: recompute from the live league so the
    // pushed rows can never be a stale snapshot of our points.
    if (state.standings.source === 'league') refreshLeagueStandingsMirror();
    saveAppState();
    broadcastFullState();
  },
  set_league_stats(msg) {
    const p = msg.data || {};
    if (typeof p.visible === 'boolean') state.leagueStats.visible = p.visible;
    if (typeof p.title === 'string') state.leagueStats.title = p.title;
    if (typeof p.subtitle === 'string') state.leagueStats.subtitle = p.subtitle;
    if (Array.isArray(p.columns)) state.leagueStats.columns = p.columns.slice(0, 24);
    if (Array.isArray(p.rows)) state.leagueStats.rows = p.rows.slice(0, 40);
    saveAppState();
    broadcastFullState();
  }
});

// ── Series stats board (Rocket League) ──
registerWsHandlers({
  set_series_stats(msg) {
    const p = msg.data || {};
    const ss = state.seriesStats;
    // Through setExclusiveGfxVisible, never `ss.visible = ...` directly: gfx.html gates on
    // gfxActive, so setting the flag alone puts the board "on air" where nothing can see it.
    if (typeof p.visible === 'boolean') setExclusiveGfxVisible('seriesstats', p.visible);
    if (typeof p.enabled === 'boolean') ss.enabled = p.enabled;
    if (typeof p.design === 'string' && SERIES_STATS_DESIGNS.includes(p.design)) ss.design = p.design;
    // Producer's explicit Clear — drops the banked games without touching the series SCORE, so a
    // mis-started sheet can be reset mid-series without resetting the match.
    if (p.clear === true) { ss.games = []; ss.liveBanked = false; }
    saveAppState();
    broadcastFullState();
  }
});

// ── Teams to Watch (watchlist) + single-team spotlight ──
registerWsHandlers({
  set_watchlist(msg) {
    const p = msg.data || {};
    const w = state.watchlist;
    if (typeof p.visible === 'boolean') w.visible = p.visible;
    if (typeof p.title === 'string') w.title = p.title.slice(0, 80);
    if (typeof p.subtitle === 'string') w.subtitle = p.subtitle.slice(0, 120);
    if (typeof p.logo === 'string') w.logo = p.logo.slice(0, 600000);
    if (Array.isArray(p.fields)) w.fields = p.fields.slice(0, 6).map((f) => ({
      id: (f.id || ('f' + Math.random().toString(36).slice(2, 7))).toString().slice(0, 24),
      label: (f.label || 'FIELD').toString().slice(0, 40)
    }));
    if (Array.isArray(p.teams)) w.teams = p.teams.slice(0, 12).map((t) => ({
      id: (t.id || ('t' + Math.random().toString(36).slice(2, 9))).toString().slice(0, 24),
      name: (t.name || '').toString().slice(0, 80),
      players: Array.isArray(t.players) ? t.players.slice(0, 8).map((x) => (x || '').toString().slice(0, 60)) : [],
      values: (t.values && typeof t.values === 'object') ? Object.fromEntries(Object.entries(t.values).slice(0, 6).map(([k, v]) => [k.toString().slice(0, 24), (v || '').toString().slice(0, 40)])) : {},
      pos: Math.max(0, Math.min(12, Number(t.pos) || 0)),   // 0 = unranked; 1 = podium centre
      entrantId: (t.entrantId || '').toString().slice(0, 24),
      eventSlug: (t.eventSlug || '').toString().slice(0, 200)
    }));
    saveAppState();
    broadcastFullState();
  },
  // Mark / unmark one team (the ★ on event team cards) — toggles by name, preserving values.
  toggle_watchlist_team(msg) {
    const t = (msg.data && msg.data.team) || {};
    const name = (t.name || '').toString().trim();
    if (!name) return;
    const w = state.watchlist;
    if (!Array.isArray(w.teams)) w.teams = [];
    const i = w.teams.findIndex((x) => (x.name || '').toLowerCase() === name.toLowerCase());
    if (i >= 0) w.teams.splice(i, 1);
    else if (w.teams.length < 12) {
      w.teams.push({
        id: 't' + Math.random().toString(36).slice(2, 9),
        name: name.slice(0, 80),
        players: Array.isArray(t.players) ? t.players.slice(0, 8).map((x) => (x || '').toString().slice(0, 60)) : [],
        values: {}, pos: 0,
        entrantId: (t.entrantId || '').toString().slice(0, 24),   // for the single-team start.gg deep-dive
        eventSlug: (t.eventSlug || '').toString().slice(0, 200)
      });
      // Auto-fill the subtitle with the start.gg event name on the first marked team (overridable).
      const evName = (msg.data && msg.data.event || '').toString().trim();
      if (evName && !w.subtitle) w.subtitle = evName.slice(0, 120);
    }
    saveAppState();
    broadcastFullState();
  },
  // Single-team spotlight — target a team + (optionally) go live; start.gg data fetched async.
  set_team_spotlight(msg) {
    const p = msg.data || {};
    const ts = state.teamSpotlight;
    let retarget = false;
    if (typeof p.name === 'string') { if (p.name !== ts.name) retarget = true; ts.name = p.name.slice(0, 80); }
    if (typeof p.eventSlug === 'string') ts.eventSlug = p.eventSlug.slice(0, 200);
    if (typeof p.entrantId === 'string') { if (p.entrantId !== ts.entrantId) retarget = true; ts.entrantId = p.entrantId.slice(0, 24); }
    if (Array.isArray(p.players)) ts.players = p.players.slice(0, 8).map((x) => ({ gamerTag: ((x && x.gamerTag) || x || '').toString().slice(0, 60), name: '', seedRank: '' }));
    if (typeof p.visible === 'boolean') ts.visible = p.visible;
    if (retarget) { ts.sg = { seed: null, placement: null, record: { w: 0, l: 0 }, recent: [], next: null }; ts.lastSync = 0; ts.syncError = ''; }
    enrichSpotlightSeeding();
    saveAppState();
    broadcastFullState();
    if (p.fetch !== false && ts.entrantId) refreshTeamSpotlight().catch(() => {});
  }
});

// Latch for the Smash stock countdown (see the "Smash stock countdown" block inside the switch
// below). It MUST live out here: a `let` inside the switch body is shared by every case but is
// only initialized if execution actually reaches its line, which a `case` jump never does.
let _smashGameClosed = false;

// Smash board helpers. These live at MODULE scope on purpose: declared inside handleControlMessage's
// switch they were invisible to loadState() and the start.gg format sync, and the ReferenceError
// aborted the state restore part-way — which silently wiped the crew roster (and everything
// restored after it) on every launch that had a saved Smash board.
function normalizeSmashMode(m) { return (m === 'team' || m === 'doubles') ? m : 'singles'; }
// Doubles + crew keep per-player stocks in players[] and pool them; singles uses the one count.
function smashPooled() { return state.smash.mode === 'team' || state.smash.mode === 'doubles'; }
// Players per side for the pooled modes: doubles is always two, crew is the chosen crew size.
function smashSideSize() {
  return state.smash.mode === 'doubles' ? 2 : Math.max(1, Math.min(8, Number(state.smash.crewSize) || 4));
}
// Resize both sides' players[] / characters[] (kept parallel) to n.
function resizeSmashSides(n) {
  ['blue', 'orange'].forEach((s) => {
    const next = (Array.isArray(state.smash[s].players) ? state.smash[s].players : []).slice(0, n);
    while (next.length < n) next.push(state.smash.startStocks);
    state.smash[s].players = next;
    const chars = (Array.isArray(state.smash[s].characters) ? state.smash[s].characters : []).slice(0, n);
    while (chars.length < n) chars.push('');
    state.smash[s].characters = chars;
  });
}
function setSmashMode(mode) {
  state.smash.mode = normalizeSmashMode(mode);
  if (smashPooled()) resizeSmashSides(smashSideSize());
}

// Stocks a side still has: the pooled total in doubles/crew, the single count in singles.
function smashStocksLeft(side) {
  const sd = state.smash[side] || {};
  if (smashPooled()) {
    return (Array.isArray(sd.players) ? sd.players : []).reduce((a, n) => a + Math.max(0, Number(n) || 0), 0);
  }
  return Math.max(0, Number(sd.stocks) || 0);
}

// The stocks a side STARTS a game with — one per crew member in team mode, so the countdown is
// scaled to the format rather than to a single fixed number.
function smashStockPool(side) {
  const start = Math.max(1, Math.min(9, Number(state.smash.startStocks) || 3));
  if (!smashPooled()) return start;
  const n = (Array.isArray((state.smash[side] || {}).players) ? state.smash[side].players.length : 0)
         || smashSideSize();
  return n * start;
}

function refillSmashStocks() {
  const start = state.smash.startStocks;
  ['blue', 'orange'].forEach((side) => {
    state.smash[side].stocks = start;
    state.smash[side].players = (state.smash[side].players || []).map(() => start);
  });
}

/** Called after every stock write. Returns true when it closed the game. */
// ── Brawlhalla board helpers ────────────────────────────────────────────────
// Module scope for the same reason the Smash helpers are: loadState() and the WS switch both call
// them, and a function declared inside the switch is a ReferenceError that aborts the whole state
// restore (see [[loadstate-abort-wipes-secrets]] / test/loadstate-restore.test.js).

// The Brawlhalla data layer. Created lazily: the API needs no key, but building the client at boot
// would spend a module load on every producer who never touches the game.
let _brawlhalla = null;
function brawlhalla() {
  if (!_brawlhalla) _brawlhalla = createBrawlhalla();
  return _brawlhalla;
}

let _bhGameClosed = false;
const bhSeats = () => (state.brawlhalla.mode === '2v2' ? 2 : 1);

// Stocks a side has left. 1v1 reads the side's own count; 2v2 pools the pair's, so a board can
// show "3 stocks left" for a team whose second player is already out.
function bhStocksLeft(side) {
  const sd = state.brawlhalla[side] || {};
  if (bhSeats() === 2) {
    return (sd.players || []).slice(0, 2).reduce((a, p) => a + Math.max(0, Number(p && p.stocks) || 0), 0);
  }
  return Math.max(0, Number(sd.stocks) || 0);
}

function refillBrawlhallaStocks() {
  const start = state.brawlhalla.startStocks;
  ['blue', 'orange'].forEach((side) => {
    state.brawlhalla[side].stocks = start;
    (state.brawlhalla[side].players || []).forEach((p) => { p.stocks = start; });
  });
}

// A side running out of stocks closes the game: the opponent takes the series point and both
// sides refill. Identical rule to Smash — same genre, same producer expectation.
function checkBrawlhallaGameOver() {
  if (!state.brawlhalla.autoAdvance) return false;
  const left = { blue: bhStocksLeft('blue'), orange: bhStocksLeft('orange') };
  if (left.blue > 0 && left.orange > 0) { _bhGameClosed = false; return false; }
  if (left.blue <= 0 && left.orange <= 0) return false;   // mid-reset, not a result
  if (_bhGameClosed) return false;
  _bhGameClosed = true;
  const winner = left.blue > 0 ? 'blue' : 'orange';
  const cap = Math.ceil(state.bestOf / 2);
  state.series[winner] = Math.max(0, Math.min(cap, (state.series[winner] || 0) + 1));
  const played = (state.series.blue || 0) + (state.series.orange || 0);
  state.game.number = Math.max(1, Math.min(state.bestOf, played + 1));
  refillBrawlhallaStocks();
  console.log(`[Brawlhalla] ${winner} took the game on stocks — series ${state.series.blue}-${state.series.orange}, game ${state.game.number}`);
  broadcast(bridgeClients, { type: 'brawlhalla-game-over', data: { winner, series: { ...state.series }, game: state.game.number } });
  return true;
}

/*
  Refresh the ranked card for one seat. Safe to call whenever — the data layer caches for five
  minutes, so a panel that calls this on every render still makes one request per player per five
  minutes.

  A failed lookup NEVER clears the card that is already on screen: the board is live, and replacing
  a rank chip with a blank because a single request timed out is worse than showing one that is a
  few minutes stale. The error is surfaced on state.brawlhalla.lastError instead.
*/
async function refreshBrawlhallaCard(side, seat = 0) {
  const sd = state.brawlhalla[side];
  if (!sd) return null;
  const p = (sd.players || [])[seat];
  if (!p || !p.bhId) return null;
  try {
    const card = await brawlhalla().playerCard(p.bhId, { mode: state.brawlhalla.rankMode });
    p.card = card;
    state.brawlhalla.lastError = '';
    state.brawlhalla.lastLookupAt = Date.now();
    return card;
  } catch (e) {
    state.brawlhalla.lastError = e.message;
    return null;
  }
}

// Every linked seat, refreshed together (both sides going on air at once).
async function refreshBrawlhallaCards() {
  const jobs = [];
  ['blue', 'orange'].forEach((side) => {
    for (let i = 0; i < bhSeats(); i++) jobs.push(refreshBrawlhallaCard(side, i));
  });
  await Promise.all(jobs);
  broadcastFullState();
}

function checkSmashGameOver() {
  if (!state.smash.autoAdvance) return false;
  const left = { blue: smashStocksLeft('blue'), orange: smashStocksLeft('orange') };
  if (left.blue > 0 && left.orange > 0) { _smashGameClosed = false; return false; }
  // Both at zero is a mid-reset state, not a result — wait for a real winner.
  if (left.blue <= 0 && left.orange <= 0) return false;
  if (_smashGameClosed) return false;
  _smashGameClosed = true;
  const winner = left.blue > 0 ? 'blue' : 'orange';
  const cap = Math.ceil(state.bestOf / 2);
  state.series[winner] = Math.max(0, Math.min(cap, (state.series[winner] || 0) + 1));
  const played = (state.series.blue || 0) + (state.series.orange || 0);
  state.game.number = Math.max(1, Math.min(state.bestOf, played + 1));
  refillSmashStocks();
  console.log(`[Smash] ${winner} took the game on stocks — series ${state.series.blue}-${state.series.orange}, game ${state.game.number}`);
  broadcast(bridgeClients, { type: 'smash-game-over', data: {
    winner, series: { ...state.series }, game: state.game.number
  } });
  return true;
}

// A message no handler knows (a typo in a button, a handler lost in a refactor) used to vanish
// silently. Log each unknown type once; test/ws-handlers.test.js keeps the senders covered.
const _unhandledTypes = new Set();
function warnUnhandledType(type) {
  const t = String(type || '(none)').slice(0, 60);
  if (_unhandledTypes.has(t) || _unhandledTypes.size > 200) return;
  _unhandledTypes.add(t);
  console.warn("[bridge] no handler for message type '" + t + "'");
}
function handleControlMessage(msg, ws) {
  const h = WS_HANDLERS[msg.type];
  if (h) return void h(msg, ws);
  warnUnhandledType(msg.type);
}

// Panel / overlay / Stream Deck messages (formerly the switch in handleControlMessage). One handler
// per type: test/ws-handlers.test.js fails on a type sent with no handler, or handled twice.
registerWsHandlers({
  // App-level heartbeat: lets a client confirm its receive direction is alive (half-open detection).
  ping(msg, ws) {
    try { ws.send(JSON.stringify({ type: 'pong' })); } catch (e) {}
  },

  // Auto-update controls → forwarded to electron-updater in main.js.
  check_for_update(msg, ws) {
    if (_updateHandlers && _updateHandlers.check) _updateHandlers.check();
    // No updater wired (server run on its own): answer, or the panel waits on "Checking..." forever.
    else module.exports.broadcastUpdateStatus({ state: 'error', message: 'Updates are unavailable here.', currentVersion: appVersion });
  },

  download_update(msg, ws) {
    if (_updateHandlers && _updateHandlers.download) _updateHandlers.download();
  },

  install_update(msg, ws) {
    if (_updateHandlers && _updateHandlers.install)  _updateHandlers.install();
  },

  request_state(msg, ws) {
    ws.send(JSON.stringify(getFullState()));
  },

  // Client self-identifies its role so the pre-flight checklist can count live overlay
  // browser sources. 'overlay' = an OBS/browser overlay source; 'control' = the panel.
  register(msg, ws) {
    const was = ws._role;
    ws._role = (msg.role === 'overlay' || msg.role === 'control') ? msg.role : 'unknown';
    ws._page = (typeof msg.page === 'string') ? msg.page.slice(0, 120) : '';
    if (ws._page) { if (!ws._pages) ws._pages = new Set(); if (ws._pages.size < 40) ws._pages.add(ws._page); }
    // Optional client tag (e.g. 'streamdeck') — the Integrations page shows a live
    // "Connected" chip for the Stream Deck plugin off this.
    ws._client = (typeof msg.client === 'string') ? msg.client.slice(0, 40) : '';
    if (ws._role === 'overlay' || was === 'overlay') maybeBroadcastOverlayCount();
    if (ws._client === 'streamdeck') broadcastFullState();
  },

  // Client (overlay/sticky-logos.js) can restore vaulted "@img:<hash>" image refs → opt it into the
  // compact broadcast variant. Purely additive: without this the client always gets whole images.
  imgvault_ready(msg, ws) {
    ws._imgvault = true;
  },

  // Safety net: the overlay got an "@img:" ref it can't resolve (its cache and our record of it
  // disagree). Forget what we think it holds and resend the whole state with every image in full.
  imgvault_miss(msg, ws) {
    ws._imgSent = new Set();
    try { const snap = JSON.stringify(getFullState()); ws.send(snap); _seedImgSent(ws, snap); }
    catch (e) { console.error('[bridge] imgvault resync failed:', (e && e.message) || e); }
  },

  set_telemetry(msg, ws) {
    const on = !!(msg.data && msg.data.enabled);
    if (!state.ai) state.ai = { shield: false, telemetry: { enabled: true, uploadEnabled: false, lastUploadAt: null, lastUploadCount: 0 } };
    if (!state.ai.telemetry) state.ai.telemetry = { enabled: true, uploadEnabled: false, lastUploadAt: null, lastUploadCount: 0 };
    state.ai.telemetry.enabled = on;   // preserve uploadEnabled/lastUploadAt/lastUploadCount — this only toggles local recording
    if (telemetry) telemetry.setEnabled(on);
    saveAppState();
    broadcastFullState();
  },

  // Separate, explicit opt-in to also batch already-recorded local telemetry to the shared
  // cloud training dataset (Phase 2) — distinct from set_telemetry above (local recording).
  set_telemetry_upload(msg, ws) {
    const on = !!(msg.data && msg.data.enabled);
    if (!state.ai) state.ai = { shield: false, telemetry: { enabled: true, uploadEnabled: false, lastUploadAt: null, lastUploadCount: 0 } };
    if (!state.ai.telemetry) state.ai.telemetry = { enabled: true, uploadEnabled: false, lastUploadAt: null, lastUploadCount: 0 };
    state.ai.telemetry.uploadEnabled = on;
    saveAppState();
    broadcastFullState();
  },
});

// Normalise a Game Config bundle against the game's BUILT-IN maps + roster (ids, blank overrides,
// image bounds) — see backend/game-config.js.
// The active custom content changed after it was loaded from / saved as a version.
function markGameConfigEdited(gameId) {
  const from = (state.gameConfigFrom || {})[gameId];
  state.gameConfigFrom = { ...(state.gameConfigFrom || {}), [gameId]: { name: (from && from.name) || '', clean: false } };
}

function normalizeGameConfigFor(bundle) {
  const game = String((bundle && bundle.game) || '');
  return gameConfigData.normalizeGameConfig(bundle, {
    maps: vetoData.mapPool(game) || [],
    characters: (draftData.ROSTERS && draftData.ROSTERS[game]) || []
  });
}

function sendImportExportResult(ws, result, message, context) {
  ws.send(JSON.stringify({
    type: 'import-export-result',
    data: { result, message, context: context || 'profile' }
  }));
}

function mergeAtTop(savedArray, importedArray, isSameItem) {
  const filteredNew = importedArray.filter(importItem => {
    return !savedArray.some(savedItem => isSameItem(savedItem, importItem));
  });

  return [...filteredNew, ...savedArray];
}

// Image vault: repeat base64 images (team/standings/ad logos) are the bulk of the live payload but
// almost never change. Clients that sent `imgvault_ready` (overlay/sticky-logos.js) cache each image
// the first time they see it and thereafter accept a compact "@img:<hash>" reference. This strips the
// bytes off every subsequent broadcast for those clients — big win for remote overlays. Legacy clients
// (no script / didn't opt in) get the untouched payload, so nothing regresses.
// What each client has ALREADY RECEIVED lives on the socket (ws._imgSent), not in one global set.
// A global set broke logos on real shows: an overlay that connected or reloaded later only got
// the images in its connect snapshot, so a logo that came back afterwards (team X plays again,
// brand kit switched back) arrived as an "@img:" ref that overlay had never seen.
function _imgHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + '.' + s.length; }
// A manual scan instead of one regex over the whole payload — the previous version matched
// [A-Za-z0-9+/=]{1024,}" directly against each base64 run, and a full-resolution logo can run
// 100k+ characters. That unbounded quantifier is exactly what threw "Maximum call stack size
// exceeded" from INSIDE V8's own regex engine (crash.log showed `at String.replace`, not our code)
// on two separate real broadcasts — neither one related to start.gg; one came from an OBS source
// visibility change. indexOf() has no equivalent risk: base64 never contains an unescaped '"', so
// the first quote after the "data:image/...;base64, prefix IS the payload's real end — no
// backtracking, and no regex ever runs over the (huge) payload itself.
// Split a payload ONCE into plain text runs and vaultable images: { parts: [string | {h, val}], hashes }.
// Returns null when it holds no image worth vaulting.
function _imgSegments(str) {
  const PREFIX_RE = /"data:image\/[a-z0-9.+-]+;base64,/gi;   // matches only the short prefix, never the payload
  const parts = [], hashes = [];
  let lastIndex = 0;
  let m;
  while ((m = PREFIX_RE.exec(str))) {
    const dataStart = m.index + m[0].length;
    const endQuote = str.indexOf('"', dataStart);
    if (endQuote === -1) { PREFIX_RE.lastIndex = dataStart; continue; }   // malformed/truncated — leave it, keep scanning
    const b64 = str.slice(dataStart, endQuote);
    if (b64.length < 1024) { PREFIX_RE.lastIndex = endQuote + 1; continue; }   // too small to bother vaulting
    parts.push(str.slice(lastIndex, m.index));
    const val = m[0].slice(1) + b64;   // data:image/...;base64,XXXX (no quotes) — what the client hashes
    const h = _imgHash(val);
    parts.push({ h, val }); hashes.push(h);
    lastIndex = endQuote + 1;
    PREFIX_RE.lastIndex = lastIndex;
  }
  if (!hashes.length) return null;
  parts.push(str.slice(lastIndex));
  return { parts, hashes };
}
// Render a segmented payload for ONE client: images it already holds become "@img:<hash>", the rest
// go in full and are recorded as held. `memo` shares the rendered string between clients that are
// missing the same images (normally every client, so it is built once per broadcast).
function _vaultFor(seg, ws, memo) {
  if (!ws._imgSent) ws._imgSent = new Set();
  const sent = ws._imgSent;
  const key = seg.hashes.filter((h) => !sent.has(h)).join(',');
  let out = memo.get(key);
  if (out === undefined) {
    out = '';
    const inThisMsg = new Set();
    for (const p of seg.parts) {
      if (typeof p === 'string') { out += p; continue; }
      if (sent.has(p.h) || inThisMsg.has(p.h)) out += '"@img:' + p.h + '"';
      else { inThisMsg.add(p.h); out += '"' + p.val + '"'; }
    }
    memo.set(key, out);
  }
  for (const h of seg.hashes) sent.add(h);
  return out;
}
// A client was just sent `str` un-vaulted (connect snapshot, resync): it now holds those images.
function _seedImgSent(ws, str) {
  try { const seg = _imgSegments(str); if (!seg) return; if (!ws._imgSent) ws._imgSent = new Set(); seg.hashes.forEach((h) => ws._imgSent.add(h)); }
  catch (_) { /* seeding is an optimisation only */ }
}
// Diagnostic — only ever runs AFTER JSON.stringify has already thrown, so its O(n) cost is moot.
// Locates the first circular reference or pathologically deep chain in `root` and returns a
// human-readable key path (e.g. "$.bracket.winners[0].sets…"). Depth-capped well below the native
// stack limit so the diagnostic itself can never overflow; cycles are caught via the ancestor path.
function _diagnoseSerialization(root) {
  const CAP = 500;                    // report anything deeper than this rather than risk our own overflow
  const NODE_LIMIT = 3000000;         // safety valve on a huge-but-flat object
  let deepest = { d: 0, path: '$' };
  let nodes = 0;
  function walk(v, path, depth, ancestors) {
    if (++nodes > NODE_LIMIT) return `ABORTED after ${nodes} nodes (deepest so far: ${deepest.path})`;
    if (depth > deepest.d) deepest = { d: depth, path };
    if (v === null || typeof v !== 'object') return null;
    if (ancestors.has(v)) return `CIRCULAR reference back to an ancestor at ${path}`;
    if (depth >= CAP) return `TOO DEEP (>=${CAP} levels) at ${path}`;
    ancestors.add(v);
    for (const k of Object.keys(v)) {
      const hit = walk(v[k], path + (Array.isArray(v) ? `[${k}]` : `.${k}`), depth + 1, ancestors);
      if (hit) { ancestors.delete(v); return hit; }
    }
    ancestors.delete(v);
    return null;
  }
  return walk(root, '$', 0, new Set()) || `no cycle found; deepest chain (${deepest.d} levels) = ${deepest.path}`;
}
// Record a state-serialization failure to the console AND crash.log (the reliable channel in a
// packaged build, where the server console goes nowhere). Same log file main.js uses for crashes.
// The STACK TRACE is the prize: "Maximum call stack size exceeded" is a runaway *recursive function*
// (JSON.stringify itself tolerates 500k-deep and reports circular refs with a different message), so
// e.stack names the frame that's repeating — the actual bug. `where` is a secondary data-path signal.
//
// ALSO relayed to the renderer's own console buffer (client_log, below) — this runs in the Electron
// MAIN process, a separate JS context the in-app bug reporter's console capture (core.js) can never
// see on its own, so without this relay the exact diagnostic a producer's bug report most needs
// (the repeating stack frame) would sit in crash.log forever, unattached to the report they file.
function _logSerializeFailure(text, err) {
  console.error('[state] serialization failed:', text);
  const stack = (err && err.stack) ? String(err.stack).slice(0, 4000) : '(no stack)';
  try {
    const logPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ne-broadcast-suite', 'logs', 'crash.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] state serialize FAILED: ${text}\n  STACK: ${stack}\n`);
  } catch (_) { /* logging must never throw */ }
  try { broadcast(bridgeClients, { type: 'client_log', data: { level: 'error', text: `[state] serialization failed: ${text}\n${stack}` } }); } catch (_) {}
}
let _bcTimer = null, _bcPending = false, _lastLibSig = '', _lastMsgStr = '';
function _flushFullState() {
  try { syncOwDraftMap(); } catch (e) { console.warn('[draft] OW map sync failed:', e.message); }
  let data, realStr;
  try {
    data = buildLiveState();
    const sig = librarySig();
    const libChanged = (sig !== _lastLibSig);
    // Something in the library moved — ship only the keys that actually changed (see libraryDelta).
    if (libChanged) { _lastLibSig = sig; Object.assign(data, libraryDelta()); }
    // Serialize ONCE. Skip byte-identical re-sends (a mutation that didn't change anything live — only a
    // library/local key moved, or an identical value was written). New clients get their own snapshot via
    // the connection handler, so deduping the throttled path never starves them.
    realStr = JSON.stringify({ type: 'full_state', data });
  } catch (e) {
    // "Maximum call stack size exceeded" here = a circular ref or pathologically deep chain in the live
    // payload — almost always from a freshly-loaded start.gg/bracket object. Pinpoint the offending key
    // path and log it, instead of letting the throw abort the in-flight load (whose catch relays the raw
    // message to the panel) or crash the main process. The broadcast is skipped; the next mutation retries.
    _lastLibSig = ''; _libKeySigs = {};   // force a full library rebuild on the next (successful) flush
    let where;
    try { where = _diagnoseSerialization(data !== undefined ? data : state); } catch (_) { where = 'diagnosis walk failed'; }
    _logSerializeFailure(`_flushFullState: ${(e && e.message) || e} — data-path signal: ${where}`, e);
    feedDirectorBroadcast();
    return;
  }
  if (realStr === _lastMsgStr) { feedDirectorBroadcast(); return; }
  _lastMsgStr = realStr;
  // Build the vaulted variant once, only if some connected client can use it. Belt-and-suspenders:
  // vaulting is a bandwidth optimization, never something worth crashing the broadcast over — if it
  // ever throws for any reason, log it and fall through to sending every client the untouched string.
  let seg = null;
  for (const ws of bridgeClients) {
    if (ws._imgvault) {
      try { seg = _imgSegments(realStr); } catch (e) { _logSerializeFailure(`_imgSegments: ${e.message}`, e); }
      break;
    }
  }
  const memo = new Map();
  for (const ws of bridgeClients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    let out = realStr;
    if (ws._imgvault && seg) {
      try { out = _vaultFor(seg, ws, memo); } catch (e) { out = realStr; _logSerializeFailure(`_vaultFor: ${e.message}`, e); }
    }
    ws.send(out);
  }
  feedDirectorBroadcast();
}
// Coalesce bursts: broadcast immediately (leading edge), then at most once per 40ms. Collapses
// the common `saveAppState(); broadcastFullState();` storms and rapid multi-field updates into
// a single send, so the main thread isn't re-stringifying/​re-sending dozens of times a second.
function broadcastFullState() {
  if (_bcTimer) { _bcPending = true; return; }
  _flushFullState();
  _bcTimer = setTimeout(() => {
    _bcTimer = null;
    if (_bcPending) { _bcPending = false; broadcastFullState(); }
    // Coalesce width follows the Performance settings: wider while a match is live /
    // lean mode, and the producer's chosen overlay update rate otherwise. (RL tick
    // data rides the tiny state_update channel and is never delayed by this.)
  }, perfCoalesceMs());
}

// ─── HTTP Server (port 3000) — serves overlay ────────────────────────────────
function startHttpServer(baseDir) {
  const app = express();
  // FIRST middleware: refuse requests from foreign web pages (any site in the producer's browser
  // could otherwise read state and fetch the WS token) and answer CORS for allowed callers.
  // See backend/origin-guard.js for who is allowed.
  app.use(originGuardMiddleware((m) => console.warn(m)));
  // Which overlay pages have actually been served this session (see recoverFailedBrowserSources).
  app.use((req, res, next) => { if (req.method === 'GET' && /\.html$/i.test(req.path)) _pagesServed.add(req.path.toLowerCase()); next(); });
  const overlayDir = path.join(baseDir, 'overlay');
  const overridesDir = path.join(dataDir, 'overlay-overrides');
  overlayEditor = createOverlayEditor({ overlayDir, overridesDir });

  // Inject the sticky-logos client as the first <head> script of EVERY served overlay page, so remote
  // overlays opt into compact @img: image refs (see overlay/sticky-logos.js) with zero per-file edits.
  // Covers user overrides and base overlays; on any read error it falls through to normal serving.
  //
  // scene-bg.js rides the same injection so the Scenes page "Background fill" works on EVERY
  // overlay, not just the ones that load scene-base.js (19 didn't, so the control silently did
  // nothing on the main HUD, upcoming, credits, valorant, lol, apex, pulse…). It MUST come after
  // sticky-logos so its WebSocket wrapper sits outside sticky's and observes restored frames.
  // The bare address (and /index.html) used to be the Classic RL HUD, retired 2026-10. Plenty of OBS
  // scenes still point at http://localhost:3000/, so send them to the React HUD (query kept, e.g.
  // ?only=scoreboard). A redirect, not a rewrite: the page's real path is then /rl-hud.html, which
  // per-overlay settings (background fill, HTML overrides) are keyed on.
  app.get(['/', '/index.html'], (req, res) => {
    const q = req.originalUrl.indexOf('?');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.redirect(302, '/rl-hud.html' + (q >= 0 ? req.originalUrl.slice(q) : ''));
  });

  const _stickyTag = '<script src="/sticky-logos.js"></script>\n  <script src="/scene-bg.js"></script>';
  const _resolveOverlayHtml = (reqPath) => {
    const ov = overlayEditor.resolveFileForRequest(reqPath);
    if (ov) return ov;
    const rel = (reqPath === '/' ? '' : reqPath.replace(/^\/+/, ''));
    if (!rel || !/\.html$/i.test(rel)) return null;
    const full = path.join(overlayDir, rel);
    if (!full.startsWith(overlayDir)) return null;   // path-traversal guard
    return fs.existsSync(full) ? full : null;
  };
  app.get(/^\/([^?]*\.html)?$/i, (req, res, next) => {
    // A ?preview=1 URL pasted into an OBS Browser Source must not put sample data on air — see
    // backend/obs-preview-guard.js. Redirect (not rewrite) so location.search is clean for the
    // overlays that parse ?preview themselves.
    const live = obsPreviewRedirect(req.originalUrl, req.headers['user-agent']);
    if (live) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.redirect(302, live);
    }
    const file = _resolveOverlayHtml(req.path);
    if (!file || !/\.html$/i.test(file)) return next();
    fs.readFile(file, 'utf8', (err, html) => {
      if (err) return next();
      // Skip only if BOTH injected clients are already present — a page that hand-rolls one of
      // them must still receive the other (otherwise scene-bg.js would silently never load).
      const out = (html.indexOf('sticky-logos.js') >= 0 && html.indexOf('scene-bg.js') >= 0) ? html
        : (/<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + '\n  ' + _stickyTag)
                                     : _stickyTag + '\n' + html);
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.type('html').send(out);
    });
  });

  // Custom overlay files (user HTML overrides) before static fallback
  app.get(/^\/[^?]*\.(html|css|js)$/i, (req, res, next) => {
    const file = overlayEditor.resolveFileForRequest(req.path);
    if (!file) return next();
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.sendFile(file);
  });
  app.get('/api/overlay/source', async (req, res) => {
    try {
      const data = await overlayEditor.getSource(req.query.path || '/');
      res.json({ ok: true, ...data });
    } catch (e) {
      res.status(400).json({ ok: false, message: e.message });
    }
  });

  app.post('/api/overlay/save', express.json({ limit: '4mb' }), async (req, res) => {
    try {
      const { path: filePath, content } = req.body || {};
      const data = await overlayEditor.saveOverride(filePath, content);
      res.json({ ok: true, ...data });
    } catch (e) {
      res.status(400).json({ ok: false, message: e.message });
    }
  });

  app.post('/api/overlay/revert', express.json({ limit: '256kb' }), async (req, res) => {
    try {
      const data = await overlayEditor.revert((req.body || {}).path);
      res.json({ ok: true, ...data });
    } catch (e) {
      res.status(400).json({ ok: false, message: e.message });
    }
  });

  app.get('/api/overlay/overrides', async (req, res) => {
    try {
      const paths = await overlayEditor.listOverrides();
      res.json({ ok: true, paths });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  // Almost every overlay file opens with a `<!-- filename.html — description... -->` header
  // comment (see duorow.html, preshow.html, etc.) — pull the first line of it as a free
  // auto-description so newly-added, not-yet-curated scenes still show something useful in
  // the "Other Overlays" fallback group instead of a generic placeholder.
  async function overlayAutoDescription(filePath) {
    try {
      const fh = await fsp.open(filePath, 'r');
      const buf = Buffer.alloc(2048);
      const { bytesRead } = await fh.read(buf, 0, 2048, 0);
      await fh.close();
      const head = buf.slice(0, bytesRead).toString('utf8');
      const m = head.match(/<!--\s*([\s\S]*?)-->/);
      if (!m) return '';
      const firstLine = m[1].split('\n').map((l) => l.trim()).find((l) => l);
      if (!firstLine) return '';
      return firstLine.replace(/^[\w.-]+\.html\s*[—-]\s*/, '').trim();
    } catch (e) { return ''; }
  }

  // List every overlay HTML on disk so the Scenes page auto-discovers new scenes
  // (no need to hand-maintain a list). Internal pages are excluded.
  app.get('/api/overlays', async (req, res) => {
    // launcher + overlay index + upcoming→schedule redirect stub + CS2 Observer Assist (over-game window only; it hides itself in OBS)
    const EXCLUDE = new Set(['scenes.html', 'index.html', 'upcoming.html', 'cs2-observer.html']);
    try {
      const files = (await fsp.readdir(overlayDir))
        .filter((f) => /\.html$/i.test(f) && !EXCLUDE.has(f.toLowerCase()))
        .sort();
      const overlays = await Promise.all(files.map(async (f) => ({
        file: f, path: '/' + f, desc: await overlayAutoDescription(path.join(overlayDir, f))
      })));
      res.json({ ok: true, overlays });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  require('./backend/http/overlay-thumbs')({
    HTTP_PORT, app, electronApi, fs, fsp, overlayDir, path,
    get dataDir() { return dataDir; }, set dataDir(v) { dataDir = v; }
  });

  require('./backend/http/obs-collection')({
    OBS_AUDIT_LABELS, _electronApp, app, broadcastFullState, dialog, express, fs, fsp,
    generateSceneCollection, obsAuditFile, os, path, saveAppState, state,
    get obsClient() { return obsClient; }, set obsClient(v) { obsClient = v; },
    get obsSettingsAudit() { return obsSettingsAudit; }, set obsSettingsAudit(v) { obsSettingsAudit = v; },
    get obsSettingsCurrent() { return obsSettingsCurrent; }, set obsSettingsCurrent(v) { obsSettingsCurrent = v; }
  });

  require('./backend/http/stats-analytics')({
    analytics, app, bridgeClients, broadcast, createStartGgClient, express, startggImport,
    state, stats, streamStateManager, twitchStats,
    get _startggImportRunning() { return _startggImportRunning; }, set _startggImportRunning(v) { _startggImportRunning = v; },
    get _twitchStatsCache() { return _twitchStatsCache; }, set _twitchStatsCache(v) { _twitchStatsCache = v; },
    get socialPublisher() { return socialPublisher; }, set socialPublisher(v) { socialPublisher = v; },
    get startggApiToken() { return startggApiToken; }, set startggApiToken(v) { startggApiToken = v; }
  });

  require('./backend/http/vdo-talent')({
    app, buildCasterJoinUrl, buildCasterObsUrl, buildDirectorUrl, buildListenInUrl,
    buildObsViewUrl, buildPlayerInterviewJoinUrl, buildPlayerInterviewViewUrl,
    buildRoomJoinUrl, buildRoomListenInUrl, buildTalentGroup, buildTalentJoinUrl, deskRoomVdo,
    ensureCasterVdo, ensureDirectorApiKey, ensureGuestsVdo, ensureObserversVdo, ensureTeamVdo,
    lanHost, lanSeats, playerStreamId, saveAppState, state, vdoBase, vdoSlug,
    get savedTeams() { return savedTeams; }, set savedTeams(v) { savedTeams = v; }
  });

  require('./backend/http/game-feeds')({
    apexLive, app, applyValorantGep, broadcastFullState, express, flowBus, path,
    startValorantWatchdog, state,
    get _apexServer() { return _apexServer; }, set _apexServer(v) { _apexServer = v; },
    get bedwarsToken() { return bedwarsToken; }, set bedwarsToken(v) { bedwarsToken = v; }
  });

  require('./backend/http/bug-report')({
    FormData, app, axios, baseDir, bridgeClients, broadcast, cloud, express, fs, path,
    showTimeline,
    get appVersion() { return appVersion; }, set appVersion(v) { appVersion = v; },
    get dataDir() { return dataDir; }, set dataDir(v) { dataDir = v; }
  });

  require('./backend/http/clips')({
    app, broadcastClipsUpdate, fs, fsp, needsAirPrep, path, showTimeline, state,
    get clipSystem() { return clipSystem; }, set clipSystem(v) { clipSystem = v; },
    get obsStingerFile() { return obsStingerFile; }, set obsStingerFile(v) { obsStingerFile = v; },
    get wsAuthToken() { return wsAuthToken; }, set wsAuthToken(v) { wsAuthToken = v; }
  });

  require('./backend/http/media')({
    GAMES, app, cloud, cloudLoop, express, fs, fsp, path, serverDir: __dirname, state,
    get dataDir() { return dataDir; }, set dataDir(v) { dataDir = v; }
  });

  require('./backend/http/gsi')({
    DOTA_GSI_TOKEN, GSI_TOKEN, app, handleDotaGsi, handleGsi
  });

  require('./backend/http/startgg')({
    app, broadcastFullState, createStartGgClient, fetchAllEntrants, fetchEventSeeding,
    fetchLeagueInfo, fetchLeagueStandings, fetchMyTournaments, fetchTournamentDetail,
    fetchTournamentSets, lgRecalcServer, mapEntrantsToTeams, normalizeLeagueSlug,
    parseEventSlug, saveAppState, saveTeams, searchStartggLeagues, srvLgUid, state,
    get savedTeams() { return savedTeams; }, set savedTeams(v) { savedTeams = v; },
    get startggApiToken() { return startggApiToken; }, set startggApiToken(v) { startggApiToken = v; }
  });

  require('./backend/http/players-teams')({
    app, applyVaultToLibrary, broadcastFullState, enrichVaultFromStartgg,
    importStartggTeamBySlug, playerDb, propagateVaultCrest, refreshVaultTeamFromStartgg,
    saveAppState, saveTeams, state, teamDb, upsertPlayerProfile, vaultEnrichTargets,
    vaultTouch,
    get savedTeams() { return savedTeams; }, set savedTeams(v) { savedTeams = v; }
  });

  require('./backend/http/public-api')({
    GFX_EXCLUSIVE_VISIBLE, app, applyCompetitionDoc, broadcastFullState, compResolveTeam,
    competition, competitionGoLive, competitionLiveIds, describeSyncReport,
    fetchTournamentEvents, handleControlMessage, lgRecalcServer, loadStartggEventTeams,
    migrateLeague, refreshCompetitionFeed, saveAppState, saveTeams, srvLgUid, state, teamDb,
    vaultTouch,
    get competitionApiKey() { return competitionApiKey; }, set competitionApiKey(v) { competitionApiKey = v; },
    get leaguesVer() { return leaguesVer; }, set leaguesVer(v) { leaguesVer = v; },
    get savedBrandKits() { return savedBrandKits; }, set savedBrandKits(v) { savedBrandKits = v; },
    get savedTeams() { return savedTeams; }, set savedTeams(v) { savedTeams = v; },
    get startggApiToken() { return startggApiToken; }, set startggApiToken(v) { startggApiToken = v; }
  });

  require('./backend/http/challengermode')({
    GAMES, app, challengermodeClient, cmData, createChallengermodeClient,
    fetchChallengermodeTournament, parseChallengermodeId, resolveGameId,
    get challengermodeRefreshKey() { return challengermodeRefreshKey; }, set challengermodeRefreshKey(v) { challengermodeRefreshKey = v; }
  });

  require('./backend/http/brawlhalla')({
    app, brawlhalla, broadcastFullState, challongePartMap, createChallongeClient, saveAppState,
    state,
    get challongeApiKey() { return challongeApiKey; }, set challongeApiKey(v) { challongeApiKey = v; }
  });

  require('./backend/http/tournament-push')({
    app, broadcastFullState, buildChallongeParticipantMap, createChallongeClient,
    createStartGgClient, faceit, fetchAllSets, fetchEntrantTrueSeeds, fetchPageHtml,
    getNxgenEventLive, getNxgenEvents, getNxgenLeaderboard, handleControlMessage,
    resolveChallongeParticipant, saveAppState, setExclusiveGfxVisible, state, vetoImport,
    vetoLoad,
    get challongeApiKey() { return challongeApiKey; }, set challongeApiKey(v) { challongeApiKey = v; },
    get faceitApiKey() { return faceitApiKey; }, set faceitApiKey(v) { faceitApiKey = v; },
    get nxgenApiKey() { return nxgenApiKey; }, set nxgenApiKey(v) { nxgenApiKey = v; },
    get savedTeams() { return savedTeams; }, set savedTeams(v) { savedTeams = v; },
    get startggApiToken() { return startggApiToken; }, set startggApiToken(v) { startggApiToken = v; }
  });

  require('./backend/http/auth')({
    BROADCAST_API_KEY, BROADCAST_REMOTE_URL, ChatParser, DISCORD_CLIENT_ID,
    DISCORD_REDIRECT_URI, MiniGameManager, PredictionManager, TWITCH_CLIENT_ID, TwitchClient,
    WebSocket, WheelManager, app, appPromos, axios, bridgeClients, broadcast,
    broadcastFullState, buildLiveState, chatManager, cloud, coStore, eventSubService, express,
    registerTwitchWebhooks, saveDiscordUser, saveTwitchData, scheduleTokenRefresh, siteHome,
    state, stopPredictionPolling, streamStateManager,
    get _launcherLaunchCb() { return _launcherLaunchCb; }, set _launcherLaunchCb(v) { _launcherLaunchCb = v; },
    get _launcherResizeCb() { return _launcherResizeCb; }, set _launcherResizeCb(v) { _launcherResizeCb = v; },
    get _panelReady() { return _panelReady; }, set _panelReady(v) { _panelReady = v; },
    get _pendingContract() { return _pendingContract; }, set _pendingContract(v) { _pendingContract = v; },
    get _siteHomePulledAt() { return _siteHomePulledAt; }, set _siteHomePulledAt(v) { _siteHomePulledAt = v; },
    get _tokenRefreshGen() { return _tokenRefreshGen; }, set _tokenRefreshGen(v) { _tokenRefreshGen = v; },
    get _tokenRefreshTimer() { return _tokenRefreshTimer; }, set _tokenRefreshTimer(v) { _tokenRefreshTimer = v; },
    get _twitchStatsCache() { return _twitchStatsCache; }, set _twitchStatsCache(v) { _twitchStatsCache = v; },
    get _twitchTokenInvalid() { return _twitchTokenInvalid; }, set _twitchTokenInvalid(v) { _twitchTokenInvalid = v; },
    get chatParser() { return chatParser; }, set chatParser(v) { chatParser = v; },
    get miniGameManager() { return miniGameManager; }, set miniGameManager(v) { miniGameManager = v; },
    get predictionManager() { return predictionManager; }, set predictionManager(v) { predictionManager = v; },
    get twitchClient() { return twitchClient; }, set twitchClient(v) { twitchClient = v; },
    get wheelManager() { return wheelManager; }, set wheelManager(v) { wheelManager = v; }
  });

  require('./backend/http/roles')({
    BROADCAST_API_KEY, BROADCAST_REMOTE_URL, analytics, announceGameResult, app, axios,
    bridgeClients, broadcast, broadcastFullState, buildGameAnnouncement, buildLiveState,
    chatManager, fs, gameTimers, normalizePrediction, path, safeReadJson, safeWriteJson,
    saveTwitchData, startPredictionPolling, state, stopPredictionPolling,
    get discordDataFile() { return discordDataFile; }, set discordDataFile(v) { discordDataFile = v; },
    get marbleRaceManager() { return marbleRaceManager; }, set marbleRaceManager(v) { marbleRaceManager = v; },
    get miniGameManager() { return miniGameManager; }, set miniGameManager(v) { miniGameManager = v; },
    get predictionManager() { return predictionManager; }, set predictionManager(v) { predictionManager = v; },
    get twitchClient() { return twitchClient; }, set twitchClient(v) { twitchClient = v; },
    get wheelManager() { return wheelManager; }, set wheelManager(v) { wheelManager = v; }
  });

  require('./backend/http/twitch-channel')({
    app, bridgeClients, broadcast, broadcastFullState, buildLiveState, chatManager,
    saveTwitchData, state,
    get twitchClient() { return twitchClient; }, set twitchClient(v) { twitchClient = v; }
  });

  require('./backend/http/sponsor-impressions')({
    adProof, adProofCsv, adProofReport, adProofStart, adProofStop, adProofValueMetrics,
    analytics, app, bridgeClients, broadcast, registerTwitchEventSubRoutes, saveAppState,
    saveTwitchData, state,
    get _adProofTimer() { return _adProofTimer; }, set _adProofTimer(v) { _adProofTimer = v; },
    get twitchClient() { return twitchClient; }, set twitchClient(v) { twitchClient = v; }
  });

  // Catch-all for unhandled errors thrown inside route handlers
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[HTTP] Unhandled route error:', err.stack || err.message || err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  });

  httpServer = app.listen(HTTP_PORT, '127.0.0.1', () => {
    console.log(`[HTTP] Overlay at http://localhost:${HTTP_PORT}`);
  });
  // Without this, a bind failure (almost always EADDRINUSE — some other program already has the
  // port) is an unhandled 'error' event: it lands in the process-level uncaughtException handler
  // (writes to crash.log) and the app just keeps running with no working local server — login,
  // overlays and every WS-dependent feature hang forever with zero feedback to the user. Fail
  // loud and quit instead of leaving a silently-broken app open.
  httpServer.on('error', (err) => {
    console.error('[HTTP] Server error:', err);
    if (err && err.code === 'EADDRINUSE') {
      dialog.showErrorBox(
        'Broadcast Studio — Port already in use',
        `Port ${HTTP_PORT} is already being used by another program on this PC, so the app can't start its local server — this is what login and every overlay depend on.\n\nClose whatever else is using port ${HTTP_PORT} (check Task Manager, or run "netstat -ano | findstr :${HTTP_PORT}" in a command prompt) and relaunch Broadcast Studio.`
      );
      _electronApp.quit();
    }
  });
  httpServer.keepAliveTimeout = 2000;
  httpServer.headersTimeout = 3000;

  // IPv6 loopback twin. "localhost" resolves to ::1 FIRST on Windows, and the IPv4-only bind above never
  // answers there — so when any other dev server holds port 3000 on all interfaces (a Next/Vite dev server
  // is the classic one), http://localhost:3000/live.html (or any overlay URL typed with "localhost") is served
  // by THAT program and comes back as its 404 page, while http://127.0.0.1:3000 works. Binding ::1 as well
  // takes precedence over their wildcard listener on the same port (measured), so both spellings reach us.
  // Best-effort only: no IPv6 stack, or ::1 already taken, must never stop the app — IPv4 is the real listener.
  try {
    httpServer6 = require('http').createServer(app);
    httpServer6.on('error', (err) => {
      console.warn('[HTTP] IPv6 loopback listener unavailable (' + (err && err.code || err) + ') — use http://127.0.0.1:' + HTTP_PORT + ' if "localhost" misbehaves.');
      try { httpServer6.close(); } catch (e) {}
      httpServer6 = null;
    });
    httpServer6.keepAliveTimeout = 2000;
    httpServer6.headersTimeout = 3000;
    httpServer6.listen(HTTP_PORT, '::1');
  } catch (e) { httpServer6 = null; }
}

// ─── Start ───────────────────────────────────────────────────────────────────
// ── Boot profiler ─────────────────────────────────────────────────────────────
// "Taking forever to launch" is impossible to diagnose after the fact: the launcher window just
// sits there and nothing is written down. Every start() stage stamps its elapsed ms here, and the
// table is printed AND appended to data/boot-timing.log so a slow launch can be read back later.
// Cost is a Date.now() per stage.
const _bootMarks = [];
let _bootT0 = Date.now();
let _bootLast = _bootT0;
function bootMark(label) {
  const now = Date.now();
  _bootMarks.push({ label, ms: now - _bootLast, at: now - _bootT0 });
  _bootLast = now;
}
function bootReport(tag) {
  try {
    const slow = _bootMarks.filter((m) => m.ms >= 100).sort((a, b) => b.ms - a.ms);
    const total = Date.now() - _bootT0;
    const lines = _bootMarks.map((m) => `  ${String(m.ms).padStart(6)}ms  +${String(m.at).padStart(6)}ms  ${m.label}`);
    const head = `[Boot] ${tag} total ${total}ms` + (slow.length
      ? ` — slowest: ${slow.slice(0, 3).map((m) => m.label + ' ' + m.ms + 'ms').join(', ')}`
      : '');
    console.log(head);
    lines.forEach((l) => console.log(l));
    if (dataDir) {
      fs.appendFile(path.join(dataDir, 'boot-timing.log'),
        [new Date().toISOString() + '  ' + head, ...lines, ''].join('\n') + '\n',
        () => {});
    }
  } catch (e) { /* diagnostics must never break the boot they measure */ }
}

module.exports.start = function(baseDir) {
  appDir = baseDir || __dirname;

  // Data paths — use userData so teams survive portable exe relocation
  const userData = _electronApp.getPath('userData');
  dataDir   = path.join(userData, 'data');
  showTimeline.setDir(dataDir);
  tl('app.start', { version: appVersion });
  teamsFile = path.join(dataDir, 'teams.json');
  stateFile = path.join(dataDir, 'state.json');
  facecamsFile = path.join(dataDir, 'facecams.json');
  presetsFile = path.join(dataDir, 'presets.json');
  brandsFile = path.join(dataDir, 'brands.json');
  twitchDataFile  = path.join(dataDir, 'twitch-data.json');
  discordDataFile = path.join(dataDir, 'discord-user.json');
  multichatDataFile = path.join(dataDir, 'multichat-data.json');
  questionsDataFile = path.join(dataDir, 'questions-data.json');
  wsTokenFile     = path.join(dataDir, 'ws-token.json');

  fs.mkdirSync(dataDir, { recursive: true });
  bootMark('mkdir data');
  wsAuthToken = getOrCreateWsToken();
  stats.init(dataDir);
  bootMark('stats.init (stats.json + sqlite mirror kickoff)');
  analytics.init({
    dataDir, getState: () => state, broadcast, bridgeClients,
    // Proof of play follows the broadcast: a session starting (by hand or from the Twitch live
    // signal) starts the sponsor tracker, and stopping it saves the sponsor report.
    onStart: (label) => { if (!adProof.active) adProofStart(label); },
    onStop: () => adProofStop()
  });
  bootMark('analytics.init');
  playerDb.init(dataDir);
  bootMark('playerDb.init');
  teamDb.init(dataDir);
  bootMark('teamDb.init');
  // Cross-platform, so instantiated unconditionally (unlike miniGameManager, which is only created
  // once Twitch connects — see below) — a producer with only Kick or only YouTube connected can still
  // run a marble race (auto-enter-viewers just won't have anything to pull without Twitch).
  bootMark('marbleRaceManager');
  marbleRaceManager = new MarbleRaceManager(state, {
    fetchAutoEntrants: async () => {
      if (!state.twitch.apiToken || !state.twitch.channelId) return { ok: false, error: 'Twitch not connected' };
      const r = await fetchTwitchChatters({ clientId: TWITCH_CLIENT_ID, accessToken: state.twitch.apiToken, broadcasterId: state.twitch.channelId });
      if (!r.ok) return r;
      return { ok: true, entrants: r.chatters.map((c) => ({ platform: 'twitch', userId: c.userId, username: c.username, source: 'auto' })) };
    }
  });

  // Seed state.playerProfiles from the persistent player DB — playerDb survives event resets
  // while state.json doesn't. Merge: state.json wins on conflicts (it's the current session).
  {
    const dbMap = playerDb.toProfilesMap();
    if (!state.playerProfiles) state.playerProfiles = {};
    for (const [key, rec] of Object.entries(dbMap)) {
      const existing = state.playerProfiles[key];
      if (!existing || (rec.updatedAt && (!existing.updatedAt || rec.updatedAt > existing.updatedAt))) {
        state.playerProfiles[key] = { ...rec, ...existing };
      }
    }
  }

  // Social publisher — init with userData so tokens persist across restarts
  socialPublisher = new SocialPublisher(userData, {
    GOOGLE_CLIENT_ID:     process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    TWITTER_CLIENT_ID:    process.env.TWITTER_CLIENT_ID,
    TWITTER_CLIENT_SECRET: process.env.TWITTER_CLIENT_SECRET
  });
  socialPublisher.startScheduler(post => {
    broadcast(bridgeClients, { type: 'social_published', data: post });
  });

  // Weekly clip automation. Everything it needs from the outside world is injected, so the run
  // logic stays testable without a Twitch token: clip fetching goes through twitchClient, naming
  // goes through the SAME core the control panel uses (so an unattended run titles clips exactly
  // the way the producer saw it do on-screen), and results come back out as WS events.
  bootMark('social publisher');   // the weekly-clip automation it used to also start was removed

  // YouTube Live Chat → the multichat feed. Same pipeline as Twitch IRC: broadcast a
  // per-message frame + append to the rolling _chatLog for panel backfill. Reuses the
  // Social YouTube OAuth client (_ytClient auto-refreshes tokens); idles when not
  // connected or not live, so it's free to always start.
  let _googleApi = null;
  try { ({ google: _googleApi } = require('googleapis')); } catch (e) { console.warn('[yt-chat] googleapis not installed'); }
  youtubeChat = createYouTubeChat({
    google: _googleApi,
    getAuthClient: () => socialPublisher._ytClient(),
    onMessage: (m) => {
      broadcast(bridgeClients, {
        type: 'youtube_chat_message',
        data: { username: m.user, message: m.text, color: m.color, timestamp: new Date().toISOString() }
      });
      _chatLog.push({ platform: 'youtube', user: m.user, text: m.text, color: m.color, ts: m.ts });
      if (_chatLog.length > 100) _chatLog.shift();
      captureQuestionFromChat('youtube', m.user, m.text);
      // No stable user id in YouTube's chat payload — use the (lowercased) username itself as the id;
      // tryEnterMarbleRace already prefixes it with the platform, so this stays unique per-platform.
      tryEnterMarbleRace('youtube', String(m.user || '').toLowerCase(), m.user, m.text);
    },
    onStatus: (connected, detail) => {
      console.log(`[yt-chat] ${connected ? 'connected' : 'idle'}${detail ? ' — ' + detail : ''}`);
      broadcast(bridgeClients, { type: 'youtube_chat_status', data: { connected, detail } });
    }
  });
  youtubeChat.start();
  bootMark('googleapis require + youtube chat');

  // Kick + Discord multichat sources — same message pipeline as Twitch/YouTube.
  loadMultichatData();
  loadQuestionsData();   // before discordChat: its getConfig reads the questions channel
  kickChat = createKickChat({
    getChannel: () => state.multichat.kickChannel,
    onMessage: (m) => {
      broadcast(bridgeClients, { type: 'kick_chat_message', data: { username: m.user, message: m.text, color: m.color, timestamp: new Date().toISOString() } });
      _chatLog.push({ platform: 'kick', user: m.user, text: m.text, color: m.color, ts: m.ts });
      if (_chatLog.length > 100) _chatLog.shift();
      captureQuestionFromChat('kick', m.user, m.text);
      // No stable user id in Kick's chat payload either — same lowercased-username keying as YouTube.
      tryEnterMarbleRace('kick', String(m.user || '').toLowerCase(), m.user, m.text);
    },
    onStatus: (connected, detail) => { console.log(`[kick-chat] ${connected ? 'connected' : 'idle'}${detail ? ' — ' + detail : ''}`); broadcast(bridgeClients, { type: 'kick_chat_status', data: { connected, detail } }); }
  });
  discordChat = createDiscordChat({
    getConfig: () => ({
      botToken: state.multichat.discordBotToken,
      channelId: state.multichat.discordChannelId,
      questionChannelId: state.questions.settings.discordChannelId   // dedicated #questions channel
    }),
    onMessage: (m) => {
      // The questions channel never enters the chat feed — every message there IS a question.
      if (m.kind === 'question') {
        if (questionStore.addQuestion(state.questions.list, { source: 'discord', user: m.user, text: m.text, ts: m.ts, ref: m.ref, origin: 'discord' })) {
          questionsChanged();
        }
        return;
      }
      broadcast(bridgeClients, { type: 'discord_chat_message', data: { username: m.user, message: m.text, color: m.color, timestamp: new Date().toISOString() } });
      _chatLog.push({ platform: 'discord', user: m.user, text: m.text, color: m.color, ts: m.ts });
      if (_chatLog.length > 100) _chatLog.shift();
      captureQuestionFromChat('discord', m.user, m.text);
    },
    onStatus: (connected, detail) => { console.log(`[discord-chat] ${connected ? 'connected' : 'idle'}${detail ? ' — ' + detail : ''}`); broadcast(bridgeClients, { type: 'discord_chat_status', data: { connected, detail } }); }
  });
  kickChat.start();
  discordChat.start();
  bootMark('kick + discord chat');
  loadTeams();
  bootMark('loadTeams');
  loadState();
  bootMark('loadState');
  try { lanSeatsSync(); lanAgentApply(); } catch (e) { console.warn('[lan seats] init failed:', e.message); }
  try { refreshCompetitionFeed(); } catch (e) { console.warn('[competition] initial feed build failed:', e.message); }
  startCompetitionSyncLoop();
  // Self-heal placeholder side colours against the active game's palette (see the function's note).
  applyGameDefaultSideColors();
  try { applySheetsAutoSync(); } catch (e) { /* resume Google Sheets auto-sync if it was on */ }
  // Re-join the desk lineup against the crew/library so slots carry the current gamertag
  // (the persisted list is a snapshot; without this, a relaunch keeps stale display names).
  try { resolveLineupToList(); } catch (e) { /* no lineup yet */ }
  resetRlGameTrack();
  loadFacecams();
  loadPresets();
  loadBrandKits();
  bootMark('loadBrandKits');
  syncActivePreshowTopics();   // Desk Show headline/topics come from the active kit/package, not the save file
  loadTwitchData();
  loadDiscordUser();
  initFlowEngine();
  bootMark('initFlowEngine');
  // Resume Ballchasing auto-upload folder watching if it was left enabled.
  try { syncBallchasingAutoUpload(); } catch (e) { console.warn('[Ballchasing] auto-upload resume skipped:', e.message); }
  // Resume LoL champ-select automation if it was left on.
  if (state.draft && state.draft.auto && state.draft.auto.enabled) { try { startLolDraftAuto(); } catch (e) {} }
  // Nameless cloud client — dormant unless BROADCAST_REMOTE_URL is configured.
  try { cloud.init({ baseUrl: BROADCAST_REMOTE_URL, dataDir, appVersion }); } catch (e) { console.warn('[Cloud] init skipped:', e.message); }
  // Access enforcement: re-validate the cloud session shortly after boot (catches a
  // revoked user relaunching, during the launcher's load) and every 10 minutes while
  // running. Signs out ONLY on a definitive backend refusal — see validateCloudSession.
  setTimeout(() => { validateCloudSession('boot'); }, 2500);
  cloudLoop('session', () => validateCloudSession('periodic'), 10 * 60 * 1000);

  // Initialize Twitch integration if API token is configured
  if (state.twitch.apiToken) {
    // Validate token on startup; silently refresh if expired, then schedule proactive refresh
    scheduleTokenRefresh();

    twitchClient = new TwitchClient(TWITCH_CLIENT_ID, null, state.twitch.apiToken);
    if (state.twitch.channelId) {
      predictionManager = new PredictionManager(twitchClient, state.twitch.channelId);
      wheelManager = new WheelManager(state);
      miniGameManager = new MiniGameManager(state);
      chatParser = new ChatParser(miniGameManager);
      state.twitch.connected = true;
      streamStateManager.startPolling();
      chatManager.connect(state.twitch.displayName, state.twitch.apiToken).catch(err =>
        console.error('[IRC auto-connect]', err.message)
      );
      // Re-open the EventSub WebSocket so live events resume after a restart.
      try { eventSubService.start(); } catch (e) { console.error('[EventSub] start failed:', e.message); }
      console.log('[Twitch] Initialized (predictions, wheel, minigames, chat parsing, EventSub enabled)');
    }
  }

  bootMark('pre-listen work done');
  startHttpServer(appDir);
  bootMark('startHttpServer (launcher can reach us from here)');
  startBridgeServer();
  bootMark('startBridgeServer');
  connectToRL();
  if (state.activeGame === 'valorant') startValorantWatchdog();
  if (state.activeGame === 'league') startLolPolling();
  if (state.activeGame === 'apex') startApexServer();
  startResourceWatchdog();

  // Connect to OBS if it was enabled previously
  if (state.obs.enabled && obsClientFactory()) {
    setupObsClient();
    connectObs();
  }

  // Re-load the bracket on startup if one was configured
  if (state.bracket.eventSlug && startggApiToken) {
    fetchBracket(state.bracket.eventSlug).catch((e) => {
      state.bracket.lastError = e.message;
    });
  }

  // Keep saved My Events fresh from start.gg (entrants / teams / players / seeds) in the background.
  startMyEventsAutoSync();
  // Refresh the single-team spotlight's start.gg data while it's live.
  startTeamSpotlightAutoSync();

  if (state.startgg.queueEnabled && startggApiToken && state.startgg.tournamentSlug) {
    setStartggQueuePolling(true);
  }
  // Enforce single-active-platform on boot too: if a tournament platform was the active event last
  // session, make sure the other platforms' auto-follow didn't survive in the saved state and start
  // fighting it after restart.
  if (state.activeEvent && state.activeEvent.platform) setActivePlatform(state.activeEvent.platform);
  // …and RESUME the active platform's own polling. start.gg has its resume just above; NXGEN had
  // none, so a restart left a linked NXGEN event permanently dead: queue, matchFeed and connected
  // are all transient (never saved), and nothing refetched them — the ticker stayed empty with the
  // event still showing as linked.
  if (state.activeEvent && state.activeEvent.platform === 'nxgen' && nxgenApiKey && (state.nxgen.eventSlug || '').trim()) {
    state.nxgen.enabled = true;
    setNxgenPolling(true);
  }
  // Challengermode's queue, feed and placements are transient too — without this a restart leaves
  // a loaded tournament showing as linked with an empty bracket until someone presses Refresh.
  if (state.activeEvent && state.activeEvent.platform === 'challengermode'
      && challengermodeRefreshKey && (state.challengermode.tournamentId || '').trim()) {
    state.challengermode.enabled = true;
    setChallengermodePolling(true);
  }


  // AI training-data recorder (Phase 0 — local JSONL of producer decisions + context).
  telemetry = createTelemetryRecorder({
    dataDir,
    appVersion,
    getContext: buildTelemetryContext,
    // producerId prefers the cloud account; falls back to a stable per-install id.
    getIdentity: () => {
      let s = {}; try { s = cloud.getSession() || {}; } catch (_) {}
      return { producerId: (s.user && s.user.discordId) || null, workspaceId: s.workspaceId || null };
    },
  });
  telemetry.setEnabled(state.ai?.telemetry?.enabled !== false);

  // AI training-data uploader (Phase 2 — opt-in batch upload of the local JSONL above to the
  // shared cloud dataset). Same fire-and-forget/busy-flag/silent-retry shape as cameraFacecamAutoSync
  // (server.js:~2281) — gated on cloud.authed() + the separate uploadEnabled toggle (never runs off
  // of just "local recording enabled"). 60s cadence: this is non-urgent training data, not live state.
  _telemetryUploader = createTelemetryUploader({ dataDir });
  cloudLoop('telemetry', () => telemetryAutoSync(), 60000);

  // Event loaded before event logos were tracked: look its start.gg logo up once.
  if (state.activeEvent && state.activeEvent.platform === 'startgg' && state.activeEvent.slug && !state.activeEvent.logo) {
    const _evSlug = state.activeEvent.slug;
    setTimeout(() => fetchStartggEventImage(_evSlug).then((img) => {
      if (!img || state.activeEvent.slug !== _evSlug || state.activeEvent.logo) return;
      state.activeEvent.logo = img; saveAppState(); broadcastFullState();
    }), 4000);
  }

  // CS2 scripted freezetime camera: reconnect to the CS2 console if it was left enabled.
  try { csCinematicApply(); } catch (e) { console.error('[CS2 cinematic] start failed:', e.message); }

  // AI Auto-Director + clip system
  directorEngine = createDirectorEngine({
    dataDir,
    getActiveGame: () => state.activeGame,
    getBroadcastState: () => state,
    onEvents: onDirectorEvents,
    onPrimaryChange: (out) => {
      // Shadow stream: log what the engine WANTED, whenever the primary target changes,
      // regardless of whether auto-switch is on. Reset the latency clock for the next decision.
      if (out.primary && out.primary.target?.id !== _lastRecTargetId) {
        _lastRecTargetId = out.primary.target?.id || null;
        _directorRecShownAt = Date.now();
        if (telemetry) telemetry.recommendation({ recommendation: currentDirectorRec(), autoActed: !!out.autoSwitch });
      }
      if (!out.autoSwitch || !out.primary || aiShielded()) return;   // shield blocks the action
      // Keyboard observer-slot switching (CS2 only). RL in-game camera control was removed.
      const result = autoSwitch.trySwitch({
        gameId: state.activeGame,
        primary: out.primary,
        gameState: getDirectorGameState()
      });
      if (result.ok) {
        state.director.lastAutoSwitch = { at: Date.now(), target: result.target, key: result.key };
        try { analytics.event('auto_switch'); } catch (e) {}
        broadcastDirectorUpdate();
      }
    },
    onUpdate: (out) => {
      state.director = mergeDirectorRuntime(out);
      broadcastDirectorUpdate();
    }
  });
  if (state.director) {
    directorEngine.setSettings({
      enabled: state.director.enabled,
      sensitivity: state.director.sensitivity,
      autoSwitch: state.director.autoSwitch
    });
    autoSwitch.setEnabled(!!state.director.autoSwitch);
    state.director = mergeDirectorRuntime(directorEngine.getState());
  }

  clipSystem = createClipSystem({
    dataDir,
    getObsClient: () => obsClient,
    onUpdate: () => {
      syncClipsState();   // keeps captureMode / autoMontage — a bare getState() copy reset them to manual
      broadcastClipsUpdate();
    },
    onEncodeProgress: (progress) => {
      state.encode = progress;
      broadcast(bridgeClients, { type: 'encode_progress', data: progress });
      if (onEncodeProgressCallback) onEncodeProgressCallback(progress);
    }
  });
  syncClipsState();
  bootMark('clip system');
  bootReport('server.start()');
};

// ─── Resource Watchdog ───────────────────────────────────────────────────────
const CPU_WARN_PERCENT = 80;
const RAM_WARN_MB = 1500;
// Only warn on SUSTAINED pressure, and rarely — otherwise any busy stretch (encode, startup, a brief
// CPU spike) spammed a fresh notification every 10s. Require several consecutive high samples, then
// stay quiet for a long cooldown before warning again.
const WARN_SUSTAIN_SAMPLES = 3;             // ~30s continuously high before the first warning
const WARN_COOLDOWN_MS = 15 * 60 * 1000;    // at most one warning per 15 minutes

let _watchdogInterval = null;

function startResourceWatchdog() {
  let lastCpu = process.cpuUsage();
  let lastTs = process.hrtime.bigint();
  let highStreak = 0;
  let lastWarnAt = 0;

  _watchdogInterval = setInterval(() => {
    const now = process.hrtime.bigint();
    const cur = process.cpuUsage();
    const elapsedUs = Number(now - lastTs) / 1000;
    const cpuPercent = Math.round(
      (cur.user - lastCpu.user + cur.system - lastCpu.system) / elapsedUs * 100
    );
    lastCpu = cur;
    lastTs = now;

    if (state.perfMode && state.perfMode.resourceWarnings === false) { highStreak = 0; return; }   // alerts turned off in Settings
    const ramMb = Math.round(process.memoryUsage().rss / 1048576);
    const high = cpuPercent >= CPU_WARN_PERCENT || ramMb >= RAM_WARN_MB;
    if (!high) { highStreak = 0; return; }   // recovered → reset (a fresh sustained run must build up again)
    highStreak++;
    if (highStreak < WARN_SUSTAIN_SAMPLES) return;          // ignore transient spikes
    if (Date.now() - lastWarnAt < WARN_COOLDOWN_MS) return; // already warned recently
    lastWarnAt = Date.now();
    broadcast(bridgeClients, { type: 'resource_warning', data: { cpu: cpuPercent, ramMb } });
  }, 10000);
}

// ─── Twitch: EventSub, stream state, chat, clips (backend/twitch/services.js) ───────────────
const {
  eventSubService,
  streamStateManager,
  _chatLog,
  chatManager,
  showChatHighlight,
  captureQuestionFromChat,
  registerTwitchEventSubRoutes
} = require('./backend/twitch/services')({
    get obsClient() { return obsClient; },
    get twitchClient() { return twitchClient; },
    get socialPublisher() { return socialPublisher; },
    get youtubeChat() { return youtubeChat; },
    get predictionManager() { return predictionManager; },
    get miniGameManager() { return miniGameManager; },
    get chatParser() { return chatParser; },
    get clipSystem() { return clipSystem; },
    get bridgeClients() { return bridgeClients; },
    get gameTimers() { return gameTimers; },
    get _twitchTokenInvalid() { return _twitchTokenInvalid; },
    setTwitchTokenInvalid(v) { _twitchTokenInvalid = v; },
    state, cloud, questionStore, analytics, tryEnterMarbleRace, TWITCH_CLIENT_ID, questionsChanged, saveTwitchData, refreshTwitchToken, currentViewers, chatCommandReply, broadcast, buildLiveState, broadcastClipsUpdate, syncClipsState, flowBus, normalizePrediction, normalizePoll, _logActivity, announceGameResult, stopPredictionPolling, broadcastFullState, triggerClipCapture, replayBufferErrorMessage, switcherIsVmix, vmixMarkReplay
});


// ─── Graceful Shutdown ───────────────────────────────────────────────────────
module.exports.shutdown = function () {
  stopValorantWatchdog();
  if (_watchdogInterval) { clearInterval(_watchdogInterval); _watchdogInterval = null; }
  if (_bridgeHeartbeat) { clearInterval(_bridgeHeartbeat); _bridgeHeartbeat = null; }
  if (_bcTimer) { clearTimeout(_bcTimer); _bcTimer = null; }
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (rlReconnectTimer) { clearTimeout(rlReconnectTimer); rlReconnectTimer = null; }
  if (rlSocket) { try { rlSocket.destroy(); } catch (e) { /* ignore */ } rlSocket = null; }

  for (const client of bridgeClients) {
    try { client.terminate(); } catch (e) { /* ignore */ }
  }
  bridgeClients.clear();

  if (bridgeWss) { bridgeWss.close(() => {}); bridgeWss = null; }
  if (bridgeHttp6) { try { bridgeHttp6.close(() => {}); } catch (e) {} bridgeHttp6 = null; }
  if (httpServer) { httpServer.close(() => {}); httpServer = null; }
  if (httpServer6) { try { httpServer6.close(() => {}); } catch (e) {} httpServer6 = null; }

  try { flushBrandKitsSave(); } catch (e) { /* ignore */ }     // a deferred Desk Show topic edit must not die with the app
  try { _saveAppStateNow(true); } catch (e) { /* ignore */ }   // sync flush so the write completes before exit
  try { saveQuestionsData(true); } catch (e) { /* ignore */ }  // Q&A queue lives in its own file
  stats.close();
  playerDb.close();
  teamDb.close();
};

// Test hook: run the real restore against a state file (test/loadstate-restore.test.js).
// Brand-kit style rules (test/brand-styles.test.js): what activating / importing may change.
module.exports._testBrandStyles = { applyKitStyles, applyPackageSnapshot, applyProfileBundle, getState: () => state };
module.exports._testSaveSnapshot = () => JSON.parse(JSON.stringify(buildSaveSnapshot()));
module.exports._testLoadState = function (file) { stateFile = file; _stateLoadAbort = null; loadState(); return { state, abort: _stateLoadAbort }; };

module.exports.broadcastCrashAlert = function (message) {
  broadcast(bridgeClients, { type: 'crash_alert', data: { message } });
};

module.exports.setEncodeProgressCallback = function (cb) {
  onEncodeProgressCallback = cb;
};

// Launcher window handoff: main.js registers how to swap launcher → studio window;
// the launcher page POSTs /api/launcher/launch when auth + load animation are done.
module.exports.setLauncherLaunchCallback = function (cb) {
  _launcherLaunchCb = cb;
};

module.exports.setLauncherResizeCallback = function (cb) {
  _launcherResizeCb = cb;
};

// Game performance mode: main.js lowers/restores every app process's priority here.
module.exports.setPerfPriorityCallback = function (cb) {
  _perfPriorityCb = cb;
};

// Set by main.js when the control panel's renderer finishes loading — the launcher polls for it
// so its load animation ends when the studio is genuinely ready instead of after a fixed sleep.
let _panelReady = false;
module.exports.markPanelReady = function () { _panelReady = true; };
// Rewrites every file that holds secrets (the server's own process calls this once new secrets have
// their keychain form; see backend/electron-api.js).
module.exports.resaveSecrets = function () {
  saveAppState(); saveTwitchData(); saveDiscordUser(); saveMultichatData();
};

module.exports.setRlSpectatorUiHotkeyChangeCallback = function (cb) {
  onRlSpectatorUiHotkeyChange = cb;
};

// Auto-update bridge (driven by main.js / electron-updater).
module.exports.setUpdateHandlers = function (handlers) {
  _updateHandlers = handlers || null;
};
module.exports.broadcastUpdateStatus = function (status) {
  _lastUpdateStatus = status || null;
  broadcast(bridgeClients, { type: 'update_status', data: _lastUpdateStatus });
};

module.exports.getRlSpectatorUiConfig = function () {
  return state.rlSpectatorUi || rlSpectatorUi.DEFAULTS;
};

module.exports.hideRlNativeUi = function () {
  return triggerRlHideNativeUi();
};

// ── Panel message handlers that live in backend/ws/ (registered last: every declaration above has run) ──
registerWsHandlers(require('./backend/ws/battle-royale')({
  BR_DEFAULT_MODE, BR_SCORING_PRESETS, BR_TEAM_FORMATS, GAMES, HTTP_PORT, apexLive,
  brApplyScoringPreset, brBinding, brFormatSize, brMergeLobby, brModeMeta, brModesFor,
  brNameFromPlayers, brNewMatrixId, brNewSeries, brResolveSeries, brSyncFromLeague,
  brWriteSheetTemplate, broadcastFullState, computeBrStandings, createStartGgClient,
  fetchAllEntrants, findMatrix, isLobbyGame, logAuto, mapEntrantsToTeams, matrixToScoring,
  obsAppName, parseEventSlug, recomputeApexBroadcast, recomputeBrSeason, sanitizeBrEntrant,
  sanitizePointMatrix, saveAppState, sendWs, setExclusiveGfxVisible, state,
  get _apexAcc() { return _apexAcc; }, set _apexAcc(v) { _apexAcc = v; },
  get _apexGamesSig() { return _apexGamesSig; }, set _apexGamesSig(v) { _apexGamesSig = v; },
  get gameConfigsVer() { return gameConfigsVer; }, set gameConfigsVer(v) { gameConfigsVer = v; },
  get leaguesVer() { return leaguesVer; }, set leaguesVer(v) { leaguesVer = v; },
  get obsClient() { return obsClient; }, set obsClient(v) { obsClient = v; },
  get startggApiToken() { return startggApiToken; }, set startggApiToken(v) { startggApiToken = v; }
}));
registerWsHandlers(require('./backend/ws/cs2')({
  broadcastCsgo, broadcastFullState, cleanRadarLayout, cs2Cinematic, cs2Netcon, cs2Setup,
  csCinematicApply, electronApi, installGsiConfig, installSpectatorCfg, saveAppState, state,
  get _csHudSpec() { return _csHudSpec; }, set _csHudSpec(v) { _csHudSpec = v; }
}));
registerWsHandlers(require('./backend/ws/dota')({
  DOTA_GSI_TOKEN, HTTP_PORT, broadcastFullState, cs2Setup, dotaGsi, electronApi, saveAppState,
  state,
  get _dotaFirstPick() { return _dotaFirstPick; }, set _dotaFirstPick(v) { _dotaFirstPick = v; }
}));
registerWsHandlers(require('./backend/ws/lol')({
  bridgeClients, broadcast, broadcastFullState, broadcastLol, lolOcr, lolOcrConfigure,
  saveAppState, startLolDraftAuto, startLolOcr, state, stopLolDraftAuto, stopLolOcr,
  get _lolPollTimer() { return _lolPollTimer; }, set _lolPollTimer(v) { _lolPollTimer = v; }
}));
registerWsHandlers(require('./backend/ws/fgc')({
  BH_REGIONS, broadcastFullState, checkBrawlhallaGameOver, checkSmashGameOver,
  normalizeTokonLayout, refillBrawlhallaStocks, refreshBrawlhallaCard, refreshBrawlhallaCards,
  resizeSmashSides, saveAppState, setSmashMode, state,
  get _bhGameClosed() { return _bhGameClosed; }, set _bhGameClosed(v) { _bhGameClosed = v; },
  get _smashGameClosed() { return _smashGameClosed; }, set _smashGameClosed(v) { _smashGameClosed = v; }
}));
registerWsHandlers(require('./backend/ws/other-games')({
  broadcastFullState, saveAppState, state,
  get bedwarsToken() { return bedwarsToken; }, set bedwarsToken(v) { bedwarsToken = v; }
}));
registerWsHandlers(require('./backend/ws/rocket-league')({
  autoSwitch, bridgeClients, broadcast, broadcastDirectorUpdate, broadcastFullState,
  clearPostGameBoard, logAuto, mergeDirectorRuntime, recordDirectorDecision, rlSpectatorUi,
  sanitizeWorldsSidebar, saveAppState, scoreboardRoster, sendRlCommand, state,
  triggerClipCapture, triggerRlHideNativeUi,
  get _boardShownAt() { return _boardShownAt; }, set _boardShownAt(v) { _boardShownAt = v; },
  get directorEngine() { return directorEngine; }, set directorEngine(v) { directorEngine = v; },
  get onRlSpectatorUiHotkeyChange() { return onRlSpectatorUiHotkeyChange; }, set onRlSpectatorUiHotkeyChange(v) { onRlSpectatorUiHotkeyChange = v; },
  get telemetry() { return telemetry; }, set telemetry(v) { telemetry = v; }
}));
registerWsHandlers(require('./backend/ws/switcher')({
  OBS_RB_OFF_MSG, VMIX_REPLAY_SECONDS, WS_HANDLERS, airPlayableUrl, bridgeClients, broadcast,
  broadcastFullState, clearBreakAutoSwitch, connectObs, disconnectObs, endCommercial,
  filterSwitchableScenes, fs, obsAppIsStreamlabs, obsAppName, obsClientFactory, obsPlace,
  pollObsPreview, pollVmix, probeVideoInfo, replayBufferErrorMessage, replayUrlToPath,
  saveAppState, setupObsClient, startCommercial, state, switcherAudioSet, switcherCut,
  switcherFtb, switcherIsVmix, switcherRecord, switcherReplay, switcherSetPreview,
  switcherStream, switcherTake, syncReplayBufferAvailability, tagObsSwitch, tl, vmix, vmixApi,
  vmixDo, vmixMarkReplay, vmixPlace, willAirPrep,
  get _manualCutSeq() { return _manualCutSeq; }, set _manualCutSeq(v) { _manualCutSeq = v; },
  get _postGameTimer() { return _postGameTimer; }, set _postGameTimer(v) { _postGameTimer = v; },
  get _switcherWatching() { return _switcherWatching; }, set _switcherWatching(v) { _switcherWatching = v; },
  get clipSystem() { return clipSystem; }, set clipSystem(v) { clipSystem = v; },
  get obsClient() { return obsClient; }, set obsClient(v) { obsClient = v; },
  get obsPassword() { return obsPassword; }, set obsPassword(v) { obsPassword = v; },
  get obsStingerFile() { return obsStingerFile; }, set obsStingerFile(v) { obsStingerFile = v; },
  get slobsToken() { return slobsToken; }, set slobsToken(v) { slobsToken = v; }
}));
registerWsHandlers(require('./backend/ws/talent')({
  VDO_CRED_STRIP, broadcastFullState, buildCasterJoinUrlFromVdo, buildCasterObsUrl,
  buildCasterObsUrlFromVdo, buildListenInUrl, buildObsViewUrl, buildPlayerInterviewViewUrl,
  buildRoomListenInUrl, cleanFacecamId, clearDeskSlots, crewGamertagFor, dedupeSupport,
  deskLineupPeople, deskSlotNames, effectiveTeamColors, ensureCasterVdo, ensureGuestsVdo,
  ensureInterviewVdo, ensureObserversVdo, ensureRoomVdo, ensureTeamVdo, findTeamPlayer,
  obsSwitch, playerStreamId, resolveLineupToList, sanitizeVdoAudio, saveAppState, saveFacecams,
  saveTeams, seatDeskSlots, state, stationAutoSync, suppressAutoFill, syncCrewRosterToCloud,
  unsuppressAutoFill, vdoBase, vdoRandom, vdoSlug, wsSend,
  get savedFacecams() { return savedFacecams; }, set savedFacecams(v) { savedFacecams = v; },
  get savedTeams() { return savedTeams; }, set savedTeams(v) { savedTeams = v; }
}));
registerWsHandlers(require('./backend/ws/clips')({
  _electronApp, broadcastClipsUpdate, dialog, fs, fsp, maybeAutoMontage, os, path,
  saveAppState, state, syncClipsState, triggerClipCapture,
  get clipSystem() { return clipSystem; }, set clipSystem(v) { clipSystem = v; },
  get telemetry() { return telemetry; }, set telemetry(v) { telemetry = v; }
}));
registerWsHandlers(require('./backend/ws/flows')({
  _evalCondition, _flowSeqState, _substituteTokens, _syncFlowIntervals, broadcastFullState,
  flowBus, saveAppState, state
}));
registerWsHandlers(require('./backend/ws/chat')({
  _chatLog, broadcastFullState, electronApi, fetchDiscordMessages, finalizeVod, matchTitle,
  questionStore, questionsChanged, resetTwitchAutoTitle, saveAppState, saveMultichatData,
  showChatHighlight, state,
  get _mtPendingSince() { return _mtPendingSince; }, set _mtPendingSince(v) { _mtPendingSince = v; },
  get _mtPreviewKey() { return _mtPreviewKey; }, set _mtPreviewKey(v) { _mtPreviewKey = v; },
  get discordChat() { return discordChat; }, set discordChat(v) { discordChat = v; },
  get kickChat() { return kickChat; }, set kickChat(v) { kickChat = v; }
}));
registerWsHandlers(require('./backend/ws/cloud')({
  AdmZip, applyProfileBundle, broadcastFullState, buildLeaguePushPayload, buildProfileBundle,
  cloud, deskRoomVdo, dialog, extractAssetsToZip, fsp, inflateAssetsFromZip, mergePulledLeague,
  pullOrgLibrary, pushProfileNow, saveAppState, saveDiscordUser, sendImportExportResult,
  sendStationsFull, state, syncCrewRosterToCloud, syncProfileToCloud, vdoRandom,
  get leaguesVer() { return leaguesVer; }, set leaguesVer(v) { leaguesVer = v; }
}));
registerWsHandlers(require('./backend/ws/ballchasing')({
  REPLAY_RENAME_TOLERANCE_MS, bcAggregateGroupIntoLeague, bcApplyMvpCounts, bcSyncMvps,
  bcUploadReplays, bcUploadReplaysDetailed, broadcastFullState, createBallchasingClient,
  dialog, logAuto, saveAppState, scanAndRenameReplays, state, stats, syncBallchasingAutoUpload,
  get ballchasingApiKey() { return ballchasingApiKey; }, set ballchasingApiKey(v) { ballchasingApiKey = v; },
  get leaguesVer() { return leaguesVer; }, set leaguesVer(v) { leaguesVer = v; }
}));
registerWsHandlers(require('./backend/ws/startgg')({
  _logSerializeFailure, activateStartggEvent, activePlatformSets, applyStartggAutomation,
  broadcastFullState, buildEventUpcomingExtras, createStartGgClient, ensureOnAirLiveInFeed,
  fetchAllEntrants, fetchStreamQueue, fetchTeamQueue, fetchTournamentEvents, formatTickerFeed,
  importStartggTeams, loadStartggEventTeams, mapEntrantsToTeams, parseEventSlug,
  parseStartggInput, platformRoundLabel, refreshAllMyEvents, resetAutoFollowHold,
  resolveStartggUrl, saveAppState, saveEventTeamToLibrary, saveTeams, sendWs,
  setActivePlatform, setStartggAutoFollow, setStartggQueuePolling, state,
  syncBracketToActiveEvent, syncStartGgSet, testStartGgConnection, touchAutoFollowHold,
  get leaguesVer() { return leaguesVer; }, set leaguesVer(v) { leaguesVer = v; },
  get startggApiToken() { return startggApiToken; }, set startggApiToken(v) { startggApiToken = v; }
}));
registerWsHandlers(require('./backend/ws/tournaments')({
  _logSerializeFailure, applySheetsAutoSync, broadcastFullState, buildChallongeParticipantMap,
  challengermodeClient, challongePartMap, createChallongeClient, faceit, getNxgenEvents,
  liquipedia, loadChallengermodeTournament, loadChalongeTournament, loadEvent,
  loadFaceitCompetition, loadNxgenEvent, loadSiteEvent, lpFetchRankings, lpFetchSquad,
  lpFetchStandings, lpFetchTournament, lpSyncBudget, parseChallengermodeId,
  pullOrgCompetitions, putSiteMatchOnAir, refreshAllMyEvents, refreshChallengermodeLive,
  refreshChallongeLive, refreshFaceitLive, refreshMyEvent, refreshNxgenLive, riot,
  saveAppState, saveTeams, sendWs, setActivePlatform, setChallengermodePolling,
  setChallongePolling, setFaceitPolling, setNxgenPolling, setStartggQueuePolling, sheets,
  sheetsConnect, siteEventFollow, siteEventLeague, siteEventState, state,
  syncLinkedChallongeTournament, syncSheets, touchMyEvents, wsSend,
  get challengermodeRefreshKey() { return challengermodeRefreshKey; }, set challengermodeRefreshKey(v) { challengermodeRefreshKey = v; },
  get challongeApiKey() { return challongeApiKey; }, set challongeApiKey(v) { challongeApiKey = v; },
  get faceitApiKey() { return faceitApiKey; }, set faceitApiKey(v) { faceitApiKey = v; },
  get liquipediaApiKey() { return liquipediaApiKey; }, set liquipediaApiKey(v) { liquipediaApiKey = v; },
  get nxgenApiKey() { return nxgenApiKey; }, set nxgenApiKey(v) { nxgenApiKey = v; },
  get riotApiKey() { return riotApiKey; }, set riotApiKey(v) { riotApiKey = v; },
  get savedTeams() { return savedTeams; }, set savedTeams(v) { savedTeams = v; },
  get sheetsServiceAccount() { return sheetsServiceAccount; }, set sheetsServiceAccount(v) { sheetsServiceAccount = v; }
}));
registerWsHandlers(require('./backend/ws/bracket')({
  bracketNameScore, bracketNormName, broadcastFullState, fetchBracket, obsSwitch, saveAppState,
  sendWs, setExclusiveGfxVisible, state, syncActiveBracketPhase, syncStartGgSet
}));
registerWsHandlers(require('./backend/ws/leagues')({
  brBinding, brSyncFromLeague, broadcastFullState, computeBrStandings, lgCaptureFinalize,
  migrateLeague, recomputeBrSeason, refreshCompetitionFeed, refreshLeagueStandingsMirror,
  saveAppState, state,
  get leaguesVer() { return leaguesVer; }, set leaguesVer(v) { leaguesVer = v; }
}));
registerWsHandlers(require('./backend/ws/game-config')({
  AdmZip, GAMES, GAME_CONFIG_VERSION_CAP, broadcastFullState, dialog, extractAssetsToZip, fsp,
  inflateAssetsFromZip, markGameConfigEdited, normalizeGameConfigFor, saveAppState,
  sendImportExportResult, state,
  get gameConfigsVer() { return gameConfigsVer; }, set gameConfigsVer(v) { gameConfigsVer = v; }
}));
registerWsHandlers(require('./backend/ws/brand')({
  GAMES, PACKAGE_FIELDS, activateBrandKitById, activePackage, applyBrandSlots, applyKitStyles,
  applyPackageSnapshot, applyPreset, brandId, broadcastFullState, capturePackageSnapshot,
  capturePreset, dialog, ensureKitPackages, fsp, isValidTheme, migrateThemeId, sanitizePackage,
  saveAppState, saveBrandKits, savePresets, sendImportExportResult, state,
  syncActivePreshowTopics,
  get savedBrandKits() { return savedBrandKits; }, set savedBrandKits(v) { savedBrandKits = v; },
  get savedPresets() { return savedPresets; }, set savedPresets(v) { savedPresets = v; }
}));
registerWsHandlers(require('./backend/ws/custom-overlays')({
  GAMES, broadcastFullState, coStore, saveAppState, state, wsSend,
  get customOverlaysVer() { return customOverlaysVer; }, set customOverlaysVer(v) { customOverlaysVer = v; }
}));
registerWsHandlers(require('./backend/ws/teams')({
  abbrForTeamName, broadcastFullState, cleanTeamAbbr, findTeamPlayer, logoForTeamName,
  persistRosterToLibrary, pickAutoFollowSet, propagateVaultCrest, rebuildCombinedPlayers,
  refreshCompetitionFeed, retuneRoundLabel, saveAppState, saveTeams, state, teamDb, vaultTouch,
  get leaguesVer() { return leaguesVer; }, set leaguesVer(v) { leaguesVer = v; },
  get savedTeams() { return savedTeams; }, set savedTeams(v) { savedTeams = v; }
}));
registerWsHandlers(require('./backend/ws/match')({
  GAMES, abbrForTeamName, applyActiveGame, broadcastFullState, cleanTeamAbbr, csCinematicApply,
  csGameTeamsKey, entrantOrgName, finalizeAndResetSeries, gameDefaultColors, persistMatchCrest,
  rebuildCombinedPlayers, resetOvertimeTrigger, retuneRoundLabel, saveAppState, state,
  swapTeamSides, vetoDraws,
  get _csManualSwapKey() { return _csManualSwapKey; }, set _csManualSwapKey(v) { _csManualSwapKey = v; },
  get _smashGameClosed() { return _smashGameClosed; }, set _smashGameClosed(v) { _smashGameClosed = v; },
  get savedTeams() { return savedTeams; }, set savedTeams(v) { savedTeams = v; }
}));
registerWsHandlers(require('./backend/ws/show')({
  REPLAY_STYLES, activePackage, announceGameResult, bridgeClients, broadcast,
  broadcastFullState, buildLiveState, flowBus, gameTimers, obsSwitch, resolveClockTarget,
  sanitizePreshowPick, saveAppState, saveBrandKitsSoon, saveTwitchData,
  scheduleBreakAutoSwitch, setExclusiveGfxVisible, setGfxActive, state,
  get miniGameManager() { return miniGameManager; }, set miniGameManager(v) { miniGameManager = v; },
  get savedBrandKits() { return savedBrandKits; }, set savedBrandKits(v) { savedBrandKits = v; }
}));
