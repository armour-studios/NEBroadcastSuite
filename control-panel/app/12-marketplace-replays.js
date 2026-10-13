// Control panel, part 12 of 17: Marketplace; AI director and clips; replays staging, playlists, go-live, ad scheduler, shortcuts.
// Built into control-panel/app.js with the other parts (scripts/build-panel-app.js): one script, one scope.

// ── Marketplace page (tab id 'integrations') — top pills: Integrations (the 'store' grid) / Plugins / Developers.
// Per-app panels (Streaming software / Cameras / Tournament Platforms / Twitch / Stream Deck) open from the cards with a back bar. ──
// 'chatgames' (Marble Race) is parked — unlisted from Integrations, implementation intact.
// To restore: add 'chatgames' back here, re-add the panels/titles entries below, and
// un-comment the subnav button + store card in index.html (the #integration-chatgames panel
// itself was left in place, just orphaned).
const INT_TABS = ['store', 'api', 'plugins', 'switcher', 'streamdeck', 'cameras', 'tournaments', 'twitch', 'riot'];
const INT_TOP_TABS = ['store', 'api', 'plugins'];   // top-level Marketplace sections — no back bar   // 'games' moved to Settings ▸ Games
let _intTab = 'store';
function _intShowTab(which) {
  if (which === 'developers') which = 'api';   // the API page used to be called Developers
  _intTab = INT_TABS.includes(which) ? which : 'store';
  document.querySelectorAll('#int-subnav .ev-subnav-btn').forEach((b) => b.classList.toggle('active', b.dataset.inttab === _intTab));
  const panels = {
    store: [el('integration-store')],
    plugins: [el('integration-plugins')],
    switcher: [el('integration-obs')],
    streamdeck: [el('integration-streamdeck')],
    cameras: [el('integration-vdo')],
    tournaments: [el('integration-startgg')],
    riot: [el('integration-riot')],
    twitch: [el('integration-twitch')],   // Games & Features (#integration-twitchgames) moved to Settings ▸ Features
    api: [el('integration-api')]
    // chatgames: [el('integration-chatgames')]   — parked, see INT_TABS above
  };
  Object.entries(panels).forEach(([key, els]) => els.forEach((p) => { if (p) p.style.display = key === _intTab ? '' : 'none'; }));
  // Top-level sections keep the page head + pill row; every app panel shows a way back instead.
  // Inside an app, the back bar is the only header — the page-head stacked above it read as a
  // second back bar.
  const isTop = INT_TOP_TABS.includes(_intTab);
  const intHead = document.querySelector('#tab-integrations-content .page-head');
  if (intHead) intHead.style.display = isTop ? '' : 'none';
  const subnav = el('int-subnav');
  if (subnav) subnav.style.display = isTop ? '' : 'none';
  const backbar = el('int-backbar');
  if (backbar) {
    backbar.style.display = isTop ? 'none' : 'flex';
    const titles = { switcher: 'Streaming software', cameras: 'Cameras', streamdeck: 'Elgato Stream Deck',
      games: 'Games & GSI', tournaments: 'Tournament Platforms', twitch: 'Twitch', riot: 'Riot Games' };
    const t = el('int-backbar-title');
    if (t) t.textContent = (typeof INT_APP_NAMES !== 'undefined' && INT_APP_NAMES[_intAppFilter]) || titles[_intTab] || '';
  }
  if (typeof _intApplyAppFilter === 'function') _intApplyAppFilter();
  if (_intTab === 'cameras' && typeof cfLoadVdoSettings === 'function') cfLoadVdoSettings();
  if (_intTab === 'api' && typeof cmpLoadKey === 'function') cmpLoadKey();
  try { localStorage.setItem('integrations_active_tab', _intTab); } catch (_) {}
}
window._intShowTab = _intShowTab;
document.querySelectorAll('#int-subnav .ev-subnav-btn').forEach((b) => b.addEventListener('click', function () { _intShowTab(this.dataset.inttab); }));
// Deferred like Assets' subnav restore — some panel init code referenced here isn't defined until
// later in the script; calling synchronously here risks the same TDZ crash documented for that case.
setTimeout(() => {
  // Always land on the Integrations grid — the first Marketplace section.
  _intShowTab('store');
}, 0);

// ── Browse grid: cards navigate to their section; status chips follow live state ──
el('int-back')?.addEventListener('click', () => { _intAppFilter = ''; _intShowTab('store'); });
// Which app was clicked — shared panels (tournaments, switcher, games) narrow to
// JUST that app's section so start.gg never shows Challonge's settings, etc.
let _intAppFilter = '';
const INT_APP_NAMES = { obs: 'Streaming software', vmix: 'Streaming software', twitch: 'Twitch', startgg: 'start.gg',
  challonge: 'Challonge', challengermode: 'Challengermode', nxgen: 'NXGEN', faceit: 'FACEIT', vdo: 'VDO.Ninja', rl: 'Rocket League',
  cs2: 'Counter-Strike 2', valorant: 'Valorant', lol: 'League of Legends', riot: 'Riot Games',
  sheets: 'Google Sheets', liquipedia: 'Liquipedia', streamdeck: 'Elgato Stream Deck' };
function _intApplyAppFilter() {
  // One app = one titled <section class="section"> inside its shared panel.
  const scope = {
    startgg:   { panel: 'integration-startgg', title: /^start\.gg/i },
    challonge: { panel: 'integration-startgg', title: /^challonge/i },
    nxgen:     { panel: 'integration-startgg', title: /^nxgen/i },
    faceit:    { panel: 'integration-startgg', title: /^faceit/i },
    challengermode: { panel: 'integration-startgg', title: /^challengermode/i },
    sheets:    { panel: 'integration-startgg', title: /^google sheets/i },
    liquipedia:{ panel: 'integration-startgg', title: /^nxgen/i },   // its block lives inside the NXGEN section
  };
  // The "Tournament platforms" page-head only describes the bracket apps; Sheets and Liquipedia
  // share the panel but are not platforms.
  const platHead = document.querySelector('#integration-startgg > .page-head');
  if (platHead) platHead.classList.toggle('int-head-hidden', /^(sheets|liquipedia)$/.test(String(_intAppFilter || '')));
  ['integration-startgg', 'integration-obs'].forEach((pid) => {
    const p = el(pid); if (!p) return;
    const cfg = scope[_intAppFilter];
    p.querySelectorAll('section.section').forEach((sec) => {
      if (!cfg || cfg.panel !== pid) { sec.style.display = ''; return; }
      const t = sec.querySelector('.section-title');
      sec.style.display = cfg.title.test(((t && t.textContent) || '').trim()) ? '' : 'none';
    });
  });
  // The streaming software panel shows only the chosen program's section (the loop above reset it).
  if (typeof swRenderPicker === 'function') swRenderPicker();
  // Liquipedia shares the NXGEN section: show only its own block when it was clicked, and hide
  // that block when NXGEN was.
  const lpBlock = el('integration-liquipedia');
  if (lpBlock) {
    const nxSec = lpBlock.closest('section.section');
    if (nxSec) {
      Array.from(nxSec.children).forEach((c) => {
        if (c.contains(lpBlock)) { c.style.display = ''; return; }   // the wrapper that holds the block
        c.style.display = _intAppFilter === 'liquipedia' ? 'none' : '';
      });
      // Inside that wrapper: Liquipedia only, or everything but Liquipedia.
      const wrap = lpBlock.parentElement;
      if (wrap && wrap !== nxSec) Array.from(wrap.children).forEach((c) => {
        if (c === lpBlock) c.style.display = _intAppFilter === 'nxgen' ? 'none' : '';
        else c.style.display = _intAppFilter === 'liquipedia' ? 'none' : '';
      });
      else lpBlock.style.display = _intAppFilter === 'nxgen' ? 'none' : '';
    }
    if (_intAppFilter === 'liquipedia') { lpBlock.style.marginTop = '0'; lpBlock.style.paddingTop = '0'; lpBlock.style.borderTop = '0'; }
    else { lpBlock.style.marginTop = ''; lpBlock.style.paddingTop = ''; lpBlock.style.borderTop = ''; }
  }
  // Games: select the matching inner game tab and hide the tab row while narrowed.
  const gameMap = { cs2: 'cs2', rl: 'rl', lol: 'league', valorant: 'valorant' };
  const bar = document.querySelector('#integration-games .game-tab-row');
  if (bar) bar.style.display = gameMap[_intAppFilter] ? 'none' : '';
  if (gameMap[_intAppFilter]) {
    const b = document.querySelector('#integration-games .game-tab-btn[data-game="' + gameMap[_intAppFilter] + '"]');
    if (b) b.click();
  }
}
document.querySelectorAll('#int-store-grid .int-card').forEach((card) => {
  card.addEventListener('click', () => {
    const cardKey = card.dataset.card || '';
    // The per-game setup panel moved to Settings ▸ Games — game cards deep-link there and select the
    // game. Don't set _intAppFilter here (it would later hide the game selector in the settings panel).
    if (card.dataset.goto === 'games') {
      if (typeof openSettings === 'function') openSettings('games');
      const gm = { cs2: 'cs2', rl: 'rl', lol: 'league', valorant: 'valorant', dota2: 'dota2' };
      const g = gm[cardKey];
      if (g) setTimeout(() => document.querySelector('#integration-games .game-tab-btn[data-game="' + g + '"]')?.click(), 50);
      return;
    }
    _intAppFilter = cardKey;
    _intShowTab(card.dataset.goto);
    const target = card.dataset.scroll && el(card.dataset.scroll);
    if (target) setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
  });
});
function renderIntegrationStore(data) {
  const grid = el('int-store-grid');
  if (!grid) return;
  const set = (key, st, text) => {
    const chip = grid.querySelector('.int-card[data-card="' + key + '"] .int-card-status');
    if (chip) { chip.dataset.st = st; chip.textContent = text; }
    return st === 'on';
  };
  const obs = data.obs || {}, vmix = data.vmix || {}, tw = data.twitch || {};
  const sgg = data.startgg || {}, ch = data.challonge || {}, nx = data.nxgen || {};
  const fc = data.faceit || {};
  const cm = data.challengermode || {};
  const sh = data.sheets || {};
  let on = 0;
  // One card for the streaming software: its status is the program in use (OBS, Streamlabs or vMix).
  const swV = (data.switcher && data.switcher.target) === 'vmix';
  const swS = swV ? vmix : obs;
  const swName = swV ? 'vMix' : (obs.app === 'streamlabs' ? 'Streamlabs' : 'OBS');
  on += set('obs', !swS.enabled ? 'off' : swS.connected ? 'on' : 'warn',
                   !swS.enabled ? 'Off' : swS.connected ? swName + ' connected' : swName + ' not reachable') ? 1 : 0;
  on += set('twitch', tw.connected ? 'on' : 'off', tw.connected ? 'Connected' : 'Not connected') ? 1 : 0;
  const sggOk = !!(sgg.hasToken && (sgg.lastSyncAt || sgg.selectedEvent));
  on += set('startgg', sgg.hasToken ? (sggOk ? 'on' : 'warn') : 'off', sgg.hasToken ? (sggOk ? 'Connected' : 'Token saved') : 'No token') ? 1 : 0;
  on += set('challonge', ch.hasKey ? (ch.connected ? 'on' : 'warn') : 'off',
                         ch.hasKey ? (ch.connected ? 'Connected' : 'Key saved') : 'No key') ? 1 : 0;
  on += set('nxgen', nx.hasKey ? (nx.connected ? 'on' : 'warn') : 'off',
                     nx.hasKey ? (nx.connected ? 'Connected' : 'Key saved') : 'No key') ? 1 : 0;
  on += set('faceit', fc.hasKey ? (fc.connected ? 'on' : 'warn') : 'off',
                      fc.hasKey ? (fc.connected ? 'Connected' : 'Key saved') : 'No key') ? 1 : 0;
  on += set('challengermode', cm.hasKey ? 'on' : 'off', cm.hasKey ? 'Key saved' : 'No key') ? 1 : 0;
  on += set('sheets', sh.hasKey ? (sh.connected ? 'on' : 'warn') : 'off',
                      sh.hasKey ? (sh.connected ? 'Connected' : 'Key saved') : 'No key') ? 1 : 0;
  const rt = data.riot || {};
  on += set('riot', rt.hasKey ? (rt.lastError ? 'warn' : 'on') : 'off',
                    rt.hasKey ? (rt.lastError ? 'Key rejected' : 'Key saved') : 'No key') ? 1 : 0;
  on += set('rl',  data.rlConnected ? 'on' : 'off', data.rlConnected ? 'Connected' : 'Waiting for game') ? 1 : 0;
  on += set('cs2', (data.csgo && data.csgo.connected) ? 'on' : 'off',
                   (data.csgo && data.csgo.connected) ? 'Connected' : 'Waiting for game') ? 1 : 0;
  const sd = !!(data.streamdeck && data.streamdeck.connected);
  on += set('streamdeck', sd ? 'on' : 'off', sd ? 'Connected' : 'Not installed') ? 1 : 0;
  const dt = data.dota || {};
  on += set('dota2', dt.connected ? 'on' : 'off', dt.connected ? 'Connected' : (dt.cfgPath ? 'Waiting for game' : 'Not set up')) ? 1 : 0;
  const sdStatus = el('streamdeck-conn-status');
  if (sdStatus) sdStatus.textContent = sd ? 'Plugin connected — keys are live.' : 'Plugin not connected.';
  const count = el('int-strip-count');
  if (count) {
    const all = grid.querySelectorAll('.int-card .int-card-status');
    let live = 0; all.forEach((c) => { if (c.dataset.st === 'on') live++; });
    count.textContent = live + ' of ' + all.length;
  }
}

function applyVmixState(data) {
  const v = data.vmix || {};
  const cb = el('check-vmix-enabled'); if (cb && document.activeElement !== cb) cb.checked = !!v.enabled;
  const h = el('input-vmix-host'); if (h && document.activeElement !== h) h.value = v.host || '127.0.0.1';
  const p = el('input-vmix-port'); if (p && document.activeElement !== p) p.value = v.port || 8088;
  const target = (data.switcher && data.switcher.target) || 'obs';
  document.querySelectorAll('#switcher-target-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.target === target));
  const vmixBadge = el('vmix-conn-badge'); if (vmixBadge) vmixBadge.style.display = v.connected ? '' : 'none';
  const st = el('vmix-live-status');
  if (st) {
    if (!v.enabled) st.textContent = '';
    else if (v.connected) {
      const prog = v.active != null ? ('#' + v.active) : '—', prev = v.preview != null ? ('#' + v.preview) : '—';
      st.innerHTML = `<span style="color:#4ade80;">● Connected</span> — vMix ${_stEsc(v.version || '')} ${v.edition ? '(' + _stEsc(v.edition) + ')' : ''} · ${(v.inputs || []).length} inputs · PGM ${prog} / PRV ${prev}`
        + (v.streaming ? ' · <span style="color:#ef4444;">STREAMING</span>' : '') + (v.recording ? ' · <span style="color:#ef4444;">REC</span>' : '');
    } else {
      st.innerHTML = `<span style="color:#f0a5a5;">● ${_stEsc(v.lastError || 'Not connected')}</span>`;
    }
  }
}

el('btn-obs-clear-password')?.addEventListener('click', () => {
  const btn = el('btn-obs-clear-password');
  const pwEl = el('input-obs-password');
  if (pwEl) pwEl.value = '';
  btn.dataset.clearing = '1';
  send('set_obs_settings', getObsPayload());
  delete btn.dataset.clearing;
  btn.style.display = 'none';
  el('obs-password-indicator').style.display = 'none';
  const pwInd = el('obs-password-indicator');
  if (pwInd) pwInd.style.display = 'none';
  if (pwEl) pwEl.placeholder = 'OBS WebSocket password';
});

// OBS or vMix, whichever is the switcher (Settings > OBS / vMix toggle), and whether it is reachable.
function activeSwitcher() {
  const st = currentState || {};
  const vmix = !!(st.switcher && st.switcher.target === 'vmix');
  return { vmix, name: vmix ? 'vMix' : (st.obs && st.obs.app === 'streamlabs' ? 'Streamlabs' : 'OBS'), ready: vmix ? !!(st.vmix && st.vmix.enabled && st.vmix.connected) : !!(st.obs && st.obs.connected) };
}
function buildObsShowScenes() {
  const sw = activeSwitcher();
  if (!sw.ready) {
    showToast(`Connect ${sw.name} first (Apps > ${sw.vmix ? 'vMix' : 'OBS Studio'}), then build the scenes.`, '#f59e0b', 5000);
    return;
  }
  send('obs_build_show_scenes', { base: SCENE_BASE_URL });
  showToast(`Building your show in ${sw.name}…`, '#3b82f6', 2500);
}
el('btn-obs-build-scenes')?.addEventListener('click', buildObsShowScenes);

el('btn-obs-download-collection')?.addEventListener('click', async () => {
  const btn = el('btn-obs-download-collection');
  const statusEl = btn.nextElementSibling?.classList.contains('obs-collection-status') ? btn.nextElementSibling : null;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  statusEl.textContent = '';
  try {
    const res = await fetch('http://127.0.0.1:3000/api/obs/install-collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
    if (data.canceled) {
      btn.textContent = orig; btn.disabled = false; statusEl.textContent = '';
      return;
    }
    btn.textContent = '✓ Saved';
    statusEl.textContent = data.message || 'Done.';
    statusEl.style.color = 'var(--good, #48bb78)';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; statusEl.textContent = ''; }, 6000);
  } catch (e) {
    btn.textContent = '✗ Failed';
    btn.disabled = false;
    statusEl.textContent = e.message;
    statusEl.style.color = '#f56565';
    setTimeout(() => { btn.textContent = orig; statusEl.textContent = ''; }, 5000);
    console.error('[OBS] save-collection failed:', e);
  }
});

