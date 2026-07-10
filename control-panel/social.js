/* ─── social.js — Social publishing domain (clips → YouTube/Twitter composer, calendar) ──
   Extracted verbatim from the end of app.js (2026-07) as the first per-domain module.
   Loads AFTER app.js; uses core.js globals (el, esc, send, currentState) and app.js
   helpers (showToast) at call time. app.js reaches back in via typeof-guarded calls
   (_loadSocialConnections/_loadSocialSchedule on social_* WS messages). */


// ── State ─────────────────────────────────────────────────────────────────────
let _socialClip        = null;
let _socialSchedule    = [];
let _calYear = null, _calMonth = null;
let _allTwitchClips    = [];   // cached for client-side sort

// ── Main sub-tab switching ─────────────────────────────────────────────────────
document.querySelectorAll('.social-sub-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.social-sub-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.social-sub-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const panel = el('social-panel-' + btn.dataset.stab);
    if (panel) panel.classList.add('active');
    if (btn.dataset.stab === 'calendar') _renderSocialCalendar();
  });
});

// ── Clip source tab switching (Twitch / Local) ─────────────────────────────────
document.querySelectorAll('.clip-src-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.clip-src-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.clip-src-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const panel = el('clip-src-' + btn.dataset.csrc);
    if (panel) panel.classList.add('active');
  });
});

// ── Sort control ──────────────────────────────────────────────────────────────
el('social-clip-sort')?.addEventListener('change', () => _renderTwitchClipCards(_allTwitchClips));

el('tab-social')?.addEventListener('click', () => {
  _loadSocialConnections();
  _loadSocialSchedule();
  _loadTwitchClips();
  _loadLocalClips();
});

// ── Description / caption templates ───────────────────────────────────────────
const _TMPL_YT = 'ne_social_yt_template';
const _TMPL_TW = 'ne_social_tw_template';
function _getSocialTemplate(key) { return localStorage.getItem(key) || ''; }
function _setSocialTemplate(key, val) { localStorage.setItem(key, val); showToast('Template saved'); }

el('btn-yt-save-template')?.addEventListener('click', () => {
  _setSocialTemplate(_TMPL_YT, el('social-yt-desc')?.value || '');
});
el('btn-tw-save-template')?.addEventListener('click', () => {
  _setSocialTemplate(_TMPL_TW, el('social-tw-caption')?.value || '');
});

// ── Platform connections ───────────────────────────────────────────────────────
async function _loadSocialConnections() {
  try {
    const r = await fetch('http://localhost:3000/api/social/connections');
    const data = await r.json();
    _renderSocialConnections(data);
  } catch {}
}

function _renderSocialConnections(data) {
  const hint = el('social-setup-hint');
  if (hint) hint.style.display = 'none'; // credentials bundled in production build
  _renderConnCard('yt', 'youtube', data.youtube);
  _renderConnCard('tw', 'twitter', data.twitter);
  _setConnBadge('social-yt-badge', data.youtube);
  _setConnBadge('social-tw-badge', data.twitter);
}

function _setConnBadge(id, info) {
  const badge = el(id);
  if (!badge) return;
  if (info?.connected) {
    badge.textContent = 'Connected'; badge.style.background = 'rgba(72,187,120,.15)'; badge.style.color = '#48bb78';
  } else {
    badge.textContent = info?.configured ? 'Not connected' : 'Not configured';
    badge.style.background = 'rgba(255,255,255,.08)'; badge.style.color = 'var(--muted)';
  }
}

function _renderConnCard(prefix, platform, info) {
  const pill   = el('social-conn-' + (prefix === 'yt' ? 'youtube' : 'twitter'));
  const status = el('social-' + prefix + '-status');
  const action = el('social-' + prefix + '-action');
  if (!status || !action) return;
  if (pill) pill.classList.toggle('connected', !!info?.connected);
  if (info?.connected) {
    status.textContent = 'Connected'; status.style.color = '#48bb78';
    action.innerHTML = `<button class="btn btn-ghost btn-xs" onclick="_disconnectSocial('${platform}')">Disconnect</button>`;
  } else if (info?.configured) {
    status.textContent = 'Not connected'; status.style.color = 'var(--warn,#f59e0b)';
    action.innerHTML = `<button class="btn btn-primary btn-xs" onclick="_connectSocial('${platform}')">Connect</button>`;
  } else {
    status.textContent = 'Not configured'; status.style.color = 'var(--muted)';
    action.innerHTML = '<span style="font-size:10px;color:var(--muted);">Add keys to .env.local</span>';
  }
}

