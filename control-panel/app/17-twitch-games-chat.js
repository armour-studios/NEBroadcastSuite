// Control panel, part 17 of 17: Predictions, wheel, minigames, marble race, EventSub, chat and Q&A, polling, automations, pickers, game setup.
// Built into control-panel/app.js with the other parts (scripts/build-panel-app.js): one script, one scope.

// ── Prediction countdown timer ──────────────────────────────────────────────
let _predCountdownTimer = null;

function _stopPredCountdown() {
  if (_predCountdownTimer) { clearInterval(_predCountdownTimer); _predCountdownTimer = null; }
  const el2 = el('pred-countdown');
  if (el2) el2.textContent = '';
}

function _startPredCountdown(endsAt) {
  _stopPredCountdown();
  if (!endsAt) return;
  const tick = () => {
    const remaining = Math.max(0, new Date(endsAt) - Date.now());
    const countEl = el('pred-countdown');
    if (!countEl) return;
    if (remaining === 0) {
      countEl.textContent = 'Voting ended';
      _stopPredCountdown();
    } else {
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      countEl.textContent = `${m}:${s.toString().padStart(2, '0')} remaining`;
    }
  };
  tick();
  _predCountdownTimer = setInterval(tick, 1000);
}

// ── Declare Winner (two-click confirm, no alert/confirm dialogs) ────────────
document.addEventListener('click', e => {
  const btn = e.target.closest('.pred-declare-winner-btn');
  if (!btn) return;

  if (btn.dataset.confirming) {
    btn.textContent = 'Resolving…';
    btn.disabled = true;
    fetch('http://127.0.0.1:3000/api/twitch/prediction/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcomeId: btn.dataset.outcomeId })
    })
    .then(r => r.json())
    .then(data => {
      if (data.error) {
        btn.textContent = '✗ ' + data.error;
        btn.disabled = false;
        delete btn.dataset.confirming;
        setTimeout(() => { btn.textContent = 'Declare Winner'; }, 3000);
      }
      // On success the WS full_state update clears the display automatically
    })
    .catch(() => {
      btn.textContent = '✗ Error';
      btn.disabled = false;
      delete btn.dataset.confirming;
      setTimeout(() => { btn.textContent = 'Declare Winner'; }, 2000);
    });
  } else {
    // First click — show inline confirmation
    const title = btn.dataset.outcomeTitle || 'this outcome';
    btn.dataset.confirming = '1';
    const orig = btn.textContent;
    btn.textContent = `"${title}" wins — confirm?`;
    btn.style.background = '#22c55e';
    btn.style.color = '#000';
    setTimeout(() => {
      if (btn.dataset.confirming) {
        delete btn.dataset.confirming;
        btn.textContent = orig;
        btn.style.background = '';
        btn.style.color = '';
      }
    }, 4000);
  }
});

// ── Cancel prediction (two-click confirm) ───────────────────────────────────
el('btn-cancel-prediction')?.addEventListener('click', function() {
  const btn = this;
  if (btn.dataset.confirming) {
    btn.textContent = 'Cancelling…';
    btn.disabled = true;
    fetch('http://127.0.0.1:3000/api/twitch/prediction/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    .then(r => r.json())
    .then(data => {
      if (data.error) {
        btn.textContent = '✗ ' + data.error;
        btn.disabled = false;
        delete btn.dataset.confirming;
        setTimeout(() => { btn.textContent = 'Cancel Prediction'; btn.style.cssText = ''; }, 3000);
      }
      // On success the WS update will hide the panel
    })
    .catch(() => {
      btn.textContent = '✗ Error';
      btn.disabled = false;
      delete btn.dataset.confirming;
      setTimeout(() => { btn.textContent = 'Cancel Prediction'; btn.style.cssText = ''; }, 2000);
    });
  } else {
    btn.dataset.confirming = '1';
    btn.textContent = 'Confirm cancel?';
    btn.style.background = 'rgba(239,68,68,0.2)';
    btn.style.color = '#ef4444';
    btn.style.border = '1px solid rgba(239,68,68,0.4)';
    setTimeout(() => {
      if (btn.dataset.confirming) {
        delete btn.dataset.confirming;
        btn.textContent = 'Cancel Prediction';
        btn.style.cssText = '';
      }
    }, 4000);
  }
});

el('btn-spin-wheel')?.addEventListener('click', () => {
  if (!currentState.twitch?.wheel?.participants || currentState.twitch.wheel.participants.length === 0) {
    showToast('No participants yet — wait for followers/subscribers or use chat integration.', '#f59e0b');
    return;
  }

  appConfirm(`Spin wheel with ${currentState.twitch.wheel.participants.length} participants?`, 'Spin', false).then(ok => {
    if (!ok) return;
    fetch('http://127.0.0.1:3000/api/twitch/wheel/spin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    .then(r => r.json())
    .then(data => {
      if (data.error) {
        showToast('Error: ' + data.error, '#ef4444');
      } else {
        showToast('Spinning!', '#22c55e');
      }
    })
    .catch(e => showToast(friendlyError(e), '#ef4444'));
  });
});

el('btn-clear-wheel')?.addEventListener('click', () => {
  appConfirm('Clear all participants from wheel?', 'Clear').then(ok => {
    if (!ok) return;
    fetch('http://127.0.0.1:3000/api/twitch/wheel/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    .then(r => r.json())
    .then(data => {
      if (data.error) {
        showToast('Error: ' + data.error, '#ef4444');
      } else {
        showToast('Participants cleared!', '#22c55e');
      }
    })
    .catch(e => showToast(friendlyError(e), '#ef4444'));
  });
});

// Mini-game auto-start settings
el('minigame-auto-start')?.addEventListener('change', function() {
  fetch('http://127.0.0.1:3000/api/twitch/minigame/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: this.checked })
  })
  .then(r => r.json())
  .then(data => {
    if (data.error) console.error('Settings error:', data.error);
  })
  .catch(e => console.error('Error:', e.message));
});

el('minigame-auto-type')?.addEventListener('change', function() {
  fetch('http://127.0.0.1:3000/api/twitch/minigame/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ breakScreenGameType: this.value })
  })
  .then(r => r.json())
  .catch(e => console.error('Error:', e.message));
});

// ── Auto-prediction settings ────────────────────────────────────────────────
el('btn-save-pred-settings')?.addEventListener('click', () => {
  const autoCreate = el('pred-auto-create')?.checked ?? false;
  const template   = el('pred-auto-template')?.value || 'teams';
  const cooldown   = parseMmss(el('pred-auto-cooldown')?.value) * 1000; // MM:SS → ms
  const btn = el('btn-save-pred-settings');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  fetch('http://127.0.0.1:3000/api/twitch/prediction/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ autoCreate, template, cooldown })
  })
  .then(r => r.json())
  .then(d => {
    btn.textContent = d.error ? '✗ Error' : '✓ Saved';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
  })
  .catch(() => { btn.textContent = '✗ Failed'; btn.disabled = false; });
});

// ── Prediction overlay display settings ─────────────────────────────────────
function updatePredDisplayLabels() {
  const isLoop = el('pred-display-loop')?.checked;
  const loopLabel  = el('pred-display-loop-label');
  const constLabel = el('pred-display-const-label');
  const durRow     = el('pred-loop-duration-row');
  if (loopLabel)  loopLabel.style.borderColor  = isLoop  ? '#9146ff' : 'rgba(255,255,255,0.12)';
  if (constLabel) constLabel.style.borderColor = !isLoop ? '#9146ff' : 'rgba(255,255,255,0.12)';
  if (durRow)     durRow.style.display          = isLoop  ? 'flex'   : 'none';
}

document.querySelectorAll('input[name="pred-display-mode"]').forEach(r =>
  r.addEventListener('change', updatePredDisplayLabels)
);

el('btn-save-pred-display')?.addEventListener('click', () => {
  const isLoop   = el('pred-display-loop')?.checked;
  const loopSecs = isLoop ? Math.max(5, parseInt(el('pred-loop-secs')?.value || '30', 10)) : 0;
  const hideSecs = Math.max(1, parseInt(el('pred-hide-secs')?.value || '8', 10));
  const btn = el('btn-save-pred-display');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  fetch('http://127.0.0.1:3000/api/twitch/prediction/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ overlayLoop: loopSecs, overlayHide: hideSecs })
  })
  .then(r => r.json())
  .then(d => {
    btn.textContent = d.error ? '✗ Error' : '✓ Saved';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
  })
  .catch(() => { btn.textContent = '✗ Failed'; btn.disabled = false; });
});

// Show / hide the prediction card on the overlay during a game (force override; the prediction keeps running).
function setPredOverlayHidden(hidden) {
  fetch('http://127.0.0.1:3000/api/twitch/prediction/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ overlayHidden: hidden })
  }).catch(() => {});
}
el('btn-pred-show')?.addEventListener('click', () => setPredOverlayHidden(false));
el('btn-pred-hide')?.addEventListener('click', () => setPredOverlayHidden(true));
// Auto-hide the prediction card while a Rocket League goal replay is on screen.
el('pred-hide-replay')?.addEventListener('change', function () {
  fetch('http://127.0.0.1:3000/api/twitch/prediction/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hideInReplay: this.checked })
  }).catch(() => {});
});

// ── Wheel prize list UI ─────────────────────────────────────────────────────
let wheelPrizes = [];

function renderWheelPrizes() {
  const list = el('wheel-prizes-list');
  if (!list) return;
  if (wheelPrizes.length === 0) {
    list.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:4px 0;">No prizes added yet.</div>';
    return;
  }
  list.innerHTML = wheelPrizes.map((p, i) => `
    <div style="display:flex;align-items:center;gap:6px;padding:5px 8px;background:rgba(0,0,0,0.2);border-radius:4px;">
      <span style="width:14px;height:14px;border-radius:50%;background:${p.color};flex-shrink:0;display:inline-block;"></span>
      <span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.name}</span>
      <span style="font-size:10px;color:var(--muted);flex-shrink:0;">&#xD7;${p.weight || 1}</span>
      <button class="btn btn-ghost btn-sm" style="padding:2px 6px;font-size:11px;flex-shrink:0;color:#ef4444;" data-remove-prize="${i}" title="Remove">&#x2715;</button>
    </div>
  `).join('');
  list.querySelectorAll('[data-remove-prize]').forEach(rmBtn => {
    rmBtn.addEventListener('click', () => {
      wheelPrizes.splice(parseInt(rmBtn.dataset.removePrize, 10), 1);
      renderWheelPrizes();
    });
  });
}

el('btn-wheel-add-prize')?.addEventListener('click', () => {
  const name   = el('wheel-new-prize-name')?.value.trim();
  const color  = el('wheel-new-prize-color')?.value || '#6441a5';
  const weight = parseInt(el('wheel-new-prize-weight')?.value || '1', 10);
  if (!name) return;
  wheelPrizes.push({ name, color, weight: isNaN(weight) || weight < 1 ? 1 : weight });
  renderWheelPrizes();
  if (el('wheel-new-prize-name')) el('wheel-new-prize-name').value = '';
});

el('btn-save-wheel-settings')?.addEventListener('click', () => {
  const entryMethod = el('wheel-entry-method')?.value || 'chat';
  const duration    = parseInt(el('wheel-spin-duration')?.value || '8', 10) * 1000; // UI seconds → ms
  const btn = el('btn-save-wheel-settings');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  fetch('http://127.0.0.1:3000/api/twitch/wheel/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prizes: wheelPrizes, entryMethod, duration })
  })
  .then(r => r.json())
  .then(d => {
    btn.textContent = d.error ? '✗ Error' : '✓ Saved';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
  })
  .catch(() => { btn.textContent = '✗ Failed'; btn.disabled = false; });
});

