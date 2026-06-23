# Operator Guide — NE Broadcast Suite

A run-of-show guide for casting a Rocket League event end to end. The control
panel drives everything live over WebSocket; OBS just hosts the browser sources
and (optionally) gets its scenes switched automatically.

## Quick start — the Scene Launcher

Open **`http://localhost:3000/scenes.html`** for a one-page launcher of every browser
source: **Copy** any URL straight into an OBS Browser Source, **Open** to preview, and
see a live **ON AIR** badge next to whatever is currently showing. The same list (plus
on-air toggles) lives in the control panel's **Scenes** tab.

## Browser sources (add in OBS, 1920×1080)

| Scene | URL | Notes |
|-------|-----|-------|
| Main overlay (HUD / goal / post-game) | `http://localhost:3000` | The in-game scoreboard, goal replays, post-match stats, sponsor banner, ticker, and player spotlight all live here. |
| Casters | `http://localhost:3000/casters.html` | Transparent **camera holes** — composite your real webcams (or a background) behind this source, or paste a vdo.ninja URL per caster. |
| Bracket | `http://localhost:3000/bracket.html` | Live bracket. Single/double elim render as winners/losers/grand-final columns; round-robin/swiss render a standings table. Shows team logos. |
| Countdown / Starting Soon | `http://localhost:3000/countdown.html` | Break/standby timer. Driven by Production → Break / Starting Soon (title, message, countdown minutes). Movie-style finish + "we're live" message. |
| Winner / Post-match | `http://localhost:3000/winner.html` | Champion screen. Driven by Production → Winner / Post-match (team or custom name + subtitle). |
| Team Line-up / Intro | `http://localhost:3000/intro.html` | Animated roster cards for a team. Driven by Production → Team Line-up (`?side=blue|orange` to hard-pin a side per source). |
| Map Veto / Map board | `http://localhost:3000/mapscreen.html` | Pick/ban board for CS2/Valorant-style series. Driven by Production → Map Veto. |

**Caster-cam layouts** (all driven by the same casters list + current teams + brand):
`duorow.html`, `triorow.html`, `duosinglecam.html`, `triocam.html`, `awayfull.html`,
`analystspecial.html`.

**Stingers / transitions** (brand-recoloured wipes; use as an OBS *stinger transition*
or a momentary scene — append `?team=blue`/`?team=orange` for a team logo):
`transition.html`, `transitionbgg.html`, `replay.html`.

These are all their **own** sources so you can switch to them as dedicated OBS scenes
instead of layering them over gameplay. They recolour automatically to the active Brand Kit.

## One-time setup

1. **Active game** — Dashboard → click a game card (or use the header dropdown). Switch titles
   without digging into Settings. Rocket League uses the official **Stats API** (TCP :49123) — enable
   it in-game under Settings → Misc → Game Stats API.
2. **Start.gg token** — Settings → Start.gg → paste your API token → Save.
3. **OBS WebSocket** — In OBS: Tools → WebSocket Server Settings → enable, note
   the port (default `4455`) and password. In the panel: Settings → OBS →
   enter `ws://127.0.0.1:4455` + password → **Test Connection** (loads your
   scene list) → map a scene to each moment (In-Game, Replay, Post-Game, Break,
   Casters, Bracket) → Save.
4. **Fonts** — install the Bourgeois font for the intended look (Settings → font).

## Run of show

1. **Load the event** — Production → Tournament Event → paste the Start.gg event
   URL → **Load Event**. This imports every team, their players, team logos, and
   the full bracket in one shot (paginated for large events).
2. **Per match** — Production → Current Match → pick the matchup → **Push to
   Overlay**. Both teams (names, logos, players) fill the scoreboard and a fresh
   series starts.
3. **During play** — the main overlay tracks the live game automatically. With
   OBS auto-switching on, goal replays / game start / match end switch scenes for
   you. Use the **Live Scene Control** buttons for manual cuts.
4. **Highlights** — with the OBS Replay Buffer running, enable *Auto-save replay
   clip on each goal*, or hit **Save Replay Clip** manually.
5. **Between matches** — **Refresh Bracket** to update scores/standings.

## Production elements (Production tab)

- **Live status chips** — at-a-glance: OBS connection, loaded event, what's on air.
- **Player Spotlight** — feature any player as a lower-third with live stats.
- **Casters** — up to 4 commentators (name, @handle, optional cam URL).
- **Break / Starting Soon** — full-screen intermission with title, message, a live
  countdown, and an auto "Up Next" line from the bracket.
- **Ticker** — scrolling sponsor/announcement lower-third along the bottom.
- **Scene control** — manual cut buttons + instant-replay controls.

## Dashboard (live cockpit)

- **Game switcher** — card grid + dropdowns at the top; mirrors the header game/theme selects.
- **On-Air Control** — one switch per scene (Casters, Break/Countdown, Winner, Line-up,
  Map Veto, Bracket, Ticker, Spotlight, Sponsor banner). Same toggles are in the sticky
  production header. **Cut all** drops everything off-air in one click.
- **Scene Sources** — copy/open every overlay URL, or open the full launcher page.

## Tips

- Everything is driven from the control panel and pushed live to every source —
  no need to edit anything in OBS once scenes are added.
- Re-loading an event refreshes rosters and the bracket but keeps any custom team
  logos you set manually (it only fills logos that are blank).
- The bracket persists across restarts and re-fetches fresh scores on launch.
