// node test/tour-targets.test.js
//
// Guards the walkthrough (control-panel/tour.js + tour-steps.js) against rotting.
//
// The old tour broke quietly: a page was redesigned, a step's selector stopped matching, and the
// card floated in the middle of the screen describing something that wasn't there. The engine now
// skips a step whose target isn't visible, which hides the problem even better, so this checks
// every selector and navigation key against the markup and scripts instead.
//
// Static check only: an id can exist in the source and still be hidden at runtime (the engine
// handles that). What this catches is the rename or removal that nobody told the tour about.
'use strict';
const fs = require('fs');
const path = require('path');

const CP = path.join(__dirname, '..', 'control-panel');
const html = fs.readFileSync(path.join(CP, 'index.html'), 'utf8');
const js = fs.readdirSync(CP).filter((f) => f.endsWith('.js') && !f.startsWith('tour'))
  .map((f) => fs.readFileSync(path.join(CP, f), 'utf8')).join('\n');
const appJs = fs.readFileSync(path.join(CP, 'app.js'), 'utf8');
const tourJs = fs.readFileSync(path.join(CP, 'tour.js'), 'utf8');
const CHAPTERS = require(path.join(CP, 'tour-steps.js'));

let failures = 0;
const fail = (msg) => { failures++; console.error('FAIL ' + msg); };
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// An id is "defined" if the markup declares it or a script assigns it.
function idDefined(id) {
  if (new RegExp('id="' + reEsc(id) + '"').test(html)) return true;
  return new RegExp('(\\.id\\s*=\\s*|id=\\\\?")[\'"]?' + reEsc(id) + '\\b').test(js);
}
function attrDefined(attr, val) {
  if (html.includes(attr + '="' + val + '"')) return true;
  // Generated markup: data-pd="${k}" with the key listed elsewhere in the script.
  return js.includes(attr + '="' + val + '"') || (js.includes(attr + '="${') && js.includes("'" + val + "'"));
}
function classDefined(cls) {
  return new RegExp('class="[^"]*\\b' + reEsc(cls) + '\\b').test(html) || new RegExp('[\'" ]' + reEsc(cls) + '[\'" ]').test(js);
}

// A panel can survive in the markup after the stylesheet retired it (#int-subnav did).
const css = fs.readFileSync(path.join(CP, 'styles.css'), 'utf8');
const hiddenByCss = (id) => new RegExp('(^|\\n)\\s*#' + reEsc(id) + '\\s*\\{[^}]*display:\\s*none').test(css);

function checkSelector(where, sel) {
  sel.split(',').forEach((part) => {
    (part.match(/#[\w-]+/g) || []).forEach((h) => {
      if (!idDefined(h.slice(1))) fail(where + ': no element with id ' + h);
      else if (hiddenByCss(h.slice(1))) fail(where + ': ' + h + ' is hidden by styles.css (retired?)');
    });
    (part.match(/\[[\w-]+="[^"]+"\]/g) || []).forEach((a) => {
      const m = a.match(/\[([\w-]+)="([^"]+)"\]/);
      if (!attrDefined(m[1], m[2])) fail(where + ': nothing carries ' + a);
    });
    (part.replace(/\[[^\]]*\]/g, '').match(/\.[a-zA-Z][\w-]*/g) || []).forEach((c) => {
      if (!classDefined(c.slice(1))) fail(where + ': no element with class ' + c);
    });
  });
}

