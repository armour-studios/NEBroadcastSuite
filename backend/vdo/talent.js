// backend/vdo/talent.js — moved out of server.js (refactor step 3) unchanged; server.js creates it once
// with createVdoTalent(ctx). ctx carries stable references plus live getters (ctx.<name>) for values
// server.js replaces at runtime, and set_<name>(v) for the ones this code writes.
module.exports = function createVdoTalent(ctx) {
  const { https, state } = ctx;

// ─── VDO.Ninja talent workflow ─────────────────────────────────────────────
// Deterministic identity is the whole trick: each team gets a private room
// (opaque name + random password) and each player a stream ID derived from their
// gamertag, so join links, OBS feeds, and the listen-in audio all resolve from
// (team, player) with nothing to paste. Privacy rests on per-team passwords +
// private per-player distribution; opponents never receive another team's link.

function vdoRandom(len) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';   // no ambiguous 0/o/1/l
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function vdoSlug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
}
// Ensure a team has a room + password. Returns the team's vdo block.
function ensureTeamVdo(team, regenerate = false) {
  if (!team) return null;
  if (regenerate || !team.vdo || !team.vdo.room || !team.vdo.password) {
    team.vdo = { room: 'ne' + vdoRandom(9), password: vdoRandom(12) };
  }
  return team.vdo;
}
// Provision a shared private room for all casters. Returns the casters.vdo block.
function ensureCasterVdo(regenerate = false) {
  if (regenerate || !state.casters.vdo || !state.casters.vdo.room || !state.casters.vdo.password) {
    state.casters.vdo = { room: 'ne' + vdoRandom(9), password: vdoRandom(12) };
  }
  return state.casters.vdo;
}
// Shared rooms for the two other talent groups — guests (desk hosts/analysts/special guests)
// and observers. One room per group; every member of that group pushes into it and the
// Director monitors it (same model as the casters room above).
function ensureGuestsVdo(regenerate = false) {
  if (!state.casters.guestsVdo) state.casters.guestsVdo = { room: '', password: '' };
  const v = state.casters.guestsVdo;
  if (regenerate || !v.room || !v.password) { v.room = 'ne' + vdoRandom(9); v.password = vdoRandom(12); }
  return v;
}
function ensureObserversVdo(regenerate = false) {
  if (!state.casters.observersVdo) state.casters.observersVdo = { room: '', password: '' };
  const v = state.casters.observersVdo;
  if (regenerate || !v.room || !v.password) { v.room = 'ne' + vdoRandom(9); v.password = vdoRandom(12); }
  return v;
}
// Build a team-shaped group (Casters / Guests / Observers) from the caster library, filtered by
// kind. Members push to the group's single shared room; the Director monitors that room. Shaped
// like a team (name/color/room/members) so ONE renderer + the Director can consume all of them.
function buildTalentGroup(name, color, vdo, members) {
  const groupReady = !!(vdo && vdo.room && vdo.password);
  const lineup = (state.casters && state.casters.lineup) || [];
  const rooms = (state.casters && state.casters.rooms) || [];
  const list = (members || []).map((p) => {
    // On tonight's desk: join with EXACTLY the stream id and room the desk overlay views
    // (resolveLineupToList). The join link used the name in the group room while the castercam
    // watched the lineup's id in the desk room, so an invited caster never appeared on the desk.
    const li = lineup.findIndex((e) => e && e.libraryId === p.id);
    const entry = li >= 0 ? lineup[li] : null;
    let useVdo = vdo, sidSrc = p.streamId || p.handle || p.name;
    if (entry) {
      const r = rooms.find((x) => x.id === entry.roomId);
      if (r && r.vdo && r.vdo.room && r.vdo.password) useVdo = r.vdo;
      sidSrc = entry.streamId || ('caster_' + (entry.slot || (li + 1)));
    }
    const ready = !!(useVdo && useVdo.room && useVdo.password);
    const fake = { streamId: sidSrc, handle: p.handle, name: p.name, camUrl: p.camUrl };
    return {
      libraryId: p.id, name: p.name || '', handle: p.handle || '', role: p.role || '', social: p.social || 'none',
      streamId: vdoSlug(sidSrc || 'talent'),
      joinUrl: ready ? buildCasterJoinUrlFromVdo(fake, useVdo) : '',
      // A custom view link (camUrl) overrides the auto-generated room feed when set.
      obsUrl:  p.camUrl ? p.camUrl : (ready ? buildCasterObsUrlFromVdo(fake, useVdo) : ''),
      camUrl:  p.camUrl || '',
      onDesk: !!entry,
      audio: p.audio || null
    };
  });
  const ready = groupReady;
  return { name, color, room: ready ? vdo.room : '', directorUrl: ready ? buildDirectorUrl(vdo) : '', members: list };
}
// Provision VDO credentials for a named caster room.
function ensureRoomVdo(room, regenerate = false) {
  if (regenerate || !room.vdo || !room.vdo.room || !room.vdo.password) {
    room.vdo = { room: 'ne' + vdoRandom(9), password: vdoRandom(12) };
  }
  return room.vdo;
}
// The interview / desk room = the named caster room designated in the VDO Rooms panel
// (state.casters.deskRoomId). Players are transferred into THIS room for on-desk interviews and
// the spotlight-desk right cam reads their solo feed from it. Falls back to the first named room
// with VDO creds, then the legacy shared caster room.
function deskRoomVdo() {
  const rooms = state.casters.rooms || [];
  const id = state.casters.deskRoomId;
  if (id) { const r = rooms.find((x) => x.id === id); if (r && r.vdo && r.vdo.room && r.vdo.password) return r.vdo; }
  const firstReady = rooms.find((r) => r.vdo && r.vdo.room && r.vdo.password);
  if (firstReady) return firstReady.vdo;
  return state.casters.vdo;
}
// Dedicated INTERVIEW room — a separate VDO room players get transferred into for on-desk
// interviews (kept distinct from the caster desk room so the desk audio stays clean).
function ensureInterviewVdo(regenerate = false) {
  if (!state.casters.interview) state.casters.interview = { room: '', password: '' };
  const v = state.casters.interview;
  if (regenerate || !v.room || !v.password) { v.room = 'ne' + vdoRandom(9); v.password = vdoRandom(12); }
  return v;
}
// One stable key shared by every embedded director console — enables the VDO IFrame API so the
// control panel can drive director-side actions (forward/transfer, mute, hangup) programmatically.
function ensureDirectorApiKey() {
  if (!state.casters.apiKey) state.casters.apiKey = 'ne' + vdoRandom(16);
  return state.casters.apiKey;
}
// Director console URL for a room's VDO creds. &api enables IFrame-API control; &rooms pre-arms a
// one-click transfer button to the interview room in the native director UI; #p carries the room
// password (same room+password as the players, so the director owns the exact same room).
function buildDirectorUrl(vdo, { armInterview = true } = {}) {
  if (!vdo || !vdo.room || !vdo.password) return '';
  const api = ensureDirectorApiKey();
  // Interviews happen in the desk room (deskRoomVdo: what the move buttons and the spotlight cam use).
  // The old separate state.casters.interview room was armed here, so the native transfer button sent
  // players to a room nobody watched.
  const iv = deskRoomVdo();
  const roomsParam = (armInterview && iv && iv.room && iv.room !== vdo.room) ? `&rooms=${iv.room}` : '';
  // &novideo&noaudio: the director joins purely to monitor presence + issue transfers — it does NOT
  // capture the producer's camera/mic, so it can auto-run in the background with no device light.
  return `${vdoBase()}/?director=${vdo.room}&cleanoutput&novideo&noaudio&api=${api}${roomsParam}#p=${vdo.password}`;
}
// Build join/OBS URLs against a specific VDO block (room-aware).
function buildCasterJoinUrlFromVdo(caster, vdo) {
  if (!vdo || !vdo.room || !vdo.password) return '';
  const sid = vdoSlug(caster.streamId || caster.handle || caster.name || 'caster');
  const lang = state.vdo?.lang || 'en-US';
  const extra = state.vdo?.pushParams ? '&' + String(state.vdo.pushParams).replace(/^&+/, '') : '';
  return `${vdoBase()}/?room=${vdo.room}&push=${sid}&transcribe=${lang}&webcam${extra}#p=${vdo.password}`;
}
function buildCasterObsUrlFromVdo(caster, vdo) {
  if (!vdo || !vdo.room || !vdo.password) return caster.camUrl || '';
  const sid = vdoSlug(caster.streamId || caster.handle || caster.name || 'caster');
  const params = vdoViewParams(casterAudioOverride(caster));
  return `${vdoBase()}/?room=${vdo.room}&view=${sid}&solo${params ? '&' + params : ''}#p=${vdo.password}`;
}
// A caster's per-feed audio override (volume on the row + an optional richer audio block).
function casterAudioOverride(caster) {
  const a = Object.assign({}, (caster && caster.audio) || {});
  if (caster && caster.volume != null && a.volume == null) a.volume = caster.volume;
  return a;
}
// Convert lineup + library + rooms → state.casters.list for overlay consumption.
// The crew profile is the canonical person record: its Handle/Gamertag field is the DISPLAY
// name for desks. The caster-library `handle` field can't be trusted for that — the caster
// card editors historically treat it as the @social username, so the two UIs disagree about
// what it means. Cross-reference at resolve time instead of trying to sync fields.
// Matching is deliberately generous (library name/handle vs crew name/handle/socialHandle,
// case-insensitive): producers rename the library card (e.g. to the gamertag itself) and a
// strict name==name join silently loses the person.
// The crew twin for a library profile — matched by name/handle/social handle. The crew
// profile is the canonical person record (gamertag, social, country live there).
function crewTwinFor(profOrName) {
  if (!Array.isArray(state.crew) || !state.crew.length) return null;
  const prof = (profOrName && typeof profOrName === 'object') ? profOrName : { name: profOrName };
  const keys = [prof.name, prof.handle, prof.socialHandle]
    .map((v) => (v || '').toString().trim().toLowerCase()).filter(Boolean);
  if (!keys.length) return null;
  return state.crew.find((c) => {
    if (!c) return false;
    const own = [c.name, c.handle, c.socialHandle]
      .map((v) => (v || '').toString().trim().toLowerCase()).filter(Boolean);
    return own.some((o) => keys.includes(o));
  }) || null;
}
function crewGamertagFor(profOrName) {
  const hit = crewTwinFor(profOrName);
  return ((hit && hit.handle) || '').toString().trim();
}