// ── Minigame settings save ──────────────────────────────────────────────────
el('btn-save-minigame-settings')?.addEventListener('click', () => {
  const enabled             = el('minigame-auto-start')?.checked ?? true;
  const breakScreenGameType = el('minigame-auto-type')?.value || 'trivia';
  const defaultDuration     = parseInt(el('minigame-duration')?.value || '60', 10) * 1000; // UI seconds → ms
  const prRaw               = el('minigame-point-reward')?.value.trim();
  const pointReward         = prRaw ? (isNaN(Number(prRaw)) ? prRaw : Number(prRaw)) : null;
  const btn = el('btn-save-minigame-settings');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  fetch('http://127.0.0.1:3000/api/twitch/minigame/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled, breakScreenGameType, defaultDuration, pointReward })
  })
  .then(r => r.json())
  .then(d => {
    btn.textContent = d.error ? '✗ Error' : '✓ Saved';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
  })
  .catch(() => { btn.textContent = '✗ Failed'; btn.disabled = false; });
});

// ── Populate Twitch Games settings from state ───────────────────────────────
function populateTwitchGameSettings(twitch) {
  const ps = twitch?.predictions?.settings || {};
  if (el('pred-auto-create'))    el('pred-auto-create').checked  = !!ps.autoCreate;
  // Last auto-prediction outcome (why it did / didn't fire on the last match start/end).
  const _la = twitch?.predictions?.lastAuto;
  const _laEl = el('pred-auto-status');
  if (_laEl) {
    if (_la && _la.message) {
      const good = _la.kind === 'created' || _la.kind === 'resolved';
      _laEl.textContent = (good ? '✓ ' : _la.kind === 'skip' ? '• ' : '✗ ') + _la.message;
      _laEl.style.color = good ? '#4ade80' : _la.kind === 'skip' ? '#fbbf24' : '#f87171';
      _laEl.style.display = '';
    } else { _laEl.style.display = 'none'; }
  }
  if (el('pred-auto-template'))  el('pred-auto-template').value  = ps.template  || 'teams';
  if (el('pred-auto-cooldown'))  el('pred-auto-cooldown').value  = formatMmss(Math.round((ps.cooldown ?? 300000) / 1000));
  const loopSecs = ps.overlayLoop ?? 30;
  const isLoop = loopSecs > 0;
  if (el('pred-display-loop'))  el('pred-display-loop').checked  = isLoop;
  if (el('pred-display-const')) el('pred-display-const').checked = !isLoop;
  if (el('pred-loop-secs'))     el('pred-loop-secs').value       = isLoop ? loopSecs : 30;
  if (el('pred-hide-secs'))     el('pred-hide-secs').value       = ps.overlayHide ?? 8;
  if (el('pred-hide-replay'))   el('pred-hide-replay').checked   = !!ps.hideInReplay;
  const pill = el('pred-overlay-state');
  if (pill) { const hidden = !!ps.overlayHidden; pill.textContent = hidden ? 'Hidden' : 'Showing'; pill.className = 'stat-pill ' + (hidden ? 'bad' : 'ok'); }
  const durRow = el('pred-loop-duration-row');
  if (durRow) durRow.style.display = isLoop ? 'flex' : 'none';
  updatePredDisplayLabels();

  const ws = twitch?.wheel || {};
  if (el('wheel-entry-method'))  el('wheel-entry-method').value  = ws.settings?.entryMethod || ws.entryMethod || 'chat';
  // duration stored as ms; UI shows seconds
  if (el('wheel-spin-duration')) el('wheel-spin-duration').value = Math.round((ws.settings?.duration ?? 8000) / 1000);
  if (Array.isArray(ws.prizes)) { wheelPrizes = ws.prizes.map(p => ({ ...p })); renderWheelPrizes(); }

  const mset = twitch?.minigame?.settings || {};
  if (el('minigame-auto-start'))   el('minigame-auto-start').checked = mset.enabled !== false;
  if (el('minigame-auto-type'))    el('minigame-auto-type').value    = mset.breakScreenGameType || 'trivia';
  // defaultDuration stored as ms; UI shows seconds
  if (el('minigame-duration'))     el('minigame-duration').value     = Math.round((mset.defaultDuration ?? 60000) / 1000);
  // pointReward is a point cost number; show it in the field
  if (el('minigame-point-reward')) el('minigame-point-reward').value = mset.pointReward ? String(mset.pointReward) : '';
}

// Mini-game type selection
let selectedGameType = null;
const _mgSetupPanels = ['trivia-setup','vote-setup','spin-setup','number-guess-setup','fastest-setup','score-pred-setup'];

document.querySelectorAll('.game-type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    selectedGameType = btn.dataset.type;
    document.querySelectorAll('.game-type-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _mgSetupPanels.forEach(id => { const d = el(id); if (d) d.style.display = 'none'; });
    const panelMap = {
      trivia: 'trivia-setup', prediction: 'vote-setup', vote: 'vote-setup',
      spin: 'spin-setup', number_guess: 'number-guess-setup',
      fastest_finger: 'fastest-setup', score_prediction: 'score-pred-setup'
    };
    const pid = panelMap[selectedGameType];
    if (pid) { const p = el(pid); if (p) p.style.display = 'block'; }
  });
});

el('btn-start-minigame')?.addEventListener('click', () => {
  if (!selectedGameType) { showToast('Select a game type first', '#ef4444'); return; }

  const duration = parseInt(el('minigame-duration-override')?.value || '60') || 60;
  let gameData = { type: selectedGameType, duration };

  if (selectedGameType === 'trivia') {
    const q = el('trivia-question')?.value?.trim();
    const answers = [el('trivia-a'),el('trivia-b'),el('trivia-c'),el('trivia-d')]
      .map(e => e?.value?.trim()).filter(Boolean);
    if (!q || answers.length < 2) { showToast('Enter question and at least 2 answers', '#ef4444'); return; }
    gameData.question = q;
    gameData.answers = answers;
    gameData.correctAnswerIndex = parseInt(el('trivia-correct')?.value || '0');
  } else if (selectedGameType === 'prediction' || selectedGameType === 'vote') {
    const q = el('vote-question')?.value?.trim();
    const options = [el('vote-opt1'),el('vote-opt2'),el('vote-opt3'),el('vote-opt4')]
      .map(e => e?.value?.trim()).filter(Boolean);
    if (!q || options.length < 2) { showToast('Enter question and at least 2 options', '#ef4444'); return; }
    gameData.question = q;
    gameData.options = options;
  } else if (selectedGameType === 'spin') {
    const prizes = (el('spin-prizes')?.value || '').split('\n').map(p => p.trim()).filter(Boolean);
    if (prizes.length < 1) prizes.push('Prize', 'Runner-up');
    gameData.prizes = prizes.map(p => ({ name: p }));
  } else if (selectedGameType === 'number_guess') {
    const q = el('ng-question')?.value?.trim();
    const t = el('ng-target')?.value?.trim();
    if (!q) { showToast('Enter a question for the number guess', '#ef4444'); return; }
    if (t === '' || t === undefined) { showToast('Enter the target number', '#ef4444'); return; }
    gameData.question = q;
    gameData.targetNumber = Number(t);
  } else if (selectedGameType === 'fastest_finger') {
    const kw = el('ff-keyword')?.value?.trim();
    if (!kw) { showToast('Enter the keyword chat needs to type', '#ef4444'); return; }
    gameData.keyword = kw;
  } else if (selectedGameType === 'score_prediction') {
    gameData.question = el('sp-question')?.value?.trim() || 'What will the series score be?';
    gameData.teamA = el('sp-team-a')?.value?.trim() || 'Team A';
    gameData.teamB = el('sp-team-b')?.value?.trim() || 'Team B';
    gameData.maxGames = parseInt(el('sp-max-games')?.value || '5');
  }

  fetch('http://127.0.0.1:3000/api/twitch/minigame/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(gameData)
  })
  .then(r => r.json())
  .then(data => {
    if (data.error) showToast('Error: ' + data.error, '#ef4444');
    else showToast('Game started! Chat announcement sent.', '#4ade80');
  })
  .catch(e => showToast(friendlyError(e), '#ef4444'));
});

el('btn-minigame-end')?.addEventListener('click', () => {
  const game = currentState?.twitch?.minigame?.current;
  let body = {};
  if (game?.type === 'score_prediction') {
    const a = parseInt(el('mg-actual-a')?.value ?? '-1');
    const b = parseInt(el('mg-actual-b')?.value ?? '-1');
    if (a < 0 || b < 0) { showToast('Enter the actual score A–B first', '#ef4444'); return; }
    body.actualScore = [a, b];
  }
  fetch('http://127.0.0.1:3000/api/twitch/minigame/finalize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  .then(r => r.json())
  .then(d => { if (d.error) showToast('End game: ' + d.error, '#ef4444'); })
  .catch(e => showToast('End game failed: ' + e.message, '#ef4444'));
});

el('btn-minigame-cancel')?.addEventListener('click', () => {
  fetch('http://127.0.0.1:3000/api/twitch/minigame/cancel', { method: 'POST' })
    .then(r => r.json())
    .then(d => { if (d.error) showToast('Cancel game: ' + d.error, '#ef4444'); })
    .catch(e => showToast('Cancel game failed: ' + e.message, '#ef4444'));
});

// ── Marble Race — cross-platform chat entry game (Twitch+Kick+YouTube, "!play" or auto-enter) ──
el('btn-start-marblerace')?.addEventListener('click', () => {
  const customViewers = (el('mr-custom-viewers')?.value || '')
    .split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  const body = {
    entryWindowSec: parseInt(el('mr-entry-window')?.value, 10) || 30,
    autoEnterViewers: !!el('mr-auto-enter')?.checked,
    customViewers
  };
  fetch('http://127.0.0.1:3000/api/marblerace/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
    .then(r => r.json())
    .then(data => {
      if (data.error) showToast('Error: ' + data.error, '#ef4444');
      else showToast('Entries are open!', '#4ade80');
    })
    .catch(e => showToast(friendlyError(e), '#ef4444'));
});
el('btn-cancel-marblerace')?.addEventListener('click', () => {
  fetch('http://127.0.0.1:3000/api/marblerace/cancel', { method: 'POST' })
    .then(r => r.json())
    .then(d => { if (d.error) showToast('Cancel round: ' + d.error, '#ef4444'); })
    .catch(e => showToast('Cancel round failed: ' + e.message, '#ef4444'));
});
function renderMarbleRaceStatus(mr) {
  const textEl = el('mr-status-text'), detailEl = el('mr-status-detail');
  if (!textEl || !mr) return;
  const labels = { idle: 'Idle — no round running', entry: 'Entries open', locked: 'Racing…', finished: 'Finished' };
  textEl.textContent = labels[mr.status] || mr.status;
  if (detailEl) {
    if (mr.status === 'entry') {
      const remaining = Math.max(0, Math.round(((mr.entryEndsAt || 0) - Date.now()) / 1000));
      detailEl.textContent = (mr.participants || []).length + ' entered — closes in ' + remaining + 's';
    } else if (mr.status === 'finished' && mr.result) {
      const w = mr.result.winnerParticipant;
      detailEl.textContent = w ? (w.username + ' won!') : 'Nobody entered.';
      if (mr.droppedCount) detailEl.textContent += ' (' + mr.droppedCount + ' entrant(s) dropped for exceeding the cap)';
    } else {
      detailEl.textContent = '';
    }
  }
}

connect();

// (Stats + Analytics domains live in stats-analytics.js)

// ─── EventSub Real-Time Events ──────────────────────────────────────────────
el('btn-eventsub-subscribe')?.addEventListener('click', async () => {
  if (!state.twitch?.channelId) {
    showToast('Please connect to Twitch first', '#f59e0b');
    return;
  }

  try {
    const res = await fetch('http://127.0.0.1:3000/api/twitch/eventsub/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: state.twitch.channelId
      })
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Subscription failed');
    }

    const data = await res.json();
    showToast(`EventSub subscribed — ${data.subscriptions.filter(s => s.success).length} events enabled.`, '#22c55e');
    updateEventSubStatus();
  } catch (err) {
    console.error('[EventSub]', err);
    showToast('Error subscribing to events: ' + err.message, '#ef4444');
  }
});

