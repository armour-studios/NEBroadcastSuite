# NE Broadcast Suite — AI Producer / Director Architecture (research draft)

**Status:** research draft v1 · **Author:** Armour Studios · **Audience:** us + Nameless backend
**Goal:** evolve the Production → **Director** tab into a full **AI producer/director** that (a) recommends camera cuts, scene changes, and clips to the producer, (b) learns each producer's style, and (c) trains shared per-game models from the accept/decline signal, with video + audio + tags streamed to a central server.

---

## 0. TL;DR — the reframe

We are **not** building an AI from scratch. The app already contains the skeleton of one:

- **`backend/director/`** — a live director engine: a shared `core.js` scorer + **per-game adapters** (`adapters/cs2.js`, `rl.js`, `generic.js`) that emit normalized events, plus `learning.js`, an online weight store (`global / byGame / byPlayer`) persisted to `director-learning.json`.
- A working **feedback loop**: producer **Accept / Override / Lock** → `director_feedback` → `recordFeedback()` adjusts weights. **This is already a labeling mechanism.**
- **Auto-clipping** runs off the *same* event stream (`onDirectorEvents` → `triggerClipCapture`), and a background ffmpeg **montage encoder** exists.
- A **stats DB** (`backend/db/stats.js` + `sqlite-store.js`) already carries cloud-ready columns (`uid · workspace_id · owner_id · created_at · updated_at · rev · deleted_at`).
- A **cloud contract** (`docs/cloud-backend-contract.md`) with auth + workspace/role seams — today auth+profile-sync only; the AI pipeline is a **net-new section** of it.

So the program of work is four moves:

1. **Capture** the decisions the producer already makes (accept/decline/override/lock, keep/cut a clip, manual scene switch) as **labeled examples**, each stamped with the **game + scene + OBS + score context** at that instant.
2. **Ship** those examples (and, later, the A/V) to a **central training server**.
3. **Graduate** the hand-tuned per-game adapter weights into **trained models** — one shared backbone, per-game feature heads (your "one model, different game params" instinct, exactly).
4. **Personalize** per producer, and walk autonomy up from *shadow → assist → auto*.

Your "one model but different game params" idea is already the code's shape: shared `core.js` + per-game `adapters/*`. The ML version keeps that shape.

---

## 1. Two planes: control plane vs data plane

Separate the cheap-but-essential signal from the expensive-but-optional media. This is the single most important architectural decision.

```
                         PRODUCER MACHINE (Electron, server.js in main process)
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │  CONTROL PLANE  (small, structured, always-on)                                │
  │   game events (RL StatsAPI / CS2 GSI / Valorant / generic)                    │
  │   + live state snapshot (score, clock, players, active scene)                 │
  │   + OBS telemetry (current scene, recording, replay-buffer)                   │
  │   + director recommendations                                                  │
  │   + PRODUCER DECISIONS (accept/decline/override/lock, clip keep/cut, switch)  │
  │        │                                                                       │
  │        ▼                                                                       │
  │   Telemetry recorder  →  local JSONL decision log  →  batched HTTPS upload     │
  │                                                                                │
  │  DATA PLANE  (heavy, optional, phased-in)                                      │
  │   program A/V (+ ISO cams / game capture)  →  mediasoup SFU  →  cloud recorder │
  │   clip files (already produced)            →  segment upload                   │
  └──────────────────────────────────────────────────────────────────────────────┘
        │ control plane (KB/s)                         │ data plane (MB/s)
        ▼                                              ▼
  ┌───────────────────────────────────────────────────────────────────────────────┐
  │  CENTRAL SERVER (Nameless)                                                      │
  │   /api/telemetry   → decision/event store (time-series)                        │
  │   mediasoup recorder → object storage (A/V segments) + manifest                │
  │   dataset builder  → joins decisions ⨝ A/V ⨝ outcomes → labeled examples       │
  │   training jobs    → per-game heads on shared backbone + per-producer adapters │
  │   model registry   → versioned models, A/B + canary                            │
  │   /api/models/:game → client pulls the latest model for inference              │
  └───────────────────────────────────────────────────────────────────────────────┘
```

