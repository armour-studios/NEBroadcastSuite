'use strict';
// Putting overlays into vMix (the either/or alternative to OBS). vMix has no scenes-with-layers in
// the OBS sense: every overlay becomes a Web Browser INPUT, and anything that must sit on top of
// whatever is on program goes on an OVERLAY CHANNEL (1-4, channel 4 drawn on top).
//
// `api` = { call(fn, params) -> Promise, state() -> Promise<{inputs:[{number,key,title}], overlays:[{number,input}]}> }
// (server.js passes vmixDo + vmix.vmixState). Nothing here deletes or renames a producer's own input.
//
// ⚠ Verified against a simulated vMix only: AddInput "Browser|url", BrowserNavigate, SetInputName,
// OverlayInput4In and SetMultiViewOverlay are taken from vMix's shortcut function reference.

const GRAPHICS_CHANNEL = 4;

const SHOW_INPUTS = [
  { name: 'NE Scoreboard',    path: '/live.html' },           // HUD of the game + layout active in the app
  { name: 'NE Graphics',      path: '/gfx.html' },            // every graphic pushed from the Graphics panel
  { name: 'NE Casters',       path: '/duorow.html',        moment: 'casters' },
  { name: 'NE Replay Player', path: '/replay-player.html', moment: 'replay' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Make sure a Web Browser input titled `name` shows `url`. Returns 'added' | 'updated'.
async function ensureBrowserInput(api, name, url, opts) {
  const waitMs = (opts && opts.waitMs != null) ? opts.waitMs : 400;
  const before = (await api.state()).inputs || [];
  if (before.some((i) => i.title === name)) {
    await must(api.call('BrowserNavigate', { Input: name, Value: url }));
    return 'updated';
  }
  const known = new Set(before.map((i) => i.key || String(i.number)));
  await must(api.call('AddInput', { Value: 'Browser|' + url }));
  // vMix adds the input asynchronously and titles it after the URL; find it and give it our name.
  for (let tries = 0; tries < 8; tries++) {
    if (waitMs) await sleep(waitMs);
    const now = (await api.state()).inputs || [];
    const added = now.find((i) => !known.has(i.key || String(i.number)));
    if (added) {
      await must(api.call('SetInputName', { Input: added.key || added.number, Value: name }));
      return 'added';
    }
  }
  throw new Error(`vMix did not add the "${name}" input (is this vMix edition out of inputs?)`);
}

async function must(p) {
  const r = await p;
  if (r && r.ok === false) throw new Error(r.reason || 'vMix call failed');
  return r;
}

// Graphics on the top overlay channel, so every pushed graphic shows over whatever is on program.
async function graphicsOnTop(api) {
  const st = await api.state();
  const gfx = (st.inputs || []).find((i) => i.title === 'NE Graphics');
  const ch = (st.overlays || []).find((o) => Number(o.number) === GRAPHICS_CHANNEL);
  if (gfx && ch && String(ch.input) === String(gfx.number)) return false;
  await must(api.call('OverlayInput' + GRAPHICS_CHANNEL + 'In', { Input: 'NE Graphics' }));
  return true;
}

// "Build show inputs": the vMix twin of OBS "Build show scenes". `mapping` = current moment map
// (state.obs.scenes; with vMix in charge its values are vMix input titles). Returns
// { added, updated, mapping, scoreboardLayeredOn } where `mapping` holds only moments that were
// empty or pointed at an input vMix no longer has.
async function buildShowInputs(api, base, mapping, opts) {
  const added = [], updated = [];
  for (const def of SHOW_INPUTS) {
    const how = await ensureBrowserInput(api, def.name, base + def.path, opts);
    (how === 'added' ? added : updated).push(def.name);
  }
  await graphicsOnTop(api);
  const st = await api.state();
  const titles = new Set((st.inputs || []).map((i) => i.title));
  const cur = mapping || {};
  const out = {};
  for (const def of SHOW_INPUTS) {
    if (def.moment && (!cur[def.moment] || !titles.has(cur[def.moment]))) out[def.moment] = def.name;
  }
  // The scoreboard belongs ON the game feed, not over the caster desk, so it is layered onto the
  // producer's own In Game input when one is mapped (layer 1), instead of an overlay channel.
  let scoreboardLayeredOn = '';
  const game = (cur.inGame || '').trim();
  if (game && titles.has(game) && game !== 'NE Scoreboard') {
    const r = await api.call('SetMultiViewOverlay', { Input: game, Value: '1,NE Scoreboard' });
    if (!r || r.ok !== false) scoreboardLayeredOn = game;
  }
  return { added, updated, mapping: out, scoreboardLayeredOn };
}

module.exports = { ensureBrowserInput, graphicsOnTop, buildShowInputs, SHOW_INPUTS, GRAPHICS_CHANNEL };
