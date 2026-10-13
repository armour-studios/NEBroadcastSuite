// backend/platforms/startgg.js — moved out of server.js (refactor step 3) unchanged; server.js creates it once
// with createStartgg(ctx). ctx carries stable references plus live getters (ctx.<name>) for values
// server.js replaces at runtime, and set_<name>(v) for the ones this code writes.
module.exports = function createStartgg(ctx) {
  const { https, createStartGgClient, teamDb, state, saveTeams, adoptEventGame, pollLoop, saveAppState, broadcast, upsertPlayerProfile, fetchStreamQueue, resetAutoFollowHold, setStartggQueuePolling, syncAllLinkedChallongeTournaments, setActivePlatform, _stripStartggWhitespace, parseEventSlug, parseStartggInput, indexEntrantLogos, buildPhases, syncActiveBracketPhase, fetchAllEntrants, broadcastFullState } = ctx;

// ─── Single-team spotlight: deep-dive on one entrant (placement / seed / record / sets) ───
async function fetchTeamSpotlight(apiToken, entrantId) {
  if (!apiToken) throw new Error('start.gg API token required');
  if (!entrantId) throw new Error('No start.gg entrant for this team — re-mark it from the event.');
  const client = createStartGgClient(apiToken);
  const query = `
    query EntrantSpotlight($id: ID!) {
      entrant(id: $id) {
        id name
        seeds { seedNum }
        standing { placement }
        participants { gamerTag user { name } }
        paginatedSets(page: 1, perPage: 16, sortType: RECENT) {
          nodes { id fullRoundText displayScore state winnerId startAt slots { entrant { id name } } }
        }
      }
    }`;
  const res = await client.request(query, { id: String(entrantId) });
  const e = res && res.entrant;
  if (!e) throw new Error('Entrant not found on start.gg');
  const myId = String(e.id);
  const seed = (e.seeds && e.seeds[0] && e.seeds[0].seedNum) || null;
  const placement = (e.standing && e.standing.placement) || null;
  const players = (e.participants || []).map((p) => ({ gamerTag: p.gamerTag || (p.user && p.user.name) || '', name: (p.user && p.user.name) || '' })).filter((p) => p.gamerTag);
  const sets = (e.paginatedSets && e.paginatedSets.nodes) || [];
  const oppOf = (s) => { const o = (s.slots || []).map((x) => x.entrant).filter(Boolean).find((x) => String(x.id) !== myId); return o ? o.name : 'TBD'; };
  let w = 0, l = 0; const recent = [];
  sets.forEach((s) => {
    if (s.state === 3) {            // completed
      const won = String(s.winnerId) === myId;
      if (won) w++; else l++;
      if (recent.length < 4) recent.push({ round: s.fullRoundText || '', opponent: oppOf(s), score: s.displayScore || '', won });
    }
  });
  const upcoming = sets.filter((s) => s.state === 1 || s.state === 2).sort((a, b) => (a.startAt || 9e15) - (b.startAt || 9e15));
  const next = upcoming.length ? { round: upcoming[0].fullRoundText || '', opponent: oppOf(upcoming[0]), live: upcoming[0].state === 2 } : null;
  return { name: e.name || '', seed, placement, record: { w, l }, recent, next, players };
}
// Fill each spotlight player's seedRank from the matching My Event's saved seeding (by gamertag).
function enrichSpotlightSeeding() {
  const ts = state.teamSpotlight;
  const ev = (state.myEvents || []).find((e) => e.eventSlug === ts.eventSlug);
  const team = ev && ev.seeding && Array.isArray(ev.seeding.entrants)
    ? ev.seeding.entrants.find((t) => (t.name || '').toLowerCase() === (ts.name || '').toLowerCase()) : null;
  if (!team) return;
  (ts.players || []).forEach((p) => {
    const sp = (team.players || []).find((x) => (x.gamerTag || '').toLowerCase() === (p.gamerTag || '').toLowerCase());
    if (sp && sp.rank) p.seedRank = sp.rank;
  });
}
let _tsSyncing = false;
async function refreshTeamSpotlight() {
  const ts = state.teamSpotlight;
  if (_tsSyncing || !ts.entrantId || !ctx.startggApiToken) return;
  _tsSyncing = true;
  try {
    const d = await fetchTeamSpotlight(ctx.startggApiToken, ts.entrantId);
    ts.sg = { seed: d.seed, placement: d.placement, record: d.record, recent: d.recent, next: d.next };
    if (d.name && !ts.name) ts.name = d.name;
    if (!ts.players.length && d.players.length) ts.players = d.players.map((p) => ({ gamerTag: p.gamerTag, name: p.name, seedRank: '' }));
    else (d.players || []).forEach((dp) => { const tp = ts.players.find((x) => (x.gamerTag || '').toLowerCase() === (dp.gamerTag || '').toLowerCase()); if (tp && dp.name) tp.name = dp.name; });
    enrichSpotlightSeeding();
    ts.lastSync = Date.now(); ts.syncError = '';
  } catch (e) { ts.syncError = (e && e.message) || 'fetch failed'; }
  finally { _tsSyncing = false; saveAppState(); broadcastFullState(); }
}
let _tsTimer = null;
function startTeamSpotlightAutoSync() {
  if (_tsTimer) return;
  _tsTimer = pollLoop('team-spotlight', async () => { if (state.teamSpotlight.visible && state.teamSpotlight.entrantId) { await refreshTeamSpotlight().catch(() => {}); if (state.teamSpotlight.syncError) throw new Error(state.teamSpotlight.syncError); } }, 45000);
}

// Fetch tournaments the current token user ADMINS/staffs (organizer view), with the
// extra fields the Events tab needs (attendees, events, location). Falls back to the
// unfiltered "tournaments I'm associated with" list if the admin filter is rejected.
async function fetchMyTournaments(apiToken) {
  if (!apiToken) throw new Error('API token required');
  const client = createStartGgClient(apiToken);
  const buildQuery = (withFilter) => `
    query MyTournaments($perPage: Int) {
      currentUser {
        id
        slug
        tournaments(query: { perPage: $perPage${withFilter ? ', filter: { tournamentView: "admin" }' : ''} }) {
          nodes {
            id
            name
            slug
            startAt
            endAt
            numAttendees
            city
            countryCode
            images { type url }
            events { id name slug numEntrants state startAt videogame { id name } }
          }
        }
      }
    }
  `;
  let res;
  try {
    res = await client.request(buildQuery(true), { perPage: 50 });
  } catch (e) {
    // Some tokens / API states reject the admin filter — retry without it.
    res = await client.request(buildQuery(false), { perPage: 50 });
  }
  const nodes = (res && res.currentUser && res.currentUser.tournaments && res.currentUser.tournaments.nodes) || [];
  return nodes.map(mapTournamentSummary);
}

function mapTournamentSummary(t) {
  const imageUrl = (t.images || []).find(i => i.type === 'profile')?.url ||
                   (t.images || []).find(i => i.type === 'banner')?.url ||
                   (t.images && t.images[0] && t.images[0].url) || null;
  const events = (t.events || []).map(e => ({
    id: e.id, name: e.name, slug: e.slug, numEntrants: e.numEntrants || 0,
    state: e.state, startAt: e.startAt,
    game: (e.videogame && e.videogame.name) || ''
  }));
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    startAt: t.startAt,
    endAt: t.endAt,
    numAttendees: t.numAttendees || 0,
    city: t.city || '',
    countryCode: t.countryCode || '',
    image: imageUrl,
    events,
    eventCount: events.length,
    games: [...new Set(events.map(e => e.game).filter(Boolean))],
    tournamentName: t.name
  };
}

