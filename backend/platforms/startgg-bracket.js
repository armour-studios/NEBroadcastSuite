// backend/platforms/startgg-bracket.js — moved out of server.js (refactor step 3) unchanged; server.js creates it once
// with createStartggBracket(ctx). ctx carries stable references plus live getters (ctx.<name>) for values
// server.js replaces at runtime, and set_<name>(v) for the ones this code writes.
module.exports = function createStartggBracket(ctx) {
  const { https, createStartGgClient, teamDb, state, upsertPlayerProfile } = ctx;

// ─── Start.gg bracket ────────────────────────────────────────────────────────
// Strip ALL whitespace, not just leading/trailing — a slug/URL never legitimately contains a space,
// but a paste from a webpage/Discord/PDF selection can easily carry one in the MIDDLE (a wrapped
// line, a stray character next to a link). A plain .trim() leaves that untouched, and the slug regexes
// below stop matching right at it with no error — the paste just silently "doesn't work".
function _stripStartggWhitespace(input) {
  return (input || '').replace(/\s+/g, '');
}
function parseEventSlug(input) {
  const s = _stripStartggWhitespace(input);
  if (!s) return '';
  // Accept a full start.gg URL or a bare slug
  const m = s.match(/tournament\/[^/]+\/event\/[^/?#]+/i);
  return m ? m[0] : s;
}

// Parse any start.gg input — a tournament URL (e.g. .../tournament/100-genesis-cup-38/details),
// a full event URL (.../tournament/x/event/y), a bare "tournament/x" slug, or a plain slug.
// Returns { tournamentSlug, eventSlug } (eventSlug = full "tournament/x/event/y" path or '').
function parseStartggInput(input) {
  const s = _stripStartggWhitespace(input).replace(/^https?:\/\/(www\.)?start\.gg\//i, '');
  if (!s) return { tournamentSlug: '', eventSlug: '' };
  const ev = s.match(/tournament\/([^/?#]+)\/event\/([^/?#]+)/i);
  if (ev) return { tournamentSlug: ev[1], eventSlug: `tournament/${ev[1]}/event/${ev[2]}` };
  const t = s.match(/tournament\/([^/?#]+)/i);
  if (t) return { tournamentSlug: t[1], eventSlug: '' };
  // Bare token — assume it's a tournament slug.
  return { tournamentSlug: s.split(/[/?#]/)[0], eventSlug: '' };
}

// Maintain the lowercased name→logo map from a list of Start.gg entrants so the
// stream queue, upcoming overlay and bracket can all show team logos.
function indexEntrantLogos(entrants) {
  (entrants || []).forEach((ent) => {
    const name = (ent && ent.name || '').trim().toLowerCase();
    const logo = ctx.pickEntrantLogo(ent);
    if (name && logo) state.startgg.logoMap[name] = logo;
  });
}

// Best known logo for a team name: prefer a saved-team custom logo, then the
// start.gg logoMap captured at load time.
// Short tag for a team, from wherever the producer set one: the working library, the imported
// event teams, then the vault (which remembers it under every alias). Mirrors logoForTeamName so
// a tag banked once follows the team onto every side it is applied to - queue clicks, bracket Go
// Live, auto-fill from stream and the game's own team names all route through set_team and get
// it for free. null = nothing set; overlays then fall back to initials.
function cleanTeamAbbr(v) { return String(v || '').trim().toUpperCase().slice(0, 6) || null; }
function abbrForTeamName(name) {
  const key = (name || '').trim().toLowerCase();
  if (!key) return null;
  const saved = ctx.savedTeams.find((t) => t && (t.name || '').trim().toLowerCase() === key);
  if (saved && saved.abbr) return cleanTeamAbbr(saved.abbr);
  const ev = ((state.startgg && state.startgg.eventTeams) || []).find((t) => t && (t.name || '').trim().toLowerCase() === key);
  if (ev && ev.abbr) return cleanTeamAbbr(ev.abbr);
  if (state.teamVault && state.teamVault.enabled) {
    try {
      const hit = teamDb.resolve({ name });
      if (hit.rec && hit.rec.abbr) return cleanTeamAbbr(hit.rec.abbr);
    } catch (_) {}
  }
  return null;
}

function logoForTeamName(name) {
  const key = (name || '').trim().toLowerCase();
  if (!key) return null;
  const saved = ctx.savedTeams.find((t) => (t.name || '').trim().toLowerCase() === key);
  if (saved && saved.logo) return saved.logo;
  const fromEvent = state.startgg.logoMap[key];
  if (fromEvent) return fromEvent;
  // Last resort: the team vault, which remembers a crest under EVERY name this org has competed
  // under. That's what makes a producer's one-time logo upload keep working after a rebrand, and
  // for events where start.gg has no crest at all.
  if (state.teamVault && state.teamVault.enabled) {
    try {
      const hit = teamDb.resolve({ name });
      if (hit.rec && hit.rec.logo) return hit.rec.logo;
    } catch (_) {}
  }
  return null;
}

// Swap everything that belongs to a TEAM between the blue and orange sides: names/logos/colours,
// series score, active/observed player, Smash/Brawlhalla seats, and an armed league capture's
// orientation. The Swap button, and CS2 when the game reports that the teams changed sides.
function swapTeamSides() {
  // Swap names/logos
  const tempTeams = { ...state.teams.blue };
  state.teams.blue = { ...state.teams.orange };
  state.teams.orange = tempTeams;
  
  // Swap series scores
  const tempSeries = state.series.blue;
  state.series.blue = state.series.orange;
  state.series.orange = tempSeries;

  // Swap the active/on-air player so each side keeps its selection across the swap.
  const tempActive = state.activePlayer.blue;
  state.activePlayer.blue = state.activePlayer.orange;
  state.activePlayer.orange = tempActive;
  // The observed player travels with their team.
  if (state.observedPlayer && state.observedPlayer.side) {
    state.observedPlayer.side = state.observedPlayer.side === 'blue' ? 'orange' : 'blue';
  }

  // Smash stocks/fighters/crew follow their team across the swap.
  if (state.smash) {
    const tmpS = state.smash.blue;
    state.smash.blue = state.smash.orange;
    state.smash.orange = tmpS;
  }

  // Same for Brawlhalla — stocks, legends and each seat's linked ranked card belong to the
  // PLAYER, so they travel with them. Leaving them behind puts the other side's ELO under a
  // player's name, which is worse than a wrong stock count because it looks authoritative.
  if (state.brawlhalla) {
    const tmpB = state.brawlhalla.blue;
    state.brawlhalla.blue = state.brawlhalla.orange;
    state.brawlhalla.orange = tmpB;
  }

  // Team records need no swapping now: both auto (stats/startgg) and manual (manualByName) are
  // keyed by team NAME, so they follow the team across the swap automatically.

  // An armed league capture maps the live blue/orange scores onto the fixture's team A/B via
  // aSide. Producers swap when the teams change colour between games, so after a swap team A's
  // score comes from the other colour; without this every later game was recorded backwards.
  if (state.leagueCapture && state.leagueCapture.active) {
    state.leagueCapture.aSide = state.leagueCapture.aSide === 'orange' ? 'blue' : 'orange';
  }

}

// Auto team names from the live game: when enabled, apply a game-reported team name to a
// side, matching the saved-teams library to pull the correct logo/colour. Generic in-game
// names (CT/T/Blue/Orange/etc.) are ignored. Returns true if anything changed.
const GENERIC_TEAM_RE = /^(counter-?terrorists?|terrorists?|team\s*(ct|t)|ct|t|blue(\s*team)?|orange(\s*team)?|red(\s*team)?|home|away|team\s*[ab12]|dire|radiant|spectator|unknown)$/i;
function applyGameTeamName(side, rawName) {
  if (!state.autoTeamsFromGame) return false;
  const name = String(rawName == null ? '' : rawName).trim();
  if (!name || GENERIC_TEAM_RE.test(name)) return false;
  const t = state.teams[side];
  if (!t) return false;
  const key = name.toLowerCase();
  const saved = ctx.savedTeams.find((s) => String(s.name || '').trim().toLowerCase() === key);
  const nm = saved ? saved.name : name;
  let changed = false;
  if (t.name !== nm) { t.name = nm; changed = true; }
  if (saved && saved.logo && t.logo !== saved.logo) { t.logo = saved.logo; changed = true; }
  if (saved && saved.color && t.color !== saved.color) { t.color = saved.color; changed = true; }
  // The tag follows the team too - the previous side's abbreviation must not outlive its team.
  const abbr = abbrForTeamName(nm);
  if ((t.abbr || null) !== abbr) { t.abbr = abbr; changed = true; }
  return changed;
}

// The overlay round label is only ever WRITTEN from a pushed start.gg set (syncStartGgSet). The
// on-air TEAMS, though, change by several other routes — auto-teams-from-game, Autofill from the
// stream queue, a manual Match-panel pick — and none of them touched the label, so the previous
// set's round stayed on screen over the new teams (producer saw "WINNERS QUARTER-FINAL" burned over
// a Winners Round 3 match). Re-bind an auto-derived label to whoever is actually on air: adopt the
// round of the queued set those two teams are in, and clear it if they're in no queued set at all
// (an empty label hides the strip — always better than confidently naming the wrong round).
// A hand-typed label or a preset is left completely alone.
//
// This follows whichever platform is ACTIVE (start.gg / Challonge / NXGEN) — reading start.gg's
// queue while a Challonge/NXGEN event is on air left the previous start.gg event's round burned
// on the overlay (a stale "SEMIFINALS" that nothing could clear).
function activePlatformSets() {
  const p = (state.activeEvent && state.activeEvent.platform) || 'startgg';
  if (p === 'challonge') return { platform: p, sets: state.challonge.queue || [] };
  if (p === 'nxgen')     return { platform: p, sets: state.nxgen.queue || [] };
  if (p === 'faceit')    return { platform: p, sets: state.faceit.queue || [] };
  if (p === 'challengermode') return { platform: p, sets: state.challengermode.queue || [] };
  return { platform: 'startgg', sets: [...(state.startgg.queue || []), ...(state.startgg.matchFeed || [])] };
}
// start.gg carries real round TEXT ("Winners Finals"); Challonge and NXGEN only give a round
// NUMBER (Challonge negatives = losers side), so label those plainly. A wrong "SEMIFINALS" on
// air is worse than an honest "ROUND 3".
function platformRoundLabel(platform, round) {
  if (round == null || round === '') return '';
  // Challengermode names its rounds properly ("Upper Semifinal", "Grand Final"), so it gets the
  // same treatment as start.gg rather than being reduced to "ROUND 3".
  if (platform === 'startgg' || platform === 'challengermode') return String(round).toUpperCase();
  const n = Number(round);
  if (!Number.isFinite(n) || n === 0) return String(round).toUpperCase();
  if (platform === 'challonge' && n < 0) return 'LOSERS ROUND ' + Math.abs(n);
  return 'ROUND ' + Math.abs(n);
}
function retuneRoundLabel() {
  if (!state.startgg.roundLabelAuto) return false;
  const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
  const a = norm(state.teams.blue && state.teams.blue.name);
  const b = norm(state.teams.orange && state.teams.orange.name);
  // Half-resolved matchups (TBD opponent) can't identify a set — leave the label as-is.
  if (!a || !b || a === 'tbd' || b === 'tbd') return false;
  const { platform, sets } = activePlatformSets();
  // No queue loaded yet (fresh boot — queues are transient and refetch on the first poll)
  // means "not found" proves nothing. Never clear a label on absence of evidence.
  if (!sets.length) return false;
  const pairIs = (x, y) => {
    const nx = norm(x); const ny = norm(y);
    return (nx === a && ny === b) || (nx === b && ny === a);   // side order is a producer choice
  };
  const hit = sets.find((s) => pairIs(s.teamA, s.teamB));
  const next = hit ? platformRoundLabel(platform, hit.round) : '';
  if (next === (state.roundLabel || '')) return false;
  state.roundLabel = next;
  state.startgg.roundLabelSetId = hit ? (hit.setId || hit.matchId || null) : null;
  return true;
}

// Turn a flat list of Start.gg sets — all from ONE pool/phaseGroup — into a
// structured, type-aware bracket. Round Robin pools also get a head-to-head
// matrix and enriched standings (Sets Played/Set Count/Game Count) to match
// how Start.gg itself presents Pool Play; elimination standings stay plain.
// Team-name matching for the bracket's "find a team" box. Punctuation/space-insensitive, and
// ranked so a typed name resolves to ONE team: exact > prefix > whole word > substring.
function bracketNormName(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function bracketNameScore(name, qNorm) {
  const n = bracketNormName(name);
  if (!n || !qNorm || n === 'tbd') return -1;
  if (n === qNorm) return 100;
  if (n.startsWith(qNorm + ' ')) return 70;
  if ((' ' + n + ' ').indexOf(' ' + qNorm + ' ') >= 0) return 50;
  if (n.indexOf(qNorm) >= 0) return 30;
  // Last resort: a typed typo ("TARNSHIED"). Only accepted when it's close to the WHOLE name
  // or to one of its words, so it can never quietly pick an unrelated team.
  const near = (a, bStr) => bracketEditDistance(a, bStr) <= (a.length <= 5 ? 1 : 2);
  if (near(qNorm, n) || n.split(' ').some((w) => w.length > 3 && near(qNorm, w))) return 10;
  return -1;
}
function bracketEditDistance(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function buildBracket(sets, advancesTo) {
  const list = Array.isArray(sets) ? sets : [];

  // Dominant bracket type across the sets (a pool's sets are normally all one
  // type; we pick the most common just in case of stray mixed data).
  const typeCounts = {};
  list.forEach((s) => {
    const t = s.phaseGroup && s.phaseGroup.bracketType;
    if (t) typeCounts[t] = (typeCounts[t] || 0) + 1;
  });
  const type = Object.keys(typeCounts).sort((a, b) => typeCounts[b] - typeCounts[a])[0] || '';

  // start.gg's bracketType is NOT reliable on its own. A hand-built playoff stage — which is how
  // most "Day 2 Championship Playoffs" phases are made — comes back as CUSTOM_SCHEDULE, and the old
  // test (!type || SINGLE || DOUBLE) sent it down the swiss/round-robin path: winners, losers and
  // finals all returned EMPTY, so bracket.html had no tree to draw and fell through to its standings
  // table. bracket.html already knew CUSTOM_SCHEDULE was ambiguous and infers the real format from
  // the data (see fmtType there) — but the structure had been discarded here before it ever arrived.
  //
  // So: trust the type when it is unambiguous, and otherwise read the SETS. A tree carries structure
  // a swiss round never does — a negative round number (the losers band), a "Grand Final", or a slot
  // seeded from ANOTHER SET. Swiss and round-robin pairings are seeded from standings, never from a
  // specific set, so this cannot misread one of those as a bracket.
  const ELIM_TYPES = ['SINGLE_ELIMINATION', 'DOUBLE_ELIMINATION', 'ELIMINATION_ROUNDS'];
  const NON_ELIM_TYPES = ['ROUND_ROBIN', 'SWISS', 'MATRIX', 'EXHIBITION', 'RACE', 'CIRCUIT'];
  const looksLikeTree = () => list.some((s) =>
    Number(s.round) < 0 ||
    /grand\s*final/i.test(s.fullRoundText || '') ||
    (s.slots || []).some((sl) => sl && sl.prereqType === 'set'));
  const isElim = ELIM_TYPES.includes(type) ? true
               : NON_ELIM_TYPES.includes(type) ? false
               : (!type || looksLikeTree());
  if (type && !ELIM_TYPES.includes(type) && !NON_ELIM_TYPES.includes(type)) {
    console.log('[bracket] ' + type + ' phase read as ' +
      (isElim ? 'an ELIMINATION bracket' : 'a schedule') + ' from its ' + list.length + ' set(s).');
  }

  const mapSlot = (slot, set) => {
    const ent = slot && slot.entrant;
    const scoreVal = slot && slot.standing && slot.standing.stats && slot.standing.stats.score
      ? slot.standing.stats.score.value : null;
    return {
      name: (ent && ent.name) || 'TBD',
      score: (typeof scoreVal === 'number' && scoreVal >= 0) ? scoreVal : null,
      winner: !!(ent && set.winnerId && ent.id === set.winnerId)
    };
  };

  // Live standings (used for round-robin / swiss, computed from results). For
  // non-elimination pools this also tallies Sets Played/Total, Set Wins-Losses
  // and Game Wins-Losses — the exact stat columns Start.gg's own Pool/Swiss
  // standings tables show, derived entirely from data already fetched (no
  // extra API round-trip).
  const standingsMap = new Map();
  list.forEach((s) => {
    const slots = s.slots || [];
    const e0 = slots[0] && slots[0].entrant;
    const e1 = slots[1] && slots[1].entrant;
    const sc0 = slots[0] && slots[0].standing && slots[0].standing.stats && slots[0].standing.stats.score
      ? slots[0].standing.stats.score.value : null;
    const sc1 = slots[1] && slots[1].standing && slots[1].standing.stats && slots[1].standing.stats.score
      ? slots[1].standing.stats.score.value : null;
    [e0, e1].forEach((e) => {
      if (e && e.id && !standingsMap.has(e.id)) {
        standingsMap.set(e.id, { id: e.id, name: e.name, wins: 0, losses: 0, setsPlayed: 0, setsTotal: 0, gameWins: 0, gameLosses: 0 });
      }
    });
    if (e0 && e0.id) standingsMap.get(e0.id).setsTotal++;
    if (e1 && e1.id) standingsMap.get(e1.id).setsTotal++;
    if (s.winnerId && e0 && e1) {
      const winId = s.winnerId;
      const win = winId === e0.id ? e0 : (winId === e1.id ? e1 : null);
      const lose = winId === e0.id ? e1 : (winId === e1.id ? e0 : null);
      if (win && standingsMap.has(win.id)) { standingsMap.get(win.id).wins++; standingsMap.get(win.id).setsPlayed++; }
      if (lose && standingsMap.has(lose.id)) { standingsMap.get(lose.id).losses++; standingsMap.get(lose.id).setsPlayed++; }
      const gw0 = (typeof sc0 === 'number' && sc0 >= 0) ? sc0 : 0;
      const gw1 = (typeof sc1 === 'number' && sc1 >= 0) ? sc1 : 0;
      if (e0 && e0.id) { standingsMap.get(e0.id).gameWins += gw0; standingsMap.get(e0.id).gameLosses += gw1; }
      if (e1 && e1.id) { standingsMap.get(e1.id).gameWins += gw1; standingsMap.get(e1.id).gameLosses += gw0; }
    }
  });
  const standingsRaw = [...standingsMap.values()]
    .sort((a, b) => (b.wins - a.wins) || (a.losses - b.losses) || a.name.localeCompare(b.name));
  const standings = standingsRaw.map((s, i) => {
    // played=false → the overlay shows '–' instead of a rank so an unstarted event never
    // implies alphabetical seeding is a real placement.
    const row = { placement: i + 1, name: s.name, wins: s.wins, losses: s.losses, played: s.setsPlayed > 0 };
    if (!isElim) {
      row.setsPlayed = s.setsPlayed;
      row.setsTotal = s.setsTotal;
      row.setWins = s.wins;
      row.setLosses = s.losses;
      row.gameWins = s.gameWins;
      row.gameLosses = s.gameLosses;
    }
    return row;
  });
  const roster = standingsRaw.map((s) => s.name);

  // Origin pill ("Day 1 A25: Winners") — only for slots seeded from a PREVIOUS phase
  // (prereqType 'seed' + a progressionSource). Within-bracket slots (prereqType 'set')
  // are covered by the connectors; first-phase seeds have no progression to show.
  const originName = (slot) => {
    if (!slot || slot.prereqType !== 'seed') return undefined;
    const sd = slot.seed;
    return (sd && sd.progressionSource && sd.placeholderName) ? sd.placeholderName : undefined;
  };

  // Group sets into rounds — shared by the elimination split below AND the Swiss/Round-Robin
  // schedule (each round's pairings), so both read the exact same {name,round,sets} shape.
  const isGrandFinal = (s) => /grand\s*final/i.test(s.fullRoundText || '');
  // start.gg set identifier ("A".."Z","AA"..) → a sortable number. Null for anything that isn't a
  // plain letter sequence (manual/Challonge-built brackets have none) — those fall back to the
  // feeder-tree ordering below, exactly as before.
  const identKey = (s) => {
    const id = String((s && s.identifier) || '').trim().toUpperCase();
    if (!/^[A-Z]+$/.test(id)) return null;
    let n = 0;
    for (let i = 0; i < id.length; i++) n = n * 26 + (id.charCodeAt(i) - 64);
    return n;
  };
  // Fallback ordering key: start.gg mints set ids in bracket order when it generates the
  // bracket, so a numeric id sorts the same way an identifier does. Verified against a real
  // 32-team double-elim — every round sorted by id has its feeders as consecutive pairs of
  // the previous round. Used only when a round has no identifiers at all (never mixed, the
  // two key spaces aren't comparable).
  const idKey = (s) => { const n = Number(s && s.id); return Number.isFinite(n) ? n : null; };
  // Sort one round into start.gg's own bracket order, if we can key the whole round.
  const sortRoundByBracketOrder = (round) => {
    const sets = round.sets || [];
    if (!sets.length) return false;
    if (sets.every((st) => st.ident != null)) { sets.sort((a, b) => a.ident - b.ident); return true; }
    if (sets.every((st) => st.sid != null)) { sets.sort((a, b) => a.sid - b.sid); return true; }
    return false;
  };
  const groupRounds = (filterFn, sortFn) => {
    const m = new Map();
    list.filter(filterFn).forEach((s) => {
      const key = s.fullRoundText || `Round ${s.round}`;
      if (!m.has(key)) m.set(key, { name: key, round: s.round, sets: [] });
      const slots = s.slots || [];
      // state: start.gg set state (1=upcoming, 2=live, 3=done) — lets the overlay dim
      // unstarted sets so a pre-event bracket doesn't read as if matches already happened.
      m.get(key).sets.push({ id: s.id, a: mapSlot(slots[0], s), b: mapSlot(slots[1], s), state: s.state || 0, fromA: originName(slots[0]), fromB: originName(slots[1]),
        // start.gg's own bracket-position marker for the set ("A", "B", … "AA"), assigned
        // top-to-bottom / left-to-right across the phase group. Sorting a round by it reproduces
        // exactly what start.gg's bracket page shows. Stripped again once ordering is done.
        ident: identKey(s), sid: idKey(s),
        // Which PREVIOUS set(s) feed this one — used to order matches within a round by bracket
        // position so the tree/connectors line up (start.gg's sortType:ROUND doesn't order within a round).
        prereq: slots.map((sl) => (sl && sl.prereqType === 'set' && sl.prereqId != null) ? String(sl.prereqId) : null).filter(Boolean) });
    });
    return [...m.values()].sort(sortFn);
  };
  // Order each round's sets by the vertical position of their feeder sets in the previous round, so the
  // bracket reads top-to-bottom like start.gg (the index-based connectors in bracket.html assume this).
  //
  // start.gg's set identifier (or, failing that, its set id) IS the bracket order, so when a round
  // can be keyed that way we use it verbatim — that's the source of truth, and it's the only thing
  // that gets bye rounds right (a 2-set Round 1 feeding a 16-set Round 2 has no meaningful "feeder
  // order"; the old pass sorted those two to the top and pushed the other 14 down, which is what
  // scrambled the tree from Round 2 onward in BOTH bands).
  //
  // The feeder pass survives only as the fallback for brackets with neither key.
  const orderByTree = (band) => {
    const pos = {};   // setId (string) -> row within its round
    band.forEach((round) => {
      if (!sortRoundByBracketOrder(round)) {
        const rowOf = (st) => { const rs = (st.prereq || []).map((id) => pos[id]).filter((p) => p != null); return rs.length ? Math.min(...rs) : Number.MAX_SAFE_INTEGER; };
        round.sets.sort((a, b) => rowOf(a) - rowOf(b));   // stable: same-key sets keep source order
      }
      round.sets.forEach((st, i) => { pos[String(st.id)] = i; });
    });
  };
  // ident is an ordering input only — drop it before the band goes into state/broadcast.
  const stripIdent = (band) => band.forEach((r) => (r.sets || []).forEach((st) => { delete st.ident; delete st.sid; }));

  // Head-to-head matrix — Round Robin pools only (Swiss pairings aren't all-play-all,
  // a matrix would be mostly empty gaps, so we don't build one for Swiss).
  let matrix = null;
  if (type === 'ROUND_ROBIN') {
    const teams = standingsRaw.map((s) => ({ id: String(s.id), name: s.name }));
    const cells = {};
    list.forEach((s) => {
      const slots = s.slots || [];
      const e0 = slots[0] && slots[0].entrant;
      const e1 = slots[1] && slots[1].entrant;
      if (!e0 || !e1 || e0.id == null || e1.id == null) return;
      const a = mapSlot(slots[0], s);
      const b = mapSlot(slots[1], s);
      const played = s.winnerId != null;
      cells[`${e0.id}_${e1.id}`] = { aScore: a.score, bScore: b.score, winner: played ? (a.winner ? 'a' : (b.winner ? 'b' : null)) : null, played };
      cells[`${e1.id}_${e0.id}`] = { aScore: b.score, bScore: a.score, winner: played ? (b.winner ? 'a' : (a.winner ? 'b' : null)) : null, played };
    });
    matrix = { teams, cells };
  }

  if (!isElim) {
    // Swiss / Round-Robin: no winners/losers split, just the round-by-round pairing schedule.
    const schedule = groupRounds(() => true, (a, b) => a.round - b.round);
    schedule.forEach(sortRoundByBracketOrder);
    stripIdent(schedule);
    return { type, winners: [], losers: [], finals: [], standings, schedule, roster, matrix, advancesTo: advancesTo || '' };
  }

  // Elimination: group sets into rounds, split winners / losers / grand finals.
  const winners = groupRounds(
    (s) => s.round > 0 && !isGrandFinal(s),
    (a, b) => a.round - b.round
  );
  const losers = groupRounds(
    (s) => s.round < 0 && !isGrandFinal(s),
    (a, b) => Math.abs(a.round) - Math.abs(b.round)
  );
  const finals = groupRounds(isGrandFinal, (a, b) => a.round - b.round);

  // Align each round's rows to start.gg's bracket order, then to its feeders.
  orderByTree(winners);
  orderByTree(losers);
  finals.forEach(sortRoundByBracketOrder);
  [winners, losers, finals].forEach(stripIdent);

  // Exit pill: a set whose WINNER has no next set inside this pool is a bracket exit —
  // when we know where this pool's qualifiers go, tag it ("-> Day 3: Swiss Stage").
  if (advancesTo) {
    const winnerFeedsForward = (sid) => list.some((s) =>
      (s.slots || []).some((sl) => sl && String(sl.prereqId) === String(sid) && sl.prereqPlacement === 1));
    [winners, losers, finals].forEach((band) => band.forEach((r) => (r.sets || []).forEach((st) => {
      if (st.id != null && !winnerFeedsForward(st.id)) st.toNext = advancesTo;
    })));
  }
  return { type, winners, losers, finals, standings, schedule: [], roster, matrix: null, advancesTo: advancesTo || '' };
}

// Split a flat Start.gg set list into one bracket PHASE per Start.gg phase
// (so a Day-1 double-elim and a Day-2 single-elim/swiss stay separate), then
// further split each phase into POOLS — one per Start.gg phaseGroup, e.g. a
// Round Robin phase running 8 parallel pools at once. A phase with a single
// phaseGroup still gets one pool entry, and the phase-level winners/losers/
// finals/standings/schedule/roster fields mirror that one pool directly —
// this is what keeps existing single-pool/elimination events rendering
// exactly as before.
function buildPhases(sets, phaseList) {
  // Display order comes from the event's phases[] array — start.gg's own listing order.
  // Neither phase id NOR phaseOrder is reliable: a rebuilt phase gets a high id and a
  // high phaseOrder (RLCS NA Open 6: "Day 2" has phaseOrder 7, "Day 3" has 3).
  const orderMap = new Map();
  (Array.isArray(phaseList) ? phaseList : []).forEach((p, i) => { if (p && p.id != null) orderMap.set('p' + p.id, i); });
  let firstSeen = 0;
  // Cross-phase progression: originPhaseGroupId -> destination phase names. A slot whose
  // seed progressed OUT of pool X tells us where X's qualifiers went ("Day 3: Swiss Stage").
  const destByGroup = new Map();
  (sets || []).forEach((s) => {
    const dphase = s.phaseGroup && s.phaseGroup.phase && s.phaseGroup.phase.name;
    (s.slots || []).forEach((sl) => {
      const og = sl && sl.seed && sl.seed.progressionSource && sl.seed.progressionSource.originPhaseGroup;
      if (og && og.id != null && dphase) {
        const k = String(og.id);
        if (!destByGroup.has(k)) destByGroup.set(k, new Set());
        destByGroup.get(k).add(dphase);
      }
    });
  });
  const groups = new Map();
  // Seed a group for EVERY phase the event lists — even ones with no sets yet (e.g. a Playoffs stage
  // that hasn't been seeded/generated). Grouping only by sets hid a whole stage until it started, so
  // the producer couldn't see Day 2 / Playoffs existed. Empty phases render as an empty bracket and
  // fill in once start.gg seeds them + the next sync runs.
  (Array.isArray(phaseList) ? phaseList : []).forEach((p) => {
    if (!p || p.id == null) return;
    const id = 'p' + p.id;
    if (!groups.has(id)) groups.set(id, { id, name: p.name || 'Bracket', order: orderMap.has(id) ? orderMap.get(id) : 1000 + (firstSeen++), sets: [] });
  });
  (sets || []).forEach((s) => {
    const ph = (s.phaseGroup && s.phaseGroup.phase) || null;
    const id = ph && ph.id != null ? 'p' + ph.id : 'default';
    const name = (ph && ph.name) || 'Bracket';
    if (!groups.has(id)) groups.set(id, { id, name, order: orderMap.has(id) ? orderMap.get(id) : 1000 + (firstSeen++), sets: [] });
    groups.get(id).sets.push(s);
  });
  return [...groups.values()]
    .sort((a, b) => a.order - b.order)
    .map((g) => {
      const poolGroups = new Map();
      g.sets.forEach((s) => {
        const pg = s.phaseGroup || null;
        const pid = pg && pg.id != null ? String(pg.id) : 'default';
        const pname = (pg && pg.displayIdentifier) || g.name;
        if (!poolGroups.has(pid)) poolGroups.set(pid, { id: pid, name: pname, sets: [] });
        poolGroups.get(pid).sets.push(s);
      });
      const pools = [...poolGroups.values()]
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .map((pg) => {
          const b = buildBracket(pg.sets, [...(destByGroup.get(pg.id) || [])].join(' / '));
          // Pools carry their OWN elimination arrays: major-scale events (RLCS Opens) run MANY
          // double-elim pools per phase — merging at phase level produced one unreadable
          // mega-bracket with every pool's Round 1 stacked into a single column.
          return { id: pg.id, name: pg.name, type: b.type, roster: b.roster, schedule: b.schedule,
            standings: b.standings, matrix: b.matrix, advancesTo: b.advancesTo || '',
            winners: b.winners, losers: b.losers, finals: b.finals };
        });
      const p0 = pools[0] || { id: '', type: '', roster: [], schedule: [], standings: [], matrix: null };
      // Winners/losers/finals always come from the WHOLE phase's sets (not per-pool) —
      // elimination phases are effectively always a single pool in practice, and this
      // preserves exact prior behavior for them regardless of the pools split above.
      const phaseDest = new Set();
      g.sets.forEach((s) => {
        const k = s.phaseGroup && s.phaseGroup.id != null ? String(s.phaseGroup.id) : '';
        if (k && destByGroup.has(k)) destByGroup.get(k).forEach((d) => phaseDest.add(d));
      });
      const bAll = buildBracket(g.sets, [...phaseDest].join(' / '));
      return {
        id: g.id, name: g.name, type: bAll.type, advancesTo: bAll.advancesTo || '',
        winners: bAll.winners, losers: bAll.losers, finals: bAll.finals,
        standings: p0.standings, schedule: p0.schedule, roster: p0.roster,
        pools, activePoolId: p0.id || ''
      };
    });
}

// Copy the active phase's bracket data — and that phase's ACTIVE POOL — up to
// the top-level fields the overlay reads.
function syncActiveBracketPhase() {
  const phases = state.bracket.phases || [];
  if (!phases.length) return;
  let ph = phases.find((x) => x.id === state.bracket.activePhaseId);
  if (!ph) { ph = phases[0]; state.bracket.activePhaseId = ph.id; }
  state.bracket.type = ph.type || '';
  state.bracket.winners = ph.winners || [];
  state.bracket.losers = ph.losers || [];
  state.bracket.finals = ph.finals || [];

  const pools = Array.isArray(ph.pools) ? ph.pools : [];
  // Pools ride up as {id,name} for the selector, PLUS their own small bracket when they are
  // group-sized. That is what lets the overlay draw a GSL stage as the four separate 4-team
  // groups it actually is, instead of one pool at a time or a merged mega-bracket. Bounded on
  // purpose: only groups of at most 8 sets (a GSL group is 5) and at most 16 of them, so a
  // major-scale phase with dozens of pools can't bloat the library payload.
  // 8 was below the format's own size and broke GSL on the live event: an 8-team group runs 10
  // sets while it is in progress and 13 when complete (WQF 4 + WSF 2 + WF 1 + LR1 2 + LQF 2 +
  // LSF 1 + LF 1), so every pool failed the test, no pool boards shipped, and the phase-level
  // merge (20 sets / 16 teams) then failed the group-size check too. 16 leaves real headroom.
  const POOL_BOARD_MAX_SETS = 16, POOL_BOARD_MAX_POOLS = 16;
  const _poolSets = (pl) => ['winners', 'losers', 'finals']
    .reduce((n, k) => n + (pl[k] || []).reduce((m, r) => m + ((r.sets || []).length), 0), 0);
  const _small = pools.length > 1 && pools.length <= POOL_BOARD_MAX_POOLS
    && pools.every((pl) => { const n = _poolSets(pl); return n > 0 && n <= POOL_BOARD_MAX_SETS; });
  state.bracket.pools = pools.map((pl) => (_small
    ? { id: pl.id, name: pl.name, type: pl.type || '', winners: pl.winners || [],
        losers: pl.losers || [], finals: pl.finals || [], advancesTo: pl.advancesTo || '' }
    : { id: pl.id, name: pl.name }));
  let pool = pools.find((pl) => pl.id === state.bracket.activePoolId);
  if (!pool) { pool = pools[0] || null; state.bracket.activePoolId = pool ? pool.id : ''; }

  // Multi-pool elimination phase: show the ACTIVE POOL's bracket, not the phase-wide merge.
  const poolElim = pool && ((pool.winners || []).length || (pool.losers || []).length || (pool.finals || []).length);
  if (poolElim && pools.length > 1) {
    state.bracket.winners = pool.winners || [];
    state.bracket.losers = pool.losers || [];
    state.bracket.finals = pool.finals || [];
  }
  state.bracket.standings = (pool ? pool.standings : ph.standings) || [];
  state.bracket.schedule = (pool ? pool.schedule : ph.schedule) || [];   // Swiss/Round-Robin round-by-round pairings
  state.bracket.roster = (pool ? pool.roster : ph.roster) || [];
  state.bracket.advancesTo = (pool && pool.advancesTo) || ph.advancesTo || '';
  state.bracket.matrix = (pool ? pool.matrix : (ph.matrix || null)) || null;   // ph.matrix: single-group manual Round Robin (no pools split)

  // Never leave the saved view pointing at data this bracket doesn't have — a stale "matrix"
  // on an elim bracket rendered the overlay as a blank page with no clue why.
  const hasElim = state.bracket.winners.length || state.bracket.losers.length || state.bracket.finals.length;
  const fallback = hasElim ? 'both' : (state.bracket.standings.length ? 'standings' : 'both');
  if (state.bracket.view === 'matrix' && !state.bracket.matrix) state.bracket.view = fallback;
  if (state.bracket.view === 'schedule' && !state.bracket.schedule.length) state.bracket.view = fallback;
  if (state.bracket.view === 'swiss' && !state.bracket.schedule.length) state.bracket.view = fallback;
  if (state.bracket.view === 'group' && !state.bracket.standings.length) state.bracket.view = fallback;
  if (state.bracket.view === 'losers' && !state.bracket.losers.length) state.bracket.view = fallback;
  if (state.bracket.view === 'standings' && hasElim) state.bracket.view = 'both';
  // And the mirror case: an elim-only view ('both'/'winners'/'losers'/'finals') on a
  // round-robin/Swiss phase — pick the format's real default so a linked platform import
  // renders correctly without the producer touching the view chips.
  if (!hasElim && ['winners', 'losers', 'finals', 'standings'].includes(state.bracket.view)) {
    // 'both' on pool play = the records LADDER (the overlay's default view for swiss/RR).
    state.bracket.view = 'both';
  }
}

// Pull every page of an event's sets (capped so a misconfigured event can't loop).
// 40 pages × 50 = 2000 sets — enough for major-scale events (e.g. RLCS Opens: hundreds of
// teams across swiss pools + top cut). Big events get a slower bracket-refresh cadence
// in startggPollTick so this doesn't hammer the API every 20s.
async function fetchAllSets(client, slug, perPage = 32, maxPages = 63) {
  const query = `
    query BracketSets($slug: String!, $perPage: Int!, $page: Int!) {
      event(slug: $slug) {
        id
        name
        tournament { name }
        phases { id name }
        sets(perPage: $perPage, page: $page, sortType: ROUND) {
          pageInfo { totalPages }
          nodes {
            id
            identifier
            fullRoundText
            round
            state
            winnerId
            phaseGroup { id displayIdentifier bracketType phase { id name } }
            slots {
              prereqType
              prereqId
              prereqPlacement
              seed { placeholderName progressionSource { originPlacement originPhaseGroup { id } originPhase { id name } } }
              entrant { id name }
              standing { stats { score { value } } }
            }
          }
        }
      }
    }
  `;
  let page = 1;
  let totalPages = 1;
  let event = null;
  const all = [];
  do {
    if (page > 1) await new Promise((r) => setTimeout(r, ctx.STARTGG_PAGE_DELAY_MS));   // stay under start.gg's 80 req/min
    const res = await ctx.startggRequestWithBackoff(client, query, { slug, perPage, page });
    event = res && res.event;
    if (!event) throw new Error('Event not found — check the slug/URL and your token');
    all.push(...((event.sets && event.sets.nodes) || []));
    totalPages = (event.sets && event.sets.pageInfo && event.sets.pageInfo.totalPages) || 1;
    page++;
  } while (page <= totalPages && page <= maxPages);
  return { event, sets: all };
}

// True bracket seed per entrant, straight from start.gg (`initialSeedNum` — the seed that actually
// produced the real bracket's bye placement). Locally-cached roster/seeding-studio order is NOT a
// reliable substitute: it can drift from what start.gg really used (manual reseeds, edits after the
// seeding studio snapshot, etc.), which silently produces a DIFFERENT bye/bracket shape when used to
// seed a mirrored bracket elsewhere (e.g. Challonge). Returns { name.toLowerCase() -> seedNum }.
async function fetchEntrantSeedList(eventSlug) {
  if (!ctx.startggApiToken) throw new Error('No start.gg API token yet. Add it under Apps > start.gg.');
  const client = createStartGgClient(ctx.startggApiToken);
  const query = `
    query TrueSeeds($slug: String!, $perPage: Int!, $page: Int!) {
      event(slug: $slug) {
        entrants(query: { perPage: $perPage, page: $page }) {
          pageInfo { totalPages }
          nodes { id name initialSeedNum }
        }
      }
    }`;
  let page = 1, totalPages = 1;
  const list = [];
  do {
    if (page > 1) await new Promise((r) => setTimeout(r, 350));   // stagger for start.gg rate limits
    const res = await ctx.startggRequestWithBackoff(client, query, { slug: eventSlug, perPage: 75, page });
    const ev = res && res.event;
    if (!ev) throw new Error('Event not found — check the slug/URL and your token');
    ((ev.entrants && ev.entrants.nodes) || []).forEach((n) => {
      if (n.name && n.initialSeedNum != null) list.push({ seed: n.initialSeedNum, name: n.name });
    });
    totalPages = (ev.entrants && ev.entrants.pageInfo && ev.entrants.pageInfo.totalPages) || 1;
    page++;
  } while (page <= totalPages && page <= 16);
  return list.sort((a, b) => a.seed - b.seed);
}
async function fetchEntrantTrueSeeds(eventSlug) {
  const list = await fetchEntrantSeedList(eventSlug);
  const map = {};
  list.forEach((e) => { map[e.name.toLowerCase()] = e.seed; });
  return map;
}

// Pull every page of an event's entrants (teams + their players).
// Tries to include social handles and country; falls back silently if the API rejects those fields.
async function fetchAllEntrants(client, slug, perPage = 50, maxPages = 60) {   // 60 pages = 3000 entrants (a full RLCS Open field clears the old 1200 cap)
  // `globalTeam` is what makes a team recognisable at the NEXT event: an entrant id is scoped to
  // one event and an entrant NAME changes every time an org rebrands, but the GlobalTeam id and its
  // discriminator (the /team/<slug> path) are permanent. The team vault keys on them — see
  // backend/team-db.js. It's an inline fragment on an interface, so it gets its own fallback tier
  // rather than riding on `withExt`: a schema that rejects it must not also cost us the socials.
  const buildQuery = (feat) => `
    query EventEntrants($slug: String!, $perPage: Int!, $page: Int!) {
      event(slug: $slug) {
        entrants(query: { perPage: $perPage, page: $page }) {
          pageInfo { totalPages }
          nodes {
            id name initialSeedNum
            participants { id gamerTag${feat.ext ? ' prefix' : ''} player { id${feat.ext ? ' prefix' : ''} user { slug name images { url type }${feat.ext ? ' authorizations { type externalUsername } location { country }' : ''} } } }
            team { ${feat.team ? 'id name ... on EventTeam { globalTeam { id discriminator name images { url type } } }' : ''} images { url type } }
          }
        }
      }
    }
  `;
  let page = 1, totalPages = 1;
  const feat = { ext: true, team: true };
  const all = [];
  do {
    if (page > 1) await new Promise((r) => setTimeout(r, ctx.STARTGG_PAGE_DELAY_MS));   // stay under start.gg's 80 req/min
    let res;
    // Rate limits back off and retry the page (same policy as the bracket import); schema errors
    // (globalTeam, then authorizations/location) drop one optional tier at a time instead of
    // failing the whole team import.
    for (;;) {
      try { res = await ctx.startggRequestWithBackoff(client, buildQuery(feat), { slug, perPage, page }); break; }
      catch (e) {
        if (/429|rate ?limit|too many/i.test(String(e && e.message || ''))) throw e;
        if (feat.team) feat.team = false;
        else if (feat.ext) feat.ext = false;
        else throw e;
      }
    }
    const ev = res && res.event;
    if (!ev) break;
    all.push(...((ev.entrants && ev.entrants.nodes) || []));
    totalPages = (ev.entrants && ev.entrants.pageInfo && ev.entrants.pageInfo.totalPages) || 1;
    page++;
  } while (page <= totalPages && page <= maxPages);
  if (totalPages > maxPages) {
    console.warn(`[start.gg] event has ${totalPages} pages of entrants — capped at ${maxPages} (${all.length} loaded). Some teams were not imported.`);
  }
  return all;
}

// Fetch an event's entrants with their CURRENT start.gg seed (for the seeding studio).
async function fetchEventSeeding(apiToken, eventSlugRaw) {
  if (!apiToken) throw new Error('start.gg API token required');
  const slug = parseEventSlug(eventSlugRaw);
  if (!slug || !/\/event\//i.test(slug)) throw new Error('Paste a specific start.gg EVENT URL (…/event/…).');
  const client = createStartGgClient(apiToken);
  // Connected accounts (Epic etc.) are a far stronger match key for 6mans rank
  // lookup than the event gamertag. Query them, but fall back gracefully if start.gg
  // rejects/omits the `authorizations` field so the seeding pull never breaks.
  // teamRosterSize tells us the event's actual format (a 2v2 event reports 2), which the seeding studio
  // needs so it doesn't hold teams to the game's default squad size. Both it and `authorizations` are
  // optional extras — if start.gg rejects either, drop that field and retry rather than failing the pull.
  const buildQuery = (feat) => `
    query EventSeeding($slug: String!, $perPage: Int!, $page: Int!) {
      event(slug: $slug) {
        id name images { type url }
        ${feat.roster ? 'teamRosterSize { minPlayers maxPlayers }' : ''}
        tournament { images { type url } }
        entrants(query: { perPage: $perPage, page: $page }) {
          pageInfo { totalPages }
          nodes { id name initialSeedNum participants { gamerTag player { id user { slug name images { url type } ${feat.auth ? 'authorizations { type externalUsername }' : ''} } } } }
        }
      }
    }`;
  let page = 1, totalPages = 1, evName = '', evImage = '', evRoster = 0;
  const feat = { auth: true, roster: true };
  const all = [];
  do {
    if (page > 1) await new Promise((r) => setTimeout(r, 350));   // stagger for start.gg rate limits
    // Try as-is, then keep dropping one optional field at a time (roster first — it's the cheaper loss)
    // until the query is accepted or there's nothing left to drop.
    let res;
    for (;;) {
      try { res = await client.request(buildQuery(feat), { slug, perPage: 75, page }); break; }
      catch (e) {
        if (feat.roster) feat.roster = false;
        else if (feat.auth) feat.auth = false;
        else throw e;
      }
    }
    const ev = res && res.event;
    if (!ev) break;
    evName = ev.name || evName;
    if (!evRoster && ev.teamRosterSize) {
      const rs = ev.teamRosterSize;
      const n = parseInt(rs.maxPlayers || rs.minPlayers, 10);
      if (n > 0 && n <= 12) evRoster = n;
    }
    if (!evImage) {
      const pick = (imgs) => (imgs || []).find((i) => i.type === 'profile')?.url || (imgs || []).find((i) => i.type === 'banner')?.url || (imgs && imgs[0] && imgs[0].url) || '';
      evImage = pick(ev.images) || pick(ev.tournament && ev.tournament.images) || '';
    }
    ((ev.entrants && ev.entrants.nodes) || []).forEach((n) => all.push({
      entrantId: String(n.id),
      name: n.name || '',
      seedNum: n.initialSeedNum || null,
      players: (n.participants || []).map((p) => {
        const u = (p.player && p.player.user) || {};
        const auths = u.authorizations || [];
        const epic = (auths.find((a) => a && (a.type === 'EPIC' || a.type === 'EPICGAMES')) || {}).externalUsername || '';
        const steam = (auths.find((a) => a && a.type === 'STEAM') || {}).externalUsername || '';
        // Build alts as {platform, username} objects so the UI can display and look up each account.
        const _altSeen = new Set();
        const alts = auths
          .filter((a) => a && a.externalUsername)
          .map((a) => ({ platform: (a.type || '').toLowerCase().replace('epicgames', 'epic'), username: a.externalUsername }))
          .filter((a) => { const k = a.platform + ':' + a.username; if (_altSeen.has(k)) return false; _altSeen.add(k); return true; });
        const gamerTag = p.gamerTag || u.name || '';
        const startggPlayerId = p.player && p.player.id ? String(p.player.id) : null;
        const image = ((u.images || []).find((i) => /profile/i.test(i.type || '')) || (u.images || [])[0] || {}).url || '';
        // Auto-link the start.gg profile into the registry for every entrant we see.
        if (gamerTag && u.slug) upsertPlayerProfile(gamerTag, { startggSlug: u.slug, startggPlayerId, image });
        return { gamerTag, epic, steam, alts, startggSlug: u.slug || null, startggPlayerId, image };
      }).filter((p) => p.gamerTag)
    }));
    totalPages = (ev.entrants && ev.entrants.pageInfo && ev.entrants.pageInfo.totalPages) || 1;
    page++;
  } while (page <= totalPages && page <= 16);
  all.sort((a, b) => (a.seedNum || 99999) - (b.seedNum || 99999));
  // Diagnostic: how often did start.gg actually hand us a connected Epic/Steam account vs. leaving us
  // to fall back to the tournament gamerTag for tracker.gg? Connected accounts are privacy-gated on
  // start.gg (typically only the token owner's own are returned), so this is usually near-zero — which
  // is exactly why tracker.gg-by-gamertag misses (the gamerTag often isn't the Epic username).
  const _players = all.flatMap((e) => e.players || []);
  const _epic = _players.filter((p) => p.epic).length;
  const _steam = _players.filter((p) => p.steam).length;
  const _anyAuth = _players.filter((p) => p.epic || p.steam || (p.alts && p.alts.length)).length;
  console.log(`[start.gg seeding] ${_players.length} players — connected accounts from start.gg: epic=${_epic}, steam=${_steam}, any=${_anyAuth} (withAuth=${feat.auth}). The rest fall back to gamerTag for tracker.gg. Event team size: ${evRoster || 'not reported'}.`);
  return { eventName: evName, eventSlug: slug, image: evImage, rosterSize: evRoster, entrants: all };
}

// Live finish order for the event currently on air. Distinct from a full-field standings pull,
// which pages the WHOLE field for the historical stats importer: this wants the top of the board
// only, cheaply, on a repeating poll.
//
// Why this exists at all: an elimination bracket's `standings` array is derived from SET WINS
// (buildBracketFromSets), which is NOT the finish order — a losers-run runner-up can out-win the
// champion, and everyone knocked out in the same round ties on W-L and falls back to alphabetical.
// The 5/5 and 7/7 ties a top-8 board is built around only exist in start.gg's own standings query.
async function fetchEventPlacements(apiToken, idOrSlug, limit) {
  if (!apiToken) throw new Error('Start.gg API token required');
  if (!idOrSlug) throw new Error('event id or slug required');
  const client = createStartGgClient(apiToken);
  const byId = /^\d+$/.test(String(idOrSlug));
  // `ext` adds each participant's start.gg location so the Top 8 cards can carry a flag. A field the
  // API rejects fails the WHOLE document, so a rejected ext query falls back to the slim one rather
  // than losing the placements over a flag.
  const query = (ext) => `query EventPlacements($key:${byId ? 'ID' : 'String'}!,$per:Int!){
    event(${byId ? 'id' : 'slug'}:$key){ id state
      standings(query:{page:1,perPage:$per}){
        nodes{ placement entrant{ id name participants{ gamerTag${ext ? ' player{ user{ location{ country } } }' : ''} } } } } } }`;
  const vars = { key: String(idOrSlug), per: Math.max(1, Math.min(64, limit || 32)) };
  let res = null;
  try { res = await client.request(query(true), vars); } catch (e) { res = null; }
  if (!res || !res.event) res = await client.request(query(false), vars);
  const ev = res && res.event;
  if (!ev) throw new Error('Event not found on start.gg');
  // One flag per ENTRANT: a singles player's own country, or a team's only when every member shares
  // it (a mixed-nation squad has no single flag). ISO-2, never the country name.
  const entrantCountry = (parts) => {
    const codes = (parts || []).map((pt) => ctx._countryCode((((pt && pt.player) || {}).user || {}).location
      ? pt.player.user.location.country : null) || '');
    return codes.length && codes.every((c) => c && c === codes[0]) ? codes[0] : '';
  };
  const rows = ((ev.standings && ev.standings.nodes) || [])
    .filter((n) => n && n.placement && n.entrant && n.entrant.name)
    .map((n) => ({
      placement: n.placement,
      name: n.entrant.name,
      entrantId: String(n.entrant.id || ''),
      // The entrant's roster. For SINGLES this is one tag (and usually just restates the entrant
      // name); for doubles/crew it is the squad, which the Top 8 card lists under the team name.
      players: ((n.entrant.participants) || []).map((pt) => (pt && pt.gamerTag) || '').filter(Boolean),
      countryCode: entrantCountry(n.entrant.participants)
    }))
    .sort((a, b) => a.placement - b.placement);
  return { rows, complete: String(ev.state || '').toUpperCase() === 'COMPLETED' };
}

// Which fighter each entrant actually played, from start.gg's own per-game character reports —
// the same data behind an event's character-usage stats page. Returns Map(entrantId -> name).
//
// This is reported data, NOT derived: start.gg only has it when the TO or the players filled in
// characters when reporting each game, which plenty of locals never do. An entrant with nothing
// reported simply isn't in the map, and the Top 8 leaves their fighter blank for the producer.
//
// Only COMPLETED sets are read (state 3) — the same filter the match feed uses — and an entrant's
// most-reported character across the event wins, so a one-game counterpick doesn't override the
// main they played all bracket.
async function fetchEventCharacters(apiToken, idOrSlug, wantIds, maxPages) {
  const out = { map: new Map(), error: '', scanned: 0, shape: '' };
  if (!apiToken || !idOrSlug) { out.error = 'no token or event'; return out; }
  const want = new Set((wantIds || []).map(String).filter(Boolean));
  if (!want.size) { out.error = 'no entrant ids'; return out; }
  const client = createStartGgClient(apiToken);
  const byId = /^\d+$/.test(String(idOrSlug));
  const key = byId ? 'id' : 'slug';
  const keyType = byId ? 'ID' : 'String';

  // TWO shapes, tried in order. start.gg's published schema gives GameSelection.character, but
  // that is not something this code has ever been able to execute against the live API, and a
  // field the server rejects fails the WHOLE document — so if the first shape errors we fall back
  // to the older selectionValue form and resolve ids through the videogame's character table.
  const SHAPES = [
    { name: 'character',
      q: `query EventCharacters($key:${keyType}!,$page:Int!){
            event(${key}:$key){ id
              sets(page:$page, perPage:50, sortType:RECENT, filters:{state:3}){
                pageInfo{ totalPages }
                nodes{ games{ selections{ entrant{ id } character{ name } } } } } } }` },
    { name: 'selectionValue',
      q: `query EventCharacterIds($key:${keyType}!,$page:Int!){
            event(${key}:$key){ id
              videogame{ characters{ id name } }
              sets(page:$page, perPage:50, sortType:RECENT, filters:{state:3}){
                pageInfo{ totalPages }
                nodes{ games{ selections{ entrant{ id } selectionType selectionValue } } } } } }` }
  ];

  const tally = new Map();          // entrantId -> Map(characterName -> count)
  const cap = Math.max(1, Math.min(8, maxPages || 3));
  let lastErr = '';

  for (const shape of SHAPES) {
    tally.clear();
    let page = 1, totalPages = 1, scanned = 0, failed = false;
    const charById = new Map();
    do {
      let res;
      try { res = await client.request(shape.q, { key: String(idOrSlug), page }); }
      catch (e) { lastErr = e.message; failed = true; break; }
      const ev = res && res.event;
      if (!ev) { lastErr = 'event not found'; failed = true; break; }
      ((ev.videogame && ev.videogame.characters) || []).forEach((c) => {
        if (c && c.id != null) charById.set(String(c.id), c.name || '');
      });
      ((ev.sets && ev.sets.nodes) || []).forEach((set) => {
        scanned++;
        ((set && set.games) || []).forEach((g) => {
          ((g && g.selections) || []).forEach((sel) => {
            const eid = sel && sel.entrant && String(sel.entrant.id || '');
            if (!eid || !want.has(eid)) return;
            // Shape 1 documents character as a list but returns an object; accept either.
            let name = '';
            const c = sel.character;
            if (c) name = Array.isArray(c) ? ((c[0] || {}).name || '') : (c.name || '');
            if (!name && sel.selectionValue != null) {
              const t = String(sel.selectionType || 'CHARACTER').toUpperCase();
              if (t === 'CHARACTER' || t === '1') name = charById.get(String(sel.selectionValue)) || '';
            }
            if (!name) return;
            if (!tally.has(eid)) tally.set(eid, new Map());
            const m = tally.get(eid);
            m.set(name, (m.get(name) || 0) + 1);
          });
        });
      });
      totalPages = (ev.sets && ev.sets.pageInfo && ev.sets.pageInfo.totalPages) || 1;
      page++;
    } while (page <= totalPages && page <= cap);

    out.scanned = scanned;
    if (!failed) {
      out.shape = shape.name;
      // A shape that ran clean is authoritative even if it found nothing (nobody reported a
      // character); only fall through to the next shape when the query itself failed.
      lastErr = tally.size ? '' : (scanned ? '' : 'no completed sets to read');
      break;
    }
  }

  tally.forEach((counts, eid) => {
    let best = '', n = 0;
    counts.forEach((c, name) => { if (c > n) { n = c; best = name; } });
    // Normalise to the registry's spelling so the overlay resolves the same art it would for a
    // hand-typed name ("Pokémon Trainer" -> "Pokemon Trainer").
    if (best) out.map.set(eid, ctx.smashFighters ? ctx.smashFighters.nameOf(best) : best);
  });
  out.error = out.map.size ? '' : lastErr;
  return out;
}


  return { _stripStartggWhitespace, parseEventSlug, parseStartggInput, indexEntrantLogos, cleanTeamAbbr, abbrForTeamName, logoForTeamName, swapTeamSides, GENERIC_TEAM_RE, applyGameTeamName, activePlatformSets, platformRoundLabel, retuneRoundLabel, buildPhases, syncActiveBracketPhase, fetchEntrantSeedList, fetchAllEntrants, fetchEventSeeding, fetchEventPlacements, fetchEventCharacters, bracketNormName, bracketNameScore, fetchEntrantTrueSeeds, fetchAllSets };
};
