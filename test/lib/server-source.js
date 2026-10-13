// The source of server.js plus every module split out of it (refactor step 3), joined, for tests
// that look code up by name or text. Split-out code keeps its original indentation, so lookups such
// as indexOf('\nfunction name(') keep working wherever the code lives now.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
// Folders that hold code moved out of server.js. A new split-out folder goes here.
const SPLIT_DIRS = ['backend/twitch', 'backend/flows', 'backend/platforms'];

function serverSource() {
  const files = ['server.js'];
  for (const d of SPLIT_DIRS) {
    const abs = path.join(root, d);
    if (fs.existsSync(abs)) fs.readdirSync(abs).filter((f) => f.endsWith('.js')).sort().forEach((f) => files.push(path.join(d, f)));
  }
  return files.map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n').replace(/\r\n/g, '\n');
}
module.exports = { serverSource, SPLIT_DIRS };
