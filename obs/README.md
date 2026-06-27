# OBS scene collection — NE Broadcast Suite

`NE-Broadcast-Suite.json` is a ready-to-use OBS Studio scene collection (v2 format). Every
scene is built from 1920×1080 browser sources pointing at the suite's overlays on
`http://localhost:3000`, so the whole graphics package comes in with one import.

## Getting it into OBS

**Easiest — from the app:** Control panel → the OBS panel → pick **Caster audio**
(Combined / Separated) → **Install**. The app writes the collection straight into your OBS
`basic/scenes` folder (with your casters' live cam URLs baked in) and, if OBS is open with
WebSocket enabled, switches to it for you.

**Manual import:** **Scene Collection → Import → choose `NE-Broadcast-Suite.json`**, then
switch to it. Regenerate the file any time with:

```
node obs/build-scene-collection.js                    # combined (default)
node obs/build-scene-collection.js --audio-mode=separated   # → NE-Broadcast-Suite-separated.json
```

Optional flags: `--bg-path=FILE` (looping background video), `--stinger=FILE` (stinger .webm),
and `--host-url= --caster1-url= --caster2-url= --caster4-url=` to pre-fill the cam feeds.

## How caster cams fill the "holes" — combined vs separated

Every desk/caster overlay has transparent **camera holes**. There are two ways to fill them,
chosen by the **Caster audio** selector (or `--audio-mode`):

- **Combined _(default, recommended)_** — each desk overlay embeds the cams itself. It reads
  every caster's cam URL from the control panel and drops the VDO.ninja feed into the hole.
  Pixel-perfect, nothing to position, and it survives overlay redesigns. All caster audio
  rides on that one browser-source fader.
- **Separated** — the desk overlay loads with `?cams=off` so its holes go **transparent**, and
  one OBS browser source per caster (the `=> Cam` scenes) is framed in behind each hole. This
  gives you a **per-caster audio fader** in OBS. Hole positions are hardcoded per desk; nudge a
  `=> Cam` source in OBS if a layout ever shifts.

The `=> Host / Caster 1 / 2 / 4 Cam` framing scenes ship in **both** modes, so you can always
hand-drop a single cam into any scene. In separated mode, set their VDO.ninja URLs once
(`[VDO] Host`, `[VDO] Caster 1/2/4`) and every desk updates at once.

## The scenes

Scenes are grouped with `─── LIVE ───` / `─── DESK ───` / `─── UTILITY ───` divider rows.

### Pre-game / break
| Scene | Overlay |
| --- | --- |
| Away / Standby | `/countdown.html` |
| Break (Countdown) | `/countdown.html` |
| Map Veto | `/mapscreen.html` |
| Draft | `/draft.html` |
| Matchup | `/matchup.html` _(embeds a caster strip)_ |
| Team 1 Intro | `/intro.html?side=blue` |
| Team 2 Intro | `/intro.html?side=orange` |
| Upcoming | `/upcoming.html` |
| Standings | `/standings.html` |
| Bracket | `/bracket.html` |

### Live
| Scene | Contents |
| --- | --- |
| In Game | Game Capture + HUD stack: RL / CS2 / Valorant / Overwatch / Marvel Rivals (only your game's HUD visible — un-hide the one you need) |
| In Game — Cam PIP | In Game + `/campip.html` (picture-in-picture caster cams) |
| In Game — Talent Bar | In Game + `/talentbar.html` (lower talent bar) |
| Replay | `/replay.html` |

### Desk / casters _(holes carry the cams — see above)_
| Scene | Overlay | Cams |
| --- | --- | --- |
| SingleCam | `/singlecam.html` | 1 |
| DuoCam Row | `/duorow.html` | 2 |
| TrioCam Row | `/triorow.html` | 3 (C1 · C2 · Host) |
| Quad Desk | `/quaddesk.html` | 4 |
| Analyst Desk | `/analystspecial.html` | Host large + 2 small |
| Duo SingleCam | `/duosinglecam.html` | 1 (full-frame) |
| Spotlight Desk | `/spotlightdesk.html` | 1 + player card |
| Interview | `/interview.html` | 2 guests |
| Post-Game (Winner) | `/winner.html` | — |

### Utility — cam framing scenes
`=> Host Cam`, `=> Caster 1 Cam`, `=> Caster 2 Cam`, `=> Caster 4 Cam` — each holds one
VDO.ninja feed (`[VDO] …`), framed into the desk layouts in separated mode.

### Draggable add-ons (sources, no dedicated scene)
Drop these onto any scene from **Sources → Add → existing**:
`[GFX] Sponsor Banner` (`/sponsor-banner.html`), `[GFX] Listen-In Captions`
(`/listen-in.html`), `[GFX] Interviewee Cam` (`/int-cam.html`).

## Map these names in the app

Control panel → **Settings → OBS** maps broadcast moments to scene **names**. Use these exact
names so auto-transitions and the bottom-bar scene cuts line up:
`In Game`, `Replay`, `Post-Game (Winner)`, `Break (Countdown)`, `Bracket`, plus whichever desk
scene you cast from (e.g. `DuoCam Row`).

## What you still add yourself (machine-specific)

This collection ships the **graphics layer** plus the cam framing scenes — but capture sources
are tied to your PC's windows/devices and can't be generated portably:

- **Game Capture** — the `In Game` scenes include a Game Capture preset for Rocket League; set
  it to your actual game window.
- **Cameras** — in **combined** mode cams come through the overlay automatically (set cam URLs
  in the control panel). In **separated** mode, set the `[VDO]` URLs in the `=> Cam` scenes.
- **Audio** — Desktop + Mic are created with default devices; pick your real devices in OBS.
- **Stinger** — a `NE Stinger` transition is pre-created with an empty path; set its `.webm` in
  **Scene Transitions → Properties** (otherwise Fade/Cut work out of the box).
- **Background** — a `Background Loop` media source backs the desk scenes; point it at a looping
  video, or leave it empty for a solid backdrop (or pass `--bg-path=`).
