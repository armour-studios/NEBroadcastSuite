# NE Broadcast Suite — Architecture & Roadmap

Goal: turn this from a Rocket-League overlay into **business software for running broadcast
productions across many games** (Rocket League, CS2, Super Smash Bros., League of Legends, and
more), used by multiple producers, for our own events and as a paid service for clients — with
**per-client branding**, **sellable sponsor inventory on every overlay**, and automation.

North-star reference: **Lexogrine HUD Manager (lhm.gg)** — multi-game, centralized
teams/players/matches with bracket auto-sync, non-game overlays (veto/countdown/break/post-match),
sponsors baked into the HUD ("Signals Ads"), automations (auto-config install, auto cinematic
observer, auto replay), and a cloud for storing/sharing HUDs + configs.

## Core concepts (the data model we are moving toward)

Separate four things that are currently tangled together:

1. **Game plugin** — `{ id, name, overlays[], themes[], format, schema }`. The `format` describes the
   match shape so the UI/overlays stop assuming blue/orange:
   - `duo` (RL: 2 teams, score), `team5` (CS2/LoL/Val/Dota: 2 teams of 5, rounds/objectives),
     `ffa` / `bracket` (Smash singles), `1v1`. Each format has a **schema** (which fields/controls
     the MAIN panel renders — team count, score type, OT rules, roster size).
2. **Theme** — visual design *within* a game (Classic/Midnight/Neon today). Per-game, already supported.
3. **Brand Kit (Client)** — a reusable identity: `{ name, logos, primary/accent colors, font,
   sponsors[], defaults (theme per game, lower-third style) }`. This is the "NAMELESS ESPORTS" vs
   "FROST ESPORTS" toggle. Switching a brand kit recolors overlays + swaps sponsor sets + logos in one click.
4. **Show / Preset** — a saved production instance binding `game + overlay + theme + brandKit +
   event name + teams/bracket + best-of`. "Load FROST RL Rush" → everything snaps into place.

Today: `GAMES` registry + per-game `themes` ✓; `presets` (event+theme+banner+ticker+casters) ≈ Show
but no brand kit; teams hardcoded `blue/orange`; `banner` image carousel ≈ a basic sponsor rail (RL only).

## Sponsorship as first-class, sellable inventory

Every overlay reserves named **sponsor slots** so we can sell placement per production:
- **Corner bug** (always-on small logo), **rotating partner rail** (lower-third strip),
  **"PRESENTED BY" lockup** (intros/breaks), **full-screen break/standby**, **replay/transition wipe**,
  **post-match stat card footer**. Slots carry a **tier** (presenting / partner / supporter) so a kit
  can drive sizing/rotation weight. Sponsors live on the **Brand Kit**, so selecting a client loads their sold inventory.

## MAIN screen (streamlined live control)

MAIN = the few things a producer touches mid-show, schema-driven per game:
- On-air match (teams/score/best-of), quick score nudges, **on-air toggles** (HUD/break/casters/
  ticker/sponsor rail), active brand kit + overlay/theme selector, live status chips (game API / OBS /
  overlay connected). Everything else (rosters, sponsor management, presets, integrations) lives in
  PRODUCTION / SETTINGS / a new BRANDS tab. Non-2-team games render their own schema (e.g. Smash = bracket slot + 2 entrants; LoL = 5v5 + draft).

## STATS screen (game API tracking, reference)

Per-game data integrations, normalized into our teams/players/matches store for later reference:
- Smash/FGC: **start.gg** (already integrated for RL brackets) — entrants, sets, standings.
- LoL: **Riot LoL Esports / LiveStats API** (or Bayes/GRID) — draft, gold, objectives.
- CS2: **GSI** (already) for live; demo parsing for post-match.
- RL: **Psyonix Stats API** (TCP :49123) — official in-game feed; no BakkesMod/SOS.
Store match results centrally so brackets auto-advance (LHM "every result included") and we can show
season/event stats later.

## Automation (industry standard)

- Auto-install game configs (✓ GSI cfg writer) — extend per game.
- Auto-import rosters/brackets from the game API → fills teams/players.
- Score/scene sync: GSI/API → overlay; optional OBS scene auto-switch on round/goal/replay (✓ partial for RL/OBS).
- Sponsor auto-rotation on a timer (per tier weight).
- Auto cinematic observer / auto replay (later, CS2).

## Multi-producer

Near-term: named **Brand Kits + Shows** are portable config (export/import JSON) so any producer loads a
client's setup. Later (LHM-Cloud-style): a shared store/sync so kits, teams, and shows live server-side
and multiple operators pull the same production.

## Phased roadmap

- **Phase 1 (in progress): Brand Kits + Sponsor model.** Server data model + persistence + WS API;
  `brand` resolved into `full_state`; **sponsor rail rendered on overlays** (start: CS2). ← this commit.
- **Phase 2: Control-panel BRANDS tab** — CRUD brand kits, upload logos/sponsors, set per-game default
  theme, one-click activate; Shows bind a brand kit.
- **Phase 3: Multi-game schema** — generalize state beyond blue/orange; schema-driven MAIN panel;
  add a game plugin (Smash via start.gg or LoL) end-to-end with its overlay.
- **Phase 4: Sponsor slots everywhere** — corner bug / break / replay-wipe / post-match across all overlays; tiers + rotation weights.
- **Phase 5: STATS screen + deeper API automation**; later **cloud/multi-producer sync**.

## Conventions

- Overlays are data-driven: they render from `full_state` (WS :3001) and never hold production config.
- Branding flows one way: Brand Kit → `full_state.brand` → CSS vars + sponsor elements on every overlay.
- Keep each game's overlay self-contained under `overlay/`; shared brand/sponsor logic is duplicated
  minimally per overlay until a shared module is extracted.
