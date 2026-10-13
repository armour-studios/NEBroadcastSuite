# Backend modules

Everything under `backend/` is required by `server.js` (which runs inside the Electron main
process) or by `main.js`. There is no separate backend entry point.

Folders:
- `cloud/` - Nameless cloud client, breaker and session.
- `integrations/` - OBS, start.gg, RL Stats API and the other platform clients.
- `director/` - the AI director and its per-game adapters.
- `scenes/overlay-editor.js` - the live overlay HTML editor behind `/api/overlay/*`.
- Single-file modules (`veto.js`, `sheets.js`, `team-db.js`, ...) are documented at the top of each file.

The Phase 1 "modular backend scaffold" (`core/`, `triggers/`, `themes/`, `scenes/scene-router.js`,
`index.js`) was removed in 2026-10: nothing required it and it had drifted from the real server.
