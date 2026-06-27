/**
 * broadcast-users-route.js
 * ─────────────────────────────────────────────────────────────────
 * Drop this file into your namelessesports.com Express server and
 * wire it up with:
 *
 *   const broadcastUsers = require('./broadcast-users-route');
 *   app.use('/api/broadcast-users', broadcastUsers);
 *
 * Env vars required on the SERVER (add to your server's .env):
 *   DATABASE_URL=<your existing Postgres connection string>
 *   BROADCAST_API_KEY=<same secret you put in the app's .env.local>
 *
 * This creates ONE new table (broadcast_users) in your existing DB.
 * It does not touch or alter any existing tables.
 *
 * Dependencies (run in your server project):
 *   npm install pg express
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const { Pool } = require('pg');
const router  = express.Router();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Create the table once on startup — safe to run every time, never destructive
pool.query(`
  CREATE TABLE IF NOT EXISTS broadcast_users (
    discord_id     TEXT        PRIMARY KEY,
    username       TEXT        NOT NULL,
    global_name    TEXT,
    discriminator  TEXT        NOT NULL DEFAULT '0',
    avatar_url     TEXT,
    first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    login_count    INTEGER     NOT NULL DEFAULT 1
  );
`).catch(err => console.error('[broadcast-users] DB init failed:', err.message));

// Simple shared-secret auth — reads the key set in the app's .env.local
function requireApiKey(req, res, next) {
  const key = (req.headers['x-api-key'] || '').trim();
  if (!key || key !== (process.env.BROADCAST_API_KEY || '').trim()) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// POST /api/broadcast-users/sync
// Called by the app every time a user completes Discord OAuth login.
// Upserts the user record and bumps last_seen_at + login_count.
router.post('/sync', requireApiKey, async (req, res) => {
  const { discordId, username, globalName, discriminator, avatarUrl } = req.body || {};

  if (!discordId || !username) {
    return res.status(400).json({ error: 'discordId and username are required' });
  }

  try {
    await pool.query(
      `INSERT INTO broadcast_users
         (discord_id, username, global_name, discriminator, avatar_url)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (discord_id) DO UPDATE SET
         username      = EXCLUDED.username,
         global_name   = EXCLUDED.global_name,
         discriminator = EXCLUDED.discriminator,
         avatar_url    = EXCLUDED.avatar_url,
         last_seen_at  = NOW(),
         login_count   = broadcast_users.login_count + 1`,
      [discordId, username, globalName || username, discriminator || '0', avatarUrl || null]
    );
    console.log(`[broadcast-users] synced ${username} (${discordId})`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[broadcast-users] sync error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/broadcast-users/search?q=... — fuzzy search by username or display name
// Called via the local server proxy so the API key never reaches the client.
router.get('/search', requireApiKey, async (req, res) => {
  const raw = (req.query.q || '').trim();
  if (!raw) return res.json({ users: [] });
  const q = `%${raw}%`;
  try {
    const result = await pool.query(
      `SELECT discord_id, username, global_name, avatar_url
       FROM broadcast_users
       WHERE username ILIKE $1 OR global_name ILIKE $1
       ORDER BY last_seen_at DESC
       LIMIT 25`,
      [q]
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error('[broadcast-users] search error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/broadcast-users — list all users (admin use, keep this behind auth)
router.get('/', requireApiKey, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT discord_id, username, global_name, first_seen_at, last_seen_at, login_count FROM broadcast_users ORDER BY last_seen_at DESC'
    );
    res.json({ users: result.rows, count: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