// ── RL status ─────────────────────────────────────────────────────────────
// (Updated via full_state)

// ── AI Director & Clips ───────────────────────────────────────────────────
let selectedClipId = null;   // the clip currently loaded in the REPLAYS editor

function gameHasDirector() {
  const g = (currentState.games && currentState.games[currentState.activeGame]) || null;
  return !!(g && g.features && g.features.includes('director'));
}

function renderDirectorLocalStack(data) {
  const strip = el('director-local-stack');
  if (strip) strip.style.display = gameHasDirector() ? '' : 'none';
  if (!strip || strip.style.display === 'none') return;

  const feats = activeGameFeatures(data);
  const rlChip = el('dir-chip-rl');
  if (rlChip) {
    const show = feats.includes('stats-api');
    rlChip.style.display = show ? '' : 'none';
    if (show) chip('dir-chip-rl', data.rlConnected ? 'RL API' : 'RL API: offline', !!data.rlConnected);
  }

  const obs = data.obs || {};
  chip('dir-chip-obs', obs.connected ? 'OBS' : (obs.enabled ? 'OBS: offline' : 'OBS: off'),
    obs.connected ? true : (obs.enabled ? null : false));
}

function applyDirectorState(d) {
  const section = el('director-section');
  if (section) section.style.display = gameHasDirector() ? '' : 'none';
  renderDirectorLocalStack(currentState);
  if (!d) return;

  const enabled = el('check-director-enabled');
  if (enabled && document.activeElement !== enabled) enabled.checked = d.enabled !== false;

  const sens = el('range-director-sensitivity');
  const sensVal = el('director-sens-val');
  const pct = Math.round((d.sensitivity ?? 0.5) * 100);
  if (sens && document.activeElement !== sens) sens.value = pct;
  if (sensVal) sensVal.textContent = pct + '%';

  const conf = el('director-confidence');
  const target = el('director-target');
  const reason = el('director-reason');
  const meta = el('director-meta');
  if (d.primary) {
    if (conf) conf.textContent = (d.confidence || d.primary.confidence || 0) + '%';
    if (target) target.textContent = d.primary.name || d.primary.target?.name || '—';
    if (reason) reason.textContent = d.primary.reason || '';
    if (meta) meta.textContent = [d.primary.type, d.primary.gameTime].filter(Boolean).join(' · ');
  } else {
    if (conf) conf.textContent = '—';
    if (target) target.textContent = d.enabled ? 'Analyzing…' : 'Director disabled';
    if (reason) reason.textContent = d.enabled ? 'Waiting for broadcast-worthy moment' : 'Enable director to get suggestions';
    if (meta) meta.textContent = '';
  }

  const altWrap = el('director-alternates-wrap');
  const altList = el('director-alternates');
  const alts = d.alternates || [];
  if (altWrap) altWrap.style.display = alts.length ? '' : 'none';
  const _altSig = alts.map((a, i) => i + ':' + a.name + ':' + (a.confidence || 0) + ':' + (a.reason || a.type) + ':' + ((a.target && a.target.id) || '')).join('|');
  if (altList && altList.dataset.sig !== _altSig) {
    altList.dataset.sig = _altSig;
    altList.innerHTML = alts.map((a, i) =>
      `<div class="director-alt-item" data-alt-idx="${i}" data-target-id="${(a.target && a.target.id) || ''}">
        <span><strong>${a.name}</strong> — ${a.reason || a.type}</span>
        <span style="color:var(--muted)">${a.confidence || 0}%</span>
      </div>`
    ).join('');
    altList.querySelectorAll('.director-alt-item').forEach((node) => {
      node.addEventListener('click', () => {
        const idx = Number(node.dataset.altIdx);
        const alt = alts[idx];
        if (alt) {
          send('set_director', { lockTarget: alt.target?.id || alt.name });
          send('director_feedback', { action: 'overridden', eventType: alt.type, targetId: alt.target?.id });
        }
      });
    });
  }

  const feed = el('director-feed');
  if (feed) {
    const items = (d.feed || []).slice(0, 20);
    const _feedSig = items.map((f) => (f.id || '') + ':' + f.type + ':' + (f.target || '') + ':' + (f.reason || '') + ':' + (f.gameTime || '')).join('|');
    if (feed.dataset.sig !== _feedSig) {
    feed.dataset.sig = _feedSig;
    feed.innerHTML = items.length ? items.map((f) => {
      const time = f.gameTime || (f.ts ? new Date(f.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
      return `<div class="director-feed-item" data-feed-id="${f.id || ''}" title="Save replay clip + train AI on this moment">
        <span class="director-feed-type">${f.type}</span>
        <span>${f.target || ''} — ${f.reason || ''}${time ? ` <span style="color:var(--muted)">(${time})</span>` : ''}</span>
        <span class="feed-save-hint">Save clip</span>
      </div>`;
    }).join('') : '<div style="color:var(--muted);font-size:12px;">No events yet</div>';
    feed.querySelectorAll('.director-feed-item[data-feed-id]').forEach((node) => {
      node.addEventListener('click', () => {
        const id = node.dataset.feedId;
        if (!id) return;
        send('director_feed_action', { feedId: id, action: 'both' });
        const st = el('clips-status');
        if (st) { st.textContent = 'Saving replay clip from feed…'; st.style.color = 'var(--muted)'; }
      });
    });
    }
  }

  const autoSw = el('check-director-autoswitch');
  if (autoSw && document.activeElement !== autoSw) autoSw.checked = !!d.autoSwitch;

  const asHint = el('director-autoswitch-hint');
  if (asHint) {
    const game = currentState.activeGame;
    asHint.textContent = game === 'csgo'
      ? 'CS2: sends observer slot hotkeys 1–0 to the focused game window on this PC.'
      : 'Available for CS2 (observer keys). Rocket League camera control is not automated.';
  }

  const asStatus = el('director-autoswitch-status');
  if (asStatus) {
    const las = d.lastAutoSwitch;
    asStatus.textContent = las
      ? `Last auto-switch: ${las.target}${las.key ? ` (key ${las.key})` : ''}`
      : (d.autoSwitch ? 'Auto-switch armed — CS2 observer keys' : '');
  }

  const learn = el('director-learning');
  if (learn && d.learning) {
    learn.textContent = `Learning: ${d.learning.totalFeedback || 0} feedback events · ${d.learning.accuracy || 0}% accepted · improves with every show`;
  }
}

let activeDirectorPanel = 'live';
function switchDirectorPanel(name) {
  activeDirectorPanel = name;
  document.querySelectorAll('.director-subnav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.directorPanel === name);
  });
  document.querySelectorAll('.director-panel').forEach((p) => {
    p.classList.toggle('active', p.dataset.panel === name);
  });
}

document.querySelectorAll('.director-subnav-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchDirectorPanel(btn.dataset.directorPanel));
});

// ═══════════════════════════════════════════════════════════════════════════
//  REPLAYS — Clip Library, Visual Trim Bar, Playlist, OBS Folder Scan
// ═══════════════════════════════════════════════════════════════════════════

const _thumbCache = new Map();

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00.0';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const d = Math.floor((sec % 1) * 10);
  return `${m}:${String(s).padStart(2, '0')}.${d}`;
}

async function getClipThumbnail(clip) {
  if (_thumbCache.has(clip.id)) return _thumbCache.get(clip.id);
  const url = clipUrl(clip);
  if (!url) return null;
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous'; v.muted = true; v.preload = 'metadata'; v.src = url;
    const cleanup = () => { v.src = ''; };
    v.addEventListener('loadedmetadata', () => { v.currentTime = Math.min(v.duration * 0.15, 3); });
    v.addEventListener('seeked', () => {
      try {
        const c = document.createElement('canvas');
        c.width = 160; c.height = 90;
        c.getContext('2d').drawImage(v, 0, 0, 160, 90);
        const u = c.toDataURL('image/jpeg', 0.75);
        _thumbCache.set(clip.id, u); cleanup(); resolve(u);
      } catch { cleanup(); resolve(null); }
    });
    v.addEventListener('error', () => { cleanup(); resolve(null); });
    setTimeout(() => { cleanup(); resolve(null); }, 8000);
  });
}

function generateFilmstrip(videoEl) {
  const strip = el('rp-trim-filmstrip');
  if (!strip || !videoEl) return;
  strip.innerHTML = '';
  const dur = videoEl.duration;
  if (!isFinite(dur) || dur <= 0) return;
  const trackW = el('rp-trim-track')?.offsetWidth || 300;
  const frameH = 52; const frameW = Math.round(frameH * (16 / 9));
  const count = Math.max(3, Math.min(20, Math.floor(trackW / frameW)));
  let i = 0;
  function paintFrame() {
    if (i >= count) return;
    const c = document.createElement('canvas');
    c.width = frameW; c.height = frameH;
    strip.appendChild(c);
    const sv = document.createElement('video');
    sv.crossOrigin = 'anonymous'; sv.muted = true; sv.src = videoEl.src;
    sv.addEventListener('loadedmetadata', () => { sv.currentTime = (dur / count) * (i + 0.5); });
    sv.addEventListener('seeked', () => {
      try { c.getContext('2d').drawImage(sv, 0, 0, frameW, frameH); } catch {}
      sv.src = ''; i++; setTimeout(paintFrame, 80);
    });
    sv.addEventListener('error', () => { sv.src = ''; i++; setTimeout(paintFrame, 80); });
  }
  paintFrame();
}

// ── Staging Area (OBS replay folder — column 1) ───────────────────────────
let _stagingFiles = [];          // { name, path, size, mtimeMs, imported, importedId }
let _stagingTotal = 0;           // true file count in the folder (the list payload is capped)
let _stagingFilter = '';
let _stagingLoading = false;
let _stagingSelectedPath = null;
let _stagingAutoTimer = null;

function fileUrl(rawPath) {
  return 'http://127.0.0.1:3000/api/clips/file?path=' + encodeURIComponent(rawPath);
}
function thumbUrl(rawPath) {
  return 'http://127.0.0.1:3000/api/clips/thumb?path=' + encodeURIComponent(rawPath);
}

function cleanFileName(name) {
  return name.replace(/\.[^.]+$/, '').replace(/-(\d{2})-(\d{2})$/, ' $1:$2');
}

function syncStagingCount() {
  const n = Math.max(_stagingTotal || 0, _stagingFiles.length);
  const shown = _stagingFiles.length;
  const capped = n > shown;   // folder has more than the payload cap
  const cnt = el('rp-staging-count');
  if (cnt) cnt.textContent = n ? String(n) : '';
  const statusEl = el('clips-status');
  if (statusEl && !statusEl.style.color) {   // don't clobber error/success messages
    statusEl.textContent = n
      ? `${n} clip${n === 1 ? '' : 's'} in OBS folder${capped ? ` (showing newest ${shown})` : ''}`
      : 'No clips found — check OBS replay/output folder in Capture settings below';
  }
}

async function scanStagingArea(quiet = false) {
  if (_stagingLoading) return;
  _stagingLoading = true;
  const btn = el('rp-scan-folder');
  const statusEl = el('clips-status');
  if (!quiet) {
    if (btn) btn.textContent = 'Scanning…';
    if (statusEl) { statusEl.textContent = 'Scanning OBS replay folder…'; statusEl.style.color = ''; }
  }
  let scanOk = false;
  try {
    const res = await fetch('http://127.0.0.1:3000/api/clips/scan-folder');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { files, folder, total } = await res.json();
    _stagingFiles = files || [];
    _stagingTotal = (typeof total === 'number') ? total : _stagingFiles.length;

    const folderBar = el('rp-staging-folder-bar');
    if (folderBar) {
      if (folder) { folderBar.textContent = folder; folderBar.style.display = ''; }
      else folderBar.style.display = 'none';
    }
    scanOk = true;
  } catch (err) {
    if (statusEl) { statusEl.textContent = 'Scan failed — ' + friendlyError(err); statusEl.style.color = '#f56565'; }
  } finally {
    _stagingLoading = false;
    if (btn) btn.textContent = 'Refresh';
  }
  if (!scanOk) return;
  // Render outside the fetch try-catch so rendering bugs surface as console errors, not "Scan failed"
  refreshStagingImportedFlags();
  renderStagingList();
  if (statusEl) statusEl.style.color = '';
  syncStagingCount();
}

function refreshStagingImportedFlags() {
  const lib = currentState.clips?.library || [];
  const normalize = p => (p || '').replace(/\\/g, '/');
  _stagingFiles.forEach(f => {
    const match = lib.find(cl => cl.sourceFile && normalize(cl.sourceFile) === normalize(f.path));
    f.imported = !!match;
    f.importedId = match?.id || null;
  });
}

