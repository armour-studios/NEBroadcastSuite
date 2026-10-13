// node test/panel-bundle.test.js
// control-panel/app.js is built from control-panel/app/NN-*.js (scripts/build-panel-app.js). Fails
// when a part was edited without rebuilding, or app.js was edited by hand.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { build, parts } = require('../scripts/build-panel-app');

const have = fs.readFileSync(path.join(__dirname, '..', 'control-panel', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
assert.ok(parts().length >= 10, 'the panel source parts exist');
assert.ok(have === build(), 'control-panel/app.js matches its parts: run node scripts/build-panel-app.js (and edit the parts, not app.js)');
const html = fs.readFileSync(path.join(__dirname, '..', 'control-panel', 'index.html'), 'utf8');
assert.ok(html.includes('<script src="app.js"></script>') && !/src="app\//.test(html), 'index.html loads the one built script, not the parts');
console.log(`panel-bundle: control-panel/app.js matches its ${parts().length} parts`);
