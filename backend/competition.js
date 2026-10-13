// Competition data interchange — the ONE format every outside system speaks to reach a league.
//
// Leagues arrive from everywhere: a Google Sheet, a league website that can publish JSON, a Discord
// bot, a CSV export from other league software, or nothing at all (typed in by hand). Every one of
// those is converted into the same document ("ne-competition" v1, documented in
// docs/competition-api.md) and merged into an in-app league by applyDoc(). The league then stays
// the single store the broadcast reads from — buildFeed() turns it into the small live feed the
// ticker, schedule board, starting-soon and BRB scenes draw.
//
// Pure module: no server state, no I/O. server.js passes in what it needs (id minting, the team
// library resolver), which is also what makes this testable (test/competition.test.js).
'use strict';

const FORMAT = 'ne-competition';
const VERSION = 1;
const MATCH_STATUSES = ['scheduled', 'live', 'completed', 'cancelled', 'postponed'];

// ── Names ────────────────────────────────────────────────────────────────────
// Same rule as control-panel/league-interchange.js (lgNormName): delete apostrophes, strip the
// decorative suffixes orgs add, collapse punctuation. Exact, then normalised equality — NEVER a
// prefix/containment fuzzy match; two schools sharing one record is a corrupted season.
const NAME_NOISE = /\b(esports?|egaming|gaming|academy|university|college|club|team|gc|ec|sc)\b/g;
function normName(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(NAME_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const str = (v, max = 200) => (v == null ? '' : String(v).trim().slice(0, max));
const numOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const pad2 = (n) => String(n).padStart(2, '0');

// ── CSV ──────────────────────────────────────────────────────────────────────
// RFC 4180-ish: quoted fields, doubled quotes, CRLF. Enough for Google Sheets' CSV export and
// every spreadsheet app's "Save as CSV".
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  const s = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}
// Header row + data rows → objects keyed by the normalised header ("Team A" → "team a").
function rowsToObjects(rows) {
  if (!Array.isArray(rows) || rows.length < 1) return [];
  const heads = rows[0].map((h) => String(h || '').trim().toLowerCase().replace(/[_.]/g, ' ').replace(/\s+/g, ' '));
  return rows.slice(1).map((r) => {
    const o = {};
    heads.forEach((h, i) => { if (h) o[h] = r[i] == null ? '' : String(r[i]).trim(); });
    return o;
  });
}

// ── Spreadsheet columns → document ──────────────────────────────────────────
// Generous synonyms: making an organiser rename their columns is the friction that stops them.
const COLS = {
  id:       ['id', 'match id', 'matchid', 'team id', 'teamid', 'key'],
  teamName: ['team', 'name', 'team name', 'school', 'organization', 'organisation', 'org', 'club'],
  abbr:     ['abbr', 'abbreviation', 'short', 'short name', 'tag', 'tricode'],
  logo:     ['logo', 'logo url', 'image', 'crest', 'icon'],
  color:    ['color', 'colour', 'team color', 'hex'],
  division: ['division', 'conference', 'group', 'pool'],
  teamA:    ['team a', 'teama', 'home', 'home team', 'team 1', 'team1', 'player 1', 'blue'],
  teamB:    ['team b', 'teamb', 'away', 'away team', 'team 2', 'team2', 'player 2', 'opponent', 'orange'],
  scoreA:   ['score a', 'scorea', 'home score', 'a score', 'score 1', 'team 1 score', 'team a score'],
  scoreB:   ['score b', 'scoreb', 'away score', 'b score', 'score 2', 'team 2 score', 'team b score'],
  date:     ['date', 'match date', 'day'],
  time:     ['time', 'start time', 'kickoff', 'match time'],
  when:     ['scheduled at', 'scheduledat', 'datetime', 'start', 'starts at'],
  week:     ['week', 'wk', 'matchweek'],
  round:    ['round', 'stage', 'phase'],
  bestOf:   ['best of', 'bestof', 'bo', 'format', 'series'],
  status:   ['status', 'state'],
  stream:   ['stream', 'channel', 'broadcast', 'stream url'],
  wins:     ['w', 'wins', 'won'],
  losses:   ['l', 'losses', 'lost'],
  draws:    ['t', 'd', 'ties', 'draws', 'tied'],
  points:   ['pts', 'points'],
  rank:     ['rank', 'position', 'pos', 'place', '#'],
  gameWins: ['game wins', 'map wins', 'gw', 'games won', 'maps won'],
  gameLosses: ['game losses', 'map losses', 'gl', 'games lost', 'maps lost'],
};
function col(o, key) {
  for (const k of COLS[key] || []) if (o[k] != null && o[k] !== '') return o[k];
  return '';
}
function hasCol(objs, key) { return objs.some((o) => (COLS[key] || []).some((k) => k in o)); }

// "Bo3", "best of 5", "3" → 3
function parseBestOf(v) {
  const m = String(v == null ? '' : v).match(/(\d+)/);
  const n = m ? Number(m[1]) : 0;
  return n > 0 && n < 20 ? n : null;
}
function parseStatus(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return '';
  if (/^(live|in ?progress|playing|on ?air|started)$/.test(s)) return 'live';
  if (/^(completed?|done|final|finished|played|result)$/.test(s)) return 'completed';
  if (/^(cancell?ed|forfeit|void)$/.test(s)) return 'cancelled';
  if (/^(postponed|delayed|tbd|rescheduled)$/.test(s)) return 'postponed';
  if (/^(scheduled|upcoming|pending|not started)$/.test(s)) return 'scheduled';
  return '';
}

/** Tables (arrays of header-keyed row objects) → an ne-competition document. */
function tablesToDoc({ teams = [], matches = [], standings = [], competition = {} } = {}) {
  const doc = { format: FORMAT, version: VERSION, competition: { ...competition }, teams: [], matches: [] };
  teams.forEach((o) => {
    const name = col(o, 'teamName'); if (!name) return;
    doc.teams.push({ id: col(o, 'id') || undefined, name, abbr: col(o, 'abbr') || undefined, logo: col(o, 'logo') || undefined,
      color: col(o, 'color') || undefined, division: col(o, 'division') || undefined });
  });
  matches.forEach((o) => {
    const a = col(o, 'teamA'), b = col(o, 'teamB'); if (!a || !b) return;
    const sa = col(o, 'scoreA'), sb = col(o, 'scoreB');
    doc.matches.push({
      id: col(o, 'id') || undefined, teamA: a, teamB: b,
      scheduledAt: col(o, 'when') || undefined, date: col(o, 'date') || undefined, time: col(o, 'time') || undefined,
      week: col(o, 'week') || undefined, round: col(o, 'round') || undefined,
      bestOf: parseBestOf(col(o, 'bestOf')) || undefined, status: parseStatus(col(o, 'status')) || undefined,
      scoreA: sa === '' ? undefined : sa, scoreB: sb === '' ? undefined : sb,
      stream: col(o, 'stream') || undefined,
    });
  });
  if (standings.length) {
    doc.standings = [];
    standings.forEach((o) => {
      const t = col(o, 'teamName'); if (!t) return;
      doc.standings.push({ team: t, rank: col(o, 'rank') || undefined, wins: col(o, 'wins'), losses: col(o, 'losses'),
        draws: col(o, 'draws') || undefined, points: col(o, 'points') === '' ? undefined : col(o, 'points'),
        gameWins: col(o, 'gameWins') || undefined, gameLosses: col(o, 'gameLosses') || undefined, division: col(o, 'division') || undefined });
    });
  }
  return doc;
}

/** One CSV of unknown shape → document. Detects a schedule (Team A/B), a standings table
 *  (Team + W/L or Points) or a plain team list — the three shapes organisers actually have. */
function csvToDoc(text) {
  const objs = rowsToObjects(parseCsv(text));
  if (!objs.length) return { doc: null, shape: '', error: 'That file has no data rows.' };
  if (hasCol(objs, 'teamA') && hasCol(objs, 'teamB')) return { doc: tablesToDoc({ matches: objs }), shape: 'schedule' };
  if (hasCol(objs, 'teamName') && (hasCol(objs, 'wins') || hasCol(objs, 'points'))) return { doc: tablesToDoc({ teams: objs, standings: objs }), shape: 'standings' };
  if (hasCol(objs, 'teamName')) return { doc: tablesToDoc({ teams: objs }), shape: 'teams' };
  return { doc: null, shape: '', error: 'Could not find the columns. Expected Team A / Team B (a schedule), Team + W / L or Points (standings), or a Team column (a team list).' };
}

// ── Validation ───────────────────────────────────────────────────────────────
// Normalises a document from any source and reports problems in plain words. Lenient by design:
// a single bad row is a warning and is skipped; only a document with nothing usable is an error.
function splitWhen(m) {
  // Explicit date/time win — they are what a spreadsheet author typed and meant.
  let date = str(m.date, 20), time = str(m.time, 20);
  const when = m.scheduledAt || m.startsAt || m.start;
  if ((!date || !time) && when) {
    const d = new Date(when);
    if (!isNaN(d.getTime())) {
      // Converted to THIS machine's local time: the broadcast PC is where the show runs.
      if (!date) date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      if (!time && /T|\d:\d/.test(String(when))) time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }
  }
  // Normalise common spreadsheet date spellings to YYYY-MM-DD so sorting works.
  const us = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (us) { const y = us[3].length === 2 ? '20' + us[3] : us[3]; date = `${y}-${pad2(us[1])}-${pad2(us[2])}`; }
  // "7:30 PM" → "19:30"
  const t12 = time.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i);
  if (t12) { let h = Number(t12[1]) % 12; if (/p/i.test(t12[3])) h += 12; time = `${pad2(h)}:${t12[2] || '00'}`; }
  return { date, time };
}

