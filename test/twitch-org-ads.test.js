// node test/twitch-org-ads.test.js
// Ads on the organization's channel (backend/http/twitch-channel.js, target 'org'): an editor's own
// Twitch token cannot run ads on someone else's channel, so these go through the website with the
// channel owner's permission. They keep every ad gate: producer click only (never a flow), the
// Ads on/off switch, and only for a real organization workspace.
'use strict';
const assert = require('assert');
const express = require('express');
const http = require('http');
let pass = 0;
const ok = (c, why) => { assert.ok(c, why); pass++; };

const calls = [];
let session = { workspaceId: 'org_1' }, authed = true;
const cloud = {
  authed: () => authed,
  getSession: () => session,
  orgAdsStatus: async (orgId) => { calls.push(['status', orgId]); return { channel: { login: 'namelessesports', displayName: 'NamelessEsports' }, canSnooze: true, schedule: { nextAdAt: null } }; },
  orgAdRun: async (orgId, length) => { calls.push(['run', orgId, length]); return { ok: true, channel: 'namelessesports', length, retryAfter: 480 }; },
  orgAdSnooze: async (orgId) => { calls.push(['snooze', orgId]); return { ok: true, channel: 'namelessesports', snoozeCount: 2 }; },
};
const state = { twitch: { connected: false, displayName: 'editor_jo', adsEnabled: true } };
const app = express();
app.use(express.json());
require('../backend/http/twitch-channel')({
  app, bridgeClients: new Set(), broadcast() {}, broadcastFullState() {}, buildLiveState: () => ({}), chatManager: {},
  cloud, saveTwitchData() {}, state, get twitchClient() { return null; }, set twitchClient(v) {},
});

const server = http.createServer(app).listen(0, async () => {
  const port = server.address().port;
  const req = (method, path, body, headers) => new Promise((resolve) => {
    const r = http.request({ port, path, method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) }, (res) => {
      let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(t || '{}') }));
    });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
  try {
    let r = await req('GET', '/api/twitch/ad/org-status');
    ok(r.body.available && r.body.channel.login === 'namelessesports' && r.body.mine === 'editor_jo', 'status names our channel and mine');

    r = await req('POST', '/api/twitch/ad/run', { length: 90, target: 'org' });
    ok(r.status === 200 && r.body.success && calls.some((c) => c[0] === 'run' && c[1] === 'org_1' && c[2] === 90), 'runs on the org channel through the website, without this app being connected to Twitch');

    r = await req('POST', '/api/twitch/ad/run', { length: 90, target: 'org' }, { 'x-ne-flow': '1' });
    ok(r.status === 403, 'a flow cannot run an ad on the org channel');

    state.twitch.adsEnabled = false;
    const before = calls.length;
    r = await req('POST', '/api/twitch/ad/run', { length: 60, target: 'org' });
    ok(r.status === 409 && calls.length === before, 'Ads off blocks the org channel too');
    state.twitch.adsEnabled = true;

    r = await req('POST', '/api/twitch/ad/run', { length: 999, target: 'org' });
    ok(calls[calls.length - 1][2] === 30, 'an odd length falls back to 30s');

    r = await req('POST', '/api/twitch/ad/snooze', { target: 'org' });
    ok(r.status === 200 && calls.some((c) => c[0] === 'snooze'), 'snooze goes to the org channel');

    session = { workspaceId: 'user:abc' };
    r = await req('POST', '/api/twitch/ad/run', { length: 60, target: 'org' });
    ok(r.status === 400 && /organization/.test(r.body.error), 'a personal workspace has no org channel');
    r = await req('GET', '/api/twitch/ad/org-status');
    ok(!r.body.available, 'status says so');

    r = await req('POST', '/api/twitch/ad/run', { length: 60 });
    ok(r.status === 400 && /not connected/.test(r.body.error), 'my-channel ads still need this app connected to Twitch');
    console.log('twitch-org-ads: ' + pass + ' checks passed');
  } catch (e) { console.error(e); process.exitCode = 1; }
  server.close();
});