el('btn-eventsub-status')?.addEventListener('click', updateEventSubStatus);

async function updateEventSubStatus() {
  try {
    const res = await fetch('http://127.0.0.1:3000/api/twitch/eventsub/status');
    if (!res.ok) throw new Error('Failed to fetch status');

    const status = await res.json();
    const costEl = el('eventsub-cost');
    const statusPanel = el('eventsub-status-panel');
    const listEl = el('eventsub-subscriptions-list');

    if (costEl) costEl.textContent = status.totalCost;

    if (statusPanel && listEl) {
      statusPanel.style.display = 'block';
      let html = '';
      for (const [eventType, sub] of Object.entries(status.subscriptions)) {
        html += `<div style="margin-bottom:6px; padding:6px; background:rgba(0,0,0,0.2); border-radius:3px;">
          <div style="font-size:11px; color:#aaa;">${eventType}</div>
          <div style="font-size:10px; color:#666;">ID: ${sub.id?.substring(0, 12)}...</div>
          <div style="font-size:10px; color:#666;">Status: ${sub.status}</div>
        </div>`;
      }
      listEl.innerHTML = html || '<div style="color:#666;">No active subscriptions</div>';
    }
  } catch (err) {
    console.error('[EventSub Status]', err);
    showToast('Error fetching status: ' + err.message, '#ef4444');
  }
}

// Update EventSub status on Twitch connect
window.addEventListener('message', (e) => {
  if (e.data.type === 'twitch_connected') {
    setTimeout(updateEventSubStatus, 1000);
  }
});

// ─── Right Rail Chat & Activity ─────────────────────────────────────────────

// Chat messages storage
const chatMessages = [];
const maxChatMessages = 100;

// Function to add message to chat
// Platform dot colors for the multichat feed (panel-only — the on-stream lower
// third is deliberately platform-unbranded).
const CHAT_PLATFORM_DOT = { twitch: '#9146ff', youtube: '#ff4d4d', kick: '#53fc18', discord: '#5865f2' };
let _chatFilter = (() => { try { return localStorage.getItem('ne_chat_filter') || 'all'; } catch { return 'all'; } })();

function addChatMessage(username, message, color = '', platform = 'twitch') {
  const chatEl = el('twitch-chat');
  if (!chatEl) return;

  // Remove the placeholder if still present
  const placeholder = chatEl.querySelector('[data-placeholder]');
  if (placeholder) placeholder.remove();

  chatMessages.push({ username, message, timestamp: new Date() });
  if (chatMessages.length > maxChatMessages) {
    chatMessages.shift();
    if (chatEl.firstChild) chatEl.removeChild(chatEl.firstChild);
  }

  const nameColor = color || '#9146ff';
  const dot = CHAT_PLATFORM_DOT[platform] || '#8b93a7';
  const msgEl = document.createElement('div');
  msgEl.style.cssText = 'padding:5px 6px; border-bottom:1px solid rgba(255,255,255,0.04); font-size:12px; word-wrap:break-word; line-height:1.4; cursor:pointer; border-radius:4px; border-left:2px solid transparent;';
  msgEl.innerHTML = `<span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:${dot}; margin-right:5px; vertical-align:1px;" title="${esc(platform)}"></span>`
    + `<span style="color:${nameColor}; font-weight:700;">${escapeHtml(username)}</span><span style="color:rgba(255,255,255,0.4);">: </span><span style="color:#ddd;">${escapeHtml(message)}</span>`;
  // Multichat click-to-feature: clicking a row puts it on stream as a lower third
  // (overlay/chat-highlight.html); clicking the featured row again clears it.
  msgEl.dataset.chatUser = username;
  msgEl.dataset.chatText = message;
  msgEl.dataset.chatPlatform = platform;
  msgEl.title = 'Feature this message on stream';
  if (_chatFilter !== 'all' && platform !== _chatFilter) msgEl.style.display = 'none';
  // Hover affordance: grab a chat message into the Q&A queue instead of featuring it now.
  const qBtn = document.createElement('button');
  qBtn.type = 'button';
  qBtn.className = 'btn btn-ghost btn-sm';
  qBtn.textContent = '+Q';
  qBtn.title = 'Send to the Q&A queue';
  qBtn.style.cssText = 'float:right; margin-left:6px; padding:0 5px; font-size:10px; line-height:15px; opacity:0; transition:opacity .12s;';
  qBtn.addEventListener('click', (e) => {
    e.stopPropagation();   // the row itself features the message — this must not do both
    send('add_question', { source: platform, user: username, text: message, origin: 'chat' });
    qBtn.textContent = 'Queued';
    setTimeout(() => { qBtn.textContent = '+Q'; }, 1400);
  });
  msgEl.insertBefore(qBtn, msgEl.firstChild);

  msgEl.addEventListener('mouseenter', () => { qBtn.style.opacity = '1'; if (!msgEl.dataset.featured) msgEl.style.background = 'rgba(255,255,255,0.06)'; });
  msgEl.addEventListener('mouseleave', () => { qBtn.style.opacity = '0'; if (!msgEl.dataset.featured) msgEl.style.background = ''; });
  msgEl.addEventListener('click', () => featureChatMessage({ user: username, text: message, color, platform }));

  chatEl.appendChild(msgEl);
  chatEl.scrollTop = chatEl.scrollHeight;
}

// ── Multichat platform filter chips (All / Twitch / YouTube) ──
function applyChatFilter() {
  const chatEl = el('twitch-chat');
  if (chatEl) {
    chatEl.querySelectorAll('[data-chat-platform]').forEach((row) => {
      row.style.display = (_chatFilter === 'all' || row.dataset.chatPlatform === _chatFilter) ? '' : 'none';
    });
    chatEl.scrollTop = chatEl.scrollHeight;
  }
  document.querySelectorAll('#chat-filter-chips [data-cf]').forEach((b) => {
    const on = b.dataset.cf === _chatFilter;
    b.style.background = on ? 'rgba(124,92,255,0.25)' : '';
    b.style.color = on ? '#c4b5fd' : '';
  });
}
document.querySelectorAll('#chat-filter-chips [data-cf]').forEach((b) => {
  b.addEventListener('click', () => {
    _chatFilter = b.dataset.cf;
    try { localStorage.setItem('ne_chat_filter', _chatFilter); } catch {}
    applyChatFilter();
  });
});
applyChatFilter();

// ── Chat sources config popover (Kick channel + Discord bot/channel) ──
el('chat-sources-btn')?.addEventListener('click', () => {
  const p = el('chat-sources-panel'); if (!p) return;
  p.style.display = p.style.display === 'none' ? '' : 'none';
});
el('mc-close')?.addEventListener('click', () => { const p = el('chat-sources-panel'); if (p) p.style.display = 'none'; });
el('mc-save')?.addEventListener('click', () => {
  const payload = {
    kickChannel: (el('mc-kick-channel')?.value || '').trim(),
    discordChannelId: (el('mc-discord-channel')?.value || '').trim()
  };
  // Only send the token when the field holds a real value (not the •••• masked placeholder).
  const tok = (el('mc-discord-token')?.value || '');
  if (tok && tok !== '•••') payload.discordBotToken = tok;
  send('set_multichat_settings', payload);
  const p = el('chat-sources-panel'); if (p) p.style.display = 'none';
});
// Reflect saved config + live connection state (token itself never leaves the server).
function renderMultichatConfig(data) {
  const mc = data.multichat || {};
  const kick = el('mc-kick-channel'), dch = el('mc-discord-channel'), tok = el('mc-discord-token');
  if (kick && document.activeElement !== kick) kick.value = mc.kickChannel || '';
  if (dch && document.activeElement !== dch) dch.value = mc.discordChannelId || '';
  if (tok && document.activeElement !== tok && !tok.value && mc.hasDiscordToken) tok.value = '•••';
  const kb = el('kick-conn-badge'); if (kb) kb.style.display = mc.kickConnected ? '' : 'none';
  const db = el('discord-conn-badge'); if (db) db.style.display = mc.discordConnected ? '' : 'none';
}

// ── Multichat → stream: feature / clear a chat message lower third ──
function featureChatMessage(m) {
  const cur = currentState.chatHighlight;
  if (cur && cur.visible && cur.user === m.user && cur.text === m.text) {
    send('set_chat_highlight', { visible: false });   // same row again = take it down
    return;
  }
  const dur = parseInt(el('chat-feature-dur')?.value, 10);
  send('set_chat_highlight', {
    visible: true, platform: m.platform || 'twitch',
    user: m.user, text: m.text, color: m.color || '',
    duration: isNaN(dur) ? 30 : dur
  });
}
el('chat-feature-clear')?.addEventListener('click', () => send('set_chat_highlight', { visible: false }));
el('chat-feature-dur')?.addEventListener('change', function () { try { localStorage.setItem('ne_chat_feature_dur', this.value); } catch {} });
try { const v = localStorage.getItem('ne_chat_feature_dur'); if (v !== null && el('chat-feature-dur')) el('chat-feature-dur').value = v; } catch {}

// Reflect the live featured message in the rail: status bar + highlighted feed row.
function renderChatHighlight(data) {
  const ch = data.chatHighlight || {};
  const status = el('chat-feature-status');
  const clearBtn = el('chat-feature-clear');
  if (status) {
    status.textContent = ch.visible
      ? `ON STREAM — ${ch.user}: ${ch.text}`
      : 'Click a message to feature it on stream.';
    status.style.color = ch.visible ? '#4ade80' : '';
  }
  if (clearBtn) clearBtn.style.display = ch.visible ? '' : 'none';
  const chatEl = el('twitch-chat');
  if (chatEl) {
    chatEl.querySelectorAll('[data-chat-user]').forEach((row) => {
      const on = !!ch.visible && row.dataset.chatUser === ch.user && row.dataset.chatText === ch.text;
      if (on) { row.dataset.featured = '1'; row.style.background = 'rgba(74,222,128,0.10)'; row.style.borderLeft = '2px solid #4ade80'; }
      else { delete row.dataset.featured; row.style.background = ''; row.style.borderLeft = '2px solid transparent'; }
    });
  }
}

// ─── Q&A mailbag ────────────────────────────────────────────────────────────
// The queue itself lives on the server (state.questions, library tier) and is filled from a
// dedicated Discord channel, a chat keyword, the +Q button on a chat row, or the form below.
// Asking a question reuses the chat lower third — only the kicker changes (QUESTION · X).