async function _connectSocial(platform) {
  try {
    const r = await fetch('http://localhost:3000/api/social/auth/' + platform);
    const { url, error } = await r.json();
    if (error) return showToast(error, 'error');
    // Try Electron shell first, fall back to popup
    try { window.require('electron').shell.openExternal(url); }
    catch { window.open(url, '_blank', 'width=560,height=660,noopener'); }
  } catch (e) { showToast('Could not start auth: ' + e.message, 'error'); }
}

async function _disconnectSocial(platform) {
  try {
    await fetch('http://localhost:3000/api/social/disconnect/' + platform, { method: 'POST' });
    showToast(platform + ' disconnected');
    _loadSocialConnections();
  } catch { showToast('Failed to disconnect', 'error'); }
}

// ── Twitch Clips ──────────────────────────────────────────────────────────────
el('btn-load-twitch-clips')?.addEventListener('click', () => _loadTwitchClips());

function _renderTwitchClipCards(clips) {
  const grid = el('social-twitch-clips-grid');
  const countEl = el('social-twitch-clip-count');
  if (!grid) return;
  const sort = el('social-clip-sort')?.value || 'recent';
  const sorted = [...clips].sort((a, b) =>
    sort === 'views'
      ? (b.view_count || 0) - (a.view_count || 0)
      : new Date(b.created_at || 0) - new Date(a.created_at || 0)
  );
  if (countEl) countEl.textContent = sorted.length ? sorted.length + ' clips' : '';
  grid.innerHTML = '';
  sorted.forEach(clip => {
    const views   = clip.view_count ? clip.view_count.toLocaleString() + ' views' : '';
    const date    = clip.created_at ? new Date(clip.created_at).toLocaleDateString() : '';
    const clipper = clip.creator_name || '';
    const card = document.createElement('div');
    card.className = 'social-clip-card';
    card.innerHTML = `
      <img class="social-clip-thumb" src="${clip.thumbnail_url || ''}" alt="" loading="lazy">
      <div class="social-clip-card-body">
        <div class="social-clip-title" title="${(clip.title||'').replace(/"/g,'&quot;')}">${clip.title || 'Untitled'}</div>
        <div class="social-clip-meta"><span>${views}</span><span>${date}</span></div>
        ${clipper ? '<div class="social-clip-creator">by ' + clipper + '</div>' : ''}
        <button class="btn btn-primary btn-xs" style="width:100%;">Select</button>
        <button class="btn btn-ghost btn-xs" style="width:100%;margin-top:4px;" data-dl>Download</button>
      </div>`;
    card.querySelector('.btn-primary').addEventListener('click', e => {
      e.stopPropagation();
      _selectClip({ type: 'twitch', title: clip.title, thumbnailUrl: clip.thumbnail_url, clipVideoUrl: clip._videoUrl, clipUrl: clip.url, duration: clip.duration, viewCount: clip.view_count });
    });
    card.querySelector('[data-dl]').addEventListener('click', async e => {
      e.stopPropagation();
      const dlBtn = e.currentTarget;
      dlBtn.disabled = true;
      dlBtn.textContent = 'Downloading…';
      try {
        const r = await fetch('http://localhost:3000/api/social/clip/download', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clipUrl: clip.url, thumbnailUrl: clip.thumbnail_url, title: clip.title })
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Download failed');
        showToast('Clip saved to Local library', 'success');
        dlBtn.textContent = 'Saved';
        dlBtn.style.color = '#48bb78';
        _loadLocalClips();
      } catch (err) {
        showToast('Download failed: ' + err.message, 'error');
        dlBtn.textContent = 'Download';
        dlBtn.disabled = false;
      }
    });
    grid.appendChild(card);
  });
  if (!sorted.length) grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:32px;color:var(--muted);font-size:13px;">No clips found. Make sure Twitch is connected.</div>';
}

