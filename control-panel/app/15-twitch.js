// Control panel, part 15 of 17: Twitch: predictions bar, chat, stream controls, markers, AI page, notifications.
// Built into control-panel/app.js with the other parts (scripts/build-panel-app.js): one script, one scope.

// ── Predictions Quick Bar (sidebar) ──────────────────────────────────────────
function renderPredQuickBar(twitch) {
  const activeEl = el('qpred-active');
  const createEl = el('qpred-create');
  const livePillEl = el('qpred-live-pill');
  const dot = el('qrail-predict-dot');
  if (!activeEl || !createEl) return;

  const pred = twitch?.predictions?.current;
  const isActive = pred && (pred.state === 'ACTIVE' || pred.state === 'active');

  if (isActive) {
    activeEl.style.display = 'block';
    createEl.style.display = 'none';
    if (livePillEl) livePillEl.style.display = 'inline-block';
    if (dot) dot.style.display = 'block';

    const titleEl = el('qpred-active-title');
    if (titleEl) titleEl.textContent = pred.title;

    const timerEl = el('qpred-timer');
    if (timerEl && pred.endsAt) {
      const secsLeft = Math.max(0, Math.floor((new Date(pred.endsAt) - Date.now()) / 1000));
      if (secsLeft > 0) {
        const m = Math.floor(secsLeft / 60), s = secsLeft % 60;
        timerEl.textContent = `${m}:${s.toString().padStart(2, '0')} left`;
        timerEl.style.color = secsLeft < 60 ? '#f56565' : '#9146ff';
      } else {
        timerEl.textContent = 'Voting closed';
        timerEl.style.color = '#888';
      }
    } else if (timerEl) {
      timerEl.textContent = '';
    }

    const outcomesEl = el('qpred-outcomes');
    if (outcomesEl && pred.outcomes) {
      const teams = currentState?.teams || {};
      const totalVotes = pred.outcomes.reduce((s, o) => s + (o.votes || 0), 0);
      outcomesEl.innerHTML = pred.outcomes.map((o, i) => {
        const pct = totalVotes > 0 ? Math.round((o.votes || 0) / totalVotes * 100) : 50;
        const side = i === 0 ? 'blue' : 'orange';
        const color = teams[side]?.color || (i === 0 ? '#5B9BD5' : '#E8712A');
        return `<div>
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;">
            <span style="font-size:12px;font-weight:700;color:${color};max-width:145px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(o.title)}</span>
            <span style="font-size:11px;color:var(--muted);flex-shrink:0;">${(o.votes || 0).toLocaleString()} · ${pct}%</span>
          </div>
          <div style="background:rgba(255,255,255,0.07);border-radius:4px;height:5px;overflow:hidden;margin-bottom:6px;">
            <div style="height:100%;width:${pct}%;background:${color};border-radius:4px;transition:width 0.4s;"></div>
          </div>
          <button class="btn btn-xs btn-success qpred-resolve-btn" style="width:100%;font-size:11px;"
            data-outcome-id="${o.id}" data-outcome-title="${escapeHtml(o.title)}">✓ Declare Winner</button>
        </div>`;
      }).join('');
    }
  } else {
    activeEl.style.display = 'none';
    createEl.style.display = 'block';
    if (livePillEl) livePillEl.style.display = 'none';
    if (dot) dot.style.display = 'none';

    // Pre-fill team names as placeholders without overriding user input
    const teams = currentState?.teams || {};
    const opt0 = el('qpred-opt0');
    const opt1 = el('qpred-opt1');
    if (opt0 && !opt0.value) opt0.placeholder = teams.blue?.name || 'Blue side';
    if (opt1 && !opt1.value) opt1.placeholder = teams.orange?.name || 'Orange side';
  }
}