// Fallback for the pre-first-snapshot render; the server ships the real list as questionSources.
const Q_SOURCES_FALLBACK = [
  { key: 'discord', label: 'DISCORD', dot: '#5865f2' }, { key: 'twitch', label: 'TWITCH', dot: '#9146ff' },
  { key: 'youtube', label: 'YOUTUBE', dot: '#ff4d4d' }, { key: 'kick', label: 'KICK', dot: '#53fc18' },
  { key: 'x', label: 'X', dot: '#e7e9ee' }, { key: 'instagram', label: 'INSTAGRAM', dot: '#e1306c' },
  { key: 'tiktok', label: 'TIKTOK', dot: '#25f4ee' }, { key: 'facebook', label: 'FACEBOOK', dot: '#1877f2' },
  { key: 'reddit', label: 'REDDIT', dot: '#ff4500' }, { key: 'email', label: 'EMAIL', dot: '#94a3b8' },
  { key: 'other', label: 'QUESTION', dot: '#8b93a7' },
];
const qSources = () => (currentState && currentState.questionSources) || Q_SOURCES_FALLBACK;
const qSource = (key) => qSources().find(s => s.key === key) || qSources()[qSources().length - 1];
let _qFilter = (() => { try { return localStorage.getItem('ne_q_filter') || 'new'; } catch { return 'new'; } })();
let _qSourcesFilled = false;

// Is this question the one currently on the lower third? (id isn't in chatHighlight — it
// carries only what the overlay renders — so match on the text/handle pair we put up.)
function qIsOnAir(q) {
  const ch = currentState && currentState.chatHighlight;
  return !!(ch && ch.visible && q && ch.text === q.text && ch.user === q.user);
}

function renderQuestions(data) {
  const list = el('q-list');
  if (!list) return;
  const qs = (data.questions && data.questions.list) || [];
  const settings = (data.questions && data.questions.settings) || {};

  // Source picker + settings fields (skip while the producer is typing in one).
  const sel = el('q-add-source');
  if (sel && !_qSourcesFilled) {
    sel.innerHTML = qSources().map(s => `<option value="${esc(s.key)}">${esc(s.key === 'other' ? 'Other' : s.label.charAt(0) + s.label.slice(1).toLowerCase())}</option>`).join('');
    sel.value = 'x';
    _qSourcesFilled = true;
  }
  const dch = el('q-discord-channel'); if (dch && document.activeElement !== dch) dch.value = settings.discordChannelId || '';
  const kw = el('q-keyword'); if (kw && document.activeElement !== kw) kw.value = settings.keyword || '';
  const kon = el('q-keyword-on'); if (kon) kon.checked = settings.keywordEnabled !== false;
  const dur = el('q-duration'); if (dur && document.activeElement !== dur) dur.value = String(settings.duration == null ? 30 : settings.duration);

  const shown = qs.filter(q => _qFilter === 'all' || (_qFilter === 'new' ? q.status === 'new' : q.status !== 'new'));
  // Starred first, then oldest-first so the queue reads in the order it arrived.
  shown.sort((a, b) => (b.star ? 1 : 0) - (a.star ? 1 : 0) || a.ts - b.ts);

  const onAir = qs.find(qIsOnAir);
  const status = el('q-status');
  if (status) {
    const pending = qs.filter(q => q.status === 'new').length;
    status.textContent = onAir ? `ON STREAM — ${onAir.text}` : (pending ? `${pending} waiting` : 'No questions queued.');
    status.style.color = onAir ? '#4ade80' : '';
  }
  const takedown = el('q-onair-clear'); if (takedown) takedown.style.display = onAir ? '' : 'none';

  document.querySelectorAll('#q-filter-chips [data-qf]').forEach((b) => {
    const on = b.dataset.qf === _qFilter;
    b.style.background = on ? 'rgba(124,92,255,0.25)' : '';
    b.style.color = on ? '#c4b5fd' : '';
  });

  if (!shown.length) {
    list.innerHTML = `<div data-placeholder style="color:#888; font-size:12px; text-align:center; padding:20px 10px;">`
      + (qs.length ? 'Nothing in this view.' : 'Questions appear here — pull them from Discord, capture them with a keyword, or add your own.')
      + `</div>`;
    return;
  }

  list.innerHTML = shown.map((q) => {
    const src = qSource(q.source);
    const label = (q.sourceLabel || src.label);
    const live = qIsOnAir(q);
    const answered = q.status !== 'new';
    return `<div data-qid="${esc(q.id)}" style="padding:7px 8px; margin-bottom:4px; border-radius:5px; font-size:12px; line-height:1.4;`
      + `background:${live ? 'rgba(74,222,128,0.10)' : 'rgba(255,255,255,0.03)'}; border-left:2px solid ${live ? '#4ade80' : src.dot};`
      + `${answered && !live ? 'opacity:.55;' : ''}">`
      + `<div style="display:flex; align-items:center; gap:5px; margin-bottom:3px;">`
        + `<span style="font-size:9px; font-weight:700; letter-spacing:.08em; color:${src.dot};">${esc(label)}</span>`
        + `<span style="color:#e7e9ee; font-weight:700; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(q.user || '')}</span>`
        + (q.status === 'asked' ? `<span style="font-size:9px; color:#4ade80;">ASKED</span>` : '')
        + (q.status === 'skipped' ? `<span style="font-size:9px; color:var(--muted);">SKIPPED</span>` : '')
        + `<span style="flex:1;"></span>`
        + `<button class="btn btn-ghost btn-sm" data-qact="star" title="Star" style="padding:1px 5px; font-size:11px; color:${q.star ? '#fbbf24' : 'var(--muted)'};">★</button>`
      + `</div>`
      + `<div style="color:#ddd; word-wrap:break-word;">${esc(q.text)}</div>`
      + `<div style="display:flex; gap:4px; margin-top:5px;">`
        + `<button class="btn ${live ? 'btn-ghost' : 'btn-primary'} btn-sm" data-qact="${live ? 'takedown' : 'ask'}" style="flex:1; padding:2px 8px; font-size:11px;">${live ? 'Take down' : 'Ask on stream'}</button>`
        + `<button class="btn btn-ghost btn-sm" data-qact="${answered ? 'requeue' : 'skip'}" style="padding:2px 8px; font-size:11px;">${answered ? 'Re-queue' : 'Skip'}</button>`
        + `<button class="btn btn-ghost btn-sm" data-qact="del" title="Delete" style="padding:2px 7px; font-size:11px;">✕</button>`
      + `</div></div>`;
  }).join('');
}

// One delegated handler for every row button — rows are re-rendered on each state push.
el('q-list')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-qact]');
  const row = e.target.closest('[data-qid]');
  if (!btn || !row) return;
  const id = row.dataset.qid;
  const q = ((currentState.questions && currentState.questions.list) || []).find(x => x.id === id);
  switch (btn.dataset.qact) {
    case 'ask': send('ask_question', { id }); break;
    case 'takedown': send('set_chat_highlight', { visible: false }); break;
    case 'star': send('update_question', { id, star: !(q && q.star) }); break;
    case 'skip': send('update_question', { id, status: 'skipped' }); break;
    case 'requeue': send('update_question', { id, status: 'new' }); break;
    case 'del': send('remove_question', { id }); break;
  }
});

document.querySelectorAll('#q-filter-chips [data-qf]').forEach((b) => {
  b.addEventListener('click', () => {
    _qFilter = b.dataset.qf;
    try { localStorage.setItem('ne_q_filter', _qFilter); } catch {}
    renderQuestions(currentState || {});
  });
});

// Manual entry. 'Other' reveals a free-text label so the on-air kicker can read whatever the
// question actually came off (a podcast, a forum, the venue floor).
el('q-add-source')?.addEventListener('change', function () {
  const lab = el('q-add-label'); if (lab) lab.style.display = this.value === 'other' ? '' : 'none';
});
function qAddFromForm() {
  const text = (el('q-add-text')?.value || '').trim();
  if (!text) { el('q-add-text')?.focus(); return; }
  send('add_question', {
    source: el('q-add-source')?.value || 'other',
    sourceLabel: (el('q-add-source')?.value === 'other') ? (el('q-add-label')?.value || '') : '',
    user: (el('q-add-user')?.value || '').trim(),
    text, origin: 'manual'
  });
  if (el('q-add-text')) el('q-add-text').value = '';
  if (el('q-add-user')) el('q-add-user').value = '';
  el('q-add-user')?.focus();
}
el('q-add-btn')?.addEventListener('click', qAddFromForm);
el('q-add-text')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') qAddFromForm(); });
el('q-add-user')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') el('q-add-text')?.focus(); });

el('q-onair-clear')?.addEventListener('click', () => send('set_chat_highlight', { visible: false }));
el('q-clear-asked')?.addEventListener('click', () => send('clear_questions', { scope: 'asked' }));
el('q-clear-all')?.addEventListener('click', () => {
  const n = ((currentState.questions && currentState.questions.list) || []).length;
  if (!n || confirm(`Delete all ${n} questions, answered or not? This cannot be undone.`)) send('clear_questions', { scope: 'all' });
});

// ── Question sources popover ──
el('q-settings-btn')?.addEventListener('click', () => {
  const p = el('q-settings-panel'); if (!p) return;
  p.style.display = p.style.display === 'none' ? '' : 'none';
});
el('q-settings-close')?.addEventListener('click', () => { const p = el('q-settings-panel'); if (p) p.style.display = 'none'; });
el('q-settings-save')?.addEventListener('click', () => {
  send('set_question_settings', {
    discordChannelId: (el('q-discord-channel')?.value || '').trim(),
    keyword: (el('q-keyword')?.value || '').trim(),
    keywordEnabled: !!el('q-keyword-on')?.checked,
    duration: parseInt(el('q-duration')?.value, 10) || 0
  });
  const fb = el('q-settings-fb'); if (fb) { fb.textContent = 'Saved.'; fb.style.color = '#4ade80'; }
});
// Backlog pull — the gateway only sees messages posted while we're connected.
el('q-pull-btn')?.addEventListener('click', function () {
  const fb = el('q-settings-fb');
  // Save first so a just-typed channel ID is the one we pull from.
  send('set_question_settings', { discordChannelId: (el('q-discord-channel')?.value || '').trim() });
  send('pull_discord_questions', { limit: 50 });
  this.disabled = true;
  if (fb) { fb.textContent = 'Pulling…'; fb.style.color = ''; }
  setTimeout(() => { this.disabled = false; }, 4000);
});

// Function to escape HTML
function escapeHtml(text) { return esc(text); }   // legacy alias — canonical esc() lives at the top of the file
                                                   // (old DOM-based version didn't escape quotes — unsafe in attributes)

// Activity feed items
const activityItems = [];
const maxActivityItems = 50;

// Function to add activity item
function addActivityItem(type, user, detail, icon) {
  const activityEl = el('twitch-activity');
  if (!activityEl) return;

  activityItems.push({ type, user, detail, timestamp: new Date() });
  if (activityItems.length > maxActivityItems) {
    activityEl.removeChild(activityEl.firstChild);
    activityItems.shift();
  }

  const colors = {
    'follow': '#86efac',
    'subscribe': '#4ade80',
    'raid': '#60a5fa',
    'channel_points': '#fbbf24',
    'hype_train': '#f472b6'
  };

  const itemEl = document.createElement('div');
  itemEl.style.cssText = `padding:8px; background:rgba(255,255,255,0.03); border-left:3px solid ${colors[type] || '#888'}; border-radius:2px; font-size:11px;`;
  itemEl.innerHTML = `
    <div style="color:${colors[type] || '#ccc'}; font-weight:600;">${icon} ${user}</div>
    <div style="color:#aaa; font-size:10px; margin-top:2px;">${detail}</div>
  `;

  activityEl.insertBefore(itemEl, activityEl.firstChild);

  // Mirror Twitch activity (follows/subs/raids/redemptions/hype) into the notification bell.
  try { addNotification(detail, colors[type], { title: user }); } catch (_) {}
}


