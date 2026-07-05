#!/usr/bin/env node
/**
 * release.js — load GH_TOKEN from .env.local then run electron-builder --publish always.
 * Called by the `release` npm script so the token never has to be set manually in the shell.
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root    = path.join(__dirname, '..');
const envPath = path.join(root, '.env.local');

if (!fs.existsSync(envPath)) {
  console.error('[release] .env.local not found — cannot publish.');
  process.exit(1);
}

// Parse .env.local and inject into process.env (only for this process + children).
for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq < 0) continue;
  const key = line.slice(0, eq).trim();
  let val   = line.slice(eq + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
  process.env[key] = val;
}

if (!process.env.GH_TOKEN) {
  console.error('[release] GH_TOKEN not found in .env.local — add it to publish to GitHub Releases.');
  process.exit(1);
}

console.log('[release] GH_TOKEN loaded — running electron-builder --publish always');

const eb = path.join(root, 'node_modules', '.bin', 'electron-builder');
const result = spawnSync(eb, ['--win', 'nsis', '--publish', 'always'], {
  stdio: 'inherit',
  env:   process.env,
  cwd:   root,
  shell: true,
});
process.exit(result.status ?? 1);