// Full detail for one tournament: events + participant (player) roster + sponsorship aggregates.
async function fetchTournamentDetail(apiToken, tournamentSlug, maxPlayerPages = 6) {
  if (!apiToken) throw new Error('API token required');
  const slug = (tournamentSlug || '').trim().replace(/^tournament\//i, '');   // accept bare OR prefixed
  if (!slug) throw new Error('tournamentSlug required');
  const client = createStartGgClient(apiToken);
  const query = `
    query TournamentDetail($slug: String!, $page: Int!) {
      tournament(slug: $slug) {
        id name slug startAt endAt numAttendees
        city addrState countryCode venueName venueAddress
        images { type url }
        events { id name slug numEntrants state startAt videogame { id name } }
        participants(query: { perPage: 100, page: $page }) {
          pageInfo { total totalPages page }
          nodes { id gamerTag user { id slug name } }
        }
      }
    }
  `;

  let page = 1, totalPages = 1;
  let head = null;
  const players = [];
  do {
    if (page > 1) await new Promise((r) => setTimeout(r, 350));   // stagger for start.gg rate limits
    const res = await client.request(query, { slug: `tournament/${slug}`, page });
    const t = res && res.tournament;
    if (!t) break;
    if (!head) head = t;
    const part = (t.participants && t.participants.nodes) || [];
    part.forEach(p => players.push({
      id: p.id,
      tag: p.gamerTag || (p.user && p.user.name) || '',
      userSlug: (p.user && p.user.slug) || '',
      name: (p.user && p.user.name) || ''
    }));
    totalPages = (t.participants && t.participants.pageInfo && t.participants.pageInfo.totalPages) || 1;
    page++;
  } while (page <= totalPages && page <= maxPlayerPages);

  if (!head) throw new Error('Tournament not found');

  const events = (head.events || []).map(e => ({
    id: e.id, name: e.name, slug: e.slug, numEntrants: e.numEntrants || 0,
    state: e.state, startAt: e.startAt, game: (e.videogame && e.videogame.name) || ''
  }));
  const games = [...new Set(events.map(e => e.game).filter(Boolean))];
  const totalEntrants = events.reduce((s, e) => s + (e.numEntrants || 0), 0);
  const imageUrl = (head.images || []).find(i => i.type === 'profile')?.url ||
                   (head.images || []).find(i => i.type === 'banner')?.url ||
                   (head.images && head.images[0] && head.images[0].url) || null;

  return {
    id: head.id,
    name: head.name,
    slug: head.slug,
    startAt: head.startAt,
    endAt: head.endAt,
    numAttendees: head.numAttendees || 0,
    location: [head.venueName, head.city, head.addrState, head.countryCode].filter(Boolean).join(', '),
    city: head.city || '',
    countryCode: head.countryCode || '',
    image: imageUrl,
    events,
    games,
    players,
    // Aggregates for sponsorship decks.
    summary: {
      attendees: head.numAttendees || 0,
      eventCount: events.length,
      totalEntrants,
      uniquePlayers: players.length,
      games,
      gameCount: games.length,
      startAt: head.startAt,
      endAt: head.endAt
    }
  };
}

// Fetch sub-events (phases) for a tournament so user can pick the right one for entrants/stats.
async function fetchTournamentEvents(apiToken, tournamentSlug) {
  if (!apiToken) throw new Error('API token required');
  const slug = (tournamentSlug || '').trim().replace(/^tournament\//i, '');   // accept bare OR prefixed
  if (!slug) return [];
  const client = createStartGgClient(apiToken);
  const query = `
    query TournamentEvents($slug: String!) {
      tournament(slug: $slug) {
        id
        name
        slug
        events {
          id
          slug
          name
          startAt
          numEntrants
          videogame { name }
        }
      }
    }
  `;
  const res = await client.request(query, { slug: `tournament/${slug}` });
  if (!res || !res.tournament) throw new Error(`Tournament not found on start.gg — check the slug (tried: tournament/${slug})`);
  return (Array.isArray(res.tournament.events) ? res.tournament.events : []).map(e => ({
    id: e.id,
    slug: e.slug,
    name: e.name,
    startAt: e.startAt,
    numEntrants: e.numEntrants || 0,
    game: (e.videogame && e.videogame.name) || '',
    tournamentSlug: slug,
    tournamentName: res.tournament.name || ''
  }));
}

// One start.gg Participant -> our roster-player shape, with the profile registry updated as a
// side effect. Three call sites (event import, eventTeams mapping, live set push) carried
// byte-identical copies of this block. `prefix` is the sponsor/org tag start.gg stores separately
// from the gamerTag ("MVG | Zain" is prefix "MVG", gamerTag "Zain") - it is the only reliable
// source for a SINGLES competitor's team name, since the entrant name mashes the two together.
function startggPlayerFromParticipant(p) {
  const tag = ((p && p.gamerTag) || '').trim();
  const pl = (p && p.player) || {};
  const u = pl.user || {};
  const auths = u.authorizations || [];
  const twitch = (auths.find((a) => a && a.type === 'TWITCH') || {}).externalUsername || null;
  const twitter = (auths.find((a) => a && (a.type === 'TWITTER' || a.type === 'TWITTER_V2')) || {}).externalUsername || null;
  const country = (u.location && u.location.country) || null;
  const countryCode = _countryCode(country);
  const image = ((u.images || []).find((i) => /profile/i.test(i.type || '')) || (u.images || [])[0] || {}).url || null;
  // u.name is the user's display/legal name on start.gg (different from gamerTag)
  const realName = (u.name && u.name.trim() && u.name.trim() !== tag) ? u.name.trim() : null;
  // The event-entry prefix wins over the player's standing one - a competitor who changed orgs
  // still carries the old tag on their player record until they get round to updating it.
  const prefix = ((((p && p.prefix) || pl.prefix || '')) + '').trim() || null;
  const startggPlayerId = pl.id ? String(pl.id) : null;
  if (tag) {
    const patch = {};
    if (u.slug) { patch.startggSlug = u.slug; patch.startggPlayerId = startggPlayerId; }
    if (twitch) patch.twitch = twitch;
    if (twitter) patch.twitter = twitter;
    if (country) patch.country = country;
    if (countryCode) patch.countryCode = countryCode;
    if (image) patch.image = image;
    if (realName) patch.realName = realName;
    if (prefix) patch.prefix = prefix;
    if (Object.keys(patch).length) upsertPlayerProfile(tag, patch);
  }
  // Socials/prefix/realName are mirrored onto the ROSTER entry as well as the profile: overlay
  // scenes read the roster directly, and a profile lookup only resolves while the gamertag still
  // matches exactly - which it stops doing the moment a producer renames the player on the card.
  return {
    id: Math.random().toString(36).slice(2, 11),
    name: tag, platform: 'startgg', platformId: startggPlayerId || '', assignedCamera: null,
    country: country || '', countryCode: countryCode || '',
    prefix: prefix || '', realName: realName || '',
    twitter: twitter || '', twitch: twitch || '',
    startgg: u.slug || '', photo: image || ''
  };
}

// The org/sponsor name for an entrant: the prefix every member shares (a singles entrant has one
// member, so this is just their tag's prefix). Mixed prefixes = a pickup team, which has no org.
function entrantOrgName(players) {
  const tags = (players || []).map((x) => (x.prefix || '').trim()).filter(Boolean);
  if (tags.length && tags.length === (players || []).length &&
      tags.every((t) => t.toLowerCase() === tags[0].toLowerCase())) return tags[0];
  return '';
}

// Map entrants (from fetchAllEntrants) into our eventTeams shape.
// Each entrant is folded into the team vault first, so an org we have branded before shows up with
// its saved logo/colour/abbr on the very first render instead of as an anonymous grey card.
// `resolved` (optional) is a Map of entrant -> vault record from a caller that has already folded
// these entrants in. mergeEntrantsIntoLibrary does exactly that before calling us, and re-running
// the cascade for a 200-entrant field against a 500-team vault is 100k needless comparisons.
function mapEntrantsToTeams(entrants, ctx, resolved) {
  const out = (entrants || []).map((ent) => {
    const name = (ent.name || '').trim();
    if (!name) return null;
    const players = (ent.participants || []).map(startggPlayerFromParticipant).filter((p) => p.name);
    const logo = pickEntrantLogo(ent);
    const team = {
      name,
      logo: logo || null,
      players,
      seed: Number(ent.initialSeedNum) > 0 ? Number(ent.initialSeedNum) : 0,
      org: entrantOrgName(players),
      startggId: ent.id || null
    };
    const rec = resolved ? resolved.get(ent) : ((vaultApplyEntrant(ent, players, ctx) || {}).rec);
    return rec ? vaultDecorateTeam(team, rec) : team;
  }).filter(Boolean);
  vaultTouch();
  // Entrants only tell us who entered. The org's crest and full membership live on its start.gg
  // TEAM page, which this reads in the background — so a producer never has to paste a slug.
  if (!resolved) scheduleVaultEnrich('event teams');
  return out;
}

// Refresh the small vault summary carried in state (the records live outside it).
function vaultTouch() {
  if (!state.teamVault) return;
  try {
    state.teamVault.count = teamDb.count();
    state.teamVault.ver = (state.teamVault.ver || 0) + 1;
  } catch (_) {}
}

// Flat picker list of playable matches (both entrants known), ready first.
function buildMatches(sets) {
  return (Array.isArray(sets) ? sets : [])
    .map((s) => {
      const slots = s.slots || [];
      const a = slots[0] && slots[0].entrant && slots[0].entrant.name;
      const b = slots[1] && slots[1].entrant && slots[1].entrant.name;
      return {
        id: String(s.id),
        round: s.fullRoundText || `Round ${s.round}`,
        a: a || null,
        b: b || null,
        state: s.state || 0   // 1 = not started, 2 = in progress, 3 = completed
      };
    })
    .filter((m) => m.a && m.b)
    // In-progress first, then not-started, then completed last
    .sort((x, y) => {
      const rank = (st) => (st === 2 ? 0 : st === 1 ? 1 : 2);
      return rank(x.state) - rank(y.state);
    });
}

function applyBracketResult(slug, event, sets) {
  const phases = buildPhases(sets, event && event.phases);
  // Keep the active phase across a refresh if it still exists; else first phase.
  const keepId = phases.some((p) => p.id === state.bracket.activePhaseId) ? state.bracket.activePhaseId : (phases[0] && phases[0].id) || '';
  state.bracket = {
    ...state.bracket,
    eventSlug: slug,
    title: (event && event.name) || '',
    phases,
    activePhaseId: keepId,
    matches: buildMatches(sets),
    mode: 'imported',
    source: 'startgg',
    lastFetchAt: new Date().toISOString(),
    lastError: null
  };
  syncActiveBracketPhase();   // mirror active phase → top-level fields the overlay reads
}

// Refresh just the bracket (scores/progression) without re-importing teams.
// ── Phased bracket import ────────────────────────────────────────────────────
// Big events (RLCS: 1600+ sets / 50+ pages) used to import as ONE monolithic sweep:
// the panel's request timed out ("No response from the server") and two sweeps in
// the same minute tripped start.gg's 80 req/min budget. Now:
//   1. one cheap query gets the phase list,
//   2. sets are fetched PER PHASE — live phases first — and the bracket re-assembles
//      and broadcasts after each phase, so the UI fills in progressively,
//   3. COMPLETED phases cache for the app session (their results can't change), so a
//      steady-state refresh only spends requests on the phase that's actually moving,
//   4. rate-limit responses back off and resume instead of failing request #43 of 50.
const _bracketPhaseCache = new Map();   // slug|phaseId -> { sets, phaseState }
let _bracketFetchInFlight = '';         // slug mid-import — never stack a second sweep

// start.gg rate limiting surfaces as a 429/error (sometimes an empty body) — back off
// and retry the ONE page instead of failing the whole import.
// The client (backend/integrations/startgg-client.js) already retries the transient cases —
// timeouts, dropped sockets, 5xx, 429 and 200-with-throttle-error — with its own backoff. This
// outer layer is now ONLY the last-resort long wait for a sustained rate limit that survived all
// of that, i.e. the per-minute quota is genuinely spent. Keeping both layers narrow matters: they
// used to compound (4 client attempts x 4 outer attempts) and could stall an import for minutes.
async function startggRequestWithBackoff(client, query, vars, tries = 2) {
  for (let i = 0; ; i++) {
    try {
      return await client.request(query, vars);
    } catch (e) {
      const msg = String((e && e.message) || '');
      const limited = /429|rate ?limit|too many|throttl/i.test(msg);
      if (!limited || i >= tries - 1) throw e;
      const wait = 20000;
      console.log('[Bracket] start.gg quota spent - waiting ' + (wait / 1000) + 's for the window to roll (page retry ' + (i + 1) + ')');
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// start.gg's documented budget is 80 requests / 60s. The old 500ms page delay paced at up to
// 120/min — over the line by design, so a big sweep TRIPPED the limit and then paid for it in
// multi-second backoffs. 850ms (~70/min) sits under the quota and finishes sooner in wall-clock
// than getting throttled does.
const STARTGG_PAGE_DELAY_MS = 850;
// 32 sets/page. 120 pages = 3840 sets in ONE phase, which covers a 2048-entrant double-elim with
// room over; the old 63-page (2016-set) cap could clip a major open's own bracket.
const PHASE_SETS_MAX_PAGES = 120;
// Phases whose set list hit the cap on the last import — surfaced to the panel so a partial
// bracket announces itself instead of looking like it just ends.
const _bracketTruncated = new Set();

const BRACKET_SET_FIELDS = `
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
            }`;

async function fetchEventPhaseMeta(client, slug) {
  // paged=true asks for pageInfo so we can page past 64 phase groups. If start.gg's schema ever
  // rejects that selection, fall straight back to the original single-page shape — a bracket that
  // imports its first 64 pools beats one that won't import at all.
  const buildQuery = (paged) => `
    query BracketPhases($slug: String!, $page: Int!) {
      event(slug: $slug) {
        id
        name
        tournament { name }
        phases { id name state phaseGroups(query: { perPage: 64, page: $page }) {
          ${paged ? 'pageInfo { totalPages }' : ''}
          nodes { id }
        } }
      }
    }`;
  let paged = true;
  let res;
  try {
    res = await startggRequestWithBackoff(client, buildQuery(true), { slug, page: 1 });
  } catch (e) {
    if (/429|rate ?limit|too many|not found|token/i.test(String((e && e.message) || ''))) throw e;
    console.warn('[Bracket] phaseGroups pageInfo rejected (' + e.message + ') — falling back to a single page of pools');
    paged = false;
    res = await startggRequestWithBackoff(client, buildQuery(false), { slug, page: 1 });
  }
  const query = buildQuery(paged);
  const event = res && res.event;
  if (!event) throw new Error('Event not found — check the slug/URL and your token');

  // phaseGroups was capped at ONE page of 64 with no pagination — a major-scale pool phase
  // (RLCS Opens run far more than 64 pools) silently lost every group past the first 64, so the
  // bracket just stopped partway with no error. Page through any phase that says there's more.
  const phases = event.phases || [];
  for (const ph of phases) {
    const pg = ph && ph.phaseGroups;
    const total = (pg && pg.pageInfo && pg.pageInfo.totalPages) || 1;
    if (total <= 1) continue;
    for (let page = 2; page <= total; page++) {
      await new Promise((r) => setTimeout(r, STARTGG_PAGE_DELAY_MS));
      const more = await startggRequestWithBackoff(client, query, { slug, page });
      const mph = ((more && more.event && more.event.phases) || []).find((x) => x && x.id === ph.id);
      const nodes = (mph && mph.phaseGroups && mph.phaseGroups.nodes) || [];
      pg.nodes = (pg.nodes || []).concat(nodes);
    }
    console.log(`[Bracket] phase "${ph.name || ph.id}" has ${(pg.nodes || []).length} pool group(s) across ${total} page(s)`);
  }
  return event;
}

async function fetchPhaseSets(client, slug, phase) {
  const ids = ((phase.phaseGroups && phase.phaseGroups.nodes) || []).map((g) => g.id).filter((x) => x != null);
  if (!ids.length) return [];
  // ids inlined (server-provided integers): the literal-array form is the one verified
  // against the live API; a typed $ids variable is the only shape we could not test.
  const query = `
    query BracketPhaseSets($slug: String!, $perPage: Int!, $page: Int!) {
      event(slug: $slug) {
        sets(perPage: $perPage, page: $page, sortType: ROUND, filters: { phaseGroupIds: [${ids.join(', ')}] }) {
          pageInfo { totalPages }
          nodes {${BRACKET_SET_FIELDS}
          }
        }
      }
    }`;
  const all = [];
  let page = 1, totalPages = 1;
  do {
    if (page > 1) await new Promise((r) => setTimeout(r, STARTGG_PAGE_DELAY_MS));   // stay under start.gg's 80 req/min
    const res = await startggRequestWithBackoff(client, query, { slug, perPage: 32, page });
    const sets = res && res.event && res.event.sets;
    if (!sets) break;
    all.push(...(sets.nodes || []));
    totalPages = (sets.pageInfo && sets.pageInfo.totalPages) || 1;
    page++;
  } while (page <= totalPages && page <= PHASE_SETS_MAX_PAGES);
  // Never truncate silently: a bracket that just stops mid-phase reads as a bug in the overlay,
  // not as a cap we chose. Say so in the log and hand the count back to the caller.
  if (totalPages > PHASE_SETS_MAX_PAGES) {
    console.warn(`[Bracket] phase "${phase.name || phase.id}" has ${totalPages} pages of sets — capped at ${PHASE_SETS_MAX_PAGES} (${all.length} sets loaded). Raise PHASE_SETS_MAX_PAGES if a real event needs it.`);
    _bracketTruncated.add(String(phase.name || phase.id));
  }
  return all;
}

async function fetchBracket(rawSlug) {
  if (!ctx.startggApiToken) throw new Error('No start.gg API token yet. Add it under Apps > start.gg.');
  const slug = parseEventSlug(rawSlug);
  if (!slug) throw new Error('Missing event slug or URL');
  if (_bracketFetchInFlight === slug) {
    // An import for this event is already running — report it instead of stacking
    // another 50-request sweep on the same rate budget.
    return { title: state.bracket.title || '', type: state.bracket.type,
      rounds: state.bracket.winners.length + state.bracket.losers.length + state.bracket.finals.length,
      sets: (state.bracket.matches || []).length, inProgress: true };
  }
  _bracketFetchInFlight = slug;
  _bracketTruncated.clear();   // per-import: only report caps this sweep actually hit
  try {
    const client = createStartGgClient(ctx.startggApiToken);
    const event = await fetchEventPhaseMeta(client, slug);
    const phases = event.phases || [];
    // Fetch order: live phases first, then upcoming, COMPLETED last (usually cache
    // hits) — the part of the bracket people are watching lands on the overlay first.
    const rank = (p) => (p.state === 'ACTIVE' ? 0 : p.state !== 'COMPLETED' ? 1 : 2);
    const order = [...phases].sort((a, b) => rank(a) - rank(b));
    const combined = () => phases.flatMap((p) => ((_bracketPhaseCache.get(slug + '|' + p.id) || {}).sets) || []);
    let done = 0;
    for (const ph of order) {
      const key = slug + '|' + ph.id;
      const cached = _bracketPhaseCache.get(key);
      const settled = ph.state === 'COMPLETED' && cached && cached.phaseState === 'COMPLETED';
      if (!settled) {
        const sets = await fetchPhaseSets(client, slug, ph);
        _bracketPhaseCache.set(key, { sets, phaseState: ph.state });
        await new Promise((r) => setTimeout(r, STARTGG_PAGE_DELAY_MS));   // breathe between phases
      }
      done++;
      state.bracket.progress = done < order.length ? { done, total: order.length, phase: ph.name || '' } : null;
      // `bracket` is a LIBRARY-tier key, so progress written into state never rode the live
      // broadcast — and nothing read it either. Push it as its own tiny message instead: on a
      // major event this loop runs for minutes and the producer needs to see it moving.
      broadcastBracketProgress(done, order.length, ph.name || '');
      applyBracketResult(slug, event, combined());
      broadcastFullState();   // the bracket fills in phase by phase
    }
    saveAppState();
    syncAllLinkedChallongeTournaments().catch(() => {});
    const rounds = state.bracket.winners.length + state.bracket.losers.length + state.bracket.finals.length;
    const truncated = [..._bracketTruncated];
    return { title: event.name || '', tournamentName: (event.tournament && event.tournament.name) || '', type: state.bracket.type, rounds, sets: combined().length, truncated };
  } finally {
    _bracketFetchInFlight = '';
    // Always clear progress — a failed import used to leave a stale "importing phase X" object
    // in state forever, because the reset only ran on the success path.
    state.bracket.progress = null;
    broadcastBracketProgress(0, 0, '');
  }
}

// One small message rather than a full_state, so phase-by-phase progress is cheap to send.
// total 0 = finished/idle (the panel clears its line).
function broadcastBracketProgress(done, total, phase) {
  broadcast(ctx.bridgeClients, { type: 'bracket-progress', data: { done, total, phase } });
}

// ISO 3166-1 alpha-2 lookup for the most common esports countries.
const _COUNTRY_CODES = {
  'united states': 'us', 'usa': 'us', 'united states of america': 'us', 'america': 'us',
  'united states minor outlying islands': 'um', 'u.s. minor outlying islands': 'um',
  'puerto rico': 'pr', 'guam': 'gu', 'u.s. virgin islands': 'vi', 'united states virgin islands': 'vi', 'american samoa': 'as',
  'canada': 'ca', 'united kingdom': 'gb', 'uk': 'gb', 'great britain': 'gb',
  'england': 'gb', 'scotland': 'gb', 'wales': 'gb', 'northern ireland': 'gb',
  'ireland': 'ie', 'republic of ireland': 'ie',
  'australia': 'au', 'new zealand': 'nz', 'germany': 'de', 'france': 'fr',
  'sweden': 'se', 'norway': 'no', 'denmark': 'dk', 'finland': 'fi', 'iceland': 'is',
  'netherlands': 'nl', 'the netherlands': 'nl', 'holland': 'nl', 'belgium': 'be',
  'switzerland': 'ch', 'austria': 'at', 'luxembourg': 'lu',
  'spain': 'es', 'portugal': 'pt', 'italy': 'it', 'greece': 'gr', 'cyprus': 'cy', 'malta': 'mt',
  'poland': 'pl', 'czechia': 'cz', 'czech republic': 'cz', 'slovakia': 'sk', 'hungary': 'hu',
  'romania': 'ro', 'bulgaria': 'bg', 'moldova': 'md', 'ukraine': 'ua', 'belarus': 'by',
  'russia': 'ru', 'russian federation': 'ru', 'turkey': 'tr', 'türkiye': 'tr',
  'croatia': 'hr', 'serbia': 'rs', 'slovenia': 'si', 'bosnia and herzegovina': 'ba', 'bosnia': 'ba',
  'north macedonia': 'mk', 'macedonia': 'mk', 'montenegro': 'me', 'albania': 'al', 'kosovo': 'xk',
  'estonia': 'ee', 'latvia': 'lv', 'lithuania': 'lt',
  'georgia': 'ge', 'armenia': 'am', 'azerbaijan': 'az', 'kazakhstan': 'kz',
  'israel': 'il', 'south africa': 'za', 'nigeria': 'ng', 'egypt': 'eg', 'morocco': 'ma',
  'tunisia': 'tn', 'algeria': 'dz', 'kenya': 'ke', 'ghana': 'gh',
  'saudi arabia': 'sa', 'united arab emirates': 'ae', 'uae': 'ae', 'qatar': 'qa', 'kuwait': 'kw',
  'bahrain': 'bh', 'oman': 'om', 'jordan': 'jo', 'lebanon': 'lb', 'iraq': 'iq', 'iran': 'ir',
  'brazil': 'br', 'mexico': 'mx', 'argentina': 'ar', 'chile': 'cl',
  'colombia': 'co', 'peru': 'pe', 'venezuela': 've', 'ecuador': 'ec', 'bolivia': 'bo',
  'uruguay': 'uy', 'paraguay': 'py', 'costa rica': 'cr', 'panama': 'pa', 'guatemala': 'gt',
  'dominican republic': 'do', 'puerto rico': 'pr', 'jamaica': 'jm', 'trinidad and tobago': 'tt',
  'japan': 'jp', 'south korea': 'kr', 'korea': 'kr', 'north korea': 'kp', 'china': 'cn',
  'taiwan': 'tw', 'hong kong': 'hk', 'macau': 'mo', 'singapore': 'sg', 'indonesia': 'id',
  'malaysia': 'my', 'philippines': 'ph', 'thailand': 'th', 'vietnam': 'vn', 'myanmar': 'mm',
  'cambodia': 'kh', 'laos': 'la', 'mongolia': 'mn',
  'india': 'in', 'pakistan': 'pk', 'bangladesh': 'bd', 'sri lanka': 'lk', 'nepal': 'np',
};
function _countryCode(name) {
  if (!name) return null;
  const s = name.trim().toLowerCase();
  if (/^[a-z]{2}$/.test(s)) return s;
  return _COUNTRY_CODES[s] || null;
}

// Merge a list of Start.gg entrants into the saved team library (update by name,
// don't clobber custom logos) and refresh the transient eventTeams list.
function mergeEntrantsIntoLibrary(entrants, ctx) {
  let teamsAdded = 0, playersTotal = 0, logosFound = 0, vaultMatched = 0, vaultLogos = 0;
  const resolved = new Map();   // entrant -> vault record, reused by mapEntrantsToTeams below
  (entrants || []).forEach((ent) => {
    const name = (ent.name || '').trim();
    if (!name) return;
    const players = (ent.participants || []).map(startggPlayerFromParticipant).filter((p) => p.name);
    playersTotal += players.length;
    const seed = Number(ent.initialSeedNum) > 0 ? Number(ent.initialSeedNum) : 0;
    const org = entrantOrgName(players);

    const logo = pickEntrantLogo(ent);
    if (logo) logosFound++;

    // Ask the vault who this is BEFORE touching the library. It matches on the permanent start.gg
    // team id/slug, then any name this org has competed under, then roster overlap — so a rebrand
    // or a squad that dropped one player still lands on the record the producer already branded,
    // instead of arriving as a brand-new nameless team.
    const v = vaultApplyEntrant(ent, players, ctx);
    const rec = v && v.rec;
    if (rec) resolved.set(ent, rec);
    if (rec && v.via) vaultMatched++;

    // Vault branding overrides the import. Its logo is the whole point: most orgs never upload a
    // crest to start.gg, so `logo` here is usually null and the producer's saved one is all we have.
    const useName  = (rec && rec.pins && rec.pins.name && rec.name) ? rec.name : name;
    const useLogo  = (rec && rec.logo) || logo || null;
    if (rec && rec.logo && !logo) vaultLogos++;

    const startggId = (ent.id != null) ? String(ent.id) : null;
    const key = useName.toLowerCase();
    // Match the library entry by the vault id first — that's what survives a rename. Falling
    // straight to the name lookup (as this used to) meant a renamed team was appended as a
    // duplicate and the branded original was orphaned.
    let existing = null;
    if (rec) existing = ctx.savedTeams.find((t) => t && t.vaultId === rec.id);
    if (!existing) existing = ctx.savedTeams.find((t) => (t.name || '').toLowerCase() === key);
    if (!existing && useName.toLowerCase() !== name.toLowerCase()) {
      existing = ctx.savedTeams.find((t) => (t.name || '').toLowerCase() === name.toLowerCase());
    }

    if (existing) {
      if (players.length) existing.players = players;            // refresh roster
      if (useLogo && (!existing.logo || (rec && rec.logo))) existing.logo = useLogo;   // vault wins, raw import only fills a gap
      if (startggId) existing.startggId = startggId;             // tag for exact, collision-proof matching on push
      if (seed) existing.seed = seed;
      if (org) existing.org = org;
      if (rec) {
        existing.vaultId = rec.id;
        if (rec.startggTeamId) existing.startggTeamId = rec.startggTeamId;
        if (rec.startggSlug)   existing.startggSlug   = rec.startggSlug;
        if (rec.color) existing.color = rec.color;
        if (rec.abbr)  existing.abbr  = rec.abbr;
        if (rec.pins && rec.pins.name && rec.name) existing.name = rec.name;
      }
    } else {
      const row = { name: useName, logo: useLogo, players, seed, org, startggId };
      if (rec) {
        row.vaultId = rec.id;
        if (rec.startggTeamId) row.startggTeamId = rec.startggTeamId;
        if (rec.startggSlug)   row.startggSlug   = rec.startggSlug;
        if (rec.color) row.color = rec.color;
        if (rec.abbr)  row.abbr  = rec.abbr;
      }
      ctx.savedTeams.push(row);
      teamsAdded++;
    }
  });
  // Keep the transient picker list + name→logo map in sync too.
  state.startgg.eventTeams = mapEntrantsToTeams(entrants, ctx, resolved);
  indexEntrantLogos(entrants);
  if (state.teamVault) state.teamVault.lastMatch = { at: Date.now(), matched: vaultMatched, logosRestored: vaultLogos, total: (entrants || []).length };
  vaultTouch();
  scheduleVaultEnrich('library merge');
  return { teamsAdded, playersTotal, logosFound, vaultMatched, vaultLogos };
}

// Teams-only import (for the Teams page "Pull from start.gg") — no bracket touch.
async function importStartggTeams(rawSlug) {
  if (!ctx.startggApiToken) throw new Error('No start.gg API token yet. Add it under Apps > start.gg.');
  const { tournamentSlug, eventSlug: parsedSlug } = parseStartggInput(rawSlug);
  const client = createStartGgClient(ctx.startggApiToken);
  let slug = parsedSlug;

  if (!slug && tournamentSlug) {
    // Tournament-only URL — auto-pick the event with the most entrants.
    const res = await client.request(`
      query TEvents($slug: String!) {
        tournament(slug: $slug) { events { slug numEntrants } }
      }`, { slug: 'tournament/' + tournamentSlug });
    const events = (res?.tournament?.events || []).sort((a, b) => (b.numEntrants || 0) - (a.numEntrants || 0));
    if (!events.length) throw new Error('No events found in that tournament');
    slug = events[0].slug;
  }

  if (!slug) throw new Error('Paste a start.gg event or tournament URL');
  const entrants = await fetchAllEntrants(client, slug);
  const r = mergeEntrantsIntoLibrary(entrants, { eventSlug: slug });
  saveTeams();
  saveAppState();
  broadcastFullState();
  return { teams: entrants.length, teamsAdded: r.teamsAdded, players: r.playersTotal, logos: r.logosFound };
}

// One-shot: load EVERYTHING for an event — teams, players, and the bracket.
// Adopt an imported event's OWN title as the show title.
//
// Pulled once per event: loading a DIFFERENT event overwrites whatever the last one left behind,
// but re-activating the SAME event (a refresh, a re-pasted link) never stomps a title the producer
// typed by hand — so it stays editable after import, which is the whole point.
//
// start.gg has always done this inline; Challonge, NXGEN and FACEIT only ever set
// activeEvent.name, so importing through those APIs left the PREVIOUS event's title on air.
// One rule, four callers, so they can't drift again.
function adoptEventName(slug, name) {
  const s = String(slug || '').trim();
  const n = String(name || '').trim();
  if (!s || !n) return false;
  const isNewEvent = state.eventNameSlug !== s;
  if (!state.eventName || isNewEvent) state.eventName = n;
  state.eventNameSlug = s;
  return isNewEvent;
}

async function loadEvent(rawSlug) {
  if (!ctx.startggApiToken) throw new Error('No start.gg API token yet. Add it under Apps > start.gg.');
  const slug = parseEventSlug(rawSlug);
  if (!slug) throw new Error('Missing event slug or URL');

  const client = createStartGgClient(ctx.startggApiToken);
  // TEAMS FIRST: entrants are ~10-20 requests and they're what the user is waiting
  // to see — apply and broadcast them before starting the long phased bracket import.
  const entrants = await fetchAllEntrants(client, slug);
  // Only populate the transient event roster — don't touch savedTeams (user saves manually)
  const eventTeams = mapEntrantsToTeams(entrants, { eventSlug: slug });
  state.startgg.eventTeams = eventTeams;
  indexEntrantLogos(entrants);
  broadcastFullState();
  // Bracket via the phased import (live phase first, completed phases cached,
  // progressive broadcasts) — the old single fetchAllSets sweep timed out on
  // RLCS-scale events and tripped start.gg rate limits.
  const bk = await fetchBracket(slug);
  const event = { name: state.bracket.title || bk.title || '', tournament: { name: bk.tournamentName || '' } };

  const players = eventTeams.reduce((sum, t) => sum + (t.players ? t.players.length : 0), 0);
  const logos = eventTeams.filter(t => t.logo).length;

  saveAppState();
  broadcastFullState();

  return {
    title: event.name || '',
    tournamentName: (event.tournament && event.tournament.name) || '',
    type: state.bracket.type,
    teams: entrants.length,
    players,
    logos,
    sets: bk.sets
  };
}

// Load teams (with players) for the selected event WITHOUT merging into savedTeams.
// Used for the transient "start.gg teams" list. Also updates selectedEvent + tournamentSlug.
async function loadStartggEventTeams(tournamentSlug, eventSlug) {
  if (!ctx.startggApiToken) throw new Error('No start.gg API token yet. Add it under Apps > start.gg.');
  const slug = parseEventSlug(eventSlug || tournamentSlug || '');
  if (!slug) throw new Error('Missing tournament or event slug');

  const client = createStartGgClient(ctx.startggApiToken);
  const entrantsRaw = await fetchAllEntrants(client, slug);
  const teams = mapEntrantsToTeams(entrantsRaw, { eventSlug: slug });

  // Update state
  state.startgg.tournamentSlug = (tournamentSlug || state.startgg.tournamentSlug || '').trim();
  if (eventSlug) state.startgg.eventSlug = eventSlug.trim();

  state.startgg.selectedEvent = {
    tournamentSlug: (tournamentSlug || '').trim() || state.startgg.tournamentSlug,
    eventSlug: (eventSlug || '').trim(),
    name: '', // can be enriched if we fetch event name
    tournamentName: ''
  };

  state.startgg.eventTeams = teams;

  saveAppState();
  broadcastFullState();

  return { teams: teams.length, players: teams.reduce((n, t) => n + (t.players ? t.players.length : 0), 0) };
}

// Best team logo from a Start.gg entrant's linked team (null for ad-hoc entrants).
// The event team's own images are checked first, then the org's GlobalTeam crest — plenty of orgs
// have a logo on their permanent team page and none on the per-event entry.
function pickEntrantLogo(ent) {
  const team = (ent && ent.team) || {};
  const imgs = [...(team.images || []), ...((team.globalTeam && team.globalTeam.images) || [])];
  if (!imgs.length) return null;
  const profile = imgs.find((i) => i.type === 'profile' && i.url);
  if (profile) return profile.url;
  const any = imgs.find((i) => i.url);
  return any ? any.url : null;
}

// The permanent identity of the org behind an entrant, if start.gg has one. `discriminator` is the
// public /team/<slug> path; the id is the numeric key. Ad-hoc entrants (most pickup squads) have
// neither, which is exactly why the vault also matches on roster overlap.
function entrantGlobalTeam(ent) {
  const gt = (ent && ent.team && ent.team.globalTeam) || null;
  if (!gt) return { startggTeamId: null, startggSlug: null };
  return {
    startggTeamId: gt.id != null ? String(gt.id) : null,
    startggSlug: gt.discriminator || null,
  };
}

// One entrant -> the platform-neutral team signature the vault resolves on.
function entrantTeamSignature(ent, players) {
  const gt = entrantGlobalTeam(ent);
  return {
    name: (ent && ent.name || '').trim(),
    startggTeamId: gt.startggTeamId,
    startggSlug: gt.startggSlug,
    logo: pickEntrantLogo(ent),
    entrantId: (ent && ent.id != null) ? String(ent.id) : null,
    seed: Number(ent && ent.initialSeedNum) > 0 ? Number(ent.initialSeedNum) : 0,
    players: (players || []).map((p) => ({ ...p, startggPlayerId: p.platformId || p.startggPlayerId || '' })),
  };
}

// Fold an entrant into the team vault and hand back the branding the vault says is correct.
// This is the single choke point that makes a producer's edits survive into future events: the
// import provides the roster, the vault provides the name/logo/colour/abbr once they've been set.
// Returns null when the vault is disabled, so every caller falls straight back to raw start.gg.
function vaultApplyEntrant(ent, players, ctx) {
  if (!state.teamVault || !state.teamVault.enabled) return null;
  try {
    const sig = entrantTeamSignature(ent, players);
    if (!sig.name) return null;
    // autoLink off = the vault is a curated list: it enriches teams the producer has banked and
    // stays silent on everyone else, rather than growing a record for all 200 entrants of an open.
    if (!state.teamVault.autoLink) {
      const found = teamDb.resolve(sig);
      if (!found.rec) return null;
    }
    const { rec, via, created } = teamDb.applyEntrant(sig, ctx || {});
    if (!rec) return null;
    return { rec, via, created };
  } catch (e) {
    console.warn('[TeamVault] applyEntrant failed:', e.message);
    return null;
  }
}

// Copy ONE event team into the working library. Both "Save" paths off the Event Teams grid used to
// rebuild the row from three fields, which silently dropped the team's colour, abbreviation,
// favourite flag and start.gg entrant id every time a producer pressed Save. Spread the existing
// row instead, and carry the vault link across so the record stays findable next event.
function saveEventTeamToLibrary(team) {
  if (!team || !(team.name || '').trim()) return null;
  const _tn = (x) => (x || '').trim().toLowerCase();
  let row = (team.vaultId && ctx.savedTeams.find((t) => t && t.vaultId === team.vaultId)) ||
            ctx.savedTeams.find((t) => _tn(t.name) === _tn(team.name));
  const players = (team.players && team.players.length) ? team.players : ((row && row.players) || []);
  if (row) {
    row.name = team.name;
    if (!row.logo && team.logo) row.logo = team.logo;    // a custom logo already set here wins
    row.players = players;
  } else {
    row = { name: team.name, logo: team.logo || null, players };
    ctx.savedTeams.push(row);
  }
  ['color', 'abbr', 'seed', 'org', 'startggId', 'vaultId', 'startggTeamId', 'startggSlug']
    .forEach((f) => { if (team[f] !== undefined && team[f] !== null && team[f] !== '') row[f] = team[f]; });
  return row;
}

// Push a vault record into the working team library (savedTeams) — matched on the vault id so a
// renamed team updates its own row instead of spawning a second one. Only the ACTIVE roster ships;
// see teamDb.toLibraryTeam.
function applyVaultToLibrary(rec) {
  if (!rec) return null;
  const lib = teamDb.toLibraryTeam(rec);
  const _tn = (x) => (x || '').trim().toLowerCase();
  let row = ctx.savedTeams.find((t) => t && t.vaultId === rec.id) ||
            ctx.savedTeams.find((t) => _tn(t.name) === _tn(rec.name)) ||
            ctx.savedTeams.find((t) => (rec.aliases || []).includes(teamDb.norm(t.name || '')));
  if (row) {
    row.name = lib.name;
    if (lib.logo)  row.logo  = lib.logo;
    if (lib.color) row.color = lib.color;
    if (lib.abbr)  row.abbr  = lib.abbr;
    if (lib.players.length) row.players = lib.players;
    row.vaultId = rec.id;
    if (rec.startggTeamId) row.startggTeamId = rec.startggTeamId;
    if (rec.startggSlug)   row.startggSlug   = rec.startggSlug;
  } else {
    row = lib;
    ctx.savedTeams.push(row);
  }
  return row;
}

// Overlay the vault's producer-owned branding + roster extras onto a freshly imported team object.
// start.gg still owns WHO entered; the vault owns what they look like on air.
function vaultDecorateTeam(team, rec) {
  if (!rec) return team;
  const out = { ...team, vaultId: rec.id };
  if (rec.startggTeamId) out.startggTeamId = rec.startggTeamId;
  if (rec.startggSlug)   out.startggSlug   = rec.startggSlug;
  if (rec.pins && rec.pins.name && rec.name) out.name = rec.name;
  if (rec.logo)  out.logo  = rec.logo;                       // vault logo always wins — it's the fix
  // Seed the name→logo map too, so the stream queue / bracket / upcoming overlay resolve this
  // crest with a hash lookup instead of falling through to logoForTeamName's vault scan.
  if (rec.logo && out.name) state.startgg.logoMap[out.name.trim().toLowerCase()] = rec.logo;
  if (rec.color) out.color = rec.color;
  if (rec.abbr)  out.abbr  = rec.abbr;
  // Carry the producer's per-player extras (photo, role, camera slot, socials) onto the imported
  // roster, matched on the vault's own player key so a gamertag change doesn't lose them.
  if (Array.isArray(out.players) && out.players.length && Array.isArray(rec.roster)) {
    const byKey = new Map();
    rec.roster.forEach((p) => { const k = teamDb.playerKey(p); if (k) byKey.set(k, p); });
    out.players = out.players.map((p) => {
      const saved = byKey.get(teamDb.playerKey({ ...p, startggPlayerId: p.platformId || '' }));
      if (!saved) return p;
      const merged = { ...p };
      ['photo', 'role', 'camSlot', 'assignedCamera', 'discord', 'instagram', 'tiktok', 'youtube', 'info', 'sixmans', 'status']
        .forEach((f) => { if (!merged[f] && saved[f]) merged[f] = saved[f]; });
      if (saved.id) merged.id = saved.id;
      return merged;
    });
  }
  return out;
}

// ── Pull a team straight from its start.gg team page ───────────────────────
//
// The other direction from an event import: instead of waiting for an org to enter something and
// scraping them out of the entrant list, point at start.gg/team/<slug> and bank them now — logo,
// full roster, and (the part an event import can never tell you) who is a CURRENT member versus an
// alum. start.gg's TeamMember.status carries exactly that, so the vault's active/inactive split
// comes back correct on the first pull.

function parseStartggTeamSlug(input) {
  const s = _stripStartggWhitespace(input).replace(/^https?:\/\/(www\.)?start\.gg\//i, '');
  if (!s) return '';
  const m = s.match(/team\/([^/?#]+)/i);
  return m ? m[1] : s.split(/[/?#]/)[0];
}

// start.gg's own member states. ACCEPTED is on the roster today; ALUM is explicitly a past member;
// an invite that was never accepted has no business showing on a broadcast graphic either.
function _memberIsActive(m) {
  const st = String((m && m.status) || '').toUpperCase();
  if (!st) return true;                 // schema tier that couldn't query status — assume current
  return st === 'ACCEPTED';
}

async function fetchStartggTeam(client, slug) {
  // Tried strongest-first; each tier drops one thing start.gg's schema might refuse, so a partial
  // answer still beats failing the pull outright.
  const tiers = [
    `query T($slug: String!) { team(slug: $slug) { id name discriminator images { url type }
        ... on GlobalTeam { members { id status isCaptain isAlternate
            player { id gamerTag prefix user { slug name images { url type } authorizations { type externalUsername } location { country } } } } } } }`,
    `query T($slug: String!) { team(slug: $slug) { id name discriminator images { url type }
        ... on GlobalTeam { members { id status
            player { id gamerTag prefix user { slug name images { url type } } } } } } }`,
    `query T($slug: String!) { team(slug: $slug) { id name discriminator images { url type }
        ... on GlobalTeam { members { player { id gamerTag user { slug name } } } } } }`,
    `query T($slug: String!) { team(slug: $slug) { id name discriminator images { url type } } }`,
  ];
  // A start.gg team slug is addressed as "team/<discriminator>"; a producer will paste either form
  // (or the whole URL), so try the prefixed one first and the bare token second.
  const candidates = [`team/${slug}`, slug];
  let lastErr = null;
  for (const cand of candidates) {
    for (const q of tiers) {
      let res;
      try { res = await client.request(q, { slug: cand }); }
      catch (e) { lastErr = e; continue; }          // schema error → next (simpler) tier
      if (res && res.team) return res.team;
      break;                                        // query ran fine, this slug just isn't a team
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

// Apply one FETCHED start.gg team to the vault. Split out from the slug import because the
// automatic sweep below needs exactly the same work — the two used to be one function, which is
// why the only way to bank a team was to paste its URL by hand.
function applyStartggTeamToVault(team, slugHint, ctx) {
  const members = Array.isArray(team.members) ? team.members : [];
  // Reuse the ONE participant→player mapper so a team-page pull produces byte-identical player
  // objects to an event import (and updates playerProfiles the same way) — otherwise the same
  // human resolves differently depending on which door they came in through.
  const rows = members.map((m) => ({
    player: startggPlayerFromParticipant({ gamerTag: (m.player && m.player.gamerTag) || '', prefix: (m.player && m.player.prefix) || '', player: m.player || {} }),
    active: _memberIsActive(m),
    alternate: !!m.isAlternate,
    captain: !!m.isCaptain,
  })).filter((r) => r.player.name);

  const imgs = team.images || [];
  const logo = ((imgs.find((i) => i.type === 'profile' && i.url) || imgs.find((i) => i.url) || {}).url) || null;

  const sig = {
    name: (team.name || slugHint || '').trim(),
    startggTeamId: team.id != null ? String(team.id) : null,
    startggSlug: team.discriminator || slugHint || null,
    logo,
    // EVERY member goes in, current and alum alike — the alums are the roster history the vault
    // exists to keep. Their status is corrected immediately below.
    players: rows.map((r) => ({ ...r.player, startggPlayerId: r.player.platformId || '', role: r.alternate ? 'Sub' : (r.captain ? 'Captain' : (r.player.role || '')) })),
  };
  if (!sig.name) return null;
  const { rec, via, created } = teamDb.applyEntrant(sig, ctx || { eventSlug: null });
  if (!rec) return null;

  // applyEntrant marks everyone it was handed as active (it can't know about alums), so apply
  // start.gg's own membership state on top.
  let activeCount = 0;
  rows.forEach((r) => {
    const key = teamDb.playerKey({ ...r.player, startggPlayerId: r.player.platformId || '' });
    if (!key) return;
    if (r.active) activeCount++;
    else teamDb.setRosterStatus(rec.id, key, 'inactive');
  });
  // Stamp WHEN we last read the team page, so the sweep can skip records it already knows about
  // instead of re-querying the whole vault on every import.
  teamDb.update(rec.id, { enrichedAt: Date.now() });
  const fresh = teamDb.get(rec.id) || rec;

  return {
    id: fresh.id, rec: fresh,
    name: fresh.name,
    slug: fresh.startggSlug,
    startggTeamId: fresh.startggTeamId,
    logo: !!fresh.logo,
    members: rows.length,
    active: activeCount,
    inactive: rows.length - activeCount,
    created, matchedVia: via,
  };
}

// Re-read one banked team's start.gg page right now — the vault UI's "Check start.gg" button.
// Unlike the background sweep this ignores the weekly re-read window and reports what changed, so
// the producer gets an answer rather than a silent no-op when the crest is already current.
async function refreshVaultTeamFromStartgg(id) {
  const rec = teamDb.get(id);
  if (!rec) throw new Error('Not found');
  if (!ctx.startggApiToken) throw new Error('No start.gg API token yet. Add it under Apps > start.gg.');
  const slug = rec.startggSlug || rec.startggTeamId;
  if (!slug) throw new Error('This team has no start.gg team slug — add one above, then check again');

  const priorLogo = rec.logo || null;
  const client = createStartGgClient(ctx.startggApiToken);
  const team = await fetchStartggTeam(client, slug);
  if (!team) {
    teamDb.update(rec.id, { enrichedAt: Date.now() });
    throw new Error('start.gg has no team page for "' + slug + '" any more — check the slug');
  }
  const out = applyStartggTeamToVault(team, rec.startggSlug || '');
  if (!out) throw new Error('Could not store the team');

  const fresh = out.rec;
  // A pinned logo is left alone on purpose; the producer still gets told a different crest exists
  // and can take it from the start.gg tile in the vault card.
  const changed = !!(fresh.logo && fresh.logo !== priorLogo);
  if (changed) { if (adoptVaultCrest(fresh, true)) saveTeams(); }
  vaultTouch();
  broadcastFullState();
  return {
    team: fresh,
    logoChanged: changed,
    startggLogo: fresh.startggLogo || null,
    // The interesting case for the UI: start.gg has something newer but a pin is holding it back.
    startggLogoDiffers: !!(fresh.startggLogo && fresh.startggLogo !== fresh.logo),
    pinned: !!(fresh.pins && fresh.pins.logo),
  };
}

// Import (or refresh) one start.gg team into the vault from a slug or URL. This is the OPTIONAL
// manual door — for an org that hasn't entered one of your events yet, so the automatic sweep has
// never seen them. `alsoLibrary` additionally drops it into the working team library.
async function importStartggTeamBySlug(rawSlug, opts = {}) {
  if (!ctx.startggApiToken) throw new Error('No start.gg API token yet. Add it under Apps > start.gg.');
  const slug = parseStartggTeamSlug(rawSlug);
  if (!slug) throw new Error('Paste a start.gg team URL or slug');

  const client = createStartGgClient(ctx.startggApiToken);
  const team = await fetchStartggTeam(client, slug);
  if (!team) throw new Error(`No start.gg team found for "${slug}" — check the URL (it should look like start.gg/team/abc123)`);

  const out = applyStartggTeamToVault(team, slug);
  if (!out) throw new Error('Could not store the team');

  if (opts.alsoLibrary !== false) { applyVaultToLibrary(out.rec); saveTeams(); }
  vaultTouch();
  broadcastFullState();
  return out;
}

// ── Automatic enrichment ───────────────────────────────────────────────────
//
// An event import already learns each entrant's permanent GlobalTeam slug for free (see
// entrantGlobalTeam) — but the entrant only tells us who ENTERED. The team page is where the org's
// crest and its full membership (including alumni) live. So after every import, quietly walk the
// records that carry a slug and haven't been read recently, and fill them in.
//
// Nothing here blocks an import: the sweep runs detached, paces itself under start.gg's 80 req/min,
// and reports progress through state.teamVault.enrich for the panel to display.

const VAULT_ENRICH_TTL_MS   = 7 * 24 * 60 * 60 * 1000;   // re-read a team page at most weekly
const VAULT_ENRICH_MAX      = 120;                        // per sweep; the rest is picked up next time
const VAULT_ENRICH_START_MS = 4000;                       // let the import's own broadcasts settle first
let _vaultEnrichRunning = false;
let _vaultEnrichTimer   = null;

function _vaultEnrichState(patch) {
  if (!state.teamVault) return;
  state.teamVault.enrich = { ...(state.teamVault.enrich || {}), ...patch };
}

// Which banked teams are worth asking start.gg about right now.
function vaultEnrichTargets(force) {
  return teamDb.all().filter((t) => {
    if (!t.startggSlug && !t.startggTeamId) return false;   // no team page to read
    if (force) return true;
    if (!t.enrichedAt) return true;
    return (Date.now() - t.enrichedAt) > VAULT_ENRICH_TTL_MS;
  });
}

async function enrichVaultFromStartgg(opts = {}) {
  if (_vaultEnrichRunning) return { skipped: 'already running' };
  if (!ctx.startggApiToken) return { skipped: 'no start.gg token' };
  if (!state.teamVault || !state.teamVault.enabled) return { skipped: 'vault off' };

  const targets = vaultEnrichTargets(!!opts.force).slice(0, opts.limit || VAULT_ENRICH_MAX);
  if (!targets.length) { _vaultEnrichState({ running: false, done: 0, total: 0, lastAt: Date.now() }); return { updated: 0, total: 0 }; }

  _vaultEnrichRunning = true;
  _vaultEnrichState({ running: true, done: 0, total: targets.length, updated: 0, failed: 0 });
  broadcastFullState();

  const client = createStartGgClient(ctx.startggApiToken);
  let updated = 0, failed = 0, logosGained = 0, libraryTouched = false;
  for (let i = 0; i < targets.length; i++) {
    const rec = teamDb.get(targets[i].id);
    if (!rec) continue;
    const slug = rec.startggSlug || rec.startggTeamId;
    const priorLogo = rec.logo || null;
    try {
      const team = await fetchStartggTeam(client, slug);
      if (team) {
        const r = applyStartggTeamToVault(team, rec.startggSlug || '');
        if (r) {
          updated++;
          // A CHANGED crest counts, not just a first one. The old test (`!hadLogo`) meant a
          // rebrand never reached the library — the vault learned the new logo and the overlays
          // kept airing the old one.
          if (r.rec && r.rec.logo && r.rec.logo !== priorLogo) {
            logosGained++;
            libraryTouched = adoptVaultCrest(r.rec) || libraryTouched;
          }
        }
      } else {
        // The slug resolved to nothing — stamp it anyway so a dead link isn't retried every import.
        teamDb.update(rec.id, { enrichedAt: Date.now() });
      }
    } catch (e) {
      failed++;
      // A rate limit means the whole sweep should stop and try again later, not hammer on.
      if (/429|rate ?limit|too many|throttl/i.test(String(e && e.message || ''))) break;
      teamDb.update(rec.id, { enrichedAt: Date.now() });
    }
    _vaultEnrichState({ done: i + 1, updated, failed });
    if (i < targets.length - 1) await new Promise((r) => setTimeout(r, STARTGG_PAGE_DELAY_MS));
  }

  _vaultEnrichRunning = false;
  _vaultEnrichState({ running: false, lastAt: Date.now(), updated, failed, logosGained });
  if (libraryTouched) saveTeams();
  vaultTouch();
  broadcastFullState();
  console.log(`[TeamVault] Auto-enriched ${updated}/${targets.length} team page(s)${logosGained ? `, ${logosGained} new crest(s)` : ''}${failed ? `, ${failed} failed` : ''}.`);
  return { updated, failed, logosGained, total: targets.length };
}

// A crest the sweep just found should reach the working library straight away — otherwise the
// producer sees the team still logo-less until the NEXT event import, which defeats the point.
// Deliberately narrow: it fills an EMPTY logo and nothing else. The sweep must never rename a team
// or replace a chosen crest, because it can run in the middle of a live show.
// `force` replaces a logo the library already has. The default stays fill-the-gap only, because
// the routine sweep must never stomp a crest a producer chose in the Match panel; force is passed
// exactly where the vault has just been told the crest is out of date.
function adoptVaultCrest(rec, force) {
  if (!rec || !rec.logo) return false;
  const _tn = (x) => (x || '').trim().toLowerCase();
  const row = ctx.savedTeams.find((t) => t && t.vaultId === rec.id) ||
              ctx.savedTeams.find((t) => _tn(t.name) === _tn(rec.name)) ||
              ctx.savedTeams.find((t) => (rec.aliases || []).includes(teamDb.norm(t.name || '')));
  // The name→logo map feeds the queue/bracket/upcoming overlays even for teams that were never
  // saved into the library, so stamp it either way.
  (rec.aliases || []).concat(_tn(rec.name)).forEach((k) => {
    if (!k) return;
    if (force || !state.startgg.logoMap[k]) state.startgg.logoMap[k] = rec.logo;
  });
  if (!row) return false;
  if (row.logo && !force) return false;
  if (row.logo === rec.logo) return false;
  row.logo = rec.logo;
  if (!row.vaultId) row.vaultId = rec.id;
  return true;
}

// Bring EVERY copy of a team's crest in line with its vault record. A crest lives in five places -
// the vault record, the team library row, the imported event-teams snapshot, the name->logo map the
// queue/bracket overlays read, and the match side on air - and a change that reached only some of
// them was undone by whichever stale copy got read next. The one producers hit: a vault edit left
// the library on the OLD crest, and the next save_team of any kind (a favourite toggle is enough)
// wrote that old crest back into the vault and re-pinned it. The logo "reverted".
// Unlike adoptVaultCrest this mirrors a CLEARED crest too, so call it only where a producer just
// changed the crest - never from an import or the background sweep. Returns true if the library
// changed (the caller owns saveTeams()).
function propagateVaultCrest(rec) {
  if (!rec) return false;
  const logo = rec.logo || null;
  const _tn = (x) => (x || '').trim().toLowerCase();
  const aliases = rec.aliases || [];
  const linked = (t) => !!t && ((t.vaultId && t.vaultId === rec.id) ||
    _tn(t.name) === _tn(rec.name) || aliases.includes(teamDb.norm(t.name || '')));
  let libraryChanged = false;
  ctx.savedTeams.forEach((t) => {
    if (!linked(t)) return;
    if (!t.vaultId) { t.vaultId = rec.id; libraryChanged = true; }
    if ((t.logo || null) !== logo) { t.logo = logo; libraryChanged = true; }
  });
  (state.startgg.eventTeams || []).forEach((t) => { if (linked(t)) t.logo = logo; });
  aliases.concat(_tn(rec.name)).forEach((k) => {
    if (!k) return;
    if (logo) state.startgg.logoMap[k] = logo; else delete state.startgg.logoMap[k];
  });
  ['blue', 'orange'].forEach((side) => { if (linked(state.teams[side])) state.teams[side].logo = logo; });
  return libraryChanged;
}

// Match > Teams: a crest the producer uploads, picks from the media library or resets on a side is
// the TEAM's crest from then on, not a one-off for this match. It used to touch only the side on
// air, so the next push or auto-fill put the vault's old crest straight back. Written through for a
// team we already know (a library row, or a vault record matched by exact name/alias) - a typed-in
// one-off name is not turned into a permanent team behind the producer's back; Save does that.
function persistMatchCrest(side) {
  const t = state.teams[side];
  if (!t || !(t.name || '').trim()) return;
  const logo = t.logo || null;
  const _tn = (x) => (x || '').trim().toLowerCase();
  const row = ctx.savedTeams.find((x) => x && _tn(x.name) === _tn(t.name));
  let rec = null;
  if (state.teamVault && state.teamVault.enabled) {
    try {
      rec = (row && row.vaultId && teamDb.get(row.vaultId)) || null;
      if (!rec) { const hit = teamDb.resolve({ name: t.name }); if (hit.via === 'name') rec = hit.rec; }
      if (rec) rec = teamDb.update(rec.id, { logo, logoSource: 'match' }) || rec;
    } catch (e) { console.warn('[TeamVault] match crest write-through failed:', e.message); rec = null; }
  }
  let libraryChanged = false;
  if (row && (row.logo || null) !== logo) { row.logo = logo; libraryChanged = true; }
  if (rec) { libraryChanged = propagateVaultCrest(rec) || libraryChanged; vaultTouch(); }
  if (libraryChanged) saveTeams();
}

// Called at the end of every entrant import. Debounced, so back-to-back imports (teams, then the
// bracket sweep, then a queue poll) trigger ONE sweep rather than three overlapping ones.
function scheduleVaultEnrich(reason) {
  if (!state.teamVault || !state.teamVault.enabled || state.teamVault.autoEnrich === false) return;
  if (!ctx.startggApiToken) return;
  if (!vaultEnrichTargets(false).length) return;
  clearTimeout(_vaultEnrichTimer);
  _vaultEnrichTimer = setTimeout(() => {
    enrichVaultFromStartgg().catch((e) => console.warn('[TeamVault] enrich failed:', e.message));
  }, VAULT_ENRICH_START_MS);
  if (reason) console.log(`[TeamVault] Auto-enrich queued (${reason}).`);
}


// One-shot "make this event the broadcast event": full team import (→ library with
// logos) + bracket (all phases) + stream queue, and start polling for live updates.
// The game start.gg says an event is for ("Super Smash Bros. Ultimate", "Rocket League"), or ''.
// activateStartggEvent's callers never send it, and event NAMES rarely carry the game ("Fight Night #3"),
// so without this the auto-detect had nothing to work from and a Smash event loaded while the app sat on
// Rocket League — where the Smash-only top-8 wall (and every fighting-game default) then never appeared.
// One tiny query, best-effort: any failure just means we fall back to the event name as before.
// First usable image URL on a platform object, by the field names the platforms use.
function pickEventImage(o) {
  if (!o || typeof o !== 'object') return '';
  for (const k of ['logo', 'logoUrl', 'logo_url', 'avatar', 'icon', 'iconUrl', 'image', 'imageUrl', 'image_url']) {
    const v = o[k];
    if (typeof v === 'string' && /^(https?:|data:image\/)/i.test(v)) return v;
    if (v && typeof v === 'object' && typeof v.url === 'string') return v.url;
  }
  return '';
}

// The event's logo on start.gg: the tournament's square profile image (what organisers upload as
// their logo), else the event's own profile image. Banners are wide and skipped. Best-effort.
async function fetchStartggEventImage(slug) {
  try {
    if (!ctx.startggApiToken || !slug) return '';
    const client = createStartGgClient(ctx.startggApiToken);
    const res = await client.request('query EventImg($slug: String!) { event(slug: $slug) { images { type url } tournament { images { type url } } } }', { slug });
    const ev = (res && res.event) || {};
    const prof = (imgs) => ((imgs || []).find((i) => i && i.type === 'profile') || {}).url || '';
    return prof(ev.tournament && ev.tournament.images) || prof(ev.images) || '';
  } catch (e) {
    console.warn('[start.gg] could not read the event logo:', e && e.message);
    return '';
  }
}

async function fetchStartggEventGame(slug) {
  try {
    if (!ctx.startggApiToken || !slug) return '';
    const client = createStartGgClient(ctx.startggApiToken);
    const res = await client.request('query EventGame($slug: String!) { event(slug: $slug) { videogame { name } } }', { slug });
    return String((res && res.event && res.event.videogame && res.event.videogame.name) || '');
  } catch (e) {
    console.warn('[start.gg] could not read the event\'s videogame:', e && e.message);
    return '';
  }
}

async function activateStartggEvent(tournamentSlug, eventSlug, meta) {
  if (!ctx.startggApiToken) throw new Error('No start.gg API token yet. Add it under Apps > start.gg.');
  const evSlug = parseEventSlug(eventSlug || '');
  if (!evSlug || !/\/event\//i.test(evSlug)) throw new Error('Missing event slug');
  const tSlug = (tournamentSlug || (evSlug.match(/tournament\/([^/]+)/i) || [])[1] || '').trim();

  // Teams (→ library, with logos) + bracket (phases).
  const loaded = await loadEvent(evSlug);

  // Switching events must not leave the PREVIOUS event's matches on air. The queue/feed are only
  // rewritten by a SUCCESSFUL fetchStreamQueue, so without this the ticker kept showing the old
  // event until the next poll landed — and if that poll failed (rate limit, network, a tournament
  // with no stream queue) it kept showing it indefinitely. That is the "ticker on the wrong event".
  // Dropping the pushed set id too, so ensureOnAirLiveInFeed can't re-inject the old event's match.
  const _eventChanged = (state.startgg.eventSlug || '').trim().toLowerCase() !== evSlug.trim().toLowerCase();
  if (_eventChanged) {
    state.startgg.queue = [];
    state.startgg.matchFeed = [];
    state.startgg.streams = [];
    state.startgg.setId = '';
    state.startgg.lastPushedSetId = '';
    resetAutoFollowHold();
    state.startgg.queueFetchedAt = null;
    if (state.ticker.source === 'startgg') state.ticker.feed = [];
    if (state.upcoming.source === 'event') state.upcoming.matches = [];
  }

  state.startgg.tournamentSlug = tSlug;
  state.startgg.eventSlug = evSlug;
  // Activating an event is the explicit "this is my event" — the bracket follows it again
  // even if a different slug was typed into the bracket panel earlier.
  state.bracket.followActive = true;
  state.startgg.enabled = true;
  state.startgg.selectedEvent = {
    tournamentSlug: tSlug,
    eventSlug: evSlug,
    name: (meta && meta.name) || loaded.title || '',
    tournamentName: (meta && meta.tournamentName) || loaded.tournamentName || ''
  };
  state.startgg.pendingEvents = [];
  // Which game this event is, so start.gg gets the same treatment Challonge does: loading an
  // event lands the app on that game's overlay, labels and roster size. start.gg's own
  // `videogame.name` rides in on `meta.game` where the caller had it; the EVENT NAME is the
  // fallback, because start.gg event names carry the game far more often than not ("Ultimate
  // Singles", "Rocket League 3v3"). resolveGameId returns '' when it can't tell, and we then
  // leave the producer's game alone rather than guessing.
  // The event's real videogame wins over the name heuristic; the name/tournament name stay as the fallback.
  const _sggVideogame = (meta && meta.game) || await fetchStartggEventGame(evSlug);
  const _sggGameName = _sggVideogame || state.startgg.selectedEvent.name || '';
  adoptEventGame(_sggGameName);
  ctx.set__gameAdoptedForEventSlug(String(evSlug).toLowerCase());
  state.activeEvent = {
    platform: 'startgg',
    slug: evSlug,
    name: state.startgg.selectedEvent.name || state.startgg.selectedEvent.tournamentName || '',
    gameName: _sggVideogame || '',
    numEntrants: (state.startgg.eventTeams || []).length,
    format: '',
    url: `https://www.start.gg/${evSlug}`,
    logo: (meta && meta.image) || '',
    loadedAt: new Date().toISOString()
  };
  // Logo lookup runs in the background so loading the event never waits on it.
  fetchStartggEventImage(evSlug).then((img) => {
    if (!img || !state.activeEvent || state.activeEvent.platform !== 'startgg' || state.activeEvent.slug !== evSlug) return;
    if (state.activeEvent.logo === img) return;
    state.activeEvent.logo = img;
    saveAppState(); broadcastFullState();
  });

  // Loading an event we haven't loaded before re-arms the things that describe the SHOW itself.
  // Re-activating the same event (a refresh, a re-pasted link) leaves the producer's edits alone.
  const _newEvent = state.eventNameSlug !== evSlug;
  adoptEventName(evSlug, state.startgg.selectedEvent.tournamentName || state.startgg.selectedEvent.name);

  // Linking start.gg means the ticker has real scores to show — point it at the live feed instead of
  // the manual message list. Producer-typed promo lines are kept (start.gg mode interleaves them),
  // and switching the source back to Manual sticks until a DIFFERENT event is loaded.
  if (_newEvent) state.ticker.source = 'startgg';

  // Stream queue (non-fatal if the tournament has no queued streams yet).
  let queued = 0;
  if (tSlug) {
    try { const q = await fetchStreamQueue(tSlug); queued = q.count || 0; } catch (e) { /* optional */ }
  }
  // One-click setup: turn on the queue and begin live polling (queue + bracket + standings refresh)
  // now that we have a slug. Auto-follow defaults ON for that same one-click experience, but ONLY
  // until the producer expresses a preference — once they've touched the switch, activating an
  // event must not flip it back (that's why turning auto-follow off never used to stick, and the
  // scoreboard kept re-pushing itself mid-show).
  setActivePlatform('startgg');   // active platform — silence Challonge / NXGEN follow before we start ours
  state.startgg.queueEnabled = true;
  if (!state.startgg.autoFollowChosen) state.startgg.autoFollow = true;
  setStartggQueuePolling(true);

  // Standings follow the newly-activated event too — unless the producer chose a source that OWNS
  // its rows. Without this, rows frozen from a PREVIOUS event pull shadow the live event forever
  // (standings.html prefers rows over bracket.standings).
  //
  // 'league' is excluded alongside 'manual': a producer running our own league standings on air had
  // them silently replaced by the tournament's the moment an event was activated. A league board is
  // an explicit choice pointing at explicit data, so activation leaves it alone — switch the source
  // back to Tournament on the Standings panel to follow the event again.
  const _stdSrc = state.standings?.source || '';
  if (_stdSrc !== 'manual' && _stdSrc !== 'league') {
    state.standings.rows = (state.bracket.standings || []).map((r) => ({ ...r }));
    state.standings.source = 'startgg';
  }

  saveAppState();
  broadcastFullState();
  return { ...loaded, tournamentSlug: tSlug, eventSlug: evSlug, queued, eventName: state.startgg.selectedEvent.name };
}

// Resolve any pasted start.gg input (tournament URL, event URL, or bare slug) and
// activate it. If a tournament has multiple events, return them for the panel to pick.
async function resolveStartggUrl(input) {
  if (!ctx.startggApiToken) throw new Error('No start.gg API token yet. Add it under Apps > start.gg.');
  const { tournamentSlug, eventSlug } = parseStartggInput(input);
  if (!tournamentSlug && !eventSlug) throw new Error('Could not read a start.gg tournament from that link');

  if (eventSlug) {
    const r = await activateStartggEvent(tournamentSlug, eventSlug, {});
    return { activated: true, ...r };
  }

  // Tournament-only — resolve its events.
  const events = await fetchTournamentEvents(ctx.startggApiToken, tournamentSlug);
  if (!events.length) throw new Error('Tournament found but has no events — it may not be published yet, or your token may lack access. Try pasting the full event URL instead.');
  if (events.length === 1) {
    const r = await activateStartggEvent(tournamentSlug, events[0].slug, { name: events[0].name, tournamentName: events[0].tournamentName });
    return { activated: true, ...r };
  }
  // Multiple events → let the producer pick (largest first).
  const sorted = [...events].sort((a, b) => (b.numEntrants || 0) - (a.numEntrants || 0));
  state.startgg.pendingEvents = sorted.map((e) => ({ slug: e.slug, name: e.name, numEntrants: e.numEntrants, game: e.game }));
  state.startgg.selectedEvent = { tournamentSlug, eventSlug: '', name: '', tournamentName: events[0].tournamentName || '' };
  saveAppState();
  broadcastFullState();
  return { activated: false, needsEventPick: true, tournamentSlug, tournamentName: events[0].tournamentName || '', events: state.startgg.pendingEvents };
}



  return { enrichSpotlightSeeding, refreshTeamSpotlight, startTeamSpotlightAutoSync, fetchMyTournaments, fetchTournamentDetail, fetchTournamentEvents, startggPlayerFromParticipant, entrantOrgName, mapEntrantsToTeams, vaultTouch, startggRequestWithBackoff, STARTGG_PAGE_DELAY_MS, fetchBracket, _countryCode, mergeEntrantsIntoLibrary, importStartggTeams, adoptEventName, loadStartggEventTeams, pickEntrantLogo, saveEventTeamToLibrary, applyVaultToLibrary, refreshVaultTeamFromStartgg, importStartggTeamBySlug, vaultEnrichTargets, enrichVaultFromStartgg, propagateVaultCrest, persistMatchCrest, pickEventImage, fetchStartggEventImage, activateStartggEvent, resolveStartggUrl, loadEvent };
};
