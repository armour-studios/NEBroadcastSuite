# Overwolf Dev Console Submission — copy-paste pack

## App name
NE Broadcast Suite Relay

## Tagline / short description (under ~120 chars)
Relays live Overwatch match data to NE Broadcast Suite, a local esports broadcast production tool.

## Full description
NE Broadcast Suite Relay is a lightweight background companion for broadcast producers
running NE Broadcast Suite (a desktop esports production application). While Overwatch
is running on the observer PC, the relay reads the live game data that Overwolf's Game
Events Provider exposes — team rosters, hero selections, per-player statistics, map and
game mode, and match/round start and end events — and forwards it over the local network
to the producer's NE Broadcast Suite instance (an HTTP endpoint on the producer's own
machine, default http://localhost:3000).

The suite uses this data to drive live broadcast overlays for tournament streams: an
in-game HUD showing each player's hero, eliminations, damage and healing; automatic map
and game-mode detection on the series scoreboard; flagging when a player selects a hero
that was banned in the tournament ruleset; and scene automation cues on round and match
boundaries.

The app has no user interface of its own, collects nothing beyond the Overwolf game
events for the current session, sends data only to the address the producer configures
(local network), and stores nothing.

## Category
Utilities / Broadcasting (or closest available: Esports Tools)

## Game
Overwatch 2 (game ID 10844)

## Permissions used and why
- GameInfo / game events (required): reading the Overwatch GEP features — game_info,
  match_info, roster, kill, death, assist — which are the entire purpose of the app.
- No hotkeys UI, no overlays drawn in-game, no ads, no external services: data goes only
  to the user's own broadcast software on their LAN.

## Monetization
None. Free companion for NE Broadcast Suite users.

## Support contact
armourstudiosllc@gmail.com

## Notes for reviewer
This is a data relay for tournament broadcast production. It runs minimized in the
background (start_window: background, no visible windows), subscribes to the documented
Overwatch GEP features, and POSTs JSON to the user's locally hosted production suite.
It never draws over the game and has no interaction with gameplay.
