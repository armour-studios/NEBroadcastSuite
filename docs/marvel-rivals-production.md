# Marvel Rivals — Production Package Reference

Verified 2026-07-09 via deep research (official NetEase rulebook PDFs + marvelrivals.com
announcements + Overwolf developer docs, adversarially cross-checked). Use this as the
source of truth for the Marvel Rivals game package; update at season boundaries.

> **Season context:** Season 9.0 "The Mystery of Thebes" launches **2026-07-10** (tomorrow
> relative to research date). Counts below describe the S9.0 launch roster. The Hood
> (hero #53) arrives ~2026-08-07 with S9.5.

---

## 1. Hero roster — 52 heroes at Season 9.0

Role breakdown: **13 Vanguard / 26 Duelist / 12 Strategist / 1 Multi-Role**.

**Deadpool is the game's only Multi-Role hero** — he has separate Vanguard/Duelist/Strategist
variants that ban and balance independently (Season 9 patch notes balance "Deadpool (Vanguard)"
as its own entry). Our hero/role graphics and the draft board need a fourth role category
(or per-variant entries) for him.

Full alphabetical roster (52):

Adam Warlock, Angela, Black Cat, Black Panther, Black Widow, Blade, Bruce Banner (Hulk),
Captain America, Cloak & Dagger, Cyclops, Daredevil, Deadpool, Devil Dinosaur, Doctor Strange,
Elsa Bloodstone, Emma Frost, Gambit, Groot, Hawkeye, Hela, Human Torch, Invisible Woman,
Iron Fist, Iron Man, Jeff the Land Shark, Jubilee, Loki, Luna Snow, Magik, Magneto, Mantis,
Mister Fantastic, Moon Knight, Namor, Peni Parker, Phoenix, Psylocke, Rocket Raccoon, Rogue,
Scarlet Witch, Spider-Man, Squirrel Girl, Star-Lord, Storm, The Punisher, The Thing, Thor,
Ultron, Venom, White Fox, Winter Soldier, Wolverine.

Additions since our original 37-hero asset set (scripts/download-mr-heroes.js):

| Hero | Role | Added | Verified |
|---|---|---|---|
| The Thing | Vanguard | S1.5 (Feb 2025) | high |
| Ultron | Strategist | S2.5 (2025) | high |
| Phoenix | Duelist | S3 (Jul 2025) | high |
| Blade | Duelist | S3.5 (2025) | high |
| Angela | Vanguard | S4 (2025) | high |
| Daredevil | Duelist | S4.5 (2025) | high |
| Rogue | Vanguard | S5 (Dec 2025) | medium |
| Gambit | Duelist | S5 (Dec 2025) | medium |
| Deadpool | Multi-Role | S6 (Jan 2026) | verified (research) |
| Elsa Bloodstone | Duelist | S6.5 (13 Feb 2026, hero #47) | verified (research) |
| White Fox | see note | S7 (Mar 2026) | UNVERIFIED role |
| Black Cat | see note | S7 (Mar 2026) | UNVERIFIED role |
| Devil Dinosaur | Vanguard | S8 (15 May 2026, hero #50) | verified (research) |
| Cyclops | Duelist | S8.5 (12 Jun 2026, hero #51) | verified (research) |
| Jubilee | Strategist | S9.0 (10 Jul 2026, hero #52) | verified (research) |

**Role note:** the verified totals (13/26/12/1) only balance if exactly two of the 2026
additions are Strategists beyond Ultron/Jubilee — role math points at White Fox and
Black Cat, but their roles were not individually verified. Confirm both against
https://www.marvelrivals.com/heroes (the official page enumerates all 52 with roles)
before finalizing the draft-board role grouping.

Upcoming: **The Hood** — hero #53, ~2026-08-07 (S9.5). Role not officially announced
(leaks say Vanguard).

---

## 2. Competitive map pool — 14 maps (Ignite 2026 / Season 7 rulebook)

Verified verbatim from the official Ignite 2026 Preseason & Stage 1 rules PDF; the MRC
rulebook independently confirms the tournament pool **stays in real-time sync with the
Competitive-mode map pool** — treat the pool as data, not constants, and re-check each season.

| Mode | Maps |
|---|---|
| **Domination** (4) | Birnin T'Challa, Hell's Heaven, Krakoa, Celestial Husk |
| **Convoy** (5) | Yggdrasill Path, Spider-Islands, Midtown, Arakko, Museum of Contemplation |
| **Convergence** (5) | Hall of Djalia, Symbiotic Surface, Central Park, Heart of Heaven, Shin-Shibuya |

- **Conquest maps are NOT in competitive rotation** — only Domination/Convoy/Convergence.
- Shin-Shibuya was specifically re-added for the Ignite 2026 Preseason.
- Season 9's new Thebes map may enter rotation — unconfirmed (open question).

### Map selection procedure (drives the veto/map-flow widget)

Map 1 of every series is **always Domination** in both circuits.

- **Ignite:** map 1 + sides (A/B) randomly drawn by the organizer; from map 2 the losing
  team picks from remaining *unused modes* (Convoy/Convergence); modes fully unlock again
  at map 4; no specific map repeats within a match.
- **MRC:** map 1 randomly drawn from the Domination maps; the losing captain picks each
  subsequent map; no repeats until the pool is exhausted; attack/defend sides randomly
  assigned at the start and **never swapped** within a series.

The circuits differ slightly → the veto widget should support both variants
(backend/veto.js format entry for marvel-rivals).

---

## 3. Live game-state integration

### Overwolf Game Events Provider (GEP) — the only documented programmatic source

Officially supports Marvel Rivals
(https://dev.overwolf.com/ow-native/live-game-data-gep/supported-games/marvel-rivals/).

**Events:** `match_start`, `match_end`, `round_start`, `round_end`, `kill`, `death`,
`assist`, `kill_feed` (attacker + victim, all players).

**Info updates:**
- `roster_0..11` — per-player: name, UID, character_id/character_name, team, K/D/A,
  ult_charge, is_alive (this is exactly the shape our `POST /api/mr-gep` roster expects)
- `banned_characters` — hero bans (character_id/name/is_teammate)
- `selected_character` (info update, NOT a dedicated event)
- `player_stats` — damage dealt/blocked, accuracy, healing
- `objective_progress` — per Convoy/Convergence/Domination
- `ability_cooldown_X` + `additional_ability_cd_X` (team-ups)
- `match_id`, `game_type`, `game_mode`, `map`, `match_outcome`, `scene`

**Caveats for broadcast use:**
- GEP reads the **local running client** — kill/death/assist are local-player-perspective.
  We must instrument a PC that is *in the room* (player or observer seat).
- `ult_charge` is **teammates-only** (NetEase competitive-integrity policy) — one
  instrumented client cannot show both teams' ult charge. Two clients (one per team,
  e.g. coach seats) would be needed for full ult tracking.
- Player names hidden pre-round in Diamond 3+ lobbies.
- NetEase compliance rules restrict *displaying* some data (opponent damage/heal,
  ult prediction) — check the compliance page before adding stats to overlays.
- **Open question:** whether GEP works from a Tournament Room spectator/coach slot vs
  only as an active player — must be tested; it determines if a neutral observer seat
  can feed our overlay.

### What does NOT exist
- **No official NetEase spectator/broadcast API.** marvelrivals.com/heroes_data is a
  client-rendered JS shell (no fetchable JSON in the HTML).
- In-client Tournament Room spectating for neutral observers runs at a **~40-second
  delay**; only coaches get low-latency view, restricted to their own team.
- Official MRC/Ignite broadcasts appear to observe via privileged in-room clients;
  no third-party tooling has been published.

### Secondary data source
**MarvelRivalsAPI.com** — unofficial REST API: heroes, maps, player stats/match history,
seasons, patch data. Zero live/event endpoints → useful for pre-produced stats graphics
(player cards, H2H), not live automation. Reliability unvetted (likely scrapes NetEase's
backend; could break anytime).

---

## 4. Esports formats (for series scoreboard / rundown / bracket tooling)

- **Team size:** 6v6 (12 players in room). Faction needs ≥6 eligible players; larger
  rosters pick a lineup per match.
- **Terminology (matters for graphics copy):** a "Match" = one map; a "Round" = the
  BO3/BO5/BO7 series.
- **Series lengths:** BO1/BO3/BO5/BO7 (BO9 available in Tournament Room).
  - **Ignite 2026 Preseason:** BO3 round-robin groups → BO5 double-elim playoffs → BO7
    grand final. (Stage 1 specifics unconfirmed — a composite claim about it was refuted.)
  - **MRC S6:** BO1 open + closed qualifiers; BO3 rounds 1–9; BO5 rounds 10–14 and lower
    bracket finals; BO7 grand finals; 15-minute break between maps.

### Hero pick/ban (draft board)
Runs in the in-game **Tournament Room** custom lobby:
- **Tournament (Advanced)** — used for all Ignite matches: pre-round phase, each team bans
  up to 3 heroes and locks 2; pause permission organizer-only.
- **Tournament (Basic)** — fixed 10-step alternating captain order:
  `A ban → B ban → B pick → A pick → A ban → B ban → B pick → A pick → A ban → B ban`
  (3 bans + 2 locks per team; a "lock" protects a hero from being banned).
- **MRC per-map draft:** 10-step `ban-ban-lock-lock-ban-ban-lock-lock-ban-ban` — up to
  **6 heroes banned per map**; locked heroes can't subsequently be banned; in BO3+ the
  winner of the previous map bans first on the next map.
- Ranked (S7+) also has 3 bans per team, aligned with tournament format.

Our current `state.mrMatch.bansByMap` models 4 bans/team — **should be up to 3 bans + 2
locks per team (6 total bans per map)** with the lock concept added.

---

## 5. Gap analysis vs current code (as of 2026-07-09)

| Area | Current | Needed |
|---|---|---|
| Hero assets | 37 avatars (scripts/download-mr-heroes.js) | +15 heroes (see §1); Deadpool multi-role handling |
| Veto pool (backend/veto.js) | 8 approximate/wrong names | Verified 14-map pool with modes (§2) |
| Veto format | plain map ban | Loser-picks flow, map-1-always-Domination, Ignite vs MRC variants |
| mrMatch bans | 4 bans/team per map | 3 bans + 2 locks per team (6 banned/map), winner-bans-first |
| GEP ingest (`/api/mr-gep`) | DONE 2026-07-11: full GEP schema (objective_progress, player_stats, kill_feed ring, match_id/scene), auto game-mode, mr_* Flow triggers | Live-test on a real match (needs app relaunch to load the new handler) |
| Overlay (marvel-rivals.html) | series scoreboard + roster demo | Wire live GEP roster; role-colored hero chips incl. Multi-Role |
| Draft board | generic `draft` feature | 10-step ban/lock sequence renderer |

### Suggested build order
1. ~~Data refresh: hero list + veto pool → registry/veto/scripts.~~ DONE 2026-07-09.
2. ~~Overwolf companion app that subscribes to GEP and POSTs to `/api/mr-gep`.~~ DONE
   2026-07-11 — `companion-overwolf/` is now dual-game (Overwatch 10844 → /api/ow-gep,
   Marvel Rivals 24890 → /api/mr-gep; features: gep_internal + match_info + game_info).
   Bans are cleared on `match_end` only (they're drafted pre-map, before match_start).
   STILL TODO: live-test from a Tournament Room coach/spectator slot (open question §3).
3. ~~Extend `/api/mr-gep` schema: kill_feed, objective_progress, player_stats.~~ DONE
   2026-07-11 — also emits `mr_match_start/round_start/round_end/match_end` Flow triggers
   and auto-sets `state.mrMatch.gameMode` from GEP mode strings; kill feed kept as a
   12-entry ring on `gepData.killFeed`. Both handler and companion covered by scratchpad
   harnesses (17 + 16 assertions).
4. Draft/ban board overlay implementing the 10-step ban/lock order (both Basic + MRC);
   restructure `mrMatch.bansByMap` from 4 bans/team to 3 bans + 2 locks per team.
5. Scene automation hooks: wire the new `mr_*` Flow triggers to OBS scene switches
   (mirror the RL kickoff pattern; opt-in toggle per feedback rules).
6. Overlay upgrades: kill-feed strip + objective progress bar on marvel-rivals.html
   fed from `gepData.killFeed` / `gepData.objective_progress`.

### Sources (primary)
- Ignite 2026 rules: marvelrivals.com/Marvel_Rivals_Ignite_2026_Rules_Preseason_&_Stage1_2026.3.13_V1.0.pdf
- MRC S6 rules v1.6 / S7 rules v1.7 PDFs (marvelrivals.com)
- Ignite 2026 Preseason announcement: marvelrivals.com/announcements/20260323/40955_1292438.html
- Tournament Room guide: marvelrivals.com/news/20250701/42745_1229373.html
- Overwolf GEP: dev.overwolf.com/ow-native/live-game-data-gep/supported-games/marvel-rivals/
