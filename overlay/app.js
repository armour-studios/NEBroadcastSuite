/* ─── Overlay logic — connects to WS bridge on :3001 ────────────────────── */

const WS_URL = 'ws://localhost:3001';
const BLUE   = '#055fdb';
const ORANGE = '#e97139';

let ws;
let currentState = {};
let boostColor   = BLUE;

// ── DOM refs ──────────────────────────────────────────────────────────────
const views = {
  hud:        document.getElementById('view-hud'),
  goal:       document.getElementById('view-goal'),
  scoreboard: document.getElementById('view-scoreboard')
};

function el(id) { return document.getElementById(id); }

function setText(id, val) {
  const e = el(id);
  if (e) e.textContent = val ?? '';
}

function setTextAutoFit(id, val, defaultSize = 50, minSize = 10) {
  const e = el(id);
  if (!e) return;
  e.textContent = val ?? '';
  e.style.fontSize = defaultSize + 'px';
  let currentSize = defaultSize;
  while (e.scrollWidth > e.clientWidth && currentSize > minSize) {
    currentSize -= 1;
    e.style.fontSize = currentSize + 'px';
  }
}

function isDefaultGameLogo(src) {
  if (!src) return true;
  const s = src.toString();
  return /\/assets\/rl\.png(\?|$)/i.test(s)
    || /\/assets\/games\/[^/]+\.(svg|png)(\?|$)/i.test(s);
}

function setImg(id, src, fallback) {
  const e = el(id);
  if (!e) return;
  const custom = (src || '').toString().trim();
  const url = custom || fallback || '/assets/rl.png';
  e.src = url;
  e.style.display = '';
  if (e.classList) e.classList.toggle('logo-on-dark', !custom || isDefaultGameLogo(url));
}

function showView(name) {
  const sb = el('scoreboard');
  const sbImg = document.querySelector('.scoreboard-bg');
  
  if (sb) {
    sb.classList.remove('view-hud', 'view-goal', 'view-scoreboard');
    sb.classList.add(`view-${name}`);
  }

  if (sbImg) {
    sbImg.src = (name === 'scoreboard') ? '/assets/podium-scoreboard2.png' : '/assets/scoreboard.png';
  }

  if (name === 'goal') {
    views.hud.classList.add('active');
    views.goal.classList.add('active');
    views.scoreboard.classList.remove('active');
  } else {
    Object.entries(views).forEach(([k, elem]) => {
      elem.classList.toggle('active', k === name);
    });
  }
}

// ── Boost Canvas ──────────────────────────────────────────────────────────
const boostCanvas = document.getElementById('boost-canvas');
const boostCtx    = boostCanvas ? boostCanvas.getContext('2d') : null;

function drawBoost(pct, color) {
  if (!boostCtx) return;
  const W = 229, H = 229, cx = W / 2, cy = H / 2, R = 100;
  boostCtx.clearRect(0, 0, W, H);
  if (pct <= 0) return;

  // Background ring (270 degrees)
  const startAngle = Math.PI / 2; // Bottom
  const totalAngle = 1.5 * Math.PI; // 270 degrees
  const fullEndAngle = startAngle + totalAngle;

  boostCtx.beginPath();
  boostCtx.arc(cx, cy, R, startAngle, fullEndAngle);
  boostCtx.strokeStyle = 'rgba(0, 0, 0, 0)';
  boostCtx.lineWidth = 0; // Desactivado porque el fondo está en el asset
  boostCtx.lineCap = 'butt';
  boostCtx.stroke();

  // Color arc
  const endAngle = startAngle + (pct / 100) * totalAngle;
  boostCtx.beginPath();
  boostCtx.arc(cx, cy, R, startAngle, endAngle);
  boostCtx.strokeStyle = color;
  boostCtx.lineWidth = 22;
  boostCtx.lineCap = 'butt';
  boostCtx.stroke();
}

// ── Series Dots ───────────────────────────────────────────────────────────
function renderSeriesDots(containerId, wins, bestOf, side) {
  const container = el(containerId);
  if (!container) return;
  const needed = Math.ceil(bestOf / 2);
  container.innerHTML = '';
  for (let i = 0; i < needed; i++) {
    const dot = document.createElement('div');
    dot.className = 'series-dot';
    if (i < wins) dot.classList.add(side === 'blue' ? 'won-blue' : 'won-orange');
    container.appendChild(dot);
  }
}