**Why split them:** the control plane is a few KB/s of structured JSON and **trains the director + clip-trigger models on its own**. The data plane (mediasoup A/V) is MB/s, has storage/egress cost, and consent/IP weight. You get a working learning loop from the control plane **before** standing up any media infra. Don't block the AI on mediasoup.

---

## 2. The atomic unit: a **Decision Record**

Everything the AI learns from is a *decision the producer made, plus the context at that instant, plus the outcome*. Two record types share a common envelope.

### 2.1 Common envelope (the "tick context")
Assembled today from: director events (`backend/director/events.js`, `ts = Date.now()`), `buildLiveState()` (`server.js:~1680`), `state.obs.currentScene`, and the stats match/game IDs (`statsCurrentMatchId` etc.).

```jsonc
{
  "v": 1,
  "ts": 1750000000000,                 // server Date.now() — the join key
  "sessionId": "uuid",                 // one per app launch (NEW: mint at engine init)
  "producerId": "discordUserId",       // from cloud session (privacy-scoped)
  "workspaceId": "wid",                // from cloud session
  "game": "rocket-league",
  "matchId": 123, "gameId": 456,       // links to stats DB (sqlite-store.js)

  "context": {
    "score": { "a": 2, "b": 1 },
    "clock": { "seconds": 124, "isOT": false, "phase": "combat", "round": 14 },
    "players": [ { "id": "steam_…", "name": "…", "alive": true, "hp": 60, "stat": {…} } ],
    "spectated": "steam_…",            // current observed/spectated entity
    "scene": "In Game",                // state.obs.currentScene (PROGRAM = on air)
    "recording": true, "replayBuffer": true,
    "storyline": { "matchPoint": false, "comeback": true } // storyline.js context
  }
}
```

### 2.2 `DirectorDecision` (camera / scene)
```jsonc
{
  "...envelope": "…",
  "kind": "director_decision",
  "recommendation": {                  // what the engine proposed
    "target": { "kind": "player", "id": "steam_…", "name": "…" },
    "type": "clutch", "confidence": 87, "reason": "1v2 clutch",
    "alternates": [ { "id": "…", "type": "lurk", "confidence": 61 } ]
  },
  "decision": "accept",                // accept | override | lock | ignore(timeout)
  "chosen": { "kind": "player", "id": "steam_…" }, // what the producer actually took
  "note": "great read, hold for the defuse",        // optional free-text (NEW)
  "latencyMs": 1400                    // time from rec shown → decision (a quality signal)
}
```

### 2.3 `ClipDecision` (auto-clip / replay)
```jsonc
{
  "...envelope": "…",
  "kind": "clip_decision",
  "clipId": "clip_…",
  "trigger": { "type": "goal", "targetId": "id_…", "confidence": 95 },
  "decision": "keep",                  // keep | reject | edit
  "trim": { "in": 1.2, "out": 9.8, "editedByHuman": true }, // editor edits = labels
  "tags": ["overtime", "double-touch", "team-blue"],         // NEW: editor tags
  "note": "use in the post-game montage",                    // NEW
  "playedToAir": true                  // did it actually go to program? (outcome signal)
}
```

**The label is the `decision` field.** The features are the envelope + trigger/recommendation. This is a supervised dataset the moment we start writing it.

### 2.4 What's missing today (the gap to close)
- **No session/producer stamping** on events → add `sessionId` at engine init (`server.js:~10512`) and `producerId` from the cloud session.
- **Clips don't record keep/reject, trim-edits, score/clock-at-clip, or `eventTargetId`** → extend the clip object (`backend/clips/clip-manager.js`) and link `recordFeedback(accepted)` back to the clip by `{game,type,targetId,ts}`.
- **No tags / notes / timeline markers** in the editor → add `tags[] / note / markers[]` to the clip and the `clip_update` handler (`server.js:~8187`).
- **No unified clock** — each feed (RL TCP, CS2 GSI, OBS WS) is async on its own clock. We don't need a perfect clock; we need **one server-side `ts` per record** and to **debounce ~250–300 ms** so events/state/scene from "the same moment" land in one record.

