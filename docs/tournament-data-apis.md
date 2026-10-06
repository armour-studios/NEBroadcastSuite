# Tournament & game APIs: what we can pull, and what it's worth

Scope: every external API that can feed a **top 8 / placement graphic, a bracket, a scoreboard or a
player card** in this suite — what is already wired, what is worth adding next, and what looks
attractive but is a dead end. Written after adding full Challonge multi-game support and the
Brawlhalla integration (2026-09-20).

---

## 0. The rule that decides everything

A **top 8 graphic states a fact**: "this is how the event finished". Only two kinds of source can
back that claim:

1. A platform that publishes a **real placement per entrant** — `final_rank` (Challonge),
   `standing.placement` (start.gg). These carry the ties a bracket actually produces (1, 2, 3, 4,
   5, 5, 7, 7) and fill in progressively as players are eliminated.
2. A **producer typing it in**.

Everything else — set wins, points, "sorted by score" — is an *inference*. An elimination bracket
sorted by set wins has no 5/5 or 7/7 ties and will happily rank a losers-run runner-up above the
champion. That is why `challongePlacements()` / `fetchEventPlacements()` are separate from the
standings builders, and why the Top 8 builder in the control panel refuses to call an inference a
placement.

Second rule: **a wrong game id is worse than no game id.** Every platform hands the game over as
free text, and resolving it wrong silently swaps the overlay, team labels and roster size out from
under the producer. `backend/game-match.js` returns `''` rather than guessing.

---

## 1. Bracket & placement sources (these fill a top 8)

| Source | Status | Placements? | Auth | Quota | Multi-game |
|---|---|---|---|---|---|
| **start.gg** | wired | yes (`standings`) | personal access token | 80 req / 60s, 1000 objects / req | yes (`videogame.name`) |
| **Challonge** | wired (v1) | yes (`final_rank`) | v1 API key, or OAuth on v2.1 | **500 req / month on the free plan** | yes (`game_name`) |
| **Challengermode** | wired (GraphQL) | yes, with TIE RANGES | bot token from a refresh key | cost-weighted, no request cap published | yes (`gameTitle.slug`) |
| **FACEIT** | wired | partial | Data API v4 key | generous | yes |
| **NXGEN** | wired | via bracket | partner API | n/a | partner's games |
| **Liquipedia** | wired (read-only) | yes, historical | API key + contact in UA | **60 req / hour** | yes, per-wiki |
| **Toornament** | not wired — best next candidate | yes | OAuth 2 client credentials | tiered | yes |
| **Battlefy** | not wired | yes, via undocumented JSON | none | unknown | yes |

### start.gg
The strongest source we have. GraphQL, real standings, entrant rosters with prefixes, country
codes, seeds, per-game character selections, stream stations and league standings. Everything the
Smash/FGC boards need arrives on one set push.

Limits: **80 requests per 60 seconds and a maximum of 1000 objects per request** (nested objects
count). The object cap is the one that bites — a deep query over a large bracket fails on
complexity long before you hit the request rate.

Known trap, already bitten once: an **expired token returns zeros and empty arrays, not an error**
— a 401 isn't a GraphQL error, so nothing logs. See `startgg-token-silent-failure`.

### Challonge — read this before running a long event on it
Challonge v1 is what we use (`backend/integrations/challonge-client.js`). It now drives:
brackets of every type, participants, live match queue, auto-follow, result push-back, **real
placements** (`challongePlacements()`), **standings for every format**, and **game detection** that
switches the whole app to the right game.

**The quota is the operational risk.** Challonge's free plan allows **500 requests per month**, and
the grace period on that ended **6 July 2026** — past the limit the API returns 429. One live poll
costs three requests (tournament + participants + matches), so a 30-second poll is ~86,000 requests
a month: a free key runs dry in under four hours of broadcasting. Hence the poll-interval selector
and the monthly budget meter in Settings ▸ Challonge. For any real event, either raise the interval
or put the organiser's key on a paid Challonge plan.

v2.1 exists and takes either OAuth (`Authorization-Type: v2`) or the same v1 key
(`Authorization-Type: v1`). We already use v2.1 for one thing v1 can't do — listing affiliates'
community tournaments. Moving wholesale to v2.1 buys nothing for placements; it does not change
the quota.

### Challengermode — not Challonge, despite the name
`challengermode.com`. A different company and a completely different API, and the similar name is
worth being careful about: a producer asking for one and getting the other is an easy mistake to
make in a support thread.