function validateDoc(input) {
  const errors = [], warnings = [];
  let d = input;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return { doc: null, errors: ['Not valid JSON: ' + e.message], warnings }; } }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { doc: null, errors: ['Expected a JSON object.'], warnings };
  if (d.format && d.format !== FORMAT) warnings.push(`format is "${d.format}", expected "${FORMAT}" — reading it anyway.`);
  if (d.version && Number(d.version) > VERSION) warnings.push(`version ${d.version} is newer than this app understands (${VERSION}) — unknown fields are ignored.`);

  const c = d.competition && typeof d.competition === 'object' ? d.competition : {};
  const doc = {
    format: FORMAT, version: VERSION,
    competition: { id: str(c.id, 120), name: str(c.name, 120), season: str(c.season, 60), game: str(c.game, 60), logo: str(c.logo, 2048), website: str(c.website, 2048) },
    teams: [], matches: [], standings: null,
  };

  const seenTeam = new Set();
  (Array.isArray(d.teams) ? d.teams : []).slice(0, 500).forEach((t, i) => {
    const name = str(t && (t.name || t.teamName), 120);
    if (!name) { warnings.push(`teams[${i}] has no name — skipped.`); return; }
    const key = normName(name) || name.toLowerCase();
    if (seenTeam.has(key)) { warnings.push(`teams[${i}] "${name}" is listed twice — kept the first.`); return; }
    seenTeam.add(key);
    // players is optional: a source that sends it owns the roster (the website does); one that
    // omits it leaves the league's own roster alone.
    const players = Array.isArray(t.players) ? t.players.slice(0, 20).map((p) => ({
      id: str(p && p.id, 120), name: str(p && (p.name || p.gamertag || p.handle), 60), role: str(p && p.role, 40),
      photo: str(p && (p.photo || p.avatar), 2048), country: str(p && p.country, 8),
    })).filter((p) => p.name) : null;
    doc.teams.push({ id: str(t.id, 120), name, abbr: str(t.abbr || t.tag, 12), logo: str(t.logo, 2048), color: /^#?[0-9a-f]{6}$/i.test(str(t.color)) ? ('#' + str(t.color).replace('#', '')) : '', division: str(t.division, 60), players });
  });

  (Array.isArray(d.matches) ? d.matches : []).slice(0, 2000).forEach((m, i) => {
    if (!m || typeof m !== 'object') return;
    const a = str(m.teamA != null ? m.teamA : m.home, 120), b = str(m.teamB != null ? m.teamB : m.away, 120);
    if (!a || !b) { warnings.push(`matches[${i}] needs both teamA and teamB — skipped.`); return; }
    if (normName(a) === normName(b) && a.toLowerCase() === b.toLowerCase()) { warnings.push(`matches[${i}] has the same team on both sides — skipped.`); return; }
    const { date, time } = splitWhen(m);
    let scoreA = numOrNull(m.scoreA != null ? m.scoreA : m.homeScore);
    let scoreB = numOrNull(m.scoreB != null ? m.scoreB : m.awayScore);
    const games = (Array.isArray(m.games) ? m.games : []).slice(0, 15)
      .map((g) => ({ scoreA: numOrNull(g && g.scoreA), scoreB: numOrNull(g && g.scoreB), map: str(g && g.map, 60) }))
      .filter((g) => g.scoreA != null && g.scoreB != null);
    let status = parseStatus(m.status);
    if (m.status && !status) warnings.push(`matches[${i}] status "${m.status}" isn't one of ${MATCH_STATUSES.join(', ')} — ignored.`);
    if (!status) status = (scoreA != null && scoreB != null) || games.length ? 'completed' : 'scheduled';
    doc.matches.push({
      id: str(m.id, 120), teamA: a, teamB: b, date, time,
      week: str(m.week, 20), round: str(m.round || m.stage, 60), bestOf: parseBestOf(m.bestOf) || null,
      status, scoreA, scoreB, games, overtime: !!m.overtime, stream: str(m.stream, 2048),
      // Stream-queue flags (the Nameless website sends them): on a channel's queue, its place, featured.
      onStream: !!m.onStream, queuePos: numOrNull(m.queuePos), featured: !!m.featured, streamName: str(m.streamName, 60),
    });
  });

  if (Array.isArray(d.standings)) {
    doc.standings = [];
    d.standings.slice(0, 500).forEach((s, i) => {
      const team = str(s && (s.team || s.name || s.teamName), 120);
      if (!team) { warnings.push(`standings[${i}] has no team — skipped.`); return; }
      doc.standings.push({ team, rank: numOrNull(s.rank), wins: numOrNull(s.wins) || 0, losses: numOrNull(s.losses) || 0,
        draws: numOrNull(s.draws) || 0, points: numOrNull(s.points), gameWins: numOrNull(s.gameWins), gameLosses: numOrNull(s.gameLosses),
        division: str(s.division, 60) });
    });
  }

  if (!doc.teams.length && !doc.matches.length && !(doc.standings && doc.standings.length) && !doc.competition.name) {
    errors.push('The document has no teams, matches or standings.');
  }
  return { doc: errors.length ? null : doc, errors, warnings };
}

// ── Merge into a league ─────────────────────────────────────────────────────
// Idempotent: syncing the same document twice changes nothing. Rows are keyed by the source's own
// id when it has one (extId), else by the pairing + week/date, so a spreadsheet without an id
// column still updates results in place instead of appending a duplicate fixture every sync.
//
// opts.prune — the document is the WHOLE truth for this league (a pulled feed or a sheet): fixtures
// that came from a previous sync (m.src === 'sync') and are no longer in it are removed. Fixtures a
// producer added by hand are never pruned.
function applyDoc(lg, doc, opts = {}) {
  const uid = opts.uid || ((p) => p + Math.random().toString(36).slice(2, 9));
  const report = { teamsCreated: [], teamsMatched: 0, matchesAdded: 0, matchesUpdated: 0, matchesRemoved: 0, standingsRows: 0, changed: false, needsRecalc: false };
  if (!lg || !doc) return report;
  lg.teams = Array.isArray(lg.teams) ? lg.teams : [];
  lg.schedule = Array.isArray(lg.schedule) ? lg.schedule : [];

  const c = doc.competition || {};
  if (opts.updateMeta !== false) {
    if (c.name && !lg.name) { lg.name = c.name; report.changed = true; }
    if (c.season && lg.season !== c.season && opts.adoptSeason) { lg.season = c.season; report.changed = true; }
    if (c.game && !lg.game) { lg.game = c.game; report.changed = true; }
  }

  // Divisions: created on first sight, by name.
  const ensureDivision = (name) => {
    if (!name) return '';
    lg.divisions = Array.isArray(lg.divisions) ? lg.divisions : [];
    let d = lg.divisions.find((x) => x && normName(x.name) === normName(name));
    if (!d) { d = { id: uid('dv'), name }; lg.divisions.push(d); report.changed = true; }
    return d.id;
  };

  // Team lookup: by source id, then exact name, then normalised name.
  const docTeamsById = {};
  (doc.teams || []).forEach((t) => { if (t.id) docTeamsById[t.id] = t; });
  const findTeam = (ref) => {
    const raw = str(ref, 120); if (!raw) return null;
    const byExt = lg.teams.find((t) => t.extId && t.extId === raw);
    if (byExt) return byExt;
    const named = docTeamsById[raw] ? docTeamsById[raw].name : raw;
    const exact = lg.teams.find((t) => str(t.teamName || t.name) === named);
    if (exact) return exact;
    const n = normName(named);
    return n ? (lg.teams.find((t) => normName(t.teamName || t.name) === n) || null) : null;
  };
  const upsertTeam = (t) => {
    let tm = (t.id && lg.teams.find((x) => x.extId === t.id)) || findTeam(t.name);
    if (!tm) {
      tm = { id: uid('tm'), teamName: t.name };
      lg.teams.push(tm);
      report.teamsCreated.push(t.name);
      report.changed = true;
    } else report.teamsMatched++;
    const set = (k, v) => { if (v && tm[k] !== v) { tm[k] = v; report.changed = true; } };
    set('extId', t.id);
    // Branding from the source only fills gaps — it never overwrites a crest the producer set.
    if (t.logo && !tm.logo) set('logo', t.logo);
    if (t.abbr && !tm.abbr) set('abbr', t.abbr);
    if (t.color && !tm.color) set('color', t.color);
    if (t.division) set('divisionId', ensureDivision(t.division));
    if (Array.isArray(t.players)) {
      const prev = Array.isArray(tm.players) ? tm.players : [];
      const next = t.players.map((p) => {
        const old = prev.find((x) => (p.id && x.extId === p.id) || normName(x.name) === normName(p.name)) || {};
        return { ...old, id: old.id || uid('pl'), extId: p.id || old.extId || '', name: p.name, role: p.role || old.role || '', photo: p.photo || old.photo || '', country: p.country || old.country || '' };
      });
      if (JSON.stringify(next) !== JSON.stringify(prev)) { tm.players = next; report.changed = true; }
    }
    return tm;
  };
  (doc.teams || []).forEach(upsertTeam);
  const teamFor = (ref) => findTeam(ref) || upsertTeam({ id: docTeamsById[ref] ? docTeamsById[ref].id : '', name: docTeamsById[ref] ? docTeamsById[ref].name : str(ref, 120) });

  const pairKey = (m) => [m.teamA, m.teamB, m.week || '', m.date || ''].join('|');
  const seen = new Set();
  (doc.matches || []).forEach((dm) => {
    const ta = teamFor(dm.teamA), tb = teamFor(dm.teamB);
    if (!ta || !tb || ta.id === tb.id) return;
    const want = { teamA: ta.id, teamB: tb.id, week: dm.week, date: dm.date };
    let m = dm.id ? lg.schedule.find((x) => x.extId === dm.id) : null;
    // Without a source id, match on the pairing (either orientation) + week/date.
    let flipped = false;
    if (!m && !dm.id) {
      m = lg.schedule.find((x) => !x.extId && pairKey(x) === pairKey(want));
      if (!m) {
        m = lg.schedule.find((x) => !x.extId && pairKey(x) === pairKey({ ...want, teamA: tb.id, teamB: ta.id }));
        flipped = !!m;
      }
    }
    const isNew = !m;
    if (isNew) {
      m = { id: uid('m'), teamA: ta.id, teamB: tb.id, format: '', week: '', date: '', time: '', result: { scoreA: null, scoreB: null, ot: false }, games: [], src: 'sync' };
      lg.schedule.push(m);
    }
    const before = JSON.stringify(m);
    if (dm.id) m.extId = dm.id;
    if (!flipped) { m.teamA = ta.id; m.teamB = tb.id; }
    const A = flipped ? 'scoreB' : 'scoreA', B = flipped ? 'scoreA' : 'scoreB';
    if (dm.week) m.week = dm.week;
    if (dm.date) m.date = dm.date;
    if (dm.time) m.time = dm.time;
    if (dm.round) m.round = dm.round;
    if (dm.bestOf) m.format = 'bo' + dm.bestOf;
    if (dm.stream) m.stream = dm.stream;
    const q = { onStream: dm.onStream || undefined, queuePos: dm.queuePos != null ? dm.queuePos : undefined, featured: dm.featured || undefined, streamName: dm.streamName || undefined };
    for (const k of Object.keys(q)) {
      if (q[k] === undefined) { if (k in m) { delete m[k]; report.changed = true; } }
      else if (m[k] !== q[k]) { m[k] = q[k]; report.changed = true; }
    }
    m.result = m.result || { scoreA: null, scoreB: null, ot: false };
    // The app just recorded this match and sent it to the source; a document fetched before that
    // report landed must not roll the result back (standings went backwards until the next change).
    // Held only while the source has fewer games than we do; once it catches up it wins again.
    const localGames = (m.games || []).length;
    const docGames = (dm.games || []).length;
    const held = opts.protect && m.id && opts.protect(m) && docGames < localGames;
    if (held) { seen.add(m.id); report.held = (report.held || 0) + 1; return; }
    if (dm.games && dm.games.length) {
      m.games = dm.games.map((g) => (flipped ? { scoreA: g.scoreB, scoreB: g.scoreA } : { scoreA: g.scoreA, scoreB: g.scoreB }));
    }
    if (dm.scoreA != null && dm.scoreB != null) { m.result[A] = dm.scoreA; m.result[B] = dm.scoreB; }
    else if (dm.status === 'scheduled' && !(dm.games && dm.games.length)) { m.result.scoreA = null; m.result.scoreB = null; }
    m.result.ot = !!dm.overtime;
    // Only the non-derivable statuses are stored; scheduled/completed follow from the result.
    const st = dm.status === 'live' || dm.status === 'cancelled' || dm.status === 'postponed' ? dm.status : '';
    if (st) m.status = st; else delete m.status;
    seen.add(m.id);
    if (isNew) { report.matchesAdded++; report.changed = true; }
    else if (JSON.stringify(m) !== before) { report.matchesUpdated++; report.changed = true; }
  });

  if (opts.prune && doc.matches) {
    const keep = lg.schedule.filter((m) => m.src !== 'sync' || seen.has(m.id));
    report.matchesRemoved = lg.schedule.length - keep.length;
    if (report.matchesRemoved) { lg.schedule = keep; report.changed = true; }
  }

  if (doc.standings && doc.standings.length) {
    // A standings table from the source IS the record — keep Recalculate from wiping it.
    const rows = [];
    doc.standings.forEach((s) => {
      const tm = teamFor(s.team); if (!tm) return;
      if (s.division) tm.divisionId = ensureDivision(s.division);
      rows.push({ s, tm });
    });
    rows.sort((x, y) => (x.s.rank != null && y.s.rank != null ? x.s.rank - y.s.rank : 0));
    const next = rows.map(({ s, tm }) => {
      const prev = (lg.standings || []).find((r) => r.teamId === tm.id) || {};
      return {
        ...prev, teamId: tm.id, w: s.wins, l: s.losses, t: s.draws,
        pts: s.points != null ? s.points : (prev.pts || 0), ptsLocked: s.points != null,
        subW: s.gameWins != null ? s.gameWins : (prev.subW || 0), subL: s.gameLosses != null ? s.gameLosses : (prev.subL || 0),
      };
    });
    if (JSON.stringify(next) !== JSON.stringify(lg.standings || [])) { lg.standings = next; report.changed = true; }
    if (lg.standingsMode !== 'manual') { lg.standingsMode = 'manual'; report.changed = true; }
    report.standingsRows = next.length;
  } else if ((report.matchesAdded || report.matchesUpdated || report.matchesRemoved) && lg.standingsMode !== 'manual') {
    report.needsRecalc = true;
  }
  return report;
}

// ── Export ───────────────────────────────────────────────────────────────────
// resolveTeam(tm) → { name, logo } (server passes the team-library resolver). data: URI logos are
// dropped from exports — they are megabytes, and no outside system can use an embedded blob.
function matchStatus(m, liveIds) {
  if (liveIds && liveIds.has(m.id)) return 'live';
  if (m.status === 'live' || m.status === 'cancelled' || m.status === 'postponed') return m.status;
  const r = m.result || {};
  if ((Array.isArray(m.games) && m.games.length) || (r.scoreA != null && r.scoreB != null)) return 'completed';
  return 'scheduled';
}
function seriesScore(m) {
  const games = Array.isArray(m.games) ? m.games.filter((g) => g && g.scoreA != null && g.scoreB != null) : [];
  if (games.length) {
    return { a: games.filter((g) => Number(g.scoreA) > Number(g.scoreB)).length, b: games.filter((g) => Number(g.scoreB) > Number(g.scoreA)).length };
  }
  const r = m.result || {};
  return { a: r.scoreA != null ? Number(r.scoreA) : null, b: r.scoreB != null ? Number(r.scoreB) : null };
}
const urlOnly = (v) => (v && typeof v === 'string' && !/^data:/i.test(v) ? v : '');

function leagueToDoc(lg, resolveTeam) {
  const rt = resolveTeam || ((tm) => ({ name: (tm && (tm.teamName || tm.name)) || '', logo: tm && tm.logo }));
  const teamsById = {};
  (lg.teams || []).forEach((t) => { if (t && t.id) teamsById[t.id] = t; });
  const divName = (id) => { const d = (lg.divisions || []).find((x) => x && x.id === id); return d ? d.name : ''; };
  const idOf = (tm) => (tm ? (tm.extId || tm.id) : '');
  const nameOf = (id, fb) => (teamsById[id] ? rt(teamsById[id]).name : (fb || ''));
  const teams = (lg.teams || []).map((tm) => {
    const r = rt(tm);
    const o = { id: idOf(tm), name: r.name };
    if (tm.abbr) o.abbr = tm.abbr;
    const logo = urlOnly(r.logo) || urlOnly(tm.logo); if (logo) o.logo = logo;
    if (tm.color) o.color = tm.color;
    if (tm.divisionId && divName(tm.divisionId)) o.division = divName(tm.divisionId);
    return o;
  });
  const matches = (lg.schedule || []).map((m) => {
    const sc = seriesScore(m);
    const o = { id: m.extId || m.id, teamA: idOf(teamsById[m.teamA]) || nameOf(m.teamA, m.sggTeamA), teamB: idOf(teamsById[m.teamB]) || nameOf(m.teamB, m.sggTeamB),
      teamAName: nameOf(m.teamA, m.sggTeamA), teamBName: nameOf(m.teamB, m.sggTeamB), status: matchStatus(m) };
    if (m.date) o.date = m.date;
    if (m.time) o.time = m.time;
    if (m.week) o.week = String(m.week);
    if (m.round) o.round = m.round;
    const bo = parseBestOf(m.format); if (bo) o.bestOf = bo;
    if (sc.a != null && sc.b != null) { o.scoreA = sc.a; o.scoreB = sc.b; }
    if (Array.isArray(m.games) && m.games.length) o.games = m.games.map((g) => ({ scoreA: g.scoreA, scoreB: g.scoreB }));
    if (m.result && m.result.ot) o.overtime = true;
    if (m.stream) o.stream = m.stream;
    return o;
  });
  const standings = (lg.standings || []).map((s, i) => {
    const tm = teamsById[s.teamId]; if (!tm) return null;
    const o = { team: idOf(tm), teamName: rt(tm).name, rank: i + 1, wins: s.w || 0, losses: s.l || 0, draws: s.t || 0, points: s.pts || 0 };
    if (s.subW != null || s.subL != null) { o.gameWins = s.subW || 0; o.gameLosses = s.subL || 0; }
    if (tm.divisionId && divName(tm.divisionId)) o.division = divName(tm.divisionId);
    return o;
  }).filter(Boolean);
  return {
    format: FORMAT, version: VERSION,
    competition: { id: lg.id, name: lg.name || '', season: lg.season || '', game: lg.game || '', type: 'league' },
    teams, matches, standings,
  };
}

// ── Live broadcast feed ─────────────────────────────────────────────────────
// The compact slice every scene reads (state.compFeed, LIVE tier). Kept small on purpose: logos
// for teams in the team library are NOT inlined (overlays already hold savedTeams and resolve by
// name); only a league-only team's own logo travels, once, in `logos`.
//   live     — marked live, or the fixture the producer armed for capture / has on air
//   upcoming — not played yet, soonest first (undated fixtures after dated ones)
//   done     — has a result, most recent first
function startsAtMs(m) {
  if (!m.date) return null;
  const t = m.time && /^\d{1,2}:\d{2}/.test(m.time) ? m.time : '23:59';
  const d = new Date(`${m.date}T${t.length === 4 ? '0' + t : t}`);
  return isNaN(d.getTime()) ? null : d.getTime();
}
function buildFeed(lg, opts = {}) {
  if (!lg) return null;
  const rt = opts.resolveTeam || ((tm) => ({ name: (tm && (tm.teamName || tm.name)) || '', logo: tm && tm.logo, linked: false }));
  const liveIds = opts.liveIds || new Set();
  const maxUpcoming = opts.maxUpcoming || 10, maxDone = opts.maxDone || 8;
  const teamsById = {};
  (lg.teams || []).forEach((t) => { if (t && t.id) teamsById[t.id] = t; });
  // compFeed rides EVERY live broadcast, so embedded logos are budgeted: a URL is free, a data: URI
  // must be small (uploads are downscaled to ~20-60KB) and the whole map stays under ~300KB.
  const logos = {};
  let logoBytes = 0;
  const side = (id, fallback) => {
    const tm = teamsById[id];
    if (!tm) return { name: fallback || 'TBD', abbr: '' };
    const r = rt(tm);
    if (!r.linked && r.logo && !(r.name in logos)) {
      const len = String(r.logo).length;
      const isData = /^data:/i.test(r.logo);
      if (!isData || (len <= 80000 && logoBytes + len <= 300000)) { logos[r.name] = r.logo; if (isData) logoBytes += len; }
    }
    return { name: r.name || fallback || 'TBD', abbr: tm.abbr || '' };
  };
  const rows = (lg.schedule || []).map((m, idx) => {
    const status = matchStatus(m, liveIds);
    if (status === 'cancelled') return null;
    const a = side(m.teamA, m.sggTeamA), b = side(m.teamB, m.sggTeamB);
    const sc = seriesScore(m);
    const done = status === 'completed';
    return {
      id: m.id, idx,
      status: status === 'live' ? 'live' : done ? 'done' : 'upcoming',
      postponed: status === 'postponed' || undefined,
      teamA: a.name, teamB: b.name, abbrA: a.abbr, abbrB: b.abbr,
      scoreA: sc.a, scoreB: sc.b,
      winSide: done && sc.a != null && sc.b != null && sc.a !== sc.b ? (sc.a > sc.b ? 'a' : 'b') : '',
      round: m.round || (m.week ? 'Week ' + m.week : ''), week: m.week || '',
      date: m.date || '', time: m.time || '', startsAt: startsAtMs(m),
      bestOf: parseBestOf(m.format) || null, stream: m.stream || '',
    };
  }).filter(Boolean);
  const live = rows.filter((r) => r.status === 'live');
  const upcoming = rows.filter((r) => r.status === 'upcoming')
    .sort((x, y) => (x.startsAt == null) - (y.startsAt == null) || (x.startsAt || 0) - (y.startsAt || 0) || x.idx - y.idx)
    .slice(0, maxUpcoming);
  const done = rows.filter((r) => r.status === 'done')
    .sort((x, y) => (y.startsAt || 0) - (x.startsAt || 0) || y.idx - x.idx)
    .slice(0, maxDone);
  const clean = (r) => { const o = { ...r }; delete o.idx; if (!o.postponed) delete o.postponed; return o; };
  const title = [lg.name, lg.season].filter(Boolean).join(' — ');
  return {
    leagueId: lg.id, name: lg.name || '', season: lg.season || '', title, game: lg.game || '',
    live: live.map(clean), upcoming: upcoming.map(clean), results: done.map(clean),
    next: clean(live[0] || upcoming[0] || { id: '', status: '' }),
    logos,
  };
}

// ── JSON Schema (served at /api/v1/schema, embedded in the docs) ────────────
const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'ne-competition/v1',
  title: 'Broadcast Studio competition document',
  type: 'object',
  properties: {
    format: { const: FORMAT },
    version: { const: VERSION },
    competition: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, season: { type: 'string' }, game: { type: 'string' }, logo: { type: 'string', format: 'uri' }, website: { type: 'string', format: 'uri' } } },
    teams: { type: 'array', items: { type: 'object', required: ['name'], properties: {
      id: { type: 'string', description: 'Your stable id for the team. Matches may reference it.' },
      name: { type: 'string' }, abbr: { type: 'string', maxLength: 12 }, logo: { type: 'string', format: 'uri' },
      color: { type: 'string', pattern: '^#?[0-9a-fA-F]{6}$' }, division: { type: 'string' } } } },
    matches: { type: 'array', items: { type: 'object', required: ['teamA', 'teamB'], properties: {
      id: { type: 'string', description: 'Your stable id for the match. Strongly recommended — it is how updates find the same fixture.' },
      teamA: { type: 'string', description: 'Team id or team name' }, teamB: { type: 'string', description: 'Team id or team name' },
      scheduledAt: { type: 'string', format: 'date-time' }, date: { type: 'string', description: 'YYYY-MM-DD (alternative to scheduledAt)' }, time: { type: 'string', description: 'HH:MM 24h (alternative to scheduledAt)' },
      week: { type: 'string' }, round: { type: 'string' }, bestOf: { type: 'integer', minimum: 1 },
      status: { enum: MATCH_STATUSES },
      scoreA: { type: ['integer', 'null'] }, scoreB: { type: ['integer', 'null'] },
      games: { type: 'array', items: { type: 'object', properties: { scoreA: { type: 'integer' }, scoreB: { type: 'integer' }, map: { type: 'string' } } } },
      overtime: { type: 'boolean' }, stream: { type: 'string' } } } },
    standings: { type: 'array', description: 'Optional. Omit it and standings are calculated from match results.', items: { type: 'object', required: ['team'], properties: {
      team: { type: 'string' }, rank: { type: 'integer' }, wins: { type: 'integer' }, losses: { type: 'integer' }, draws: { type: 'integer' },
      points: { type: 'number' }, gameWins: { type: 'integer' }, gameLosses: { type: 'integer' }, division: { type: 'string' } } } },
  },
};

module.exports = {
  FORMAT, VERSION, MATCH_STATUSES, SCHEMA,
  normName, parseCsv, rowsToObjects, tablesToDoc, csvToDoc, validateDoc, applyDoc,
  leagueToDoc, buildFeed, matchStatus, seriesScore, parseStatus, parseBestOf,
};
