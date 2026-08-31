# Grid multiview — many producers, one wall

The GRID/RLCS-style wall: several producers each run their own broadcast of a different match, and
the main broadcast shows them side by side with a bar under each tile carrying that producer's
channel and the **series** score.

This is not a new data pipeline — it is a second face on the one Pulse already uses.

## How a match gets onto the wall

```
producer's desktop app                 cloud (NENetworkWebsite)              main broadcast's OBS
──────────────────────                 ────────────────────────              ────────────────────
state.pulse.publish = on
  ↓ every 3s
publishObservedGame()  ──POST──▶  /api/orgs/:id/observed-games
  teams a/b (name, abbr,             cleanObservedInput() sanitises
  logo, colour, map score,           → ObservedGame row (upsert by
  series score), clock,                orgId+key)
  status, bestOf, feed
  { viewUrl, channel, label }
                                   /api/orgs/:id/multiview
                                     shapeMultiview() — drops any row
                                     whose heartbeat is >30s old
                                            │
                        desktop /api/multiview proxy (Bearer, server-side)
                                            │
                                     GET /api/multiview  ◀── grid.html / grid-bars.html / pulse.html
```

The proxy matters: the browser source never holds a credential, and a producer who closes their app
falls off the wall by itself 30 seconds later.

## Turning it on (each producer)

Settings ▸ Broadcast ▸ **Grid Multiview**:

| Field | What it does |
|---|---|
| Publish my match | The master switch. Off = nothing is published. Also feeds the Pulse scene. |
| My Twitch channel | Captioned on the tile as `twitch.tv/handle`. |
| Desk label | Used instead when there is no handle ("Desk 2"). |
| My feed URL | The VDO **view** link for that producer's program feed — the video that fills their tile. Empty = a scores-only tile. |

Requires an active broadcast seat in the org (`resolveApiActor` + `BroadcastSeat`); an unlinked app
publishes nothing and its wall sits on STANDBY. There is no demo mode anywhere in these scenes — an
empty wall means nobody is publishing, and it says so.

## The scenes (main broadcast)

| Scene | Source | Use |
|---|---|---|
| `grid.html` | one browser source, paints everything | The wall including video — nothing to lay out. |
| `grid-bars.html` | transparent | You place your own video sources (capture, NDI, Twitch); we draw only the bars, NOW bar and ticker. |
| `pulse.html` | one browser source | The whip-around: one big feed that cuts to whichever match just scored. |

Params: `?tiles=2|3|4|6` pins a layout (default `auto` grows the wall as producers come online),
`?ticker=0` / `?nowbar=0` drop the bottom furniture, and — on `grid-bars.html` only — `?guides=1`
prints each tile's OBS transform numbers (Position X/Y and Size) inside its rectangle so you can
type them into your sources.

## Look and ticker

Nothing in the wall is hard-coded to a colour. `grid-core.applyBrand()` writes the active brand
kit's `color` and `accent` onto `:root`, and every accent reads from those — the NOW-bar title
gradient runs colour → accent, tile borders and crest fallbacks tint from them, and the backdrop
washes are both of them. `brand.font` sets the type, `brand.logo` the mark, and the sponsor strip
follows the kit's own `sponsorMode` (`static` shows the set at once, `cycle` rotates at
`sponsorInterval`). The app's scene themes (`midnight`, `neon`) recolour the same two tokens.

The bottom strip is the app's real ticker, not a second one: the wall's own live matches lead, then
— while the producer has their ticker running — `state.ticker`'s content in its own mode, at its own
speed, with `brand.spots.ticker` pinned at the left. start.gg mode renders live/final scorelines with
crests exactly as `overlay/ticker.html` does; manual mode renders their messages. With nothing to
say the strip hides itself rather than scrolling an empty bar.

`obs/build-scene-collection.js` ships **Multiview — Grid 2-Up / 4-Up / Pulse** as ready scenes.

## Which score shows where

The tile bar shows the **series** score (maps won). The map score is already on each producer's own
HUD, baked into their video — repeating it on the bar would double it up on screen. Both numbers
travel (`ma`/`mb` and `sa`/`sb`), so a future skin can show either.

## Where the code lives

| Piece | File |
|---|---|
| Publisher (heartbeat, abbr, series, channel) | `server.js` — `publishObservedGame` block + `set_pulse` |
| Sanitise / shape | `NENetworkWebsite/lib/observed-games.ts` |
| Routes | `NENetworkWebsite/app/api/orgs/[id]/{observed-games,multiview}/route.ts` |
| Layout, data, NOW bar, ticker | `overlay/grid-core.js` |
| Sizes shared by both scenes | `overlay/grid.css` |
| Scenes | `overlay/grid.html`, `overlay/grid-bars.html` |

`channel`, `label`, `abbr`, `series` and `bestOf` ride inside the existing `teams` / `feed` JSON
columns — **no Prisma migration**, but the website has to be deployed before they reach the wall.
Until it is, tiles still work: names, logos and map scores flow, series reads 0-0 and the caption
falls back to the game name.