// Prediction quick bar — create
el('btn-qpred-create')?.addEventListener('click', async () => {
  const titleInput = el('qpred-new-title');
  const opt0Input = el('qpred-opt0');
  const opt1Input = el('qpred-opt1');
  const durInput = el('qpred-duration');
  const btn = el('btn-qpred-create');

  const title = titleInput?.value.trim() || 'Who will win?';
  const opt0 = opt0Input?.value.trim() || currentState?.teams?.blue?.name || 'Blue';
  const opt1 = opt1Input?.value.trim() || currentState?.teams?.orange?.name || 'Orange';

  const durStr = durInput?.value.trim() || '5:00';
  let durationSecs = 300;
  if (durStr.includes(':')) {
    const [m, s] = durStr.split(':').map(Number);
    durationSecs = (m || 0) * 60 + (s || 0);
  } else {
    durationSecs = parseInt(durStr, 10) || 300;
  }
  durationSecs = Math.max(30, Math.min(1800, durationSecs));

  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    const r = await fetch('http://127.0.0.1:3000/api/twitch/prediction/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, outcomes: [opt0, opt1], durationSeconds: durationSecs })
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
    if (titleInput) titleInput.value = '';
    if (opt0Input) opt0Input.value = '';
    if (opt1Input) opt1Input.value = '';
  } catch (err) {
    showToast('Failed to create prediction: ' + err.message, '#c53030', 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create';
  }
});

// Prediction quick bar — cancel
el('btn-qpred-cancel')?.addEventListener('click', async () => {
  const btn = el('btn-qpred-cancel');
  btn.disabled = true;
  try {
    const r = await fetch('http://127.0.0.1:3000/api/twitch/prediction/cancel', { method: 'POST' });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
  } catch (err) {
    showToast('Failed to cancel: ' + err.message, '#c53030', 5000);
  } finally {
    btn.disabled = false;
  }
});

// Prediction quick bar — resolve (event delegation on outcomes container)
el('qpred-outcomes')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('.qpred-resolve-btn');
  if (!btn || btn.disabled) return;
  const { outcomeId, outcomeTitle } = btn.dataset;
  if (!outcomeId) return;
  if (!await appConfirm(`Declare "${outcomeTitle}" the winner?`, 'Declare Winner', false)) return;
  btn.disabled = true;
  btn.textContent = 'Resolving…';
  try {
    const r = await fetch('http://127.0.0.1:3000/api/twitch/prediction/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcomeId })
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');
  } catch (err) {
    showToast('Failed to resolve: ' + err.message, '#c53030', 5000);
    btn.disabled = false;
    btn.textContent = '✓ Declare Winner';
  }
});

// ── Chat send from sidebar ───────────────────────────────────────────────────
async function sendSidebarChat() {
  const input = el('chat-send-input');
  const msg = input?.value.trim();
  if (!msg) return;
  input.value = '';
  try {
    const r = await fetch('http://127.0.0.1:3000/api/twitch/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg })
    });
    if (!r.ok) {
      const d = await r.json();
      showToast(d.error || 'Failed to send message', '#c53030', 4000);
      if (input) input.value = msg;
    } else {
      addChatMessage(currentState?.twitch?.displayName || 'You', msg, '#9146ff');
    }
  } catch (err) {
    showToast('Send failed: ' + err.message, '#c53030', 4000);
    if (input) input.value = msg;
  }
}
el('btn-sidebar-chat-send')?.addEventListener('click', sendSidebarChat);
el('chat-send-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendSidebarChat(); }
});

// ── Twitch Embed + Stream Controls ───────────────────────────────────────────
let _embedChannel = null;
let _embedViewerPoll = null;
const EMBED_POLL_MS = 30000;

function initTwitchEmbed(channelName) {
  if (!channelName) return;
  _embedChannel = channelName;
  if (!_embedViewerPoll) {
    startEmbedViewerPoll();
    fetchChatModeSettings();
  }
}

function startEmbedViewerPoll() {
  stopEmbedViewerPoll();
  updateEmbedViewers();
  _embedViewerPoll = setInterval(updateEmbedViewers, EMBED_POLL_MS);
}

function stopEmbedViewerPoll() {
  if (_embedViewerPoll) { clearInterval(_embedViewerPoll); _embedViewerPoll = null; }
}

async function updateEmbedViewers() {
  try {
    const r = await fetch('http://127.0.0.1:3000/api/twitch/stream/viewers');
    if (!r.ok) return;
    const d = await r.json();
    const badge = el('embed-live-badge');
    const cnt   = el('embed-viewer-count');
    if (badge) badge.style.display = d.isLive ? 'inline' : 'none';
    if (cnt)   { cnt.style.display = d.isLive ? 'inline' : 'none'; if (d.isLive) cnt.textContent = (d.viewers || 0).toLocaleString() + ' viewers'; }
    const titleIn = el('embed-stream-title');
    const gameIn  = el('embed-stream-game');
    if (titleIn && !titleIn.value && d.title) titleIn.value = d.title;
    if (gameIn  && !gameIn.value  && d.game)  gameIn.value  = d.game;
  } catch (_) {}
}