---

## 3. mediasoup — what it's for and **when** to add it

mediasoup is a WebRTC **SFU** (selective forwarding unit). In this design it is the **data-plane transport**: it carries program A/V (and, later, ISO cameras / game capture / talent VDO feeds) from the producer machine to a cloud **recorder**, alongside a **WebRTC DataChannel** carrying the control-plane stream so A/V and signals share one clock.

**What it buys us (eventually):**
- Cloud-side **content features** for the clip model (vision: did the goal actually look good? audio: caster excitement / crowd pop).
- A path to a **live cloud director** (remote inference, remote producer, multi-feed).
- Synchronized multi-feed capture for human labeling.

**Why not first:** it's MB/s with storage + egress cost, needs TURN/STUN + a recording worker (e.g. GStreamer/libmediasoup → segmented MP4/HLS in object storage), and raises consent/IP issues (talent, players, third-party tournament footage). **None of it is required to train the director or clip-trigger models**, which learn from the control plane.

**Recommended sequencing for the data plane:**
1. **Bootstrap with what we already make:** the app already writes **clip files** + a `description`. Upload those **segments** (not a live pipe) with their `ClipDecision` metadata. That gives the clip model real video to learn from at near-zero new infra.
2. **Add mediasoup** when we want (a) live cloud features/inference, (b) the program feed for moment-level training, or (c) remote production. Stand up: browser/native producer → mediasoup `Producer` (video+audio+data) → SFU → recording consumer → object storage; the DataChannel mirrors `/api/telemetry` so A/V and decisions are co-timestamped.
3. **Privacy switch:** every workspace gets **telemetry-only** vs **telemetry+A/V**; A/V requires explicit talent/player consent capture.

> Net: design the data plane around mediasoup, but **ship the control-plane learning loop first**. mediasoup is phase 3+, not phase 1.

---

## 4. Model strategy — "one model, per-game params"

Your instinct is right and matches the existing code (shared `core.js` + per-game `adapters/*`). The ML version:

### 4.1 Shape: shared backbone + per-game feature heads + per-producer adapter
```
   normalized event/state window
            │
   ┌────────▼─────────┐     game id ──► selects per-game feature encoder
   │ per-game encoder │◄────────────────  (cs2 / rl / generic …) — mirrors adapters/*
   └────────┬─────────┘
            │ features
   ┌────────▼─────────┐     producerId ──► per-producer style embedding / LoRA adapter
   │ shared backbone  │◄────────────────  (personalization)
   └───┬──────────┬───┘
       │          │
   director     clip head
   head (rank   (P(clip-worthy),
   targets +    suggested in/out)
   P(cut))
```

One base model, **conditioned on game** (a learned game embedding + the per-game feature encoder) and **conditioned on producer** (a style embedding). Two task heads share the backbone because they consume the same context:
- **Director head:** rank candidate targets/cameras + P(switch now). Labels: accept/override/lock + the chosen target.
- **Clip head:** P(this moment is clip-worthy) + suggested trim. Labels: keep/reject + human trim edits + played-to-air.

### 4.2 Model *class* — start simple, earn complexity (data efficiency matters)
You will be **data-starved early**, so do **not** open with deep nets or video models.

| Stage | Model | Why | Trains on |
|---|---|---|---|
| **0 (today)** | Hand-tuned weights (`learning.js`) | Already shipping | online accept/decline deltas |
| **1** | **Gradient-boosted trees / logistic ranker** on engineered features | The adapters already produce excellent features; GBT is data-efficient, interpretable, trains on hundreds of examples, and will beat the hand weights fast | `DirectorDecision` / `ClipDecision` tables |
| **2** | **Small temporal model** (GRU / tiny Transformer over the event window) | Captures sequence/momentum the per-tick scorer misses | sequences of records per match |
| **3** | **Multimodal** (add vision/audio features from mediasoup A/V) | "Did the play *look/sound* great?" | A/V segments ⨝ decisions |