// Fetch all Twitch clips (all creators) — auto-paginate until exhausted, then render.
let _twitchClipsLoading = false;
async function _loadTwitchClips() {
  if (_twitchClipsLoading) return;
  _twitchClipsLoading = true;
  const grid = el('social-twitch-clips-grid');
  const countEl = el('social-twitch-clip-count');
  if (!grid) { _twitchClipsLoading = false; return; }
  grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:32px;color:var(--muted);font-size:13px;">Loading…</div>';
  if (countEl) countEl.textContent = '';

  const collected = [];
  let cursor = null;
  let errorMsg = null;

  try {
    while (true) {
      const url = 'http://localhost:3000/api/twitch/clips' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : '');
      const { clips, cursor: next, error } = await fetch(url).then(r => r.json());
      if (error && !clips?.length) { errorMsg = error; break; }
      collected.push(...(clips || []));
      cursor = next || null;
      if (!cursor) break;
    }
  } catch (e) {
    errorMsg = e.message;
  }

  _allTwitchClips = collected;
  _twitchClipsLoading = false;

  if (errorMsg && !collected.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:32px;color:var(--muted);font-size:13px;">' + errorMsg + '</div>';
    return;
  }
  _renderTwitchClipCards(collected);
}

// ── Local Clips ───────────────────────────────────────────────────────────────
el('btn-load-local-clips')?.addEventListener('click', _loadLocalClips);

