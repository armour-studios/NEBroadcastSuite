// Pre-build step: keep the packed Stream Deck plugin that ships inside the app
// (streamdeck-plugin/dist, served from /api/integrations/streamdeck-plugin) current.
// Falls back to the committed dist artifact if the toolchain isn't available, so a
// build machine without the plugin's node_modules still produces a full installer.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'streamdeck-plugin');
const dist = path.join(dir, 'dist', 'nebroadcaststudio.streamDeckPlugin');
const run = (cmd) => execSync(cmd, { cwd: dir, stdio: 'inherit' });

try {
  if (!fs.existsSync(dir)) throw new Error('streamdeck-plugin/ missing');
  if (!fs.existsSync(path.join(dir, 'node_modules'))) run('npm ci');
  run('npm run build');
  run('npm run pack');
  console.log('[streamdeck] plugin rebuilt and packed for bundling.');
} catch (e) {
  if (fs.existsSync(dist)) {
    console.warn('[streamdeck] rebuild failed - shipping the existing packed plugin. (' + e.message + ')');
  } else {
    console.error('[streamdeck] rebuild failed and no packed plugin exists: ' + e.message);
    process.exit(1);
  }
}