**GraphQL, not REST.** One endpoint (`publicapi.challengermode.com/graphql`), and the schema is
published as SDL at `?sdl` — which means our queries are validated against Challengermode's own
schema in CI (`test/challengermode-schema.test.js`). That is a real advantage over every REST
platform here: a mistyped field fails the build instead of returning an empty bracket on air.

**Auth is two-step.** A long-lived *refresh key* (Application Dashboard → Credentials, shown once)
is exchanged at `POST /mk1/v1/auth/access_keys` for a short-lived *bot token* (~20 min), which then
goes in `Authorization: Bearer`. The client re-exchanges transparently. A bot reads public
tournaments out of the box; a private or unlisted one needs the bot linked to that Space.

**Two things it models better than anything else we support:**
- **Bracket side is labelled.** `TournamentNodeLabel` marks a bracket UPPER / LOWER / FINALS, so
  winners, losers and grand final are exact. Challonge makes us infer it from the sign of a round
  number.
- **Placements are ranges.** A joint 5th–8th is `{ bestPlacement: 5, worstPlacement: 8,
  displayPlacement: "5-8" }`. That is what a bracket actually produces, and the standings board now
  prints the range instead of inventing a 5th, 6th and 7th nobody played for.

**Tournaments are multi-stage** (groups, then playoffs) — each stage becomes one of our bracket
phases, so a two-stage event arrives as two selectable phases rather than one unreadable bracket.

**No published request limit.** The API is budgeted by *field cost* (`@cost` weights on the schema)
rather than requests per minute, so the optimisation is to ask for fewer FIELDS — the opposite of
Challonge. Our live poll uses a narrower query than the initial load for exactly this reason.

### Toornament — the gap worth filling next
The largest bracket platform we do **not** support, and the one European/APAC organisers ask for.
Official, documented v2 API with a Viewer tier (public tournaments, no organiser consent needed),
OAuth 2 client credentials, and bracket-node endpoints shaped almost exactly like the ones we
already consume. Because `state.bracket.phases` and the placement row shape are now
platform-agnostic, adding it is a client plus a loader — roughly the size of the Challonge loader,
not a new subsystem.

### Battlefy
Big in North American collegiate and publisher-run circuits. There is **no official API** — the
site's own JSON endpoints (`api.battlefy.com`) are public and stable enough that community
wrappers exist, but nothing is documented or promised. Worth wiring only if an actual client runs
on it, and worth labelling as unofficial in the UI if we do.

---

## 2. Per-game data: what exists, and what genuinely doesn't

This is where most of the wasted effort in esports tooling goes, so it's worth being blunt about
which games have a live feed and which do not.

### Games with a real live feed (wired)
| Game | Feed | Notes |
|---|---|---|
| Rocket League | RL Stats API over TCP 49123 | full live match state |
| CS2 / CS:GO | Game State Integration | the config we install |
| League of Legends | LCU + Live Client Data API :2999 | gold is estimated, not exposed |
| Apex Legends | LiveAPI (the game connects out to us) | |
| Valorant | Overwolf GEP relay | relay PC must be IN the match; no per-player health |
| Overwatch / Marvel Rivals / R6 | Overwolf GEP relay | ~40s delay on Rivals |

### Valorant: what Riot does and does not give you

Worth spelling out, because the suite shipped for a year with a Valorant feed that could never
connect. It polled `https://127.0.0.1:2999/liveclientdata/allgamedata` — **that port belongs to
the League of Legends client.** Valorant's local API is lockfile-authenticated on a random port and
serves presence, not match state. Nothing was ever going to arrive, and with League running on the
same PC the poll would *succeed* and pour League data into a Valorant scoreboard.

There is no fix inside Riot's own APIs:

* **No GSI.** Valorant has nothing like CS2's Game State Integration.
* **No live spectator endpoint.** `val-match-v1` is post-match and needs a production key that Riot
  approves per-product; it is not a broadcast feed.
* **The unofficial local API** (lockfile) carries the presence blob — map, in-progress score,
  session state — but no per-player stats, it only sees the local player, and it is reverse
  engineered.

So the feed is **Overwolf GEP**, relayed by `companion-overwolf/` to `POST /api/val-gep`
(normalised in `backend/integrations/valorant-gep.js`). GEP reads the LOCAL client, so the relay PC
has to be in the match — an observer seat counts, and `match_info.observing` reports who that seat
is watching.

