# Control API: run the show from your own tools

**Server:** `server.js` (`V1_ACTIONS`, `v1State`, routes under `/api/v1/control` and `/api/v1/state`). **Tests:** `scripts/e2e-server.js` ("control API").

The same actions the control panel and the Stream Deck send over the WebSocket, as plain HTTP for bots, web panels, hardware buttons and apps built on the platform. Every action is validated, then run through `handleControlMessage`, the single implementation the buttons in the app use, so a bot and a producer can work side by side.

## Basics

- Base URL `http://127.0.0.1:3000/api/v1`. The server listens on this PC only (plus an origin guard), so a tool on another machine needs a relay on the broadcast PC.
- Auth: `Authorization: Bearer <key>` or `X-Api-Key: <key>`. The key is on Apps > API in the app; it is the same key as the competition routes in `docs/competition-api.md`.
- Requests and responses are JSON. Every action answers `{ ok: true, action, state }` with the state after the change. A wrong body answers `400 { ok: false, error }` naming what it expected; an unknown action is `404`.
- `GET /api/v1/control` lists every action with its body, so a client can build its UI from it.

## Reading

`GET /api/v1/state` returns:

| Field | |
|---|---|
| `game` | The active game id (`rocket-league`, `csgo`, ...). |
| `eventName`, `roundLabel` | Titles on the overlays. |
| `bestOf`, `gameNumber` | Series length and the game being played. |
| `teams.blue` / `teams.orange` | `{ name, abbr, color, score, logo, players[] }`. A logo stored as an image (not a URL) reads `"(image)"`. |
| `graphic`, `graphics[]` | The full-screen graphic on air (or null) and every key `graphic` accepts. |
| `break` | `{ visible, title, endsAt }` |
| `banner`, `casters` | Whether the sponsor banner / caster lower third are on. |
| `brandKit`, `brandKits[]` | The live kit id and every kit `{ id, name }`. |
| `colorMode` | `team` / `brand` / `default` / `game`. |
| `obs` | `{ connected, scene, scenes[] }` |
| `event` | `{ platform, name }` of the loaded event, or null. |

For a live stream of every change, read the WebSocket feed instead (Apps > API > Live feed and your own overlays).

## Actions: `POST /api/v1/control/:action`

| Action | Body | Does |
|---|---|---|
| `score` | `{ side: "blue"\|"orange", delta: 1 }` | Adds (or with -1 takes away) a game win; the game number follows. `a`/`b` are accepted for the sides. |
| `series-reset` | `{}` | 0-0, game 1. |
| `swap-sides` | `{}` | Swaps the teams. |
| `game` | `{ delta: 1 }` | Moves the game number. |
| `best-of` | `{ value: 5 }` | 1 to 15. |
| `team` | `{ side, name, logo?, abbr?, color? }` | Puts a team on a side. A library team brings its roster and logo. `logo` must be an http(s) or data:image URL. |
| `team-color` | `{ side, color: "#rrggbb" }` | |
| `round` | `{ text }` | |
| `event-name` | `{ name }` | |
| `graphic` | `{ key }` / `{ key: null }` | Shows one full-screen graphic (keys in `state.graphics`), or hides it. |
| `break` | `{ visible?, title?, message?, finalMessage?, seconds? \| until: "21:30", titleOnly?, thenScene? }` | Break screen and countdown. `{ visible: false }` hides it and disarms the clock. |
| `banner` | `{ visible }` | Sponsor banner. |
| `casters` | `{ visible }` | Caster lower third (and the casters scene, if one is set). |
| `scene` | `{ scene: "Gameplay" }` | Cuts OBS (or Streamlabs / vMix) to a scene. |
| `brand-kit` | `{ id }` / `{ id: null }` | Makes a brand kit live. |
| `color-mode` | `{ mode }` | `team`, `brand`, `default` or `game`. |

## Example

```
curl -X POST http://127.0.0.1:3000/api/v1/control/score \
  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"side":"blue","delta":1}'
```

## Adding an action

Add an entry to `V1_ACTIONS` in `server.js`: a one-line `desc` (it is what `GET /api/v1/control` shows) and a `build(body)` that returns `{ type, data }` for an existing WebSocket message, or a falsy value for a bad body. Never put logic in `build` beyond validating and shaping the body; the WebSocket handler is the implementation. Add a check to `scripts/e2e-server.js`.