// ── Players (Sides) ───────────────────────────────────────────────────────
function renderPlayerPanels(players, spectated) {
  const blue   = players.filter(p => p.team === 0).sort((a, b) => a.name.localeCompare(b.name));
  const orange = players.filter(p => p.team === 1).sort((a, b) => a.name.localeCompare(b.name));

  function buildPanel(containerId, list, side) {
    const c = el(containerId);
    if (!c) return;
    c.innerHTML = '';
    list.forEach(p => {
      const isSpectated = p.name === spectated;
      const row = document.createElement('div');
      row.className = 'player-item' + (p.isDemolished ? ' demolished' : '');

      // BG
      const bg = document.createElement('img');
      bg.className = 'player-bg';
      if (isSpectated) {
        bg.src = side === 'blue' ? '/assets/player-blue.png' : '/assets/player-orange.png';
      } else {
        bg.src = '/assets/player.png';
      }
      row.appendChild(bg);

      // Boost bar
      const boostBar = document.createElement('div');
      boostBar.className = 'player-boost-bar';
      const pct = Math.max(0, Math.min(100, p.boost || 0));
      boostBar.style.width = `${pct}%`;
      if (isSpectated) boostBar.style.background = '#fff';
      row.appendChild(boostBar);

      // Name
      const nameEl = document.createElement('div');
      nameEl.className = 'player-name-txt';
      nameEl.textContent = p.name;
      row.appendChild(nameEl);

      // Boost number
      const boostNum = document.createElement('div');
      boostNum.className = 'player-boost-num';
      boostNum.textContent = p.boost ?? 0;
      row.appendChild(boostNum);

      c.appendChild(row);
    });
  }

  buildPanel('players-blue', blue, 'blue');
  buildPanel('players-orange', orange, 'orange');
}

// ── Helper: find facecam by player name OR platformId ────────────────────
function findFacecam(player, facecams) {
  if (!facecams || !facecams.length) return null;
  const rawId = player.primaryid ? String(player.primaryid).split('|')[1] : null;
  
  // 1. Try to find by ID first (stronger priority)
  if (rawId) {
    const byId = facecams.find(fc => fc.platformId && fc.platformId === rawId);
    if (byId) return byId;
  }

  // 2. Fallback to name
  return facecams.find(fc => fc.name === player.name) || null;
}

function safeId(name) {
  return name ? name.replace(/[^a-zA-Z0-9]/g, '-') : 'unknown';
}

// ── Facecams ─────────────────────────────────────────────────────────────
function renderFacecams(players, facecams) {
  if (currentState.facecamsEnabled === false) {
    document.querySelectorAll('.player-facecam-container').forEach(c => c.remove());
    return;
  }
  players.forEach(p => {
    const fc  = findFacecam(p, facecams);
    const cid = `player-${safeId(p.name)}-facecam`;

    if (!fc) {
      const existing = document.getElementById(cid);
      if (existing) existing.remove();
      return;
    }

    if (document.getElementById(cid)) return;

    const container = document.createElement('div');
    container.id = cid;
    container.className = 'player-facecam-container';

    const iframe = document.createElement('iframe');
    iframe.id = `facecam-iframe-${safeId(p.name)}`;
    iframe.className = 'facecam-iframe';
    iframe.src = fc.link || '';
    iframe.frameBorder = '0';
    iframe.allow = 'autoplay; encrypted-media';

    container.appendChild(iframe);
    const facecamsDiv = el('active-player-bot');
    if (facecamsDiv) facecamsDiv.appendChild(container);
  });
}