function renderStagingList() {
  const list = el('rp-staging-list');
  if (!list) return;
  const q = _stagingFilter.trim();
  // Subfolder path searchable too — OBS drops replays into dated folders and the producer often
  // remembers the day, not the auto-generated filename.
  const files = NESearch.filter(_stagingFiles, q, (f) => [{ text: f.name, weight: 2 }, f.path]);

  // Skip the rebuild (which reloads every thumbnail → a visible flash) when nothing relevant
  // changed. applyClipsState() calls this on every state broadcast, so without this the side
  // column flickers constantly. Don't skip mid-rename.
  // Order-independent sig: the 20s rescan can return files in a different order, which would
  // otherwise change the sig and force a needless rebuild (= thumbnail-reload flash).
  const sig = files.map(f => f.path + ':' + f.size + ':' + f.mtimeMs + ':' + (f.imported ? 1 : 0)).sort().join('|')
    + '||' + [..._stagingSelected].sort().join(',') + '||' + (_stagingSelectedPath || '') + '||' + _stagingFilter;
  if (renderStagingList._sig === sig && list.children.length && !list.querySelector('.rp-sc-rename-input')) return;
  renderStagingList._sig = sig;

  if (!files.length) {
    list.innerHTML = `<div class="rp-empty" style="padding:28px 14px;text-align:center;font-size:12px;">${
      !_stagingFiles.length
        ? 'No clips in OBS folder.<br><span style="font-size:11px;color:var(--muted)">Set the folder path in Capture settings below.</span>'
        : `No clips match "${_stagingFilter.replace(/</g, '&lt;')}"`
    }</div>`;
    return;
  }

  list.innerHTML = '';
  files.forEach(f => {
    const card = document.createElement('div');
    card.className = 'rp-stage-card' + (f.path === _stagingSelectedPath ? ' active' : '') + (_stagingSelected.has(f.path) ? ' checked' : '');
    card.dataset.path = f.path;

    const mb = (f.size / 1024 / 1024).toFixed(1);
    const when = f.mtimeMs
      ? new Date(f.mtimeMs).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';
    const label = cleanFileName(f.name);

    card.innerHTML = `
      <label class="rp-sc-check" title="Select for bulk delete"><input type="checkbox" ${_stagingSelected.has(f.path) ? 'checked' : ''}></label>
      <div class="rp-sc-thumb">
        <svg class="rp-sc-thumb-icon" viewBox="0 0 24 24" width="18" height="18" fill="rgba(255,255,255,0.25)"><path d="M8 5v14l11-7z"/></svg>
        <img class="rp-sc-thumb-img" alt="" loading="lazy" src="${thumbUrl(f.path)}">
      </div>
      <div class="rp-sc-body">
        <div class="rp-sc-name" title="${f.name.replace(/"/g, '&quot;')}">${label.replace(/</g, '&lt;')}</div>
        <div class="rp-sc-meta">${mb} MB${when ? ' · ' + when : ''}${f.imported ? ' <span class="rp-sc-lib-badge">IN LIB</span>' : ''}</div>
      </div>
      <div class="rp-sc-acts">
        <button class="rp-vi-act rp-sc-addpl" title="${f.imported ? 'Already in your library — check the Replays/Highlights pool' : 'Import into the Replays pool'}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="12" x2="18" y2="12"/><polyline points="12 6 18 12 12 18"/></svg>
        </button>
        <button class="rp-vi-act rp-sc-ren" title="Rename file">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325"/></svg>
        </button>
        <button class="rp-vi-del rp-sc-del" title="Delete from OBS folder">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M6.5 1h3a.5.5 0 0 1 .5.5v1H6v-1a.5.5 0 0 1 .5-.5M11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3A1.5 1.5 0 0 0 5 1.5v1H1.5a.5.5 0 0 0 0 1h.538l.853 10.66A2 2 0 0 0 4.885 16h6.23a2 2 0 0 0 1.994-1.84l.853-10.66h.538a.5.5 0 0 0 0-1zm1.958 1-.846 10.58a1 1 0 0 1-.997.92h-6.23a1 1 0 0 1-.997-.92L3.042 3.5zm-7.487 1a.5.5 0 0 1 .528.47l.5 8.5a.5.5 0 0 1-.998.06L5 5.03a.5.5 0 0 1 .47-.53zm5.058 0a.5.5 0 0 1 .47.53l-.5 8.5a.5.5 0 1 1-.998-.06l.5-8.5a.5.5 0 0 1 .528-.47M8 4.5a.5.5 0 0 1 .5.5v8.5a.5.5 0 0 1-1 0V5a.5.5 0 0 1 .5-.5"/></svg>
        </button>
      </div>`;

    const thumbImg = card.querySelector('.rp-sc-thumb-img');
    if (thumbImg) {
      thumbImg.addEventListener('load', () => { thumbImg.classList.add('loaded'); });   // fades in over the icon
      thumbImg.addEventListener('error', () => { thumbImg.remove(); });                 // leave the play icon
    }

    // Inline rename of the file on disk.
    card.querySelector('.rp-sc-ren')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const body = card.querySelector('.rp-sc-body'); if (!body) return;
      if (body.querySelector('.rp-sc-rename-input')) return;   // already editing
      const ext = (f.name.match(/\.[^.]+$/) || [''])[0];
      const base = f.name.replace(/\.[^.]+$/, '');
      const inp = document.createElement('input');
      inp.className = 'input-text rp-sc-rename-input';
      inp.value = base; inp.style.cssText = 'width:100%;padding:3px 6px;font-size:12px;';
      const nameEl = body.querySelector('.rp-sc-name');
      const prevHTML = body.innerHTML;
      body.innerHTML = ''; body.appendChild(inp);
      inp.focus(); inp.select();
      let committed = false;
      const restore = () => { if (!committed) body.innerHTML = prevHTML; };
      const commit = async () => {
        if (committed) return; committed = true;
        const nn = inp.value.trim();
        if (!nn || nn === base) { body.innerHTML = prevHTML; return; }
        try {
          const r = await fetch('http://127.0.0.1:3000/api/clips/rename-staged', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath: f.path, newName: nn })
          });
          const d = await r.json().catch(() => ({}));
          if (d.ok) {
            // Update local model + selection so the rename reflects immediately.
            if (_stagingSelectedPath === f.path) _stagingSelectedPath = d.path || f.path;
            if (_stagingSelected.has(f.path)) { _stagingSelected.delete(f.path); _stagingSelected.add(d.path || f.path); }
            const sf = _stagingFiles.find(x => x.path === f.path);
            if (sf) { sf.path = d.path || f.path; sf.name = d.name || (nn + ext); }
            renderStagingList();
          } else {
            committed = false; const st = el('clips-status'); if (st) { st.textContent = d.message || 'Rename failed.'; st.style.color = '#f56565'; }
            body.innerHTML = prevHTML;
          }
        } catch (err) { committed = false; body.innerHTML = prevHTML; }
      };
      inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') commit(); else if (ev.key === 'Escape') { committed = true; body.innerHTML = prevHTML; } });
      inp.addEventListener('blur', commit);
    });

    const pushToEditor = () => {
      _stagingSelectedPath = f.path;
      list.querySelectorAll('.rp-stage-card').forEach(c2 => c2.classList.toggle('active', c2.dataset.path === f.path));
      loadClipPreview({ rawPath: f.path, name: label, rawName: f.name, trimIn: 0, trimOut: null });
    };
    card.addEventListener('click', e => {
      if (e.target.closest('.rp-sc-addpl') || e.target.closest('.rp-sc-del') || e.target.closest('.rp-sc-check') || e.target.closest('.rp-sc-ren') || e.target.closest('.rp-sc-rename-input')) return;
      pushToEditor();
    });
    card.querySelector('.rp-sc-check input')?.addEventListener('change', function () {
      if (this.checked) _stagingSelected.add(f.path); else _stagingSelected.delete(f.path);
      card.classList.toggle('checked', this.checked);
      updateStagingBulkBar();
    });

    card.querySelector('.rp-sc-addpl')?.addEventListener('click', e => {
      e.stopPropagation();
      addStagingClipToReplays(f, e.currentTarget);
    });

    card.querySelector('.rp-sc-del')?.addEventListener('click', async e => {
      e.stopPropagation();
      if (!await appConfirm(`Delete "${f.name}" from OBS folder?`, 'Delete')) return;
      try {
        const r = await fetch('http://127.0.0.1:3000/api/clips/delete-staged', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: f.path })
        });
        if (r.ok) {
          _stagingFiles = _stagingFiles.filter(sf => sf.path !== f.path);
          _stagingTotal = Math.max(0, _stagingTotal - 1);
          if (_stagingSelectedPath === f.path) _stagingSelectedPath = null;
          renderStagingList();
          syncStagingCount();
        }
      } catch {}
    });

    list.appendChild(card);
  });

  // Thumbnails are server-rendered JPEGs loaded via native loading="lazy" — the browser
  // fetches them as they near the viewport (no observer needed), and they're cached
  // server-side so they never block the editor's video.
  if (typeof updateStagingBulkBar === 'function') updateStagingBulkBar();
}

// ── Staging multi-select (bulk delete) ──
const _stagingSelected = new Set();
function updateStagingBulkBar() {
  const bar = el('rp-stage-bulk'); if (!bar) return;
  // Drop selections for files no longer present.
  const present = new Set(_stagingFiles.map((f) => f.path));
  [..._stagingSelected].forEach((p) => { if (!present.has(p)) _stagingSelected.delete(p); });
  const n = _stagingSelected.size;
  bar.style.display = n ? 'flex' : 'none';
  const cnt = el('rp-stage-bulk-count'); if (cnt) cnt.textContent = n + ' selected';
}
el('rp-stage-bulk-clear')?.addEventListener('click', () => {
  _stagingSelected.clear();
  document.querySelectorAll('#rp-staging-list .rp-stage-card.checked').forEach((c) => { c.classList.remove('checked'); const cb = c.querySelector('.rp-sc-check input'); if (cb) cb.checked = false; });
  updateStagingBulkBar();
});
el('rp-stage-bulk-del')?.addEventListener('click', async () => {
  const paths = [..._stagingSelected];
  if (!paths.length) return;
  const ok = await customConfirm('Delete clips', `Delete ${paths.length} selected clip${paths.length === 1 ? '' : 's'} from the OBS folder? This cannot be undone.`, 'Delete');
  if (!ok) return;
  const btn = el('rp-stage-bulk-del'); if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
  let done = 0;
  for (const p of paths) {
    try {
      const r = await fetch('http://127.0.0.1:3000/api/clips/delete-staged', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath: p })
      });
      if (r.ok) { _stagingFiles = _stagingFiles.filter((sf) => sf.path !== p); _stagingSelected.delete(p); if (_stagingSelectedPath === p) _stagingSelectedPath = null; _stagingTotal = Math.max(0, _stagingTotal - 1); done++; }
    } catch {}
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Delete selected'; }
  renderStagingList();
  syncStagingCount();
  updateStagingBulkBar();
});

let _pendingNewMontage = false;
// Active shelf on the Replays page: 'replays' (raw capture pool) or 'highlights' (curated reels).
// Scopes the playlist list + which folder new/edited reels are sent to.
let _rpFolder = 'replays';

// Move a whole reel between shelves (the promote-the-reel action on a playlist row).
function rpMoveMontageFolder(montageId, folder) {
  send('montage_settings', { montageId, folder });
}

// Arm a reel for instant go-live: warm its FIRST clip (server transcodes + overlays pre-buffer it),
// so a later Play Live hits air with no prep beat. No encode — playout streams clip-by-clip.
function rpArmMontage(m) {
  if (!m || !(m.clipIds || []).length) return;
  const lib = (currentState.clips && currentState.clips.library) || [];
  const first = lib.find((cl) => cl.id === m.clipIds[0]);
  const url = first && (typeof clipUrl === 'function' ? clipUrl(first) : '');
  if (url) send('replay_arm', { bus: 'program', url });
}

// Keep the bulk shelf-action buttons in step with the active shelf: the Copy label names the OTHER
// shelf, and both disable when the current shelf has no reels.
function rpUpdateShelfActions() {
  const otherLabel = _rpFolder === 'highlights' ? 'Moments' : 'Highlights';
  const all = (currentState.clips && currentState.clips.montages) || [];
  const count = all.filter((x) => (x.folder || 'replays') === _rpFolder).length;
  const copyBtn = el('rp-copy-shelf');
  const clearBtn = el('rp-clear-shelf');
  if (copyBtn) { copyBtn.innerHTML = `Copy all &rarr; ${otherLabel}`; copyBtn.disabled = !count; }
  if (clearBtn) clearBtn.disabled = !count;
}
el('rp-copy-shelf')?.addEventListener('click', () => {
  const other = _rpFolder === 'highlights' ? 'replays' : 'highlights';
  send('montage_copy_shelf', { from: _rpFolder, to: other });
});
el('rp-clear-shelf')?.addEventListener('click', async () => {
  const all = (currentState.clips && currentState.clips.montages) || [];
  const count = all.filter((x) => (x.folder || 'replays') === _rpFolder).length;
  if (!count) return;
  const label = _rpFolder === 'highlights' ? 'Highlights' : 'Moments';
  const ok = await customConfirm('Clear shelf', `Remove all ${count} reel${count === 1 ? '' : 's'} from ${label}? Clips stay in your library.`, 'Clear');
  if (ok) send('montage_clear_shelf', { folder: _rpFolder });
});

// Which of the section's three tabs is showing: the clip pool (for the active shelf) or the
// playlists built from it. Playlists used to be a collapsed accordion UNDER the pool, which read as
// a footnote — it's a peer view of the same shelf, so it's a peer tab.
var _rpPoolView = 'pool';   // 'pool' (Moments / Highlights) | 'playlists' | 'obsfolder'
function rpApplyPoolView() {
  const pool = _rpPoolView === 'pool';
  const playlists = _rpPoolView === 'playlists';
  const obsfolder = _rpPoolView === 'obsfolder';
  ['rp-pool-bulk', 'rp-pool-shelf-actions', 'rp-clip-pool'].forEach((id) => {
    const n = el(id); if (!n) return;
    if (id === 'rp-pool-bulk') { n.style.display = pool && _poolSelected.size ? 'flex' : 'none'; return; }
    n.style.display = pool ? '' : 'none';
  });
  const sec = el('rp-pl-section'); if (sec) sec.style.display = playlists ? '' : 'none';
  if (playlists) rpSetPlaylistsSectionExpanded(true);
  const of = el('rpx-obsfolder'); if (of) of.style.display = obsfolder ? '' : 'none';
  const sw = el('rp-pl-shelf-switch');
  if (sw) sw.innerHTML = (_rpFolder === 'highlights' ? 'Highlights' : 'Moments') + ' &#8646;';
  const tabs = document.getElementById('rp-folder-tabs');
  if (tabs) tabs.querySelectorAll('.rp-folder-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.view ? b.dataset.view === _rpPoolView : (pool && b.dataset.folder === _rpFolder));
  });
}
// Switch shelf (Replays ⇄ Highlights) — used by the two shelf tabs and by the Playlists tab's own
// shelf toggle, so both stay in step.
function rpSetFolder(f) {
  f = f === 'highlights' ? 'highlights' : 'replays';
  if (f === _rpFolder) return;
  _rpFolder = f;
  // Leaving the current shelf — drop the selection so the pane opens fresh on the new shelf.
  const selEdit = el('select-montage-edit'); if (selEdit) selEdit.value = '';
  const selAdd = el('rp-add-to-playlist-sel'); if (selAdd) selAdd.value = '';
  _plCollapsed = false;
  rpUpdateShelfActions();
  if (currentState.clips) { renderClipPool(currentState.clips); renderPlaylistPane(currentState.clips); }
}
(function wireRpFolderTabs() {
  const tabs = document.getElementById('rp-folder-tabs');
  if (!tabs) return;
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.rp-folder-tab');
    if (!btn) return;
    if (btn.dataset.view === 'playlists' || btn.dataset.view === 'obsfolder') {
      _rpPoolView = btn.dataset.view;
      rpApplyPoolView();
      if (_rpPoolView === 'playlists' && currentState.clips) renderPlaylistPane(currentState.clips);
      if (_rpPoolView === 'obsfolder' && !_stagingLoading) scanStagingArea();
      return;
    }
    const f = btn.dataset.folder === 'highlights' ? 'highlights' : 'replays';
    const wasOther = _rpPoolView !== 'pool';
    _rpPoolView = 'pool';
    rpSetFolder(f);
    rpApplyPoolView();
    if (wasOther && currentState.clips) renderClipPool(currentState.clips);
  });
  el('rp-pl-shelf-switch')?.addEventListener('click', () => {
    rpSetFolder(_rpFolder === 'highlights' ? 'replays' : 'highlights');
    rpApplyPoolView();
  });
  // Deferred: this runs during top-level script execution, before the `let`s it touches further
  // down the file have initialised (see the TDZ crash this codebase has hit before).
  setTimeout(rpApplyPoolView, 0);
})();

// Import a raw staging file into the clip library (lands in the Replays pool — new imports always
// default to folder:'replays'). Shared by the staging card's own "→ Replays" action and by the
// Video Editor's "+ Add to playlist" button, which still needs an import-then-add in one step.
async function importStagingFile(f) {
  const resp = await fetch('http://127.0.0.1:3000/api/clips/import-file', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePath: f.path, label: cleanFileName(f.name) })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.message || 'Import failed');
  f.imported = true; f.importedId = data.clip?.id || null;
  renderStagingList();
  return data.clip || null;
}

async function addStagingClipToReplays(f, btn) {
  // New captures already default to folder:'replays' on import — the clip pool grid picks it up
  // automatically, no playlist required. Already-imported files are already sitting in a pool.
  if (f.imported && f.importedId) {
    const statusEl = el('clips-status');
    if (statusEl) { statusEl.textContent = 'Already in your library — check the Replays/Highlights pool.'; statusEl.style.color = 'var(--muted)'; }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  const statusEl = el('clips-status');
  try {
    await importStagingFile(f);
    if (statusEl) { statusEl.textContent = `Added to Replays: ${cleanFileName(f.name)}`; statusEl.style.color = 'var(--good,#48bb78)'; }
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = '→'; }
    if (statusEl) { statusEl.textContent = 'Import failed: ' + err.message; statusEl.style.color = '#f56565'; }
  }
}

// ── Hover preview ──────────────────────────────────────────────────────────
let _hoverTimer = null;
function showHoverPreview(clip, anchorEl) {
  clearTimeout(_hoverTimer);
  _hoverTimer = setTimeout(() => {
    const pop = el('rp-hover-preview'); if (!pop) return;
    const hv = el('rp-hover-video'); if (!hv) return;
    const url = clipUrl(clip); if (!url) return;
    hv.src = url; hv.currentTime = clip.trimIn || 0;
    hv.play().catch(() => {});
    const rect = anchorEl.getBoundingClientRect();
    pop.style.left = Math.min(rect.right + 10, window.innerWidth - 240) + 'px';
    pop.style.top = Math.max(rect.top, 10) + 'px';
    pop.style.display = 'block';
    requestAnimationFrame(() => pop.classList.add('visible'));
  }, 600);
}
function hideHoverPreview() {
  clearTimeout(_hoverTimer);
  const pop = el('rp-hover-preview'); if (!pop) return;
  pop.classList.remove('visible');
  const hv = el('rp-hover-video'); if (hv) { hv.pause(); hv.src = ''; }
  setTimeout(() => { if (!pop.classList.contains('visible')) pop.style.display = 'none'; }, 130);
}

// ── Playlist preview (watch a reel in the Video Editor, off air) ───────────
// "Play live" was the only way to actually SEE a playlist end to end, which meant punching it to
// air just to check it. This plays the reel locally in #clip-preview-video: clip by clip, honouring
// each clip's trim, auto-advancing at the out-point. Nothing is sent to any bus.
let _plPreview = null;         // { montageId, name, clips:[], idx }
let _plPreviewLoading = false; // guards the loadClipPreview() re-entry below

function rpPreviewClipsFor(m) {
  const lib = (currentState.clips && currentState.clips.library) || [];
  return (m.clipIds || []).map((id) => lib.find((cl) => cl.id === id)).filter((cl) => cl && clipUrl(cl));
}

function rpPreviewPlaylist(montageId) {
  const all = (currentState.clips && currentState.clips.montages) || [];
  const m = all.find((x) => x.id === montageId);
  if (!m) return;
  const clips = rpPreviewClipsFor(m);
  const st = el('rp-screen-status');
  if (!clips.length) {
    if (st) { st.textContent = 'Nothing to preview — this playlist has no playable clips.'; st.style.color = 'var(--muted)'; }
    return;
  }
  _plPreview = { montageId, name: m.name || 'Playlist', clips, idx: 0 };
  rpPreviewLoadIdx(0);
}