async function fetchChatModeSettings() {
  try {
    const r = await fetch('http://127.0.0.1:3000/api/twitch/chat/settings');
    if (!r.ok) return;
    const d = await r.json();
    updateModeBtnUI({
      subOnly:      d.subscriber_mode ?? false,
      emoteOnly:    d.emote_mode      ?? false,
      followerOnly: d.follower_mode   ?? false,
      slowMode:     d.slow_mode       ?? false,
    });
  } catch (_) {}
}

function updateModeBtnUI(settings) {
  const map = { subOnly: 'embed-mode-sub', emoteOnly: 'embed-mode-emote', followerOnly: 'embed-mode-follower', slowMode: 'embed-mode-slow' };
  Object.entries(map).forEach(([key, id]) => {
    const btn = el(id);
    if (btn) btn.classList.toggle('mode-active', !!settings[key]);
  });
  const flowsMap = { subOnly: 'flows-toggle-sub', emoteOnly: 'flows-toggle-emote', followerOnly: 'flows-toggle-follower', slowMode: 'flows-toggle-slow' };
  Object.entries(flowsMap).forEach(([key, id]) => {
    const chk = el(id);
    if (chk) chk.checked = !!settings[key];
  });
}

async function toggleChatMode(mode) {
  const idMap = { subOnly: 'embed-mode-sub', emoteOnly: 'embed-mode-emote', followerOnly: 'embed-mode-follower', slowMode: 'embed-mode-slow' };
  const btn = el(idMap[mode]);
  const isActive = btn?.classList.contains('mode-active');
  const payload = { [mode]: !isActive };
  if (mode === 'slowMode') payload.slowModeSeconds = !isActive ? 30 : 0;
  try {
    const r = await fetch('http://127.0.0.1:3000/api/twitch/chat/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (r.ok) {
      if (btn) btn.classList.toggle('mode-active');
      const flowsIdMap = { subOnly: 'flows-toggle-sub', emoteOnly: 'flows-toggle-emote', followerOnly: 'flows-toggle-follower', slowMode: 'flows-toggle-slow' };
      const chk = el(flowsIdMap[mode]);
      if (chk) chk.checked = !isActive;
    }
  } catch (_) {}
}

el('btn-embed-settings')?.addEventListener('click', () => {
  const panel = el('tw-embed-settings-panel');
  if (!panel) return;
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'block';
  if (!open) fetchChatModeSettings();
});

el('btn-embed-set-title')?.addEventListener('click', async () => {
  const title = el('embed-stream-title')?.value?.trim();
  if (!title) return;
  const btn = el('btn-embed-set-title');
  const orig = btn.textContent; btn.textContent = '…'; btn.disabled = true;
  try {
    const r = await fetch('http://127.0.0.1:3000/api/twitch/channel', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
    if (r.ok) { btn.textContent = '✓'; showToast('Title updated', '#4ade80', 2500); }
    else { const d = await r.json(); btn.textContent = '✗'; showToast(d.error || 'Failed', '#c53030', 3000); }
  } catch (_) { btn.textContent = '✗'; }
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500);
});