// ── Bottom active player ──────────────────────────────────────────────────
function renderActivePlayer(players, spectated, facecams) {
  const p = players.find(pl => pl.name === spectated);
  const wrap  = el('active-player-bot');
  const boostWrap = el('boost-wrap');

  if (!p) {
    if (wrap) wrap.classList.add('hidden');
    if (boostWrap) boostWrap.classList.add('hidden');
    return;
  }

  if (wrap) wrap.classList.remove('hidden');
  if (boostWrap) boostWrap.classList.remove('hidden');

  // Bottom left background
  const bgImg = el('active-player-bg');
  if (bgImg) bgImg.src = p.team === 0 ? '/assets/player-blue-bot.png' : '/assets/player-orange-bot.png';

  // Bottom left bar
  const botBar = el('bot-boost-bar');
  const pct = Math.max(0, Math.min(100, p.boost || 0));
  if (botBar) {
    botBar.style.width = `${(pct / 100) * 254}px`;
    // Removed team-colored background to keep it white from CSS
  }

  const fc = (currentState.facecamsEnabled !== false) ? findFacecam(p, facecams) : null;
  const containers = document.querySelectorAll('.player-facecam-container');
  containers.forEach(c => c.style.visibility = 'hidden');

  if (fc) {
    const facecamdiv = el(`player-${safeId(p.name)}-facecam`);
    if (facecamdiv) facecamdiv.style.visibility = 'visible';
  }

  setText('bot-player-name', p.name);
  setText('bot-stat-score', p.score);
  setText('bot-stat-goals', p.goals);
  setText('bot-stat-shots', p.shots);
  setText('bot-stat-assists', p.assists);
  setText('bot-stat-saves', p.saves);
  setText('bot-stat-demos', p.demos);

  // Bottom right boost
  boostColor = p.team === 0 ? BLUE : ORANGE;
  drawBoost(pct, boostColor);
  setText('boost-value', Math.round(pct));
}

// ── Break / Starting Soon scene ─────────────────────────────────────────────
let breakTickId = null;

