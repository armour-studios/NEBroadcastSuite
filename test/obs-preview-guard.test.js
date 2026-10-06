// node test/obs-preview-guard.test.js
//
// Guards the rule that an OBS Browser Source never renders ?preview=1 sample data by accident:
//   1. Only OBS's embedded browser is redirected — a producer's own browser keeps the preview.
//   2. preview (any value) and thumb are stripped; every other param survives byte-for-byte.
//   3. &inobs=1 is the deliberate opt-in for sample data inside OBS.
'use strict';
const assert = require('assert');
const { isObsBrowser, obsPreviewRedirect } = require('../backend/obs-preview-guard');

const OBS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.120 Safari/537.36 OBS/31.0.3';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

assert.strictEqual(isObsBrowser(OBS), true);
assert.strictEqual(isObsBrowser(CHROME), false);
assert.strictEqual(isObsBrowser(undefined), false);

// A normal browser is never redirected.
assert.strictEqual(obsPreviewRedirect('/duorow.html?preview=1', CHROME), null);
// OBS with a live URL is served as-is.
assert.strictEqual(obsPreviewRedirect('/duorow.html', OBS), null);
assert.strictEqual(obsPreviewRedirect('/duorow.html?bg=000000&bgop=50', OBS), null);

// OBS with a preview URL is sent to the live one.
assert.strictEqual(obsPreviewRedirect('/duorow.html?preview=1', OBS), '/duorow.html');
assert.strictEqual(obsPreviewRedirect('/duorow.html?preview=true', OBS), '/duorow.html');
assert.strictEqual(obsPreviewRedirect('/stream-credits.html?preview', OBS), '/stream-credits.html');
assert.strictEqual(obsPreviewRedirect('/?preview=1', OBS), '/');
assert.strictEqual(obsPreviewRedirect('/schedule.html?preview=1&thumb=1&layout=board', OBS), '/schedule.html?layout=board');
// Other params are left exactly as written (bare flags, encoding, order).
assert.strictEqual(
  obsPreviewRedirect('/ministation.html?stream=Main%20Stage&preview=1&cover&bg=0a0a0a', OBS),
  '/ministation.html?stream=Main%20Stage&cover&bg=0a0a0a');
// A param that merely contains the word is not the preview flag.
assert.strictEqual(obsPreviewRedirect('/x.html?previewer=1', OBS), null);

// Explicit opt-in keeps sample data inside OBS.
assert.strictEqual(obsPreviewRedirect('/fn-dropmap.html?preview=1&inobs=1', OBS), null);

console.log('obs-preview-guard: ok');