What that buys: names, agents, alive, shields, K/D/A, weapon, credits, ult points, spike state,
round number/phase and the round score. What it does **not** include, and what the HUD therefore no
longer draws: **per-player health** and **ability charges**, both local-client-only.

Agent names arrive as Riot's internal codenames (`Pandemic` = Viper, `Wushu` = Jett, `Aggrobot` =
Gekko). Those are not guessable, so `backend/valorant-agents.js` is generated from valorant-api.com
by `assets/fetch-valorant-agents.js` — re-run it after an agent release.

### Games with **no** live feed — scoreboards are producer-driven, by necessity
**Smash Ultimate, Brawlhalla, every FGC title, THE FINALS, Call of Duty, Fortnite, Bedwars.**

No GSI, no spectator API, no "currently playing" endpoint. Anyone promising otherwise is
screen-scraping or OCR'ing. Our boards for these games are honest about it: the producer clicks
stocks/rounds down, and the API layer supplies **identity** around that.

### Brawlhalla (new)
`api.brawlhalla.com` **v1**, and it is the friendliest integration in the suite:

- **No API key.** v1 dropped the key requirement; v0 required one and Blue Mammoth stopped issuing
  them. Nothing to apply for, nothing to paste in.
- **2000 requests / 5 minutes**, and the docs say it will not be raised on request. Our caches
  (10 min search, 5 min card, 24 h legends) keep us orders of magnitude inside that.
- Endpoints we use: `/v1/leaderboard/ranked`, `/v1/player/stats`, `/v1/player/teams`,
  `/v1/static/legends`.

What it gives a broadcast: ELO, tier (Tin→Valhallan), peak rating, global and regional rank, season
W/L, and the legends a player actually plays, ordered by games. That is a genuinely good player
card and a ready-made ladder standings board.

**The one sharp edge:** there is no `/search` endpoint. The only name lookup is *searching the
ranked leaderboard*, so **an unranked player cannot be found by name at all**. The control panel
says so in as many words and offers the Brawlhalla ID instead — otherwise "no results" reads as a
broken integration.

`overlay/brawlhalla-legends.js` is generated from `/v1/static/legends`, so legend ids and weapon
pairs are the game's own. `assets/fetch-brawlhalla-legends.js` refreshes both art and registry.

