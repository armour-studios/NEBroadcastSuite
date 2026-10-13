'use strict';
// Match-day extras the Nameless website sends with each match of an event document (producer
// data, like what start.gg gives a stream producer): which of the event's streams the match is
// queued on, the website's own status, called / started / check-in stamps, the LAN station, the
// lobby, the VOD, every game's map / pick / side / characters, the veto and where the bracket
// sends the teams. Contract: docs/website-competitions-contract.md (v2, "Producer extras").
//
// Pure. validateDoc keeps them as match.site; applyDoc stores them on the league fixture as
// m.site, turned to the fixture's own orientation (when the league lists the website's team B
// first, every A/B is swapped, so "A" always means m.teamA).

const str = (v, max = 200) => (v == null ? '' : String(v).trim().slice(0, max));
const side = (v) => (v === 'A' || v === 'B' ? v : null);
const iso = (v) => { const s = str(v, 40); return s && !isNaN(Date.parse(s)) ? new Date(s).toISOString() : null; };
const names = (v) => (Array.isArray(v) ? v.slice(0, 10).map((x) => str(x, 60)).filter(Boolean) : []);
const https = (v) => { const s = str(v, 2048); return /^https:\/\//i.test(s) ? s : ''; };

function streams(list) {
  return (Array.isArray(list) ? list : []).slice(0, 12)
    .map((s) => ({ id: str(s && s.id, 120), name: str(s && s.name, 60), url: https(s && s.url) }))
    .filter((s) => s.id && s.name);
}

// Returns null when the match carries none of the extras (older website, other sources).
function matchExtras(m) {
  if (!m || typeof m !== 'object') return null;
  const has = ['streamId', 'siteStatus', 'calledAt', 'startedAt', 'checkIn', 'station', 'lobby', 'vod', 'maps', 'veto', 'bracket'].some((k) => m[k] !== undefined);
  if (!has) return null;
  const out = {
    streamId: str(m.streamId, 120) || null,
    siteStatus: str(m.siteStatus, 30),
    calledAt: iso(m.calledAt),
    startedAt: iso(m.startedAt),
    checkIn: { a: !!(m.checkIn && m.checkIn.a), b: !!(m.checkIn && m.checkIn.b) },
    station: str(m.station, 40),
    vod: https(m.vod),
    maps: (Array.isArray(m.maps) ? m.maps : []).slice(0, 15).map((g) => ({
      game: Math.max(1, Math.min(15, Math.trunc(Number(g && g.game) || 0))) || 1,
      map: str(g && g.map, 60),
      pickedBy: g && (g.pickedBy === 'A' || g.pickedBy === 'B' || g.pickedBy === 'decider') ? g.pickedBy : null,
      side: str(g && g.side, 30) || null,
      status: str(g && g.status, 20) || 'pending',
      vod: https(g && g.vod),
      characters: g && g.characters && typeof g.characters === 'object' ? { A: names(g.characters.A), B: names(g.characters.B) } : null,
    })),
    bracket: m.bracket && typeof m.bracket === 'object' ? {
      stage: str(m.bracket.stage, 60), stageKind: str(m.bracket.stageKind, 30),
      side: ['winners', 'losers', 'grand_finals'].includes(m.bracket.side) ? m.bracket.side : null,
      round: Number.isFinite(Number(m.bracket.round)) ? Number(m.bracket.round) : null,
      match: Number.isFinite(Number(m.bracket.match)) ? Number(m.bracket.match) : null,
      winnerTo: str(m.bracket.winnerTo, 120) || null, loserTo: str(m.bracket.loserTo, 120) || null,
    } : null,
  };
  if (m.lobby && typeof m.lobby === 'object' && (m.lobby.code || m.lobby.password)) {
    out.lobby = { code: str(m.lobby.code, 80), password: str(m.lobby.password, 80) };
  }
  if (m.veto && typeof m.veto === 'object') {
    const v = m.veto;
    out.veto = {
      status: str(v.status, 20),
      mapPool: names(v.mapPool),
      bans: (Array.isArray(v.bans) ? v.bans : []).slice(0, 20).map((b) => ({ map: str(b && b.map, 60), by: side(b && b.by) })).filter((b) => b.map),
      picks: (Array.isArray(v.picks) ? v.picks : []).slice(0, 15).map((p) => ({
        map: str(p && p.map, 60), by: p && p.by === 'decider' ? 'decider' : side(p && p.by), side: str(p && p.side, 30) || null, sideBy: side(p && p.sideBy),
      })).filter((p) => p.map),
      characters: (Array.isArray(v.characters) ? v.characters : []).slice(0, 20).map((c) => ({
        by: side(c && c.by), action: c && c.action === 'ban' ? 'ban' : 'pick', names: names(c && c.names),
      })).filter((c) => c.names.length),
    };
  }
  return out;
}

// The same extras with A and B swapped (the league lists the website's team B as its teamA).
function flipExtras(x) {
  if (!x) return x;
  const f = (s) => (s === 'A' ? 'B' : s === 'B' ? 'A' : s);
  const out = JSON.parse(JSON.stringify(x));
  out.checkIn = { a: x.checkIn.b, b: x.checkIn.a };
  out.maps = out.maps.map((g) => ({ ...g, pickedBy: f(g.pickedBy), characters: g.characters ? { A: g.characters.B, B: g.characters.A } : null }));
  if (out.veto) {
    out.veto.bans = out.veto.bans.map((b) => ({ ...b, by: f(b.by) }));
    out.veto.picks = out.veto.picks.map((p) => ({ ...p, by: f(p.by), sideBy: f(p.sideBy) }));
    out.veto.characters = out.veto.characters.map((c) => ({ ...c, by: f(c.by) }));
  }
  return out;
}

// The match this desk should be on: one being played on this desk's stream (lowest queue place),
// else featured / queued anywhere when no stream is picked, else the only live match. With a
// stream picked and nothing live on it, the next match queued on it (so the desk shows "up next").
function deskMatch(schedule, streamId) {
  const list = Array.isArray(schedule) ? schedule : [];
  const pos = (m) => (m.queuePos == null ? 99 : m.queuePos);
  const done = (m) => m.status === 'cancelled' || (m.result && m.result.scoreA != null && m.result.scoreB != null && m.status !== 'live');
  const live = list.filter((m) => m.status === 'live');
  if (streamId) {
    const mine = list.filter((m) => m.site && m.site.streamId === streamId);
    const liveMine = mine.filter((m) => m.status === 'live').sort((a, b) => pos(a) - pos(b));
    if (liveMine.length) return { match: liveMine[0], why: 'live' };
    const next = mine.filter((m) => !done(m)).sort((a, b) => pos(a) - pos(b));
    return next.length ? { match: next[0], why: 'next' } : null;
  }
  if (!live.length) return null;
  const queued = live.filter((m) => m.onStream || m.featured).sort((a, b) => pos(a) - pos(b));
  if (queued.length) return { match: queued[0], why: 'live' };
  return live.length === 1 ? { match: live[0], why: 'live' } : null;
}

module.exports = { streams, matchExtras, flipExtras, deskMatch };