function rpPreviewLoadIdx(i) {
  if (!_plPreview) return;
  if (i < 0 || i >= _plPreview.clips.length) { rpPreviewStop(true); return; }
  _plPreview.idx = i;
  const clip = _plPreview.clips[i];
  const v = el('clip-preview-video');
  _plPreviewLoading = true;
  loadClipPreview(clip);
  _plPreviewLoading = false;
  rpPreviewSyncBar();
  if (!v) return;
  const start = () => {
    v.currentTime = clip.trimIn || 0;
    v.play().catch(() => {});   // autoplay can be refused before any user gesture; the strip still works
  };
  if (v.readyState >= 1) start();
  else v.addEventListener('loadedmetadata', start, { once: true });
}

function rpPreviewNext() { if (_plPreview) rpPreviewLoadIdx(_plPreview.idx + 1); }
function rpPreviewPrev() { if (_plPreview) rpPreviewLoadIdx(Math.max(0, _plPreview.idx - 1)); }

// finished=true means we ran off the end of the reel — leave the last frame up rather than yanking it.
function rpPreviewStop(finished) {
  if (!_plPreview) { rpPreviewSyncBar(); return; }
  const v = el('clip-preview-video');
  if (v && !finished) v.pause();
  _plPreview = null;
  rpPreviewSyncBar();
  const title = el('rp-editor-title'); if (title) title.textContent = 'Player';
}

function rpPreviewSyncBar() {
  const bar = el('rp-plprev-bar');
  if (bar) bar.style.display = _plPreview ? 'flex' : 'none';
  if (!_plPreview) return;
  const n = _plPreview.clips.length;
  const clip = _plPreview.clips[_plPreview.idx] || {};
  const nameEl = el('rp-plprev-name');
  if (nameEl) nameEl.textContent = `${_plPreview.name} — ${_plPreview.idx + 1}/${n} · ${clip.name || 'Clip'}`;
  const prev = el('rp-plprev-prev'); if (prev) prev.disabled = _plPreview.idx <= 0;
  const next = el('rp-plprev-next'); if (next) next.disabled = _plPreview.idx >= n - 1;
  const title = el('rp-editor-title'); if (title) title.textContent = 'Playlist Preview';
}

el('rp-plprev-next')?.addEventListener('click', rpPreviewNext);
el('rp-plprev-prev')?.addEventListener('click', rpPreviewPrev);
el('rp-plprev-exit')?.addEventListener('click', () => rpPreviewStop(false));

// Auto-advance: honour the clip's out-point, and fall through on natural end for untrimmed clips.
(function wirePlaylistPreviewAdvance() {
  const v = el('clip-preview-video'); if (!v) return;
  v.addEventListener('timeupdate', () => {
    if (!_plPreview) return;
    const clip = _plPreview.clips[_plPreview.idx];
    if (clip && clip.trimOut != null && v.currentTime >= clip.trimOut - 0.04) rpPreviewNext();
  });
  v.addEventListener('ended', () => { if (_plPreview) rpPreviewNext(); });
})();

// Preview the ENCODED file of a playlist (one continuous video, transitions baked in) — used by the
// Exports panel, where there are no source clips to walk.
function rpPreviewExport(m) {
  const url = montageUrl(m); if (!url) return;
  rpPreviewStop(false);
  loadClipPreview({ id: null, name: (m.name || 'Montage') + ' (encoded export)', _url: url, trimIn: 0, trimOut: null });
  const v = el('clip-preview-video');
  if (v) v.play().catch(() => {});
}

// ── Playlist pane ──────────────────────────────────────────────────────────
let timelineSortable = null;

function renderPlaylistPane(c) {
  const selEdit  = el('select-montage-edit');
  const selAdd   = el('rp-add-to-playlist-sel');
  const timeline = el('montage-timeline');
  const totalEl  = el('rp-pl-total');
  if (!selEdit || !timeline) return;
  // Scope everything below to the active shelf (Replays vs Highlights). A reel with no folder is
  // treated as a raw replay (matches the backend migration default).
  const allMontages = c.montages || [];
  const montages = allMontages.filter((x) => (x.folder || 'replays') === _rpFolder);
  // Light the shelf tab whose reel is currently on air.
  // Which shelf the live run belongs to. A POOL run has no montage id, so deriving this from the
  // playlist list alone fell through to 'replays' — a Highlights pool play lit the Replays tab and
  // left Highlights dark. _plLiveFolder is set by whoever started the run and wins.
  const liveFolder = !_plLiveActive ? null
    : (_plLiveFolder || (allMontages.find((x) => x.id === _plLiveMontageId) || {}).folder || 'replays');
  document.querySelectorAll('#rp-folder-tabs .rp-folder-live').forEach((dot) => {
    dot.classList.toggle('on', _plLiveActive && dot.dataset.folderLive === liveFolder);
  });
  rpUpdateShelfActions();
  // If the selected reel lives on the OTHER shelf (e.g. just moved, or a stale selection), drop it.
  if (selEdit.value && !montages.some((x) => x.id === selEdit.value)) selEdit.value = '';
  const prevId = selEdit.value;
  const opts = '<option value="">— New playlist —</option>' +
    montages.map((m) => `<option value="${m.id}">${m.name}</option>`).join('');
  selEdit.innerHTML = opts;
  if (selAdd) selAdd.innerHTML = opts;
  if (_pendingNewMontage && montages.length) {
    _pendingNewMontage = false;
    selEdit.value = montages[0].id;
    if (selAdd) selAdd.value = montages[0].id;
  } else if (prevId && montages.some((m) => m.id === prevId)) {
    selEdit.value = prevId;
    if (selAdd) selAdd.value = prevId;
  }
  const mId = selEdit.value;
  const m = montages.find((x) => x.id === mId);
  const lib = c.library || [];

  // Vertical playlist picker (click a row to select; the hidden <select> stays the source of truth).
  const listV = el('rp-playlist-list');
  if (listV) {
    const encodeActive = c.encode && c.encode.active;
    const encodeQueue = (c.encode && c.encode.queue) || [];
    // Badge label already varies with everything that should invalidate the cached render (clip
    // count via EMPTY, encode %, ready/draft, live attribution) — include it in sig so state
    // transitions actually repaint instead of getting stuck on a stale badge.
    const sig = JSON.stringify(montages.map((x) => [x.id, x.name, (x.clipIds || []).length, montageBadgeInfo(x, encodeActive, encodeQueue).label])) + '|' + mId + '|' + _rpFolder;
    const otherFolder = _rpFolder === 'highlights' ? 'replays' : 'highlights';
    const moveLabel = _rpFolder === 'highlights' ? 'Moments' : 'Highlights';
    if (listV.dataset.sig !== sig) {
      listV.dataset.sig = sig;
      listV.innerHTML = montages.length ? montages.map((x) => {
        const n = (x.clipIds || []).length;
        const isActive = x.id === mId;
        const badge = montageBadgeInfo(x, encodeActive, encodeQueue);
        return `<div class="rp-pl-row${isActive ? ' active' : ''}${isActive && _plCollapsed ? ' collapsed' : ''}" data-mid="${x.id}">
          <span class="rp-pl-row-chev">&#9660;</span>
          <button class="rp-pl-row-prev" data-mid="${x.id}" title="Watch this playlist in the player (off air)"${n ? '' : ' disabled'}>&#9654;</button>
          <span class="rp-pl-row-name">${(x.name || 'Playlist').replace(/</g, '&lt;')}</span>
          <span class="rp-pl-row-count">${n} clip${n === 1 ? '' : 's'}</span>
          <span class="rp-pl-badge rp-pl-badge--${badge.cls}">${badge.label}</span>
          <button class="rp-pl-row-move" data-mid="${x.id}" title="Move this reel to ${moveLabel}">&rarr; ${moveLabel}</button>
          <button class="rp-pl-row-del" data-mid="${x.id}" title="Delete this playlist">✕</button>
        </div>`;
      }).join('') : `<div class="rp-empty" style="padding:12px 6px;">No ${_rpFolder === 'highlights' ? 'highlight reels' : 'replay reels'} yet — hit <b>+ New</b>${_rpFolder === 'highlights' ? ' or move a reel over from Replays' : ' or add a clip from the editor'}.</div>`;
      listV.querySelectorAll('.rp-pl-row-move').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          rpMoveMontageFolder(btn.dataset.mid, otherFolder);
        });
      });
      listV.querySelectorAll('.rp-pl-row-prev').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const pl = montages.find((x) => x.id === btn.dataset.mid);
          if (pl && montageUrl(pl)) rpPreviewExport(pl);
          else rpPreviewPlaylist(btn.dataset.mid);
        });
      });
      listV.querySelectorAll('.rp-pl-row').forEach((row) => {
        row.addEventListener('click', (e) => {
          if (e.target.closest('.rp-pl-row-del') || e.target.closest('.rp-pl-row-prev')) return;
          if (row.classList.contains('active')) {
            // Toggle collapse without full re-render
            _plCollapsed = !_plCollapsed;
            row.classList.toggle('collapsed', _plCollapsed);
            const show = !_plCollapsed && !!m;
            const nameRow = el('rp-pl-name-row'); if (nameRow) nameRow.style.display = show ? '' : 'none';
            const liveRow = el('rp-pl-live-row'); if (liveRow) liveRow.style.display = show ? 'grid' : 'none';
            const transRow = el('rp-pl-trans-row'); if (transRow) transRow.style.display = show ? '' : 'none';
            const encOpts = el('rp-pl-encode-opts'); if (encOpts) encOpts.style.display = show ? '' : 'none';
            const urlRow  = el('rp-pl-url-row');  if (urlRow)  urlRow.style.display  = show ? '' : 'none';
            const tl = el('montage-timeline');    if (tl) tl.style.display = show ? '' : 'none';
            const tot = el('rp-pl-total');        if (tot) tot.style.display = show ? '' : 'none';
            return;
          }
          _plCollapsed = false;
          selEdit.value = row.dataset.mid;
          if (selAdd) selAdd.value = row.dataset.mid;
          // Pre-warm this reel's first clip so a subsequent Play Live is instant (stinger covers the cut).
          rpArmMontage(montages.find((x) => x.id === row.dataset.mid));
          renderPlaylistPane(currentState.clips || {});
        });
      });
      listV.querySelectorAll('.rp-pl-row-del').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const pl = montages.find((x) => x.id === btn.dataset.mid);
          const ok = await customConfirm('Delete Playlist', `Delete the playlist "${pl ? pl.name : ''}"? (Clips stay in your library.)`, 'Delete');
          if (!ok) return;
          if (selEdit.value === btn.dataset.mid) { selEdit.value = ''; if (selAdd) selAdd.value = ''; }
          send('montage_delete', { montageId: btn.dataset.mid });
        });
      });
    }
  }
  const show = m && !_plCollapsed;
  if (show) rpSetPlaylistsSectionExpanded(true);
  const nameRow = el('rp-pl-name-row');
  if (nameRow) nameRow.style.display = show ? '' : 'none';
  const statusLine = el('rp-pl-status');
  if (statusLine) statusLine.textContent = (show && m) ? montageStatusLine(m, c.encode && c.encode.active, c.encode && c.encode.queue) : '';
  const liveRow = el('rp-pl-live-row');
  if (liveRow) liveRow.style.display = show ? 'grid' : 'none';
  const transRow = el('rp-pl-trans-row');
  if (transRow) transRow.style.display = show ? '' : 'none';
  const encOpts = el('rp-pl-encode-opts');
  if (encOpts) encOpts.style.display = show ? '' : 'none';
  const urlRow = el('rp-pl-url-row');
  if (urlRow) {
    urlRow.style.display = show ? '' : 'none';
    if (show && m) {
      // One shared browser source for EVERYTHING (single clips + all playlists). Add this once to OBS;
      // clips and playlists all render here and the playlist just cuts to its chosen scene. (No more
      // per-playlist ?playlist=<id> sources — those fought each other.)
      const obsUrl = (window.SCENE_BASE_URL || 'http://localhost:3000') + '/replay-player.html';
      const urlText = el('rp-pl-url-text'); if (urlText) urlText.value = obsUrl;
      const copyBtn = el('rp-pl-url-copy');
      if (copyBtn && !copyBtn.dataset.wired) {
        copyBtn.dataset.wired = '1';
        copyBtn.addEventListener('click', () => {
          const txt = el('rp-pl-url-text'); if (!txt) return;
          navigator.clipboard.writeText(txt.value).then(() => {
            const orig = copyBtn.textContent; copyBtn.textContent = 'Copied!';
            setTimeout(() => { copyBtn.textContent = orig; }, 1800);
          }).catch(() => { txt.select(); document.execCommand('copy'); });
        });
      }
    }
  }
  if (m) syncPlaylistLiveControls(m);
  if (typeof updatePlaylistLiveBtns === 'function') updatePlaylistLiveBtns();

  if (!m || _plCollapsed) {
    timeline.style.display = '';
    timeline.innerHTML = _plCollapsed ? '' : '<div class="rp-empty">Select a playlist above to edit its clips.</div>';
    if (totalEl) { totalEl.textContent = ''; totalEl.style.display = ''; }
    return;
  }
  const nameEl = el('rp-playlist-name');
  if (nameEl && document.activeElement !== nameEl) nameEl.value = m.name || '';
  const clips = (m.clipIds || []).map((id) => lib.find((cl) => cl.id === id)).filter(Boolean);
  let totalSec = 0;
  clips.forEach((cl) => { totalSec += cl.trimOut != null ? cl.trimOut - (cl.trimIn || 0) : (cl.duration || 0); });
  timeline.innerHTML = clips.length ? clips.map((clip, i) => {
    const inPt  = clip.trimIn || 0;
    const outPt = clip.trimOut != null ? clip.trimOut : (clip.duration || 0);
    const len   = clip.trimOut != null ? clip.trimOut - inPt : (clip.duration || 0);
    const splitInfo = clip.trimOut != null || inPt > 0
      ? `<span style="color:var(--cp-accent,#7C3AED)">${fmtTime(inPt)} → ${fmtTime(outPt)}</span> · ${fmtTime(len)}`
      : fmtTime(len) || '—';
    const plUrl = clipUrl(clip);
    return `<div class="rp-pl-item" data-clip-id="${clip.id}">
      <span class="rp-pl-num">${i + 1}</span>
      <div class="rp-pl-thumb">${plUrl
        ? `<video muted playsinline preload="metadata" src="${plUrl}" style="width:100%;height:100%;object-fit:cover;display:none;" data-plthumb></video><svg viewBox="0 0 24 24" width="12" height="12" fill="rgba(255,255,255,0.3)"><path d="M8 5v14l11-7z"/></svg>`
        : `<svg viewBox="0 0 24 24" width="12" height="12" fill="rgba(255,255,255,0.3)"><path d="M8 5v14l11-7z"/></svg>`}</div>
      <div class="rp-pl-body">
        <div class="rp-pl-name">${(clip.name || 'Clip').replace(/</g, '&lt;')}</div>
        <div class="rp-pl-meta">${splitInfo}</div>
      </div>
      <button class="rp-pl-del" data-mid="${mId}" data-cid="${clip.id}">✕</button>
    </div>`;
  }).join('') : '<div class="rp-empty">Playlist is empty — add clips from the library or staging area</div>';
  if (totalEl) totalEl.textContent = clips.length ? `${clips.length} clip${clips.length === 1 ? '' : 's'} · ${fmtTime(totalSec)}` : '';
  timeline.querySelectorAll('video[data-plthumb]').forEach((v) => {
    v.addEventListener('loadedmetadata', () => { v.currentTime = Math.min(v.duration * 0.15, 3); });
    v.addEventListener('seeked', () => {
      v.style.display = 'block';
      v.parentElement?.querySelectorAll('svg').forEach(s => s.remove());
    });
  });
  timeline.querySelectorAll('.rp-pl-del').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const order = clips.map((cl) => cl.id).filter((id) => id !== btn.dataset.cid);
      send('montage_reorder', { montageId: btn.dataset.mid, clipIds: order });
    });
  });
  // Click a playlist clip → load it into the editor (with its saved trim) to adjust. While this same
  // reel is being previewed, a click jumps the preview to that clip instead of dropping out of it.
  timeline.querySelectorAll('.rp-pl-item').forEach((item) => {
    item.title = 'Click to open in the editor';
    item.addEventListener('click', (e) => {
      if (e.target.closest('.rp-pl-del')) return;
      if (_plPreview && _plPreview.montageId === mId) {
        const i = _plPreview.clips.findIndex((cl) => cl.id === item.dataset.clipId);
        if (i >= 0) { rpPreviewLoadIdx(i); return; }
      }
      const clip = clips.find((cl) => cl.id === item.dataset.clipId);
      if (clip) loadClipPreview(clip);
    });
  });
  if (timelineSortable) { timelineSortable.destroy(); timelineSortable = null; }
  if (clips.length > 1 && typeof Sortable !== 'undefined') {
    timelineSortable = Sortable.create(timeline, {
      animation: 150, draggable: '.rp-pl-item',
      onEnd: () => {
        const order = [...timeline.querySelectorAll('.rp-pl-item')].map((n) => n.dataset.clipId);
        send('montage_reorder', { montageId: mId, clipIds: order });
      }
    });
  }
}