`assets/games/brawlhalla.png` is the game's crest (Brawlhalla wiki, `File:Brawlhalla Logo 2017
Icon.png`), re-rendered as a mono mark by `scripts/make-mono-logo.js`. It has to be mono: the
control panel draws every game logo through `filter: brightness(0) invert(1)`, which keeps only
the alpha channel — the colour crest came through as a featureless white shield. Six other games
(2XKO, Guilty Gear Strive, Marvel Tokon, THE FINALS, Tekken 8, Street Fighter 6) still carry
Arial-text placeholder SVGs and want the same treatment.

### Riot Games (key storage wired)

The key lives in **Marketplace ▸ Integrations ▸ Riot Games** (encrypted at rest, never broadcast,
never leaves the machine except to Riot). `backend/integrations/riot-client.js` holds the client;
`Test key` hits `lol-status-v4` and `Look up` resolves a Riot ID through `account-v1` →
`summoner-v4` → `league-v4`.

Two things bite, and the panel says both out loud:

* **A development key expires every 24 hours** and a dead one answers **403**, not 401 — the
  overnight failure that looks like a typo. Regenerate it on the Riot dashboard.
* **Riot has two routing families.** Account and match endpoints are regional
  (`americas`/`europe`/`asia`/`sea`); summoner, league and status are per-platform
  (`na1`/`kr`/…). A mismatch is a 404 that reads as "player not found", so the platform picker
  drags the region with it.

Nothing polls Riot — the rate limits are small and every call is a producer button press.

### Other per-game stats APIs worth knowing
| API | What it's good for | Catch |
|---|---|---|
| **Riot** (LoL, Valorant, TFT) (key wired) | ranked identity, match history | production key needs app review; no live spectator for a third party |
| **ballchasing.com** (wired) | RL replay stats, per-player leaderboards | post-match only |
| **Marvel Rivals API** (marvelrivalsapi.com) | hero/player stats, ranks, match history | third-party, key from their dashboard, not Netease |
| **OpenDota / Steam** (Dota 2) | full match + live league data | free, genuinely good |
| **Tracker.gg** | many games, one shape | rate-limited, ToS restricts display |
| **Overwolf GEP** (wired) | the only live source for several games | local-player-scoped, per-title gaps |

---

## 3. What a top 8 board can now be built from

Four routes, all landing on the same `overlay/standings.html` graphic:

1. **Platform placements** — start.gg or Challonge, re-mirrored live as the bracket resolves
   (`startgg-placements` / `challonge-placements`).
2. **Our own competition layer** — in-app leagues, Sheets, the Competition API.
3. **A ranked ladder** — Brawlhalla's `/api/brawlhalla/push-leaderboard` puts a region's top N
   straight on the board with no bracket at all. The same pattern would work for any game with a
   public ladder.
4. **Typed by hand** — the Top 8 builder, which is also what every platform route degrades into the
   moment a producer edits a row.

The placement wall is **no longer Smash-only**: choosing it explicitly works for any game, because
the cards fall back to the entrant's logo when there is no character art. `auto` still means
fighting games get it and team games get the podium.

---

## 4. Quota summary — the numbers that actually matter mid-show

| API | Limit | What that means for a broadcast |
|---|---|---|
| Challonge free | **500 / month** | ~4 hours at a 30s poll. **Raise the interval or pay.** |
| Liquipedia | **60 / hour** | Never poll. Cache-first, producer-triggered only. |
| start.gg | 80 / 60s, 1000 objects/req | Fine; the object cap is the real constraint |
| Brawlhalla | 2000 / 5 min | Effectively unlimited for our use |
| Challengermode | cost-weighted, no request cap | Ask for fewer FIELDS, not fewer requests |
| FACEIT | generous | ⚠ silently *clamps* paging limits |
| Twitch | per-token | Implicit-grant tokens can't refresh — 401 on expiry |

---

## 5. Recommendations, ranked

1. **Put the Challonge quota in front of producers before an event, not after.** Done (meter +
   interval), but organisers on free plans should be told to upgrade or poll slowly. This is the
   single most likely on-air failure in the Challonge path.
2. **Add Toornament.** Now the biggest remaining coverage gain, and cheaper than it was:
   Challengermode proved the placement/bracket shapes are genuinely platform-agnostic.
3. ~~Adopt the game automatically on every platform load.~~ **Done** — `adoptEventGame()` is shared
   and now runs on the Challonge, start.gg and FACEIT loaders. NXGEN is the one left; it reports a
   game string too, so it is a one-line addition when someone is next in that file.
4. **Treat "no live feed" as a product decision, not a gap.** Smash and Brawlhalla boards are good
   *because* they pair a fast manual control strip with a real identity layer. Reuse that shape for
   the next platform fighter rather than hunting for a feed that doesn't exist.
5. **Battlefy only on demand.** Unofficial endpoints, no promises; wire it when a client needs it.

---

## Appendix: adding a new tournament platform

1. `backend/integrations/<platform>-client.js` — HTTP client with retry and a real error taxonomy.
2. A loader that fills `state.bracket.phases`, `state.<platform>.queue` and `state.activeEvent`.
3. `adoptEventGame(theGameName)` — resolves the game id and switches the app. Add spellings to
   `backend/game-match.js` and a case to `test/game-match.test.js`.
4. A placements function returning `{ placement, name, logo, players, countryCode, character }`
   rows, plus a `<platform>-placements` standings source that re-mirrors on poll.
5. `setActivePlatform('<platform>')` in the loader and in the auto-follow enable path — two
   platforms auto-following at once fight over the scoreboard.
6. Push identity through a side-setter like `challongePushSide()` so **1v1 games get a roster**, not
   just a team name. Skipping this is what makes a platform look broken for fighting games.

## Sources

- [Challonge API docs — getting started & rate limits](https://challonge.apidog.io/getting-started-1726706m0)
- [start.gg — rate limits](https://developer.start.gg/docs/rate-limits/)
- [start.gg — event standings query](https://developer.start.gg/docs/examples/queries/event-standings/)
- [Brawlhalla developer docs](https://dev.brawlhalla.com/)
- [Challengermode developer docs](https://www.challengermode.com/developers/docs) · [GraphQL SDL](https://publicapi.challengermode.com/graphql?sdl)
- [Toornament developer portal (Viewer API)](https://developer.toornament.com/v2/doc/viewer_overview)
- [Marvel Rivals API docs](https://docs.marvelrivalsapi.com/)