// Right-rail tab switching is handled by the single qrailShowTab() handler above
// (title, panel toggle, live-section refresh, and collapse-on-reclick all live there).
// The former duplicate handler here was removed — it fought the collapse toggle.

// Twitch sub-nav: Chat | Activity | Predict.
document.querySelectorAll('#tw-subnav .ev-subnav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tw = btn.dataset.tw;
    document.querySelectorAll('#tw-subnav .ev-subnav-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.qrail-panel[data-qpanel="twitch"] .tw-sub').forEach((p) => { p.style.display = p.dataset.twpanel === tw ? '' : 'none'; });
    if (tw === 'chat') setTimeout(() => { const c = el('twitch-chat'); if (c) c.scrollTop = c.scrollHeight; }, 60);
  });
});

// ─── Stream State Polling (Viewer Count & Ad Timer) ──────────────────────────

let streamPollInterval = null;
const streamPollIntervalMs = 30 * 1000; // Poll every 30 seconds

function startStreamStatePolling() {
  if (streamPollInterval) return;

  const pollStreamState = async () => {
    if (!currentState.twitch?.connected) return;

    try {
      // Fetch stream state
      const res = await fetch('http://127.0.0.1:3000/api/twitch/stream/viewers');
      if (!res.ok) return;

      const data = await res.json();
      const viewersEl = el('tb-viewers');
      const viewersNEl = el('tb-viewers-n');

      if (viewersEl && viewersNEl) {
        try { _viewerCount = data.viewers || 0; renderViewers(); } catch (e) {}
        viewersEl.style.opacity = data.isLive ? '1' : '0.6';
      }

      // The ad chip is owned by renderAdChip() (1s ticker over stored deadlines); writing it from
      // here made it flicker between two different countdowns.
    } catch (err) {
      console.error('[Stream State]', err);
    }
  };

  // Poll immediately and then on interval
  pollStreamState();
  streamPollInterval = setInterval(pollStreamState, streamPollIntervalMs);
}

function stopStreamStatePolling() {
  if (streamPollInterval) {
    clearInterval(streamPollInterval);
    streamPollInterval = null;
  }
  const viewersEl = el('tb-viewers');
  const adTimerEl = el('tb-adtimer');
  if (viewersEl) viewersEl.style.opacity = '0.6';
  if (adTimerEl) adTimerEl.style.opacity = '0.6';
}

// Top-bar viewer count — click the chip to hide/show it (privacy), persisted.
let _viewersHidden = false, _viewerCount = 0;
try { _viewersHidden = localStorage.getItem('ne_hide_viewers') === '1'; } catch (e) {}
function renderViewers() {
  const n = el('tb-viewers-n'); if (!n) return;
  n.textContent = _viewersHidden ? '•••' : (_viewerCount || 0).toLocaleString();
}
el('tb-viewers')?.addEventListener('click', () => {
  _viewersHidden = !_viewersHidden;
  try { localStorage.setItem('ne_hide_viewers', _viewersHidden ? '1' : '0'); } catch (e) {}
  renderViewers();
});
renderViewers();

// Top-bar ad-controls dropdown — play a Twitch commercial / snooze the next ad.
function closeAdMenu() { const m = el('tb-ad-menu'); if (m) m.style.display = 'none'; }
el('tb-adtimer')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const m = el('tb-ad-menu'); if (m) m.style.display = (m.style.display === 'none' || !m.style.display) ? 'flex' : 'none';
});
document.addEventListener('click', (e) => {
  const m = el('tb-ad-menu');
  if (m && m.style.display === 'flex' && !el('tb-ad-area')?.contains(e.target)) m.style.display = 'none';
});
// Pre-flight "Go Live" checklist is hover-driven (CSS) — the checkmark icon next to the
// connection bars; no click toggle needed.
async function _adPost(url, body, okMsg, color) {
  closeAdMenu();
  try {
    const opts = { method: 'POST' };
    if (body) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
    const r = await fetch('http://127.0.0.1:3000' + url, opts);
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.success) showToast(okMsg, color, 4000);
    else {
      const msg = String(j.error || 'request failed');
      showToast(/twitch/i.test(msg) ? msg + (/not connected/i.test(msg) ? '. Connect it under Apps > Twitch.' : '') : 'Twitch: ' + msg, '#c53030', 5000);
    }
  } catch (err) { showToast('Twitch request failed: ' + err.message, '#c53030', 5000); }
}
let _adLocalTimer = null;
el('tb-ad-play')?.addEventListener('click', () => {
  if (!adsAreEnabled()) { showToast('Ads are turned off', '#c53030', 3000); closeAdMenu(); return; }
  const sel = el('tb-ad-length'); const length = parseInt(sel?.value) || 30;
  const label = (sel && sel.selectedOptions[0]) ? sel.selectedOptions[0].textContent : (length + 's');
  // Start a client-side countdown immediately so the chip updates without waiting for EventSub.
  // The EventSub twitch_ad_break handler will overwrite _adState with the accurate endsAt if it fires.
  _adState.adBreak = true;
  _adState.adBreakEndsAt = Date.now() + length * 1000;
  renderAdChip();
  if (_adLocalTimer) clearTimeout(_adLocalTimer);
  _adLocalTimer = setTimeout(() => { _adLocalTimer = null; if (_adState.adBreak && Date.now() >= _adState.adBreakEndsAt - 2000) { _adState.adBreak = false; _adState.adBreakEndsAt = 0; renderAdChip(); } }, (length + 5) * 1000);
  const target = adTarget(), on = adTargetName();
  _adPost('/api/twitch/ad/run', { length, target }, `Running a ${label} Twitch ad break${on ? ' on ' + on : ''}`, '#9147ff');
});
el('tb-ad-snooze')?.addEventListener('click', () => {
  const target = adTarget(), on = adTargetName();
  _adPost('/api/twitch/ad/snooze', target === 'org' ? { target } : null, 'Snoozed the next Twitch ad' + (on ? ' on ' + on : ''), '#4ade80');
});
// ── Our channel: ads on the organization's Twitch channel ─────────────────────
// Twitch only lets the channel's own account run or snooze its ads, so an editor producing on the
// org channel goes through the website, which holds the channel owner's permission (website
// lib/studio/twitch-ads.ts, server /api/twitch/ad/org-status). When that channel is not the one this
// app's Twitch login is on, ads default to it; the menu's "Run on" switches back.
const _orgAds = { available: false, channel: null, why: '', canSnooze: false, schedule: null, mine: '', checkedAt: 0, signedIn: false };
let _adTargetPick = '';   // '' = automatic
function orgIsOtherChannel() {
  return !!(_orgAds.available && _orgAds.channel && _orgAds.channel.login && _orgAds.channel.login.toLowerCase() !== String(_orgAds.mine || '').toLowerCase());
}
function adTarget() {
  if (_adTargetPick === 'mine' || !_orgAds.available) return 'mine';
  if (_adTargetPick === 'org') return 'org';
  return orgIsOtherChannel() || !(currentState && currentState.twitch && currentState.twitch.connected) ? 'org' : 'mine';
}
function adTargetName() {
  return adTarget() === 'org' && _orgAds.channel ? (_orgAds.channel.displayName || _orgAds.channel.login) : '';
}
function renderAdTarget() {
  const row = el('tb-ad-target-row'), sel = el('tb-ad-target'), note = el('tb-ad-org-note');
  if (row) row.style.display = orgIsOtherChannel() ? '' : 'none';
  if (sel) {
    const o = sel.querySelector('option[value="org"]');
    if (o && _orgAds.channel) o.textContent = 'Our channel (' + (_orgAds.channel.displayName || _orgAds.channel.login) + ')';
    const m = sel.querySelector('option[value="mine"]');
    if (m) m.textContent = _orgAds.mine ? 'My channel (' + _orgAds.mine + ')' : 'My channel';
    if (document.activeElement !== sel) sel.value = adTarget();
  }
  // Signed in to an org whose channel is not set up for ads yet: say what to do, in the menu.
  if (note) { note.textContent = (!_orgAds.available && _orgAds.signedIn && _orgAds.why) ? _orgAds.why : ''; note.style.display = note.textContent ? '' : 'none'; }
  const snz = el('tb-ad-snooze');
  if (snz) snz.disabled = adTarget() === 'org' && !_orgAds.canSnooze;
  // Our channel's schedule drives the chip when ads go there.
  if (adTarget() === 'org' && _orgAds.schedule) {
    _adState.nextAdAt = _orgAds.schedule.nextAdAt ? new Date(_orgAds.schedule.nextAdAt).getTime() : 0;
    _adState.prerollUntil = _orgAds.schedule.prerollFreeSeconds ? Date.now() + _orgAds.schedule.prerollFreeSeconds * 1000 : 0;
  }
}
async function refreshOrgAds(fresh) {
  try {
    const r = await fetch('http://127.0.0.1:3000/api/twitch/ad/org-status' + (fresh ? '?fresh=1' : ''));
    const d = await r.json();
    Object.assign(_orgAds, d || {}, { checkedAt: Date.now(), signedIn: !/^Sign in/.test((d && d.why) || '') });
  } catch (e) { /* app server not up yet: try again next tick */ }
  renderAdTarget();
}
el('tb-ad-target')?.addEventListener('change', function () { _adTargetPick = this.value; renderAdTarget(); });
el('tb-adtimer')?.addEventListener('click', () => { if (Date.now() - _orgAds.checkedAt > 10000) refreshOrgAds(false); });
setTimeout(() => refreshOrgAds(false), 4000);
setInterval(() => { if (!document.hidden) refreshOrgAds(false); }, 60000);