let _embedGameSearchTimer = null;
el('embed-stream-game')?.addEventListener('input', () => {
  clearTimeout(_embedGameSearchTimer);
  const q = el('embed-stream-game').value.trim();
  const sugg = el('embed-game-suggestions');
  if (!q || q.length < 2) { if (sugg) sugg.style.display = 'none'; return; }
  _embedGameSearchTimer = setTimeout(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:3000/api/twitch/games/search?q=${encodeURIComponent(q)}`);
      if (!r.ok) return;
      const games = await r.json();
      if (!sugg || !games.length) { if (sugg) sugg.style.display = 'none'; return; }
      sugg.innerHTML = games.slice(0, 5).map(g =>
        `<div class="embed-game-suggestion" data-id="${escapeHtml(String(g.id))}" data-name="${escapeHtml(g.name)}" style="padding:5px 8px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.06);">${escapeHtml(g.name)}</div>`
      ).join('');
      sugg.style.display = 'block';
      sugg.querySelectorAll('.embed-game-suggestion').forEach(item => {
        item.addEventListener('click', () => {
          const inp = el('embed-stream-game');
          if (inp) { inp.dataset.gameId = item.dataset.id; inp.value = item.dataset.name; }
          sugg.style.display = 'none';
        });
        item.addEventListener('mouseenter', () => { item.style.background = 'rgba(255,255,255,0.06)'; });
        item.addEventListener('mouseleave', () => { item.style.background = ''; });
      });
    } catch (_) {}
  }, 350);
});

el('embed-stream-game')?.addEventListener('blur', () => {
  setTimeout(() => { const s = el('embed-game-suggestions'); if (s) s.style.display = 'none'; }, 200);
});

el('btn-embed-set-game')?.addEventListener('click', async () => {
  const gameInp = el('embed-stream-game');
  const name = gameInp?.value?.trim();
  if (!name) return;
  const gameId = gameInp?.dataset?.gameId || null;
  const btn = el('btn-embed-set-game');
  const orig = btn.textContent; btn.textContent = '…'; btn.disabled = true;
  try {
    const body = gameId ? { gameId } : { gameName: name };
    const r = await fetch('http://127.0.0.1:3000/api/twitch/channel', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) { btn.textContent = '✓'; showToast('Category updated', '#4ade80', 2500); if (gameInp) delete gameInp.dataset.gameId; }
    else { const d = await r.json(); btn.textContent = '✗'; showToast(d.error || 'Failed', '#c53030', 3000); }
  } catch (_) { btn.textContent = '✗'; }
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500);
});

document.querySelectorAll('.embed-mode-btn').forEach(btn => {
  btn.addEventListener('click', () => toggleChatMode(btn.dataset.mode));
});

el('btn-embed-shoutout')?.addEventListener('click', async () => {
  const user = el('embed-shoutout-user')?.value?.trim().replace(/^@/, '');
  const fb = el('embed-shoutout-fb');
  if (!user) return;
  const btn = el('btn-embed-shoutout');
  const orig = btn.textContent; btn.textContent = '…'; btn.disabled = true;
  try {
    const r = await fetch('http://127.0.0.1:3000/api/twitch/shoutout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: user }) });
    if (r.ok) { btn.textContent = '✓'; if (fb) fb.textContent = `Shoutout sent to @${user}`; const inp = el('embed-shoutout-user'); if (inp) inp.value = ''; }
    else { const d = await r.json(); btn.textContent = '✗'; if (fb) fb.textContent = d.error || 'Failed'; }
  } catch (_) { btn.textContent = '✗'; if (fb) fb.textContent = 'Error'; }
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500);
});

el('btn-embed-raid')?.addEventListener('click', async () => {
  const user = el('embed-raid-user')?.value?.trim().replace(/^@/, '');
  const fb = el('embed-raid-fb');
  if (!user) return;
  const btn = el('btn-embed-raid');
  const cancelBtn = el('btn-embed-cancel-raid');
  const orig = btn.textContent; btn.textContent = '…'; btn.disabled = true;
  try {
    const r = await fetch('http://127.0.0.1:3000/api/twitch/raid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: user }) });
    if (r.ok) { btn.textContent = 'Raiding ✓'; if (fb) fb.textContent = `Raid to @${user} started`; if (cancelBtn) cancelBtn.style.display = ''; }
    else { const d = await r.json(); btn.textContent = '✗'; if (fb) fb.textContent = d.error || 'Failed'; }
  } catch (_) { btn.textContent = '✗'; }
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3000);
});

el('btn-embed-cancel-raid')?.addEventListener('click', async () => {
  const btn = el('btn-embed-cancel-raid');
  const fb = el('embed-raid-fb');
  btn.textContent = '…'; btn.disabled = true;
  try {
    const r = await fetch('http://127.0.0.1:3000/api/twitch/raid', { method: 'DELETE' });
    if (r.ok) { btn.style.display = 'none'; if (fb) fb.textContent = 'Raid cancelled'; }
    else { btn.disabled = false; btn.textContent = '✕'; }
  } catch (_) { btn.disabled = false; btn.textContent = '✕'; }
});

// ── Stream Marker (bottom bar) ───────────────────────────────────────────────
el('btn-bb-marker')?.addEventListener('click', async () => {
  const btn = el('btn-bb-marker');
  if (!btn || btn.disabled) return;
  const origHTML = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Marking…';
  try {
    const r = await fetch('http://127.0.0.1:3000/api/twitch/marker', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const d = await r.json();
    if (r.ok) {
      showToast('Stream marker placed ✓', '#4ade80', 3000);
    } else {
      showToast(d.error || 'Marker failed — is the channel live?', '#c53030', 5000);
    }
  } catch (err) {
    showToast('Marker failed: ' + err.message, '#c53030', 5000);
  } finally {
    setTimeout(() => { if (btn) { btn.disabled = false; btn.innerHTML = origHTML; } }, 2000);
  }
});

el('check-director-enabled')?.addEventListener('change', function() {
  send('set_director', { enabled: this.checked });
});
el('range-director-sensitivity')?.addEventListener('input', function() {
  const v = el('director-sens-val');
  if (v) v.textContent = this.value + '%';
});
el('range-director-sensitivity')?.addEventListener('change', function() {
  send('set_director', { sensitivity: Number(this.value) / 100 });
});
// Pull-and-clear the optional decision note (attaches to the next Accept/Decline for AI training).
function _directorTakeNote() {
  const inp = el('director-note'); if (!inp) return null;
  const v = (inp.value || '').trim(); inp.value = '';
  return v || null;
}
el('btn-director-accept')?.addEventListener('click', () => {
  const p = currentState.director?.primary;
  send('director_feedback', { action: 'accepted', eventType: p?.type, targetId: p?.target?.id, note: _directorTakeNote() });
});
el('btn-director-decline')?.addEventListener('click', () => {
  const p = currentState.director?.primary;
  send('director_feedback', { action: 'declined', eventType: p?.type, targetId: p?.target?.id, note: _directorTakeNote() });
});
el('btn-director-lock')?.addEventListener('click', () => {
  const p = currentState.director?.primary;
  if (p) {
    send('set_director', { lockTarget: p.target?.id || p.name });
    send('director_feedback', { action: 'locked', eventType: p.type, targetId: p.target?.id, note: _directorTakeNote() });
  }
});
el('btn-director-unlock')?.addEventListener('click', () => {
  send('set_director', { lockTarget: null });
  send('director_feedback', { action: 'overridden' });
});
el('check-director-autoswitch')?.addEventListener('change', function() {
  send('set_director', { autoSwitch: this.checked });
});

// ── AI page: Shield + quick controls ──────────────────────────────────────
function renderAiPage(data) {
  data = data || currentState || {};
  const ai = data.ai || {}, dir = data.director || {}, clips = data.clips || {};
  const shielded = !!ai.shield;

  // Shield card + rail-tab indicator dot
  const card = el('ai-shield-card');
  if (card) card.classList.toggle('armed', shielded);
  const dot = el('qrail-ai-dot');
  if (dot) { dot.style.display = shielded ? '' : 'none'; dot.style.background = '#ef4444'; }
  const btn = el('ai-shield-toggle');
  if (btn && document.activeElement !== btn) btn.textContent = shielded ? 'Release Shield' : 'Engage Shield';
  const title = el('ai-shield-title'); if (title) title.textContent = shielded ? 'AI Shield — ENGAGED' : 'AI Shield';
  const desc = el('ai-shield-desc');
  if (desc) desc.innerHTML = shielded
    ? 'Every AI automation is <strong>paused</strong> — nothing will auto-switch, auto-clip, or auto-cut. Your settings are kept. Release the shield to resume.'
    : 'All AI automations are <strong>active</strong>. Engage the shield to instantly pause auto-director, auto-clipping, auto-replay and scene automation — your settings are kept and resume when you release it.';

  // Director quick controls (don't fight the user mid-edit)
  const de = el('ai-dir-enabled'); if (de && document.activeElement !== de) de.checked = dir.enabled !== false;
  const ds = el('ai-dir-sens');
  if (ds && document.activeElement !== ds) { ds.value = Math.round((dir.sensitivity ?? 0.5) * 100); }
  const dsv = el('ai-dir-sens-val'); if (dsv) dsv.textContent = Math.round((dir.sensitivity ?? 0.5) * 100) + '%';
  const da = el('ai-dir-autoswitch'); if (da && document.activeElement !== da) da.checked = !!dir.autoSwitch;
  // Director/clip controls are meaningless while shielded — visually dim them.
  ['ai-dir-enabled', 'ai-dir-sens', 'ai-dir-autoswitch', 'ai-clip-mode'].forEach((id) => {
    const e = el(id); if (e) e.disabled = shielded;
  });

  // Clip controls
  const cm = el('ai-clip-mode'); if (cm && document.activeElement !== cm) cm.value = clips.captureMode || 'auto';

  // Telemetry — local recording
  const tt = el('ai-telemetry-toggle');
  const tEnabled = ai.telemetry ? ai.telemetry.enabled !== false : true;
  if (tt && document.activeElement !== tt) tt.checked = tEnabled;
  const ts = el('ai-telemetry-status');
  if (ts) ts.textContent = tEnabled ? 'Recording locally — decisions saved to this PC for training.' : 'Paused — no training data is being recorded.';

  // Telemetry — cloud upload (separate opt-in; only meaningful once cloud-authed, see applyCloudStatus)
  const tut = el('ai-telemetry-upload-toggle');
  const tuEnabled = !!(ai.telemetry && ai.telemetry.uploadEnabled);
  if (tut && document.activeElement !== tut) tut.checked = tuEnabled;
  const tus = el('ai-telemetry-upload-status');
  if (tus) {
    const t = ai.telemetry || {};
    tus.textContent = !tuEnabled ? 'Not uploading — stays on this PC.'
      : t.lastUploadAt ? `Uploaded ${t.lastUploadCount || 0} records so far · last synced ${Math.max(0, Math.round((Date.now() - t.lastUploadAt) / 60000))}m ago`
      : 'Upload enabled — waiting for the next sync.';
  }
  // cloud_status is only requested at boot + on visiting Settings — request it once here too so the
  // upload toggle's disabled state isn't stale if this page renders first.
  if (!window._aiCloudStatusRequested) { window._aiCloudStatusRequested = true; if (typeof cloudRequestStatus === 'function') cloudRequestStatus(); }
}

el('ai-shield-toggle')?.addEventListener('click', () => {
  send('set_ai_shield', { on: !(currentState.ai && currentState.ai.shield) });
});
el('ai-dir-enabled')?.addEventListener('change', function () { send('set_director', { enabled: this.checked }); });
el('ai-dir-autoswitch')?.addEventListener('change', function () { send('set_director', { autoSwitch: this.checked }); });
el('ai-dir-sens')?.addEventListener('input', function () {
  const v = el('ai-dir-sens-val'); if (v) v.textContent = this.value + '%';
});
el('ai-dir-sens')?.addEventListener('change', function () { send('set_director', { sensitivity: Number(this.value) / 100 }); });
el('ai-clip-mode')?.addEventListener('change', function () { send('set_clips', { captureMode: this.value }); });
el('ai-telemetry-toggle')?.addEventListener('change', function () { send('set_telemetry', { enabled: this.checked }); });
el('ai-telemetry-upload-toggle')?.addEventListener('change', function () { send('set_telemetry_upload', { enabled: this.checked }); });
el('ai-open-director')?.addEventListener('click', (e) => {
  e.preventDefault();
  document.querySelector('[data-tab="produccion"]')?.click();
  if (typeof window._pdShow === 'function') window._pdShow('director');
});

el('select-montage-edit')?.addEventListener('change', () => {
  if (currentState.clips) renderPlaylistPane(currentState.clips);
});

el('input-replay-folder')?.addEventListener('change', function() {
  send('set_clips', { replayFolder: this.value.trim() });
});
document.querySelectorAll('#clip-mode-seg .seg-btn').forEach((b) => {
  b.addEventListener('click', () => send('set_clips', { captureMode: b.dataset.mode }));
});
el('check-auto-montage')?.addEventListener('change', function() {
  send('set_clips', { autoMontage: this.checked });
});
['goal', 'ace', 'clutch', 'save', 'demo', 'shot'].forEach((type) => {
  el(`check-capture-${type}`)?.addEventListener('change', function() {
    send('set_clips', { captureRules: { [type]: this.checked } });
  });
});
el('btn-clip-capture')?.addEventListener('click', () => {
  const p = currentState.director?.primary;
  send('clip_capture_manual', {
    player: p?.name || '',
    label: p ? `Manual — ${p.name}` : 'Manual clip',
    reason: 'Producer manual capture'
  });
});
// ── Notification center (bell) ─────────────────────────────────────────────
// Central in-app notification store. Toasts and Twitch activity feed into the bell so
// the producer has one persistent history with unread tracking, next to the profile icon.
const NOTIF_KEY = 'ne_notifications_v1';
const NOTIF_MAX = 50;
const NOTIF_LEVEL_COLORS = { info: '#7c5cff', success: '#22c55e', warning: '#f59e0b', error: '#ef4444' };
let _notifs = [];
let _notifUnread = 0;
let _notifOpen = false;

function _loadNotifs() {
  try {
    const raw = localStorage.getItem(NOTIF_KEY);
    if (raw) { const o = JSON.parse(raw); if (Array.isArray(o)) _notifs = o; }
  } catch (_) {}
  _notifUnread = _notifs.filter(n => !n.read).length;
}
function _saveNotifs() {
  try { localStorage.setItem(NOTIF_KEY, JSON.stringify(_notifs.slice(0, NOTIF_MAX))); } catch (_) {}
}
function _notifLevelFromColor(color) {
  const c = (color || '').toLowerCase();
  if (/c53030|f56565|ef4444|ff3b30|dc2626|e74c3c|red/.test(c)) return 'error';
  if (/f59e0b|fbbf24|fb923c|f0ad4e|ffd23f|orange|amber|warn/.test(c)) return 'warning';
  if (/22c55e|4ade80|10b981|86efac|34d399|2ecc71|green/.test(c)) return 'success';
  return 'info';
}
function _notifRelTime(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

// Public: add a notification. `message` text, `color` optional (a toast's hex), opts {level,title}.
function addNotification(message, color, opts) {
  opts = opts || {};
  const msg = String(message == null ? '' : message);
  const title = opts.title ? String(opts.title) : '';
  if (!msg && !title) return null;
  // Collapse rapid duplicates (e.g. a toast that fires repeatedly) into one entry.
  const last = _notifs[0];
  if (last && last.message === msg && last.title === title && (Date.now() - last.time) < 3000) return last;
  const level = opts.level || _notifLevelFromColor(color);
  const n = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    message: msg, title, level,
    color: color || NOTIF_LEVEL_COLORS[level],
    time: Date.now(), read: false
  };
  _notifs.unshift(n);
  if (_notifs.length > NOTIF_MAX) _notifs.length = NOTIF_MAX;
  _notifUnread = _notifs.filter(x => !x.read).length;
  _saveNotifs();
  renderNotifBell();
  return n;
}

function renderNotifBell() {
  const badge = el('notif-badge');
  const btn = el('btn-notif');
  if (badge) {
    if (_notifUnread > 0) { badge.textContent = _notifUnread > 99 ? '99+' : String(_notifUnread); badge.style.display = 'flex'; }
    else badge.style.display = 'none';
  }
  if (btn) btn.classList.toggle('has-unread', _notifUnread > 0);
  const list = el('notif-list');
  if (!list) return;
  if (!_notifs.length) { list.innerHTML = '<div class="notif-empty">No notifications yet</div>'; return; }
  list.innerHTML = _notifs.map(n => `
    <div class="notif-item${n.read ? '' : ' unread'}" data-id="${n.id}">
      <span class="notif-dot" style="background:${n.color}"></span>
      <div class="notif-body">
        ${n.title ? `<div class="notif-title">${escapeHtml(n.title)}</div>` : ''}
        <div class="notif-msg">${escapeHtml(n.message)}</div>
        <div class="notif-time">${_notifRelTime(n.time)}</div>
      </div>
    </div>`).join('');
}

function _notifMarkAllRead() {
  let changed = false;
  _notifs.forEach(n => { if (!n.read) { n.read = true; changed = true; } });
  if (changed) { _notifUnread = 0; _saveNotifs(); renderNotifBell(); }
}
function _notifClearAll() { _notifs = []; _notifUnread = 0; _saveNotifs(); renderNotifBell(); }

function toggleNotifPanel(force) {
  const dd = el('notif-dropdown');
  if (!dd) return;
  _notifOpen = force !== undefined ? force : !_notifOpen;
  dd.style.display = _notifOpen ? '' : 'none';
  if (_notifOpen) { renderNotifBell(); _notifMarkAllRead(); }
}

el('btn-notif')?.addEventListener('click', (e) => { e.stopPropagation(); toggleNotifPanel(); });
el('notif-markread')?.addEventListener('click', (e) => { e.stopPropagation(); _notifMarkAllRead(); });
el('notif-clear')?.addEventListener('click', (e) => { e.stopPropagation(); _notifClearAll(); });
document.addEventListener('click', (e) => {
  if (_notifOpen && !el('notif-area')?.contains(e.target)) toggleNotifPanel(false);
});
_loadNotifs();
renderNotifBell();

// ── In-app notifications ───────────────────────────────────────────────────
// Every notification goes to the bell (persistent history) AND shows as a transient
// bottom-right toast via showToast (auto-dismisses; autoDismissMs respected).

// In-app confirm dialog — returns a Promise<bool>, no white OS popup.
function appConfirm(msg, okLabel, isDanger) {
  const dlg = document.getElementById('app-confirm-dlg');
  if (!dlg) return Promise.resolve(window._nativeConfirm ? window._nativeConfirm(msg) : true);
  document.getElementById('app-confirm-msg').textContent = msg || 'Are you sure?';
  const ok = document.getElementById('app-confirm-ok');
  ok.textContent = okLabel || 'Confirm';
  ok.className = 'btn btn-sm' + (isDanger !== false ? ' danger' : '');
  return new Promise((resolve) => {
    const finish = (v) => { dlg.close(); resolve(v); };
    ok.onclick = () => finish(true);
    document.getElementById('app-confirm-cancel').onclick = () => finish(false);
    dlg.oncancel = () => finish(false);
    dlg.showModal();
  });
}

// Pushing a queue set loads new teams AND silently resets the series score server-side
// (startgg_push_set → reset_series). Guard every user-initiated push: when a series is
// actually running, make the reset explicit before it happens.
function confirmQueuePush() {
  const s = (currentState && currentState.series) || {};
  const b = Number(s.blue || 0), o = Number(s.orange || 0);
  if (!b && !o) return Promise.resolve(true);
  const tn = (side, fb) => (((currentState || {}).teams || {})[side] || {}).name || fb;
  return appConfirm(
    `Load this match onto the scoreboard? The running series (${tn('blue', 'Blue')} ${b}–${o} ${tn('orange', 'Orange')}) resets to 0–0.`,
    'Load match'
  );
}

// Transient toast + notification bell. The bell keeps the permanent history; the toast is the
// immediate on-screen confirmation (success/error feedback was invisible when everything went
// bell-only). Click a toast to dismiss it early.
// Turn a raw thrown error into human, actionable copy — a bare "Failed to fetch" tells a producer
// nothing. Falls back to the original message for anything we don't have a friendlier line for.
function friendlyError(e) {
  const m = String((e && (e.message || e.error)) || e || '');
  if (/failed to fetch|networkerror|load failed|err_connection|fetch failed|ecconnrefused|econnrefused/i.test(m)) return "Couldn't reach the service — check your connection, or that the app / OBS is running.";
  if (/abort|timeout|timed out/i.test(m)) return 'That took too long — try again.';
  if (/\b401\b|unauthor/i.test(m)) return 'Not signed in — sign in and try again.';
  if (/\b403\b|forbidden/i.test(m)) return "You don't have permission for that.";
  if (/\b404\b|not found/i.test(m)) return "Couldn't find that — it may have been removed.";
  return m || 'Something went wrong.';
}
window.friendlyError = friendlyError;

function showToast(message, bg, autoDismissMs) {
  try { addNotification(message, bg); } catch (_) {}
  try {
    let stack = document.getElementById('toast-stack');
    if (!stack) { stack = document.createElement('div'); stack.id = 'toast-stack'; document.body.appendChild(stack); }
    const t = document.createElement('div');
    t.className = 'toast';
    if (bg) t.style.borderLeftColor = bg;
    t.textContent = String(message || '');
    t.addEventListener('click', () => t.remove());
    stack.appendChild(t);
    while (stack.children.length > 4) stack.removeChild(stack.firstChild);   // cap the pile-up
    const ttl = Math.max(1200, Number(autoDismissMs) || 3500);
    setTimeout(() => { t.classList.add('hide'); setTimeout(() => t.remove(), 300); }, ttl);
  } catch (_) {}
}

// Intercept native alert() → notification bell (no white popup).
window._nativeAlert = window.alert;
window.alert = function(msg) { showToast(String(msg || ''), '#ef4444'); };
