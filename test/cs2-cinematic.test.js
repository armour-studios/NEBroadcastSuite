// CS2 scripted freezetime camera: netcon client + cinematic scheduler against a fake CS2 console.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { createNetcon } = require('../backend/cs2-netcon');
const { createCinematic, starterShots, poseAt, POSE_RE } = require('../backend/cs2-cinematic');

// Fake CS2 console: records every line, answers getpos like the game does.
function fakeConsole() {
  return new Promise((resolve) => {
    const lines = [];
    const srv = net.createServer((c) => {
      c.setEncoding('utf8');
      let buf = '';
      c.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          lines.push(line);
          if (line === 'getpos') c.write('setpos 123.45 -678.90 64.03;setang 2.31 -91.07 0.00\n');
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, lines, port: srv.address().port }));
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) return false; await wait(20); } return true; }

test('starter shots exist for the competitive maps and look at the site', () => {
  for (const m of ['de_ancient', 'de_anubis', 'de_dust2', 'de_inferno', 'de_mirage', 'de_nuke', 'de_train', 'de_overpass']) {
    const shots = starterShots(m);
    assert.strictEqual(shots.length, 2, m);
    for (const s of shots) {
      assert.ok(s.from.pitch > 30 && s.from.pitch < 70, m + ' looks down at the site');
      assert.ok(Number.isFinite(s.to.yaw));
    }
  }
  assert.deepStrictEqual(starterShots('de_unknown'), []);
});

test('poseAt eases from start to end and takes the short way round on yaw', () => {
  const shot = { from: { x: 0, y: 0, z: 0, pitch: 0, yaw: 170 }, to: { x: 100, y: 0, z: 0, pitch: 10, yaw: -170 } };
  assert.strictEqual(poseAt(shot, 0).x, 0);
  assert.strictEqual(poseAt(shot, 1).x, 100);
  assert.ok(Math.abs(poseAt(shot, 0.5).yaw - 180) < 0.01, 'crosses 180 instead of sweeping 340 degrees');
});

test('getpos output parses into a pose', () => {
  const m = POSE_RE.exec('setpos 123.45 -678.90 64.03;setang 2.31 -91.07 0.00');
  assert.ok(m);
  assert.strictEqual(+m[2], -678.9);
});

test('freezetime plays spec_goto moves over netcon, then hands back before live', async (t) => {
  const fc = await fakeConsole();
  const statuses = [];
  const nc = createNetcon({ onStatus: (s) => statuses.push(s) });
  t.after(() => { nc.stop(); fc.srv.close(); });
  nc.start(fc.port);
  assert.ok(await until(() => nc.isConnected()), 'connects to the console');

  let returned = 0;
  const cfg = { enabled: true, port: fc.port, shots: {} };
  const cine = createCinematic({ netcon: nc, getConfig: () => cfg, onReturn: () => { returned++; } });

  cine.onCsgo({ phase: 'live', map: { name: 'de_mirage', phase: 'live' } });
  cine.onCsgo({ phase: 'freezetime', phaseEndsIn: 5, map: { name: 'de_mirage', phase: 'live' } });   // 3.5s window
  assert.ok(cine.isPlaying());
  await wait(1200);
  const gotos = fc.lines.filter((l) => l.startsWith('spec_goto '));
  assert.ok(gotos.length > 15, 'streams poses (~30/sec), got ' + gotos.length);
  assert.match(gotos[0], /^spec_goto -?[\d.]+ -?[\d.]+ -?[\d.]+ -?[\d.]+ -?[\d.]+$/);
  assert.ok(await until(() => !cine.isPlaying(), 4000), 'stops at the end of the window');
  assert.strictEqual(returned, 1, 'hands back to a player once');

  // Round goes live early (e.g. freezetime cut short): stop and hand back immediately.
  cine.onCsgo({ phase: 'live', map: { name: 'de_mirage', phase: 'live' } });
  cine.onCsgo({ phase: 'freezetime', phaseEndsIn: 20, map: { name: 'de_mirage', phase: 'live' } });
  assert.ok(cine.isPlaying());
  cine.onCsgo({ phase: 'live', map: { name: 'de_mirage', phase: 'live' } });
  assert.ok(!cine.isPlaying());
  assert.strictEqual(returned, 2);

  // Warmup freezetime never triggers.
  cine.onCsgo({ phase: 'live', map: { name: 'de_mirage', phase: 'warmup' } });
  cine.onCsgo({ phase: 'freezetime', phaseEndsIn: 20, map: { name: 'de_mirage', phase: 'warmup' } });
  assert.ok(!cine.isPlaying());

  // Disabled: nothing plays.
  cfg.enabled = false;
  cine.onCsgo({ phase: 'live', map: { name: 'de_mirage', phase: 'live' } });
  cine.onCsgo({ phase: 'freezetime', phaseEndsIn: 20, map: { name: 'de_mirage', phase: 'live' } });
  assert.ok(!cine.isPlaying());

  // Capture reads the camera pose back through getpos.
  const pose = await cine.capturePose();
  assert.deepStrictEqual(pose, { x: 123.5, y: -678.9, z: 64, pitch: 2.3, yaw: -91.1 });

  // A captured shot replaces the starter for that slot.
  cfg.shots.de_mirage = [{ name: 'Mine', from: pose, to: pose }];
  assert.strictEqual(cine.shotsFor('de_mirage')[0].name, 'Mine');
  assert.strictEqual(cine.shotsFor('de_mirage')[1].name, 'B site');

  nc.stop();
  assert.strictEqual(nc.isConnected(), false);
});

test('netcon keeps retrying until CS2 opens the console', async (t) => {
  const probe = net.createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; probe.close();
  const nc = createNetcon({});
  t.after(() => nc.stop());
  nc.start(port);                       // nothing listening yet
  await wait(300);
  assert.strictEqual(nc.isConnected(), false);
  assert.strictEqual(nc.send('echo hi'), false, 'send is a no-op while disconnected');
  const srv = net.createServer(() => {}); await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  assert.ok(await until(() => nc.isConnected(), 5000), 'connects once the console appears');
  nc.stop(); srv.close();
});
