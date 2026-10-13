'use strict';
// End-to-end: custom game content + saved versions, against the running app.
// Run:  node scripts/e2e-gameconfig.js   (the app must be running)
// Works on a game the producer has NOT customised (refuses otherwise) and puts it back exactly:
// no custom content, no versions, "Original".

const path = require('path');
const WS = require(path.join(__dirname, '..', 'node_modules', 'ws'));
const GAME = process.argv[2] || 'dota2';

let ws, latest = {};
const listeners = new Set();
function connect() {
  return new Promise((resolve, reject) => {
    ws = new WS('ws://localhost:3001');
    let first = true;
    const t = setTimeout(() => reject(new Error('connect timeout')), 5000);
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      if (m.type === 'full_state' && m.data) { latest = { ...latest, ...m.data }; if (first) { first = false; clearTimeout(t); resolve(); } }
      for (const fn of Array.from(listeners)) { try { fn(m); } catch (e) {} }
    });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}
const send = (type, data) => ws.send(JSON.stringify({ type, data }));
function result(timeout = 4000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { listeners.delete(fn); resolve(null); }, timeout);
    const fn = (m) => { if (m.type === 'import-export-result' && m.data && m.data.context === 'game-config') { clearTimeout(t); listeners.delete(fn); resolve(m.data); } };
    listeners.add(fn);
  });
}
const settle = () => new Promise((r) => setTimeout(r, 700));
const roster = () => ((latest.draftRosters || {})[GAME] || []).map((x) => x.name);
const versions = () => ((latest.gameConfigVersions || {})[GAME] || []).map((v) => v.name);
const from = () => (latest.gameConfigFrom || {})[GAME] || null;
const bundle = (chars) => ({ format: 'ne-game-config', version: 1, game: GAME, maps: [], roles: [], roleIcons: {}, modes: [], characters: chars });

const results = [];
function record(name, pass, observed) {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  -> ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
}

(async () => {
  await connect();
  await settle();
  const cfg = (latest.gameConfigs || {})[GAME];
  const hasCustom = cfg && ['maps', 'characters', 'roles', 'modes'].some((k) => (cfg[k] || []).length);
  if (hasCustom || versions().length) { console.log(`[gc-e2e] ${GAME} already has custom content or versions; pick another game.`); process.exit(2); }
  if (!Array.isArray((latest.draftRosters || {})[GAME])) { console.log(`[gc-e2e] ${GAME} has no character roster.`); process.exit(2); }
  const base = roster().length;
  let exit = 0;
  try {
    let r;
    send('save_game_config', { bundle: bundle([{ id: 'charabc', name: 'E2E Alpha', image: '', role: 'Carry' }]) });
    r = await result(); await settle();
    record('save adds a character to the live roster', !!r && r.result && roster().includes('E2E Alpha') && roster().length === base + 1, { ok: r && r.result, n: roster().length });
    record('editing marks the content as not saved as a version', from() && from().clean === false, from());

    send('game_config_version_save', { gameId: GAME, name: 'E2E v1' });
    r = await result(); await settle();
    record('save as version', !!r && r.result && versions()[0] === 'E2E v1' && from().name === 'E2E v1' && from().clean === true, { versions: versions(), from: from() });

    send('save_game_config', { bundle: bundle([{ id: 'e2e-alpha', name: 'E2E Alpha', image: '', role: 'Carry' }, { id: 'charxyz', name: 'E2E Beta', image: '', role: 'Support' }]) });
    await result(); await settle();
    record('building on a version marks it changed', roster().includes('E2E Beta') && from().name === 'E2E v1' && from().clean === false, from());

    send('game_config_version_load', { gameId: GAME, name: '' });
    r = await result(); await settle();
    record('switch to Original keeps saved versions', !roster().includes('E2E Alpha') && roster().length === base && versions().includes('E2E v1'), { n: roster().length, versions: versions(), from: from() });

    send('game_config_version_load', { gameId: GAME, name: 'E2E v1' });
    r = await result(); await settle();
    record('switch back to the version restores exactly it', roster().includes('E2E Alpha') && !roster().includes('E2E Beta') && from().clean === true, { roster: roster().filter((n) => /E2E/.test(n)), from: from() });

    send('game_config_version_save', { gameId: GAME, name: 'E2E v2' });
    await result(); await settle();
    record('a second version lists newest first', versions().join(',') === 'E2E v2,E2E v1', versions());

    send('game_config_version_delete', { gameId: GAME, name: 'E2E v2' });
    r = await result(); await settle();
    record('delete a version leaves the content in use', versions().join(',') === 'E2E v1' && roster().includes('E2E Alpha'), { versions: versions() });

    send('game_config_version_load', { gameId: GAME, name: 'No Such Version' });
    r = await result();
    record('loading a missing version is refused', !!r && r.result === false, r && r.message);
  } catch (e) {
    console.error('[gc-e2e] fatal:', e && e.stack || e); exit = 1;
  } finally {
    for (const v of versions()) { send('game_config_version_delete', { gameId: GAME, name: v }); await result(); }
    send('clear_game_config', { gameId: GAME }); await result(); await settle();
    const clean = !(latest.gameConfigs || {})[GAME] && !versions().length && roster().length === base;
    console.log(`${clean ? 'ok   ' : 'WARN '} restore ${GAME} -> ${JSON.stringify({ configs: !!(latest.gameConfigs || {})[GAME], versions: versions(), n: roster().length })}`);
    const passed = results.filter(Boolean).length;
    console.log(`\n[gc-e2e] ${passed}/${results.length} passed`);
    ws.close();
    process.exit(exit || (passed === results.length && clean ? 0 : 1));
  }
})();
