// node test/ui-actions.test.js
// Regression checks for bugs found by clicking every control in the Modern UI against a real
// server (2026-10-12). Each block names the failure it guards.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const app = read('control-panel/app.js');
const html = read('control-panel/index.html');
const gc = read('control-panel/gameconfig.js');
const server = require('./lib/server-source').serverSource();   // server.js + modules split out of it
let pass = 0;
const ok = (cond, why) => { assert.ok(cond, why); pass++; };

// Hide all / showing another graphic clicked the Schedule's FULL RESET button: it emptied the
// schedule and switched start.gg auto-fill off. Taking Schedule off air must only hide it.
ok(/schedule:\s*\{[^}]*clearId: 'btn-hide-schedule-gfx'/.test(app), 'Schedule hide uses its own hide-only button');
ok(/id="btn-hide-schedule-gfx"/.test(html), 'hide-only Schedule button exists');
ok(/el\('btn-hide-schedule-gfx'\)\?\.addEventListener\('click', \(\) => \{ send\('set_upcoming', \{ visible: false \}\); \}\);/.test(app), 'Schedule hide sends visible:false and nothing else');
ok((app.match(/el\('btn-gfx-schedule-clear'\)\?\.addEventListener/g) || []).length === 1, 'Schedule reset handler registered once (it fired twice per click)');
ok(/el\('btn-gfx-schedule-clear'\)\?\.addEventListener\('click', async \(\) => \{[\s\S]{0,600}appConfirm\('Clear the schedule\?/.test(app), 'Schedule full reset asks first');

// Game Settings: a game with no characters or maps lands on the Roles tab, and the next game
// switch called gcSupports('roles'), which read KIND.roles.src (undefined) and threw.
ok(/if \(gcTab !== 'roles' && !gcSupports\(gcTab\)\)/.test(gc), 'roles tab is checked before gcSupports');
ok(/function gcLive\(kind\) \{\n\s*if \(!KIND\[kind\]\) return undefined;/.test(gc), 'gcLive tolerates kinds without a source');

// Esc closes pop-ups: the .mp-modal family and the automation template picker had no key handler.
ok(/Esc closes the topmost \.mp-modal pop-up[\s\S]{0,900}#brand-editor-close, #se-close, #bug-close, #mp-close, #qr-edit-close/.test(app), 'Esc closes the .mp-modal pop-ups through their Close buttons');
ok(/function _showTemplatesPicker\(\) \{[\s\S]{0,2000}e\.key === 'Escape' && m\.isConnected/.test(app), 'Esc closes the automation template picker');

const stats = read('control-panel/stats-analytics.js');
ok(/function closeStatsDetail\(\) \{[\s\S]{0,400}e\.key !== 'Escape'[\s\S]{0,300}e\.target\.id === 'stats-detail-modal'/.test(stats), 'Esc and a backdrop click close the Analytics match detail');

// Challengermode had a settings section but no Apps card, so every card's filter hid it.
ok(/data-card="challengermode" data-goto="tournaments" data-scroll="input-cm-key"/.test(html), 'Challengermode has an Apps card');
ok(/challengermode: \{ panel: 'integration-startgg', title: \/\^challengermode\/i \}/.test(app), 'its card shows the Challengermode section');
ok(/set\('challengermode', cm\.hasKey/.test(app), 'its card shows key status');

// Every top-level state key rides a declared broadcast tier (the server warns on each untiered key).
const tiers = server.slice(server.indexOf('const BROADCAST_TIERS = {'), server.indexOf('};', server.indexOf('const BROADCAST_TIERS = {')));
['streamdeck', 'pollFailures', 'obsStinger', 'multichat', 'marbleRace', 'lanHost', 'eventNameSlug', 'dateFormat', 'chatHighlight', 'challongePlacements']
  .forEach((k) => ok(new RegExp('\\b' + k + ": '(live|library|local)'").test(tiers), k + ' has a broadcast tier'));

// Error messages point at the page that exists: tokens and OBS live under Apps.
ok(!/set it in Settings\)|connect in Integrations|Settings → OBS|in Integrations first/.test(server + app), 'no hints point at the old Settings / Integrations locations');

// Every game has at least one in-game layout, and live.html never puts its idle hint on air.
const layouts = server.slice(server.indexOf('const OVERLAY_LAYOUTS = {'), server.indexOf('const GENERIC_OVERLAY_LAYOUTS'));
const gameIds = [...server.slice(server.indexOf('const GAMES = {'), server.indexOf('Object.keys(GAMES).forEach')).matchAll(/^\s+'([a-z0-9-]+)':\s+\{ id:/gm)].map((m) => m[1]);
ok(gameIds.length >= 20, 'GAMES registry parsed');
gameIds.forEach((g) => ok(new RegExp("'" + g + "':\\s*\\[").test(layouts), g + ' has an overlay layout'));
ok(read('overlay/live.html').includes("idle.style.display = /[?&]preview=1/.test(location.search) ? 'flex' : 'none';"), 'live.html idle hint only in previews');

console.log(`ui-actions: all ${pass} checks passed`);
