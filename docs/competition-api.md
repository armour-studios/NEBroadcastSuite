# Competition data: connecting a league to NE Broadcast Suite

This guide is for league organisers and the developers who run their tools. It explains how to get a league's teams, fixtures, results and standings into the broadcast app. Once they're in, the ticker, schedule board, standings, starting-soon and BRB scenes update on their own.

There are four ways in. They all feed the same league inside the app, so you can mix them: for example, fixtures from a Google Sheet and live results from a Discord bot.

| You have | Use | Needs |
|---|---|---|
| Nothing yet, or a small league | **Enter it in the app** | Nothing |
| A Google Sheet | **Google Sheet source** | Share the sheet (or a service account) |
| A league website or database | **Website feed** (the app polls a URL you publish) | One JSON endpoint |
| A bot, form or script on the broadcast PC | **Local API** (you push updates) | The API key |

A one-off CSV or JSON file can also be imported on a league's **Data source** tab.

In the app: **Esports > Competitions**. Open a league, go to its **Data source** tab, pick a source, then press **Go live** so the scenes follow it.

---

## The document format (`ne-competition` v1)

Every source speaks one JSON document. A website feed returns it, `PUT`/`PATCH` send it, and a Google Sheet is converted into it.

```json
{
  "format": "ne-competition",
  "version": 1,
  "competition": {
    "id": "fall-2026",
    "name": "Collegiate Fall League",
    "season": "Fall 2026",
    "game": "rocket-league"
  },
  "teams": [
    { "id": "rvs", "name": "Riverside", "abbr": "RVS", "logo": "https://yourleague.com/logos/riverside.png", "color": "#1d4ed8", "division": "East" },
    { "id": "lkn", "name": "Lakeside North", "abbr": "LKN", "logo": "https://yourleague.com/logos/lakeside.png", "division": "East" }
  ],
  "matches": [
    { "id": "wk3-rvs-lkn", "teamA": "rvs", "teamB": "lkn", "scheduledAt": "2026-09-24T19:30:00-04:00",
      "week": "3", "bestOf": 5, "status": "scheduled", "stream": "https://twitch.tv/yourleague" },
    { "id": "wk2-lkn-rvs", "teamA": "lkn", "teamB": "rvs", "scheduledAt": "2026-09-17T19:30:00-04:00",
      "week": "2", "bestOf": 5, "status": "completed", "scoreA": 3, "scoreB": 1,
      "games": [ { "scoreA": 3, "scoreB": 1 }, { "scoreA": 0, "scoreB": 2 }, { "scoreA": 4, "scoreB": 2 }, { "scoreA": 2, "scoreB": 1 } ] }
  ],
  "standings": [
    { "team": "lkn", "rank": 1, "wins": 2, "losses": 0, "points": 6, "gameWins": 6, "gameLosses": 2 }
  ]
}
```

The JSON Schema is served at `http://127.0.0.1:3000/api/v1/schema`.

### Fields

**competition**: `id`, `name`, `season`, `game`. All are optional. `name` is required only when creating a competition through the API. `game` is the app's game id: `rocket-league`, `valorant`, `csgo`, `overwatch`, `league`, `marvel-rivals`, `rainbow6`, `fortnite`, `smash` and so on.

**teams[]**

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Display name. |
| `id` | recommended | Your stable id. Matches may reference a team by id or by name. |
| `abbr` | | Up to 12 characters. |
| `logo` | | An image **URL**. Only fills in a crest the producer hasn't set in the app. |
| `color` | | `#rrggbb`. |
| `division` | | Created on first sight; used by two-column standings. |

**matches[]**

| Field | Required | Notes |
|---|---|---|
| `teamA`, `teamB` | yes | Team id or name. `home`/`away` are accepted too. |
| `id` | **strongly recommended** | Your stable id. Without it, a fixture is matched by its two teams plus week/date, so rescheduling it creates a new fixture. |
| `scheduledAt` | | ISO 8601 with a timezone. Shown in the broadcast PC's local time. |
| `date`, `time` | | The alternative to `scheduledAt`: `YYYY-MM-DD` and `HH:MM` (24h). `9/24/2026` and `7:30 PM` are accepted. |
| `week`, `round` | | Labels. The scenes show `round`, falling back to "Week N". |
| `bestOf` | | Integer. |
| `status` | | `scheduled`, `live`, `completed`, `postponed`, `cancelled`. Leave it out and it's worked out from the score. |
| `scoreA`, `scoreB` | | The series score. Omit both (or send `null`) for an unplayed match. |
| `games[]` | | Per-game `{ scoreA, scoreB, map }`. When present, the series score is counted from it. |
| `overtime` | | Boolean. Awards the league's overtime-win points. |
| `stream` | | Stream URL for this match. |

**standings[]** is optional. Leave it out and the app calculates standings from the results using the league's scoring settings. Send it only if your system is the source of truth for the table. Doing so switches the league to manual standings, so a recalculate can't overwrite yours.

| Field | Notes |
|---|---|
| `team` | Team id or name (required). |
| `rank`, `wins`, `losses`, `draws`, `points`, `gameWins`, `gameLosses`, `division` | Numbers except `division`. |

### How updates are merged

- **Teams** are matched by `id`, then by exact name, then by name ignoring case, punctuation and words like "Esports" or "Gaming". Names are never matched loosely ("Lakeside North" is never merged into "Lakeside"). An unknown name creates a team.
- **Matches** are matched by `id`. Without one, they're matched by their two teams (either way round) plus week and date.
- **Syncing the same document twice changes nothing.**
- **The document is treated as the whole truth** when you use the Google Sheet or website feed sources (unless "Remove matches the feed no longer lists" is off), or `PUT`. A fixture that came from an earlier sync or API call and is no longer listed is removed. **Fixtures a producer added by hand in the app are never removed.**
- The source owns what it sends. If a producer edits a synced match in the app, the next sync overwrites that edit, and the app shows a notice saying so.

