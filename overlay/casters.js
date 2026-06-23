/* ─── Standalone caster scene — connects to the WS bridge on :3001 ────────── */

const WS_URL = 'ws://localhost:3001';

let ws;
let currentState = {};
let _lastCasterSig = '';

const CASTER_CAM_WIDTHS = { 1: 1280, 2: 860, 3: 580, 4: 720 };

function el(id) { return document.getElementById(id); }

function orderedCasters(casters) {
  const list = (casters && Array.isArray(casters.list))
    ? casters.list.filter(c => c && (c.name || c.handle || c.camUrl))
    : [];
  return list.slice().sort((a, b) => {
    const sa = Number(a.slot) || 99;
    const sb = Number(b.slot) || 99;
    return sa - sb;
  });
}

function renderCasters(casters) {
  const stage = el('caster-stage');
  const listEl = el('caster-list');
  if (!stage || !listEl) return;

  const items = orderedCasters(casters);
  const standalone = /\/casters\.html$/i.test(location.pathname);
  const visible = standalone || (!!(casters && casters.visible) && items.length > 0);

  stage.classList.toggle('show', visible);

  const sig = JSON.stringify(items);
  if (sig === _lastCasterSig) return;
  _lastCasterSig = sig;

  const camW = CASTER_CAM_WIDTHS[Math.min(items.length, 4)] || 580;
  const camH = Math.round(camW * 9 / 16);

  listEl.innerHTML = '';
  items.forEach(c => {
    const box = document.createElement('div');
    box.className = 'caster-cam';
    box.style.width = camW + 'px';

    const slot = Number(c.slot);
    if (slot >= 1 && slot <= 4) {
      const badge = document.createElement('div');
      badge.className = 'caster-slot-badge';
      badge.textContent = `Caster ${slot}`;
      box.appendChild(badge);
    }

    const frame = document.createElement('div');
    frame.className = 'caster-cam-frame';
    frame.style.height = camH + 'px';
    const camUrl = (c.camUrl || '').trim();
    if (camUrl) {
      const iframe = document.createElement('iframe');
      iframe.className = 'caster-cam-iframe';
      iframe.src = camUrl;
      iframe.frameBorder = '0';
      iframe.allow = 'autoplay; encrypted-media';
      iframe.referrerPolicy = 'no-referrer';
      frame.appendChild(iframe);
    }
    box.appendChild(frame);

    const plate = document.createElement('div');
    plate.className = 'caster-plate';

    const name = document.createElement('div');
    name.className = 'caster-name';
    name.textContent = (c.name || '').toUpperCase();
    plate.appendChild(name);

    const handleText = (typeof SceneBase !== 'undefined')
      ? SceneBase.formatCasterHandle(c)
      : (c.handle || '').trim();
    const social = (c.social || 'none').toString().toLowerCase();
    if (handleText && social !== 'none') {
      const handle = document.createElement('div');
      const cls = (typeof SceneBase !== 'undefined')
        ? SceneBase.socialPlatformClass(social)
        : '';
      handle.className = 'caster-handle' + (cls ? ' ' + cls : '');
      handle.textContent = handleText;
      plate.appendChild(handle);
    }

    box.appendChild(plate);
    listEl.appendChild(box);
  });
}

function applyFullState(data) {
  currentState = data;
  if (data.fontFamily) {
    document.documentElement.style.setProperty('--main-font', `'${data.fontFamily}', sans-serif`);
  }
  document.documentElement.dataset.theme = data.theme || 'default';
  renderCasters(data.casters);
}

function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => ws.send(JSON.stringify({ type: 'request_state' }));

  ws.onmessage = ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'full_state') applyFullState(msg.data);
  };

  ws.onclose = () => setTimeout(connect, 3000);
}

connect();