// Every value a nav key can take, read from the markup it drives.
const values = (re) => new Set([...html.matchAll(re)].map((m) => m[1]));
const block = (id) => { const i = html.indexOf('id="' + id + '"'); return i < 0 ? '' : html.slice(i, html.indexOf('</div>', i)); };
const within = (id, attr) => new Set([...block(id).matchAll(new RegExp(attr + '="([\\w-]+)"', 'g'))].map((m) => m[1]));
const prodTabs = (() => {
  const m = appJs.match(/const TABS = \[((?:\[[^\]]*\],?\s*)+)\];\s*\n\s*const sub = document\.createElement\('div'\);\s*\n\s*sub\.id = 'pd-subnav'/);
  return new Set(m ? [...m[1].matchAll(/\['(\w+)'/g)].map((x) => x[1]) : []);
})();
const NAV = {
  tab: values(/class="tab-btn[^"]*" data-tab="(\w+)"/g),
  prod: prodTabs,
  talent: values(/data-talentpage="(\w+)"/g),
  teams: values(/data-teamstab="(\w+)"/g),
  ev: within('ev-subnav', 'data-evtab'),
  assets: within('assets-subnav', 'data-assettab'),
  stats: within('stats-subnav', 'data-stab'),
  integ: within('int-subnav', 'data-inttab'),
  card: values(/class="int-card" data-card="(\w+)"/g),
  rail: values(/class="qrail-tab[^"]*" data-qtab="(\w+)"/g),
  settings: values(/class="set-rail-btn[^"]*" data-stab="(\w+)"/g),
  // Modern page views, as ui-style.js routes them (go: { view: '...' }).
  view: new Set([...fs.readFileSync(path.join(CP, 'ui-style.js'), 'utf8').matchAll(/view: '(\w+)'/g)].map((m) => m[1]))
};
Object.keys(NAV).forEach((k) => { if (!NAV[k].size) fail('could not read any values for nav.' + k + ' from the markup (did it move?)'); });

// Plain-text copy only — no emoji in the UI.
const EMOJI = /\p{Extended_Pictographic}/u;

const seen = new Set();
CHAPTERS.forEach((ch) => {
  if (!ch.id || seen.has(ch.id)) fail('chapter id missing or duplicated: ' + ch.id);
  seen.add(ch.id);
  if (!ch.title || !ch.summary) fail(ch.id + ': chapter needs a title and a summary');
  if (!Array.isArray(ch.steps) || !ch.steps.length) { fail(ch.id + ': no steps'); return; }
  if (ch.page && !NAV.tab.has(ch.page)) fail(ch.id + ': page "' + ch.page + '" is not a sidebar tab');
  ch.steps.forEach((s, i) => {
    const where = ch.id + ' step ' + (i + 1) + ' (' + (s.title || '?') + ')';
    if (!s.title || !s.body) fail(where + ': needs a title and body');
    [s.title, s.body, s.hint].forEach((t) => { if (t && EMOJI.test(t)) fail(where + ': emoji in copy'); });
    if (s.target) checkSelector(where, s.target);
    if (s.action && s.action !== 'click') fail(where + ': unknown action ' + s.action);
    if (s.action && !s.target) fail(where + ': a "try it" step needs a target');
    Object.keys(s.nav || {}).forEach((k) => {
      if (!NAV[k]) fail(where + ': unknown nav key "' + k + '"');
      else if (!NAV[k].has(s.nav[k])) fail(where + ': nav.' + k + ' "' + s.nav[k] + '" does not exist (have: ' + [...NAV[k]].join(', ') + ')');
    });
  });
});
if (!seen.has('quick')) fail('the "quick" chapter is the first-run path and must exist');

// Entry points tour.js wires up.
['btn-tour-help', 'btn-start-tour', 'btn-start-quick', 'dash-tour-cta', 'dash-tour-cta-go', 'dash-tour-cta-browse', 'dash-tour-cta-x', 'tour-section']
  .forEach((id) => { if (!idDefined(id)) fail('entry point #' + id + ' is missing from index.html'); });

// The app functions the engine navigates with.
['_pdShow', '_talentShowPage', '_assetsShow', '_intShowTab'].forEach((fn) => {
  if (!new RegExp('window\\.' + fn + '\\s*=').test(js)) fail('engine calls window.' + fn + ' but nothing defines it');
});
['qrailShowTab', 'openSettings', 'closeSettingsModal'].forEach((fn) => {
  if (!new RegExp('^function ' + fn + '\\(', 'm').test(appJs)) fail('engine calls ' + fn + ' but app.js has no top-level function for it');
  if (!tourJs.includes(fn)) fail('tour.js no longer references ' + fn + ' (update this test)');
});

// Load order: the data must be there when the engine reads it.
const iSteps = html.indexOf('<script src="tour-steps.js"></script>');
const iTour = html.indexOf('<script src="tour.js"></script>');
if (iSteps < 0 || iTour < 0 || iSteps > iTour) fail('index.html must load tour-steps.js before tour.js');

const steps = CHAPTERS.reduce((n, c) => n + c.steps.length, 0);
if (failures) { console.error('\n' + failures + ' tour problem(s).'); process.exit(1); }
console.log('ok: ' + CHAPTERS.length + ' chapters, ' + steps + ' steps, every target and nav key resolves');