---

## Google Sheets

Make one tab per table. Header names are flexible; the bold ones are required.

| Tab | Columns |
|---|---|
| Teams | **Team**, Abbr, Logo, Color, Division |
| Matches | Match ID, **Team A**, **Team B**, Date, Time, Week, Round, Best Of, Status, Score A, Score B, Stream |
| Standings (optional) | **Team**, Rank, W, L, T, Points, Game Wins, Game Losses, Division |

These header names also work: Home/Away, Team 1/Team 2, Home Score/Away Score, Wins/Losses/Pts, Conference/Group for Division, Kickoff/Start Time for Time.

**Access:** either share the sheet as *Anyone with the link, Viewer*, or connect a Google service account in **Settings > Google Sheets** and share the sheet with that account's email. A service account works for private sheets.

The app reads the sheet on the interval you choose (default one minute). A tab name that doesn't exist, or a tab without the expected columns, is skipped with a warning. It is never read as an empty schedule.

---

## Website feed (pull)

Publish one URL that returns the document above, as `application/json`. A CSV in the Matches format also works. In the app, choose **Website feed**, paste the URL and, optionally, an access token.

- The app sends `Authorization: Bearer <token>` if you set a token. The token is stored encrypted on the broadcast PC.
- It sends `If-None-Match` when your server returns an `ETag`. Answer `304` to skip unchanged data.
- It polls every 30 seconds to 15 minutes (producer's choice) and backs off automatically while your endpoint is failing.
- Responses are capped at 5 MB, and the request times out after 15 seconds.

This is the recommended path for a league website: the broadcast PC calls out, so nothing needs to reach into it.

---

## Local API (push)

The app runs an HTTP API on the broadcast PC at `http://127.0.0.1:3000/api/v1`. It only accepts connections from that machine. A bot or service on another host can poll your system and call this API from a small script on the broadcast PC, or you can use the website feed instead.

**Auth:** every route except `/schema` needs the key from **Esports > Competitions > Developer docs**, sent as either:

```
Authorization: Bearer nek_...
X-Api-Key: nek_...
```

A competition's `:id` is the id shown on its Data source tab.

### Routes

| Method and path | Body | Result |
|---|---|---|
| `GET /api/v1/schema` | | JSON Schema (no key needed) |
| `GET /api/v1/competitions` | | `{ live, competitions: [{ id, name, season, game, teams, matches, source, live }] }` |
| `POST /api/v1/competitions` | document (`competition.name` required) | `201 { competition, summary }` |
| `GET /api/v1/competitions/:id` | | the competition as a document |
| `PUT /api/v1/competitions/:id` | document | Replace. Synced/API fixtures not listed are removed; add `?prune=false` to merge instead. |
| `PATCH /api/v1/competitions/:id` | partial document | Merge only |
| `PATCH /api/v1/competitions/:id/matches/:matchId` | `{ status, scoreA, scoreB, games, scheduledAt, date, time, week, round, stream, overtime }` | `{ match }` |
| `GET /api/v1/competitions/:id/feed` | | what the scenes are showing: `{ live, upcoming, results, next }` |
| `POST /api/v1/live` | `{ "id": "<competition id>" }` or `{ "id": "" }` | puts a competition on air, or takes it off |

`:matchId` is your `id` from the document, or the app's own match id.

Setting `status: "live"` on a match clears `live` from any other match in that competition. Setting `status: "scheduled"` clears the score.

Errors come back as `{ ok: false, error }` or `{ ok: false, errors: [...] }` with status `400`, `401` or `404`. Validation warnings (skipped rows) come back in `warnings`.

### Examples

Report a result:

```bash
curl -X PATCH http://127.0.0.1:3000/api/v1/competitions/lg-abc123/matches/wk3-rvs-lkn \
  -H "Authorization: Bearer nek_..." -H "Content-Type: application/json" \
  -d '{"status":"completed","scoreA":3,"scoreB":2}'
```

Add next week's fixtures:

```bash
curl -X PATCH http://127.0.0.1:3000/api/v1/competitions/lg-abc123 \
  -H "Authorization: Bearer nek_..." -H "Content-Type: application/json" \
  -d '{"matches":[{"id":"wk4-rvs-hll","teamA":"Riverside","teamB":"Hilltop","scheduledAt":"2026-10-01T19:30:00-04:00","bestOf":5}]}'
```

Node.js (18+):

```js
await fetch(`http://127.0.0.1:3000/api/v1/competitions/${id}/matches/${matchId}`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${process.env.NE_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ status: 'live' }),
});
```

---

## What the scenes show

Once a league is live (**Go live**), each scene follows it. Each can be switched off on the Competitions page.

- **Ticker** (`ticker.html`, source "Live competition"): live matches, then the next few with their start time, then recent finals.
- **Schedule board** (`schedule.html`) and **starting soon** (`preshow.html`): live, then the soonest upcoming, then recent results if "keep finished" is on.
- **Standings** (`standings.html`): the league table, with divisions.
- **BRB / intermission** (`intermission.html`): an UP NEXT strip under the countdown. Hide it per source with `?next=0`.

A match reads as LIVE when it's marked live (in the app, through the API, or by `status: live` from a sheet or feed), or when the producer has armed it for capture on the league's Schedule tab.
