# Elgato Stream Deck Plugin — Research & Build Plan

Goal: a first-party Stream Deck plugin ("NE Broadcast Suite") that drives this app
over its localhost WebSocket bridge, mirroring the in-app Production Deck — physical
keys for scenes, flows, graphics, audio, replays, with live on-air feedback.

Status: BUILT (2026-07-13) — see `streamdeck-plugin/`. 14 actions (the plan's set
plus Set Score and Select Team, modelled on the EsportsDash Controller plugin),
validated, linked, and confirmed connected against the live suite. Zero backend
changes were required.

---

## 1. Why this is a natural fit

- **Every producer action in this app is already a remote-control message.** The
  control panel drives the server over `ws://localhost:3001` with uniform
  `{ "type": "<string>", "data": { ... } }` JSON frames, dispatched by
  `handleControlMessage()` (server.js:11498). The Stream Deck plugin speaks the
  same protocol — it is just another control-panel client.
- **Stream Deck plugins are plain Node.js processes.** The Stream Deck app bundles
  Node 20/24 (users don't need Node installed), manages the plugin lifecycle, and
  imposes no network sandbox — opening a WebSocket to localhost is exactly how the
  official OBS and Bitfocus Companion plugins work.
- **Live key feedback comes free.** The server pushes `full_state` broadcasts on
  every change; the plugin mirrors the same fields the in-app deck's
  `deckLiveClass()` (control-panel/app.js:20772) reads: current OBS scene, source
  enabled, input muted, graphic visible.
- **No auth needed on localhost.** The WS bridge only enforces its token when
  `WS_HOST` is non-loopback (server.js:10822). If the user LAN-exposes the bridge,
  fetch the token from `GET http://localhost:3000/api/ws-token` and append
  `?token=<hex>` to the WS URL. Support both.

## 2. Stream Deck SDK crash course (what matters for us)

- **Toolchain:** `npm i -g @elgato/cli` → `streamdeck create` scaffolds a
  TypeScript + rollup project. Library: `@elgato/streamdeck` v2 (engines node
  >=20.5.1). Dev loop: `npm run watch` (rebuild + `streamdeck restart <uuid>`).
  Debug: manifest `"Nodejs": {"Debug": "enabled"}` → attach VS Code to the node
  process. Validate/pack: `streamdeck validate`, `streamdeck pack` →
  `.streamDeckPlugin` double-click installer.
- **Layout:** everything ships in a `<uuid>.sdPlugin/` folder (manifest.json,
  `bin/plugin.js` rollup bundle, `imgs/`, `ui/` property-inspector HTML). Installed
  under `%APPDATA%\Elgato\StreamDeck\Plugins\`. `streamdeck link` symlinks the dev
  folder there.
- **Actions:** classes extending `SingletonAction<TSettings>` with an
  `@action({ UUID })` decorator; override `onKeyDown`, `onWillAppear`,
  `onWillDisappear`, `onDidReceiveSettings`, `onSendToPlugin`. Per-key settings
  persist automatically (`ev.action.setSettings/getSettings`); plugin-wide config
  goes in global settings (encrypted at rest — use for the LAN token if ever needed).
- **Key visuals:** `setTitle()`, `setImage()` (inline SVG string or data URL —
  ideal for dynamic scores/countdowns), `setState(0|1)` for two-state toggles
  (`DisableAutomaticStates: true` when WE own the state, which we do — state comes
  from the server, not from presses), `showOk()`/`showAlert()`. Hard cap: **10
  image updates/sec per key** (Marketplace guideline). Precedence gotcha: a
  user-typed title masks runtime `setTitle` — set `UserTitleEnabled: false` on
  actions whose title we render (scene name, flow name, countdown).
- **Property Inspector:** per-action HTML page in Chromium; use
  `@elgato/sdpi-components` (ship the JS file locally). `setting="x"` attributes
  two-way bind to action settings with zero glue. **Datasources** make dynamic
  dropdowns trivial: `<sdpi-select setting="scene" datasource="getScenes" hot-reload>`
  fires `sendToPlugin {event:"getScenes"}`; plugin replies via
  `sendToPropertyInspector` with `{event:"getScenes", items:[{label,value}...]}`.
  PI debugging: `streamdeck dev` once, then http://localhost:23654/.
- **App monitoring:** manifest `"ApplicationsToMonitor": {"windows": ["NE Broadcast Suite.exe"]}`
  gives `onApplicationDidLaunch/Terminate` — the canonical trigger for
  connect/disconnect instead of blind polling. Also handle `systemDidWakeUp`.
- **Stream Deck + (dials):** `"Controllers": ["Encoder"]`, `$B1` layout
  (title/icon/value/indicator bar), `onDialRotate/onDialDown/onTouchTap`,
  `setFeedback({value, indicator:{value}})`. Perfect for OBS input volume
  (`obs_set_volume` exists as a flow action; dial = rotate volume, push = mute).
- **Distribution:** private = just share the `.streamDeckPlugin` file (no signing
  gate). Marketplace = Maker Console upload + Elgato review + optional DRM
  (requires SDKVersion 3, no runtime manifest reads). UUIDs are immutable after
  publication — choose carefully. Guideline: action icons monochrome white
  20×20/40×40, state images 72×72/144×144, plugin icon 256/512 PNG.

## 3. Our control surface (what keys send)

One WS connection to `ws://localhost:3001`. On connect the server immediately sends
a `full_state` snapshot; afterwards throttled `full_state` (live tier ~40ms
coalesced) and lean `state_update` frames arrive on change.

Action vocabulary (mirrors `deckFire()`, control-panel/app.js:20741):

| Plugin action | WS message(s) | Feedback source in state |
|---|---|---|
| Switch Scene | `obs_switch_scene {sceneName}` | `obs.currentScene` (routes via `switcherCut()` — also covers vMix) |
| Fire Flow | `fire_flow_manual {id}` | momentary — `showOk` on send |
| Graphic On-Air (toggle) | paired `set_<gfx> {visible}` + `set_gfx_active {scene:key\|''}` per `GOLIVE_TRIGGERS` (app.js:14176) | `gfxActive`, `<gfx>.visible` |
| Audio Mute (toggle) | `obs_input_mute` / `obs_input_unmute {inputName}` | `obs.audioInputs[].muted` |
| Source Show/Hide (toggle) | `obs_source_show` / `obs_source_hide {scene, source}` | `obs.sources[].enabled` |
| Break Countdown | `set_break {visible:true, seconds, title}` | `breakScreen.visible` |
| HUD / Scoreboard | `force_hud` / `force_scoreboard` | view state |
| Save Replay | `obs_save_replay` | momentary |
| Replay Buffer (toggle) | `obs_toggle_replay_buffer` | `obs.replayBufferActive` |
| Play Clip / Montage | `replay_play {bus,url,name,...}` / `replay_stop` / `replay_take` | replay bus state |
| Ad Break | `obs_start_commercial` / `obs_end_commercial` | commercial state. **Explicit key press only — never automated (no-auto-ads rule).** |
| Clear Graphics | `set_gfx_active {scene:''}` | `gfxActive === ''` |

Target lists for Property Inspector dropdowns, all from `full_state.data`:
`obs.availableScenes`, `obs.audioInputs`, `obs.sources`, `flows`, `clips.montages`.

## 4. Plugin architecture

```
com.armour-studios.ne-broadcast.sdPlugin/
├── manifest.json            SDKVersion 3, Nodejs 24, ApplicationsToMonitor,
│                            Software.MinimumVersion 7.1, Category "NE Broadcast Suite"
├── bin/plugin.js            (rollup output)
├── imgs/…                   plugin + per-action icons (+@2x)
└── ui/
    ├── sdpi-components.js   (vendored)
    └── <action>.html        one PI per action, datasource-driven dropdowns
src/
├── plugin.ts                register actions + streamDeck.connect()
├── suite-connection.ts      THE connection manager (singleton)
└── actions/
    ├── switch-scene.ts  fire-flow.ts  graphic-onair.ts  audio-mute.ts
    ├── source-toggle.ts break-countdown.ts save-replay.ts play-clip.ts
    └── volume-dial.ts   (Encoder controller, Stream Deck + only)
```

**suite-connection.ts** — the one nontrivial module (pattern proven by the
Bitfocus Companion plugin):

- Owns a single `ws` socket to `ws://localhost:3001`; sends `register {role:'control'}`.
- Reconnect: exponential backoff capped at 5s, gated by
  `applicationDidLaunch/Terminate` (don't hammer when the suite isn't running);
  reconnect on `systemDidWakeUp`.
- Maintains a `state` cache updated from `full_state` (merge live tier) and
  `state_update` frames; emits typed events (`connected`, `disconnected`,
  `stateChanged`).
- `send(type, data)` used by all actions; queues nothing while disconnected —
  actions call `showAlert()` instead (a producer must never think a cut happened
  when it didn't).
- Actions register interest in `onWillAppear` / unregister in `onWillDisappear`
  so only visible keys re-render on state pushes (coalesce renders; stay under
  the 10/sec cap — our ~40ms full_state bursts must be debounced to ~150ms).

**Feedback model:** all toggles use `DisableAutomaticStates: true`; key state is
set exclusively from server state (`setState`, plus `setTitle`/SVG `setImage`
for scene/flow names and countdown remaining). Disconnected = grey overlay image
on every key. This makes the physical deck truthful: if OBS drops, keys show it.

## 5. Build phases

1. **Phase 1 — skeleton (a day):** `streamdeck create`, connection manager,
   Switch Scene + Fire Flow + Clear Graphics actions with datasource dropdowns,
   connect/disconnect key feedback. Proves the whole pipeline.
2. **Phase 2 — the deck parity set:** Graphic On-Air, Audio Mute, Source Toggle,
   Break Countdown, HUD/Scoreboard, Save Replay, Replay Buffer, Play Clip.
   Live-state lighting on all toggles.
3. **Phase 3 — polish:** volume dial (Stream Deck +), bundled profile
   (`.streamDeckProfile` with a pre-laid-out page auto-offered on install),
   countdown-remaining rendered on the Break key via 1Hz SVG, icons.
4. **Phase 4 — distribution:** `streamdeck pack`, ship the `.streamDeckPlugin`
   alongside the app installer / from the website; later Maker Console →
   Elgato Marketplace (review the guidelines checklist in §2).

Optional later: a "sync from Production Deck" bridge — the app exports its
`ne_deck_v1` layout and the plugin (or a generator) emits a matching
`.streamDeckProfile`, so producers configure once in-app.

## 6. Gotchas checklist

- Manifest edits need a Stream Deck app restart (metadata is cached); code edits
  only need `streamdeck restart <uuid>`.
- Logs: `streamDeck.logger` → `<plugin>.sdPlugin/logs/`; app logs in
  `%APPDATA%\Elgato\StreamDeck\logs\`.
- Windows `ApplicationsToMonitor` needs the exact packaged exe name — confirm
  what electron-builder outputs (product name) before hardcoding.
- Per-key action settings are plain-text and included in exported profiles —
  fine for scene/flow ids, never for tokens (token → global settings).
- v1 SDK examples online are stale: v2 removed `LogLevel` enum, PI can't import
  the SDK (use sdpi-components), `streamDeck.ui.current` replaces older accessors.
- Our WS host binding: if a producer sets `WS_HOST=0.0.0.0`, the plugin must
  fetch `GET /api/ws-token` and append `?token=`; make host:port configurable in
  a global-settings PI section (default `localhost:3001`).

## 7. Doc links

- Getting started: https://docs.elgato.com/streamdeck/sdk/introduction/getting-started/
- Manifest reference: https://docs.elgato.com/streamdeck/sdk/references/manifest/
- WS protocol (plugin): https://docs.elgato.com/streamdeck/sdk/references/websocket/plugin/
- Guidelines (rate limits, icons, review): https://docs.elgato.com/guidelines/stream-deck/plugins/
- sdpi-components: https://sdpi-components.dev
- Samples: https://github.com/elgatosf/streamdeck-plugin-samples
- Reference plugin (best structural match): https://github.com/bitfocus/io.bitfocus.companion-plugin
