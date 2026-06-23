# AI Auto-Director — Design Plan (multi-game)

A game-agnostic "auto-director" that watches each game's live state, detects
broadcast-worthy moments, and surfaces ranked **"who/what to watch + why"**
suggestions to the producer. Suggestions-only in v1 (no game control); an
optional input-bridge for true auto-switching is a later, opt-in phase.

Scope: **all games**, starting with the two that already have live feeds —
**CS2** (GSI) and **Rocket League** (official Stats API, TCP :49123) — then the rest of
the 15-game registry via a thin adapter each.

---

## 1. Why this is feasible now

`server.js` is already the central hub and receives full real-time state for both games:

- **CS2** → `handleGsi(payload)` → `state.csgo` (players w/ positions when
  observing, bomb, round, economy). Push model, ~10 Hz.
- **Rocket League** → Stats API TCP `:49123` → `handleRLEvent`
  (`UpdateState`, `GoalScored`, `ClockUpdatedSeconds`, `Replay*`, `Match*`).
  UpdateState carries per-player stats/boost; spectated target when exposed.

Everything is broadcast to overlays/control-panel over **WS 3001** via
`broadcastFullState()` + per-game updates. The director plugs into this exact path.

**Hard constraint (unchanged):** these feeds are one-way (game → us). v1 only
*suggests*; it never moves a camera. (See Phase 4 for the optional bridge.)

---

## 2. Architecture

```
 game feeds ──► per-game ADAPTER ──► common EVENT MODEL ──► DIRECTOR CORE ──► SUGGESTION
 (GSI / RL)     (extract + resolve   {type,target,priority,   (rank, decay,    {primary,
                 watch target)        reason, gameTime, ttl}    dwell, cooldown) alternates, feed}
                                                                                      │
                                                                          broadcast (WS) ─► Control-panel Director panel
```

- **Director Core** (game-agnostic): scoring, dwell, cooldown, storyline weighting, learning.
- **Per-game adapters**: CS2, RL, and generic (series/spotlight) for other registry games.
- **Learning**: producer Accept/Lock/Override feedback adjusts event weights over time.

---

## 3. Live feeds

### CS2 (GSI adapter)
Diff `state.csgo.players` + bomb/round — aces, clutches, bomb plant/defuse, lurks, economy.

### Rocket League (Stats API adapter)
TCP JSON events from Psyonix Stats API (port 49123). No BakkesMod/SOS required.
Goals, saves, shots, demos, OT, kickoff from `UpdateState` diffs + discrete events.

### Other games
Generic adapter uses series, spotlight, match point until a dedicated feed exists.
Gate with `director` feature flag in `GAMES` registry.

---

## 4. Clips & montages

- Auto-capture from OBS replay buffer on director moments
- Clip library with trim in/out
- Montage templates: Highlights, BRB, Post-Game
- Background ffmpeg encode (low CPU, system tray progress)

---

## 5. Phasing

- **Phase 1 — Core + CS2 + UI** ✓
- **Phase 2 — RL Stats API adapter** ✓
- **Phase 3 — Adapter SDK + generic games** ✓ (in progress)
- **Phase 4 (opt-in) — Auto-switch bridge** — CS2 observer slot keys only; RL read-only