# Deep Code & UX Audit — 2026-07-07

Five-track audit (front-end code, server/backend, UX/IA, CSS/design system, overlay suite) of the whole application, aimed at a redesign that loses zero features. Live checks were run against the running app on :3000/:3001 where possible.

Corpus: `control-panel/app.js` 33,729 ln · `server.js` 18,129 ln · `control-panel/index.html` 9,147 ln · `control-panel/styles.css` 7,411 ln · 60 overlay HTML files (23,823 ln) · 15+ backend modules.

---

## 1. Executive summary

The product is feature-dense and the *mechanisms* underneath are mostly sound (atomic async persistence, live/library broadcast tiering, WS heartbeats, per-renderer crash isolation, path-checked file routes). What has decayed is the **organization**: four generations of UI stacked by override rather than replacement, three parallel navigation systems plus boot-time DOM re-parenting that makes the HTML no longer describe the real IA, ~10 modal systems / 8 escapeHtml clones / 4 confirm systems / 94 button families, and two giant single-scope files (app.js: 1,007 top-level functions; server.js: a 296-case WS switch + 180 inline routes).

The audit also surfaced **real bugs and live-broadcast risks** (section 2) that should be fixed before/alongside any redesign — including a recurrence of the broadcast-payload bloat bug (~600 KB/broadcast measured live) and an unauthenticated control WebSocket bound to all network interfaces.

Nothing found requires a rewrite. Every recommendation below is an incremental, feature-preserving consolidation, and the existing prefix conventions (`bb*`, `ev*`, `gfx*`, `seed*`…) mean the module boundaries already exist implicitly — the refactor makes them physical.

---

## 2. FIX NOW — bugs & risks found during the audit

