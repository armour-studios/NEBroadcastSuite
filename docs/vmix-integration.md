# vMix Integration — Research & Implementation Map

Goal: add **vMix** as a supported production switcher that is a **full alternative to OBS** — a producer
picks *one* backend per setup and drives the same NE Broadcast Suite actions (scene cuts, trigger
graphics, stream/record, replay, tally) against it. This doc is research + a phased build plan. Nothing
here is built yet.

> **Decision (confirmed): vMix is a full alternative, not run alongside OBS.** The backend is a clean
> **either/or** (`obs` XOR `vmix`) — no simultaneous "both" mode. This keeps the switcher abstraction
> simple: exactly one active client at a time.

Sources: [vMix HTTP Web API](https://www.vmix.com/help28/DeveloperAPI.html) ·
[vMix TCP API](https://www.vmix.com/help26/TCPAPI.html) ·
[Unofficial vMix API reference](https://vmixapi.com/) ·
[vMix vs OBS (Renewed Vision)](https://www.renewedvision.com/blog/vmix-vs-obs-whats-better-for-streaming) ·
[StreamGeeks OBS vs vMix](https://streamgeeks.us/obs-vs-vmix/)

---

## 1. What we already do with OBS (the parity target)

Our OBS layer (`server.js`, obs-websocket v5) does:
- **Scene switch** — `obsClient.switchScene()` (`SetCurrentProgramScene`); mapped scene "moments" + literal names.
- **Transitions** — `SetCurrentSceneTransition` + `...Duration`.
- **Stream / Record** — `StartStream`/`StopStream`, `StartRecord`/`StopRecord`.
- **Replay buffer** — `startReplayBuffer` / `SaveReplayBuffer` (goal clips → our video editor).
- **Media control** — `TriggerMediaInputAction`.
- **Source install** — `CreateInput` / `SetInputSettings` build the generated scene collection (our HTML overlays as **Browser Sources**).
- **Health** — `GetStats`, `GetStreamStatus`.
- Overlays are **HTML browser sources** (duorow/bracket/standings/etc.) driven by our own `state.*.visible` flags over WS :3001 — independent of the switcher.

**Key insight:** our overlays are just web pages. vMix has a native **Web Browser input**, so the *entire*
overlay suite works in vMix unchanged — vMix integration is about *control*, not re-building overlays.

---

## 2. vMix control surface (how we'd talk to it)

vMix exposes three remote surfaces; we'd use the first two:

| Surface | Port (default) | Use it for |
|---|---|---|
| **HTTP Web API** | 8088 | Everything: `GET http://host:8088/api/?Function=X&Input=Y&Value=Z`. Blank `GET /api/` returns full **XML state**. Perfect for our axios/Node-16 backend — no new library. |
| **TCP API** | 8099 | Real-time **tally / activators** (`SUBSCRIBE TALLY`, `SUBSCRIBE ACTS`) — push updates instead of polling. Needs a raw socket. |
| Web Controller / Web Scripting | 8088 | Not needed — we build our own UI. |

Input addressing: by **number** (1+, `0`=Preview, `-1`=Active), by **name**, or by **GUID** (the `Key`
attribute in the XML — most robust, survives reordering).

State model to add: `state.vmix = { enabled, connected, host, port, inputs:[{key,number,title,type,state}],
active, preview, overlays:[...], recording, streaming, replay:{...} }`, refreshed by polling `GET /api/`
(~1 s) + TCP tally for instant program/preview.

---

## 3. vMix function map → what it buys us

### Switching / transitions (→ mirrors `obsSwitch`)
- `Cut`, `Fade`, `Merge`, `Wipe`, `Slide`, `Fly`, `CrossZoom`, `Cube`, `CubeZoom`, `Stinger1-4` (Input=target).
- `Transition1-4` (the four armed quick-transitions), `SetTransitionEffect{1-4}` + `SetTransitionDuration{1-4}`.
- `PreviewInput`, `ActiveInput`, `CutDirect`, `FadeToBlack`, `QuickPlay`.
- **Win vs OBS:** richer built-in transitions incl. **stingers** as first-class, and a real **preview/program** model (T-bar), which OBS Studio lacks natively.

### Overlays (→ our "trigger graphics" get a native home)
- `OverlayInput1`-`OverlayInput4` toggle the 4 overlay channels; `OverlayInput1In`/`Out`/`Off`, `OverlayInput1Zoom`.
- Overlays can target multiple **mixes** at once (`Mix` param).
- **Win vs OBS:** vMix overlay *channels* put a lower-third/bug up and down **without a scene change** — a
  cleaner fit for our lower-thirds/bracket/ticker than toggling OBS source visibility. Map our
  "Put On Air" cockpit chips → OverlayInput channels when the backend is vMix.

### Titles & text (optional native path)
- `SetText` (`SelectedName=Title.Text&Value=...`), `SetImage`, `SetColor`, `SelectTitlePreset`,
  `NextTitlePreset`, `TitleBeginAnimation`, `SetTextVisibleOn/Off`.
- **Use case:** push live scores/team names into vMix **GT titles** as an alternative to (or alongside)
  our HTML overlays. Probably Phase 4+ — our HTML overlays already cover this.

### Audio (→ Talent panel parity)
- `SetVolume`, `SetVolumeFade`, `Audio` (toggle mute), `AudioOn/Off`, `SetMasterVolume`, `Solo`,
  bus routing `AudioBusOn/Off`, `SetBusAVolume`, `BusXAudio`.
- **Use case:** drive per-caster / per-talent volume + mute + bus from our existing Talent/Director mixer.

### Instant Replay (vMix's headline feature — big for RL / CS2)
- `ReplayMarkIn`, `ReplayMarkInOut`, `ReplayPlayLastEvent`, `ReplayPlayEventToOutput`, `ReplayJumpToNow`,
  `ReplayChangeSpeed` (slow-mo), `ReplaySelectChannel{1-8}` (camera angles), `ReplayLiveToggle`,
  `ReplayExportLastEventToStinger`. (Exact names are version-specific — confirm against the reference.)
- **Win vs OBS:** true multi-camera slow-motion instant replay with angle selection and highlight reels.
  Our goal-replay flow (`autoReplayOnGoal`) could drive vMix replay marks on RL goals for real slow-mo.

### Streaming / recording (→ parity + extras)
- `StartRecording`/`StopRecording`, `StartStreaming Value=0..4`/`StopStreaming` (**up to 5 destinations**),
  `StartExternal`, `StartMultiCorder`, `StartFullscreen`, `SnapshotOutput`.
- **Win vs OBS:** multi-destination simulcast, **SRT** + full **NDI** in/out.

### Multiview / layers (PiP without extra scenes)
- `SetMultiViewOverlay Input=<host>&Value=<layer>,<inputToShow>`, `MultiViewOverlayOn/Off`, `SetLayer`,
  Fly params: `SetPanX/Y`, `SetZoom`, `SetPosition`, `SetCrop`.
- **Use case:** composite caster cams / bugs onto a program input on the fly — maps to our camera-layout scenes.

### PTZ cameras
- `PTZMoveUp/Down/Left/Right/Stop`, `PTZZoomIn/Out`, `PTZHome`, `PTZLoadVirtualInput`, `PTZCreatePreset`.
- **Use case:** if a venue uses PTZ cams, recall presets from the panel.

### Tally / state (TCP)
- `SUBSCRIBE TALLY` → per-input program/preview; `SUBSCRIBE ACTS` → overlay/record/stream/input activators.
- **Use case:** live **on-air indicators** in the control panel + drive our facecam/talent "LIVE" dots, and
  keep the cockpit's NOW/Program in sync with what's actually on air.

---

## 4. Proposed architecture — a switcher abstraction

Today the app calls OBS directly. Introduce a thin **switcher interface** so producer actions target the
chosen backend without duplicating logic everywhere. Because it's a full either/or, exactly **one** client
is active at a time — the abstraction just picks which one:

```
state.switcher = { target: 'obs' | 'vmix', ... }   // mutually exclusive — no 'both'

function activeSwitcher() { return state.switcher.target === 'vmix' ? vmixClient : obsClient; }

switcher.cutTo(sceneKeyOrInput)      // obs: SetCurrentProgramScene · vmix: Cut/Fade to input
switcher.setOverlay(key, on)         // obs: source visibility · vmix: OverlayInputN In/Out
switcher.setTransition(type, ms)
switcher.stream(on) / record(on)     // vmix: StartStreaming Value per destination
switcher.replayMark() / replayPlay()
switcher.setAudio(id, {vol,mute,bus})
switcher.getState()                  // normalized {active, preview, overlays, streaming, recording, tally}
```

- `obsClient` stays; add a `vmixClient` (HTTP calls + XML poll + TCP tally). Only the selected one connects.
- Route the existing WS messages (`obs_switch_scene`, stream/record, replay, transition) through
  `switcher` — it dispatches to whichever backend `state.switcher.target` names. No fan-out logic.
- Switching backend = disconnect the old client, connect the new one; the normalized `getState()` shape
  means the control panel's status/tally UI doesn't care which backend is behind it.
- **Source install parity:** alongside `obs/build-scene-collection.js`, add a **vMix preset generator**
  that emits a `.vmix` (or an import list) adding our overlay URLs as **Web Browser inputs** + mapping
  scene-moments to inputs. Same overlay HTML, different container.
- Settings → add a **vMix** section mirroring the OBS one (host/port/enable/connection status), plus a
  single **Program backend** toggle (OBS ↔ vMix). Selecting vMix hides/greys the OBS-specific settings and
  vice-versa, so the producer only sees the controls for the backend they're on.

---

## 5. Phased build plan

| Phase | Scope | Delivers |
|---|---|---|
| **1 — Connect & switch** ✅ **BUILT** | `backend/vmix.js` HTTP client + XML poll (1.5s); `state.vmix` + `state.switcher.target`; Settings → vMix section (host/port/enable/Test + live status) + OBS↔vMix backend toggle; `set_vmix_settings`/`set_switcher_target`/`vmix_call`/`vmix_test_connection` handlers; **Flow vMix actions** (vmix_cut/overlay/stream/record/replay/set_text/function). Overlays run as vMix Web Browser inputs. | Producer connects vMix, sees live tally/inputs, and Flows can fire vMix triggers |
| **2 — Overlays, transitions, stream/record** | OverlayInput channels for the "Put On Air" cockpit; transition picker; stream (multi-dest) + record buttons | Trigger graphics + go-live parity, natively |
| **3 — Tally & audio** | TCP tally → on-air indicators + cockpit NOW sync; audio volume/mute/bus from Talent mixer | Real feedback loop + audio control |
| **4 — Instant replay, PTZ, multiview** | Drive vMix replay marks (RL goals → slow-mo angles), PTZ presets, PiP layers, optional `SetText` to GT titles | vMix's premium sports/production features |

**Start with Phase 1** — it's low-risk (HTTP GET + XML, no new deps for control; TCP only in Phase 3),
proves the switcher abstraction, and immediately makes the whole existing overlay suite usable in vMix.

---

## 6. Gotchas / notes
- HTTP API is **local by default** (127.0.0.1); remote control needs vMix's Web Controller/API enabled +
  firewall. Same trust model as our OBS localhost assumption.
- Prefer **input GUIDs** over numbers/names in stored mappings — numbers shift when inputs are reordered.
- vMix function/param names vary slightly by version (v24–v29). Pin to the user's version and confirm exact
  Replay/Audio-bus names against the [reference](https://vmixapi.com/) before wiring Phase 3–4.
- vMix is **Windows-only** and paid (HD/4K/Pro tiers gate inputs, replay cameras, NDI). OBS stays the free
  default backend; vMix is the selectable "pro venue" alternative — a producer commits to one per setup.
- The AI-Shield / `OBS_AUTO_SWITCH_DISABLED` kill-switch model must extend to vMix too (no un-armed auto-cuts).