async function _loadLocalClips() {
  const list = el('social-local-clips-list');
  if (!list) return;
  try {
    const r = await fetch('http://localhost:3000/api/clips');
    const data = await r.json();
    const clips = data.clips || data.library || [];
    if (!clips.length) { list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0;">No clips in local library yet.</div>'; return; }
    list.innerHTML = '';
    clips.slice(0, 30).forEach(clip => {
      const row = document.createElement('div');
      row.className = 'social-local-row';
      row.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;opacity:.4"><rect x="2" y="2" width="20" height="20" rx="2"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none"/></svg>
        <span class="social-local-title">${clip.title || clip.filename || 'Clip'}</span>
        <button class="btn btn-primary btn-xs">Schedule</button>`;
      row.querySelector('button').addEventListener('click', () => _selectClip({ type: 'local', title: clip.title || clip.filename, clipPath: clip.path || clip.filePath, thumbnailUrl: null }));
      list.appendChild(row);
    });
  } catch { if (list) list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0;">Could not load local clips.</div>'; }
}

// ── Composer ──────────────────────────────────────────────────────────────────
function _selectClip(clip) {
  _socialClip = clip;
  document.querySelectorAll('.social-sub-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.stab === 'composer'));
  document.querySelectorAll('.social-sub-panel').forEach(p => p.classList.toggle('active', p.id === 'social-panel-composer'));
  el('social-no-clip').style.display = 'none';
  const preview = el('social-clip-preview');
  if (preview) preview.style.display = '';
  const titleEl = el('social-clip-preview-title');
  if (titleEl) titleEl.textContent = clip.title || 'Untitled';
  const metaEl = el('social-clip-preview-meta');
  if (metaEl) metaEl.textContent = clip.type === 'twitch' ? 'Twitch Clip' + (clip.viewCount ? ' · ' + clip.viewCount.toLocaleString() + ' views' : '') : 'Local Clip';
  const img = el('social-clip-thumb-img');
  if (img) { img.src = clip.thumbnailUrl || ''; img.style.display = clip.thumbnailUrl ? '' : 'none'; }

  // Wire up video editor for local clips
  const videoWrap = el('social-clip-video-wrap');
  const video = el('social-clip-video');
  if (clip.type === 'local' && clip.clipPath && videoWrap && video) {
    video.src = 'http://localhost:3000/api/clips/file?path=' + encodeURIComponent(clip.clipPath);
    videoWrap.style.display = '';
    video.onloadedmetadata = () => {
      const dur = video.duration || 0;
      const inSlider  = el('social-trim-in');
      const outSlider = el('social-trim-out');
      if (inSlider)  { inSlider.max  = dur; inSlider.value  = 0;   inSlider.step  = Math.max(0.1, dur / 1000); }
      if (outSlider) { outSlider.max = dur; outSlider.value = dur; outSlider.step = Math.max(0.1, dur / 1000); }
      _socialClip.trimIn  = 0;
      _socialClip.trimOut = null;
      _updateTrimDisplay();
    };
  } else {
    if (videoWrap) videoWrap.style.display = 'none';
    if (video) { video.src = ''; video.onloadedmetadata = null; }
    if (_socialClip) { _socialClip.trimIn = 0; _socialClip.trimOut = null; }
  }

  const ytTitle = el('social-yt-title');
  if (ytTitle) ytTitle.value = clip.title || '';
  const ytDesc = el('social-yt-desc');
  if (ytDesc) ytDesc.value = _getSocialTemplate(_TMPL_YT);
  const twCaption = el('social-tw-caption');
  if (twCaption) {
    twCaption.value = _getSocialTemplate(_TMPL_TW);
    const ct = el('social-tw-charcount'); if (ct) ct.textContent = twCaption.value.length + '/280';
  }
  const brandText = el('social-branding-text');
  if (brandText && !brandText.value) brandText.value = clip.title || '';
  _updateSocialSubmitBtn();
}

function _updateTrimDisplay() {
  const video  = el('social-clip-video');
  const inEl   = el('social-trim-in');
  const outEl  = el('social-trim-out');
  const dispEl = el('social-trim-display');
  if (!inEl || !outEl) return;
  const inVal  = parseFloat(inEl.value) || 0;
  const outVal = parseFloat(outEl.value) || (video?.duration || 0);
  const dur    = Math.max(0, outVal - inVal);
  const fmt    = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  if (dispEl) dispEl.textContent = `${fmt(inVal)} – ${fmt(outVal)} (${dur.toFixed(1)}s)`;
  if (_socialClip) {
    _socialClip.trimIn  = inVal;
    const vidDur = video?.duration || 0;
    _socialClip.trimOut = (vidDur > 0 && outVal < vidDur - 0.5) ? outVal : null;
  }
}

el('social-trim-in')?.addEventListener('input', function () {
  const outVal = parseFloat(el('social-trim-out')?.value || 100);
  if (parseFloat(this.value) >= outVal - 0.2) this.value = Math.max(0, outVal - 0.2);
  const video = el('social-clip-video');
  if (video) video.currentTime = parseFloat(this.value);
  _updateTrimDisplay();
});

el('social-trim-out')?.addEventListener('input', function () {
  const inVal = parseFloat(el('social-trim-in')?.value || 0);
  if (parseFloat(this.value) <= inVal + 0.2) this.value = inVal + 0.2;
  const video = el('social-clip-video');
  if (video) video.currentTime = parseFloat(this.value);
  _updateTrimDisplay();
});

// ── Branding template selector ────────────────────────────────────────────────
document.querySelectorAll('.branding-tmpl').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.branding-tmpl').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const isNone = btn.dataset.tmpl === 'none';
    const opts = el('social-branding-opts');
    if (opts) opts.style.display = isNone ? 'none' : '';
    const summary = el('social-branding-summary');
    if (summary) summary.textContent = isNone ? 'No intro / outro' : btn.textContent + ' template';
  });
});

function clearSocialClip() {
  _socialClip = null;
  const video = el('social-clip-video');
  if (video) { video.src = ''; video.onloadedmetadata = null; }
  const videoWrap = el('social-clip-video-wrap');
  if (videoWrap) videoWrap.style.display = 'none';
  el('social-no-clip').style.display = '';
  const p = el('social-clip-preview'); if (p) p.style.display = 'none';
  _updateSocialSubmitBtn();
}

['youtube', 'twitter'].forEach(p => {
  const cbId   = p === 'youtube' ? 'social-enable-youtube' : 'social-enable-twitter';
  const bodyId = p === 'youtube' ? 'social-yt-body' : 'social-tw-body';
  el(cbId)?.addEventListener('change', function() {
    el(bodyId)?.classList.toggle('open', this.checked);
    _updateSocialSubmitBtn();
  });
});

el('social-tw-caption')?.addEventListener('input', function() {
  const ct = el('social-tw-charcount'); if (ct) ct.textContent = this.value.length + '/280';
});

document.querySelectorAll('input[name="social-when"]').forEach(r => {
  r.addEventListener('change', function() {
    const picker = el('social-dt-picker'); if (picker) picker.style.display = this.value === 'schedule' ? '' : 'none';
    _updateSocialSubmitBtn();
  });
});

(function() {
  const dt = el('social-schedule-dt'); if (!dt) return;
  const d = new Date(Date.now() + 5 * 60000);
  dt.min = d.toISOString().slice(0, 16); dt.value = d.toISOString().slice(0, 16);
})();

function _updateSocialSubmitBtn() {
  const btn = el('btn-social-submit'); if (!btn) return;
  const ytOn = el('social-enable-youtube')?.checked;
  const twOn = el('social-enable-twitter')?.checked;
  const plats = [ytOn && 'YouTube', twOn && 'Twitter'].filter(Boolean);
  const when  = document.querySelector('input[name="social-when"]:checked')?.value;
  if (!_socialClip)    { btn.textContent = 'Select a clip first';           btn.disabled = true;  return; }
  if (!plats.length)   { btn.textContent = 'Select at least one platform';  btn.disabled = true;  return; }
  btn.disabled = false;
  btn.textContent = (when === 'schedule' ? 'Schedule to ' : 'Post Now to ') + plats.join(' + ');
}

el('btn-social-submit')?.addEventListener('click', async () => {
  if (!_socialClip) return showToast('No clip selected', 'error');
  const platforms = [];
  if (el('social-enable-youtube')?.checked) platforms.push('youtube');
  if (el('social-enable-twitter')?.checked) platforms.push('twitter');
  if (!platforms.length) return showToast('Select at least one platform', 'error');
  const when = document.querySelector('input[name="social-when"]:checked')?.value;
  const dtVal = el('social-schedule-dt')?.value;
  const scheduledAt = when === 'schedule' && dtVal ? new Date(dtVal).getTime() : null;
  if (when === 'schedule' && !scheduledAt) return showToast('Pick a date and time', 'error');
  const brandingTmpl = document.querySelector('.branding-tmpl.active')?.dataset.tmpl || 'none';
  const hasBranding = brandingTmpl !== 'none';
  const post = {
    clipType: _socialClip.type, clipVideoUrl: _socialClip.clipVideoUrl || null, clipPath: _socialClip.clipPath || null,
    thumbnailUrl: _socialClip.thumbnailUrl || null, clipUrl: _socialClip.clipUrl || null,
    title: el('social-yt-title')?.value || _socialClip.title || 'Clip',
    ytVisibility: el('social-yt-visibility')?.value || 'public',
    isShort: !!el('social-yt-shorts')?.checked,
    captions: { youtube: el('social-yt-desc')?.value || '', twitter: el('social-tw-caption')?.value || '' },
    trimIn:  _socialClip.trimIn  || 0,
    trimOut: _socialClip.trimOut || null,
    intro: hasBranding ? {
      template:  brandingTmpl,
      text:      el('social-branding-text')?.value     || el('social-yt-title')?.value || '',
      color:     el('social-branding-color')?.value    || '#7c3aed',
      duration:  parseFloat(el('social-branding-duration')?.value || '2'),
      outro:     !!el('social-branding-outro')?.checked,
      vertical:  !!el('social-branding-vertical')?.checked,
    } : null,
    platforms, scheduledAt
  };
  const btn = el('btn-social-submit');
  const status = el('social-submit-status');
  btn.disabled = true;
  if (status) status.textContent = when === 'now' ? 'Publishing...' : 'Saving...';
  try {
    const endpoint = when === 'now' ? '/api/social/publish-now' : '/api/social/schedule';
    const r = await fetch('http://localhost:3000' + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(post) });
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    if (when === 'now') {
      const lines = Object.entries(data.platforms || {}).map(([p, r]) => r.url ? p + ': ' + r.url : p + ': ' + (r.error || 'failed'));
      showToast('Published!');
      if (status) status.textContent = lines.join('\n') || 'Done';
    } else {
      const hasYT = platforms.includes('youtube');
      const hasTW = platforms.includes('twitter');
      const note = hasYT ? (hasTW ? 'Video uploading to YouTube now (will go live at scheduled time). Twitter will post at ' : 'Video uploading to YouTube now, goes live at ') + new Date(scheduledAt).toLocaleString() : 'Scheduled for ' + new Date(scheduledAt).toLocaleString();
      showToast('Scheduled!');
      if (status) status.textContent = note;
      _loadSocialSchedule();
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
    if (status) status.textContent = 'Error: ' + e.message;
  } finally { btn.disabled = false; _updateSocialSubmitBtn(); }
});

// ── Calendar ──────────────────────────────────────────────────────────────────
async function _loadSocialSchedule() {
  try {
    const r = await fetch('http://localhost:3000/api/social/schedule');
    _socialSchedule = (await r.json()).schedule || [];
    _renderSocialCalendar();
    _renderScheduledList();
  } catch {}
}

function _renderSocialCalendar() {
  const now = new Date();
  if (_calYear === null) { _calYear = now.getFullYear(); _calMonth = now.getMonth(); }
  const label = el('social-cal-month');
  if (label) label.textContent = new Date(_calYear, _calMonth, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
  const grid = el('social-cal-grid'); if (!grid) return;
  const firstDay    = new Date(_calYear, _calMonth, 1).getDay();
  const daysInMonth = new Date(_calYear, _calMonth + 1, 0).getDate();
  const today = new Date();
  const byDay = {};
  _socialSchedule.filter(p => p.status === 'scheduled' && p.scheduledAt).forEach(p => {
    const d = new Date(p.scheduledAt);
    if (d.getFullYear() !== _calYear || d.getMonth() !== _calMonth) return;
    const day = d.getDate(); if (!byDay[day]) byDay[day] = []; byDay[day].push(p);
  });
  let html = ['S','M','T','W','T','F','S'].map(d => `<div class="cal-hdr">${d}</div>`).join('');
  for (let i = 0; i < firstDay; i++) html += '<div class="cal-cell empty"></div>';
  for (let day = 1; day <= daysInMonth; day++) {
    const isToday = today.getFullYear() === _calYear && today.getMonth() === _calMonth && today.getDate() === day;
    const posts = byDay[day] || [];
    const chips = posts.slice(0, 2).map(p => {
      const cls = p.platforms?.includes('youtube') && p.platforms?.includes('twitter') ? 'both' : p.platforms?.includes('youtube') ? 'yt' : 'tw';
      const lbl = cls === 'both' ? 'YT+X' : cls === 'yt' ? 'YT' : 'X';
      return `<div class="cal-post-chip ${cls}" title="${(p.title||'').substring(0,40)}">${lbl}</div>`;
    }).join('');
    const more = posts.length > 2 ? `<div style="font-size:9px;color:var(--muted);">+${posts.length-2}</div>` : '';
    html += `<div class="cal-cell${isToday ? ' today' : ''}"><div class="cal-day-num">${day}</div>${chips}${more}</div>`;
  }
  grid.innerHTML = html;
}

el('btn-cal-prev')?.addEventListener('click', () => { if (_calMonth-- === 0) { _calMonth = 11; _calYear--; } _renderSocialCalendar(); });
el('btn-cal-next')?.addEventListener('click', () => { if (++_calMonth > 11) { _calMonth = 0; _calYear++; } _renderSocialCalendar(); });

function _renderScheduledList() {
  const list = el('social-sched-list'); if (!list) return;
  const upcoming = _socialSchedule.filter(p => p.status === 'scheduled' && p.scheduledAt && p.scheduledAt > Date.now()).sort((a, b) => a.scheduledAt - b.scheduledAt).slice(0, 20);
  const past     = _socialSchedule.filter(p => p.status === 'published').sort((a, b) => (b.publishedAt||0) - (a.publishedAt||0)).slice(0, 5);
  if (!upcoming.length && !past.length) { list.innerHTML = '<div style="color:var(--muted);font-size:13px;">No posts scheduled.</div>'; return; }
  list.innerHTML = '';
  upcoming.forEach(post => {
    const plats = (post.platforms||[]).map(p => p === 'youtube' ? 'YouTube' : 'Twitter').join(' + ');
    const row = document.createElement('div'); row.className = 'sched-row';
    row.innerHTML = `<div style="flex:1;min-width:0;"><div class="sched-title">${post.title||'Untitled'}</div><div class="sched-meta">${plats} · ${new Date(post.scheduledAt).toLocaleString()}</div></div><button class="btn btn-ghost btn-xs" onclick="_cancelSocialPost('${post.id}')">Cancel</button>`;
    list.appendChild(row);
  });
  if (past.length) {
    const div = document.createElement('div'); div.style.cssText = 'font-size:11px;color:var(--muted);letter-spacing:1px;text-transform:uppercase;margin:12px 0 6px;'; div.textContent = 'Recently Published'; list.appendChild(div);
    past.forEach(post => {
      const plats = (post.platforms||[]).map(p => p === 'youtube' ? 'YouTube' : 'Twitter').join(' + ');
      const row = document.createElement('div'); row.className = 'sched-row';
      row.innerHTML = `<div style="flex:1;min-width:0;"><div class="sched-title" style="opacity:.6;">${post.title||'Untitled'}</div><div class="sched-meta">${plats}${post.publishedAt ? ' · ' + new Date(post.publishedAt).toLocaleString() : ''}</div></div><span style="font-size:10px;color:#48bb78;font-weight:700;">Published</span>`;
      list.appendChild(row);
    });
  }
}

async function _cancelSocialPost(id) {
  try { await fetch('http://localhost:3000/api/social/schedule/' + id, { method: 'DELETE' }); showToast('Post cancelled'); _loadSocialSchedule(); }
  catch { showToast('Failed to cancel', 'error'); }
}

// ── OBS Program Preview panel ──────────────────────────────────────────────
(function () {
  function _initObsPreview() {
    const panel    = document.getElementById('obs-preview-panel');
    const btn      = document.getElementById('btn-obs-preview');
    const img      = document.getElementById('obs-prev-img');
    const video    = document.getElementById('obs-prev-video');
    const msg      = document.getElementById('obs-prev-msg');
    const fpsBtn   = document.getElementById('obs-prev-fps');
    const sceneEl  = document.getElementById('obs-prev-scene');
    const pauseBtn = document.getElementById('obs-prev-pause');
    const closeBtn = document.getElementById('obs-prev-close');
    const dragHdr  = document.getElementById('obs-prev-drag');
    const modeCam  = document.getElementById('obs-prev-mode-cam');
    const modeScr  = document.getElementById('obs-prev-mode-scr');
    if (!panel || !btn) return;

    // ── State ──
    let active  = false;
    let mode    = 'cam';          // cam-only: SCR (screenshot polling) removed from this panel
    let paused  = false;
    let pending = false;
    let timer   = null;
    let frameTs = 0;
    let frameCount = 0;
    let fpsTimer   = null;
    let camStream  = null;
    let blobUrl    = '';

    // Screenshot fps options (ms between frames): 20fps/10fps/5fps/2fps
    const FPS_OPTS = [50, 100, 200, 500];
    const FPS_LBLS = ['20 fps', '10 fps', '5 fps', '2 fps'];
    let fpsIdx = 1; // default 10fps

    // ── Helpers ──
    function setMsg(text) {
      msg.textContent = text;
      msg.classList.toggle('hidden', !text);
    }

    function setMode(m) {
      mode = 'cam';   // cam-only now
      modeCam.classList.add('active');
      if (modeScr) modeScr.style.display = 'none';
      fpsBtn.style.display = 'none';
      pauseBtn.style.display = 'none';
      img.style.display = 'none';
      video.style.display = '';
    }

    // ── Screenshot mode ──
    async function scrNext() {
      if (!active || paused || pending || mode !== 'scr') return;
      pending = true;
      try {
        const res = await fetch('http://localhost:3000/api/obs/screenshot?t=' + Date.now());
        if (res.ok) {
          const blob = await res.blob();
          const url  = URL.createObjectURL(blob);
          img.src = url;
          if (blobUrl) URL.revokeObjectURL(blobUrl);
          blobUrl = url;
          frameCount++;
          frameTs = Date.now();
          setMsg('');
        } else {
          const body = await res.json().catch(() => ({}));
          setMsg(body.error || ('Error ' + res.status));
        }
      } catch (e) {
        setMsg('Server unreachable');
      } finally {
        pending = false;
        if (active && !paused && mode === 'scr') timer = setTimeout(scrNext, FPS_OPTS[fpsIdx]);
      }
    }

    // ── Camera mode ──
    async function startCam() {
      setMsg('Starting OBS Virtual Camera...');
      // Auto-start the Virtual Camera when it's off — no more manual Tools menu trip.
      try { if (typeof send === 'function') send('obs_virtualcam', { on: true }); } catch (e) {}
      try {
        // First enumerate to see if labels are available
        let devices = await navigator.mediaDevices.enumerateDevices();
        let obsDevice = devices.find(d => d.kind === 'videoinput' && /obs/i.test(d.label));

        // If no labels yet, request temporary access to unlock them
        if (!obsDevice && devices.some(d => d.kind === 'videoinput' && !d.label)) {
          const tmp = await navigator.mediaDevices.getUserMedia({ video: true }).catch(() => null);
          if (tmp) tmp.getTracks().forEach(t => t.stop());
          devices = await navigator.mediaDevices.enumerateDevices();
          obsDevice = devices.find(d => d.kind === 'videoinput' && /obs/i.test(d.label));
        }

        if (!obsDevice) {
          // The vcam we just started needs a moment to register as a device.
          await new Promise(r => setTimeout(r, 1200));
          devices = await navigator.mediaDevices.enumerateDevices();
          obsDevice = devices.find(d => d.kind === 'videoinput' && /obs/i.test(d.label));
        }
        if (!obsDevice) {
          setMsg('OBS Virtual Camera not found — is OBS connected? (It is auto-started when available; click CAM to retry.)');
          return;
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: obsDevice.deviceId }, width: 1920, height: 1080 },
          audio: false,
        });
        camStream = stream;
        video.srcObject = stream;
        video.play().catch(() => {});
        setMsg('');
      } catch (e) {
        setMsg('Camera error: ' + (e.message || e));
      }
    }

    function stopCam() {
      if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
      video.srcObject = null;
    }

    // ── FPS meter (screenshot mode only) ──
    function startFpsMeter() {
      fpsTimer = setInterval(() => {
        if (!active || mode !== 'scr') return;
        if (paused) { return; }
        const age = Date.now() - frameTs;
        const fps = age > 3000 ? 0 : frameCount;
        fpsBtn.textContent = fps + ' fps';
        frameCount = 0;
      }, 1000);
    }

    // ── Open / close ──
    function open() {
      active = true;
      panel.style.display = '';
      btn.classList.add('active');
      fpsBtn.textContent = FPS_LBLS[fpsIdx];
      frameCount = 0; frameTs = Date.now();
      setMode('cam');
      startCam();
    }

    function close() {
      active = false;
      clearTimeout(timer); clearInterval(fpsTimer);
      stopCam();
      panel.style.display = 'none';
      btn.classList.remove('active');
      img.src = '';
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = ''; }
      setMsg('Connect OBS to enable preview');
    }

    function switchMode(m) {
      if (m === mode) return;
      // Stop whichever is running
      if (mode === 'cam') stopCam();
      if (mode === 'scr') { clearTimeout(timer); clearInterval(fpsTimer); paused = false; }
      setMode(m);
      if (active) {
        frameCount = 0; frameTs = Date.now();
        if (m === 'cam') {
          startCam();
        } else {
          setMsg('Connecting...');
          scrNext();
          startFpsMeter();
        }
      }
    }

    function togglePause() {
      if (!active || mode !== 'scr') return;
      paused = !paused;
      panel.classList.toggle('paused', paused);
      pauseBtn.innerHTML = paused ? '&#9654;' : '&#9646;&#9646;';
      if (!paused) { frameCount = 0; frameTs = Date.now(); scrNext(); }
    }

    // ── Wire controls ──
    btn.addEventListener('click', () => { if (active) close(); else open(); });
    closeBtn.addEventListener('click', close);
    pauseBtn.addEventListener('click', togglePause);
    modeCam.addEventListener('click', () => { stopCam(); startCam(); });   // retry
    if (modeScr) modeScr.style.display = 'none';

    // FPS button cycles through fps options (screenshot mode only)
    fpsBtn.addEventListener('click', () => {
      fpsIdx = (fpsIdx + 1) % FPS_OPTS.length;
      fpsBtn.textContent = FPS_LBLS[fpsIdx];
      localStorage.setItem('ne_obs_prev_fps', fpsIdx);
    });

    // ── Restore saved prefs ──
    const savedMode = localStorage.getItem('ne_obs_prev_mode') || 'cam';
    const savedFps  = parseInt(localStorage.getItem('ne_obs_prev_fps')) || 1;
    fpsIdx = Math.min(savedFps, FPS_OPTS.length - 1);
    fpsBtn.textContent = FPS_LBLS[fpsIdx];
    setMode(savedMode);

    // ── Draggable ──
    dragHdr.addEventListener('mousedown', (e) => {
      if (e.target.closest('.obs-prev-btn, .obs-prev-modetab, .obs-prev-modetabs')) return;
      const rect = panel.getBoundingClientRect();
      const ox = e.clientX - rect.left, oy = e.clientY - rect.top;
      function onMove(ev) {
        let x = ev.clientX - ox, y = ev.clientY - oy;
        x = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  x));
        y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, y));
        panel.style.right = 'auto'; panel.style.bottom = 'auto';
        panel.style.left = x + 'px'; panel.style.top = y + 'px';
      }
      function onUp() { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // ── Scene label (updated from full_state) ──
    window._obsPreviewUpdateScene = (sceneName) => {
      if (sceneEl) sceneEl.textContent = sceneName || '';
    };
  } // end _initObsPreview

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initObsPreview);
  } else {
    _initObsPreview();
  }
})();

