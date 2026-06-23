# OBS scene collection — NE Broadcast Suite

`NE-Broadcast-Suite.json` is a clean OBS Studio scene collection (v2 format) where every
scene is one 1920×1080 browser source pointing at our overlays on `http://localhost:3000`.
Regenerate it any time with:

```
node obs/build-scene-collection.js
```

Import in OBS: **Scene Collection → Import → choose `NE-Broadcast-Suite.json`**, then switch to it.

## The unified "follows the active game" funnel

The **In Game** scene uses `overlay/live.html` (`http://localhost:3000/live.html`) instead of a
fixed game overlay. It reads `activeGame` over WebSocket and swaps its inner HUD to that game's
overlay automatically — RL → `/`, CS2 → `/csgo.html`, and so on from each game's `overlay` route
in the server's `GAMES` registry. Pick a different game in the control panel and OBS keeps the
source loaded while the HUD inside switches. The native per-game URLs still work if you'd rather
point a source straight at one.

## Scenes → overlay URL

| Scene | URL |
| --- | --- |
| In Game | `/live.html` (funnel — auto game HUD) |
| Replay | `/replay.html` |
| Break (Countdown) | `/countdown.html` |
| Post-Game (Winner) | `/winner.html` |
| Casters | `/casters.html` |
| Casters — Duo Row | `/duorow.html` |
| Casters — Trio Row | `/triorow.html` |
| Casters — Duo SingleCam | `/duosinglecam.html` |
| Casters — Trio Cam | `/triocam.html` |
| Analyst Desk | `/analystspecial.html` |
| Away / Standby | `/awayfull.html` |
| Team 1 Intro | `/intro.html?side=blue` |
| Team 2 Intro | `/intro.html?side=orange` |
| Map Veto | `/mapscreen.html` |
| Bracket | `/bracket.html` |

## Map these names in the app

Control panel → **Settings → OBS** maps broadcast moments to scene **names**. Use these exact
names so auto-transitions (post-game → casters, etc.) and the bottom-bar scene cuts line up:
`In Game`, `Replay`, `Post-Game (Winner)`, `Break (Countdown)`, `Casters`, `Bracket`.

## What you still add yourself (machine-specific)

This collection ships the **graphics layer only** — browser overlays. Capture sources are tied to
your PC's windows/devices and can't be generated portably, so add these under the overlay in the
relevant scenes:

- **In Game** — your game capture (RL/CS2 window) *beneath* `GFX In Game`.
- **Caster / Analyst scenes** — your camera or NDI feeds (casters, host) beneath the frame graphic.
- **Audio** — Desktop + Mic are created with default devices; pick your real devices in OBS.
- **Stinger** — a `NE Stinger` transition is pre-created with an empty path; set its `.webm` in
  **Scene Transitions → Properties** to use it (otherwise Fade/Cut work out of the box).
