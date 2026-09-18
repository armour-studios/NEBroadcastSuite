/* ─── league-interchange.js — import / export for in-app leagues ──────────────
   Organisers rarely arrive empty-handed. Collegiate and amateur leagues usually already run in
   other software or a spreadsheet, and some will treat THIS app as the source of truth and need
   their season back out again (for a website, a report, or the next tool). Both directions are
   NAME-based rather than id-based — no two systems share ids, but they all agree on team names.

   Loads AFTER leagues.js and reuses its domain (lgActive/lgSave/lgRender/lgUid/lgStatus/
   lgResolveTeam/lgStandingsRow/lgApplyScoring/lgMatchTally/lgNewLeague/lgLeagues), plus
   csvParse() from spotlight.js and anDownload()/toCSV() from stats-analytics.js. */

// ── Name matching ────────────────────────────────────────────────────────────
// Systems differ on case, punctuation, spacing and the decorative suffixes orgs tack on, so
// "St. John's Esports" and "St Johns" have to collapse to the same key.
const LG_NAME_NOISE = /\b(esports?|egaming|gaming|academy|university|college|club|team|gc|ec|sc)\b/g;
function lgNormName(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')          // DELETE apostrophes, don't space them: spacing turns
                                        // "John's" into "john s", which never matches "Johns"
    .replace(/[^a-z0-9\s]/g, ' ')      // periods, hyphens, commas -> separators
    .replace(LG_NAME_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// Resolve an imported name against teams already in the league: exact name, then normalised
// equality. Anything less certain returns null so the importer CREATES a team — a duplicate row is
// trivial for a producer to merge, whereas two schools silently sharing one record is a corrupted
// season that nobody notices until standings look wrong.
function lgMatchTeam(lg, name) {
  const teams = (lg && lg.teams) || [];
  const raw = String(name || '').trim();
  if (!raw) return null;
  const exact = teams.find((t) => ((t.teamName || t.name) || '').trim() === raw);
  if (exact) return exact;
  const n = lgNormName(raw);
  if (!n) return null;
  const norm = teams.filter((t) => lgNormName(t.teamName || t.name) === n);
  return norm.length ? norm[0] : null;
  // NO prefix/containment fallback. It merged "Lakeside, North" into "Lakeside" — two different
  // schools sharing one set of records, which is the worst outcome an importer can produce. It was
  // also redundant: "Riverside" already matches "Riverside Gaming" because the noise list strips
  // "Gaming" before comparison, so containment only ever added false positives.
}
// Match-or-create. `report` accumulates what happened so the producer sees the decisions rather
// than having to trust them.
function lgEnsureTeam(lg, name, report) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  const hit = lgMatchTeam(lg, raw);
  if (hit) {
    const existing = (hit.teamName || hit.name || '').trim();
    if (existing !== raw && report) report.matched.push(raw + ' -> ' + existing);
    return hit;
  }
  lg.teams = lg.teams || [];
  const tm = { id: lgUid('tm'), teamName: raw };   // name reference: auto-links to a saved team if one exists
  lg.teams.push(tm);
  if (report) report.created.push(raw);
  return tm;
}

// ── Export ───────────────────────────────────────────────────────────────────
function lgFileStamp(lg) {
  const base = (lg && lg.name) || 'league';
  return base.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'league';
}
function lgTeamNameById(lg, id) {
  const t = (lg.teams || []).find((x) => x.id === id);
  return t ? lgResolveTeam(t).name : '';
}
// Full round-trippable league. Team names are denormalised alongside the ids so the file stays
// meaningful to a human, and to another system, rather than being a bag of opaque references.
function lgExportJson() {
  const lg = lgActive(); if (!lg) { lgStatus('Select a league first.', false); return; }
  const payload = {
    format: 'ne-broadcast-league', version: 1, exportedAt: new Date().toISOString(),
    league: {
      name: lg.name, game: lg.game, season: lg.season, abbr: lg.abbr,
      scoring: lg.scoring, playoffN: lg.playoffN, tiebreak: lg.tiebreak,
      standingsMode: lg.standingsMode || 'schedule',
      teams: (lg.teams || []).map((t) => ({ id: t.id, name: lgResolveTeam(t).name })),
      schedule: (lg.schedule || []).map((m) => ({
        id: m.id, week: m.week || '', date: m.date || '', time: m.time || '', format: m.format || '',
        teamA: m.teamA, teamB: m.teamB,
        teamAName: lgTeamNameById(lg, m.teamA), teamBName: lgTeamNameById(lg, m.teamB),
        result: m.result || null, games: m.games || []
      })),
      standings: (lg.standings || []).map((s) => Object.assign({}, s, { teamName: lgTeamNameById(lg, s.teamId) })),
      seasonHistory: lg.seasonHistory || []
    }
  };
  anDownload(lgFileStamp(lg) + '-league.json', JSON.stringify(payload, null, 2), 'application/json');
  lgStatus('League exported as JSON.', true);
}
// Standings as CSV — the shape a league website or end-of-season report actually wants.
function lgExportStandingsCsv() {
  const lg = lgActive(); if (!lg) { lgStatus('Select a league first.', false); return; }
  const rows = (lg.standings || []).map((s, i) => [
    i + 1, lgTeamNameById(lg, s.teamId), s.w || 0, s.l || 0, s.t || 0, s.pts || 0,
    s.gf || 0, s.ga || 0, (s.gf || 0) - (s.ga || 0), (s.form || []).join(''), s.streak || ''
  ]);
  if (!rows.length) { lgStatus('No standings to export yet.', false); return; }
  anDownload(lgFileStamp(lg) + '-standings.csv',
    toCSV(['Rank', 'Team', 'W', 'L', 'T', 'Pts', 'For', 'Against', 'Diff', 'Form', 'Streak'], rows), 'text/csv');
  lgStatus('Standings exported as CSV.', true);
}
// Schedule + results as CSV. Column names match what lgImportCsv() reads, so this round-trips.
function lgExportScheduleCsv() {
  const lg = lgActive(); if (!lg) { lgStatus('Select a league first.', false); return; }
  const rows = (lg.schedule || []).map((m) => {
    const t = lgMatchTally(m);
    const played = !!((m.games && m.games.length) || (m.result && m.result.scoreA != null));
    return [m.week || '', m.date || '', lgTeamNameById(lg, m.teamA), lgTeamNameById(lg, m.teamB),
      played ? t.sa : '', played ? t.sb : ''];
  });
  if (!rows.length) { lgStatus('No schedule to export yet.', false); return; }
  anDownload(lgFileStamp(lg) + '-schedule.csv',
    toCSV(['Week', 'Date', 'Home', 'Away', 'Home Score', 'Away Score'], rows), 'text/csv');
  lgStatus('Schedule exported as CSV.', true);
}

// ── Import ───────────────────────────────────────────────────────────────────
// Header synonyms, deliberately generous: every league platform names these differently, and
// making a producer rename spreadsheet columns before importing is exactly the friction that
// stops them trying the app at all.
const LG_CSV_SYN = {
  teamA:  ['team a', 'teama', 'home', 'home team', 'team 1', 'team1', 'player 1'],
  teamB:  ['team b', 'teamb', 'away', 'away team', 'team 2', 'team2', 'player 2', 'opponent'],
  scoreA: ['score a', 'scorea', 'home score', 'a score', 'score 1', 'team 1 score', 'home pts'],
  scoreB: ['score b', 'scoreb', 'away score', 'b score', 'score 2', 'team 2 score', 'away pts'],
  team:   ['team', 'team name', 'school', 'organization', 'organisation', 'org', 'club', 'name'],
  wins:   ['w', 'wins', 'won'],
  losses: ['l', 'losses', 'lost'],
  ties:   ['t', 'd', 'ties', 'draws', 'tied'],
  pts:    ['pts', 'points'],
  week:   ['week', 'wk', 'round', 'matchweek'],
  date:   ['date', 'played', 'match date']
};
function lgFindCol(headers, key) {
  const want = LG_CSV_SYN[key] || [];
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i] || '').trim().toLowerCase().replace(/[_.]/g, ' ').replace(/\s+/g, ' ');
    if (want.indexOf(h) !== -1) return i;
  }
  return -1;
}
// One CSV entry point covering the three shapes organisers actually have: a fixture/results list,
// a standings table, or a plain list of teams. Which one it is, is detected from the columns.
function lgImportCsv(text) {
  const lg = lgActive(); if (!lg) { lgStatus('Select a league first.', false); return; }
  const rows = csvParse(text);
  if (rows.length < 2) { lgStatus('That file has no data rows.', false); return; }
  const headers = rows[0], body = rows.slice(1);
  const report = { matched: [], created: [], fixtures: 0, results: 0, standings: 0 };
  const cA = lgFindCol(headers, 'teamA'), cB = lgFindCol(headers, 'teamB');
  const cTeam = lgFindCol(headers, 'team');

  if (cA >= 0 && cB >= 0) {
    const sA = lgFindCol(headers, 'scoreA'), sB = lgFindCol(headers, 'scoreB');
    const cWk = lgFindCol(headers, 'week'), cDt = lgFindCol(headers, 'date');
    lg.schedule = lg.schedule || [];
    body.forEach((r) => {
      const ta = lgEnsureTeam(lg, r[cA], report), tb = lgEnsureTeam(lg, r[cB], report);
      if (!ta || !tb || ta.id === tb.id) return;
      const rawA = sA >= 0 ? String(r[sA] == null ? '' : r[sA]).trim() : '';
      const rawB = sB >= 0 ? String(r[sB] == null ? '' : r[sB]).trim() : '';
      const has = rawA !== '' && rawB !== '';
      lg.schedule.push({
        id: lgUid('m'), teamA: ta.id, teamB: tb.id, format: '',
        week: cWk >= 0 ? String(r[cWk] || '').trim() : '',
        date: cDt >= 0 ? String(r[cDt] || '').trim() : '', time: '',
        result: { scoreA: has ? (Number(rawA) || 0) : null, scoreB: has ? (Number(rawB) || 0) : null, ot: false },
        games: []
      });
      report.fixtures++; if (has) report.results++;
    });
  } else if (cTeam >= 0 && (lgFindCol(headers, 'wins') >= 0 || lgFindCol(headers, 'pts') >= 0)) {
    // A standings table: the league is mid-season elsewhere and only the table came across.
    const cW = lgFindCol(headers, 'wins'), cL = lgFindCol(headers, 'losses'),
          cT = lgFindCol(headers, 'ties'), cP = lgFindCol(headers, 'pts');
    body.forEach((r) => {
      const tm = lgEnsureTeam(lg, r[cTeam], report); if (!tm) return;
      const s = lgStandingsRow(lg, tm.id);
      if (cW >= 0) s.w = Number(r[cW]) || 0;
      if (cL >= 0) s.l = Number(r[cL]) || 0;
      if (cT >= 0) s.t = Number(r[cT]) || 0;
      const rawP = cP >= 0 ? String(r[cP] == null ? '' : r[cP]).trim() : '';
      if (rawP !== '') { s.pts = Number(rawP) || 0; s.ptsLocked = true; }
      else lgApplyScoring(lg, s);
      report.standings++;
    });
    // An imported table IS the record — leaving this on 'schedule' means the next Recalculate
    // silently wipes every row, because no fixtures back it.
    lg.standingsMode = 'manual';
  } else if (cTeam >= 0) {
    body.forEach((r) => { lgEnsureTeam(lg, r[cTeam], report); });
  } else {
    lgStatus('Could not find the columns. Expected Home/Away (a schedule), Team + W/L or Points (a standings table), or a Team column (a roster).', false);
    return null;
  }
  lgSave(); if (typeof lgRender === 'function') lgRender();
  const bits = [];
  if (report.created.length) bits.push(report.created.length + ' team' + (report.created.length === 1 ? '' : 's') + ' created');
  if (report.matched.length) bits.push(report.matched.length + ' matched to existing');
  if (report.fixtures) bits.push(report.fixtures + ' fixtures (' + report.results + ' with results)');
  if (report.standings) bits.push(report.standings + ' standings rows');
  lgStatus('Imported: ' + (bits.join(', ') || 'nothing recognised') + '.', true);
  if (report.matched.length) console.info('[league-import] name matches:', report.matched);
  return report;
}
// Restore a league exported by lgExportJson(). Creates a NEW league rather than overwriting the
// active one — an import must never be able to destroy the season already open.
function lgImportJson(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { lgStatus('That file is not valid JSON.', false); return null; }
  const src = (data && data.league) || data;
  if (!src || !Array.isArray(src.teams)) { lgStatus('That JSON does not look like an exported league.', false); return null; }
  const lg = lgNewLeague();
  lg.name = (src.name || 'Imported League') + ' (imported)';
  ['game', 'season', 'abbr', 'scoring', 'playoffN', 'tiebreak', 'standingsMode'].forEach((k) => {
    if (src[k] != null) lg[k] = src[k];
  });
  const idMap = {};
  (src.teams || []).forEach((t) => {
    const tm = { id: lgUid('tm'), teamName: t.name || t.teamName || 'Team' };
    lg.teams.push(tm);
    if (t.id) idMap[t.id] = tm.id;
  });
  // Fall back to the denormalised name when the source ids are unfamiliar (hand-edited or
  // third-party files) — that name column is exactly why it is written out.
  const resolve = (oldId, fallbackName) => {
    if (idMap[oldId]) return idMap[oldId];
    const hit = fallbackName ? lgMatchTeam(lg, fallbackName) : null;
    return hit ? hit.id : null;
  };
  (src.schedule || []).forEach((m) => {
    const a = resolve(m.teamA, m.teamAName), b = resolve(m.teamB, m.teamBName);
    if (!a || !b) return;
    lg.schedule.push({
      id: lgUid('m'), teamA: a, teamB: b, format: m.format || '',
      week: m.week || '', date: m.date || '', time: m.time || '',
      result: m.result || { scoreA: null, scoreB: null, ot: false }, games: m.games || []
    });
  });
  (src.standings || []).forEach((s) => {
    const id = resolve(s.teamId, s.teamName); if (!id) return;
    const row = lgStandingsRow(lg, id);
    ['w', 'l', 't', 'gf', 'ga', 'pts', 'subW', 'subL', 'form', 'streak'].forEach((k) => {
      if (s[k] != null) row[k] = s[k];
    });
  });
  if (Array.isArray(src.seasonHistory)) lg.seasonHistory = src.seasonHistory;
  lgLeagues.push(lg);
  lgActiveId = lg.id;
  lgSave(); if (typeof lgRender === 'function') lgRender();
  lgStatus('Imported "' + lg.name + '" — ' + lg.teams.length + ' teams, ' + lg.schedule.length + ' fixtures.', true);
  return lg;
}
// Shared file picker for both importers.
function lgPickFile(accept, onText) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = accept; inp.style.display = 'none';
  inp.addEventListener('change', () => {
    const f = inp.files && inp.files[0];
    if (f) {
      const rd = new FileReader();
      rd.onload = () => { try { onText(String(rd.result || '')); } catch (e) { lgStatus('Import failed: ' + e.message, false); } };
      rd.readAsText(f);
    }
    setTimeout(() => { try { inp.remove(); } catch (e) {} }, 0);
  });
  document.body.appendChild(inp);
  inp.click();
}

el('lg-export-json')?.addEventListener('click', lgExportJson);
el('lg-export-standings-csv')?.addEventListener('click', lgExportStandingsCsv);
el('lg-export-schedule-csv')?.addEventListener('click', lgExportScheduleCsv);
el('lg-import-json')?.addEventListener('click', () => lgPickFile('.json,application/json', lgImportJson));
el('lg-import-csv')?.addEventListener('click', () => lgPickFile('.csv,text/csv', lgImportCsv));
