'use strict';
// Home page content from the website: every URL must be https, text is clipped, and a signed-out
// or different user never sees the cached "me" data.
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../backend/site-home');

test('cleanHome keeps https only and drops broken rows', () => {
  const h = S.cleanHome({
    hero: { title: 'Hi', ctas: [{ label: 'Go', url: 'javascript:alert(1)' }, { label: 'Ok', url: 'https://a.com' }] },
    events: [{ name: 'Cup', url: 'http://insecure' }, { name: 'Open', url: 'https://start.gg/x', image: 'file:///c:/x.png', startAt: 5 }],
    news: [{ title: 'x'.repeat(500), url: 'https://n.com' }],
    partners: [{ name: 'P', url: 'https://p.com', logo: '/images/p.png' }],
  });
  assert.deepStrictEqual(h.hero.ctas.map((c) => c.label), ['Ok']);
  assert.deepStrictEqual(h.events.map((e) => e.name), ['Open']);
  assert.strictEqual(h.events[0].image, '');
  assert.strictEqual(h.news[0].title.length, 160);
  assert.strictEqual(h.partners[0].logo, '');
  assert.strictEqual(S.cleanHome({ hero: { title: '' } }).hero, null);
});

test('me data is per user and hidden when signed out', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitehome-'));
  let signed = true, uid = 'u1';
  const sh = S.create({
    getDataDir: () => dir,
    fetchHome: async () => ({ home: { hero: { title: 'T' } } }),
    fetchMe: async () => ({ me: { communities: [{ name: 'NE', url: 'https://x.com/c', role: 'owner' }], events: {} } }),
    isSignedIn: () => signed,
    userId: () => uid,
  });
  await sh.refreshHome();
  await sh.refreshMe();
  assert.strictEqual(sh.snapshot().me.communities[0].name, 'NE');
  uid = 'u2';
  assert.strictEqual(sh.snapshot().me, null, 'another account never sees the cached communities');
  uid = 'u1'; signed = false;
  assert.strictEqual(sh.snapshot().me, null);
  assert.strictEqual(sh.snapshot().home.hero.title, 'T', 'public content still shows signed out');
  const err = Object.assign(new Error('nf'), { status: 404 });
  signed = true;
  const sh2 = S.create({ getDataDir: () => dir, fetchHome: async () => ({}), fetchMe: async () => { throw err; }, isSignedIn: () => true, userId: () => 'u1' });
  assert.strictEqual(await sh2.refreshMe(), false, 'a site without the route is not an outage');
  assert.strictEqual(sh2.snapshot().meError, 'not-available');
});