// Caster social key → public URL (bare, no scheme — chat renders it as a link either way).
// Keys match CASTER_SOCIAL_OPTIONS in the control panel. discord/other/none have no canonical
// profile URL, so those fall back to the raw handle.
const CASTER_SOCIAL_URL = {
  x:         (v) => 'x.com/' + v.replace(/^@/, ''),
  twitter:   (v) => 'x.com/' + v.replace(/^@/, ''),
  twitch:    (v) => 'twitch.tv/' + v.replace(/^@/, ''),
  youtube:   (v) => 'youtube.com/@' + v.replace(/^@/, ''),
  instagram: (v) => 'instagram.com/' + v.replace(/^@/, ''),
  tiktok:    (v) => 'tiktok.com/@' + v.replace(/^@/, ''),
  facebook:  (v) => 'facebook.com/' + v.replace(/^@/, ''),
  kick:      (v) => 'kick.com/' + v.replace(/^@/, '')
};
function casterSocialText(c) {
  const raw = String((c && (c.socialHandle || c.handle)) || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw.replace(/^https?:\/\//i, '');   // already a full link
  const fn = CASTER_SOCIAL_URL[String((c && c.social) || '').toLowerCase()];
  if (fn) return fn(raw);
  return raw.startsWith('@') ? raw : '@' + raw;   // discord / other / unset → bare handle
}

// ── Built-in chat commands (!bracket / !discord / !casters) ────────────────────
// One resolver so the IRC bot and the control panel's live preview always agree. Everything
// derives from LIVE state, so the answers stay correct as the show changes events/casters.
function chatCommandReply(kind) {
  if (kind === 'bracket') {
    const ev = state.activeEvent || {};
    // activeEvent.url covers start.gg / Challonge / NXGEN. Fall back to the start.gg slug, which is
    // already the FULL "tournament/x/event/y" path — do NOT re-prefix it with tournament/<slug>.
    let url = String(ev.url || '').trim()
      || (state.startgg?.eventSlug ? `https://www.start.gg/${state.startgg.eventSlug}` : '');
    if (!url) return 'No bracket linked yet.';
    // Deep-link straight to the LIVE bracket the overlay is showing rather than the event landing
    // page: start.gg brackets live at <event>/brackets/<phaseId>/<phaseGroupId>. We already hold
    // both — state.bracket.activePhaseId is stored as 'p<phaseId>' (see groupRounds), and
    // activePoolId IS the phaseGroup id. start.gg only; Challonge/NXGEN urls stay as-is.
    const bk = state.bracket || {};
    const isStartgg = ev.platform === 'startgg' || (!ev.platform && !!(state.startgg && state.startgg.eventSlug));
    if (isStartgg && !/\/brackets\//.test(url)) {
      const phaseId = String(bk.activePhaseId || '').replace(/^p/, '');
      const poolId  = String(bk.activePoolId || '');
      if (/^\d+$/.test(phaseId) && /^\d+$/.test(poolId)) url += `/brackets/${phaseId}/${poolId}`;
    }
    const name = String(ev.name || '').trim();
    return name ? `${name} bracket: ${url}` : `Bracket: ${url}`;
  }
  if (kind === 'discord') {
    const link = String((state.chatCommands && state.chatCommands.discord) || '').trim();
    return link ? `Join the Discord: ${link}` : 'No Discord link set yet.';
  }
  if (kind === 'casters') {
    // Read the already-resolved on-air list (resolveLineupToList() writes it and would re-run its
    // side effects on every command) — same source the control panel previews from.
    const crew = (state.casters && state.casters.list) || [];
    const parts = crew
      .slice()
      .sort((a, b) => (Number(a.slot) || 99) - (Number(b.slot) || 99))
      .map((c) => {
        const nm = String((c && (c.gamertag || c.name)) || '').trim();
        if (!nm) return '';
        const soc = casterSocialText(c);
        return soc ? `${nm} — ${soc}` : nm;
      })
      .filter(Boolean);
    if (!parts.length) return 'No casters on the desk right now.';
    return parts.join('  ·  ');
  }
  return '';
}

// ── Show Deck: off-air staff hygiene + shift handover ────────────────────────
// One person, one chip. Duplicates creep in two ways: the same crewId added twice (guarded at the
// add site, but not on migrated/imported lists), and TWO crew records for the same human — the
// rename "ghost" twins — which the crewId check can't see. Both are collapsed here, along with
// chips whose crew record no longer exists.
function dedupeSupport() {
  if (!Array.isArray(state.casters.support)) { state.casters.support = []; return; }
  const byId = new Map();
  (state.crew || []).forEach((c) => { if (c && c.id) byId.set(c.id, c); });
  const seenId = new Set();
  const seenName = new Set();
  state.casters.support = state.casters.support.filter((s) => {
    if (!s || !s.crewId || seenId.has(s.crewId)) return false;
    const c = byId.get(s.crewId);
    if (!c) return false;                       // crew record deleted → drop the orphan chip
    const nm = String(c.name || '').trim().toLowerCase();   // a non-string name aborted loadState here
    if (nm && seenName.has(nm)) return false;   // same human via a duplicate crew record
    seenId.add(s.crewId);
    if (nm) seenName.add(nm);
    return true;
  });
}

/** The desk's caster slots as { 1..4: name } — empty slots keep their key, so the shape round-trips
    through a handover snapshot without shifting anyone into the wrong seat. */
function deskSlotNames() {
  const lib = state.casters.library || [];
  const out = {};
  [1, 2, 3, 4].forEach((n) => {
    const e = (state.casters.lineup || []).find((x) => Number(x.slot) === n);
    const p = e && lib.find((l) => l && l.id === e.libraryId);
    out[n] = ((p && p.name) || '').toString().trim();
  });
  return out;
}

/** Who is on the desk right now — slots 1-4 plus the two show roles, as [{ name, role }]. */
function deskLineupPeople() {
  const out = [];
  const push = (name, role) => {
    const n = (name == null ? '' : String(name)).trim();
    if (n) out.push({ name: n, role });
  };
  const slots = deskSlotNames();
  [1, 2, 3, 4].forEach((n) => push(slots[n], 'Caster'));
  const roles = state.casters.showRoles || {};
  push(roles.host, 'Host');
  push(roles.observer, 'Observer');
  return out;
}

/** Empty the desk (slots 1-4 + show roles). Support/credits are untouched. */
function clearDeskSlots() {
  state.casters.lineup = (state.casters.lineup || []).filter((e) => !(Number(e.slot) >= 1 && Number(e.slot) <= 4));
  state.casters.showRoles = { host: '', observer: '' };
  state.casters.activeShiftId = '';
  resolveLineupToList();
}

/** Put a set of names back on the desk, creating library entries the way apply_shift does. */
function seatDeskSlots(slots, host, observer) {
  if (!Array.isArray(state.casters.library)) state.casters.library = [];
  const lib = state.casters.library;
  const findOrCreate = (nm) => {
    const k = nm.toLowerCase();
    let e = lib.find((l) => l && (l.name || '').toLowerCase() === k);
    if (e) return e;
    const crew = (state.crew || []).find((c) => c && (c.name || '').toLowerCase() === k) || {};
    e = { id: Math.random().toString(36).slice(2, 11), name: nm, handle: crew.socialHandle || '', socialHandle: crew.socialHandle || '', social: crew.social || 'none', country: crew.country || '', camUrl: '', kind: 'caster' };
    lib.push(e);
    return e;
  };
  const lineup = (state.casters.lineup || []).filter((e) => !(Number(e.slot) >= 1 && Number(e.slot) <= 4));
  [1, 2, 3, 4].forEach((n) => {
    const nm = ((slots && slots[n]) || '').toString().trim();
    if (!nm) return;
    lineup.push({ libraryId: findOrCreate(nm).id, slot: n });
  });
  state.casters.lineup = lineup;
  state.casters.showRoles = { host: host || '', observer: observer || '' };
  resolveLineupToList();
}

function resolveLineupToList() {
  const lib = state.casters.library || [];
  const rooms = state.casters.rooms || [];
  const lineup = state.casters.lineup || [];
  if (!lineup.length) return;
  state.casters.list = lineup.filter(e => e.libraryId).map((entry, i) => {
    const prof = lib.find(p => p.id === entry.libraryId) || {};
    const room = rooms.find(r => r.id === entry.roomId) || null;
    const vdo = (room && room.vdo && room.vdo.room) ? room.vdo
              : ((state.casters.vdo && state.casters.vdo.room) ? state.casters.vdo : null);
    const sid = entry.streamId || ('caster_' + (entry.slot || (i + 1)));
    const fakeCaster = { streamId: sid, handle: prof.handle, name: prof.name, camUrl: prof.camUrl, audio: entry.audio };
    // camUrl precedence: per-slot lineup override → the caster's explicit custom view link
    // (prof.camUrl / vdoOverride, pasted in the DCC) → the auto-generated room feed. A pasted link
    // must WIN over the generated room so producers can point a caster at any third-party feed.
    const customLink = (entry.customCamUrl || prof.vdoOverride || prof.camUrl || '').toString().trim();
    // Nameplate fields fall back to the CREW twin: the crew profile is where producers keep
    // gamertag/social/country (Show Deck / Crew page). Auto-filled station check-ins create
    // thin library entries — without this fallback their overlay nameplate showed a bare name
    // (or nothing) even though the crew profile had the full identity.
    const twin = crewTwinFor(prof) || {};
    return {
      id: prof.id || ('lineup_' + (entry.slot || (i + 1))),
      name: prof.name || twin.name || '',
      handle: prof.handle || '',
      gamertag: crewGamertagFor(prof),         // desk display name (crew Handle/Gamertag field)
      socialHandle: prof.socialHandle || prof.handle || twin.socialHandle || '',   // @-line username
      social: (prof.social && prof.social !== 'none') ? prof.social : (twin.social || 'none'),
      country: prof.country || twin.country || '',
      slot: Number(entry.slot) || (i + 1),
      streamId: sid,
      room: vdo ? vdo.room : '',
      camUrl: customLink || (vdo ? buildCasterObsUrlFromVdo(fakeCaster, vdo) : ''),
    };
  });
}
// ── Station auto-fill suppression ─────────────────────────────────────────────
// stationAutoSync() treats the WEBSITE placement as authoritative and re-pushes every
// checked-in caster into the desk lineup on each 20s tick. That silently undid manual
// pull-offs: a caster deleted from the Show Deck reappeared on the next tick, and a phantom /
// second web feed kept forcing a second caster back on. When a producer explicitly takes
// someone OFF the desk we remember them here (keyed by NAME — the identity the Show Deck / DCC
// resolve people on) so auto-fill leaves them off. Placing them back on a slot, or a fresh
// station check-in after they drop, clears the suppression.
// BOTH identities, because the two sides of this speak different ones: the station feed calls
// people by f.personName (the GAMERTAG for anyone who checked in self-serve), while the desk
// library stores that as `handle` and keeps their real name in `name` — which is exactly how
// stationAutoSync matches them (name OR handle, see the lookup above). Keying suppression on
// `name` alone made it a silent no-op for every caster whose real name isn't their gamertag:
// the stored key never matched the live key, so the prune below deleted the suppression on the
// next 20s poll and the web placement slammed them straight back into their slot.
function _autoFillNameKeys(libraryId) {
  const e = (state.casters.library || []).find((c) => c && c.id === libraryId);
  if (!e) return [];
  return [e.name, e.handle].map((v) => (v || '').trim().toLowerCase()).filter(Boolean);
}
function suppressAutoFill(libraryId) {
  if (!Array.isArray(state.casters.autoFillSuppress)) state.casters.autoFillSuppress = [];
  for (const k of _autoFillNameKeys(libraryId)) {
    if (!state.casters.autoFillSuppress.includes(k)) state.casters.autoFillSuppress.push(k);
  }
}
function unsuppressAutoFill(libraryId) {
  if (!Array.isArray(state.casters.autoFillSuppress) || !state.casters.autoFillSuppress.length) return;
  const keys = new Set(_autoFillNameKeys(libraryId));
  if (keys.size) state.casters.autoFillSuppress = state.casters.autoFillSuppress.filter((x) => !keys.has(x));
}

// Stream ID for a player — derived from gamertag/name, with an explicit override.
// Find a roster player by id, comparing as STRINGS.
//
// ⚠️ Roster ids are not consistently typed: start.gg imports create them as
// `Math.random().toString(36)` (string) while the panel's "+ Add" creates them as
// `Date.now() + Math.random()` (NUMBER). Any control that carries the id through a DOM
// `data-pid` attribute hands it back as a string, so a strict `p.id === playerId` misses every
// number-id player and the handler silently does nothing — which is exactly how the per-player
// LISTEN IN broke while the room-wide one (which never looks a player up) kept working.
// Every handler reachable from a data-pid attribute must go through this.
function findTeamPlayer(team, playerId) {
  if (!team || playerId == null || playerId === '') return null;
  const want = String(playerId);
  return (team.players || []).find((p) => p && String(p.id) === want) || null;
}

function playerStreamId(player) {
  if (!player) return '';
  if (player.vdoStreamId) return vdoSlug(player.vdoStreamId);
  return vdoSlug(player.name || player.primaryid || 'player') || ('p' + vdoRandom(5));
}
// Turn a normalized audio object into a VDO.ninja URL param string (no leading '&').
// volume 0–200, pan −100..+100 (0 = centre → &panning 0–180), mono, noaudio, ab (kbps), params (free text).
function vdoAudioParamString(a) {
  a = a || {};
  const out = [];
  const vol = a.volume;
  if (vol != null && vol !== '' && Number(vol) !== 100) out.push('volume=' + Math.max(0, Math.min(200, Math.round(Number(vol)) || 0)));
  if (a.mono) out.push('mono');
  if (a.noaudio) out.push('noaudio');
  if (a.ab !== undefined && a.ab !== null && a.ab !== '') out.push('ab=' + (parseInt(a.ab) || 0));
  if (a.pan != null && a.pan !== '' && Number(a.pan) !== 0) {
    const deg = Math.round((Math.max(-100, Math.min(100, Number(a.pan))) + 100) / 200 * 180);   // −100→0(L) … 0→90(C) … 100→180(R)
    out.push('panning=' + deg);
  }
  if (a.params) out.push(String(a.params).replace(/^&+/, '').trim());
  return out.filter(Boolean).join('&');
}
// Normalize an incoming per-feed audio override (from the control panel) into a safe stored object.
function sanitizeVdoAudio(a) {
  if (!a || typeof a !== 'object') return undefined;
  const out = {};
  if (a.volume !== undefined && a.volume !== '' && a.volume !== null) out.volume = Math.max(0, Math.min(200, Math.round(Number(a.volume)) || 0));
  if (a.pan !== undefined && a.pan !== '' && a.pan !== null) out.pan = Math.max(-100, Math.min(100, Math.round(Number(a.pan)) || 0));
  if (a.mono) out.mono = true;
  if (a.noaudio) out.noaudio = true;
  if (a.ab !== undefined && a.ab !== '' && a.ab !== null) out.ab = Math.max(0, parseInt(a.ab) || 0);
  if (typeof a.params === 'string' && a.params.trim()) out.params = a.params.slice(0, 200);
  return Object.keys(out).length ? out : undefined;
}
// Global audio defaults from the VDO config.
function vdoGlobalAudio() {
  const v = state.vdo || {};
  return { volume: v.volume, mono: !!v.audioMono, ab: v.audioBitrate || '', pan: 0, params: v.audioParams || '' };
}
// Shared "&clean view" param string from the global VDO config. Pass a per-feed audio override
// (e.g. a player's vdoAudio) to layer it on top of the global audio defaults.
function vdoViewParams(audioOverride) {
  const v = state.vdo || {};
  const p = [];
  if (v.cleanOutput !== false) p.push('cleanoutput');
  if (v.cover !== false) p.push('cover');
  if (v.transparent) p.push('transparent');
  const aStr = vdoAudioParamString(Object.assign(vdoGlobalAudio(), audioOverride || {}));
  if (aStr) p.push(aStr);
  if (v.codec) p.push('codec=' + v.codec);
  if (v.bitrate) p.push('bitrate=' + parseInt(v.bitrate));
  if (v.buffer) p.push('buffer=' + parseInt(v.buffer));
  if (v.viewParams) p.push(String(v.viewParams).replace(/^&+/, ''));
  return p.filter(Boolean).join('&');
}
// Room names and passwords go into join links unescaped (?room=...#p=...): keep them to the characters
// VDO.Ninja itself allows, so a typed space, & or # cannot break every link.
const VDO_CRED_STRIP = /[^A-Za-z0-9_-]/g;
function vdoBase() { return (state.vdo?.base || 'https://vdo.ninja').replace(/\/+$/, ''); }

// Talent join link: pushes as <streamId> into the team room, with live transcription.
// Password rides in the URL fragment (#p=) so it's never sent to / logged by the server.
function buildTalentJoinUrl(team, player) {
  const vdo = ensureTeamVdo(team);
  const sid = playerStreamId(player);
  const extra = state.vdo?.pushParams ? '&' + String(state.vdo.pushParams).replace(/^&+/, '') : '';
  const lang = state.vdo?.lang || 'en-US';
  return `${vdoBase()}/?room=${vdo.room}&push=${sid}&transcribe=${lang}&webcam${extra}#p=${vdo.password}`;
}
// OBS feed (solo view of one player) — for a dedicated browser source per gamertag.
function buildObsViewUrl(team, player) {
  const vdo = ensureTeamVdo(team);
  const sid = playerStreamId(player);
  const params = vdoViewParams(player && player.vdoAudio);   // per-player audio override
  return `${vdoBase()}/?room=${vdo.room}&view=${sid}&solo${params ? '&' + params : ''}#p=${vdo.password}`;
}
// ── Interview / production workflow ─────────────────────────────────────────
// The interview room IS the production room (where the casters are) — i.e. the shared CASTER room.
// Move a player into it for an on-desk interview, then back to their team room afterwards. The
// JOIN link pushes the player in as their own stream id; the VIEW link is the solo desk feed to
// drop into a caster slot's Custom View URL (or "Set as CAM") / the interview overlay frame.
function buildPlayerInterviewJoinUrl(player) {
  const vdo = deskRoomVdo();
  if (!vdo || !vdo.room || !vdo.password) return '';
  const sid = playerStreamId(player);
  const lang = state.vdo?.lang || 'en-US';
  const extra = state.vdo?.pushParams ? '&' + String(state.vdo.pushParams).replace(/^&+/, '') : '';
  return `${vdoBase()}/?room=${vdo.room}&push=${sid}&transcribe=${lang}&webcam${extra}#p=${vdo.password}`;
}
function buildPlayerInterviewViewUrl(player) {
  const vdo = deskRoomVdo();
  if (!vdo || !vdo.room || !vdo.password) return '';
  const sid = playerStreamId(player);
  const params = vdoViewParams(player && player.vdoAudio);
  return `${vdoBase()}/?room=${vdo.room}&view=${sid}&solo${params ? '&' + params : ''}#p=${vdo.password}`;
}
// CSS injected into the VDO view (via &base64css) so VDO renders the captions itself —
// guaranteed transcription — but styled to match the listen-in card: cam hidden, transparent
// background, our font, last 2 lines only. #overlayMsgs is VDO's caption container.
// Transparent bg, no cam, and a forced readable caption size. VDO sizes captions tiny relative
// to the small iframe, so we override font-size on #overlayMsgs AND its children (the spans),
// and lay them out bottom-aligned (newest last) clipped to the iframe.
const LISTEN_IN_CAPTION_CSS =
  "html,body{height:100%!important}" +
  "body{background-color:rgba(0,0,0,0)!important;margin:0!important;overflow:hidden!important}" +
  "video{display:none!important}" +
  // Fill the strip, newest enters at the top, older scrolls off the bottom (top-anchored).
  "#overlayMsgs{position:fixed!important;left:0!important;right:0!important;bottom:0!important;top:0!important;" +
  "display:flex!important;flex-direction:column!important;align-items:flex-start!important;justify-content:flex-start!important;" +
  "overflow:hidden!important;padding:0!important;margin:0!important;box-sizing:border-box!important}" +
  "#overlayMsgs,#overlayMsgs *{font-family:Rajdhani,'Segoe UI',sans-serif!important;font-weight:700!important;" +
  "font-size:36px!important;line-height:1.25!important;color:#e9ecf3!important;text-align:left!important;text-transform:uppercase!important;" +
  "white-space:normal!important;word-break:break-word!important;overflow-wrap:anywhere!important;" +
  "background:transparent!important;text-shadow:0 2px 6px rgba(0,0,0,.75)!important}";

// LISTEN IN feed — audio + VDO-native captions for one player (consumed by listen-in.html).
// The player's push carries &transcribe; this view shows the captions (&closedcaptions) styled
// via &base64css. Audio plays from the same iframe.
// &cc renders incoming captions; &novideo drops the video (no "white box") while keeping audio.
function buildListenInUrl(team, player) {
  const vdo = ensureTeamVdo(team);
  const sid = playerStreamId(player);
  const css = encodeURIComponent(Buffer.from(LISTEN_IN_CAPTION_CSS, 'utf8').toString('base64'));
  return `${vdoBase()}/?room=${vdo.room}&view=${sid}&cleanoutput&autostart&novideo&cc&base64css=${css}#p=${vdo.password}`;
}
// LISTEN IN on the WHOLE team room — a scene that pulls every connected player's audio +
// captions (VDO labels whoever speaks). &cc = the documented room-captions browser source.
function buildRoomListenInUrl(team) {
  const vdo = ensureTeamVdo(team);
  const css = encodeURIComponent(Buffer.from(LISTEN_IN_CAPTION_CSS, 'utf8').toString('base64'));
  return `${vdoBase()}/?room=${vdo.room}&scene=0&cleanoutput&autostart&novideo&cc&base64css=${css}#p=${vdo.password}`;
}
// General room join link — anyone can enter the team's private VDO room without claiming a named slot.
function buildRoomJoinUrl(team) {
  const vdo = ensureTeamVdo(team);
  const extra = state.vdo?.pushParams ? '&' + String(state.vdo.pushParams).replace(/^&+/, '') : '';
  return `${vdoBase()}/?room=${vdo.room}${extra}#p=${vdo.password}`;
}
// Caster join link — pushes as <streamId> into the shared caster room with transcription.
function buildCasterJoinUrl(caster) {
  const vdo = state.casters?.vdo;
  if (!vdo || !vdo.room || !vdo.password) return '';
  const sid = vdoSlug(caster.streamId || caster.handle || caster.name || 'caster');
  const lang = state.vdo?.lang || 'en-US';
  const extra = state.vdo?.pushParams ? '&' + String(state.vdo.pushParams).replace(/^&+/, '') : '';
  return `${vdoBase()}/?room=${vdo.room}&push=${sid}&transcribe=${lang}&webcam${extra}#p=${vdo.password}`;
}
// Caster OBS feed — solo view of one caster from the shared caster room.
function buildCasterObsUrl(caster) {
  const vdo = state.casters?.vdo;
  if (!vdo || !vdo.room || !vdo.password) return caster.camUrl || '';
  const sid = vdoSlug(caster.streamId || caster.handle || caster.name || 'caster');
  const params = vdoViewParams(casterAudioOverride(caster));
  return `${vdoBase()}/?room=${vdo.room}&view=${sid}&solo${params ? '&' + params : ''}#p=${vdo.password}`;
}


  return { vdoRandom, vdoSlug, ensureTeamVdo, ensureCasterVdo, ensureGuestsVdo, ensureObserversVdo, ensureRoomVdo, ensureInterviewVdo, buildCasterJoinUrlFromVdo, buildCasterObsUrlFromVdo, chatCommandReply, dedupeSupport, resolveLineupToList, suppressAutoFill, unsuppressAutoFill, findTeamPlayer, playerStreamId, sanitizeVdoAudio, VDO_CRED_STRIP, vdoBase, buildObsViewUrl, buildPlayerInterviewViewUrl, buildListenInUrl, buildRoomListenInUrl, buildCasterObsUrl, crewGamertagFor, deskLineupPeople, deskSlotNames, clearDeskSlots, seatDeskSlots, deskRoomVdo, ensureDirectorApiKey, buildTalentJoinUrl, buildPlayerInterviewJoinUrl, buildRoomJoinUrl, buildDirectorUrl, buildTalentGroup, buildCasterJoinUrl };
};
