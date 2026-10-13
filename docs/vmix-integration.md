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

## 4b. Update 2026-10-08: automated paths now follow the switcher

The §5a punch-list below is DONE. With `state.switcher.target === 'vmix'`:

- **Automated cuts** go through `switcherAutoCut(name, transition)` in server.js (validates the vMix input
  exists, AI shield, enabled/connected; returns `{ok, reason}`): game-event auto-switch (`obsSwitch`), RL
  kickoff / scoreboard / post-game and the countdown "then" cut (`rlSwitchScene`), flow `obs_scene` and
  `obs_scene_previous` (vMix previous program tracked as `state.vmix.previousTitle`).
- **Commercial break** cuts to the mapped input and back to `switcherProgramName()`.
- **Replays**: save-replay (button, flow, goal auto-replay, bottom-bar clip) = `ReplayMarkLast` (last 10s as a
  replay event); the replay-buffer toggle = `ReplayStartStopRecording`; replay push-to-program uses `switcherCut`.
- **One moment map for both switchers**: `state.obs.scenes` holds OBS scene names or vMix input titles. The
  broadcast swaps `obs.availableScenes` / `obs.currentScene` for vMix input titles / the program input, so every
  existing scene picker, program highlight and Stream Deck scene key follows vMix with no per-caller change.
- **Setup**: `backend/vmix-place.js`. Overlay card "+" = a named Web Browser input (`AddInput Browser|url`, then
  `SetInputName`; existing = `BrowserNavigate`). "Build show scenes" = NE Scoreboard (`live.html`), NE Graphics
  (`gfx.html`, put on overlay channel 4 = top), NE Casters, NE Replay Player; NE Scoreboard is layered onto the
  input mapped to In Game (`SetMultiViewOverlay 1,NE Scoreboard`). gfx.html's own graphics are never added as
  separate inputs (they would show twice).
- Tests: `test/vmix-place.test.js` (fake vMix), `scripts/e2e-vmix.js` (running app vs a fake vMix on :18088).
- ⚠ Not yet run against a REAL vMix. Function names/arguments to confirm first: `AddInput Browser|url`,
  `ReplayMarkLast`, `ReplayStartStopRecording`, `SetMultiViewOverlay` (vMix 24+ also calls it `SetLayer`).
- Still open: the Switcher page tab is hidden; vMix tiles have no thumbnails; TCP tally (:8099).

## 5. Phased build plan — status as of 2026-07-08 (code-verified, not aspirational)

Phase 1 turned out to deliver more than originally scoped — the switcher abstraction from §4 is
**built**, not just planned:

| Phase | Scope | Status |
|---|---|---|
| **1 — Connect & switch** | `backend/vmix.js` HTTP client + XML poll (1.5s); `state.vmix` + `state.switcher.target`; Settings → vMix section + OBS↔vMix toggle; `set_vmix_settings`/`set_switcher_target`/`vmix_call`/`vmix_test_connection`; Flow vMix actions (vmix_cut/overlay/stream/record/replay/set_text/function). Overlays run as vMix Web Browser inputs. | ✅ **BUILT** |
| **1.5 — Switcher abstraction** | `switcherCut/SetPreview/Take/Stream/Record/Ftb/Replay/AudioSet()` (server.js:7736-7828) dispatch to OBS or vMix per `state.switcher.target`. Switcher page UI (`renderSwitcher()`, app.js:13494+) is genuinely backend-aware — status, source grid, VU-meter mixer all branch on `data.vmix`. Live `vmix-meters` push (~2fps, server.js:7719-7729). | ✅ **BUILT** (not in the original plan — found during a 2026-07-08 code audit) |
| **2 — Route every producer action through the switcher** | See §5a — ~10 call sites still call `obsClient` directly and silently no-op when vMix is active. | ⏳ **NOT STARTED** |
| **3 — Tally & OverlayInput cockpit wiring** | TCP tally (`SUBSCRIBE TALLY`/`ACTS`, port 8099); OverlayInput channels driven by the "Put On Air" cockpit chips, not just manual Flow actions. | ⏳ **NOT STARTED** |
| **4 — Instant replay, PTZ, multiview, vMix preset generator** | Goal-triggered replay marks + camera angles/slow-mo; PTZ presets; PiP layers; a `.vmix`/Web-Browser-input generator (parity with `obs/build-scene-collection.js`). | ⏳ **NOT STARTED** |

### 5a. Phase 2 — close the "silently does nothing on vMix" gap

These call sites bypass the switcher and hit `obsClient` directly — on a vMix setup they no-op with
no error, which is the worst failure mode (looks broken, not obviously OBS-only):

- `startCommercial()` / `endCommercial()` — server.js:7565, 7573 → route through `switcherCut()`.
- WS `case 'obs_save_replay'` — server.js:12759-12777 → add the vMix branch (`switcherReplay()` already
  exists and does this correctly for the Switcher page; this WS case just needs to call it instead of
  `obsClient` directly).
