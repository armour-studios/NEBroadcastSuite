# Website competitions → NE Broadcast Studio (contract)

**Status:** v2 (2026-10-10), both sides built. **Website:** `lib/broadcast-competitions.ts` + `app/api/broadcast/competitions/**` in NENetworkWebsite (**deploy needed**). **App:** `backend/cloud/cloud-client.js` (`listMyCompetitions`, `getMyCompetition`, `reportCompetitionMatch`), `server.js` (`pullOrgCompetitions`, `loadSiteEvent`, `putSiteMatchOnAir`, `siteEventFollow`, `siteReportCapture`), `control-panel/site-events.js` (Event page ▸ Your events). Tests: `test/site-event.test.js`, `test/cloud-competition-source.test.js`.

The website is where leagues and tournaments are **created and run**. The app follows them the way it follows a start.gg event: Load pulls the teams (with rosters) into the library, puts the league on air (ticker, schedule, standings, BRB), switches the game, and with auto-follow on loads the match the website marks live on the stream onto the scoreboard. The series the desk records goes back to the website, game by game, and the final score settles the fixture (bracket and standings move on).

## v2 routes (person-scoped, current)

| Route | What |
|---|---|
| `GET /api/broadcast/competitions` | `{ competitions: [...], createUrl }`. Every competition the person owns or is CompetitionAdmin on (any role, casters included), plus those run by communities where they are owner/admin/manager/staff and orgs where they hold an owner/admin/producer/operator broadcast seat. Entries carry the v1 list fields below plus `status, logo, url, consoleUrl, role, host, teams, startsAt, nextMatchAt, canReport`. `rev` is a **change key** (newest of rev time, competition edit, any fixture, any participant), because result writes on the website do not bump `Competition.rev`. `live` = a fixture is being played AND it is on a stream queue or featured. |
| `GET /api/broadcast/competitions/:id` | The ne-competition v1 document (below) for the running season (else the next, else the latest). Needs `staff.view` on the competition, or a producer seat in the hosting org; otherwise 404. `ETag` = hash of the body; `If-None-Match` → 304. |
| `POST /api/broadcast/competitions/:id/matches/:fixtureId/report` | Body `{ games: [{ scoreA, scoreB }], scoreA, scoreB, final }`. `final: false`: FixtureGame rows upserted and the fixture set to `in_progress` (skipped when it is already final). `final: true`: `adminSetFixtureResult` + audit + `settleFixture`, the same as the console override. Needs `results.override` (owner, admin, moderator); 403 otherwise. |

Auth: `Authorization: Bearer <sessionToken>` (`resolveApiActor`). Works for personal workspaces; no org needed.

**Fallback:** if the LIST route answers 404 (a website deployed before v2), the app switches to the v1 org routes below until restart.

### Document additions in v2 (all optional, the app reads v1 without them)
- `teams[].players: [{ id, name, role, photo }]`: when present the website owns the roster. The league team and the library team (matched by `siteId`) take it; a library team the producer built by hand only has gaps filled.
- `matches[].onStream, queuePos, featured, streamName`: the stream queue. Auto-follow takes the live match that is queued (lowest `queuePos`) or featured; with none queued it follows only when exactly one match is live. A series the desk has started recording is never switched away.
- `competition.kind`, `competition.website`.
- Unplayed fixtures omit `scoreA` / `scoreB` (the database stores 0-0, which the app would read as a result). Byes and TBD slots are left out.
- Status map: veto / in_progress / awaiting_confirmation / disputed → `live`; completed / forfeited → `completed`; cancelled → `cancelled`; the rest → `scheduled`.

### Producer extras (2026-10-13, all optional)
Website: `docForUser` in `lib/broadcast-competitions.ts`. App: `backend/competition-site.js` keeps them on the league fixture as `m.site`, turned to the fixture's orientation (`m.site.flipped` when the league lists the website's team B first).