// Expand/collapse the "Playlists on this shelf" section — collapsed by default so the clip pool
// (below) stays the primary view; auto-expands once a playlist is actually selected.
function rpSetPlaylistsSectionExpanded(expanded) {
  const body = el('rp-pl-section-body');
  const chev = el('rp-pl-section-chev');
  if (body) body.style.display = expanded ? '' : 'none';
  if (chev) chev.innerHTML = expanded ? '&#9662;' : '&#9656;';
}
el('rp-pl-section-toggle')?.addEventListener('click', () => {
  const body = el('rp-pl-section-body');
  rpSetPlaylistsSectionExpanded(!body || body.style.display === 'none');
});

// ── Clip pool grid (Replays / Highlights) ──────────────────────────────────
// The primary way a clip gets organized: it lands here straight from capture/import, no playlist
// wrapper required. Multi-select feeds "Make Playlist" (a deliberate, separate action) which combines
// several pool clips into one encoded video via the existing montage/playlist pipeline below.
let _poolSelected = new Set();

function rpUpdatePoolBulkBar() {
  const bar = el('rp-pool-bulk');
  if (!bar) return;
  bar.style.display = (_poolSelected.size && _rpPoolView === 'pool') ? 'flex' : 'none';
  const count = el('rp-pool-bulk-count');
  if (count) count.textContent = `${_poolSelected.size} selected`;
  const copyBtn = el('rp-pool-bulk-copy');
  if (copyBtn) copyBtn.innerHTML = `Copy &rarr; ${_rpFolder === 'highlights' ? 'Moments' : 'Highlights'}`;
}

// Transition for pushing pool clips live (per-row single To Air + the bulk bar's To Air) — a separate,
// always-visible control from the Playlists section's own #rp-transition, so picking a transition for
// an instant pool push never silently rewrites a saved playlist's transition setting.
function poolTransitionOpts() {
  const mode = el('rp-pool-transition')?.value || 'fade';
  const transitionLogo = mode === 'logo'
    ? (_transitionLogo || (currentState.brand && currentState.brand.logo) || '')
    : '';
  if (mode === 'stinger') {
    // No stinger uploaded yet → a crossfade, not a broken sting. (The overlay can't play a file it
    // was never given, and silently doing nothing reads as "transitions don't work".)
    if (!_rpStinger.url) return { transition: 'fade', transitionLogo: '', stinger: '', stingerPoint: 0 };
    return { transition: 'stinger', transitionLogo: '', stinger: _rpStinger.url, stingerPoint: _rpStinger.point || 0 };
  }
  if (mode === 'obs') {
    const name = el('rp-pool-obstrans')?.value || '';
    // OBS transition picked but OBS has none to give (not connected / empty list) — crossfade.
    if (!name) return { transition: 'fade', transitionLogo: '', stinger: '', stingerPoint: 0 };
    const dur = Number(el('rp-pool-obstrans-dur')?.value) || 0;
    // OBS runs the transition on the SCENE CUT (obsTransition rides the switch). Between clips
    // there's no scene change for OBS to transition on — so if the chosen transition is a stinger,
    // the player runs that same stinger video itself, at OBS's own transition point. Anything else
    // (fade/wipe/luma) degrades to the player's crossfade rather than a bare cut.
    const info = (_rpObsTrans.name === name && _rpObsTrans.hasVideo) ? _rpObsTrans : null;
    if (info) {
      return { transition: 'stinger', transitionLogo: '', stinger: info.url, stingerPoint: info.point || 0,
        // Measured length (ffprobe) so the player can time the sting even when the file's own header
        // has no duration — the usual case for OBS .webm stingers.
        stingerDuration: info.lengthMs || info.duration || 0,
        obsTransition: name, obsDuration: dur };
    }
    return { transition: 'fade', transitionLogo: '', stinger: '', stingerPoint: 0,
      obsTransition: name, obsDuration: dur };
  }
  return { transition: mode, transitionLogo, stinger: '', stingerPoint: 0 };
}

// Every clip id on the active shelf, in the order the pool lists them — the running order both
// "Play all" and "Select all" use.
function rpPoolClipIds() {
  const lib = (currentState.clips && currentState.clips.library) || [];
  return lib.filter((cl) => (cl.folder || 'replays') === _rpFolder).map((cl) => cl.id);
}

// ── Moments / Highlights cards ─────────────────────────────────────────────
// What a moment is called on its card. Capture gives most clips a generic name ("Manual clip", a
// file timestamp), which tells a producer nothing; an event type (Goal, Save…) or a title the
// producer typed is what they scan for.
var RP_GENERIC_NAME = /^(manual clip|highlight|clip|replay|untitled)$|^(replay\s*)?\d{4}-\d{2}-\d{2}\b/i;
function rpTimeLabel(ms) {
  return ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}
function rpMomentTitle(clip) {
  const name = String(clip.name || '').trim();
  const type = String(clip.type || '').trim();
  // A name that is just the event type ("Goal") gets the player added, like an untitled one.
  if (name && !RP_GENERIC_NAME.test(name) && name.toLowerCase() !== type.toLowerCase()) return name;
  if (type && !/^(manual|highlight|import)$/i.test(type)) {
    const t = type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, ' ');
    return clip.player ? t + ' · ' + clip.player : t;
  }
  return 'Replay ' + rpTimeLabel(clip.createdAt);
}
// The match a moment belongs to ("FRT vs EMB · Game 3"), stamped at capture. Older clips have none
// and group by day instead.
function rpMomentGroup(clip) {
  if (clip.match) return clip.match + (clip.gameNumber ? ' · Game ' + clip.gameNumber : '');
  if (!clip.createdAt) return 'Earlier';
  const d = new Date(clip.createdAt), today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
// Starred = a Highlights copy made from this moment exists.
function rpHighlightCopyOf(clipId) {
  const lib = (currentState.clips && currentState.clips.library) || [];
  return lib.find((cl) => (cl.folder || 'replays') === 'highlights' && cl.copiedFrom === clipId) || null;
}
function rpToggleStar(clip) {
  if (!clip) return;
  const copy = rpHighlightCopyOf(clip.id);
  if (copy) { send('clip_remove', { id: copy.id }); showToast('Removed from Highlights.', '#94a3b8', 1800); }
  else { send('clip_copy_folder', { id: clip.id, folder: 'highlights' }); showToast('Starred: added to Highlights.', '#22c55e', 1800); }
}

function renderClipPool(c) {
  const grid = el('rp-clip-pool');
  if (!grid) return;
  const lib = (c && c.library) || [];
  const clips = lib.filter((cl) => (cl.folder || 'replays') === _rpFolder);
  const isHl = _rpFolder === 'highlights';
  // Drop selections that fell off this shelf (copied away, deleted, or a shelf switch).
  const validIds = new Set(clips.map((cl) => cl.id));
  let selChanged = false;
  [..._poolSelected].forEach((id) => { if (!validIds.has(id)) { _poolSelected.delete(id); selChanged = true; } });
  const clearBtn = el('rp-clear-pool');
  if (clearBtn) clearBtn.disabled = !clips.length;
  const playAllBtn = el('rp-pool-playall');
  if (playAllBtn) {
    playAllBtn.disabled = !clips.length;
    playAllBtn.innerHTML = clips.length ? `&#9654; Play all (${clips.length})` : '&#9654; Play all';
  }
  const selAllBtn = el('rp-pool-selectall');
  if (selAllBtn) {
    selAllBtn.disabled = !clips.length;
    selAllBtn.textContent = (clips.length && clips.every((cl) => _poolSelected.has(cl.id))) ? 'Deselect all' : 'Select all';
  }
  rpSyncTabCounts(c);

  const starred = new Set(lib.filter((cl) => (cl.folder || 'replays') === 'highlights' && cl.copiedFrom).map((cl) => cl.copiedFrom));
  const sig = JSON.stringify(clips.map((cl) => [cl.id, cl.name, cl.type, cl.player, cl.match, cl.gameNumber, cl.trimIn, cl.trimOut, cl.duration, starred.has(cl.id)]))
    + '|' + _rpFolder + '|' + [..._poolSelected].sort().join(',') + '|' + (selectedClipId || '') + '|' + rpQ().join(',');
  if (grid.dataset.sig === sig) { if (selChanged) rpUpdatePoolBulkBar(); return; }
  grid.dataset.sig = sig;

  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const card = (clip) => {
    const dur = clip.trimOut != null ? clip.trimOut - (clip.trimIn || 0) : (clip.duration || 0);
    const qPos = rpQ().indexOf(clip.id);
    const isStar = starred.has(clip.id);
    const title = rpMomentTitle(clip);
    const meta = [clip.gameClock ? String(clip.gameClock) : '', rpTimeLabel(clip.createdAt)].filter(Boolean).join(' · ');
    return `<div class="rp-pool-item rpx-card${_poolSelected.has(clip.id) ? ' checked' : ''}${selectedClipId === clip.id ? ' active' : ''}${qPos >= 0 ? ' queued' : ''}" data-cid="${clip.id}">
      <div class="rpx-card-media">
        <img class="rp-sc-thumb-img" alt="" loading="lazy" src="${thumbUrl(clip.path)}">
        <svg class="rpx-card-ph" viewBox="0 0 24 24" width="22" height="22" fill="rgba(255,255,255,0.25)"><path d="M8 5v14l11-7z"/></svg>
        ${dur ? `<span class="rpx-card-dur">${fmtTime(dur)}</span>` : ''}
        ${qPos >= 0 ? `<span class="rpx-card-qbadge" title="Position in Up next">Next #${qPos + 1}</span>` : ''}
        <label class="rp-sc-check" title="Select"><input type="checkbox"${_poolSelected.has(clip.id) ? ' checked' : ''}></label>
        ${isHl ? `<span class="rp-sc-grip" title="Drag to change the reel order" draggable="true"><svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><circle cx="5" cy="3" r="1.4"/><circle cx="11" cy="3" r="1.4"/><circle cx="5" cy="8" r="1.4"/><circle cx="11" cy="8" r="1.4"/><circle cx="5" cy="13" r="1.4"/><circle cx="11" cy="13" r="1.4"/></svg></span>` : ''}
      </div>
      <div class="rpx-card-body">
        <div class="rpx-card-title" title="${esc(title)}">${esc(title)}</div>
        <div class="rpx-card-meta">${esc(meta)}</div>
      </div>
      <div class="rpx-card-acts">
        <button class="rpx-act rpx-act-air rp-pool-air" title="Show now: play this on air">&#9654; Air</button>
        <button class="rpx-act rpx-act-q${qPos >= 0 ? ' is-on' : ''}" title="${qPos >= 0 ? 'Take it out of Up next' : 'Add to Up next'}">${qPos >= 0 ? 'Queued' : '+ Next'}</button>
        ${isHl ? '' : `<button class="rpx-act rpx-act-star${isStar ? ' is-on' : ''}" title="${isStar ? 'Starred: in Highlights. Click to remove it from Highlights' : 'Star: copy to Highlights'}">&#9733;</button>`}
        <button class="rpx-act rpx-act-del rp-pool-del" title="${isHl ? 'Remove from Highlights' : 'Delete this moment'}"><svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/><path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4zM2.5 3h11V2h-11z"/></svg></button>
      </div>
    </div>`;
  };

  if (!clips.length) {
    grid.innerHTML = isHl
      ? '<div class="rp-empty rpx-empty"><b>No highlights yet</b><span>Star a moment (&#9733;) to copy it here. Highlights play in the order shown; drag to change it.</span></div>'
      : '<div class="rp-empty rpx-empty"><b>No moments yet</b><span>Press Capture during the game. Every capture lands here, newest first, grouped by match.</span></div>';
  } else if (isHl) {
    grid.innerHTML = `<div class="rpx-cards">${clips.map(card).join('')}</div>`;
  } else {
    // Moments: grouped by match / game in capture order (newest first).
    let html = '', cur = null;
    clips.forEach((clip) => {
      const g = rpMomentGroup(clip);
      if (g !== cur) {
        if (cur !== null) html += '</div>';
        html += `<div class="rpx-group-head">${esc(g)}</div><div class="rpx-cards">`;
        cur = g;
      }
      html += card(clip);
    });
    grid.innerHTML = html + '</div>';
  }

  grid.querySelectorAll('.rp-sc-thumb-img').forEach((img) => {
    img.addEventListener('load', () => img.classList.add('loaded'));
    img.addEventListener('error', () => img.remove());
  });

  grid.querySelectorAll('.rp-pool-item').forEach((row) => {
    const clip = clips.find((cl) => cl.id === row.dataset.cid);
    row.addEventListener('click', (e) => {
      if (e.target.closest('.rp-sc-check') || e.target.closest('.rpx-act') || e.target.closest('.rp-sc-grip')) return;
      if (clip) loadClipPreview(clip);
    });
    row.querySelector('.rp-sc-check input')?.addEventListener('change', function () {
      if (this.checked) _poolSelected.add(row.dataset.cid); else _poolSelected.delete(row.dataset.cid);
      row.classList.toggle('checked', this.checked);
      rpUpdatePoolBulkBar();
    });
    // One-click instant replay: load it (so trims/scene/loop apply) and send straight to Program.
    row.querySelector('.rp-pool-air')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!clip) return;
      loadClipPreview(clip);
      sendToScreen('program', poolTransitionOpts());
    });
    row.querySelector('.rpx-act-q')?.addEventListener('click', (e) => {
      e.stopPropagation();
      rpQueueToggle(row.dataset.cid);
    });
    row.querySelector('.rpx-act-star')?.addEventListener('click', (e) => {
      e.stopPropagation();
      rpToggleStar(clip);
    });
    row.querySelector('.rp-pool-del')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      // Taking a starred copy out of Highlights only drops the copy; the moment stays.
      const ok = isHl && clip && clip.copiedFrom
        ? true
        : await customConfirm(isHl ? 'Remove from Highlights' : 'Delete moment', `${isHl ? 'Remove' : 'Delete'} "${clip ? rpMomentTitle(clip) : 'this clip'}"? This also removes it from any playlist using it.`, isHl ? 'Remove' : 'Delete');
      if (!ok) return;
      _poolSelected.delete(row.dataset.cid);
      rpQueueRemove(row.dataset.cid);
      send('clip_remove', { id: row.dataset.cid });
    });
  });

  rpUpdatePoolBulkBar();
}

// ── Up next: moments lined up for the next stoppage ────────────────────────
// An ordered list of clip ids, kept on this computer, rolled back to back through the same engine
// as Play all (poolPlayLive). Rolling empties it, the way a replay operator's queue works.
// `var` + rpQ(): renderClipPool can run before this part of the file has executed.
var _rpQueue;
var _rpQueueSortable = null;
function rpQ() {
  if (!Array.isArray(_rpQueue)) {
    try { _rpQueue = JSON.parse(localStorage.getItem('ne_rp_queue') || '[]').filter((x) => typeof x === 'string'); } catch (e) { _rpQueue = []; }
  }
  return _rpQueue;
}
function rpQueueSave() { try { localStorage.setItem('ne_rp_queue', JSON.stringify(rpQ())); } catch (e) {} }
function rpQueueChanged() {
  rpQueueSave();
  rpRenderQueue();
  if (currentState.clips) renderClipPool(currentState.clips);
  rpSyncPlayerActions();
}
function rpQueueToggle(id) {
  if (!id) return;
  const q = rpQ(), i = q.indexOf(id);
  if (i >= 0) q.splice(i, 1); else q.push(id);
  rpQueueChanged();
}
function rpQueueRemove(id) {
  const q = rpQ(), i = q.indexOf(id);
  if (i >= 0) { q.splice(i, 1); rpQueueChanged(); }
}
function rpQueueClips() {
  const lib = (currentState.clips && currentState.clips.library) || [];
  return rpQ().map((id) => lib.find((cl) => cl.id === id)).filter(Boolean);
}
function rpRenderQueue() {
  const list = el('rpx-queue-list'); if (!list) return;
  const lib = (currentState.clips && currentState.clips.library) || [];
  // Moments deleted elsewhere fall out of the queue.
  if (lib.length || currentState.clips) {
    const have = new Set(lib.map((cl) => cl.id));
    const q = rpQ(), kept = q.filter((id) => have.has(id));
    if (kept.length !== q.length) { _rpQueue = kept; rpQueueSave(); }
  }
  const clips = rpQueueClips();
  const total = clips.reduce((t, cl) => t + (cl.trimOut != null ? cl.trimOut - (cl.trimIn || 0) : (cl.duration || 0)), 0);
  const cnt = el('rpx-queue-count');
  if (cnt) cnt.textContent = clips.length ? `${clips.length} moment${clips.length === 1 ? '' : 's'}${total ? ' · ' + fmtTime(total) : ''}` : '';
  const roll = el('rpx-queue-roll');
  if (roll) { roll.disabled = !clips.length; roll.innerHTML = clips.length ? `&#9654; Roll ${clips.length}` : '&#9654; Roll'; }
  const clr = el('rpx-queue-clear'); if (clr) clr.disabled = !clips.length;
  const box = el('rpx-queue'); if (box) box.classList.toggle('is-empty', !clips.length);

  const sig = clips.map((cl) => cl.id + ':' + cl.name + ':' + cl.trimIn + ':' + cl.trimOut).join('|') + '|' + (selectedClipId || '');
  if (list.dataset.sig === sig) return;
  list.dataset.sig = sig;
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  list.innerHTML = clips.length ? clips.map((cl, i) => {
    const dur = cl.trimOut != null ? cl.trimOut - (cl.trimIn || 0) : (cl.duration || 0);
    const title = rpMomentTitle(cl);
    return `<div class="rpx-qitem${selectedClipId === cl.id ? ' active' : ''}" data-cid="${cl.id}" title="${esc(title)}">
      <span class="rpx-qnum">${i + 1}</span>
      <div class="rpx-qthumb"><img alt="" loading="lazy" src="${thumbUrl(cl.path)}"></div>
      <div class="rpx-qtext"><b>${esc(title)}</b><span>${dur ? fmtTime(dur) : ''}</span></div>
      <button class="rpx-qx" title="Take out of Up next">&times;</button>
    </div>`;
  }).join('') : '<div class="rpx-queue-hint">Press <b>+ Next</b> on a moment to line it up for the next stoppage, then <b>Roll</b> plays them back to back.</div>';
  list.querySelectorAll('.rpx-qthumb img').forEach((img) => img.addEventListener('error', () => img.remove()));
  list.querySelectorAll('.rpx-qitem').forEach((it) => {
    it.addEventListener('click', (e) => {
      if (e.target.closest('.rpx-qx')) { rpQueueRemove(it.dataset.cid); return; }
      const cl = clips.find((x) => x.id === it.dataset.cid);
      if (cl) loadClipPreview(cl);
    });
  });
  if (_rpQueueSortable) { try { _rpQueueSortable.destroy(); } catch (e) {} _rpQueueSortable = null; }
  if (clips.length > 1 && typeof Sortable !== 'undefined') {
    _rpQueueSortable = Sortable.create(list, {
      animation: 150, draggable: '.rpx-qitem', direction: 'horizontal',
      onEnd: () => {
        _rpQueue = [...list.querySelectorAll('.rpx-qitem')].map((n) => n.dataset.cid);
        list.dataset.sig = '';
        rpQueueChanged();
      }
    });
  }
}
el('rpx-queue-roll')?.addEventListener('click', () => {
  const ids = rpQueueClips().map((cl) => cl.id);
  if (!ids.length) return;
  poolPlayLive(ids);
  showToast(`Rolling ${ids.length} moment${ids.length === 1 ? '' : 's'}.`, '#22c55e', 2200);
  _rpQueue = [];
  rpQueueChanged();
});
el('rpx-queue-clear')?.addEventListener('click', () => { _rpQueue = []; rpQueueChanged(); });
el('rp-pool-bulk-queue')?.addEventListener('click', () => {
  const q = rpQ();
  let added = 0;
  [..._poolSelected].forEach((id) => { if (!q.includes(id)) { q.push(id); added++; } });
  if (added) showToast(`${added} added to Up next.`, '#22c55e', 1800);
  rpQueueChanged();
});

// ── Player: Up next / Highlight buttons for the loaded moment, and the empty state ──
function rpLoadedLibraryClip() {
  if (!selectedClipId) return null;
  const lib = (currentState.clips && currentState.clips.library) || [];
  return lib.find((cl) => cl.id === selectedClipId) || null;
}
function rpSyncPlayerActions() {
  const clip = rpLoadedLibraryClip();
  const qb = el('rpx-queue-add');
  if (qb) {
    const inQ = !!clip && rpQ().includes(clip.id);
    qb.disabled = !clip;
    qb.textContent = inQ ? 'Queued' : '+ Up next';
    qb.classList.toggle('is-on', inQ);
    qb.title = !clip ? 'Only moments can be queued (this file is not imported)' : inQ ? 'Take it out of Up next' : 'Add this moment to Up next';
  }
  const sb = el('rpx-star-cur');
  if (sb) {
    const hl = !!clip && (clip.folder || 'replays') === 'highlights';
    const on = !!clip && !hl && !!rpHighlightCopyOf(clip.id);
    sb.disabled = !clip || hl;
    sb.innerHTML = hl ? '&#9733; In Highlights' : on ? '&#9733; Starred' : '&#9733; Highlight';
    sb.classList.toggle('is-on', on || hl);
  }
  const v = el('clip-preview-video'), empty = el('rpx-player-empty');
  if (empty) empty.style.display = (v && v.currentSrc) ? 'none' : '';
}
el('rpx-queue-add')?.addEventListener('click', () => { const c = rpLoadedLibraryClip(); if (c) rpQueueToggle(c.id); });
el('rpx-star-cur')?.addEventListener('click', () => { rpToggleStar(rpLoadedLibraryClip()); setTimeout(rpSyncPlayerActions, 400); });
el('clip-preview-video')?.addEventListener('loadedmetadata', rpSyncPlayerActions);
el('clip-preview-video')?.addEventListener('emptied', rpSyncPlayerActions);

// Tab counts: Moments / Highlights / Playlists.
function rpSyncTabCounts(c) {
  const lib = (c && c.library) || [];
  const n = (f) => lib.filter((cl) => (cl.folder || 'replays') === f).length;
  const set = (id, v) => { const e = el(id); if (e) e.textContent = v ? String(v) : ''; };
  set('rpx-count-replays', n('replays'));
  set('rpx-count-highlights', n('highlights'));
  set('rpx-count-playlists', ((c && c.montages) || []).length);
}

// Deck: what's on air.
function rpSyncOnAir(onAir) {
  const tag = el('rpx-onair-tag'), box = el('rpx-onair');
  if (tag) tag.textContent = onAir ? 'On air' : 'Off air';
  if (box) box.classList.toggle('is-live', !!onAir);
}

// The page keeps these in step with clips_update / full_state through applyClipsState; the
// interval covers what changes outside it (a playlist ending, the loaded clip).
setInterval(() => {
  if (!document.querySelector('#tab-replays-content.active')) return;
  rpRenderQueue();
  rpSyncPlayerActions();
}, 1000);

// Drag the pool into show order (grip handle only, so a card click still loads the clip). Persisted
// server-side via clip_reorder — the same order the pool's Play all and Make Playlist then use.
(function wireClipPoolDrag() {
  const grid = el('rp-clip-pool'); if (!grid) return;
  let dragId = null;
  grid.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.rp-pool-item');
    if (!card || !e.target.closest('.rp-sc-grip')) { e.preventDefault(); return; }
    dragId = card.dataset.cid;
    card.classList.add('rp-pool-drag');
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); } catch (_) {}
  });
  grid.addEventListener('dragend', () => {
    grid.querySelectorAll('.rp-pool-drag, .rp-pool-over').forEach((n) => n.classList.remove('rp-pool-drag', 'rp-pool-over'));
    dragId = null;
  });
  grid.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const card = e.target.closest('.rp-pool-item');
    grid.querySelectorAll('.rp-pool-over').forEach((n) => { if (n !== card) n.classList.remove('rp-pool-over'); });
    if (card && card.dataset.cid !== dragId) card.classList.add('rp-pool-over');
  });
  grid.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const card = e.target.closest('.rp-pool-item'); if (!card) return;
    const ids = rpPoolClipIds();
    const from = ids.indexOf(dragId), to = ids.indexOf(card.dataset.cid);
    if (from < 0 || to < 0 || from === to) return;
    const [m] = ids.splice(from, 1); ids.splice(to, 0, m);
    // Optimistic local reorder so the grid doesn't snap back while the server round-trips.
    const lib = (currentState.clips && currentState.clips.library) || [];
    const pos = []; lib.forEach((c, i) => { if ((c.folder || 'replays') === _rpFolder) pos.push(i); });
    pos.forEach((slot, n) => { const c = lib.find((x) => x.id === ids[n]); if (c) lib[slot] = c; });
    send('clip_reorder', { folder: _rpFolder, ids });
    renderClipPool(currentState.clips);
  });
})();