// ── Between series: a one-click ad break ──────────────────────────────────────
// When a series is decided, a small bar offers an ad break on the channel the menu targets. It is
// an offer only: nothing runs until the producer clicks (ads never auto-play), and it does not
// appear while ads are switched off.
let _seriesDoneKey = '', _seriesDoneAt = 0, _adBreakDismissed = '';
const _adLenLabel = (n) => (n < 120 ? n + 's' : (n / 60) + 'm');
function seriesDecided(d) {
  const s = (d && d.series) || {};
  const need = Math.max(1, Math.ceil((Number(d && d.bestOf) || 3) / 2));
  const b = Number(s.blue) || 0, o = Number(s.orange) || 0;
  if (Math.max(b, o) < need) return null;
  const teams = d.teams || {};
  const w = teams[b > o ? 'blue' : 'orange'] || {};
  return { key: [b, o, (teams.blue && teams.blue.name) || '', (teams.orange && teams.orange.name) || ''].join('|'), winner: w.name || '' };
}
function adBreakBar() {
  let bar = el('adbreak-bar');
  if (bar) return bar;
  bar = document.createElement('div');
  bar.id = 'adbreak-bar';
  bar.className = 'adbreak-bar';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Ad break');
  bar.hidden = true;
  bar.innerHTML = '<span class="adbreak-txt" id="adbreak-txt"></span>'
    + '<span class="adbreak-lens">' + [60, 90, 120, 180].map((n) => '<button type="button" class="adbreak-len" data-len="' + n + '">' + _adLenLabel(n) + '</button>').join('') + '</span>'
    + '<button type="button" class="adbreak-snooze" id="adbreak-snooze">Snooze</button>'
    + '<button type="button" class="adbreak-close" id="adbreak-close">Not now</button>';
  document.body.appendChild(bar);
  bar.addEventListener('click', (e) => {
    const len = e.target.closest('[data-len]');
    const target = adTarget(), on = adTargetName();
    if (len) {
      if (!adsAreEnabled()) { showToast('Ads are turned off', '#c53030', 3000); return; }
      const n = Number(len.dataset.len) || 90;
      _adState.adBreak = true; _adState.adBreakEndsAt = Date.now() + n * 1000; renderAdChip();
      _adPost('/api/twitch/ad/run', { length: n, target }, 'Running a ' + _adLenLabel(n) + ' ad break' + (on ? ' on ' + on : ''), '#9147ff');
    } else if (e.target.closest('#adbreak-snooze')) {
      _adPost('/api/twitch/ad/snooze', target === 'org' ? { target } : null, 'Snoozed the next ad' + (on ? ' on ' + on : ''), '#4ade80');
    } else if (!e.target.closest('#adbreak-close')) return;
    _adBreakDismissed = _seriesDoneKey;
    bar.hidden = true;
  });
  return bar;
}
setInterval(() => {
  const d = currentState;
  if (!d) return;
  const done = seriesDecided(d);
  if (!done) { _seriesDoneKey = ''; const b0 = el('adbreak-bar'); if (b0) b0.hidden = true; return; }
  if (done.key !== _seriesDoneKey) { _seriesDoneKey = done.key; _seriesDoneAt = Date.now(); }
  const canRun = adsAreEnabled() && (adTarget() === 'org' ? _orgAds.available : !!(d.twitch && d.twitch.connected));
  // Offered for five minutes after the series ends, unless already answered.
  const show = canRun && _adBreakDismissed !== _seriesDoneKey && Date.now() - _seriesDoneAt < 5 * 60 * 1000 && !_adState.adBreak;
  const bar = show ? adBreakBar() : el('adbreak-bar');
  if (!bar) return;
  if (show) {
    const t = el('adbreak-txt');
    if (t) t.textContent = (done.winner ? done.winner + ' take the series. ' : 'Series over. ') + 'Ad break on ' + (adTargetName() || 'your channel') + '?';
    const sz = el('adbreak-snooze'); if (sz) sz.hidden = adTarget() === 'org' && !_orgAds.canSnooze;
  }
  bar.hidden = !show;
}, 1000);

// Ads on/off — server-backed gate (state.twitch.adsEnabled). When off, runCommercial is blocked
// server-side, the Play button is disabled, and the chip shows "OFF". Synced from broadcast state.
// During the 1.2s debounce window after a toggle we read the checkbox directly so the chip
// responds instantly without waiting for the server round-trip.
function adsAreEnabled() {
  if (Date.now() - _adsToggleAt <= 1200) { const cbx = el('tb-ad-enabled'); if (cbx) return cbx.checked; }
  return !(currentState && currentState.twitch && currentState.twitch.adsEnabled === false);
}
let _adsToggleAt = 0;
el('tb-ad-enabled')?.addEventListener('change', function () {
  _adsToggleAt = Date.now();
  fetch('http://127.0.0.1:3000/api/twitch/ad/enabled', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: this.checked }) })
    .then((r) => r.json()).then((j) => { if (!j || !j.success) showToast('Ads toggle failed: ' + ((j && j.error) || 'error'), '#c53030', 4000); }).catch(() => {});
  renderAdChip();
});

// Top-bar Twitch ad chip — priority: live ad break > pre-roll free time > next-ad countdown.
// Driven off stored deadlines so a 1s ticker keeps the countdown smooth between 30s polls.
const _adState = { adBreak: false, adBreakEndsAt: 0, prerollUntil: 0, nextAdAt: 0 };
function _adFmt(s) { const m = Math.floor(s / 60); return m + ':' + (s % 60).toString().padStart(2, '0'); }
function renderAdChip() {
  const on = adsAreEnabled();
  const cbx = el('tb-ad-enabled'); if (cbx && Date.now() - _adsToggleAt > 1200) cbx.checked = on;
  const playBtn = el('tb-ad-play'); if (playBtn) { playBtn.disabled = !on; playBtn.style.opacity = on ? '' : '.5'; playBtn.style.cursor = on ? '' : 'not-allowed'; }
  const chip = el('tb-adtimer'), n = el('tb-adtimer-n'), lbl = el('tb-adtimer-lbl');
  if (!chip || !n) return;
  const now = Date.now();
  chip.classList.remove('preroll-off', 'ad-live'); chip.style.color = '';
  if (!on) { n.textContent = 'OFF'; if (lbl) lbl.textContent = 'Ads'; chip.style.opacity = '0.5'; return; }
  if (_adState.adBreak) { const rem = _adState.adBreakEndsAt ? Math.max(0, Math.ceil((_adState.adBreakEndsAt - now) / 1000)) : 0; n.textContent = rem > 0 ? _adFmt(rem) : 'LIVE'; if (lbl) lbl.textContent = 'Ad Break'; chip.classList.add('ad-live'); chip.style.opacity = '1'; return; }
  const prerollRem = Math.ceil((_adState.prerollUntil - now) / 1000);
  if (prerollRem > 0) { n.textContent = _adFmt(prerollRem); if (lbl) lbl.textContent = 'Pre-roll Off'; chip.classList.add('preroll-off'); chip.style.opacity = '1'; return; }
  const adRem = Math.ceil((_adState.nextAdAt - now) / 1000);
  if (adRem > 0) { n.textContent = _adFmt(adRem); if (lbl) lbl.textContent = 'Ad in'; chip.style.opacity = '1'; return; }
  if (_adState.prerollUntil || _adState.nextAdAt) { n.textContent = '—'; if (lbl) lbl.textContent = 'Pre-roll On'; chip.style.opacity = '0.85'; }
  else { n.textContent = '—'; if (lbl) lbl.textContent = 'AD'; chip.style.opacity = '0.6'; }
}
setInterval(renderAdChip, 1000);

// Real-time Twitch stream state (viewer count + next-ad timer in the top bar).
// Driven from the main ws.onmessage chain (a separate top-level listener bound to a
// dangling `socket` var used to crash init here and never survived a reconnect).
function onTwitchStreamState(msg) {
  const d = msg && msg.data;
  if (!d) return;

  const viewersEl = el('tb-viewers');
  const viewersNEl = el('tb-viewers-n');
  if (viewersEl && viewersNEl && d.stream) {
    _viewerCount = d.stream.viewerCount || 0;
    renderViewers();
    viewersEl.style.opacity = d.stream.isLive ? '1' : '0.6';
  }

  if (d.ads) {
    _adState.prerollUntil = Number(d.ads.prerollFreeUntil) || 0;
    _adState.nextAdAt = d.ads.nextAdAt ? new Date(d.ads.nextAdAt).getTime() : 0;
    renderAdChip();
  }
}

// ─── Twitch Chat Automations ─────────────────────────────────────────────────

async function fetchAndRenderStreamState() {
  try {
    const res = await fetch('http://127.0.0.1:3000/api/twitch/stream/viewers');
    if (!res.ok) return;
    const data = await res.json();

    const badge = el('twitch-live-badge');
    const viewers = el('twitch-viewer-count');
    const titleEl = el('twitch-stream-title');
    const gameEl = el('twitch-stream-game');

    if (badge) {
      badge.textContent = data.isLive ? 'LIVE' : 'OFFLINE';
      badge.style.background = data.isLive ? '#ef4444' : '#374151';
      badge.style.color = data.isLive ? '#fff' : '#9ca3af';
    }
    if (viewers) viewers.textContent = (data.viewers || 0).toLocaleString();
    if (titleEl) titleEl.textContent = data.title || '—';
    if (gameEl) gameEl.textContent = data.game || '—';

    // Ad countdown
    try {
      const adRes = await fetch('http://127.0.0.1:3000/api/twitch/ads/countdown');
      if (adRes.ok) {
        const adData = await adRes.json();
        const adEl = el('twitch-ad-countdown');
        const adTime = el('twitch-ad-time');
        if (adEl && adData.secondsUntilAd > 0) {
          const m = Math.floor(adData.secondsUntilAd / 60);
          const s = adData.secondsUntilAd % 60;
          if (adTime) adTime.textContent = `${m}:${s.toString().padStart(2,'0')}`;
          adEl.style.display = 'inline';
        } else if (adEl) {
          adEl.style.display = 'none';
        }
      }
    } catch (_) {}
  } catch (err) {
    console.error('[Stream State]', err);
  }
}

el('btn-twitch-refresh-stream')?.addEventListener('click', fetchAndRenderStreamState);

// Load current automation settings
async function loadChatAutomations() {
  try {
    const res = await fetch('http://127.0.0.1:3000/api/twitch/chat/status');
    if (!res.ok) return;

    const status = await res.json();
    const enabledEl = el('chat-automations-enabled');
    const followEl = el('chat-follow-msg');
    const subEl = el('chat-sub-msg');
    const raidEl = el('chat-raid-msg');

    if (enabledEl) enabledEl.checked = status.autoGreetings.enabled;
    if (followEl) followEl.value = status.autoGreetings.followMessage;
    if (subEl) subEl.value = status.autoGreetings.subscribeMessage;
    if (raidEl) raidEl.value = status.autoGreetings.raidMessage;

    updateChatStatus();
  } catch (err) {
    console.error('[Chat Load]', err);
  }
}

// Update chat connection status
async function updateChatStatus() {
  try {
    const res = await fetch('http://127.0.0.1:3000/api/twitch/chat/status');
    if (!res.ok) return;

    const status = await res.json();
    const statusEl = el('chat-status');

    if (statusEl) {
      if (status.connected) {
        statusEl.innerHTML = `<span class="live-dot" style="background:#4ade80"></span> <span style="color:#86efac;">Connected to #${status.channel}</span>`;
      } else {
        statusEl.innerHTML = `<span class="live-dot" style="background:#f56565;animation:none"></span> <span style="color:#f56565;">Not connected</span>`;
      }
    }
  } catch (err) {
    console.error('[Chat Status]', err);
  }
}

// Save automation settings
el('btn-save-automations')?.addEventListener('click', async () => {
  const enabled = el('chat-automations-enabled')?.checked || false;
  const followMessage = el('chat-follow-msg')?.value || '';
  const subscribeMessage = el('chat-sub-msg')?.value || '';
  const raidMessage = el('chat-raid-msg')?.value || '';

  try {
    const res = await fetch('http://127.0.0.1:3000/api/twitch/chat/automations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled,
        followMessage,
        subscribeMessage,
        raidMessage
      })
    });

    if (!res.ok) throw new Error('Failed to save');

    showToast('Auto-greeting settings saved!', '#22c55e');
  } catch (err) {
    showToast('Error saving settings: ' + err.message, '#ef4444');
  }
});

// Send chat message
el('btn-chat-send')?.addEventListener('click', async () => {
  const msgEl = el('chat-send-msg');
  const message = msgEl?.value?.trim();

  if (!message) {
    showToast('Please type a message', '#f59e0b');
    return;
  }

  try {
    const res = await fetch('http://127.0.0.1:3000/api/twitch/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to send');
    }

    if (msgEl) msgEl.value = '';
    console.log('[Chat] Message sent:', message);
  } catch (err) {
    showToast('Error sending message: ' + err.message, '#ef4444');
  }
});

