'use strict';
// LAN seat cameras. At a LAN the camera belongs to the SEAT, not the player: seat 1's webcam stays at
// seat 1 all day while players rotate through. So each seat gets one permanent VDO.ninja link (two
// fixed side rooms, "Team 1 side" / "Team 2 side", never tied to whichever team is loaded), and each
// match the producer says who is sitting where. Assigning a player writes an ordinary facecam
// ({ name: in-game name, link: the seat's view link, seatId }), so every HUD that already follows
// facecams follows the seat with no changes.
//
// State shape (state.lanSeats):
//   enabled, perSide (1-6), rooms { a: {room, password}, b: {...} },
//   names { seatId: 'PC 4' }, links { seatId: custom view URL }, assign { seatId: in-game name },
//   last { normalised name: seatId }  (where each player sat last, for auto-seating),
//   seats [...] (derived by rebuild(); never trusted from disk)

const SIDES = ['a', 'b'];
const SIDE_LABEL = { a: 'Team 1 side', b: 'Team 2 side' };
const key = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function seatIds(perSide) {
  const out = [];
  SIDES.forEach((s) => { for (let i = 1; i <= perSide; i++) out.push(s + i); });
  return out;
}

function normalize(ls) {
  ls = (ls && typeof ls === 'object') ? ls : {};
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  const n = Math.max(1, Math.min(6, Math.round(Number(ls.perSide) || 3)));
  const out = {
    enabled: !!ls.enabled,
    perSide: n,
    rooms: obj(ls.rooms),
    names: obj(ls.names),
    links: obj(ls.links),
    assign: obj(ls.assign),
    last: obj(ls.last),
    // Seat helpers: a script on each seat PC reads that PC's own Rocket League Stats API and reports
    // who is playing there to a small LAN listener (off by default; token required).
    agent: {
      enabled: !!(ls.agent && ls.agent.enabled),
      port: Math.max(1024, Math.min(65535, Math.round(Number(ls.agent && ls.agent.port) || 3005))),
      token: (ls.agent && typeof ls.agent.token === 'string' && /^[a-f0-9]{32,64}$/.test(ls.agent.token)) ? ls.agent.token : '',
    },
    seen: obj(ls.seen),   // { seatId: { name, at } } what each seat helper last reported (runtime only)
    agentError: typeof ls.agentError === 'string' ? ls.agentError : '',   // why the helper listener is not running (runtime only)
    seats: [],
  };
  const valid = new Set(seatIds(6));
  ['names', 'links', 'assign'].forEach((k) => Object.keys(out[k]).forEach((id) => { if (!valid.has(id) || typeof out[k][id] !== 'string') delete out[k][id]; }));
  Object.keys(out.last).forEach((k) => { if (!valid.has(out.last[k])) delete out.last[k]; });
  return out;
}

// Make sure both side rooms exist. `fresh()` returns { room, password }.
function ensureRooms(ls, fresh, regenerate) {
  let changed = false;
  SIDES.forEach((s) => {
    const r = ls.rooms[s];
    if (regenerate || !r || !r.room || !r.password) { ls.rooms[s] = fresh(); changed = true; }
  });
  return changed;
}

// Derive ls.seats (links + who is in each seat). opts: { base, lang, pushExtra }.
function rebuild(ls, opts) {
  const base = String((opts && opts.base) || 'https://vdo.ninja').replace(/\/+$/, '');
  const lang = (opts && opts.lang) || 'en-US';
  const extra = (opts && opts.pushExtra) ? '&' + String(opts.pushExtra).replace(/^&+/, '') : '';
  ls.seats = seatIds(ls.perSide).map((id) => {
    const side = id[0], n = Number(id.slice(1));
    const r = ls.rooms[side] || {};
    const sid = 'seat_' + id;
    const label = ls.names[id] || ('Seat ' + n);
    const ready = !!(r.room && r.password);
    const joinUrl = ready ? `${base}/?room=${r.room}&push=${sid}&label=${encodeURIComponent(SIDE_LABEL[side] + ' ' + label)}&transcribe=${lang}&webcam${extra}#p=${r.password}` : '';
    const viewUrl = ready ? `${base}/?room=${r.room}&view=${sid}&solo&cleanoutput&cover#p=${r.password}` : '';
    return { id, side, sideLabel: SIDE_LABEL[side], n, label, streamId: sid, joinUrl, viewUrl,
      link: ls.links[id] || viewUrl, custom: !!ls.links[id], player: ls.assign[id] || '' };
  });
  return ls;
}

const seatLink = (ls, id) => { const s = (ls.seats || []).find((x) => x.id === id); return s ? s.link : ''; };

// Put `name` (an in-game name, '' to empty the seat) in seat `id`. Mutates ls + facecams.
function assign(ls, facecams, id, name) {
  if (!seatIds(ls.perSide).includes(id)) return false;
  name = String(name || '').trim();
  const prev = ls.assign[id] || '';
  // The previous occupant's seat cam goes with the seat (only the row this seat wrote).
  if (prev) removeSeatCam(facecams, prev, id);
  delete ls.assign[id];
  if (name) {
    // A player sits in one seat: leaving another seat frees it.
    Object.keys(ls.assign).forEach((other) => {
      if (key(ls.assign[other]) === key(name)) { removeSeatCam(facecams, ls.assign[other], other); delete ls.assign[other]; }
    });
    ls.assign[id] = name;
    ls.last[key(name)] = id;
    const link = seatLink(ls, id);
    if (link) {
      // Replace whatever cam this player had (any spelling) with the seat's.
      for (let i = facecams.length - 1; i >= 0; i--) if (facecams[i] && key(facecams[i].name) === key(name)) facecams.splice(i, 1);
      facecams.push({ name, platform: '', platformId: '', link, nickname: name, seatId: id, manuallySet: true });
    }
  }
  return true;
}
function removeSeatCam(facecams, name, id) {
  for (let i = facecams.length - 1; i >= 0; i--) {
    const f = facecams[i];
    if (f && f.seatId === id && key(f.name) === key(name)) facecams.splice(i, 1);
  }
}

