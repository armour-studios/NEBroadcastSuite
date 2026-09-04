// node test/cloud-breaker.test.js
//
// Pins the shared cloud circuit breaker (backend/cloud/cloud-client.js). It is what makes every
// background poll back off together, so its rules are worth holding still:
//   - a CALLER error (401) must not suspend the whole app's cloud traffic
//   - a 5xx or an unreachable backend must, with growing backoff
//   - an explicit Retry-After beats our own guess (the rate-limit case that took the site down once)
//   - one success closes it immediately
'use strict';
const http = require('http');
const path = require('path');
const cloud = require(path.join(__dirname, '..', 'backend', 'cloud', 'cloud-client'));

let mode = '401';
let failures = 0;
const srv = http.createServer((req, res) => {
  const send = (code, body, headers) => {
    res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, headers || {}));
    res.end(body);
  };
  if (mode === '401') return send(401, '{"error":{"message":"Sign in required"}}');
  if (mode === '500') return send(500, '{"error":{"message":"boom"}}');
  if (mode === '429') return send(429, '{"error":{"message":"rate limited"}}', { 'Retry-After': '37' });
  send(200, '{"ok":true}');
});

function ck(label, cond) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label);
  if (!cond) failures++;
}

srv.listen(0, async () => {
  cloud.init({ baseUrl: 'http://127.0.0.1:' + srv.address().port, appVersion: '0.0.0-test' });

  mode = '401';
  await cloud.me().catch(() => {});
  ck('401 does not suspend background work', cloud.retryInMs() === 0 && cloud.health().healthy === true);

  mode = '500';
  await cloud.me().catch(() => {});
  const first = cloud.retryInMs();
  ck('500 opens the breaker', first > 0);
  await cloud.me().catch(() => {});
  const second = cloud.retryInMs();
  ck('backoff grows on the 2nd consecutive failure (' + first + 'ms -> ' + second + 'ms)', second > first);
  ck('health reports the failure count + status', cloud.health().consecutiveFailures === 2 && cloud.health().lastStatus === 500);

  mode = '200';
  await cloud.me().catch(() => {});
  ck('a successful call closes the breaker', cloud.retryInMs() === 0 && cloud.health().healthy === true);

  mode = '429';
  await cloud.me().catch(() => {});
  const ra = cloud.retryInMs();
  ck('429 honours Retry-After: 37 (got ~' + Math.round(ra / 1000) + 's after jitter)', ra > 30000 && ra < 45000);

  mode = '200';
  await cloud.me().catch(() => {});
  srv.close();
  await cloud.me().catch(() => {});
  ck('unreachable backend opens the breaker', cloud.retryInMs() > 0);

  console.log(failures ? '\n' + failures + ' FAILED' : '\nall passed');
  process.exit(failures ? 1 : 0);
});