Per-game heads + a shared backbone throughout. Personalization = a per-producer embedding (Stage 1: producer one-hot / per-producer GBT; Stage 2+: learned embedding or LoRA-style adapter so it's **one base model + small per-producer deltas**, not N full models).

### 4.3 Auto-clip & replay "per game"
Same backbone, the **clip head** conditioned on game. Per-game differences live in the feature encoder + the candidate event types (already enumerated in `adapters/*`: RL `goal/save/demo/overtime…`, CS2 `ace/clutch/defuse…`). One model, game param — exactly your plan.

---

## 5. The training-stage UX (the human-in-the-loop)

The Director tab becomes a **recommendation surface** the producer reacts to; every reaction is a labeled example. Autonomy ramps per producer/workspace:

1. **Shadow (telemetry only):** engine recommends; producer works normally; we log recommendation vs what they actually did. Zero risk, pure data. (Auto-switch already defaults off — `OBS_AUTO_SWITCH_DISABLED`.)
2. **Assist:** explicit **Accept / Decline / Note** on each recommendation (Accept/Override/Lock already exist — add **Decline** and an optional **Note** field). Clip prompts get **Keep / Cut / Tag**.
3. **Auto (guard-railed):** model auto-acts above a confidence threshold; producer can veto; vetoes are high-value negatives. Gate per game/scene, with cooldowns (already in `core.js`).

Crucial additions for labeling quality:
- An explicit **Decline** button (today "reject" is only implicit by ignoring) — implicit ignores are weak labels; explicit declines are gold.
- An optional **Note** on any decision (director or clip) → free-text that becomes searchable rationale and, later, weak supervision.
- **Decision latency** (time rec-shown → action) captured automatically as a confidence proxy.

---

## 6. Tags & notes in the video editor (training labels for the clip model)

The editor (`overlay/replay-player.html`, Replays page) has trim in/out, program/preview buses, and one `description` field — but **no tags, no markers, and clips aren't aligned to game-event time**. Add:

- **`clip.tags: string[]`** — controlled vocab + free tags (chips UI after `rp-desc`). Seed the vocab from event types per game so tags aggregate cleanly.
- **`clip.note: string`** — promote the existing `description`.
- **`clip.markers: [{ videoTime, gameTime, label }]`** — timeline cue-points (the "mark the goal frame" signal); strong labels for trim/highlight learning.
- **Game-event alignment:** stamp `clip.gameEventId / gameEventTime / scoreAtEvent / clockAtEvent / eventTargetId` at capture (the data exists in `buildCaptureMetaFromEvent`, just not persisted). This is what lets a clip become a labeled training example instead of an orphan file.
- **`/api/clips/export`** — emit JSONL of `{clip + tags + markers + trigger + decision}` for dataset builds.

Wire-up points: `backend/clips/clip-manager.js` (schema + `updateClip`), `clip_update` handler (`server.js:~8187`), editor UI (`control-panel/index.html:~2269`).

---

## 7. Central server — new contract section (extends `cloud-backend-contract.md`)

Reuse the existing auth/session/workspace/role model. Add:

| Method & path | Purpose | Notes |
|---|---|---|
| `POST /api/telemetry/batch` | Ingest a batch of Decision Records (control plane) | Bearer; dedupe by `(sessionId, ts, kind)`; size-capped; `429` + `Retry-After` |
| `POST /api/telemetry/clip` | Upload a clip segment + its `ClipDecision` | multipart or signed-URL to object storage |
| `POST /api/media/session` | Open a mediasoup ingest session (phase 3) | returns SFU transport params; consent flags required |
| `GET  /api/models/:game` | Pull latest model (+ per-producer adapter) for local inference | versioned; ETag; canary/A-B assignment in response |
| `POST /api/models/:game/outcome` | Report online outcome (accept rate, vetoes) of a deployed model | closes the loop for canary promotion |
| `GET  /api/director/insights` | Per-producer / per-game accuracy + drift dashboards | mirrors `learning.stats` server-side |

Security/governance (extends contract §6): scope every row by `workspaceId` from the token; **A/V requires explicit consent records** (talent, players); **data ownership stays with the workspace** (export + delete); telemetry-only mode is the default. Validate record `v` (schema version) and size-cap.

---

## 8. Privacy, consent, cost, IP (do not skip)

- **Consent:** talent and players appear in A/V. Capture per-person consent (the VDO/talent rooms already identify people). Third-party tournament footage may not be ours to retain — gate A/V by event ownership.
- **Data ownership / multi-tenant:** the `workspace_id / owner_id / deleted_at` columns already exist; honor them end-to-end. Per-workspace export + hard delete.
- **PII minimization:** the control plane can train on **pseudonymous** player IDs and structured features without A/V. Default to telemetry-only.
- **Cost:** control plane is cheap (KB/s, structured). A/V is the cost driver (storage + egress + recorder compute). Phase it; sample it (e.g., only upload A/V around clipped moments, not 24/7).
- **On-device first:** keep inference local (pull model, run in `backend/director/`), upload only decisions. Cloud is for training + aggregation, not a live dependency (matches the "additive and dormant until configured" stance of the cloud contract).

---

## 9. Phased build plan (grounded in current files)

**Phase 0 — Decision logging (no cloud, no A/V) — ✅ BUILT (2026-06)**
- `backend/telemetry/recorder.js` — `createTelemetryRecorder({dataDir, appVersion, getContext, getIdentity})`
  appends Decision Records to `userData/data/telemetry/decisions-YYYYMMDD.jsonl` (async, buffered ~1.5 s).
  Stable `install-id` fallback when not cloud-authed; `producerId` prefers `cloud.getSession().user.discordId`.
- `server.js`: `telemetry` singleton minted at engine init with a per-launch `sessionId`; `buildTelemetryContext()`
  (lightweight — score/clock/scene/spectated, **no blobs**); `currentDirectorRec()` + `recordDirectorDecision()`.
  Hooks tapped: `director_feedback` / `director_accept` / `director_feed_action(train)` → `director_decision`
  (accept/override/lock/decline, with note + latency); `onPrimaryChange` → `recommendation` (shadow stream,
  de-duped by target); `onDirectorEvents` auto-clip → `clip_decision('auto')`; `clip_update` → `clip_decision('edit')`;
  OBS `onSceneChange` → `scene_change`.
- UI: explicit **Decline** button + optional **Note** field on the Director panel (`index.html:~2100`, `app.js:~16081`).
  Accept/Decline/Lock now send `director_feedback` with the note; `_directorTakeNote()` clears it after.
- **Outcome:** a real labeled dataset accumulates locally from the first broadcast. **Next:** Phase 1 (clip tags/markers/event-alignment) and the `/api/telemetry/*` uploader.

**Phase 1 — Tags/notes/alignment in clips + editor — ✅ MOSTLY BUILT (2026-06)**
- Clip schema (`backend/clips/clip-manager.js`) extended: `tags[] / markers[] / note / eventTargetId /
  gameEventTime / gameClock / scoreAtEvent`. `updateClip` validates tags (lowercased, ≤24) + markers.
- Capture-time alignment: `buildCaptureMetaFromEvent` now stamps `eventTargetId / gameClock / scoreAtEvent`
  (from `buildTelemetryContext`) onto every auto-clip — the clip is tied to the exact game moment.
- Editor UI: **tag chips** (`#rp-tags` + `#rp-tag-input`, Enter/comma to add) in the Replays editor;
  `clip_update` now sends `tags` + `note`. Telemetry already logs `clip_decision('edit')` with the tags.
- **Still TODO:** timeline **markers** UI (data model ready), and `/api/clips/export` (dataset dump).
- **Outcome:** clip decisions are labeled examples with content + game context + producer tags.

**Safety — AI Shield + AI page (built 2026-06, alongside Phase 0/1)**
- **Shield** = a master kill-switch (`state.ai.shield`, persisted). `aiShielded()` gates **every** auto-action:
  director auto-switch, auto-clipping (`onDirectorEvents`), OBS auto-switch (`obsSwitch`/`obsSwitchSceneName`),
  auto-replay (`obsAutoReplay`). Recommendations still display; nothing acts. Reversible — toggles are kept.
  WS: `set_ai_shield {on}` (logs a `mark:shield` telemetry record). **Use this if an automation misbehaves live.**
- **AI sidebar page** (robot icon, `tab-ai`): the Shield panic button (calm green → armed red) + quick
  Auto-Director (enable/sensitivity/auto-switch), Auto-Clipping (capture mode), and Training (telemetry
  on/off via `set_telemetry {enabled}`, `state.ai.telemetry.enabled`). All mirror existing WS messages.

**Phase 2 — Central ingest + first trained models**
- Implement `/api/telemetry/*` on Nameless; client uploads batches (reuse `backend/cloud/cloud-client.js`).
- Train **Stage-1 GBT** director + clip heads per game; serve via `/api/models/:game`; run **shadow** (log model vs producer) — don't act yet.
- **Outcome:** model that measurably out-predicts the hand weights, evaluated offline + in shadow.

**Phase 3 — Assisted autonomy + per-producer personalization**
- Promote shadow → assist (model drives recommendations; producer accept/decline). Per-producer adapter. Canary/A-B via the model registry.
- **Outcome:** the Director tab is an AI assistant; vetoes keep improving it.

**Phase 4 — Data plane (mediasoup) + multimodal**
- mediasoup ingest + cloud recorder; A/V-segment upload around clipped moments; Stage-3 multimodal features.
- **Outcome:** richer clip/director models; path to live cloud director / remote production.

---

## 10. Decisions (resolved 2026-06)

1. **Personalization = per-producer "auto-director profile", shareable to a team.** Each producer
   owns a personal profile (style adapter). A producer can **make a team in the app and share their
   profile** to teammates; a producer who is in a team can still **choose to use their own profile**
   instead of the team's. So the resolution order at inference is: *producer's explicit choice → their
   own profile → the team/workspace shared profile → the per-game base model.* (Model-wise: shared
   per-game base + a small per-producer adapter; the "team profile" is just a producer adapter marked
   shareable within a workspace, reusing the profile-sync share scopes in the cloud contract.)
2. **A/V = full program feed.** The data plane captures the **full program output** (not just
   segments) once mediasoup is in (Phase 4). Until then, control-plane telemetry trains the models;
   plan storage/egress for continuous program A/V + a privacy/consent gate per workspace.
3. **Cross-workspace per-game base = YES (recommended).** Shared **per-game base models learn across
   all workspaces** (more data → better base); **per-producer/team profiles stay private** to their
   workspace. Needs a clear data-governance line: base learns from pooled, pseudonymous signals;
   personal style never leaves the workspace.
4. *(still open)* Autonomy ceiling (assistive vs true auto-director), training host + A/V bucket,
   and the talent/player consent-capture mechanism for the full program feed.

---

### Appendix — key extension points (file:line)
- Director engine init (add session/producer id): `server.js:~10512`; engine `backend/director/index.js`.
- Feedback capture: `director_feedback` / `director_accept` — `server.js:~8030–8095`; `recordFeedback()` — `backend/director/learning.js`.
- Event stream / auto-clip tee: `onDirectorEvents()` — `server.js:~3330`; `triggerClipCapture()` — `server.js:~3307`.
- Clip schema + update: `backend/clips/clip-manager.js`; `clip_update` — `server.js:~8187`.
- Live state snapshot: `buildLiveState()` — `server.js:~1680`.
- OBS scene telemetry: `onSceneChange` — `server.js:~4164`; `state.obs.currentScene`.
- Stats DB (IDs + cloud columns): `backend/db/stats.js`, `backend/db/sqlite-store.js`.
- Cloud client (reuse for uploads): `backend/cloud/cloud-client.js`; contract: `docs/cloud-backend-contract.md`.
- Editor (tags/notes/markers): `control-panel/index.html:~2269`, `app.js` (`loadClipPreview`, `clip_update`), `overlay/replay-player.html`.