> **Status update (2026-07-07, same day):** Phase 1 executed. Fixed: #1 (leagues/clips → library tier, brand stripped from live, leaguesVer/clipsVer sig entries, client backfill extended), #2 (WS binds 127.0.0.1, `WS_HOST` env override documented in .env.example), #3 (csgo/valorant `_lib` carry-forward), #4 (brand no longer in live payload), #5 (`renderPlayerCamMounts` / `fillObsSceneSelect` renames — the talent/DCC/match-settings player-cam mounts were dead and now render), #6 (Font Awesome + animate.css vendored to /assets/vendor, 16 files + scene.css rewritten; valorant's jsdelivr agent/map art still remote — game-data scale, deferred), #7 (`confirmQueuePush()` on all 4 push sites), #8 (Clear All GFX + Clear Scoreboard confirms; Challonge checkbox unsticky + typed confirm), #10 (media upload/list/folder/delete, clips scan, profile export, OBS collection, transition logo all async), #11 partially (transient toasts restored w/ autoDismissMs; catch-block sweep deferred to Phase 2), #12 (wmic → os.setPriority; nxgen timeout was already present — stale finding; undefined CSS vars defined). CSS Phase 0 done: one canonical :root, missing tokens defined. Remaining from this table: #9 (safeStorage credentials — Phase 4), #13 (dead-code deletion — Phase 2).
> Live payload drop and the WS bind need an app relaunch to take effect/verify (the running instance predates the edits).
>
> **Phase 2 status (2026-07-07, same day):** Dead code deleted — root app.js (22,076 ln), control-panel/js/dashboard.js + nav.js, overlay/intermission2.html + intermission-brand.html, renderDccSection no-op (~23k lines net). NOT deleted (verified live backing stores, audit was wrong about these): hidden Social tab (13 wired IDs — it IS the Social feature's DOM) and the Cameras "Players" sub-tab (hosts the shared cfp-playercams mount). **BROADCAST_TIERS schema** added above buildLiveState — every state key declared live/library/local, spread-denylist replaced by stripByTier(), undeclared keys warn loudly once (the payload-creep tripwire). WS dispatch handler crashes now log the message type instead of vanishing. **CSS Phase 1**: semantic-state tokens (--ok/--danger/--warn/--live/--rec), white alpha ladder (--white-a03..a12), radius scale; 321 hex/rgba literals migrated to tokens; dead class families removed (.update-notification, .status-bar-l/c/r, .add-team-form, .facecam-player-row, .golive-card); .btn-sm/.btn:hover conflicting duplicates collapsed. **One confirm system**: all 19 raw confirm() calls migrated to appConfirm (async handlers), customConfirm now delegates to appConfirm — the panel has exactly one confirm dialog. Remaining for Phase 3: core.js + domain extraction from app.js, WS handler registries + route modules server-side, esc() unification, duplicate-editor merges, inline-style drain.
>
> **Phase 3 part 1 (2026-07-07, same day):** (1) **esc() unified** — one canonical full-superset escaper at the top of core.js; all 7 clones (escHtml/_spEsc/tlEsc/_stEsc/poEsc/dEsc/escapeHtml) are now one-line delegating aliases (the old DOM-based escapeHtml didn't escape quotes — attribute-unsafe). (2) **core.js extracted** (260 ln): console ring-buffer capture, WS_URL/ws/currentState globals, send/el/esc/_editingInside, gameLogo/setSideLogo, the image pipeline (downscaleDataUrl/fileToBase64/uploadImageFile), customConfirm/customPrompt. Loads before app.js; classic scripts share one global scope so nothing else changed. (3) **First domain module proven: social.js** (759 ln, the Social publishing tab) extracted verbatim from the end of app.js; loads after app.js; app.js reaches back only via two typeof-guarded calls. The pattern for the remaining domains (analytics an*, stats, seeding seed*, leagues lg2*…): cut the contiguous section → own file → script tag after app.js → typeof-guard inbound calls.
>
> **Phase 3 part 2 (same day):** three more domains extracted with that recipe — **stats-analytics.js** (2,394 ln: Stats tab, leaderboards/team records/h2h, Analytics dashboard, business figures, retention, start.gg historical import, reports, sponsor proof-of-play, cross-game profile), **seeding-spotlight.js** (2,311 ln: seeding studio, rl6mans rank verify, Spotlight/watchlist builders, entrant linking — also carries shared utils teStartggLink/teSixmansLink/playerProfileChips/csvParse used by the Teams editor at runtime), **leagues.js** (901 ln). Load order in index.html: core.js → app.js → social.js → stats-analytics.js → seeding-spotlight.js → leagues.js → app-store-nav → tour. app.js is now **27,514 lines (was 33,720)**; verified: node --check on all six files + a cross-file duplicate-declaration scan (zero collisions). All inbound edges into the extracted domains are runtime calls (WS messages/tab clicks/render functions) — classic-script load order guarantees resolution. Remaining Phase 3: next domains (camera feeds cf*, bracket builder bb*, events ev* are the next-cleanest), WS handler registries + route modules server-side, duplicate-editor merges (standings/schedule/bracket), stop DOM re-parenting, inline-style drain — the latter two want live UI verification after a relaunch.
>
> **Phase 3 part 3 (2026-07-08):** (1) **events.js** (1,281 ln) + **bracket-builder.js** (633 ln) extracted — app.js is now **25,675 lines, down 24% from the audit's 33,720**, across an 8-file load order (core → app → 6 domain files). Cross-file duplicate-declaration scan clean; all inbound edges runtime. (2) **Server WS handler registry shipped**: `WS_HANDLERS` + `registerWsHandlers()` above `handleControlMessage`; dispatch checks the registry first and falls through to the legacy switch. veto_*/draft_*/set_veto (13 handlers) migrated as the template — remaining ~280 cases migrate group-by-group with zero protocol change. (3) **Overlay WS URLs host-aware** in all 10 files that hardcoded ws://localhost:3001 (incl. scene-base.js) — browser sources on another machine now reach the server (pairs with the WS_HOST env opt-in). Remaining: cf* domain cut, switch-migration of the other WS groups, HTTP route modules, duplicate-editor merges + DOM re-parenting removal (after a relaunch, with live verification).
>
> **Phase 3 part 4 (2026-07-08):** (1) **camera-feeds.js** (1,602 ln) extracted — Talent Rooms/VDO manager/DCC consoles/match-control cards/listen-in/stations; `tlEsc` stays in app.js as a one-line alias (57 external call sites); the qrail-talent cluster and dcc* renderers stay (non-contiguous, live in the qrail/early-init regions). **app.js is now 24,098 lines — down 29% from the audit baseline** across nine load-ordered files. (2) **25 more WS cases migrated** to the registry (Overwatch, Marvel Rivals, winner/intro, ticker, upcoming/standings, watchlist/spotlight) — 37 handlers total, ~250 cases remain in the legacy switch, migrating group-by-group. All 10 JS files pass node --check; cross-file duplicate scan clean. **Phase 3's no-relaunch work is effectively done** — next steps (Phase 4 UI redesign + duplicate-editor merges + live payload verification) are gated on an app relaunch and a baseline commit.

| # | Severity | Finding | Evidence | Fix |
|---|---|---|---|---|
| 1 | **P0 perf** | Live broadcast payload regressed to **~600 KB per broadcast** (measured live): `leagues` = 368 KB of base64 team logos, `clips` = 75 KB, `teams` = 53 KB, `startgg` = 34 KB. Root cause is structural: `buildLiveState` spreads `...state` and strips a denylist, so **every new state key defaults to on-air**. | server.js:2556, 2573, 2579–2582 | Invert to an allowlist (ideally generated from a state schema, §4); move `leagues`/`clips` metadata into `libraryData()` gating (server.js:2664) |
| 2 | **P0 security** | WS control server (:3001) binds **0.0.0.0 with zero auth** while HTTP correctly binds 127.0.0.1. All 296 mutating cases (state wipes, scene control, profile import) reachable from the LAN. | server.js:8644 vs 16407 | `new WebSocket.Server({ host:'127.0.0.1', port: WS_PORT })` — or token handshake if remote overlays are ever a feature |
| 3 | **P1 on-air** | `csgo.html` and `valorant.html` do `brand = d.brand \|\| null` on every message with **no library backfill** — sponsor rail/banner silently vanish after the first light broadcast and stay gone. rl-hud.html:2056–2068 fixed this locally; fix never propagated. | csgo.html:1946, valorant.html:1847 | Port rl-hud's backfill (or adopt scene-base, §7) |
| 4 | **P1 on-air (verify)** | `state.brand` (accent-only object from `set_global_accent`) is not stripped from live payloads → may clobber scene-base's `_cache.brand` and drop sponsor logos even on base scenes. | server.js:9483, buildLiveState; scene-base.js:357–376 | Strip `brand` from live payload / backfill by sponsor-presence; verify live first |
| 5 | **P1** | Duplicate top-level function declarations silently shadow each other: `renderPlayerCams` @740 vs @18941 (second wins; callers at 789/805/809 hit the wrong one), `fillSceneSelect` @11257 vs @22969 (winning sig ignores `firstLabel` passed at 21731–21733). | control-panel/app.js | Rename per-domain; add `no-redeclare` lint. 1,007 functions in one scope guarantees more collisions |
| 6 | **P1 offline-venue** | 16 scenes + scene.css:11 load Font Awesome from cdnjs; countdown.html loads animate.css from CDN; valorant.html:1006 loads agent/map art from jsdelivr. All caster desks lose social icons (valorant loses art) with no internet. sponsor-banner/countdown/mapscreen declare fonts they never load (silent OS-font fallback). | overlay/* | Vendor an inline-SVG icon set / self-host FA subset; make fonts.css mandatory |
| 7 | **P1 UX-safety** | Queue "Push" **silently resets a running series** (no prompt, no toast) — the most common mid-broadcast data loss. Same implicit reset from league push flows. | server.js:2933; app.js:6843, 8168, 16962, 17154, 17383 | Inline diff on push ("resets series 2-1 → 0-0") with visible checkbox |
| 8 | **P1 UX-safety** | Unconfirmed on-air wipes: **Clear All (GFX)** (app.js:2160, 18360), **Clear Scoreboard Now** (app.js:22974), Challonge "clear existing participants" sticky checkbox (app.js:13801). No undo exists anywhere in the app. | — | Two-step arm (3 s) for on-air wipes; unsticky + confirm the Challonge box |
| 9 | **P2** | Plaintext secrets persisted into state.json (`startggApiToken` @2038, `challongeApiKey` @2040, `nxgenApiKey` @2042, `obsPassword` @2055) — the exact file users share when debugging. (.env.local no longer ships in builds — package.json files list verified clean.) | server.js | Electron `safeStorage` credentials file; scrub from snapshot (profile-export scrub pattern already exists) |
| 10 | **P2** | Sync I/O on hot paths in the Electron main process: `/api/media/upload` `writeFileSync` of base64 with a **40 MB** JSON limit (server.js:14248, 14188); also 14242, 13079, 13353, 11343; `/api/clips/scan-folder` sync-walks per request (13987–13998). | server.js | `fsp.writeFile`; stream uploads |
| 11 | **P2** | `showToast` forwards to the notification bell and **ignores `autoDismissMs`** — success feedback is invisible unless the bell is opened; 135 swallowed catches client-side + 61 empty catches server-side + WS dispatch `catch { /* ignore */ }` (server.js:8656–8661); Discord/Roles feature 100% silent (app.js:4024–4180). | app.js:28841–28864 | Restore transient toasts; `logErr(subsys,e)` helper + surface in What's Armed activity log |
| 12 | **P3** | `backend/nxgen.js:18` raw `https.request` with no timeout (hang risk — axios calls elsewhere all pass timeouts). wmic priority hack silently no-ops on Win11 (wmic removed) — use `os.setPriority`. Undefined CSS vars in production: `--primary` ×14, `--surface3` ×7, `--text-muted` ×3, `--fg` ×3 (styles.css:6950 has **no fallback**). | — | One-liners |
| 13 | **P3 dead code** | Root `app.js` (22,076 ln, 1.2 MB) is an old copy of control-panel/app.js referenced by **nothing** (not in package.json files, not loaded by main.js; overlay/index.html loads overlay/app.js). Also unreferenced: `control-panel/js/dashboard.js`, `control-panel/js/nav.js`, `overlay/intermission2.html`, `overlay/intermission-brand.html`, hidden Social top-level tab (index.html:225), retired Cameras "Players" sub-tab (1775), ~345 dead CSS classes (14%) incl. whole retired families (`.update-notification`, `.golive-card`, `.status-bar-*`). | — | Delete (zero-risk ~24k-line reduction) |

Smart-quote scan (per prior audit feedback): 23 occurrences, **all benign** display text — none inside attribute delimiters or JS syntax.

---

## 3. Front-end code (control-panel)

**Architecture:** app.js has no section banners; 1,007 top-level functions across ~40 feature domains identified only by prefix convention. Full line-range map is in section 3a below. index.html is 100% static hand-written markup: 2,492 `id=` attributes (a stringly-typed JS↔HTML contract), 2,134 inline `style=`, 37 pre-baked modals (7863–8940), 8 inline `<style>` blocks (413 ln).

**Key findings beyond §2:**
- **Render fan-out:** every `full_state` triggers ~21 top-level renderers + the 466-line `applyState` (4952–5418) calling 40+ sub-renderers. Only ~23 renderers have sig guards against 658 `innerHTML` sites; unguarded ones rebuild DOM and re-attach listeners per broadcast (e.g. listener-in-render-loop @20739).
- **8 escapeHtml clones** with different escape sets (`_spEsc` @5592 misses `>`; only one escapes `'`). Injection safety depends on which clone a section uses.
- **4 confirm/prompt systems** (customConfirm @196, nePrompt @6218, showClipPrompt @27383, appConfirm @28889) + `window.alert` monkey-patched to the bell @28911.
- **691 top-level wiring statements** interleaved with definitions — the documented TDZ blank-screen failure mode; defended today by 205 `typeof` guards + 129 empty catches (symptom management).
- **No API layer:** 201 literal `http://localhost:3000` strings across 202 fetch sites.
- **~46 `window._*` bridge functions** as cross-domain coupling.
- **DOM re-parenting as state:** `_borrowGraphicsToDash`/`_returnGraphicsToProd` @1732–1755 and ~6 boot-time re-parenting IIFEs (also 1944, 3425, 6246) physically move nodes between pages — root cause of the bracket-panel double-re-parenting bug class; makes index.html unreadable as an IA source.
- Four always-on 1 s intervals tick regardless of visible tab (@24427, 24452, 27327, 32827).

**Modularization plan (no bundler needed — plain `<script src>` in dependency order, precedent already exists with countries.js/heroes-data.js/tour.js):**
1. Delete dead weight (§2 #13).
2. Extract `core.js`: console capture, WS_URL/send/el/_editingInside, ONE esc(), ONE dialog service, `api.get/post`, toasts.
3. Extract leaf domains first (analytics, stats, social, seeding, leagues) as one file each, exporting via `window.NE.<domain>`.
4. Extract WS layer last: replace the hardcoded renderer fan-out with a registry (`NE.onState(fn)`) each domain registers into.
5. Move the 691 top-level wirings into per-domain `init()` called from a try/catch-per-domain `boot.js`.
6. Respect: scripts at end of body (documented constraint @8944), Graphics-hub IIFE + hidden Graphics tab move as-is (intentional backing store).

**Preserve:** per-renderer try/catch isolation (`_r`, `_ap`), WS heartbeat half-open detection, live-payload backfill merge, focus-guarded input sync (`_editingInside`), sig-guard pattern (generalize it), console ring-buffer, inline institutional-memory comments.

### 3a. app.js domain map (reconstructed)

1–195 core/WS/upload utils · 196–660 customConfirm/Prompt · 660–1750 crew/DCC + player cams · 1756–3465 Graphics hub IIFE · 3466–3900 nav/qrail · 3901–4190 Discord/roles · 4191–4950 bug reporter/updates/bb-config · 4952–5418 applyState · 5420–6200 start.gg/match-teams/series · 6200–6400 media/assets · 6400–7100 bracket builder · 7100–8900 teams tab · 8900–9500 settings/profiles · 9500–10000 facecams · 10000–11000 start.gg pickers · 11000–11600 casters · 11600–12400 veto/draft/OW/MR bans · 12400–13000 scenes tab/whats-armed · 13000–14200 events · 14200–16400 seeding/spotlight/watchlist · 16400–17400 leagues · 17400–18300 dashboard/deck · 18300–18700 switcher/timers · 18700–18940 preview dock · 18941–19100 dash player cams · 19100–21000 camera feeds/VDO/queue/caster desk · 21000–21700 ticker/bracket-state/standings · 21700–22400 production/brands · 22400–23100 per-game states/OBS · 23100–23300 vMix/director · 23300–24400 clips/playlists · 24400–25300 ads/hotkeys/deck/rundown · 25300–26000 flows · 26000–27400 producer panels/replay bus · 27400–28400 clip editor/Twitch embed · 28400–28910 chat/AI/bell/appConfirm · 28914–29700 WS connect/predictions · 30000–31000 stats · 31000–32400 analytics/ad-proof · 32435–33000 EventSub/rail chat · 33000–33729 social publishing.

---

## 4. Server & backend

**Counts:** 296-case WS control switch (8682–13098, 4,416 ln); 180 HTTP routes inline in `startHttpServer` (13148–16608); ~560-line global state literal (210–769); 420-line manual `loadState` + ~105-field save whitelist.

**Key findings beyond §2:**
- **3-way state lifecycle drift:** every persisted field must be manually kept in sync across the state literal, save whitelist (1983–2087), and loadState (1562–1981) — the historical "settings reset" symptom class. A schema-driven state module (`{default, persist, broadcast:'live'|'library'|'never'}` per slice) fixes this AND permanently fixes payload creep (§2 #1).
- **Triple-entry duplication:** Twitch predictions exist as HTTP routes AND flow actions; OBS scene switching has ≥3 call paths; veto/draft are WS-only while stats are HTTP-only — no rule for which plane owns an operation.
- **Tournament-platform triplication:** start.gg (3091–3498), Challonge (3499–3858), NXGEN (3859–4055) each reimplement queue/bracket/logo/polling; `setActivePlatform` hand-switches.
- backend/ is healthier than it looks: integrations/, director/, clips/, db/ subfolders already exist as the extraction target.

**Refactor sequence (each step shippable alone):**
1. Quick safety wins: WS host bind, nxgen timeout, hot-path async writes, `logErr`.
2. `backend/core/state.js` — schema-driven state + generated buildLiveState allowlist (keep `module.exports.state` reference identical so 18k lines of `state.x` keep working).
3. `backend/core/bus.js` — broadcast/coalescing/bridge.
4. WS switch → ~12 handler-registry files by prefix (`veto_*`, `twitch_*`, `flow_*`…), per-handler try/catch + optional validator. Deletes ~4,400 lines from server.js.
5. HTTP routes → express.Router modules by URL prefix.
6. Services for duplicated ops (predictions, switcher — `switcherCut/Take` is the seam; also closes the vMix producer-cut TODO).
7. Game telemetry out (RL TCP 7562–8642, handleGsi, Valorant/LoL polling).
8. Tournament provider interface (last — preserve queue-order invariants verbatim, e.g. Losers Finals before GF).
9. safeStorage credentials migration.

**Anti-goals:** no worker-thread move (inline Electron dialogs/app.getPath); no overlay protocol change (`full_state` shape stays backfill-compatible).

**Preserve:** `safeWriteJson` (atomic, coalesced, sync-only-at-shutdown), broadcast tiering + `librarySig`, WS heartbeat eviction, path-checked file routes (`safeMediaPath`), systematic spawn `.on('error')` hygiene, loopback HTTP bind, secret masking in broadcasts, optional-dependency guards.

---

## 5. UX / Information architecture

**The IA today:** 12 sidebar tabs + 8 quick-rail tabs + ~10 topbar controls ≈ 21 top-level destinations, ~65 leaf screens. Three generations of ghost markup ship (hidden Social tab, `prod-pane-content` graveyard @5444, retired sub-tabs); the *real* IA is assembled at boot by ~6 DOM-move IIFEs. Spanish nav IDs, English labels.

**Verified overlap drift (vs deliberate shortcuts):** two full Standings editors (Production▸Graphics vs ESPORTS▸Brackets & Graphics); two Schedule/Upcoming editors; Bracket = same DOM double-re-parented; Dashboard embeds the entire Graphics hub; On-Air board is ONE node physically moved between pages (widget "disappears"); Run-of-Show in 3 places; stream queue on 4 surfaces; talent domain sliced across 3 tabs + a Dashboard widget; Spotlight controls split across two pages (comment admits it @4162); countdown/break config duplicated.

**The core UX problem — two unreconciled "on air" concepts:** graphic-live (`gfxActive`) vs OBS program scene. A graphic can be "live" but invisible. And **staging discipline is inconsistent by surface AND scene**: Graphics hub = staged (Save content / Push visibility); qrail toggles & QUICK chips = instant; 6 of 12 gfx scenes save live-as-you-edit (series/matchup/veto/draft/spotlight/bracket); preshow is a live form with no push at all.

**Task flows:** queue push = 2 clicks but split-brain (loads scoreboard instantly + silent series reset, does NOT cut scene); graphic push = 1 or 4 clicks with opposite semantics by surface; veto = 7–8 clicks buried in a settings pop-out; replay mid-match = 2 full sidebar detours (no qrail replay panel); new event day = 4–5 screens with the eventTeams-vs-savedTeams dual-import trap.

**Consistency:** ~10 modal systems; `.btn-primary` defined 3× in 3 colors; **Push Live is a low-emphasis outline while Apply is solid blue (emphasis inverted)**; 5+ toggle mechanics with no immediate-vs-staged rule; success feedback invisible (bell-only); 1 shared + 13 ad-hoc empty-state patterns; terminology drift (scene/graphic/overlay/gfx; event/tournament; 7 different put-on-air verbs).

**Destructive actions:** four confirm mechanisms assigned at random; equal-severity actions get different ceremony; the highest-frequency loss (series reset) gets none. Full table in audit evidence; priority unconfirmed list: implicit series reset, Clear All GFX, Clear Scoreboard, Challonge participant wipe, bulk player/facecam/caster deletes, Twitch/Discord disconnect.

**Ranked redesign recommendations (all feature-preserving):**
1. **One "ON AIR" truth strip** in the topbar: OBS program scene + live graphics + armed-automation count; promote What's Armed into it; everything else becomes a reader.
2. **One staging rule:** Save = content, Push = visibility, everywhere; label instant surfaces visually (red/filled = fires now, blue/outline = staged); "LIVE-EDIT" badge on the 6 live-editing scenes; fix the inverted Push/Apply emphasis.
3. **Kill silent series reset + unconfirmed on-air wipes** (§2 #7/#8).
4. **One confirm + one feedback system:** standardize on appConfirm (native `<dialog>`) with severity prop; restore transient toasts; surface errors in the 135 silent catches (start with Roles).
5. **Merge standings/schedule/bracket duplicates:** delete legacy ESPORTS▸Brackets & Graphics after porting its Load-from-bracket/league buttons into the gfx panels' existing source-tab model; Bracket Builder moves whole into the Graphics▸Bracket pop-out — ends the double re-parenting.
6. **People page:** merge Talent + Cameras (Crew · Teams · Rooms & Cams · Monitor); Dashboard Talent Monitor becomes a view, not the DOM owner.
7. **qrail REPLAY tab** (buffer save, last-5 clips, To Air, Stop) — server API already supports it; pure UI.
8. **Event-day wizard** on ESPORTS▸My Events (activate → offer library import → casters → polling → branding) — kills the dual-import trap.
9. **De-duplicate Dashboard vs Production:** Dashboard = monitor + match state; Production = do-things hub; qrail = shortcuts. Replace Dashboard graphics widget with chip row + hub link. **Stop moving DOM nodes between pages — render from state.**
10. **Terminology glossary + cleanup:** Overlay / Scene / Match / Series / Event; Save / Push Live / LIVE-EDIT as the only verb states; English nav IDs; delete dead markup and collapse the 3 button palettes.

---

## 6. CSS / design system

**Metrics:** 5 `:root` blocks in one file (4 chronological theme generations mutating each other); ~20 tokens exist (color+layout only — **no spacing/type/shadow/z-index tokens**); color token adherence ≈ 45% (1,386 var() vs 996 hex occurrences / 221 distinct hexes + 702 rgba); 38 font sizes (incl. half-pixels); 50 border-radius values (`--radius` used 5 times); 94 button-ish class families; **no generic `.card`/`.badge`/`.chip`** — the card recipe is hand-copied into 155 rule blocks; ~85% of the sheet is page-silo CSS; 58 exact-duplicate declaration sets; 89 `!important`; 22 breakpoint values across 36 media queries; `.btn` redefined 3× with conflicting `.btn-sm` paddings (315 vs 2859 — order-dependent!). Green appears as 7 different hexes, red as 5. A11y: 18 `:focus` rules and 1 `:focus-visible` vs 255 `:hover`; 16 `outline:none` mostly uncompensated.

**Re-theme cost driver:** 2,134 inline styles in index.html + 626 in app.js templates + 1,214 `.style.` writes + 54 cssText + 8 embedded `<style>` blocks — a re-theme cannot be done in CSS alone today.

**Migration plan (value-preserving, no big-bang):**
- **Phase 0 (1 day, zero visual change):** merge the 5 `:root` blocks into one canonical block with final computed values; define the missing referenced tokens (`--surface3`, `--fg: var(--text)`, `--primary`, `--text-muted`).
- **Phase 1:** full token set — neutrals, **semantic states incl. broadcast-first-class LIVE/REC/PREVIEW/PROGRAM tokens**, alpha ladder (`--white-a04..a12` replaces 100+ rgba literals), type scale (38→8), space scale, radius (50→4), shadow, z-index. Mechanical find/replace per value.
- **Phase 2 (zero markup changes via selector aliasing):** `.card` (kills 155 copies) → unified `.seg-btn` (kills 6+ tab-pill clones) → single `.btn` block → `.badge`/`.icon-btn`/`.label-caps`.
- **Phase 3:** drain inline styles page-by-page (order: Qrail → Graphics → Replays → Events); lint gate: no new hex in app.js/index.html.
- **Phase 4:** one global `:focus-visible`; consolidate to 3 named breakpoints (~1300 rail-collapse / 900 drawer / 640 dense).
- **Overlays:** don't merge palettes (brand kits recolor overlay `--accent` at runtime); share only the semantic-state token names via a small tokens-shared.css.

**Already good:** overlay CSS is genuinely tokenized/theme-switchable; neutrals adherence is high where tokens exist (`--muted` ×474); the ≤900px drawer block is coherent; Inter everywhere; the 2857 "audit fixes" block has the right instincts (wrong layer).

---

## 7. Overlay suite (60 scenes)

**Sharing matrix:** 44/60 on scene-base.js; 13 own copy-pasted WS clients (csgo, rl-hud, valorant, lol-hud, live, gfx, scenes, ministation, director-preview, replay-player, stream-credits, twitch-polls, twitch-predictions; series.html runs base AND a second private WS); ~1,500–2,000 lines of redundant plumbing (13 WS clients, 16 local applyBrand copies, 5 esc() clones, 5 reimplementations of savedTeams→logo resolution, 4 large per-file demo states). **All scenes reconnect on socket drop — no scene dies on server restart.** All 44 base users backfill correctly; of the own-WS files only rl-hud backfills (csgo/valorant do not → §2 #3).

**Design-language spread — 5 generations coexist:** Gen0 legacy (index/app.js/casters — 'Industry' font, PNG art; still live as RL "Classic HUD"), Gen1 ported pack (scene.css em-based: countdown/draft/listen-in/mapscreen/replay/transition), Gen2 duorow desk family (15 files, `--duo-*` tokens), Gen3 target graphics language (`--disp`/`--body`, color-mix, grain/backdrop depth: schedule, bracket, matchup, intro, winner, standings, intermission, duorow), plus off-language strays (watchlist=Montserrat, sponsor-banner=Barlow with **no font actually loaded**, ticker=plain, twitch-* family).

**scene-base v2 plan (extend, don't rewrite):**
1. Host-aware WS URL (scene-base.js:17 hardcodes localhost — remote-machine sources render demo data forever); add opt-in raw-message hook so rl-hud/csgo/valorant/lol-hud/twitch-* can adopt base while keeping their game-specific message handling (deletes 13 bespoke clients and fixes the brand bug for free).
2. State store owns backfill; close the `state.brand` clobber server-side.
3. `SceneBase.resolveTeam(name)` — promote savedTeams→{logo,color} + svgFallback (kills 5 reimplementations).
4. Vendor icons (kill 17 CDN dependencies); fonts.css mandatory.
5. `scene-theme.css` — extract Gen3's :root (keep `--duo-*` as aliases).
6. Migration order by criticality: csgo/valorant fix → CDN removal on caster desks → hostname WS → restyle ticker/sponsor-banner/watchlist (on screen constantly) → fold twitch-polls/predictions/stream-credits onto base → retire Gen1 onto scene-theme → decide Gen0 Classic HUD fate → delete orphans.

**Exemplary:** schedule.html, bracket.html (target language, lean), intro/winner (richest depth), standings (clean grid), rl-hud (best own-WS pattern), scene-base.js itself.

---

## 8. Consolidated roadmap

**Phase 1 — Stop the bleeding (days):** §2 items 1–12. Highest-value minutes in the whole audit: payload allowlist, WS bind, csgo/valorant backfill, duplicate-function renames, CDN vendoring, series-reset confirm, on-air wipe arming, toast restoration, :root consolidation (CSS Phase 0).

**Phase 2 — Foundations (1–2 weeks):** delete dead code (~24k lines); front-end core.js + server state schema/bus; design tokens (CSS Phase 1); one dialog + one toast system; appConfirm standardization.

**Phase 3 — Consolidation (2–4 weeks, page-by-page):** component layer via aliasing; WS handler registries + route modules; merge duplicate editors (standings/schedule/bracket); People page; Dashboard/Production role split; stop DOM re-parenting (render from state); domain extraction from app.js (leaf domains first).

**Phase 4 — Redesign proper:** ON AIR truth strip; one staging rule + LIVE-EDIT badges; qrail REPLAY tab; event-day wizard; terminology pass; scene-base v2 migration + Gen3 convergence; tournament provider interface; safeStorage credentials.

**Ground rules that fall out of the audit:** every new state key declares its broadcast tier (schema); no new hex colors (lint); no new modal/confirm/esc implementations; no DOM re-parenting; no CDN references in overlays; destructive = confirmed or two-step armed, always with feedback.

---

## 9. What must be preserved (verified good)

- safeWriteJson atomic/coalesced persistence + .bak recovery; live/library/static broadcast tiering + librarySig; 40 ms coalescing.
- WS heartbeats both sides (half-open detection); per-renderer crash isolation; focus-guarded input sync; sig-guard render skipping.
- Path-restriction on all file routes; loopback HTTP bind; secret masking in broadcasts; spawn error-handler hygiene; optional-dependency guards.
- The hidden Graphics tab / golive backing store (intentional — QUICK chips click into it); Losers-Finals-before-GF queue order (verbatim start.gg order); ads never auto-play rule.
- Inline institutional-memory comments throughout — carry them over during every extraction.
- Overlay theme-switchable token pattern; the prefix naming convention (it IS the module map).
