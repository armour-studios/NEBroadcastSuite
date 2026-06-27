# Cloud Backend — Reference Implementation (Postgres)

Companion to [`cloud-backend-contract.md`](./cloud-backend-contract.md). This is **backend** code for the Nameless API that lives at `BROADCAST_REMOTE_URL` — it is **not** part of the desktop app. The desktop app only makes HTTPS calls to these routes; **the routes are what read/write your Postgres database.** The app never connects to Postgres directly.

> Data path: **NE Broadcast Suite (desktop)** → HTTPS `BROADCAST_REMOTE_URL/api/...` → **this Express/Node service** → **Postgres**.

## 1. Postgres schema

```sql
-- Workspaces (an org / tournament organizer). Users may belong to several.
CREATE TABLE workspaces (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Users, keyed by Discord identity.
CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id   text UNIQUE NOT NULL,
  username     text,
  global_name  text,
  avatar_url   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Workspace membership + role.
CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'producer'
               CHECK (role IN ('owner','admin','producer','operator','talent','analyst')),
  PRIMARY KEY (workspace_id, user_id)
);

-- Producer profiles — the secret-free bundle (format = 'ne-broadcast-profile').
CREATE TABLE profiles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  scope        text NOT NULL DEFAULT 'private' CHECK (scope IN ('private','workspace','link')),
  share_token  text UNIQUE,             -- set when scope = 'link'
  rev          integer NOT NULL DEFAULT 1,
  bundle       jsonb NOT NULL,          -- the validated profile bundle
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz             -- soft delete
);
CREATE INDEX profiles_ws_idx ON profiles(workspace_id) WHERE deleted_at IS NULL;

-- Refresh tokens (rotating). Access/session tokens are stateless JWTs.
CREATE TABLE auth_refresh_tokens (
  token_hash   text PRIMARY KEY,        -- store a hash, never the raw token
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
```

## 2. Auth — `POST /api/auth/discord` (secrets stay here)

The desktop app runs Discord OAuth (PKCE, public client id) and posts the `code`. **This service** holds `DISCORD_CLIENT_SECRET` and completes the exchange — so the secret never ships in the installer.

```js
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const axios = require('axios');
const pool = new Pool();                       // DATABASE_URL from env (your Postgres)

const JWT_SECRET = process.env.JWT_SECRET;     // backend-only
const ACCESS_TTL_MS = 60 * 60 * 1000;          // 1h

function issueSession(user, workspaceId, role) {
  const exp = Date.now() + ACCESS_TTL_MS;
  const sessionToken = jwt.sign({ sub: user.discord_id, wid: workspaceId, role, exp: Math.floor(exp / 1000) }, JWT_SECRET);
  const refreshToken = crypto.randomBytes(32).toString('hex');
  return { sessionToken, refreshToken, expiresAt: exp };
}

app.post('/api/auth/discord', async (req, res) => {
  const { code, codeVerifier, redirectUri } = req.body || {};
  try {
    // 1) Exchange the code with Discord (secret used ONLY here).
    const tok = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code, redirect_uri: redirectUri, code_verifier: codeVerifier
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const me = (await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tok.data.access_token}` }
    })).data;

    // 2) Upsert the user.
    const avatarUrl = me.avatar
      ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128`
      : `https://cdn.discordapp.com/embed/avatars/0.png`;
    const { rows: [user] } = await pool.query(
      `INSERT INTO users (discord_id, username, global_name, avatar_url)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (discord_id) DO UPDATE
         SET username=$2, global_name=$3, avatar_url=$4, updated_at=now()
       RETURNING *`,
      [me.id, me.username, me.global_name || me.username, avatarUrl]
    );

    // 3) Ensure a personal workspace + membership (owner).
    let { rows: [m] } = await pool.query(
      `SELECT workspace_id, role FROM workspace_members WHERE user_id=$1 ORDER BY role='owner' DESC LIMIT 1`, [user.id]);
    if (!m) {
      const { rows: [ws] } = await pool.query(
        `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [`${user.username}'s workspace`]);
      await pool.query(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner')`, [ws.id, user.id]);
      m = { workspace_id: ws.id, role: 'owner' };
    }

    // 4) Issue + persist a session.
    const s = issueSession(user, m.workspace_id, m.role);
    await pool.query(
      `INSERT INTO auth_refresh_tokens (token_hash,user_id,workspace_id,expires_at)
       VALUES ($1,$2,$3, now() + interval '30 days')`,
      [crypto.createHash('sha256').update(s.refreshToken).digest('hex'), user.id, m.workspace_id]);

    res.json({ ...s, workspaceId: m.workspace_id, role: m.role,
      user: { discordId: user.discord_id, username: user.username, globalName: user.global_name, avatarUrl: user.avatar_url } });
  } catch (e) {
    res.status(400).json({ error: { code: 'validation', message: 'Discord auth failed' } });
  }
});