- Replay "push to program" (the REPLAYS page's scene auto-switch) — server.js:12831 → `switcherCut()`.
- Flow action types `obs_scene`, `obs_scene_previous`, `obs_save_replay`, `obs_start_stream`,
  `obs_stop_stream`, `obs_start_record`, `obs_stop_record`, `obs_start_replay_buf`,
  `obs_stop_replay_buf` — server.js:7070-7088, 7298-7315 → route through `switcher*()`. (Flow already
  has separate `vmix_*` action types as a workaround; once these route through the switcher, a Flow
  author no longer has to pick the right action type per backend — `obs_scene` and `vmix_cut` converge,
  and the `vmix_*` types can eventually be deprecated in favor of the OBS-named ones working on both.)
- Automated cuts — `obsSwitch()` (server.js:7657, game-event auto-switch), `obsSwitchSceneName()`
  (server.js:7673, countdown auto-cut), `rlSwitchScene()` (server.js:7854-7867, RL kickoff/post-game),
  `obsAutoReplay()` (server.js:7924-7929, RL-goal auto-replay) — all OBS-only today. Route through the
  switcher too, **and carry the existing `aiShielded()`/`OBS_AUTO_SWITCH_DISABLED` checks with them** —
  these are automation entry points, not producer clicks, so the shield must gate the vMix path exactly
  like it gates OBS today. (The switcher functions themselves — `switcherCut` etc. — correctly have NO
  shield check, because their only current caller, `case 'obs_switch_scene'`, is a manual producer
  action; that's by design, not a gap. The gap is that automated callers don't route through the
  switcher yet, so vMix gets no automation at all right now, shielded or not.)

### 5b. Phase 3 — tally + cockpit overlay wiring

- **TCP tally**: new `backend/vmix-tally.js` (or extend `backend/vmix.js`) — raw `net.Socket` to
  `state.vmix.host:8099`, send `SUBSCRIBE TALLY\r\n` + `SUBSCRIBE ACTS\r\n` on connect, parse the
  push lines, reconnect-with-backoff on drop (mirror the pattern `backend/integrations/obs-client.js`
  already uses for its own reconnect logic). Feed into `state.vmix.tally = { program:[...], preview:[...] }`
  and broadcast only on change (same signature-diff pattern `pollVmix()` already uses, server.js:7708-7716).
- **Cockpit OverlayInput wiring**: the "Put On Air" chips (control panel cockpit) currently only flip
  `state.*.visible` for HTML-overlay scenes (backend-agnostic, since overlays are Browser Sources on
  both backends per §1). Add a per-chip optional `vmixOverlayChannel: 1-4` mapping so that when
  `state.switcher.target === 'vmix'`, toggling the chip ALSO fires `OverlayInput{N}{In|Out}` — giving
  vMix's native down-without-a-scene-change behavior instead of relying purely on the Browser Source's
  own visibility state.

### 5c. Phase 4 — replay/PTZ/multiview/preset-generator

- **Goal-triggered instant replay**: extend `obsAutoReplay()`'s call site (wherever RL goal detection
  fires it) to also call, on the vMix path, `ReplayMarkIn`→`ReplayPlayEventToOutput` with a configurable
  camera-angle (`ReplaySelectChannel{1-8}`) and speed (`ReplayChangeSpeed`) — confirm exact function
  names against the user's vMix version first (they drift v24→v29, per §6).
- **PTZ presets**: new Settings sub-panel (camera list + preset recall), `PTZLoadVirtualInput`/
  `PTZCreatePreset` wired to a new WS handler + Flow action type.
- **Multiview/PiP**: `SetMultiViewOverlay`/`SetLayer`/Fly params, likely surfaced as a "camera layout"
  picker mirroring however OBS-side camera-layout scenes are chosen today (check `control-panel/app.js`'s
  existing camera-layout UI for the pattern to reuse rather than building a parallel one).
- **vMix preset generator**: `obs/build-vmix-preset.js` alongside `obs/build-scene-collection.js` —
  emit an import list (or `.vmix` XML) that adds every overlay HTML page as a Web Browser input, named
  to match the OBS scene-collection's scene names (`switcherCut()` already matches vMix inputs by title
  against the same names, per §2/§4, so a matching preset needs zero extra mapping to work).

**Sequencing**: 5a first — it's pure plumbing (no new vMix functions, just redirecting existing calls
through functions that already exist), closes the worst failure mode, and de-risks everything after it
by proving the switcher pattern end-to-end. 5b and 5c can be built independently of each other once 5a
lands.

---

## 6. Gotchas / notes
- HTTP API is **local by default** (127.0.0.1); remote control needs vMix's Web Controller/API enabled +
  firewall. Same trust model as our OBS localhost assumption.
- Prefer **input GUIDs** over numbers/names in stored mappings — numbers shift when inputs are reordered.
- vMix function/param names vary slightly by version (v24–v29). Pin to the user's version and confirm exact
  Replay/Audio-bus names against the [reference](https://vmixapi.com/) before wiring Phase 3–4.
- vMix is **Windows-only** and paid (HD/4K/Pro tiers gate inputs, replay cameras, NDI). OBS stays the free
  default backend; vMix is the selectable "pro venue" alternative — a producer commits to one per setup.
- **AI-Shield status (corrected 2026-07-08):** manual producer actions (`switcherCut()` and friends,
  fired from `obs_switch_scene`/the Switcher page) intentionally have no shield check — same as a
  producer clicking a scene button in OBS today. The actual gap is narrower: the four *automated*
  cut sources (`obsSwitch`, `obsSwitchSceneName`, `rlSwitchScene`, `obsAutoReplay`) already check
  `aiShielded()`/`OBS_AUTO_SWITCH_DISABLED` but are OBS-only — see §5a. When they're routed through the
  switcher, that check must travel with them so vMix automation can't become a backdoor around the shield.