function formatCountdown(ms) {
  let total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  total -= h * 3600;
  const m = Math.floor(total / 60);
  const s = total % 60;
  const pad = n => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function tickBreakCountdown() {
  const cdEl = el('break-countdown');
  if (!cdEl) return;
  const brk = currentState.breakScreen;
  if (!brk || !brk.visible || !brk.endsAt) {
    cdEl.classList.add('hidden');
    return;
  }
  const remaining = brk.endsAt - Date.now();
  cdEl.classList.remove('hidden');
  cdEl.textContent = formatCountdown(remaining);
}

function renderBreak(brk) {
  const view = el('view-break');
  if (!view) return;

  const visible = !!(brk && brk.visible);
  view.classList.toggle('hidden', !visible);

  if (!visible) {
    if (breakTickId) { clearInterval(breakTickId); breakTickId = null; }
    return;
  }

  setText('break-title', (brk.title || '').toUpperCase());

  const msgEl = el('break-message');
  if (msgEl) {
    msgEl.textContent = brk.message || '';
    msgEl.classList.toggle('hidden', !brk.message);
  }

  // "Up Next" — the next not-yet-started match from the loaded bracket
  const upNextWrap = el('break-upnext');
  if (upNextWrap) {
    const matches = (currentState.bracket && currentState.bracket.matches) || [];
    const next = matches.find(m => m.state === 1) || null;   // 1 = not started
    if (next) {
      setText('break-upnext-match', `${next.a}  vs  ${next.b}`);
      upNextWrap.classList.remove('hidden');
    } else {
      upNextWrap.classList.add('hidden');
    }
  }

  tickBreakCountdown();
  if (!breakTickId) {
    breakTickId = setInterval(tickBreakCountdown, 250);
  }
}

// ── Player spotlight (featured-player lower-third, live stats) ──────────────
function renderSpotlight(players, spotlight) {
  const box = el('spotlight');
  if (!box) return;

  const sp = spotlight || currentState.spotlight || {};
  const visible = !!sp.visible && !!sp.playerName;
  if (!visible) {
    box.classList.add('hidden');
    return;
  }

  const list = players || currentState.players || [];
  const p = list.find(pl => pl.name === sp.playerName);

  box.classList.remove('hidden');
  box.classList.toggle('blue', !!p && p.team === 0);
  box.classList.toggle('orange', !!p && p.team === 1);

  setText('spotlight-name', (sp.playerName || '').toUpperCase());
  setText('spotlight-team', p ? '' : '(offline)');
  setText('spot-goals', p ? (p.goals ?? 0) : 0);
  setText('spot-assists', p ? (p.assists ?? 0) : 0);
  setText('spot-saves', p ? (p.saves ?? 0) : 0);
  setText('spot-shots', p ? (p.shots ?? 0) : 0);
  setText('spot-score', p ? (p.score ?? 0) : 0);
}

// ── Ticker (scrolling sponsor / announcement lower-third) ───────────────────
let _lastTickerSig = '';

function renderTicker(ticker) {
  const bar   = el('ticker');
  const track = el('ticker-track');
  if (!bar || !track) return;

  const messages = (ticker && Array.isArray(ticker.messages)) ? ticker.messages.filter(Boolean) : [];
  const visible = !!(ticker && ticker.visible) && messages.length > 0;

  bar.classList.toggle('hidden', !visible);
  if (!visible) return;

  // Rebuild only when content/speed changes so the scroll animation isn't reset
  const speed = (ticker.speed > 0) ? ticker.speed : 40;
  const sig = JSON.stringify({ messages, speed });
  if (sig === _lastTickerSig) return;
  _lastTickerSig = sig;

  // Two copies of the joined messages give a seamless looping marquee
  const joined = messages.join('   •   ');
  track.innerHTML = '';
  for (let i = 0; i < 2; i++) {
    const span = document.createElement('span');
    span.className = 'ticker-segment';
    span.textContent = joined;
    track.appendChild(span);
  }
  track.style.animationDuration = `${speed}s`;
}

// ── State handling ────────────────────────────────────────────────────────
let bannerIntervalId = null;
let currentBannerIdx = 0;
let sponsorRailTimer = null;
let sponsorRailIdx = 0;

// Sponsor rail — rotating corner bug fed by the active brand kit's sponsors.
function renderSponsorRail(brand) {
  const rail = el('sponsor-rail');
  if (!rail) return;
  // Only sponsors tagged for the rail (placements.rail); falls back to all for legacy brands.
  const sp = (brand && (brand.railSponsors || brand.sponsors)) || [];
  if (sponsorRailTimer) { clearInterval(sponsorRailTimer); sponsorRailTimer = null; }
  if (!sp.length) { rail.classList.add('hidden'); return; }
  rail.classList.remove('hidden');
  setText('sponsor-rail-label', brand.sponsorLabel || 'PARTNERS');
  if (sponsorRailIdx >= sp.length) sponsorRailIdx = 0;
  const draw = () => {
    const s = sp[sponsorRailIdx] || {};
    const slot = el('sponsor-rail-slot'); if (!slot) return;
    slot.innerHTML = '';
    if (s.logo) { const img = document.createElement('img'); img.className = 'sr-logo'; img.src = s.logo; img.alt = s.name || ''; slot.appendChild(img); }
    else { const t = document.createElement('span'); t.className = 'sr-name'; t.textContent = s.name || ''; slot.appendChild(t); }
  };
  draw();
  if (sp.length > 1) {
    const ms = Math.max(2, brand.sponsorInterval || 6) * 1000;
    sponsorRailTimer = setInterval(() => { sponsorRailIdx = (sponsorRailIdx + 1) % sp.length; draw(); }, ms);
  }
}

function applyFullState(data) {
  currentState = data;

  setText('event-text', data.eventName);

  if (data.fontFamily) {
    document.documentElement.style.setProperty('--main-font', `'${data.fontFamily}', sans-serif`);
  }
  document.documentElement.dataset.theme = data.theme || 'default';

  // Active client brand kit: recolor accents + drive the sponsor rail.
  if (data.brand) {
    if (data.brand.color)  document.documentElement.style.setProperty('--accent', data.brand.color);
    if (data.brand.accent) document.documentElement.style.setProperty('--accent-2', data.brand.accent);
    if (data.brand.font)   document.documentElement.style.setProperty('--main-font', `'${data.brand.font}', sans-serif`);
  }
  renderSponsorRail(data.brand);

  const teams = data.teams || {};
  setTextAutoFit('name-blue', teams.blue?.name || 'BLUE TEAM', 50, 16);
  setTextAutoFit('name-orange', teams.orange?.name || 'ORANGE TEAM', 50, 16);
  setImg('logo-blue', teams.blue?.logo, '/assets/rl.png');
  setImg('logo-orange', teams.orange?.logo, '/assets/rl.png');

  const game = data.game || {};
  setText('score-blue', game.blueScore ?? 0);
  setText('score-orange', game.orangeScore ?? 0);
  setText('game-info', `GAME ${game.number ?? 0} | BEST OF ${data.bestOf || 5}`);
  setText('game-info-1', `GAME ${game.number ?? 0}`);
  setText('game-info-2', `BEST OF ${data.bestOf || 5}`);
  const timerEl = el('timer');
  if (timerEl) {
    timerEl.textContent = (game.isOT ? '+' : '') + (data.formattedTime || '5:00');
    timerEl.className = game.isOT ? 'timer-ot' : 'timer';
  }

  const series = data.series || { blue: 0, orange: 0 };
  renderSeriesDots('series-dots-blue', series.blue, data.bestOf || 5, 'blue');
  renderSeriesDots('series-dots-orange', series.orange, data.bestOf || 5, 'orange');

  const players = data.players || [];
  const spectated = data.spectatedPlayer;
  const facecams = data.facecams || data.savedFacecams || [];

  renderFacecams(players, facecams);
  renderPlayerPanels(players, spectated);
  renderActivePlayer(players, spectated, facecams);

  if (data.banner) {
    const bannerEl = el('sponsor-banner');
    const imagesContainer = el('sponsor-banner-images');
    if (bannerEl) {
      if (data.banner.visible) {
        bannerEl.classList.remove('hidden');
      } else {
        bannerEl.classList.add('hidden');
      }
    }
    
    if (imagesContainer) {
      // Clear interval
      if (bannerIntervalId) clearInterval(bannerIntervalId);
      imagesContainer.innerHTML = '';
      
      const images = data.banner.images || [];
      if (images.length > 0) {
        // Create imgs
        const imgEls = images.map((src, idx) => {
          const img = document.createElement('img');
          img.className = 'sponsor-banner-img' + (idx === 0 ? ' active' : '');
          img.src = src;
          imagesContainer.appendChild(img);
          return img;
        });

        if (images.length > 1) {
          currentBannerIdx = 0;
          const interval = (data.banner.interval || 10) * 1000;
          bannerIntervalId = setInterval(() => {
            imgEls[currentBannerIdx].classList.remove('active');
            currentBannerIdx = (currentBannerIdx + 1) % imgEls.length;
            imgEls[currentBannerIdx].classList.add('active');
          }, interval);
        }
      }
    }
  }

  renderBreak(data.breakScreen);
  renderTicker(data.ticker);
  renderSpotlight(data.players, data.spotlight);

  showView(data.view || 'hud');
}

function applyStateUpdate(gameData, players, spectated, facecams) {
  const game = gameData || {};
  setText('score-blue', game.blueScore ?? 0);
  setText('score-orange', game.orangeScore ?? 0);
  
  const timerEl = el('timer');
  if (timerEl) {
    timerEl.textContent = (game.isOT ? '+' : '') + (game.formattedTime || '5:00');
    timerEl.className = game.isOT ? 'timer-ot' : 'timer';
  }

  renderFacecams(players, facecams || []);
  renderPlayerPanels(players, spectated);
  renderActivePlayer(players, spectated, facecams || []);
  renderSpotlight(players, currentState.spotlight);
}

function applyGoalView(goal) {
  if (!goal) return;
  setImg('goal-banner-img', goal.team === 0 ? '/assets/goal-blue-2.png' : '/assets/goal-orange-2.png');
  setText('goal-scorer', (goal.scorer || '').toUpperCase());
  setText('goal-speed', goal.speed || 0);

  const assistEl = el('goal-assister');
  const assistLbl = el('goal-assist-label');
  if (goal.assisterName) {
    if (assistEl) assistEl.textContent = goal.assisterName.toUpperCase();
    if (assistLbl) assistLbl.classList.remove('hidden');
  } else {
    if (assistEl) assistEl.textContent = '';
    if (assistLbl) assistLbl.classList.add('hidden');
  }
}

// ── Scoreboard ────────────────────────────────────────────────────────────
// Re-using old scoreboard rendering code without modifying its design,
// but we just show it when view changes.
function renderScoreboard(playerCache, data) {
  const allPlayers = Object.values(playerCache || {});
  const blue = allPlayers.filter(p => p.team === 0).sort((a,b)=>b.score - a.score);
  const orange = allPlayers.filter(p => p.team === 1).sort((a,b)=>b.score - a.score);
  const allSorted = [...allPlayers].sort((a,b)=>b.score - a.score);
  const mvpName = allSorted[0]?.name;

  const statsList = ['score', 'goals', 'assists', 'shots', 'saves', 'demos'];

  // Update comparison bars
  statsList.forEach(st => {
    const blueTotal = blue.reduce((acc, p) => acc + (p[st] || 0), 0);
    const orangeTotal = orange.reduce((acc, p) => acc + (p[st] || 0), 0);
    const total = blueTotal + orangeTotal;
    
    const bBar = el(`bar-${st}-blue`);
    const oBar = el(`bar-${st}-orange`);
    const sep  = el(`sep-${st}`);
    
    if (bBar && oBar) {
      let pct = 50;
      if (total > 0) {
        pct = (blueTotal / total) * 100;
      }
      bBar.style.width = `${pct}%`;
      oBar.style.width = `${100 - pct}%`;
      if (sep) sep.style.left = `${pct}%`;
    }
  });

  function buildSB(containerId, list, side) {
    const c = el(containerId);
    if (!c) return;
    c.innerHTML = '';
    const names = document.createElement('div');
    names.className = side === 'blue' ? 'sb-player-names-blue' : 'sb-player-names-orange';
    list.forEach(p => {
      const n = document.createElement('div');
      n.className = 'sb-pname';
      if(p.name === mvpName) {
        n.classList.add('mvp-player');
        const m = document.createElement('img');
        m.src = '/assets/mvp.png';
        m.className = 'mvp-icon';
        n.appendChild(m);
      }
      const s = document.createElement('span');
      s.textContent = p.name;
      n.appendChild(s);
      names.appendChild(n);
    });
    c.appendChild(names);

    const wrap = document.createElement('div');
    wrap.className = 'sb-stat-rows';
    statsList.forEach(st => {
      const row = document.createElement('div');
      row.className = 'sb-stat-row';
      list.forEach(p => {
        const v = document.createElement('div');
        v.className = 'sb-stat-val';
        if(p.name === mvpName) v.classList.add('mvp-stat');
        v.textContent = p[st] || 0;
        row.appendChild(v);
      });
      wrap.appendChild(row);
    });
    c.appendChild(wrap);
  }
  buildSB('sb-players-blue', blue, 'blue');
  buildSB('sb-players-orange', orange, 'orange');
}

// ── WebSocket ─────────────────────────────────────────────────────────────
function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => ws.send(JSON.stringify({ type: 'request_state' }));

  ws.onmessage = ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case 'full_state':
        applyFullState(msg.data);
        break;

      case 'state_update':
        currentState.game = msg.data.game;
        currentState.players = msg.data.players;
        currentState.spectatedPlayer = msg.data.spectatedPlayer;
        currentState.facecams = msg.data.facecams;
        applyStateUpdate(msg.data.game, msg.data.players, msg.data.spectatedPlayer, msg.data.facecams);
        break;

      case 'view_change':
        if (msg.data.view === 'goal') applyGoalView(msg.data.goal);
        if (msg.data.view === 'scoreboard') renderScoreboard(msg.data.playerCache || currentState.playerCache || {}, currentState);
        showView(msg.data.view || 'hud');
        break;

      case 'game_reset':
        el('players-blue').innerHTML = '';
        el('players-orange').innerHTML = '';
        // Remove stale facecam containers so they're rebuilt fresh for the new match
        document.querySelectorAll('.player-facecam-container').forEach(c => c.remove());
        if(el('active-player-bot')) el('active-player-bot').classList.add('hidden');
        if(el('boost-wrap')) el('boost-wrap').classList.add('hidden');
        break;
    }
  };

  ws.onclose = () => setTimeout(connect, 3000);
}

connect();
