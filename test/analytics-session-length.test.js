'use strict';
// Broadcast sessions can't outlast the app running them: a session left open when the app closed
// ends at its last tracked second, and old sessions finalized at restart time are cut back.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-analytics-'));
const H = 3600 * 1000;
const t0 = Date.now() - 50 * H;
fs.writeFileSync(path.join(dir, 'analytics.json'), JSON.stringify({
  auto: true,
  sessions: [
    // Finalized at restart: 48h long, but the app only ran it for 3h.
    { id: 'old', label: 'Old', startedAt: t0, endedAt: t0 + 48 * H, durationSec: 48 * 3600, sceneTime: { 'In Game': 2 * 3600, Casters: 3600 } },
    // A genuinely long show stays as it is.
    { id: 'long', label: 'Long', startedAt: t0, endedAt: t0 + 7 * H, durationSec: 7 * 3600, sceneTime: { 'In Game': 7 * 3600 - 20 } },
  ],
  // Crash leftover: started 50h ago, tracked for 2h, last seen 2h after start.
  live: { id: 'crash', active: true, label: 'Crash', startedAt: t0, endedAt: null, lastSeenAt: t0 + 2 * H, viewerSamples: [{ t: t0 + H, v: 10 }],
    sceneTime: { 'In Game': 2 * 3600 }, segmentTime: {}, segViewerSum: {}, ads: { count: 0, totalSec: 0 }, disconnects: [] },
}));

const analytics = require('../backend/analytics');
analytics.init({ dataDir: dir, getState: () => ({}) });
const saved = JSON.parse(fs.readFileSync(path.join(dir, 'analytics.json'), 'utf8'));
const byId = Object.fromEntries(saved.sessions.map((s) => [s.id, s]));

assert.ok(byId.crash, 'the crash leftover is kept as a session');
assert.strictEqual(byId.crash.durationSec, 2 * 3600, 'crash session ends when it was last tracked, not at restart');
assert.strictEqual(byId.old.durationSec, 3 * 3600, 'an old restart-length session is cut back to its tracked time');
assert.strictEqual(byId.old.repaired, true);
assert.strictEqual(byId.long.durationSec, 7 * 3600, 'a real long show is untouched');
assert.ok(!byId.long.repaired);
assert.strictEqual(saved.live, null);

fs.rmSync(dir, { recursive: true, force: true });
console.log('analytics-session-length: all assertions passed');
process.exit(0);