el('rp-pool-bulk-clearsel')?.addEventListener('click', () => {
  _poolSelected.clear();
  if (currentState.clips) renderClipPool(currentState.clips);
});
el('rp-pool-bulk-copy')?.addEventListener('click', () => {
  const other = _rpFolder === 'highlights' ? 'replays' : 'highlights';
  const n = _poolSelected.size;
  _poolSelected.forEach((id) => send('clip_copy_folder', { id, folder: other }));
  showToast(`Copied ${n} clip${n === 1 ? '' : 's'} to ${other === 'highlights' ? 'Highlights' : 'Moments'}.`, '#22c55e', 2200);
});
// ── Go-live hold: buffer the first clip BEFORE cutting to the replay scene ─────────────────────
// The scene cut used to fire first and the clip started loading after it, so the OBS transition
// landed on an empty player and the top of every run was black. This arms the first clip (server
// prepares it if needed, overlay buffers it) and resolves when the overlay reports a real frame is
// ready — or on a timeout, so a go-live can never be blocked by a slow file.
let _armWait = null;
function rpFinishArm() {
  if (!_armWait) return;
  clearTimeout(_armWait.timer);
  const r = _armWait.resolve;
  _armWait = null;
  r();
}
// Called from the ws handler when the overlay confirms a buffered clip.
function rpOnArmed(url) { if (_armWait && (!url || url === _armWait.url || _armWait.anyUrl)) rpFinishArm(); }
// Called when the server says this clip needs converting first — stretch the hold instead of
// cutting to black, since that conversion can take tens of seconds on a long file.
function rpOnArmPreparing() {
  if (!_armWait) return;
  clearTimeout(_armWait.timer);
  _armWait.timer = setTimeout(rpFinishArm, 90000);
}
function rpArmFirstClip(url, timeoutMs) {
  return new Promise((resolve) => {
    if (!url) return resolve();
    rpFinishArm();                       // supersede any hold still pending
    // The overlay reports the PREPARED url, which can differ from the one we sent — accept any
    // armed report for this hold rather than trying to predict the transcode's filename.
    _armWait = { url, anyUrl: true, resolve, timer: setTimeout(() => rpFinishArm(), timeoutMs || 4000) };
    send('replay_arm', { bus: 'program', url });
  });
}

// Play a run of pool clips back-to-back on air right now — the same per-clip, no-encode-required
// engine playMontageById() drives for a saved playlist (_plLiveItems/playNextLive/advancePlaylist
// below), just seeded from an ad-hoc id list instead of a persisted montage.clipIds. Shared by the
// bulk bar's To Air (checked clips) and the shelf's Play all (the whole pool, in display order).
async function poolPlayLive(ids) {
  const lib = (currentState.clips && currentState.clips.library) || [];
  _plLiveItems = (ids || []).map((id) => lib.find((cl) => cl.id === id)).filter(Boolean).map(clipToLiveItem);
  if (!_plLiveItems.length) return;
  const programScene = (el('rp-program-scene')?.value || '').trim();
  if (!programScene) showToast('No OBS scene selected — set "Plays in" at the top of the Replays page so OBS switches to the replay-player source.', '#fbbf24', 5000);
  _plLoop = !!el('rp-loop')?.checked;
  _plReturnScene = '';
  _plScene = programScene;
  // The pool's own transition picker (not the Playlists section's) — playNextLive() preloads each
  // next clip into the element the next transition will actually use, so the advance is a real
  // cut/fade/logo/stinger instead of a black-screen gap.
  const _pt = poolTransitionOpts();
  _plTransition = { type: _pt.transition, stinger: _pt.stinger, stingerPoint: _pt.stingerPoint,
    obsTransition: _pt.obsTransition, obsDuration: _pt.obsDuration };
  _plKind = 'replay';
  // In OBS-transition mode the cut onto the replay scene is OBS's sting — don't let the player
  // play the same sting over the first clip immediately afterwards.
  _plSkipStingOnce = !!(_plTransition.obsTransition && willObsCutScene(programScene));
  stopOtherProgramSources('program');
  _plBus = 'program';
  _plEncodedMode = false;
  _plLiveMontageId = null;
  _plLiveFolder = _rpFolder;          // light the shelf this run came from
  // Buffer clip 1 BEFORE the scene cut — the OBS transition then reveals a frame, not black.
  await rpArmFirstClip(_plLiveItems[0].url);
  beginReplayProgram(_plScene || undefined, _plTransition);
  _plLiveActive = true;
  if (typeof updatePlaylistLiveBtns === 'function') updatePlaylistLiveBtns();
  if (currentState.clips) renderPlaylistPane(currentState.clips);   // light this shelf's live dot now
  _plLiveIdx = 0; playNextLive();
}
el('rp-pool-bulk-air')?.addEventListener('click', () => {
  if (!_poolSelected.size) return;
  poolPlayLive([..._poolSelected]);            // Set order = the order they were checked
});
// Play the WHOLE shelf, in the order it's listed — the "just play everything in here" path that
// previously required checking every clip first (or building and encoding a playlist).
el('rp-pool-playall')?.addEventListener('click', () => {
  const ids = rpPoolClipIds();
  if (!ids.length) return;
  poolPlayLive(ids);
  showToast(`Playing ${ids.length} clip${ids.length === 1 ? '' : 's'} back-to-back.`, '#22c55e', 2600);
});
el('rp-pool-stopall')?.addEventListener('click', () => { stopPlayoutLive(); updatePlaylistLiveBtns(); });
el('rp-pool-selectall')?.addEventListener('click', () => {
  const ids = rpPoolClipIds();
  // Toggle: a second click clears, so this one button covers select-all and deselect-all.
  const all = ids.length && ids.every((id) => _poolSelected.has(id));
  _poolSelected = new Set(all ? [] : ids);
  if (currentState.clips) renderClipPool(currentState.clips);
});
el('rp-pool-bulk-makepl')?.addEventListener('click', async () => {
  if (!_poolSelected.size) return;
  const preset = 'Playlist ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const name = await customPrompt('New playlist', `Combine ${_poolSelected.size} selected clip${_poolSelected.size === 1 ? '' : 's'} into a playlist`, preset, 'Create');
  if (!name) return;
  _pendingNewMontage = true;
  send('montage_create', { name, clipIds: [..._poolSelected], template: el('select-montage-template')?.value || 'highlights', folder: _rpFolder });
  _poolSelected.clear();
  // Surface the new playlist immediately — it lives on the Playlists tab now.
  _rpPoolView = 'playlists';
  rpApplyPoolView();
  rpSetPlaylistsSectionExpanded(true);
});
el('rp-pool-bulk-del')?.addEventListener('click', async () => {
  const n = _poolSelected.size;
  if (!n) return;
  const ok = await customConfirm('Delete Clips', `Delete ${n} selected clip${n === 1 ? '' : 's'}? This also removes them from any playlist using them.`, 'Delete');
  if (!ok) return;
  const ids = [..._poolSelected];
  _poolSelected.clear();
  ids.forEach((id) => send('clip_remove', { id }));
});
el('rp-clear-pool')?.addEventListener('click', async () => {
  const lib = (currentState.clips && currentState.clips.library) || [];
  const count = lib.filter((cl) => (cl.folder || 'replays') === _rpFolder).length;
  if (!count) return;
  const label = _rpFolder === 'highlights' ? 'Highlights' : 'Moments';
  const ok = await customConfirm('Clear Pool', `Remove all ${count} clip${count === 1 ? '' : 's'} from ${label}? This also removes them from any playlist using them.`, 'Clear');
  if (!ok) return;
  _poolSelected.clear();
  send('clip_clear_folder', { folder: _rpFolder });
});

async function addClipToPlaylist(clip, c) {
  const sel = el('rp-add-to-playlist-sel') || el('select-montage-edit');
  const mId = sel?.value;
  const montages = (c || currentState.clips)?.montages || [];
  const m = montages.find((x) => x.id === mId);
  if (m) {
    const order = [...(m.clipIds || [])];
    if (!order.includes(clip.id)) order.push(clip.id);
    send('montage_reorder', { montageId: m.id, clipIds: order });
  } else {
    // "— New playlist —" chosen: let the producer NAME it in the moment (default to a timestamp).
    const preset = el('rp-playlist-name')?.value?.trim() || ('Playlist ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    const name = await customPrompt('New playlist', 'Name this playlist', preset, 'Create');
    if (!name) return;   // cancelled
    _pendingNewMontage = true;
    send('montage_create', { name, clipIds: [clip.id], template: el('select-montage-template')?.value || 'highlights', folder: _rpFolder });
  }
}

// ── Staging area event wiring ──────────────────────────────────────────────
el('tab-replays')?.addEventListener('click', () => {
  if (!_stagingFiles.length && !_stagingLoading) scanStagingArea();
});
el('rp-scan-folder')?.addEventListener('click', () => scanStagingArea());
function setReplayFolder() {
  const inp = el('rp-staging-folder-input'); if (!inp) return;
  send('set_clips', { replayFolder: inp.value.trim() });
  setTimeout(() => scanStagingArea(), 250);   // rescan the new folder
}
el('rp-staging-folder-set')?.addEventListener('click', setReplayFolder);
el('rp-staging-folder-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') setReplayFolder(); });
el('rp-staging-folder-browse')?.addEventListener('click', () => send('pick_replay_folder'));   // native folder dialog → rescans on return
el('rp-clip-search')?.addEventListener('input', function () {
  _stagingFilter = this.value; renderStagingList();
});
_stagingAutoTimer = setInterval(() => {
  if (document.querySelector('#tab-replays-content.active') && !_stagingLoading) scanStagingArea(true);
}, 20000);

