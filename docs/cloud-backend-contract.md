# NE Broadcast Suite — Cloud Backend Contract (Nameless)

**Status:** draft v1 · **Client:** NE Broadcast Suite (Electron desktop, by Armour Studios) · **Backend:** Nameless platform (`BROADCAST_REMOTE_URL`, e.g. `https://namelessesports.com`)

## Why this exists

Today the desktop app ships `.env.local` inside the installer, which leaks the **Twitch client secret**, **Discord client secret**, and **broadcast API key** to every user. This contract moves all secret-bearing operations **server-side onto the Nameless backend**, so the desktop app only ever holds:

- public config (Discord/Twitch **client IDs**, the backend base URL), and
- a short-lived **session token** issued by the backend.

Once the endpoints below are live and the client is pointed at them, we delete `.env.local` from `package.json → build.files` (see **Sequencing** at the end). Nothing about the current local-first behaviour changes — cloud is **additive and dormant until configured**.

It also gives us **profile sync** (store a producer's secret-free setup in the cloud, keyed to their account) and the seams for **workspaces + roles** before the full multi-tenant build.

---

## 1. Conventions

- **Base URL:** `BROADCAST_REMOTE_URL` (the app already reads this). All paths below are relative to it.
- **Transport:** HTTPS only. JSON request/response bodies.
- **App header:** every request sends `x-app: NE-Broadcast-Suite` and `x-app-version: <semver>`.
- **Auth:** `Authorization: Bearer <sessionToken>` on every authenticated call.
- **Errors:** non-2xx returns `{ "error": { "code": "string", "message": "human readable" } }`. Codes: `unauthorized`, `forbidden`, `not_found`, `validation`, `rate_limited`, `conflict`, `server_error`.
- **Time:** epoch milliseconds (numbers).
- **IDs:** opaque strings (server-generated). Treat as immutable.

## 2. Session token

A backend-issued JWT (or opaque token) with claims:

```
{ "sub": "<discordUserId>", "wid": "<workspaceId>", "role": "owner|admin|producer|operator|talent|analyst", "exp": <epochMs> }
```

- Lifetime: short (e.g. 1h access) with a **refresh token** (longer, rotating).
- The client stores the session locally in `userData/data/cloud-session.json` (already implemented client-side). It never stores Discord/Twitch **secrets** — only the session + any user-scoped third-party tokens the backend hands back.

---

## 3. Auth endpoints (move secrets server-side)

### `POST /api/auth/discord` — exchange a Discord OAuth code for a session
The desktop app runs the Discord **authorization-code flow with PKCE** using only the public `DISCORD_CLIENT_ID`, then posts the code here. The backend (holding `DISCORD_CLIENT_SECRET`) completes the exchange, upserts the user, and returns a session.

Request:
```json
{ "code": "string", "codeVerifier": "string", "redirectUri": "string" }
```
Response `200`:
```json
{
  "sessionToken": "string",
  "refreshToken": "string",
  "expiresAt": 1750000000000,
  "workspaceId": "string",
  "role": "owner",
  "user": { "discordId": "string", "username": "string", "globalName": "string", "discriminator": "0", "avatarUrl": "https://…" }
}
```
> Replaces the client-side exchange that currently uses `DISCORD_CLIENT_SECRET` (server.js Discord OAuth callback). Also subsumes the existing `POST /api/broadcast-users/sync` (the upsert happens here).

### `POST /api/auth/session/refresh`
Request: `{ "refreshToken": "string" }` → Response: same shape as `/api/auth/discord` (new token pair). Old refresh token is invalidated (rotation).

### `POST /api/auth/twitch` — link Twitch without shipping the Twitch secret
The app runs Twitch authorization-code + PKCE with the public `TWITCH_CLIENT_ID`, posts the code; the backend (holding `TWITCH_CLIENT_SECRET`) exchanges it and returns the **user-scoped** Twitch tokens for the app to use directly (chat, predictions, EventSub).

Request: `{ "code": "string", "codeVerifier": "string", "redirectUri": "string" }` (Bearer session required)
Response `200`:
```json
{ "accessToken": "string", "refreshToken": "string", "expiresAt": 1750000000000, "login": "string", "userId": "string", "scopes": ["chat:read","channel:manage:predictions","…"] }
```
- `POST /api/auth/twitch/refresh` `{ "refreshToken": "string" }` → same shape (backend holds the secret; client never does).

### `GET /api/me` (Bearer)
Returns the current session's user + workspace + role + entitlements:
```json
{ "user": { "discordId": "…", "username": "…", "avatarUrl": "…" }, "workspaceId": "…", "role": "producer", "workspaces": [ { "id": "…", "name": "…", "role": "producer" } ] }
```

---

## 4. Profile sync

A **profile** is the secret-free Producer Profile bundle the app already produces (`buildProfileBundle()` → `format: "ne-broadcast-profile"`; teams, brand kits, facecams, presets, leagues, casters, look settings — **never tokens/passwords/live scores/machine paths**). The backend stores it as an opaque blob plus metadata.

| Method & path | Purpose | Body | Returns |
|---|---|---|---|
| `GET /api/profiles` | List profiles visible to the user (own + shared in workspace) | — | `{ "profiles": [ ProfileMeta ] }` |
| `POST /api/profiles` | Create | `{ "name": "string", "bundle": { … } }` | `{ "profile": ProfileMeta }` |
| `GET /api/profiles/:id` | Fetch one (full bundle) | — | `{ "profile": ProfileMeta, "bundle": { … } }` |
| `PUT /api/profiles/:id` | Update (replace bundle and/or rename) | `{ "name"?: "string", "bundle"?: { … } }` | `{ "profile": ProfileMeta }` |
| `DELETE /api/profiles/:id` | Delete (owner/admin) | — | `204` |
| `POST /api/profiles/:id/share` | Share | `{ "scope": "workspace" \| "link" \| "private", "role"?: "viewer" \| "editor" }` | `{ "scope": "…", "shareUrl"?: "https://…", "shareToken"?: "…" }` |
| `GET /api/profiles/shared/:shareToken` | Resolve a link-shared profile | — | `{ "profile": ProfileMeta, "bundle": { … } }` |

`ProfileMeta`:
```json
{ "id": "string", "name": "string", "ownerId": "string", "workspaceId": "string",
  "scope": "private|workspace|link", "rev": 7, "updatedAt": 1750000000000, "createdAt": 1740000000000,
  "app": "NE Broadcast Suite", "format": "ne-broadcast-profile", "version": 1 }
```

Concurrency: include `rev` (monotonic). `PUT` with a stale `rev` → `409 conflict` so the client can pull-merge-retry. The bundle's merge semantics are the client's (`applyProfileBundle`): libraries merge/de-dupe, settings overwrite.

---

## 5. Workspaces, roles & sharing (forward-compatible seams)

Matches the cloud-ready data model already scaffolded in the app (`uid · workspace_id · owner_id · created_at · updated_at · rev · deleted_at`).

- **Workspace** = an org/team (e.g. a tournament organizer). A user can belong to several.
- **Roles** (per workspace): `owner`, `admin`, `producer`, `operator`, `talent`, `analyst`. The backend enforces; the client mirrors with a `can()` gate.
- **Sharing scopes:** `private` (owner only), `workspace` (all members per role), `link` (anyone with the token, read-only by default).
- Future resources beyond profiles (brand kits, teams, VDO rooms) reuse the same `/api/<resource>` + share shape.

---

## 6. Security requirements (backend)

1. **Never return Discord/Twitch client secrets** to the client. Only user-scoped third-party tokens + the Nameless session token.
2. TLS 1.2+. HSTS. Reject non-HTTPS.
3. Session tokens short-lived; refresh tokens rotate and are revocable. `DELETE /api/auth/session` to log out (revokes refresh).
4. Rate-limit auth + write endpoints. Return `429 rate_limited` with `Retry-After`.
5. Validate `bundle.format === "ne-broadcast-profile"` and size-cap (e.g. ≤ 5 MB; brand/logo base64 can be large).
6. Scope every query by `workspaceId` from the token — never trust a client-supplied workspace id for authorization.
7. Audit log auth + share events.

---

## 7. Client surface (already implemented, dormant)

`backend/cloud/cloud-client.js` implements the client half: `loginWithDiscord`, `linkTwitch`, `me`, `listProfiles`, `getProfile`, `saveProfile`, `deleteProfile`, session persistence, graceful no-op when `BROADCAST_REMOTE_URL` is unset. Server WS messages (dormant until configured): `cloud_status`, `cloud_list_profiles`, `cloud_push_profile`, `cloud_pull_profile`.

---

## 8. Sequencing — safely removing the shipped secrets

1. **Backend:** implement §3 (auth) + §4 (profiles). Keep the existing `/api/broadcast-users/*` working during transition.
2. **Client:** switch the Discord login + Twitch link to call `/api/auth/*` (PKCE; no client secret). Cloud profile sync goes live (UI: "Sync to cloud" / "Load from cloud" in the Producer Profile section).
3. **Verify** on a staging `BROADCAST_REMOTE_URL` that login + Twitch + profile sync work with **no secrets in `.env.local`**.
4. **Flip:** delete `.env.local` from `package.json → build.files`; remove `TWITCH_CLIENT_SECRET` / `DISCORD_CLIENT_SECRET` reads from the client. Ship. The only client config left is public (client IDs + backend URL), which is safe to bundle or fetch from `GET /api/config`.

Until step 4, behaviour is unchanged and the cloud layer is inert unless `BROADCAST_REMOTE_URL` is set.