- Document: `streams: [{ id, name, url }]`, the event's broadcast channels. A desk picks one (Event page ▸ *This desk*, `state.siteEvent.streamId`) and auto-follow takes **that stream's** queue: the live match on it, else (once the match on air is finished) the next one queued on it.
- Per match: `streamId`, `siteStatus` (the website's own status: `check_in`, `veto`, ...), `calledAt`, `startedAt`, `checkIn: { a, b }`, `station` (LAN station name), `lobby: { code, password }` (only to people with `results.override` or `schedule.manage`, never casters), `vod`, `maps: [{ game, map, pickedBy, side, status, vod, characters: { A, B } }]` (every game, played or not), `veto: { status, mapPool, bans: [{ map, by }], picks: [{ map, by, side, sideBy }], characters: [{ by, action, names }] }` (blind character picks still hidden are left out), `bracket: { stage, stageKind, side, round, match, winnerTo, loserTo }`.

## Producer actions (2026-10-13)

`POST /api/broadcast/competitions/:id/matches/:fixtureId/actions`, Bearer as above. One action per call; the website reuses its console's match-day engine, so rosters are pinged, chat lines posted and the event live-bumped exactly as if an organizer had done it there. Audited (event audit + Studio activity).

| Body | Effect | Needs |
|---|---|---|
| `{ action: 'call' }` | ping both rosters (in-app, email, Discord) | `results.override` |
| `{ action: 'start' }` | `in_progress` from scheduled / check-in / veto (already running: `unchanged`) | `results.override` |
| `{ action: 'queue', streamId \| null, position? }` | onto / within / off a stream's queue | `schedule.manage` |
| `{ action: 'feature', featured }` | the featured-match flag | `schedule.manage` |
| `{ action: 'game', gameNumber, map?, pickedBy?, side?, characters?, status? }` | game details (never scores: those use `/report`) | `results.override` |
| `{ action: 'vod', url \| null, gameNumber? }` | series or game VOD, https only | `results.override` |
| `{ action: 'message', text }` | a "Broadcast: ..." line in the match chat (300 chars) | `results.override` |

Answers `{ ok, action, ...result }`; errors `{ error: { code, message } }` with 400 (validation), 403, 404, 409 (not playable / not startable / no such game). App: `cloud.actOnCompetitionMatch`, `siteEventAct` (server.js), WS `site_event_action { matchId, action, ... }` → `site-event-action-result`; buttons on the Event page (Call, Start, To / Off my stream, Feature; VOD and a message box for the match on air). Parsing: `lib/studio/producer-actions.ts` (+ `.test.ts`).

---

# v1 (org-scoped, kept as the fallback)

Conventions are the ones in `docs/cloud-backend-contract.md` §1: HTTPS, JSON, `x-app` / `x-app-version` headers, errors as `{ "error": { "code", "message" } }`.


## Auth and scope

- `Authorization: Bearer <sessionToken>` — the same broadcast session token every other cloud call sends (`resolveApiActor` on the website).
- `:orgId` is the session's workspace (`workspaceId` from the login response). The app only calls these routes when that is a real organization id, never for a personal `user:<id>` workspace.
- The caller must hold a broadcast seat in that org. Any seat role may **read** (these routes are read-only); use the same gate as `GET /api/orgs/:orgId/leagues`.
- `401` / `403` are shown to the producer as *"Sign in to the Nameless website again (Settings > Profile)"* and stop the sync for that league until they do. Neither trips the app's cloud circuit breaker — only 5xx / 429 / timeouts do — so answer caller errors with 4xx, not 500.

---

## 1. `GET /api/orgs/:orgId/competitions` — the list

Every competition the org hosts that a broadcast could follow. **No fixtures, no rosters** — this is polled every 60 seconds by every signed-in desk, so keep it small (ids, names, a counter).

```json
{
  "competitions": [
    {
      "id": "cmp_8f3a2",
      "kind": "league",
      "name": "Nameless Collegiate League",
      "season": "Fall 2026",
      "game": "rocket-league",
      "rev": 142,
      "updatedAt": 1759795200000,
      "live": false
    },
    {
      "id": "cmp_1b77c",
      "kind": "tournament",
      "name": "October Open",
      "season": "",
      "game": "valorant",
      "rev": 9,
      "updatedAt": 1759798800000,
      "live": true
    }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string | **Stable for the life of the competition.** The app stores it in the league (`source.cloudCompetitionId`); renaming, rescheduling or re-seeding must not change it. |
| `kind` | `"league"` \| `"tournament"` | Anything else is read as `league`. |
| `name` | string | Shown in the picker as `name · season · kind`. |
| `season` | string | Optional; `""` when none. |
| `game` | string | The app's game id (`rocket-league`, `valorant`, `csgo`, `overwatch`, `league`, `marvel-rivals`, `rainbow6`, `fortnite`, `smash`, …) — see `competition.game` in `docs/competition-api.md`. Optional. |
| `rev` | integer | **Required.** A monotonic change counter: bump it on **any** change to the competition that the document below would reflect (teams, fixtures, scores, standings, status, the `live` flag). Equal `rev` ⇒ the document is byte-identical, which is what lets the app skip the fetch. |
| `updatedAt` | epoch ms | Optional; used as the change key only if `rev` is missing. |
| `live` | boolean | See *The `live` flag* below. |

Order is up to the website (most recently updated first is the useful default). Hard cap in the app: 500 entries.

Finished or archived competitions may be omitted; a linked league whose id disappears from the list shows *"This competition is no longer on the Nameless website"* and stops syncing (it keeps its last data).

## 2. `GET /api/orgs/:orgId/competitions/:id` — the document

Returns the competition as an **`ne-competition` v1 document**, exactly the format in `docs/competition-api.md` (that file is the field reference; the JSON Schema is served by the app at `http://127.0.0.1:3000/api/v1/schema`). In short:

```json
{
  "format": "ne-competition",
  "version": 1,
  "competition": { "id": "cmp_8f3a2", "name": "Nameless Collegiate League", "season": "Fall 2026", "game": "rocket-league" },
  "teams":    [ { "id": "t_rvs", "name": "Riverside", "abbr": "RVS", "logo": "https://…/riverside.png", "color": "#1d4ed8", "division": "East" } ],
  "matches":  [ { "id": "m_wk3_1", "teamA": "t_rvs", "teamB": "t_lkn", "scheduledAt": "2026-09-24T19:30:00-04:00", "week": "3", "round": "Week 3", "bestOf": 5, "status": "live", "scoreA": 1, "scoreB": 0, "games": [ { "scoreA": 3, "scoreB": 1 } ], "stream": "https://twitch.tv/nameless" } ],
  "standings": [ { "team": "t_lkn", "rank": 1, "wins": 2, "losses": 0, "points": 6, "gameWins": 6, "gameLosses": 2 } ]
}
```

Requirements specific to this source:

- **Stable ids on every team and match.** The app matches rows by `id` across syncs; without one a rescheduled fixture becomes a new fixture and the old one is pruned. Use your database ids.
- **The document is the whole truth.** The app applies it with pruning: a fixture that came from the website and is no longer listed is removed from the league. Fixtures a producer added by hand in the app are kept.
- **Send `standings` only if the website computes the table.** If present, the app stops recalculating standings for that league and shows yours. If absent, the app calculates from the results with the league's scoring settings.
- **`status: "live"` on a match** is what puts that fixture on the ticker / schedule board as LIVE. One live match per competition is the norm; the app clears any other live flag when a new one arrives.
- Logos are **URLs**, never base64 (the app caps feed documents at 5 MB; this one goes through the same validator).
- `competition.name` / `season` / `game` fill the league's name/season/game the first time only — a producer's own title is never overwritten.

### ETag

- Respond with an `ETag` header (a hash of the body, or simply `"<rev>"`).
- The app sends `If-None-Match: <etag>` on every fetch after the first. Answer **`304 Not Modified`** with an empty body when it matches. A 304 counts as a successful sync in the app ("Already up to date").
- The ETag is kept in memory on the broadcast PC only; after an app restart the first fetch is unconditional.

Response caps on the app side: 12-second timeout per request.

---

## The `live` flag

`live: true` on a list entry means *"this competition is being played / broadcast right now"*. The app uses it in one way only:

- If a linked competition is `live` **and nothing is on air in the app** (`state.competition.leagueId` empty), the app puts that league on air itself (`competitionGoLive`), which binds the ticker, schedule board, standings and BRB scenes to it — **once per `rev`**.
- If the producer then takes it off air, the app does **not** fight them: it will not re-arm until `rev` changes. So **bump `rev` whenever `live` flips**, otherwise a competition that goes live → off → live again at the same `rev` is ignored.
- If something else is already on air, the flag does nothing. It never takes a competition *off* air.
- Entries without `rev` (and without `updatedAt`) are synced but never auto-armed.

`live` on the **list** is about the competition; `status: "live"` on a **match** in the document is about one fixture. Both are expected.

---

## Poll cadence (what the website will see)

| Call | When | Per desk |
|---|---|---|
| `GET …/competitions` | every **60 s** (jittered ±20 %), while the app is signed in to an org | 1 req/min |
| `GET …/competitions/:id` | only when that competition's `rev` (or `updatedAt`) differs from the last applied one, when the producer presses *Sync now* / *Test* / *Link*, and once after an app restart | ~0 req/min at rest |

- Failures back off exponentially per loop (60 s → 2 min → 4 min … → 5 min cap) and the app-wide breaker pauses **all** background cloud traffic on 5xx / 429 / no-response, honouring `Retry-After`.
- A per-league fetch that fails backs that league off (1 → 2 → 4 … min, 15 min cap) without affecting the list poll or other leagues.
- When the session is signed out or expired the app makes **no** calls and the picker empties.

---

## What the app does with it (for reference)

- The picker: Esports ▸ Competitions ▸ open a league ▸ **Data source** ▸ *Nameless website* ▸ pick ▸ **Link**. Linking sets `source = { type: 'cloud', cloudCompetitionId, intervalSec: 60, auto: true }` and syncs at once.
- The league is read-only toward the website: the in-app *Sync to Website* push refuses it (`buildLeaguePushPayload` returns `null` for `source.type === 'cloud'`).
- Sync status (last synced / last error) is in `state.compSync[leagueId]`, the same place the Google Sheet and feed sources report.
- Scoreboards, the ticker, schedule, standings and BRB scenes follow the league once it is on air, exactly as for every other source.

## Not in v1 (open)

- No webhook/push from the website to the app; the 60 s list poll is the latency.
- No per-competition ACL beyond the org seat.
- The list is org-scoped only; cross-org or public competitions are out of scope.