// ── Push playlist live ─────────────────────────────────────────────────────
let _plLiveIdx = 0;
let _plLiveItems = [];
let _plLiveActive = false;
let _plLoop = false;          // loop the playlist continuously
let _plReturnEnabled = true;  // switch back to the origin scene when the playlist finishes
let _plReturnScene = '';      // explicit OBS scene to cut to when the playlist finishes
let _plAdvanceTimer = null;
let _plBus = 'program';       // active WS bus: 'program' | 'preview' | 'pl_<id>'
// Set right when a "To Preview" send goes out, so an immediate "Take" click isn't spuriously
// rejected while waiting on the server's replay_play echo to update currentState.replay.preview.
let _previewSentAt = 0;
// true when the live push is ONE already-encoded file (transitions baked in server-side) rather
// than the per-clip playback that advancePlaylist()/_plLiveItems/_plLiveIdx drive — those are only
// ever populated by the per-clip automation path (playMontageById), so replay_ended for an
// encoded push must go straight to finishPlayout(), not advancePlaylist()'s stale per-clip index.
let _plEncodedMode = false;
// Which montage id is actually live right now — presentation-only (drives the row status badge),
// set at every live-push entry point, cleared alongside _plBus/_plEncodedMode in finishPlayout()/
// endReplayProgram(). Needed because playMontageById() (5 of 6 automation triggers) never
// otherwise records which montage it's playing per-clip.
let _plLiveMontageId = null;
// Shelf ('replays' | 'highlights') the on-air run came from — drives the live dot on the shelf tabs
// for POOL runs too, which carry no montage id.
let _plLiveFolder = null;
let _plCollapsed = false;     // whether the selected playlist's content pane is collapsed
let _plPendingEncodeAndPlay = null;  // montageId waiting for encode to finish before playing
let _lastNotifiedEncodeError = null;  // dedupe key so a repeated failed-job broadcast doesn't re-toast
// Normalize a clip-library clip into a live playout item.
function clipToLiveItem(clip) {
  return { url: clipUrl(clip), name: clip.name || 'Clip', trimIn: clip.trimIn || 0, trimOut: clip.trimOut ?? undefined, duration: clip.duration };
}
let _plScene = '';            // the OBS scene the active playlist plays in (per-playlist binding)
let _plTransition = null;     // the active playlist's transition object { type, stinger }
let _plKind = 'replay';       // top-bar label tag for what's on air: 'replay' | 'ad'
function pushPlaylistLive() {
  const mId = el('select-montage-edit')?.value; if (!mId) return;
  const m = (currentState.clips?.montages || []).find((x) => x.id === mId); if (!m) return;

  // If the playlist is already encoded, play the single pre-rendered file — smooth, no clip gaps.
  const encodedUrl = montageUrl(m);
  if (encodedUrl) {
    // Everything (single clips + encoded playlists) shares ONE browser source: the program bus /
    // replay-player.html. The playlist only chooses which OBS SCENE to cut to (its programScene) —
    // the video always lands on the same source. Because it's one source, pushing this replaces
    // whatever was playing (no two sources fighting).
    stopOtherProgramSources('program');   // stop a single clip / other playlist first (no fighting)
    _plBus = 'program';
    _plEncodedMode = true;
    _plLiveMontageId = mId;
    _plKind = m.kind || 'ad';
    _plScene = (m.programScene || '').trim();
    _plLoop = !!el('rp-pl-loop')?.checked;
    _plReturnEnabled = el('rp-pl-return') ? !!el('rp-pl-return').checked : true;
    _plReturnScene = '';
    // Effective cut-to scene: the playlist's own scene, else the global Program-scene dropdown. Pass
    // the SAME value to the server (which also switches on the program bus) so they can't race to two
    // different scenes — beginReplayProgram resolves it identically client-side.
    const effScene = _plScene || (el('rp-program-scene')?.value || '').trim();
    beginReplayProgram(_plScene || undefined);
    _plLiveActive = true;
    updatePlaylistLiveBtns();
    send('replay_play', { bus: _plBus, url: encodedUrl, name: m.name || 'Playlist', loop: _plLoop, scene: effScene || undefined });
    return;
  }

  // No encoded file — encode first, then auto-play when done.
  const lib = currentState.clips?.library || [];
  const items = (m.clipIds || []).map((id) => lib.find((cl) => cl.id === id)).filter(Boolean);
  if (!items.length) { showToast('Playlist is empty', '#fbbf24'); return; }
  _plPendingEncodeAndPlay = mId;
  showToast('Encoding playlist for smooth playback...', '#60a5fa');
  send('montage_encode', {
    montageId: mId,
    opts: {
      quality: el('rp-quality')?.value || 'medium',
      gpu: !!el('rp-gpu')?.checked,
      format: el('rp-format')?.value || '.mp4',
      transition: m.transition?.type || 'cut'
    }
  });
}
// Toggle the right-column playlist's Play live / Stop buttons to match playout state.
// Play Live is only shown when the playlist is encoded (READY) — no button for drafts/empty/encoding.
function updatePlaylistLiveBtns() {
  const stop = el('rp-pl-stop'), play = el('rp-playlist-push-live');
  if (stop) stop.style.display = _plLiveActive ? '' : 'none';
  // The pool's own Stop — a Play all / bulk To Air run must be stoppable without expanding the
  // (collapsed by default) Playlists section to reach its Stop button.
  const poolStop = el('rp-pool-stopall'), poolPlay = el('rp-pool-playall');
  if (poolStop) poolStop.style.display = _plLiveActive ? '' : 'none';
  if (poolPlay) poolPlay.style.display = _plLiveActive ? 'none' : '';
  if (play) {
    const mId = el('select-montage-edit')?.value;
    const m = (currentState.clips?.montages || []).find((x) => x.id === mId);
    const isReady = !!montageUrl(m);
    play.style.display = (!_plLiveActive && isReady) ? '' : 'none';
  }
  // Preview needs no encode — it just needs something to play.
  const prev = el('rp-pl-preview');
  if (prev) {
    const mId = el('select-montage-edit')?.value;
    const m = (currentState.clips?.montages || []).find((x) => x.id === mId);
    prev.disabled = !m || (!(m.clipIds || []).length && !montageUrl(m));
  }
}
el('rp-pl-stop')?.addEventListener('click', () => { stopPlayoutLive(); updatePlaylistLiveBtns(); });

// Stop whatever is on the Program output (a single clip — INCLUDING a looping one — or a playlist)
// and return to the scene marked for return. Reuses the vetted stop paths so return-to-scene stays
// consistent: playlists go through finishPlayout(); a single clip through endReplayProgram() (which
// returns to the pre-clip scene when the "Return" toggle is on).
function stopProgramNow() {
  clearTimeout(_plAdvanceTimer);
  clearTimeout(_replayFallbackTimer);
  if (_plLiveActive) { stopPlayoutLive(); }
  else if (_replayActive) { endReplayProgram(false); }
  else {
    send('replay_stop', { bus: _plBus || 'program' });
    const st = el('rp-screen-status'); if (st) { st.textContent = 'Program stopped.'; st.style.color = 'var(--muted)'; }
  }
  updatePlaylistLiveBtns();
  const sb = el('rp-stop-program'); if (sb) sb.style.display = 'none';
}
el('rp-stop-program')?.addEventListener('click', stopProgramNow);

// Mutual exclusion for the ONE shared program source: everything (single clips + encoded/per-clip
// playlists) plays on the program bus / replay-player.html, so at most one thing is ever on air. Before
// a NEW push, cancel whatever was playing so its timers/sequencing can't fire under the new video.
// Because it's the same source, the new replay_play simply replaces the current video — no "fighting".
function stopOtherProgramSources(newBus) {
  newBus = newBus || 'program';
  const cur = _plBus || 'program';
  // A legacy different-bus output (e.g. the staging 'preview' monitor) must be stopped on the overlay.
  if ((_replayActive || _plLiveActive) && cur !== newBus) {
    send('replay_stop', { bus: cur });
  }
  // Kill any in-flight timers from the outgoing clip/playlist so a stale 'ended'/advance/return can't
  // fire over the incoming push. (_replayActive is intentionally left set so beginReplayProgram keeps
  // the original pre-replay scene as the return origin across a takeover.)
  clearTimeout(_plAdvanceTimer);
  clearTimeout(_replayFallbackTimer);
  // Stop a per-clip playlist's sequencing loop (advancePlaylist would otherwise keep pushing clips).
  if (_plLiveActive) {
    _plLiveActive = false; _plEncodedMode = false; _plLiveMontageId = null;
    updatePlaylistLiveBtns();
  }
}
// Playlist settings popover (gear): output format/quality, transition, auto ad-break.
el('rp-pl-settings-toggle')?.addEventListener('click', () => {
  const p = el('rp-pl-settings'); if (!p) return;
  p.style.display = p.style.display === 'none' ? '' : 'none';
});
// Play a right-column playlist (montage) live by id — used by the ad-break, break-screen
// "then play playlist", segments and command-palette shortcuts (which replaced the old separate
// Playout Playlists feature). opts: { returnScene, loop }.
function playMontageById(id, opts) {
  opts = opts || {};
  const m = (currentState.clips?.montages || []).find((x) => x.id === id);
  if (!m) return false;
  const lib = currentState.clips?.library || [];
  _plLiveItems = (m.clipIds || []).map((cid) => lib.find((c) => c.id === cid)).filter(Boolean).map(clipToLiveItem);
  if (!_plLiveItems.length) return false;
  _plLoop = opts.loop != null ? !!opts.loop : !!el('rp-loop')?.checked;
  _plReturnScene = opts.returnScene || '';
  _plScene = (m.programScene || '').trim();
  _plTransition = m.transition || { type: 'cut' };
  _plKind = m.kind || 'ad';
  stopOtherProgramSources('program');   // stop any single clip / other playlist so they don't fight
  _plBus = 'program';   // automation/flow calls always use the main program bus
  _plEncodedMode = false;
  _plLiveMontageId = id;
  _plLiveFolder = m.folder || 'replays';
  // Same go-live hold as the pool: buffer the reel's first clip, then cut. Kept off the return path
  // so automation/flows still get their synchronous "started" answer.
  rpArmFirstClip(_plLiveItems[0].url).then(() => {
    beginReplayProgram(_plScene || undefined);
    _plLiveActive = true;
    if (typeof updatePlaylistLiveBtns === 'function') updatePlaylistLiveBtns();
    if (currentState.clips) renderPlaylistPane(currentState.clips);
    _plLiveIdx = 0; playNextLive();
  });
  return true;
}
function stopPlayoutLive() {
  _plLiveActive = false; _plLoop = false;
  clearTimeout(_plAdvanceTimer);
  finishPlayout();
}
// End-of-playlist handoff: cut to the playlist's chosen scene, else return to where we came from.
function finishPlayout() {
  const stopBus = _plBus || 'program';
  if (_plReturnScene) {
    send('replay_stop', { bus: stopBus });
    send('obs_switch_scene', { sceneName: _plReturnScene });
    const st = el('rp-screen-status'); if (st) { st.textContent = 'Returned to ' + _plReturnScene; st.style.color = 'var(--muted)'; }
    _plReturnScene = ''; _replayActive = false; clearTimeout(_replayFallbackTimer); stopReplayCountdown(); _replayOrigin = '';
  } else if (_plReturnEnabled) {
    endReplayProgram();
  } else {
    send('replay_stop', { bus: stopBus });
    _replayActive = false; clearTimeout(_replayFallbackTimer); stopReplayCountdown(); _replayOrigin = '';
  }
  // Done with this playlist's dedicated bus/mode (if any) — don't leak it into the next push.
  _plBus = 'program';
  _plEncodedMode = false;
  _plLiveMontageId = null;
  _plLiveFolder = null;                 // shelf tabs stop pulsing
  if (typeof updatePlaylistLiveBtns === 'function') updatePlaylistLiveBtns();
  if (currentState && currentState.clips) renderPlaylistPane(currentState.clips);
}
// Transition for the active playlist (per-playlist setting wins; falls back to the global select).
function playlistTransitionOpts() {
  const tr = _plTransition || {};
  const type = tr.type || (el('rp-transition')?.value) || 'cut';
  if (type === 'logo') return { transition: 'logo', transitionLogo: _transitionLogo || (currentState.brand && currentState.brand.logo) || '', stinger: '', stingerPoint: 0 };
  if (type === 'stinger') {
    // A reel can carry its own stinger; otherwise fall back to the one uploaded on the pool's
    // Transition row so "Stinger" means something even on a playlist that was never given one.
    return { transition: 'stinger', transitionLogo: '',
      stinger: tr.stinger || _rpStinger.url || '',
      stingerPoint: (tr.stingerPoint != null ? tr.stingerPoint : _rpStinger.point) || 0 };
  }
  return { transition: type, transitionLogo: '', stinger: '', stingerPoint: 0 };
}
// True when putting the replay scene on air will actually change the OBS scene — i.e. OBS is about
// to run its own transition. Used to avoid stinging twice in "OBS transition" mode: OBS stings the
// scene cut, the player stings between clips, and doing both on the same push plays it back to back.
function willObsCutScene(scene) {
  scene = (scene || '').trim();
  const obs = (currentState && currentState.obs) || {};
  // Only when OBS is actually connected — otherwise no scene change happens, nothing stings the
  // cut, and suppressing the player's own sting would silently drop the transition entirely.
  if (!scene || !obs.connected) return false;
  return (obs.currentScene || '') !== scene;
}
let _plSkipStingOnce = false;   // first clip of a run whose scene cut OBS is already stinging

function playNextLive() {
  const item = _plLiveItems[_plLiveIdx]; if (!item) return;
  const url = item.url; if (!url) { _plLiveIdx++; playNextLive(); return; }
  // Preload hint: the NEXT clip's url (wraps to item 0 when looping) so the server can pre-transcode it
  // and the overlay can buffer it WHILE this one plays — making the advance seamless (no cold-load gap).
  let nextItem = _plLiveItems[_plLiveIdx + 1];
  if (!nextItem && _plLoop) nextItem = _plLiveItems[0];
  let nextUrl = (nextItem && nextItem.url) || '';
  if (nextUrl === url) nextUrl = '';   // single-clip loop → nothing new to warm
  const t = playlistTransitionOpts();   // ease between items (cut / fade / logo / stinger) on the overlay
  // OBS is stinging the scene cut for this first clip — the player must not sting it too.
  const skipSting = _plSkipStingOnce;
  if (skipSting) _plSkipStingOnce = false;
  send('replay_play', { bus: _plBus, url, name: item.name || 'Clip', loop: false,
    trimIn: item.trimIn || 0, trimOut: item.trimOut ?? undefined, scene: _plScene || undefined,
    transition: skipSting ? 'cut' : t.transition, transitionLogo: t.transitionLogo,
    // The sting travels even on a cut so the player can buffer it during this clip; only the
    // transition type decides whether it's used.
    stinger: t.stinger, stingerPoint: t.stingerPoint, stingerDuration: t.stingerDuration || 0,
    // The next clip's in-point travels with the preload hint so the overlay can buffer it AND park
    // it on the right frame — an advance then costs neither a fetch nor a seek.
    nextUrl, nextIn: (nextItem && nextItem.trimIn) || 0 });
  const st = el('rp-screen-status');
  if (st) { st.textContent = `ON AIR [${_plLiveIdx + 1}/${_plLiveItems.length}] ${item.name || 'Clip'}`; st.title = st.textContent; st.style.color = 'var(--good, #48bb78)'; }
  // Safety-net timer: fires if the overlay's 'replay_ended' event is somehow missed.
  // Use actual duration when known; fall back to 2 hours so we never cut a long video short.
  const dur = (item.trimOut ?? item.duration ?? 7200) - (item.trimIn || 0);
  clearTimeout(_plAdvanceTimer);
  _plAdvanceTimer = setTimeout(advancePlaylist, Math.max(dur, 1) * 1000 + 1500);
}
// Move the playlist forward one clip (called by replay_ended OR the safety-net timer).
function advancePlaylist() {
  clearTimeout(_plAdvanceTimer);
  if (!_plLiveActive) return;
  _plLiveIdx++;
  if (_plLiveIdx < _plLiveItems.length) { playNextLive(); return; }
  if (_plLoop) { _plLiveIdx = 0; playNextLive(); return; }
  const s = el('rp-screen-status');
  if (s) { s.textContent = 'Playlist finished'; s.style.color = 'var(--muted)'; }
  _plLiveActive = false;
  finishPlayout();
}
el('rp-playlist-push-live')?.addEventListener('click', pushPlaylistLive);
// Watch the selected reel in the editor instead of on air. Encoded reels preview their finished
// file (transitions baked in); drafts walk their source clips.
el('rp-pl-preview')?.addEventListener('click', () => {
  const mId = el('select-montage-edit')?.value;
  if (!mId) return;
  const m = (currentState.clips?.montages || []).find((x) => x.id === mId);
  if (m && montageUrl(m)) rpPreviewExport(m);
  else rpPreviewPlaylist(mId);
});

