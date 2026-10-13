// The source of server.js plus every module split out of it (refactor step 3), joined, for tests
// that look code up by name or text. Split-out modules carry the header marker
// "moved out of server.js" and keep their original indentation, so lookups such as
// indexOf('\nfunction name(') keep working wherever the code lives now.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const MARKER = 'moved out of server.js';

function splitOutFiles() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.js')) {
        const head = fs.readFileSync(path.join(root, rel), 'utf8').slice(0, 600);
        if (head.includes(MARKER)) out.push(rel);
      }
    }
  })('backend');
  return out.sort();
}
function serverSource() {
  return ['server.js'].concat(splitOutFiles()).map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n').replace(/\r\n/g, '\n');
}
module.exports = { serverSource, splitOutFiles };
