// Headless load simulator for the control panel's classic-script chain.
// Permissive DOM stub: every element access returns a "magic" proxy so null-derefs and
// DOM calls no-op — real ReferenceErrors (TDZ / missing identifiers) still throw.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'control-panel');

// The script chain is READ FROM index.html rather than hard-coded — a hand-maintained list
// silently drifts (it had gone stale by 10 files), which is the exact failure this sim exists
// to catch. Order is load order; classic scripts share one global scope.
const INDEX = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const FILES = [...INDEX.matchAll(/<script [^>]*src="([^"]+)"/gi)]
  .map((m) => m[1])
  .filter((f) => !/^(https?:)?\/\//.test(f));
if (FILES.length < 10) throw new Error('script-chain parse found only ' + FILES.length + ' files — index.html markup changed, fix this regex');

function magic() {
  const fn = function () { return m; };
  const m = new Proxy(fn, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === 'toString') return () => '';
      if (k === 'length') return 0;
      if (k === Symbol.iterator) return function* () {};
      if (k === 'then') return undefined; // don't look thenable
      // Tree-walk terminators — a truthy magic child makes `while (el.firstChild)` spin forever
      if (k === 'firstChild' || k === 'lastChild' || k === 'firstElementChild' || k === 'lastElementChild'
        || k === 'nextSibling' || k === 'nextElementSibling' || k === 'previousSibling' || k === 'previousElementSibling') return null;
      if (k === 'children' || k === 'childNodes' || k === 'rows' || k === 'options' || k === 'files') return [];
      return m;
    },
    apply() { return m; },
    construct() { return m; },
    set() { return true; },
  });
  return m;
}
const M = magic();

const sandbox = {};
const g = sandbox;
g.globalThis = g; g.window = g; g.self = g;
g.console = console;
g.document = {
  getElementById: () => M, querySelector: () => M, querySelectorAll: () => [],
  createElement: () => M, createTextNode: () => M, addEventListener: () => {},
  removeEventListener: () => {}, body: M, head: M, documentElement: M,
  activeElement: null, visibilityState: 'visible', title: '', fonts: { ready: Promise.resolve() },
};
g.location = { protocol: 'file:', hostname: '', href: 'file:///index.html', search: '', hash: '', reload: () => {} };
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.sessionStorage = g.localStorage;
g.WebSocket = class { constructor() {} send() {} close() {} };
g.WebSocket.OPEN = 1;
g.fetch = () => new Promise(() => {});
g.navigator = { clipboard: { writeText: () => Promise.resolve() }, userAgent: 'sim' };
g.Image = class { set src(_) {} };
g.FileReader = class { readAsDataURL() {} readAsText() {} };
g.MutationObserver = class { observe() {} disconnect() {} };
g.ResizeObserver = class { observe() {} disconnect() {} };
g.IntersectionObserver = class { observe() {} disconnect() {} };
g.requestAnimationFrame = () => 0;
g.cancelAnimationFrame = () => {};
g.setTimeout = () => 0;       // don't run deferred work — we only care about load-time
g.setInterval = () => 0;
g.clearTimeout = () => {}; g.clearInterval = () => {};
g.alert = () => {}; g.confirm = () => true; g.prompt = () => null;
g.getComputedStyle = () => M;
g.matchMedia = () => ({ matches: false, addEventListener: () => {}, addListener: () => {} });
g.CustomEvent = class {}; g.Event = class {}; g.KeyboardEvent = class {};
g.URL = URL; g.URLSearchParams = URLSearchParams;
g.Audio = class { play() { return Promise.resolve(); } };
g.crypto = { randomUUID: () => 'x', getRandomValues: (a) => a };
g.performance = { now: () => 0 };
g.history = { replaceState: () => {}, pushState: () => {} };
g.screen = { width: 1920, height: 1080 };
g.addEventListener = () => {}; g.removeEventListener = () => {};
g.dispatchEvent = () => true;
g.Sortable = class { constructor() {} static create() { return M; } };
g.QRCode = { toCanvas: () => {}, toDataURL: () => Promise.resolve('') };

const ctx = vm.createContext(sandbox);
for (const f of FILES) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8');
  try {
    vm.runInContext(src, ctx, { filename: f, timeout: 15000 });
    console.log('OK   ' + f);
  } catch (e) {
    console.log('FAIL ' + f + ' → ' + e.constructor.name + ': ' + e.message);
    const line = (e.stack || '').split('\n').find((l) => l.includes(f + ':'));
    if (line) console.log('     at ' + line.trim());
    break;   // everything after the failing script wouldn't run in the real renderer either
  }
}