// ── Playlist live controls: OBS-scene binding · video upload · transition · auto-trigger ──
function syncPlaylistLiveControls(m) {
  const sceneSel = el('rp-pl-scene');
  if (sceneSel) {
    const scenes = (currentState.obs && currentState.obs.availableScenes) || [];
    const sig = JSON.stringify(scenes);
    if (sceneSel.dataset.sig !== sig) {
      sceneSel.dataset.sig = sig;
      sceneSel.innerHTML = '<option value="">— global Program scene —</option>' +
        scenes.map((s) => `<option value="${String(s).replace(/"/g, '&quot;')}">${String(s).replace(/</g, '&lt;')}</option>`).join('');
    }
    if (document.activeElement !== sceneSel) sceneSel.value = m.programScene || '';
  }
  const kSel = el('rp-pl-kind');
  if (kSel && document.activeElement !== kSel) kSel.value = (m.kind != null ? m.kind : 'ad');
  const tSel = el('rp-transition');
  const tr = (m.transition && m.transition.type) || 'cut';
  if (tSel && document.activeElement !== tSel) tSel.value = tr;
  if (typeof updateTransLogoRow === 'function') updateTransLogoRow();
  const sn = el('rp-stinger-name');
  if (sn) sn.textContent = (m.transition && m.transition.stinger) ? 'Stinger set ✓ — click to replace' : 'A short .webm/.mp4 played between clips';
  const loopCk = el('rp-pl-loop'); if (loopCk && document.activeElement !== loopCk) loopCk.checked = !!m.loop;
  const retCk  = el('rp-pl-return'); if (retCk && document.activeElement !== retCk) retCk.checked = m.returnEnabled !== false;
}
// Import selected/dropped video files into a playlist via the managed clip library.
async function importVideosToPlaylist(files, mId) {
  const usable = files.filter((f) => f && f.path);
  if (!usable.length) { if (typeof showToast === 'function') showToast('Could not read those files (no path)', '#f56565'); return; }
  if (typeof showToast === 'function') showToast(`Importing ${usable.length} video(s)…`, '#22c55e');
  const m = (currentState.clips?.montages || []).find((x) => x.id === mId);
  const ids = m ? [...(m.clipIds || [])] : [];
  let ok = 0;
  for (const f of usable) {
    try {
      const r = await fetch('http://127.0.0.1:3000/api/clips/import-file', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: f.path, label: (f.name || 'Video').replace(/\.[^.]+$/, '') })
      });
      const d = await r.json();
      if (d.ok && d.clip && d.clip.id) { ids.push(d.clip.id); ok++; }
    } catch (e) {}
  }
  if (ok) send('montage_reorder', { montageId: mId, clipIds: ids });
  if (typeof showToast === 'function') showToast(`Added ${ok}/${usable.length} video(s) to the playlist`, ok ? '#22c55e' : '#f56565');
}
el('rp-pl-kind')?.addEventListener('change', function () {
  const mId = el('select-montage-edit')?.value; if (!mId) return;
  send('montage_settings', { montageId: mId, kind: this.value });
});
el('rp-pl-scene')?.addEventListener('change', function () {
  const mId = el('select-montage-edit')?.value; if (!mId) return;
  send('montage_settings', { montageId: mId, programScene: this.value });
});
el('rp-pl-loop')?.addEventListener('change', function () {
  const mId = el('select-montage-edit')?.value; if (!mId) return;
  send('montage_settings', { montageId: mId, loop: this.checked });
});
el('rp-pl-return')?.addEventListener('change', function () {
  const mId = el('select-montage-edit')?.value; if (!mId) return;
  send('montage_settings', { montageId: mId, returnEnabled: this.checked });
});
el('rp-pl-upload')?.addEventListener('click', () => {
  if (!el('select-montage-edit')?.value) { if (typeof showToast === 'function') showToast('Select or create a playlist first', '#fbbf24'); return; }
  el('rp-pl-upload-input')?.click();
});
el('rp-pl-upload-input')?.addEventListener('change', async function () {
  const mId = el('select-montage-edit')?.value; const files = [...(this.files || [])]; this.value = '';
  if (mId && files.length) await importVideosToPlaylist(files, mId);
});
el('rp-stinger-file')?.addEventListener('change', async function () {
  const mId = el('select-montage-edit')?.value; const f = this.files && this.files[0]; this.value = '';
  if (!mId || !f) return;
  if (!f.path) { if (typeof showToast === 'function') showToast('Could not read the file path', '#f56565'); return; }
  const sn = el('rp-stinger-name'); if (sn) sn.textContent = 'Uploading stinger…';
  try {
    const r = await fetch('http://127.0.0.1:3000/api/clips/import-file', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: f.path, label: f.name || 'Stinger' })
    });
    const d = await r.json();
    if (d.ok && d.clip) { send('montage_settings', { montageId: mId, transition: { type: 'stinger', stinger: clipUrl(d.clip) } }); if (sn) sn.textContent = 'Stinger set ✓'; }
    else if (sn) sn.textContent = 'Upload failed';
  } catch (e) { if (sn) sn.textContent = 'Upload failed'; }
});
// Playlists (commercials / custom) must NEVER auto-play — they only roll on an explicit producer
// Play. A playlist's programScene is purely the scene it CUTS TO when the producer hits Play; it is
// NOT a trigger. (Previously this auto-fired a bound playlist whenever OBS switched to its scene,
// which force-cut OBS + started an ad + countdown without any producer action.) Do NOT re-add a
// scene → playlist auto-trigger. Kept as a documented no-op in case anything still references it.
function checkPlaylistAutoTrigger() { /* intentionally does nothing — no scene-triggered auto-play */ }

// HTML-escape helper — still used by renderRdAddTarget()/renderRundown()/renderAdSched() below
// (the "Playout playlists" UI this was originally written for is gone; those call sites remain).
function poEsc(s) { return esc(s); }   // legacy alias — canonical esc() lives at the top of the file

// ── Auto ad-break scheduler ───────────────────────────────────────────────
// Client-driven: every N minutes, push the chosen playout live (it auto-returns). Skips a fire
// while something is already on the program bus so it never interrupts a live segment.
const RP_AD_KEY = 'ne_ad_sched';
let _adSched = (() => { try { return JSON.parse(localStorage.getItem(RP_AD_KEY) || '{}'); } catch { return {}; } })();
let _adLastFire = 0;
function adSaveCfg() { try { localStorage.setItem(RP_AD_KEY, JSON.stringify(_adSched)); } catch {} }
function renderAdSched(data) {
  const sel = el('rp-ad-playout'); if (!sel) return;
  const playouts = (data && data.clips && data.clips.montages) || [];
  const sig = playouts.map((p) => p.id + ':' + p.name).join('|');
  if (sel.dataset.sig !== sig && document.activeElement !== sel) {
    sel.dataset.sig = sig;
    sel.innerHTML = '<option value="">Choose playlist…</option>' + playouts.map((p) => `<option value="${poEsc(p.id)}">${poEsc(p.name)}</option>`).join('');
  }
  if (_adSched.playoutId && document.activeElement !== sel) sel.value = _adSched.playoutId;
  const en = el('rp-ad-enabled'); if (en) en.checked = !!_adSched.enabled;
  const iv = el('rp-ad-interval'); if (iv && document.activeElement !== iv) iv.value = _adSched.intervalMin || 15;
}
el('rp-ad-enabled')?.addEventListener('change', function () { _adSched.enabled = this.checked; _adLastFire = Date.now(); adSaveCfg(); });
el('rp-ad-playout')?.addEventListener('change', function () { _adSched.playoutId = this.value; adSaveCfg(); });
el('rp-ad-interval')?.addEventListener('change', function () { _adSched.intervalMin = Math.max(1, parseInt(this.value, 10) || 15); adSaveCfg(); });
setInterval(() => {
  const next = el('rp-ad-next');
  if (!_adSched.enabled || !_adSched.playoutId) { if (next) next.textContent = ''; return; }
  // Honour the global ads kill-switch: a scheduled commercial break is still a commercial, so it
  // must never auto-fire while ads are turned off (state.twitch.adsEnabled / tb-ad-enabled).
  const adsOn = (typeof adsAreEnabled !== 'function') || adsAreEnabled();
  if (!adsOn) { if (next) next.textContent = 'Ads off — auto-break paused'; _adLastFire = Date.now(); return; }
  const intervalMs = Math.max(1, _adSched.intervalMin || 15) * 60000;
  if (!_adLastFire) _adLastFire = Date.now();
  const remaining = intervalMs - (Date.now() - _adLastFire);
  if (remaining <= 0) {
    if (!_plLiveActive) {   // don't interrupt a segment already on air
      playMontageById(_adSched.playoutId);
    }
    _adLastFire = Date.now();
  } else if (next) {
    const s = Math.ceil(remaining / 1000);
    next.textContent = 'Next ad in ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
}, 1000);

// The countdown NEVER rolls a playlist. A timer that hits 0 shows/hides the break screen and
// (optionally) cuts to `thenScene` — clips, ads and playlists only ever play on an explicit
// producer action from the REPLAYS panel.

// ── Producer keyboard shortcuts ───────────────────────────────────────────
// In-app bindings (active while the control panel is focused). Map: { actionId: 'Ctrl+Shift+C' }.
const HK_KEY = 'ne_hotkeys_v1';
const HK_ON_KEY = 'ne_hotkeys_on';
const HK_ACTIONS = [
  { id: 'trig-countdown',  label: 'Trigger: Countdown',            run: () => el('ck-break-toggle')?.click() },
  { id: 'trig-winner',     label: 'Trigger: Winner',               run: () => el('ck-winner-toggle')?.click() },
  { id: 'trig-intro',      label: 'Trigger: Line-up',              run: () => el('ck-intro-toggle')?.click() },
  { id: 'trig-spotlight',  label: 'Trigger: Spotlight',            run: () => el('ck-spotlight-toggle')?.click() },
  { id: 'trig-veto',       label: 'Trigger: Map Veto',             run: () => el('ck-veto-toggle')?.click() },
  { id: 'view-hud',        label: 'Overlay: HUD view',             run: () => send('force_hud') },
  { id: 'view-scoreboard', label: 'Overlay: Scoreboard view',      run: () => send('force_scoreboard') },
  { id: 'cut-all',         label: 'Hide all overlays',             run: () => el('btn-cut-all')?.click() },
  { id: 'replay-save',     label: 'Save replay buffer',            run: () => send('obs_save_replay') },
  { id: 'replay-take',     label: 'Replay: Take preview → program', run: () => { if (typeof takeToProgram === 'function') takeToProgram(); } },
  { id: 'replay-clear',    label: 'Replay: Clear program',         run: () => { if (typeof rpClearProgram === 'function') rpClearProgram(); } },
  { id: 'commercial',      label: 'Toggle commercial break',       run: () => send('obs_toggle_commercial') },
  { id: 'clip',            label: 'Twitch clip',                   run: () => el('btn-bb-clip')?.click() },
  { id: 'timer-toggle',    label: 'Producer timer start/pause',    run: () => { if (typeof toggleTimer === 'function') toggleTimer(); } },
  { id: 'break-show',      label: 'Countdown: Show',               run: () => el('ptp-show')?.click() },
  { id: 'break-hide',      label: 'Countdown: Hide',               run: () => el('ptp-hide')?.click() },
  { id: 'playout-1',       label: 'Play playlist #1',              run: () => { const m = (currentState.clips?.montages || [])[0]; if (m) playMontageById(m.id); } },
  { id: 'playout-2',       label: 'Play playlist #2',              run: () => { const m = (currentState.clips?.montages || [])[1]; if (m) playMontageById(m.id); } },
  { id: 'playout-3',       label: 'Play playlist #3',              run: () => { const m = (currentState.clips?.montages || [])[2]; if (m) playMontageById(m.id); } },
];
let _hkMap = (() => { try { return JSON.parse(localStorage.getItem(HK_KEY) || '{}'); } catch { return {}; } })();
let _hkEnabled = localStorage.getItem(HK_ON_KEY) !== '0';
let _hkCapturing = null;
function hkSaveMap() { try { localStorage.setItem(HK_KEY, JSON.stringify(_hkMap)); } catch {} }
function hkCombo(e) {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;   // modifier alone
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  let k = e.key; if (k === ' ') k = 'Space'; if (k.length === 1) k = k.toUpperCase();
  parts.push(k);
  return parts.join('+');
}
// Hotkey rows grouped by what they drive; the group name replaces the "Trigger:" style prefix.
const HK_GROUPS = [
  ['Graphics', /^(trigger|overlay|countdown):|^hide all overlays/i],
  ['Replays and clips', /^(replay):|^save replay|^play playlist|^twitch clip/i],
  ['Show', /./],
];
function renderHotkeys() {
  const list = el('hk-list'); if (!list) return;
  const en = el('hk-enabled'); if (en) en.checked = _hkEnabled;
  list.innerHTML = '';
  list.classList.add('hk-list');
  const set = HK_ACTIONS.filter((a) => _hkMap[a.id]).length;
  const sum = document.createElement('div'); sum.className = 'hk-summary';
  sum.textContent = set ? `${set} of ${HK_ACTIONS.length} actions have a key.` : 'No keys set yet. Click Set key, then press the key you want.';
  list.appendChild(sum);
  const groups = HK_GROUPS.map(([name]) => ({ name, rows: [] }));
  HK_ACTIONS.forEach((a) => { const i = HK_GROUPS.findIndex(([, re]) => re.test(a.label)); groups[i].rows.push(a); });
  groups.forEach((g) => {
    if (!g.rows.length) return;
    const head = document.createElement('div'); head.className = 'hk-group'; head.textContent = g.name;
    list.appendChild(head);
    g.rows.forEach((a) => {
      const cur = _hkMap[a.id];
      const capturing = _hkCapturing === a.id;
      const row = document.createElement('div'); row.className = 'hk-row' + (cur ? ' is-set' : '') + (capturing ? ' is-capturing' : '');
      const lbl = document.createElement('span'); lbl.className = 'hk-label';
      lbl.textContent = a.label.replace(/^(trigger|overlay|replay|countdown):\s*/i, (m, p) => (/countdown/i.test(p) ? 'Countdown ' : ''));
      const key = document.createElement('button'); key.type = 'button'; key.className = 'hk-key';
      if (capturing) key.textContent = 'Press a key… (Esc to cancel)';
      else if (cur) cur.split('+').forEach((part, i) => {
        if (i) key.appendChild(document.createTextNode('+'));
        const k = document.createElement('kbd'); k.textContent = part; key.appendChild(k);
      });
      else key.textContent = 'Set key';
      key.title = cur ? 'Click to change the key' : 'Click, then press the key for this action';
      key.addEventListener('click', () => { _hkCapturing = capturing ? null : a.id; renderHotkeys(); });
      row.appendChild(lbl); row.appendChild(key);
      if (cur) {
        const clr = document.createElement('button'); clr.type = 'button'; clr.className = 'hk-clear'; clr.textContent = '✕'; clr.title = 'Remove this key';
        clr.addEventListener('click', () => { delete _hkMap[a.id]; hkSaveMap(); renderHotkeys(); });
        row.appendChild(clr);
      }
      list.appendChild(row);
    });
  });
}
el('hk-enabled')?.addEventListener('change', function () { _hkEnabled = this.checked; try { localStorage.setItem(HK_ON_KEY, _hkEnabled ? '1' : '0'); } catch {} });
document.addEventListener('keydown', (e) => {
  // Deck button hotkey capture (Production ▸ Deck editor) — grabs the next keystroke.
  if (window.__deckCapturing) {
    if (e.key === 'Escape') { window.__deckCapturing = false; e.preventDefault(); if (typeof deckCaptureDone === 'function') deckCaptureDone(null); return; }
    const c = hkCombo(e); if (!c) return;
    e.preventDefault(); window.__deckCapturing = false; if (typeof deckCaptureDone === 'function') deckCaptureDone(c); return;
  }
  // Capture mode: bind the next key to the action being edited.
  if (_hkCapturing) {
    if (e.key === 'Escape') { _hkCapturing = null; renderHotkeys(); e.preventDefault(); return; }
    const combo = hkCombo(e); if (!combo) return;
    e.preventDefault();
    Object.keys(_hkMap).forEach((id) => { if (_hkMap[id] === combo) delete _hkMap[id]; });   // no dup combos
    _hkMap[_hkCapturing] = combo; _hkCapturing = null; hkSaveMap(); renderHotkeys();
    return;
  }
  if (!_hkEnabled) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  const combo = hkCombo(e); if (!combo) return;
  // Deck buttons (user-defined) take priority over the preset actions.
  const deck = window._deck;
  if (deck && Array.isArray(deck.buttons)) {
    const db = deck.buttons.find((x) => x.hotkey === combo);
    if (db) { e.preventDefault(); try { deckFire(db); if (typeof showToast === 'function') showToast('⌨ ' + (db.label || 'Deck'), '#7c5cff', 1100); } catch (_) {} return; }
  }
  const id = Object.keys(_hkMap).find((k) => _hkMap[k] === combo); if (!id) return;
  const act = HK_ACTIONS.find((a) => a.id === id); if (!act) return;
  e.preventDefault();
  try { act.run(); if (typeof showToast === 'function') showToast('⌨ ' + act.label, '#7c5cff', 1200); } catch (_) {}
}, true);
renderHotkeys();