// ── Decorate Camera Feeds → Casters / Talent section headers with leading icons ──
(function decorateCfSectionIcons() {
  const MAP = {
    'cf-panel-talent': [
      ['Talent Rooms', 'users'],
      ['LISTEN IN', 'headphones'],
    ],
  };
  Object.entries(MAP).forEach(([panelId, titles]) => {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    const heads = Array.from(panel.querySelectorAll('h3.section-title'));
    titles.forEach(([text, icon]) => {
      const h = heads.find(el => !el.dataset.icoDone && (el.textContent || '').trim().toUpperCase().startsWith(text.toUpperCase()));
      if (!h) return;
      h.dataset.icoDone = '1';
      h.classList.add('with-ico');
      h.insertAdjacentHTML('afterbegin', svgIcon(icon));
    });
  });
})();

// ── Bounded 12-hour time picker ──────────────────────────────────────────────
// Replaces a native <input type="time"> — whose spinner scroll-WRAPS forever (past 12h / 59m and
// back to the start), which the producer hit as "endless scrolling" — with hour(1-12)/minute(00-59)/
// AM-PM selects that stop at the ends. The original input is KEPT (hidden) as the value holder in
// "HH:MM" (24h), so every existing `.value` read/write still works; changing a select writes it back
// and fires a 'change' event. Call `input._btLoad()` after setting `.value` programmatically to
// refresh the selects.
window.mountBoundedTime = function mountBoundedTime(input) {
  if (!input || input.dataset.btMounted) return;
  input.dataset.btMounted = '1';
  input.type = 'hidden';
  const mk = (cls, w, html) => { const s = document.createElement('select'); s.className = 'input-select ' + cls; s.style.cssText = 'width:' + w + 'px;font-size:11px;padding:2px 4px;'; s.innerHTML = html; return s; };
  const hSel  = mk('bt-h', 52, '<option value="">Hr</option>'  + Array.from({ length: 12 }, (_, i) => `<option>${i + 1}</option>`).join(''));
  const mSel  = mk('bt-m', 58, '<option value="">Min</option>' + Array.from({ length: 60 }, (_, i) => `<option>${String(i).padStart(2, '0')}</option>`).join(''));
  const apSel = mk('bt-ap', 52, '<option>AM</option><option>PM</option>');
  const wrap = document.createElement('span'); wrap.className = 'bt-wrap'; wrap.style.cssText = 'display:inline-flex;gap:3px;align-items:center;';
  wrap.append(hSel, mSel, apSel);
  input.parentNode.insertBefore(wrap, input.nextSibling);
  const load = () => {
    const x = /^(\d{1,2}):(\d{2})/.exec(input.value || '');
    if (x) { let hh = +x[1]; apSel.value = hh >= 12 ? 'PM' : 'AM'; hSel.value = String(hh % 12 || 12); mSel.value = x[2]; }
    else { hSel.value = ''; mSel.value = ''; apSel.value = 'PM'; }
  };
  const save = () => {
    if (!hSel.value) input.value = '';
    else { let hh = parseInt(hSel.value, 10) % 12; if (apSel.value === 'PM') hh += 12; input.value = String(hh).padStart(2, '0') + ':' + (mSel.value || '00'); }
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  [hSel, mSel, apSel].forEach((s) => s.addEventListener('change', save));
  input._btLoad = load;
  load();
};
// Mount it on the schedule "add a match" time fields (leagues + graphics schedule).
['gfx-sch-ftime', 'lg-sch-time'].forEach((id) => { const i = el(id); if (i) window.mountBoundedTime(i); });

// ── Team search with logos ───────────────────────────────────────────────────
// Replaces a plain <datalist> team input (text only) with a typeahead that shows each team's LOGO
// next to its name. The input is kept as the value holder, so `.value` reads/writes and clearing
// still work; picking an item sets the name and fires change/input events.
window.mountTeamTypeahead = function mountTeamTypeahead(input) {
  if (!input || input.dataset.ttMounted) return;
  input.dataset.ttMounted = '1';
  input.removeAttribute('list');   // drop the native (logo-less) datalist
  const wrap = document.createElement('span');
  wrap.className = 'team-logo-wrap';
  wrap.style.cssText = 'display:inline-flex;position:relative;' + (input.style.flex ? 'flex:' + input.style.flex + ';' : '') + (input.style.minWidth ? 'min-width:' + input.style.minWidth + ';' : '');
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  input.style.flex = ''; input.style.minWidth = ''; input.style.width = '100%';
  const dd = document.createElement('div'); dd.className = 'team-logo-dd'; dd.style.display = 'none';
  wrap.appendChild(dd);
  const e2 = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const teams = () => {
    const seen = new Set(), out = [];
    const add = (n, logo) => { const k = (n || '').toLowerCase(); if (!n || seen.has(k)) return; seen.add(k); out.push({ name: n, logo: logo || '' }); };
    ((currentState && currentState.savedTeams) || []).forEach((t) => t && t.name && add(t.name, t.logo));
    ((currentState && currentState.startgg && currentState.startgg.eventTeams) || []).forEach((t) => t && t.name && add(t.name, t.logo));
    return out;
  };
  const render = () => {
    const q = input.value.trim();
    const list = NESearch.filter(teams(), q, (o) => [o.name], { limit: 40 }).slice(0, 40);
    if (!list.length) { dd.style.display = 'none'; return; }
    dd.innerHTML = list.map((o) => `<div class="team-logo-item" data-name="${e2(o.name)}">`
      + (o.logo ? `<img src="${e2(o.logo)}" alt="" onerror="this.style.display='none'">` : '<span class="team-logo-ph"></span>')
      + `<span>${e2(o.name)}</span></div>`).join('');
    dd.style.display = 'block';
  };
  input.addEventListener('focus', render);
  input.addEventListener('input', render);
  input.addEventListener('blur', () => setTimeout(() => { dd.style.display = 'none'; }, 180));
  dd.addEventListener('mousedown', (e) => {
    const it = e.target.closest('[data-name]'); if (!it) return;
    e.preventDefault();
    input.value = it.dataset.name; dd.style.display = 'none';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
// Schedule add-match team fields (front card + pop-out manual/team tabs) — show logos while searching.
['gfx-sch-add-a', 'gfx-sch-add-b', 'gfx-sch-fa', 'gfx-sch-fb', 'gfx-sch-team-name'].forEach((id) => { const i = el(id); if (i) window.mountTeamTypeahead(i); });

// ── Crew search dropdown ─────────────────────────────────────────────────────
// The Show Deck slots used a native <datalist>, which Chromium renders as an unstyled,
// unsorted, bold system popup that spills over the panel (and lists crew in whatever order
// the roster happens to be in). This is the same typeahead pattern as the team picker: our
// own dropdown, always A–Z, with the group colour + role so two people with similar handles
// are still tellable apart. The <input> stays the value holder so every existing
// change-handler / .value read keeps working.
window.CREW_GROUP_LABEL = { casters: 'Caster', hosts: 'Host', guests: 'Guest', observers: 'Observer', producer: 'Producer', admin: 'Tournament Admin', socials: 'Social Media' };
window.CREW_GROUP_COLOR = { casters: '#e83a8b', hosts: '#a855f7', guests: '#3b82f6', observers: '#2dd4bf', producer: '#f59e0b', admin: '#ef4444', socials: '#22c55e' };
// A–Z by the name actually shown in the field (gamertag-first, same as the desk), case- and
// number-aware so "Caster 2" sorts after "Caster 1" rather than lexically.
window.crewSortAZ = function crewSortAZ(list) {
  const disp = (c) => (c && (c.handle || c.name)) || '';
  return (list || []).slice().sort((a, b) => disp(a).localeCompare(disp(b), undefined, { sensitivity: 'base', numeric: true }));
};
window.mountCrewTypeahead = function mountCrewTypeahead(input, getCrew) {
  if (!input || input.dataset.ctMounted) return;
  input.dataset.ctMounted = '1';
  input.removeAttribute('list');          // drop the native (unstyled, unsorted) datalist
  input.setAttribute('autocomplete', 'off');
  const wrap = document.createElement('span');
  wrap.className = 'crew-ta-wrap';
  // The wrapper takes the input's place in its parent's layout, so any inline sizing has to move
  // with it — otherwise a `flex:1 1 100%` search box collapses the moment it's wrapped.
  ['flex', 'minWidth', 'maxWidth'].forEach((k) => { if (input.style[k]) { wrap.style[k] = input.style[k]; input.style[k] = ''; } });
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  input.style.width = '100%';
  const dd = document.createElement('div'); dd.className = 'crew-dd'; dd.style.display = 'none';
  wrap.appendChild(dd);
  const e2 = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const disp = (c) => c.handle || c.name || '';
  let rows = [], active = -1;
  const close = () => { dd.style.display = 'none'; active = -1; };
  const paint = () => {
    dd.querySelectorAll('.crew-dd-item').forEach((n, i) => n.classList.toggle('is-active', i === active));
    const on = dd.querySelector('.crew-dd-item.is-active');
    if (on) on.scrollIntoView({ block: 'nearest' });
  };
  // showAll = the field was focused/clicked (browse the whole roster); typing filters it.
  const render = (showAll) => {
    const all = window.crewSortAZ(typeof getCrew === 'function' ? getCrew() : []);
    const q = input.value.trim();
    // Ranked search re-orders by relevance while typing (that's what you want mid-search);
    // an empty box — or a box still holding the person already in the slot — stays A–Z.
    rows = (showAll || !q) ? all
      : NESearch.filter(all, q, (c) => [{ text: c.name, weight: 2 }, { text: c.handle, weight: 2 }, c.role, c.country]);
    if (!rows.length) {
      dd.innerHTML = '<div class="crew-dd-empty">No crew match — add them on the Crew page first.</div>';
      dd.style.display = 'block'; active = -1; return;
    }
    dd.innerHTML = rows.map((c, i) => {
      const color = window.CREW_GROUP_COLOR[c.group] || '#8b93a7';
      // Only worth a second line when it says something the big name doesn't.
      const meta = [c.handle && c.name && c.handle !== c.name ? c.name : null,
        c.role || window.CREW_GROUP_LABEL[c.group] || null].filter(Boolean).join(' · ');
      return `<div class="crew-dd-item" data-i="${i}">`
        + `<span class="crew-dd-dot" style="background:${color};"></span>`
        + `<span class="crew-dd-txt"><span class="crew-dd-nm">${e2(disp(c))}</span>`
        + (meta ? `<span class="crew-dd-meta">${e2(meta)}</span>` : '')
        + '</span></div>';
    }).join('');
    dd.style.display = 'block';
    active = -1;
  };
  const pick = (c) => {
    if (!c) return;
    input.value = disp(c);
    close();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  input.addEventListener('focus', () => render(true));
  input.addEventListener('click', () => { if (dd.style.display === 'none') render(true); });
  input.addEventListener('input', () => render(false));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (dd.style.display === 'none') { render(true); return; }
      e.preventDefault();
      if (!rows.length) return;
      active = e.key === 'ArrowDown'
        ? (active + 1) % rows.length
        : (active <= 0 ? rows.length - 1 : active - 1);
      paint();
    } else if (e.key === 'Enter') {
      if (dd.style.display !== 'none' && active >= 0) { e.preventDefault(); pick(rows[active]); }
      else close();
    } else if (e.key === 'Escape') {
      if (dd.style.display !== 'none') { e.stopPropagation(); close(); }
    }
  });
  // mousedown (not click) so the pick lands before blur tears the list down.
  dd.addEventListener('mousedown', (e) => {
    const it = e.target.closest('.crew-dd-item'); if (!it) return;
    e.preventDefault();
    pick(rows[+it.dataset.i]);
  });
  input.addEventListener('blur', () => setTimeout(close, 160));
};
// Off-air staff / support search boxes — same roster, same dropdown.
['td-support-search', 'dcc-support-search'].forEach((id) => {
  const i = el(id);
  if (i) window.mountCrewTypeahead(i, () => (currentState && currentState.crew) || []);
});

// "Open full board" on the Schedule front card → the roomy pop-out with the full match list.
el('btn-sch-front-open')?.addEventListener('click', () => { if (window._gfxOpenPopout) window._gfxOpenPopout('schedule'); });


// ── Live-data automation for the manually-scored titles (R6 relay, Bedwars server push) ──────
// Both auto-score toggles default OFF server-side; these just surface them. renderLiveDataPanels()
// is called from applyState so the connection dots and readouts follow the live feed.
el('chk-r6-autoscore')?.addEventListener('change', function () {
  send('set_r6_settings', { autoScore: !!this.checked });
});
el('chk-bedwars-autoscore')?.addEventListener('change', function () {
  send('set_bedwars_settings', { autoScore: !!this.checked });
});
el('btn-bedwars-token-save')?.addEventListener('click', () => {
  // The field is ALWAYS blank after a reload (the token is never broadcast back), so a blank Save
  // must mean "leave it alone" — not "clear it". Clearing is an explicit, confirmed action below.
  const v = (el('input-bedwars-token')?.value || '').trim();
  if (!v) {
    if (typeof showToast === 'function') showToast('No change — type a token to replace it, or use Clear.', '#f59e0b');
    return;
  }
  send('set_bedwars_settings', { token: v });
  if (el('input-bedwars-token')) el('input-bedwars-token').value = '';
  if (typeof showToast === 'function') showToast('Bedwars token saved', '#22c55e');
});
el('btn-bedwars-token-clear')?.addEventListener('click', async () => {
  if (typeof appConfirm === 'function'
      && !(await appConfirm('Remove the Bedwars token? Any local post to /api/bedwars will then be accepted.', 'Clear'))) return;
  send('set_bedwars_settings', { clearToken: true });
  if (el('input-bedwars-token')) el('input-bedwars-token').value = '';
  if (typeof showToast === 'function') showToast('Bedwars token cleared', '#f59e0b');
});
// The endpoint hint must show an address a REMOTE Minecraft server can actually reach. The panel
// runs from file://, where location.hostname is '' — so it cannot work this out locally and would
// always print localhost. The server resolves its own LAN address at boot and sends it as lanHost.
function bedwarsEndpointHint(host) {
  const n = el('bedwars-endpoint');
  if (n) n.textContent = 'http://' + (host || 'localhost') + ':3000/api/bedwars';
}
function _liveAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 5 ? 'just now' : (s < 60 ? s + 's ago' : Math.round(s / 60) + 'm ago');
}
// A feed is only "live" if we heard from it recently — a stale lastSeen means the observer closed
// the game, and showing a green dot then would be a lie.
const LIVE_STALE_MS = 45000;
function renderLiveDataPanels(data) {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  // Dota 2 (Game State Integration)
  const dota = (data && data.dota) || {};
  const dl = dota.connected && dota.live;
  const dBox = el('dota-live-readout');
  if (dBox) {
    const clk = dl && dl.map ? Math.max(0, Math.floor(dl.map.clock || 0)) : 0;
    dBox.innerHTML = dl
      ? '<strong>Live:</strong> ' + (dl.spectating ? 'spectating' : '<span style="color:#f6ad55">not spectating (Dota only sends your own hero)</span>')
        + (dl.map && dl.map.state ? ' &middot; ' + esc(dl.map.state) : '')
        + ' &middot; ' + Math.floor(clk / 60) + ':' + String(clk % 60).padStart(2, '0')
        + ' &middot; kills ' + ((dl.map && dl.map.radiantScore) || 0) + '\u2013' + ((dl.map && dl.map.direScore) || 0)
        + (dl.draft ? ' &middot; draft in progress' : '')
      : (dota.cfgPath ? 'Set up. Waiting for Dota 2 to send data.' : '');
  }
  const dAuto = el('chk-dota-autodraft'); if (dAuto && document.activeElement !== dAuto) dAuto.checked = dota.autoDraft !== false;
  const dBoard = el('chk-dota-board'); if (dBoard && document.activeElement !== dBoard) dBoard.checked = !!dota.showBoard;
  el('dota-radiant-seg')?.querySelectorAll('button[data-v]').forEach((b) => {
    b.classList.toggle('is-on', b.dataset.v === (dota.radiantSide === 'b' ? 'b' : 'a'));
    const nm = b.dataset.v === 'b' ? ((data.teams && data.teams.orange && data.teams.orange.name) || 'Orange team') : ((data.teams && data.teams.blue && data.teams.blue.name) || 'Blue team');
    if (b.textContent !== nm) b.textContent = nm;
  });

  // Rainbow Six
  const r6 = (data && data.r6) || {};
  const g = r6.gepData || null;
  const r6Live = !!(g && g.gepConnected && (Date.now() - (g.lastSeen || 0)) < LIVE_STALE_MS);
  const r6Dot = el('r6-conn-dot'), r6St = el('r6-conn-status');
  if (r6Dot) r6Dot.className = 'conn-dot ' + (r6Live ? 'ok' : 'err');
  if (r6St) {
    r6St.textContent = r6Live
      ? 'Relay connected — last update ' + _liveAgo(g.lastSeen) + '.'
      : (g ? 'Relay idle — last seen ' + _liveAgo(g.lastSeen) + '.' : 'Relay not connected.');
  }
  const r6Box = el('r6-live-readout');
  if (r6Box) {
    r6Box.innerHTML = (r6Live && g)
      ? '<strong>Live:</strong> ' + esc(g.map || 'unknown map')
        + ' &middot; round ' + (g.round || 0)
        + ' &middot; score ' + ((g.score && g.score.a) || 0) + '\u2013' + ((g.score && g.score.b) || 0)
        + (g.side ? ' &middot; ' + esc(g.side) : '')
        + ' &middot; ' + ((g.roster || []).length) + ' players'
      : '';
  }
  const r6Chk = el('chk-r6-autoscore');
  if (r6Chk && document.activeElement !== r6Chk) r6Chk.checked = !!r6.autoScore;

  // Bedwars
  const bw = (data && data.bedwars) || {};
  const d = bw.data || null;
  const bwLive = !!(d && d.connected && (Date.now() - (d.lastSeen || 0)) < LIVE_STALE_MS);
  const bwDot = el('bedwars-conn-dot'), bwSt = el('bedwars-conn-status');
  if (bwDot) bwDot.className = 'conn-dot ' + (bwLive ? 'ok' : 'err');
  if (bwSt) {
    bwSt.textContent = bwLive
      ? 'Server connected — last update ' + _liveAgo(d.lastSeen) + '.'
      : (d ? 'Server idle — last seen ' + _liveAgo(d.lastSeen) + '.' : 'No server data received yet.');
  }
  const bwBox = el('bedwars-live-readout');
  if (bwBox) {
    bwBox.innerHTML = (bwLive && d && (d.teams || []).length)
      ? '<strong>Teams:</strong> ' + d.teams.map((t) =>
          esc(t.name || t.key) + ' ' + (t.eliminated ? '(out)' : (t.bedAlive ? '\u2014 bed intact' : '\u2014 bed broken'))
        ).join(' &middot; ')
      : '';
  }
  bedwarsEndpointHint(data && data.lanHost);
  const bwChk = el('chk-bedwars-autoscore');
  if (bwChk && document.activeElement !== bwChk) bwChk.checked = !!bw.autoScore;
  // The token itself is never broadcast (it would reach every OBS browser source) — only hasToken.
  // So the field shows whether one is set, not what it is; typing a new value replaces it.
  const bwTok = el('input-bedwars-token');
  if (bwTok && document.activeElement !== bwTok) {
    bwTok.placeholder = bw.hasToken ? 'Token set — type to replace' : 'optional — blank accepts any local post';
    if (bw.hasToken && !bwTok.value) bwTok.value = '';
  }
}
bedwarsEndpointHint();   // placeholder until the first state broadcast supplies lanHost


// ── Dota 2 setup (Settings ▸ Games ▸ Dota 2) ──
el('btn-dota-setup')?.addEventListener('click', () => {
  const r = el('dota-result'); if (r) { r.textContent = 'Looking for Dota 2 in your Steam libraries...'; r.style.color = ''; }
  send('dota_setup', {});
});
el('btn-dota-install')?.addEventListener('click', () => {
  const p = (el('input-dota-path')?.value || '').trim();
  const r = el('dota-result');
  if (!p) { if (r) { r.textContent = 'Enter your dota 2 beta folder first.'; r.style.color = '#f56565'; } return; }
  send('dota_setup', { path: p });
});
el('btn-dota-launch')?.addEventListener('click', () => send('dota_launch', {}));
el('chk-dota-autodraft')?.addEventListener('change', (e) => send('dota_settings', { autoDraft: !!e.target.checked }));
el('chk-dota-board')?.addEventListener('change', (e) => send('dota_settings', { showBoard: !!e.target.checked }));
el('dota-radiant-seg')?.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-v]'); if (!b) return;
  el('dota-radiant-seg').querySelectorAll('button[data-v]').forEach((x) => x.classList.toggle('is-on', x === b));
  send('dota_settings', { radiantSide: b.dataset.v });
});