// Bearer middleware for the routes below.
function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  try { req.session = jwt.verify(t, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: { code: 'unauthorized', message: 'Invalid session' } }); }
}
```

`POST /api/auth/twitch` mirrors this: exchange `code` with `https://id.twitch.tv/oauth2/token` using `TWITCH_CLIENT_SECRET` (held here), return the user-scoped Twitch tokens. `POST /api/auth/session/refresh` looks up the hashed refresh token, rotates it, re-issues.

## 3. Profiles — CRUD against Postgres

```js
// userId by discord_id from the session.
async function userId(discordId) {
  const { rows: [u] } = await pool.query(`SELECT id FROM users WHERE discord_id=$1`, [discordId]);
  return u && u.id;
}

app.get('/api/profiles', auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id,name,owner_id,workspace_id,scope,rev,
            extract(epoch from updated_at)*1000 AS "updatedAt",
            extract(epoch from created_at)*1000 AS "createdAt"
       FROM profiles
      WHERE workspace_id=$1 AND deleted_at IS NULL
      ORDER BY updated_at DESC`, [req.session.wid]);
  res.json({ profiles: rows.map(r => ({ ...r, app:'NE Broadcast Suite', format:'ne-broadcast-profile', version:1 })) });
});

app.post('/api/profiles', auth, async (req, res) => {
  const { name, bundle } = req.body || {};
  if (!bundle || bundle.format !== 'ne-broadcast-profile') return res.status(400).json({ error:{ code:'validation', message:'bad bundle' } });
  const owner = await userId(req.session.sub);
  const { rows: [p] } = await pool.query(
    `INSERT INTO profiles (workspace_id,owner_id,name,bundle) VALUES ($1,$2,$3,$4) RETURNING id,rev`,
    [req.session.wid, owner, name || 'Profile', bundle]);
  res.json({ profile: { id: p.id, name, rev: p.rev } });
});

app.get('/api/profiles/:id', auth, async (req, res) => {
  const { rows: [p] } = await pool.query(
    `SELECT id,name,scope,rev,bundle, extract(epoch from updated_at)*1000 AS "updatedAt"
       FROM profiles WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL`,
    [req.params.id, req.session.wid]);
  if (!p) return res.status(404).json({ error:{ code:'not_found', message:'no profile' } });
  res.json({ profile: { id:p.id, name:p.name, scope:p.scope, rev:p.rev, updatedAt:p.updatedAt, app:'NE Broadcast Suite', format:'ne-broadcast-profile', version:1 }, bundle: p.bundle });
});

app.put('/api/profiles/:id', auth, async (req, res) => {
  const { name, bundle } = req.body || {};
  const { rows: [p] } = await pool.query(
    `UPDATE profiles SET
        name = COALESCE($3, name),
        bundle = COALESCE($4, bundle),
        rev = rev + 1, updated_at = now()
      WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL
      RETURNING id,name,rev`,
    [req.params.id, req.session.wid, name || null, bundle || null]);
  if (!p) return res.status(404).json({ error:{ code:'not_found', message:'no profile' } });
  res.json({ profile: p });
});

app.delete('/api/profiles/:id', auth, async (req, res) => {
  await pool.query(`UPDATE profiles SET deleted_at=now() WHERE id=$1 AND workspace_id=$2`, [req.params.id, req.session.wid]);
  res.status(204).end();
});
```

`POST /api/profiles/:id/share` sets `scope` and, for `link`, a random `share_token`; `GET /api/profiles/shared/:token` returns the bundle for link-shared profiles (no auth).

## 4. Notes for migration

- **Existing `x-api-key` routes** (`/api/broadcast-users/sync`/`search`) keep working during transition. New routes use **per-user Bearer sessions** (profiles are per-user; a shared key can't scope them).
- The desktop client (`backend/cloud/cloud-client.js`) already sends `Authorization: Bearer <session>` and persists the session locally — it needs no changes once these routes exist.
- After verifying login + profile sync on staging with an **empty `.env.local`**, remove `.env.local` from `package.json → build.files` and drop the client-side `TWITCH_CLIENT_SECRET`/`DISCORD_CLIENT_SECRET` reads (contract §8).
