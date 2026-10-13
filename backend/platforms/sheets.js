// backend/platforms/sheets.js — moved out of server.js (refactor step 3) unchanged; server.js creates it once
// with createSheets(ctx). ctx carries stable references plus live getters (ctx.<name>) for values
// server.js replaces at runtime, and set_<name>(v) for the ones this code writes.
module.exports = function createSheets(ctx) {
  const { sheets, state, saveTeams, pollLoop, saveAppState, brPointsFor, brBinding, brSyncFromLeague, recomputeBrSeason, computeBrStandings, broadcastFullState } = ctx;

// ─── Google Sheets integration ────────────────────────────────────────────────
// Service-account auth (read+write). Each data type maps to a worksheet tab with a direction:
// off | import (sheet→app) | export (app→sheet) | both. Sheets use a HEADER ROW; we match columns by
// name case-insensitively (see backend/sheets.js pick()), so there's no column-mapping UI to fill in.
function _sheetsSA() {
  if (!ctx.sheetsServiceAccount) throw new Error('No service-account key set (Settings ▸ Google Sheets).');
  return sheets.parseServiceAccount(ctx.sheetsServiceAccount);
}
async function sheetsConnect() {
  const sa = _sheetsSA();
  if (!state.sheets.sheetId) throw new Error('Paste a Google Sheet URL first.');
  const meta = await sheets.getMeta(sa, state.sheets.sheetId);
  state.sheets.connected = true;
  state.sheets.title = meta.title || '';
  state.sheets.tabs = meta.tabs || [];
  state.sheets.saEmail = sa.client_email;
  state.sheets.lastError = null;
  return meta;
}
function _rowPlayers(row) {
  const out = [];
  const bulk = sheets.pick(row, ['players', 'roster', 'gamertags']);
  if (bulk) bulk.split(/[,;/]| and /i).map((s) => s.trim()).filter(Boolean).forEach((n) => out.push(n));
  for (let i = 1; i <= 8; i++) { const p = row['player ' + i] || row['player' + i]; if (p && p.trim()) out.push(p.trim()); }
  return out;
}
function importTeamsFromRows(rows) {
  let n = 0;
  rows.forEach((row) => {
    const name = sheets.pick(row, ['team', 'name', 'team name']); if (!name) return;
    const logo = sheets.pick(row, ['logo', 'logo url', 'image', 'image url']);
    const color = sheets.pick(row, ['color', 'colour', 'hex']);
    const players = _rowPlayers(row).map((pn) => ({ id: Math.random().toString(36).slice(2, 11), name: pn, platform: '', platformId: '', assignedCamera: null }));
    let t = ctx.savedTeams.find((x) => (x.name || '').toLowerCase() === name.toLowerCase());
    if (!t) { t = { name, logo: '', players: [] }; ctx.savedTeams.push(t); }
    t.name = name;
    if (logo) t.logo = logo;
    if (/^#?[0-9a-f]{6}$/i.test(color)) t.color = color[0] === '#' ? color : '#' + color;
    if (players.length) t.players = players;
    n++;
  });
  if (n) saveTeams();
  return n;
}
function exportTeamsToRows() {
  const maxP = Math.max(2, ...ctx.savedTeams.map((t) => (t.players || []).length), 0);
  const header = ['Team', 'Logo', 'Color'];
  for (let i = 1; i <= maxP; i++) header.push('Player ' + i);
  const rows = [header];
  ctx.savedTeams.forEach((t) => {
    const r = [t.name || '', t.logo || '', t.color || ''];
    for (let i = 0; i < maxP; i++) r.push((((t.players || [])[i]) || {}).name || '');
    rows.push(r);
  });
  return rows;
}
function importScheduleFromRows(rows) {
  const matches = rows.map((row, i) => ({
    id: 'sheet_' + i,
    round: sheets.pick(row, ['round', 'stage']),
    teamA: sheets.pick(row, ['team a', 'teama', 'blue', 'home', 'team 1']),
    teamB: sheets.pick(row, ['team b', 'teamb', 'orange', 'away', 'team 2']),
    date: sheets.pick(row, ['date']),
    time: sheets.pick(row, ['time']),
    stream: sheets.pick(row, ['stream']),
    scoreA: Number(sheets.pick(row, ['score a', 'scorea'])) || 0,
    scoreB: Number(sheets.pick(row, ['score b', 'scoreb'])) || 0,
    note: sheets.pick(row, ['note', 'notes'])
  })).filter((m) => m.teamA || m.teamB);
  state.upcoming.matches = matches;
  state.upcoming.source = 'team';
  return matches.length;
}
function exportScheduleToRows() {
  const rows = [['Team A', 'Team B', 'Round', 'Date', 'Time', 'Stream', 'Score A', 'Score B']];
  (state.upcoming.matches || []).forEach((m) => rows.push([m.teamA || '', m.teamB || '', m.round || '', m.date || '', m.time || '', m.stream || '', m.scoreA != null ? m.scoreA : '', m.scoreB != null ? m.scoreB : '']));
  return rows;
}
// ── Battle-royale sheet mapping ──────────────────────────────────────────────
// The template we write (brWriteSheetTemplate) owns the column names, but a producer will rename a
// header eventually, so every field accepts the obvious aliases. Rows missing a team are skipped
// rather than importing a blank line onto the leaderboard.
function importBrResultsFromRows(rows) {
  const out = [];
  for (const r of rows) {
    const team = (sheets.pick(r, ['team', 'team name', 'name', 'squad', 'roster']) || '').toString().trim();
    if (!team) continue;
    const match = parseInt(sheets.pick(r, ['match', 'match #', 'game', 'game #', 'round', 'm']), 10) || 0;
    if (!match) continue;   // a row with no match number can't be scored or ordered
    out.push({
      match,
      team: team.slice(0, 80),
      placement: Math.max(0, parseInt(sheets.pick(r, ['placement', 'place', 'pos', 'position', 'rank', 'finish']), 10) || 0),
      elims: Math.max(0, parseInt(sheets.pick(r, ['elims', 'elim', 'eliminations', 'kills', 'k']), 10) || 0)
    });
  }
  const rowsIn = out.slice(0, 4000);   // 40 matches x 100 teams, well past any real event
  // Land in the BOUND CUP when there is one. Writing straight to state.br.results was correct
  // while the series was standalone, but once a cup is bound the very next brSyncFromLeague()
  // mirrors the league back over the top — so a sheet sync would appear to work and then
  // silently vanish. The sheet is a peer ingest path, so it writes where every other path does.
  const b = brBinding();
  if (b) {
    b.series.results = rowsIn;
    b.series.source = 'sheets';
    recomputeBrSeason(b.lg);
    ctx.set_leaguesVer(ctx.leaguesVer + 1);
    brSyncFromLeague();
  } else {
    state.br.results = rowsIn;
    state.br.source = 'sheets';
  }
  computeBrStandings();
  return out.length;
}
function exportBrResultsToRows() {
  const rows = [['Match', 'Team', 'Placement', 'Elims', 'Points']];
  for (const r of (state.br.results || [])) {
    rows.push([r.match, r.team, r.placement, r.elims, brPointsFor(r.placement, r.elims, r.match)]);
  }
  return rows;
}
function importBrPlayersFromRows(rows) {
  const out = [];
  for (const r of rows) {
    const player = (sheets.pick(r, ['player', 'player name', 'name', 'gamertag', 'ign', 'epic']) || '').toString().trim();
    if (!player) continue;
    out.push({
      match: parseInt(sheets.pick(r, ['match', 'match #', 'game', 'game #', 'round', 'm']), 10) || 0,
      player: player.slice(0, 80),
      team: (sheets.pick(r, ['team', 'team name', 'squad']) || '').toString().trim().slice(0, 80),
      elims: Math.max(0, parseInt(sheets.pick(r, ['elims', 'elim', 'eliminations', 'kills', 'k']), 10) || 0)
    });
  }
  state.br.playerResults = out.slice(0, 8000);
  state.br.source = 'sheets';
  computeBrStandings();
  return out.length;
}
function exportBrPlayersToRows() {
  const rows = [['Match', 'Player', 'Team', 'Elims']];
  for (const r of (state.br.playerResults || [])) rows.push([r.match, r.player, r.team, r.elims]);
  return rows;
}
// One-click "set my sheet up for me": creates (or overwrites) the two tabs with the exact headers
// the importer reads, pre-filled with a row per team per match so the scorekeeper only ever types
// numbers into existing cells. Returns what it wrote so the panel can report it.
async function brWriteSheetTemplate(opts) {
  const sa = _sheetsSA();
  const id = state.sheets.sheetId;
  if (!id) throw new Error('Connect a Google Sheet first (Settings > Integrations > Sheets).');
  const o = opts || {};
  const matches = Math.max(1, Math.min(40, parseInt(o.matches, 10) || state.br.format.matches || 6));
  const teams = (Array.isArray(o.teams) && o.teams.length)
    ? o.teams.map((t) => (t || '').toString().trim()).filter(Boolean)
    : [...new Set((state.br.results || []).map((r) => r.team))];
  const resultsTab = (o.resultsTab || state.sheets.maps.brResults.tab || 'BR Results').toString().slice(0, 80);
  const playersTab = (o.playersTab || state.sheets.maps.brPlayers.tab || 'BR Players').toString().slice(0, 80);

  const rows = [['Match', 'Team', 'Placement', 'Elims']];
  for (let m = 1; m <= matches; m++) {
    if (teams.length) teams.forEach((t) => rows.push([m, t, '', '']));
    else rows.push([m, '', '', '']);
  }
  await sheets.writeTab(sa, id, resultsTab, rows);
  await sheets.writeTab(sa, id, playersTab, [['Match', 'Player', 'Team', 'Elims']]);

  // Point the sync at what we just built and turn it on, so "generate template" leaves a WORKING
  // sync rather than a sheet the producer still has to wire up by hand.
  state.sheets.maps.brResults = { direction: 'import', tab: resultsTab };
  state.sheets.maps.brPlayers = { direction: 'import', tab: playersTab };
  state.br.format.matches = matches;
  state.br.enabled = true;
  saveAppState();
  broadcastFullState();
  return { resultsTab, playersTab, matches, teams: teams.length, rows: rows.length - 1 };
}

function importStandingsFromRows(rows) {
  const out = rows.map((row, i) => ({
    placement: Number(sheets.pick(row, ['place', 'placement', 'rank', '#'])) || (i + 1),
    name: sheets.pick(row, ['team', 'name', 'team name']),
    logo: sheets.pick(row, ['logo', 'image']),
    wins: Number(sheets.pick(row, ['wins', 'w'])) || 0,
    losses: Number(sheets.pick(row, ['losses', 'l'])) || 0,
    points: Number(sheets.pick(row, ['points', 'pts'])) || 0
  })).filter((r) => r.name);
  out.sort((a, b) => a.placement - b.placement);
  state.standings.rows = out;
  state.standings.source = 'manual';
  return out.length;
}
function exportStandingsToRows() {
  const rows = [['Place', 'Team', 'Wins', 'Losses', 'Points']];
  (state.standings.rows || []).forEach((r) => rows.push([r.placement != null ? r.placement : '', r.name || '', r.wins != null ? r.wins : '', r.losses != null ? r.losses : '', r.points != null ? r.points : '']));
  return rows;
}
// One sync at a time: 'Sync now' and the auto tick used to run together and interleave reads/writes.
let _sheetsBusy = null;
function syncSheets(reason) {
  if (_sheetsBusy) return _sheetsBusy;
  _sheetsBusy = _syncSheetsOnce(reason).finally(() => { _sheetsBusy = null; });
  return _sheetsBusy;
}
async function _syncSheetsOnce(reason) {
  if (!state.sheets.enabled) return { ok: false, message: 'Sheets sync is off.' };
  const sa = _sheetsSA();
  const id = state.sheets.sheetId;
  if (!id) throw new Error('No sheet connected.');
  const maps = state.sheets.maps;
  const done = [];
  // "Both": the old import-then-export order silently discarded any in-app edit made since the
  // last sync tick — import overwrote local state right before export re-saved that (now-stale)
  // state back to the sheet, cementing the sheet's old value with zero indication anything was
  // lost. Fix: track a signature of what was last exported per key. If local data still matches
  // it, nothing's changed in-app since the last successful sync, so it's safe to import normally
  // (this also covers the very first sync, where there's no signature yet — import runs as
  // before, correctly pulling in a sheet's pre-existing data). If local data has since diverged
  // (a producer edit is pending), skip the import for this tick and export it instead — the next
  // tick's signature will match again and imports resume.
  if (!state.sheets._lastExportSig || typeof state.sheets._lastExportSig !== 'object') state.sheets._lastExportSig = {};
  const sig = state.sheets._lastExportSig;
  const runType = async (key, importFn, exportFn) => {
    const m = maps[key]; if (!m || m.direction === 'off' || !m.tab) return;
    const localDirty = m.direction === 'both' && sig[key] !== undefined && sig[key] !== JSON.stringify(exportFn());
    if ((m.direction === 'import' || m.direction === 'both') && !localDirty) {
      const before = JSON.stringify(exportFn());
      const rows = sheets.rowsToObjects(await sheets.readTab(sa, id, m.tab));
      // The read can take seconds: an in-app edit made meanwhile would be overwritten here and then
      // exported back over the sheet (lost for good). Re-check after the read and keep the edit.
      if (m.direction === 'both' && JSON.stringify(exportFn()) !== before) {
        done.push(key + ' (edited during the read — import skipped this tick)');
      } else {
        const n = importFn(rows);
        done.push(key + ' ←' + n);
      }
    }
    if (m.direction === 'export' || m.direction === 'both') {
      const rows = exportFn();
      await sheets.writeTab(sa, id, m.tab, rows);
      sig[key] = JSON.stringify(rows);
      done.push(key + ' →' + (localDirty ? ' (local edit — import skipped this tick)' : ''));
    }
  };
  await runType('teams', importTeamsFromRows, exportTeamsToRows);
  await runType('schedule', importScheduleFromRows, exportScheduleToRows);
  await runType('standings', importStandingsFromRows, exportStandingsToRows);
  await runType('brResults', importBrResultsFromRows, exportBrResultsToRows);
  await runType('brPlayers', importBrPlayersFromRows, exportBrPlayersToRows);
  state.sheets.lastSyncAt = new Date().toISOString();
  state.sheets.lastSyncMsg = done.length ? ('Synced: ' + done.join(', ')) : 'Nothing synced — set a direction (not Off) on at least one data type.';
  state.sheets.lastError = null;
  state.sheets.connected = true;
  saveAppState();
  broadcastFullState();
  return { ok: true, message: state.sheets.lastSyncMsg };
}
let _sheetsTimer = null;
function applySheetsAutoSync() {
  if (_sheetsTimer) { _sheetsTimer.stop(); _sheetsTimer = null; }
  const sec = Number(state.sheets.autoSyncSec) || 0;
  if (state.sheets.enabled && ctx.sheetsServiceAccount && state.sheets.sheetId && sec >= 10) {
    _sheetsTimer = pollLoop('sheets', () => syncSheets('auto').catch((e) => { state.sheets.lastError = e.message; broadcastFullState(); throw e; }), sec * 1000);
  }
}


  return { applySheetsAutoSync, brWriteSheetTemplate, sheetsConnect, syncSheets };
};
