// The promo strip feed: everything the website sends is re-validated before the control panel
// may render it, and a missing/old/disabled feed means NO strip (never an error).
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { sanitize, create } = require('../backend/promos.js');

const good = { id: 'a', kind: 'nameless', label: 'Nameless', text: 'Hello', cta: 'Go', url: 'https://example.com/x' };
const now = Date.now();
const out = sanitize([
  good,
  { ...good, id: 'bad-url', url: 'javascript:alert(1)' },
  { ...good, id: 'http', url: 'http://example.com' },
  { ...good, id: 'sponsor-no-label', kind: 'sponsor', label: '' },
  { ...good, id: 'sponsor-ok', kind: 'sponsor', label: 'Acme' },
  { ...good, id: 'future', startsAt: new Date(now + 3600e3).toISOString() },
  { ...good, id: 'expired', endsAt: new Date(now - 3600e3).toISOString() },
  { ...good, id: 'bad-kind', kind: 'ad' },
  { ...good, id: 'logo', logoUrl: 'file:///etc/passwd' },
  { ...good, id: 'long', text: 'x'.repeat(500), weight: 99 },
  null, 'nope', {}
]);
assert.deepStrictEqual(out.map((p) => p.id), ['a', 'sponsor-ok', 'logo', 'long']);
assert.strictEqual(out.find((p) => p.id === 'logo').logoUrl, '', 'non-https logo dropped, campaign kept');
assert.strictEqual(out.find((p) => p.id === 'long').text.length, 140);
assert.strictEqual(out.find((p) => p.id === 'long').weight, 10);
assert.deepStrictEqual(sanitize(undefined), []);
assert.strictEqual(sanitize(new Array(50).fill(good)).length, 12, 'capped');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promos-'));
  let calls = 0;
  const p = create({ getDataDir: () => dir, fetchFeed: async () => { calls++; return { promos: [good] }; } });
  assert.deepStrictEqual(p.list(), [], 'nothing before the first fetch');
  await p.refresh();
  assert.strictEqual(p.list().length, 1);
  await new Promise((r) => setTimeout(r, 100));
  // a fresh process reads the cache from disk
  const p2 = create({ getDataDir: () => dir, fetchFeed: async () => { throw new Error('offline'); } });
  assert.strictEqual(p2.list().length, 1, 'cached feed survives a restart');
  await assert.rejects(() => p2.refresh(), /offline/);
  assert.strictEqual(p2.list().length, 1, 'a failed refresh keeps the last good list');
  // stale cache (> 7 days) is not shown
  fs.writeFileSync(path.join(dir, 'promos.json'), JSON.stringify({ promos: [good], fetchedAt: now - 8 * 864e5 }));
  assert.deepStrictEqual(create({ getDataDir: () => dir, fetchFeed: async () => ({}) }).list(), []);
  // white-label builds: no fetch, no list
  process.env.NE_PROMOS = '0';
  const off = create({ getDataDir: () => dir, fetchFeed: async () => { calls++; return { promos: [good] }; } });
  const before = calls;
  assert.strictEqual(await off.refresh(), false);
  assert.strictEqual(calls, before, 'disabled build never fetches');
  assert.deepStrictEqual(off.list(), []);
  delete process.env.NE_PROMOS;
  console.log('promos: ok');
})().catch((e) => { console.error(e); process.exit(1); });