// Seat links changed (custom link, new rooms, seat count): rewrite the cams the seats own.
function refreshSeatCams(ls, facecams) {
  let changed = false;
  facecams.forEach((f) => {
    if (!f || !f.seatId) return;
    const s = (ls.seats || []).find((x) => x.id === f.seatId);
    if (!s || key(ls.assign[f.seatId]) !== key(f.name)) return;
    if (s.link && f.link !== s.link) { f.link = s.link; changed = true; }
  });
  // Seats removed by a smaller seat count drop their occupant.
  const valid = new Set(seatIds(ls.perSide));
  Object.keys(ls.assign).forEach((id) => { if (!valid.has(id)) { removeSeatCam(facecams, ls.assign[id], id); delete ls.assign[id]; changed = true; } });
  return changed;
}

// Players in the lobby who sat somewhere before go back to that seat if it is free. Only fills empty
// seats; never moves someone the producer already placed. Returns the number seated.
function autoSeat(ls, facecams, players) {
  let n = 0;
  const seated = new Set(Object.values(ls.assign).map(key));
  (players || []).forEach((p) => {
    const nm = p && p.name; if (!nm || seated.has(key(nm))) return;
    const id = ls.last[key(nm)];
    if (!id || ls.assign[id] || !seatIds(ls.perSide).includes(id)) return;
    assign(ls, facecams, id, nm); seated.add(key(nm)); n++;
  });
  return n;
}

function clearAll(ls, facecams) {
  Object.keys(ls.assign).forEach((id) => removeSeatCam(facecams, ls.assign[id], id));
  ls.assign = {};
}

// The seat helper script for one seat: PowerShell (ships with Windows, nothing to install). It reads
// the seat PC's own Stats API (127.0.0.1, newline-delimited {Event, Data} JSON) and reports the
// local player. While PLAYING, the client's view target (Game.Target) is the player's own car; goal
// replays are skipped (the replay camera follows the scorer) and a name must hold for 3 updates.
function helperScript({ producer, port, token, seatId, seatLabel, statsPort }) {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  return [
    '# NE Broadcast Suite seat helper: ' + seatLabel,
    '# Run on the PC at this seat. Leave it running. It tells the producer who is playing here.',
    '# Needs Rocket League Stats API on (TAGame/Config/DefaultStatsAPI.ini: PacketSendRate above 0).',
    '$Producer = ' + q('http://' + producer + ':' + port),
    '$Seat = ' + q(seatId),
    '$Token = ' + q(token),
    '$StatsPort = ' + Number(statsPort || 49123),
    '$Host.UI.RawUI.WindowTitle = ' + q('Seat helper: ' + seatLabel),
    'function Send-Seat($name) {',
    '  try { Invoke-RestMethod -Method Post -Uri "$Producer/seat" -ContentType "application/json" -TimeoutSec 4 -Body (@{ token = $Token; seat = $Seat; name = $name } | ConvertTo-Json) | Out-Null; return $true }',
    '  catch { Write-Host ("Could not reach the producer at " + $Producer + ": " + $_.Exception.Message) -ForegroundColor Yellow; return $false }',
    '}',
    'Write-Host ("Seat helper for " + ' + q(seatLabel) + ' + ". Waiting for Rocket League...") -ForegroundColor Cyan',
    '$sent = ""; $cand = ""; $hold = 0; $lastSend = [DateTime]::MinValue',
    'while ($true) {',
    '  try {',
    '    $client = New-Object Net.Sockets.TcpClient("127.0.0.1", $StatsPort)',
    '    $reader = New-Object IO.StreamReader($client.GetStream())',
    '    Write-Host "Connected to Rocket League." -ForegroundColor Green',
    '    while ($client.Connected) {',
    '      $line = $reader.ReadLine(); if ($line -eq $null) { break }',
    '      if ($line -notmatch \'"Event"\\s*:\\s*"UpdateState"\') { continue }',
    '      try { $msg = $line | ConvertFrom-Json; $d = $msg.Data; if ($d -is [string]) { $d = $d | ConvertFrom-Json } } catch { continue }',
    '      $g = $d.Game; if (-not $g -or $g.bReplay) { continue }',
    '      $name = if ($g.bHasTarget -and $g.Target) { [string]$g.Target.Name } else { "" }',
    '      if (-not $name) { if ($sent -ne "?") { Write-Host "Rocket League is not reporting who is playing here yet." -ForegroundColor Yellow; $sent = "?" }; continue }',
    '      if ($name -eq $cand) { $hold++ } else { $cand = $name; $hold = 1 }',
    '      $stale = ((Get-Date) - $lastSend).TotalSeconds -gt 20',
    '      if ($hold -ge 3 -and ($name -ne $sent -or $stale)) {',
    '        if (Send-Seat $name) { if ($name -ne $sent) { Write-Host ("Playing here: " + $name) -ForegroundColor Green }; $sent = $name; $lastSend = Get-Date }',
    '      }',
    '    }',
    '  } catch { }',
    '  Start-Sleep -Seconds 3',
    '}',
    '',
  ].join('\r\n');
}

module.exports = { SIDES, SIDE_LABEL, seatIds, normalize, ensureRooms, rebuild, assign, refreshSeatCams, autoSeat, clearAll, helperScript };