// ── Streaming software picker (Apps ▸ Streaming software) ──
// One choice for the program that sends the stream: OBS Studio and Streamlabs Desktop share the OBS
// connection (select-obs-app, saved with the OBS settings); vMix is the switcher target. Only the
// chosen program's section shows.
function swCurrentApp(st) {
  const s = st || currentState || {};
  if ((s.switcher && s.switcher.target) === 'vmix') return 'vmix';
  if (window._swPendingApp) return window._swPendingApp;
  return (s.obs && s.obs.app) === 'streamlabs' ? 'streamlabs' : 'obs';
}
function swRenderPicker(st) {
  const app = swCurrentApp(st);
  el('sw-app-seg')?.querySelectorAll('button[data-v]').forEach((b) => b.classList.toggle('is-on', b.dataset.v === app));
  const obsSec = el('sw-sec-obs'), vmixSec = el('sw-sec-vmix');
  if (obsSec) obsSec.style.display = app === 'vmix' ? 'none' : '';
  if (vmixSec) vmixSec.style.display = app === 'vmix' ? '' : 'none';
  const nm = app === 'streamlabs' ? 'Streamlabs Desktop' : 'OBS Studio';
  const t = el('sw-obs-title'); if (t && t.textContent !== nm) t.textContent = nm;
  const l = el('sw-obs-enable-lbl'); if (l) l.textContent = 'Connect to ' + nm;
  // The vMix section's own OBS/vMix toggle is now this picker.
  const tseg = el('switcher-target-seg'); const trow = tseg && tseg.closest('.field-row'); if (trow) trow.style.display = 'none';
}
el('sw-app-seg')?.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-v]'); if (!b) return;
  const v = b.dataset.v;
  window._swPendingApp = v === 'vmix' ? '' : v;
  if (v === 'vmix') send('set_switcher_target', { target: 'vmix' });
  else {
    send('set_switcher_target', { target: 'obs' });
    const sel = el('select-obs-app');
    if (sel && sel.value !== v) { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  }
  // Show the choice straight away; the next state confirms it.
  const st = currentState ? JSON.parse(JSON.stringify({ switcher: currentState.switcher || {}, obs: currentState.obs || {} })) : { switcher: {}, obs: {} };
  st.switcher.target = v === 'vmix' ? 'vmix' : 'obs';
  if (v !== 'vmix') st.obs.app = v;
  swRenderPicker(st);
});
