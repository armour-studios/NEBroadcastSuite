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
// Auto Queue state. Declared up here rather than beside its module at the bottom of the file so
// the clip-grid renderer can read _bulkPicked without a temporal-dead-zone hazard.
const _bulkPicked      = new Set();   // Twitch clip ids ticked on the Clips tab
let   _sqRows          = [];          // [{ clip, title, desc, caption, at, status }]
let   _sqSending       = false;

// ── Main sub-tab switching ─────────────────────────────────────────────────────
document.querySelectorAll('.social-sub-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.social-sub-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.social-sub-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const panel = el('social-panel-' + btn.dataset.stab);
    if (panel) panel.classList.add('active');
    if (btn.dataset.stab === 'export')   { if (typeof window._socOpenExport === 'function') window._socOpenExport(); }
    if (btn.dataset.stab === 'calendar') _renderSocialCalendar();
    if (btn.dataset.stab === 'queue')    _sqShowPanel();
    if (btn.dataset.stab === 'weekly')   _loadWeekly();
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
// Changing the window changes what Twitch returns, so this is a re-pull, not a client-side sort.
el('social-clip-window')?.addEventListener('change', () => _loadTwitchClips());

el('tab-social')?.addEventListener('click', () => {
  // The page is open to everyone for Social Export, but every fetch below serves a publishing
  // sub-tab that non-admins can't even see — skip them rather than hammer Twitch/YouTube.
  if (!window._socialAllowed) return;
  _loadSocialConnections();
  _loadSocialSchedule();
  _loadTwitchClips();
  _loadLocalClips();
  _loadWeekly();     // also lights the Weekly tab badge when a batch is waiting for review
});

// ── Description / caption templates ───────────────────────────────────────────
const _TMPL_YT    = 'ne_social_yt_template';
const _TMPL_TW    = 'ne_social_tw_template';
const _TMPL_TITLE = 'ne_social_title_template';
function _getSocialTemplate(key) { return localStorage.getItem(key) || ''; }
function _setSocialTemplate(key, val) { localStorage.setItem(key, val); showToast('Template saved'); }

el('btn-yt-save-template')?.addEventListener('click', () => {
  _setSocialTemplate(_TMPL_YT, el('social-yt-desc')?.value || '');
});
el('btn-tw-save-template')?.addEventListener('click', () => {
  _setSocialTemplate(_TMPL_TW, el('social-tw-caption')?.value || '');
});

// ── Auto-naming engine ────────────────────────────────────────────────────────
// Titles and descriptions are built from a {token} template, resolved against the clip's own
// Twitch metadata plus whatever the suite currently knows about the show (event name, the two
// teams, round label). Tokens that resolve to nothing are dropped and the leftover punctuation
// is tidied, so a clip captured outside a match still gets a clean title instead of "| vs |".

// The engine itself lives in social-naming-core.js so backend/social-weekly.js can require() the
// SAME code — an unattended Monday-morning run has to name clips exactly the way the producer saw
// it name them on Friday. This file only supplies the show context and the saved templates.
const _NC = (typeof SocialNamingCore !== 'undefined') ? SocialNamingCore : null;

const SOCIAL_TOKENS          = _NC ? _NC.TOKENS          : [];
const SOCIAL_DEFAULT_TITLE   = _NC ? _NC.DEFAULT_TITLE   : '{clip_title}';
const SOCIAL_DEFAULT_DESC    = _NC ? _NC.DEFAULT_DESC    : '{clip_title}';
const SOCIAL_DEFAULT_CAPTION = _NC ? _NC.DEFAULT_CAPTION : '{clip_title}';

// Twitch category id → name, filled in by _loadTwitchClips once the ids are known.
let _twitchGameNames = {};

// What the suite currently knows about the show, in the shape the core expects.
function _socialShowContext() {
  const st = (typeof currentState !== 'undefined' && currentState) || {};
  return { eventName: st.eventName, roundLabel: st.roundLabel, activeGame: st.activeGame, teams: st.teams };
}

function _tidyLine(line) { return _NC ? _NC.tidyLine(line) : String(line).trim(); }

function _fillSocialTemplate(tmpl, clip, index) {
  if (!_NC) return String(tmpl || '');
  return _NC.fillTemplate(tmpl, clip, index, _socialShowContext(), _twitchGameNames);
}

function _autoTitle(clip, index)   { return _fillSocialTemplate(_getSocialTemplate(_TMPL_TITLE) || SOCIAL_DEFAULT_TITLE, clip, index).slice(0, 100); }
function _autoDesc(clip, index)    { return _fillSocialTemplate(_getSocialTemplate(_TMPL_YT)    || SOCIAL_DEFAULT_DESC,  clip, index); }
function _autoCaption(clip, index) { return _fillSocialTemplate(_getSocialTemplate(_TMPL_TW)    || SOCIAL_DEFAULT_CAPTION, clip, index).slice(0, 280); }

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
    card.className = 'social-clip-card' + (_bulkPicked.has(clip.id) ? ' picked' : '');
    card.innerHTML = `
      <div class="social-clip-pickwrap">
        <input type="checkbox" class="social-clip-pick" ${_bulkPicked.has(clip.id) ? 'checked' : ''} title="Add to Auto Queue">
        <img class="social-clip-thumb" src="${clip.thumbnail_url || ''}" alt="" loading="lazy">
      </div>
      <div class="social-clip-card-body">
        <div class="social-clip-title" title="${(clip.title||'').replace(/"/g,'&quot;')}">${clip.title || 'Untitled'}</div>
        <div class="social-clip-meta"><span>${views}</span><span>${date}</span></div>
        ${clipper ? '<div class="social-clip-creator">by ' + clipper + '</div>' : ''}
        <button class="btn btn-primary btn-xs" style="width:100%;">Select</button>
        <button class="btn btn-ghost btn-xs" style="width:100%;margin-top:4px;" data-dl>Download</button>
      </div>`;
    card.querySelector('.social-clip-pick').addEventListener('change', e => {
      e.stopPropagation();
      if (e.currentTarget.checked) _bulkPicked.add(clip.id); else _bulkPicked.delete(clip.id);
      card.classList.toggle('picked', e.currentTarget.checked);
      _renderBulkCount();
    });
    card.querySelector('.btn-primary').addEventListener('click', e => {
      e.stopPropagation();
      _selectClip({ type: 'twitch', title: clip.title, thumbnailUrl: clip.thumbnail_url, clipVideoUrl: clip._videoUrl, clipUrl: clip.url, duration: clip.duration, viewCount: clip.view_count, raw: clip });
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
      const days = parseInt(el('social-clip-window')?.value, 10) || 0;
      const qs   = [days > 0 ? 'days=' + days : '', cursor ? 'cursor=' + encodeURIComponent(cursor) : ''].filter(Boolean).join('&');
      const url  = 'http://localhost:3000/api/twitch/clips' + (qs ? '?' + qs : '');
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
  // Drop selections for clips that are no longer in the pull, so the count can't drift.
  const live = new Set(collected.map(c => c.id));
  [..._bulkPicked].forEach(id => { if (!live.has(id)) _bulkPicked.delete(id); });

  if (errorMsg && !collected.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:32px;color:var(--muted);font-size:13px;">' + errorMsg + '</div>';
    return;
  }
  _renderTwitchClipCards(collected);
  _renderBulkCount();
  _resolveTwitchGameNames(collected);
}

// Clips only carry game_id — resolve the readable category once per pull so {game} works.
// Best-effort: a failure just leaves {game} falling back to the suite's active game.
async function _resolveTwitchGameNames(clips) {
  const ids = [...new Set(clips.map(c => c.game_id).filter(Boolean))].filter(id => !(id in _twitchGameNames));
  if (!ids.length) return;
  try {
    const r = await fetch('http://localhost:3000/api/twitch/games?ids=' + encodeURIComponent(ids.join(',')));
    const { games } = await r.json();
    if (games) _twitchGameNames = { ..._twitchGameNames, ...games };
  } catch (_) {}
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

  // Load the clip into the trim editor. Local clips stream off our own file route; a Twitch clip
  // has no local copy until publish time, so we ask the server for a signed CDN rendition — that
  // is the only reason trimming used to be local-clips-only.
  const videoWrap = el('social-clip-video-wrap');
  const video = el('social-clip-video');
  if (video) { video.src = ''; video.onloadedmetadata = null; }
  if (videoWrap) videoWrap.style.display = 'none';
  if (_socialClip) { _socialClip.trimIn = 0; _socialClip.trimOut = null; }

  const armTrim = () => {
    if (!video) return;
    videoWrap.style.display = '';
    video.onloadedmetadata = () => {
      const dur = video.duration || 0;
      const inSlider  = el('social-trim-in');
      const outSlider = el('social-trim-out');
      if (inSlider)  { inSlider.max  = dur; inSlider.value  = 0;   inSlider.step  = Math.max(0.1, dur / 1000); }
      if (outSlider) { outSlider.max = dur; outSlider.value = dur; outSlider.step = Math.max(0.1, dur / 1000); }
      if (_socialClip) { _socialClip.trimIn = 0; _socialClip.trimOut = null; }
      _updateTrimDisplay();
    };
  };

  if (clip.type === 'local' && clip.clipPath && videoWrap && video) {
    video.src = 'http://localhost:3000/api/clips/file?path=' + encodeURIComponent(clip.clipPath);
    armTrim();
  } else if (clip.type === 'twitch' && clip.clipUrl && videoWrap && video) {
    const wanted = clip.clipUrl;
    _resolveTwitchClipSrc(wanted).then(src => {
      // The producer may have moved on to another clip while the resolve was in flight.
      if (!src || !_socialClip || _socialClip.clipUrl !== wanted) return;
      video.src = src;
      armTrim();
    });
  }

  // Auto-name on select: the naming templates run against the clip's Twitch metadata plus the
  // live show state. Everything below stays editable — this is a starting point, not a lock.
  _socialClip.raw = clip.raw || { title: clip.title, url: clip.clipUrl, duration: clip.duration, view_count: clip.viewCount };
  _applyAutoNaming();
  const brandText = el('social-branding-text');
  if (brandText && !brandText.value) brandText.value = clip.title || '';
  _updateSocialSubmitBtn();
}

// Twitch clip page URL → a signed, directly-playable CDN URL. Cached per clip: the signature is
// good for the session and each resolve is a GQL round trip. Returns null on failure — the
// composer just falls back to "no trim editor" rather than blocking the whole selection.
const _twitchSrcCache = new Map();
async function _resolveTwitchClipSrc(clipUrl) {
  if (_twitchSrcCache.has(clipUrl)) return _twitchSrcCache.get(clipUrl);
  try {
    const r = await fetch('http://localhost:3000/api/social/clip/resolve?url=' + encodeURIComponent(clipUrl));
    const data = await r.json();
    if (!r.ok || data.error || !data.url) throw new Error(data.error || 'no rendition');
    _twitchSrcCache.set(clipUrl, data.url);
    return data.url;
  } catch (e) {
    console.warn('[Social] Could not resolve Twitch clip for trimming:', e.message);
    _twitchSrcCache.set(clipUrl, null);
    return null;
  }
}

// Re-run the naming templates over the composer's selected clip.
function _applyAutoNaming() {
  if (!_socialClip) return;
  const src = _socialClip.raw || { title: _socialClip.title };
  const ytTitle = el('social-yt-title');
  if (ytTitle) ytTitle.value = _autoTitle(src, 0) || _socialClip.title || '';
  const ytDesc = el('social-yt-desc');
  if (ytDesc) ytDesc.value = _autoDesc(src, 0);
  const twCaption = el('social-tw-caption');
  if (twCaption) {
    twCaption.value = _autoCaption(src, 0);
    const ct = el('social-tw-charcount'); if (ct) ct.textContent = twCaption.value.length + '/280';
  }
}

el('btn-yt-autoname')?.addEventListener('click', () => {
  if (!_socialClip) return showToast('Select a clip first', 'error');
  _applyAutoNaming();
  showToast('Names regenerated');
});

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

// ── Bumper files (intro / outro) ──────────────────────────────────────────────
// A real branded end card beats a generated slate, so these are wired for both the Composer and
// the Weekly panel off one pair of data attributes. The path text box is read-only: it holds an
// absolute path ffmpeg has to be able to open, not something worth hand-typing.
function _setBumperField(id, value) {
  const inp = el(id);
  if (!inp) return;
  inp.value = value || '';
  inp.title = value || '';
  inp.classList.toggle('set', !!value);
  _syncBumperRows();
}

// The "hold for N seconds" control is meaningless for a video bumper — only show it when a
// still image is actually in play.
function _syncBumperRows() {
  const isImg = p => /\.(png|jpe?g|webp|bmp|gif|avif)$/i.test(p || '');
  const row = el('social-bumper-imgdur-row');
  if (row) row.style.display = (isImg(el('social-intro-file')?.value) || isImg(el('social-outro-file')?.value)) ? '' : 'none';
}

// Collect the compose-facing fields from a pair of bumper inputs.
function _bumperOpts(introId, outroId, durId) {
  const dur = parseFloat(el(durId)?.value || '4') || 4;
  const out = {};
  const i = el(introId)?.value || '';
  const o = el(outroId)?.value || '';
  if (i) { out.introFile = i; out.introFileDuration = dur; }
  if (o) { out.outroFile = o; out.outroFileDuration = dur; }
  return out;
}

document.querySelectorAll('[data-pick-bumper]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const target = btn.dataset.pickBumper;
    try {
      const r = await fetch('http://localhost:3000/api/social/pick-bumper', { method: 'POST' });
      const data = await r.json();
      if (data.canceled) return;
      if (data.error) throw new Error(data.error);
      _setBumperField(target, data.path);
      showToast('Bumper set');
    } catch (e) { showToast('Could not pick a file: ' + e.message, 'error'); }
  });
});
document.querySelectorAll('[data-clear-bumper]').forEach(btn => {
  btn.addEventListener('click', () => _setBumperField(btn.dataset.clearBumper, ''));
});

// The vertical framing picker only matters once something is going out 9:16.
function _syncVerticalFitRows() {
  const row = el('social-shorts-fit-row');
  if (row) row.style.display = (el('social-yt-shorts')?.checked || el('social-branding-vertical')?.checked) ? '' : 'none';
  const sqRow = el('sq-fit-row');
  if (sqRow) sqRow.style.display = (el('sq-shorts')?.checked || el('sq-vertical')?.checked) ? '' : 'none';
}
['social-yt-shorts', 'social-branding-vertical', 'sq-shorts', 'sq-vertical']
  .forEach(id => el(id)?.addEventListener('change', _syncVerticalFitRows));
_syncVerticalFitRows();

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
  const isShort     = !!el('social-yt-shorts')?.checked;
  const vertical    = isShort || !!el('social-branding-vertical')?.checked;
  const verticalFit = el('social-shorts-fit')?.value || 'crop';
  const brandColor  = el('social-branding-color')?.value || '#7c3aed';
  const bumpers     = _bumperOpts('social-intro-file', 'social-outro-file', 'social-bumper-imgdur');
  const hasBumper   = !!(bumpers.introFile || bumpers.outroFile);
  const post = {
    clipType: _socialClip.type, clipVideoUrl: _socialClip.clipVideoUrl || null, clipPath: _socialClip.clipPath || null,
    thumbnailUrl: _socialClip.thumbnailUrl || null, clipUrl: _socialClip.clipUrl || null,
    title: el('social-yt-title')?.value || _socialClip.title || 'Clip',
    ytVisibility: el('social-yt-visibility')?.value || 'public',
    isShort,
    captions: { youtube: el('social-yt-desc')?.value || '', twitter: el('social-tw-caption')?.value || '' },
    trimIn:  _socialClip.trimIn  || 0,
    trimOut: _socialClip.trimOut || null,
    // A Short still needs the 9:16 pass even with no intro/outro template selected —
    // YouTube goes by aspect ratio, not by the #Shorts tag.
    intro: (hasBranding || hasBumper || vertical) ? {
      template:  hasBranding ? brandingTmpl : 'none',
      text:      el('social-branding-text')?.value     || el('social-yt-title')?.value || '',
      color:     brandColor,
      duration:  parseFloat(el('social-branding-duration')?.value || '2'),
      outro:     !!el('social-branding-outro')?.checked,
      vertical,
      verticalFit,
      verticalBg: brandColor,
      ...bumpers,
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

/* ══════════════════════════════════════════════════════════════════════════════
   Auto Queue — bulk pipeline
   Tick clips on the Clips tab → auto-name each from Twitch + show state → spread them over a
   drip schedule → hand the whole batch to /api/social/schedule one at a time. YouTube does the
   actual timing (publishAt), so "scheduling" here means uploading now and releasing later.
   ══════════════════════════════════════════════════════════════════════════════ */

// (_bulkPicked / _sqRows / _sqSending are declared in the State block at the top of this file.)

// ── Selection on the Clips tab ────────────────────────────────────────────────
function _renderBulkCount() {
  const n = _bulkPicked.size;
  const lbl = el('social-bulk-count');
  if (lbl) lbl.textContent = n === 1 ? '1 selected' : n + ' selected';
  const btn = el('btn-clips-to-queue');
  if (btn) { btn.disabled = !n; btn.textContent = n ? 'Add ' + n + ' to Auto Queue' : 'Add to Auto Queue'; }
}

function _setBulkSelection(ids) {
  _bulkPicked.clear();
  ids.forEach(id => _bulkPicked.add(id));
  _renderTwitchClipCards(_allTwitchClips);
  _renderBulkCount();
}

el('btn-clips-select-all')?.addEventListener('click',  () => _setBulkSelection(_allTwitchClips.map(c => c.id)));
el('btn-clips-select-none')?.addEventListener('click', () => _setBulkSelection([]));
el('btn-clips-select-top')?.addEventListener('click',  () => _setBulkSelection(
  [..._allTwitchClips].sort((a, b) => (b.view_count || 0) - (a.view_count || 0)).slice(0, 10).map(c => c.id)
));

el('btn-clips-to-queue')?.addEventListener('click', () => {
  const picked = _allTwitchClips.filter(c => _bulkPicked.has(c.id));
  if (!picked.length) return showToast('Tick some clips first', 'error');
  // Newest-first is how a producer thinks about a night's clips; keep the Clips-tab sort.
  const sort = el('social-clip-sort')?.value || 'recent';
  picked.sort((a, b) => sort === 'views'
    ? (b.view_count || 0) - (a.view_count || 0)
    : new Date(b.created_at || 0) - new Date(a.created_at || 0));
  const already = new Set(_sqRows.map(r => r.clip.id));
  picked.forEach(clip => { if (!already.has(clip.id)) _sqRows.push({ clip, status: '' }); });
  _sqRegenerateNames();
  _sqAssignTimes();
  _sqShowPanel();
  showToast(picked.length + ' clip' + (picked.length === 1 ? '' : 's') + ' queued');
});

// ── Naming ────────────────────────────────────────────────────────────────────
function _sqRegenerateNames() {
  // Templates live in the same localStorage keys the Composer uses, so a template saved in
  // either place drives both. Read the live inputs first so an unsaved edit still previews.
  const t = el('sq-tmpl-title')?.value;
  const d = el('sq-tmpl-desc')?.value;
  const c = el('sq-tmpl-caption')?.value;
  _sqRows.forEach((row, i) => {
    if (row.status === 'done') return;   // already uploaded — renaming it here would be a lie
    row.title   = _tidyLine(_fillSocialTemplate(t || SOCIAL_DEFAULT_TITLE,   row.clip, i)).slice(0, 100);
    row.desc    = _fillSocialTemplate(d || SOCIAL_DEFAULT_DESC,    row.clip, i);
    row.caption = _fillSocialTemplate(c || SOCIAL_DEFAULT_CAPTION, row.clip, i).slice(0, 280);
    if (!row.title) row.title = (row.clip.title || 'Clip').slice(0, 100);
  });
}

// ── Drip schedule ─────────────────────────────────────────────────────────────
// Two modes. "slots" drops posts onto fixed times of day, rolling to the next day when the
// day's slots are used up. "interval" just steps forward N hours from the start.
function _sqSlotTimes() {
  return String(el('sq-slots')?.value || '')
    .split(',')
    .map(s => s.trim())
    .map(s => /^(\d{1,2}):(\d{2})$/.exec(s))
    .filter(Boolean)
    .map(m => ({ h: Math.min(23, +m[1]), m: Math.min(59, +m[2]) }))
    .sort((a, b) => a.h - b.h || a.m - b.m);
}

function _sqAssignTimes() {
  const startVal = el('sq-start')?.value;
  const floor    = Math.max(Date.now() + 5 * 60000, startVal ? new Date(startVal).getTime() : 0);
  const mode     = el('sq-mode')?.value || 'slots';
  // Rows already handed to YouTube keep their time — re-dripping them would only mislead, since
  // the upload has happened and the publish time is now YouTube's to hold.
  const open = _sqRows.filter(r => r.status !== 'done');

  if (mode === 'interval') {
    const hours = Math.max(1, parseInt(el('sq-interval')?.value, 10) || 6);
    open.forEach((row, i) => { row.at = floor + i * hours * 3600000; });
  } else {
    const slots = _sqSlotTimes();
    if (!slots.length) {   // no parseable slot times — fall back to one a day at the start time
      open.forEach((row, i) => { row.at = floor + i * 86400000; });
    } else {
      const times = [];
      const day = new Date(floor); day.setHours(0, 0, 0, 0);
      // Walk forward day by day filling slots; guard the loop so a bad input can't spin forever.
      for (let d = 0; times.length < open.length && d < 400; d++) {
        for (const s of slots) {
          const dt = new Date(day.getFullYear(), day.getMonth(), day.getDate() + d, s.h, s.m, 0, 0).getTime();
          if (dt < floor) continue;
          times.push(dt);
          if (times.length >= open.length) break;
        }
      }
      open.forEach((row, i) => { row.at = times[i] ?? (floor + i * 86400000); });
    }
  }
  _sqRenderRows();
  _sqRenderSummary();
}

function _sqRenderSummary() {
  const sum = el('sq-sched-summary');
  if (!sum) return;
  if (!_sqRows.length) { sum.textContent = ''; return; }
  const first = _sqRows[0].at, last = _sqRows[_sqRows.length - 1].at;
  sum.textContent = _sqRows.length === 1
    ? new Date(first).toLocaleString()
    : new Date(first).toLocaleString() + '  →  ' + new Date(last).toLocaleString();
}

// ── Rows ──────────────────────────────────────────────────────────────────────
function _dtLocalValue(ms) {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

function _sqRenderRows() {
  const host = el('sq-rows'); if (!host) return;
  const count = el('sq-count'); if (count) count.textContent = _sqRows.length ? '· ' + _sqRows.length : '';
  const badge = el('social-queue-badge');
  if (badge) { badge.style.display = _sqRows.length ? '' : 'none'; badge.textContent = _sqRows.length; }
  host.innerHTML = '';
  _sqRows.forEach((row, i) => {
    const div = document.createElement('div');
    div.className = 'sq-row' + (row.status === 'done' ? ' done' : row.status === 'failed' ? ' failed' : '');
    div.innerHTML = `
      <img src="${esc(row.clip.thumbnail_url || '')}" alt="">
      <div class="sq-row-main">
        <input type="text" class="input-text" data-f="title" maxlength="100" value="${esc(row.title || '')}" style="width:100%;box-sizing:border-box;font-size:12px;">
        <details>
          <summary>Description${el('sq-plat-twitter')?.checked ? ' &amp; caption' : ''}</summary>
          <textarea data-f="desc">${esc(row.desc || '')}</textarea>
          ${el('sq-plat-twitter')?.checked ? `<textarea data-f="caption" maxlength="280" placeholder="X / Twitter caption">${esc(row.caption || '')}</textarea>` : ''}
        </details>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
        <input type="datetime-local" data-f="at" class="input-text" value="${row.at ? _dtLocalValue(row.at) : ''}" style="font-size:11px;padding:2px 4px;">
        <span class="sq-status" style="color:${row.status === 'done' ? '#48bb78' : row.status === 'failed' ? '#ef4444' : 'var(--muted)'};">${esc(row.error || row.status || '')}</span>
        <button class="btn btn-ghost btn-xs" data-rm>Remove</button>
      </div>`;
    div.querySelectorAll('[data-f]').forEach(inp => {
      inp.addEventListener('input', () => {
        const f = inp.dataset.f;
        if (f === 'at') { const t = new Date(inp.value).getTime(); if (!isNaN(t)) { row.at = t; _sqRenderSummary(); } }
        else row[f] = inp.value;
      });
    });
    div.querySelector('[data-rm]').addEventListener('click', () => {
      _sqRows.splice(i, 1);
      _bulkPicked.delete(row.clip.id);
      _renderBulkCount();
      if (!_sqRows.length) return _sqShowPanel();
      _sqRenderRows();
      _sqRenderSummary();
    });
    host.appendChild(div);
  });
}

function _sqShowPanel() {
  const empty = el('social-queue-empty'), body = el('social-queue-body');
  if (empty) empty.style.display = _sqRows.length ? 'none' : '';
  if (body)  body.style.display  = _sqRows.length ? '' : 'none';
  const badge = el('social-queue-badge');
  if (badge) { badge.style.display = _sqRows.length ? '' : 'none'; badge.textContent = _sqRows.length; }
  document.querySelectorAll('.social-sub-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.stab === 'queue'));
  document.querySelectorAll('.social-sub-panel').forEach(p => p.classList.toggle('active', p.id === 'social-panel-queue'));
  _sqRenderRows();
  _sqRenderSummary();
}

// ── Panel wiring ──────────────────────────────────────────────────────────────
(function _sqInit() {
  const tokenHost = el('sq-token-list');
  if (tokenHost) {
    // Click a token to append it to whichever template field was last focused.
    tokenHost.innerHTML = SOCIAL_TOKENS
      .map(([tok, desc]) => `<span class="sq-token" title="${esc(desc)}">${esc(tok)}</span>`).join('');
    let lastField = el('sq-tmpl-title');
    ['sq-tmpl-title', 'sq-tmpl-desc', 'sq-tmpl-caption'].forEach(id =>
      el(id)?.addEventListener('focus', e => { lastField = e.currentTarget; }));
    tokenHost.querySelectorAll('.sq-token').forEach(sp => sp.addEventListener('click', () => {
      if (!lastField) return;
      lastField.value += (lastField.value && !/\s$/.test(lastField.value) ? ' ' : '') + sp.textContent;
      lastField.focus();
    }));
  }

  // Seed the template fields from saved defaults.
  const ti = el('sq-tmpl-title');   if (ti) ti.value = _getSocialTemplate(_TMPL_TITLE) || SOCIAL_DEFAULT_TITLE;
  const de = el('sq-tmpl-desc');    if (de) de.value = _getSocialTemplate(_TMPL_YT)    || SOCIAL_DEFAULT_DESC;
  const ca = el('sq-tmpl-caption'); if (ca) ca.value = _getSocialTemplate(_TMPL_TW)    || SOCIAL_DEFAULT_CAPTION;

  const start = el('sq-start');
  if (start) {
    const d = new Date(Date.now() + 30 * 60000);
    start.min = start.value = _dtLocalValue(d.getTime());
  }

  el('sq-mode')?.addEventListener('change', function () {
    const slots = this.value === 'slots';
    const sf = el('sq-slots-field'),    inf = el('sq-interval-field');
    if (sf)  sf.style.display  = slots ? '' : 'none';
    if (inf) inf.style.display = slots ? 'none' : '';
    _sqAssignTimes();
  });
  ['sq-start', 'sq-slots', 'sq-interval'].forEach(id => el(id)?.addEventListener('change', _sqAssignTimes));

  el('sq-plat-twitter')?.addEventListener('change', function () {
    const f = el('sq-tw-caption-field'); if (f) f.style.display = this.checked ? '' : 'none';
    _sqRenderRows();
  });

  el('btn-sq-regen')?.addEventListener('click', () => {
    _sqRegenerateNames();
    _sqRenderRows();
    showToast('Names regenerated');
  });

  el('btn-sq-save-tmpl')?.addEventListener('click', () => {
    localStorage.setItem(_TMPL_TITLE, el('sq-tmpl-title')?.value || '');
    localStorage.setItem(_TMPL_YT,    el('sq-tmpl-desc')?.value  || '');
    localStorage.setItem(_TMPL_TW,    el('sq-tmpl-caption')?.value || '');
    showToast('Templates saved as default');
  });

  el('btn-sq-clear')?.addEventListener('click', () => {
    if (_sqSending) return showToast('Still scheduling — wait for the batch to finish', 'error');
    if (!confirm('Empty the queue? Nothing already scheduled is affected.')) return;
    _sqRows = [];
    _bulkPicked.clear();
    _renderTwitchClipCards(_allTwitchClips);
    _renderBulkCount();
    _sqShowPanel();
  });

  el('btn-sq-schedule')?.addEventListener('click', _sqScheduleAll);
})();

// ── Send ──────────────────────────────────────────────────────────────────────
// One at a time: each POST kicks off a YouTube upload server-side, and firing a dozen
// concurrent uploads is a good way to trip the API's rate limits and starve the encoder.
async function _sqScheduleAll() {
  if (_sqSending) return;
  const pending = _sqRows.filter(r => r.status !== 'done');
  if (!pending.length) return showToast('Nothing left to schedule', 'error');

  const platforms = [];
  if (el('sq-plat-youtube')?.checked) platforms.push('youtube');
  if (el('sq-plat-twitter')?.checked) platforms.push('twitter');
  if (!platforms.length) return showToast('Pick at least one platform', 'error');

  const late = pending.filter(r => !r.at || r.at <= Date.now());
  if (late.length) return showToast(late.length + ' row(s) have a time in the past — fix them first', 'error');

  const visibility = el('sq-visibility')?.value || 'public';
  const isShort    = !!el('sq-shorts')?.checked;
  const vertical   = isShort || !!el('sq-vertical')?.checked;
  const verticalFit = el('sq-fit')?.value || 'crop';
  // The batch inherits the Composer's bumper choice — that's the producer's current branding, and
  // making them set it twice for one and many would only invite the two drifting apart.
  const bumpers    = _bumperOpts('social-intro-file', 'social-outro-file', 'social-bumper-imgdur');
  const hasBumper  = !!(bumpers.introFile || bumpers.outroFile);
  const btn        = el('btn-sq-schedule');
  const status     = el('sq-status');

  _sqSending = true;
  if (btn) btn.disabled = true;
  let ok = 0, failed = 0;

  for (let i = 0; i < pending.length; i++) {
    const row = pending[i];
    row.status = 'sending…';
    row.error  = '';
    _sqRenderRows();
    if (status) status.textContent = `Scheduling ${i + 1} of ${pending.length} — uploading "${row.title}"…`;
    try {
      const r = await fetch('http://localhost:3000/api/social/schedule', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clipType:     'twitch',
          clipUrl:      row.clip.url,
          clipVideoUrl: row.clip._videoUrl,
          thumbnailUrl: row.clip.thumbnail_url,
          title:        row.title,
          ytVisibility: visibility,
          isShort,
          captions:     { youtube: row.desc || '', twitter: row.caption || '' },
          trimIn: 0, trimOut: null,
          intro:  (vertical || hasBumper) ? { template: 'none', vertical, verticalFit, ...bumpers } : null,
          platforms,
          scheduledAt: row.at,
        })
      });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || ('HTTP ' + r.status));
      row.status = 'done';
      ok++;
    } catch (e) {
      row.status = 'failed';
      row.error  = e.message;
      failed++;
    }
    _sqRenderRows();
  }

  _sqSending = false;
  if (btn) { btn.disabled = false; btn.textContent = failed ? 'Retry failed rows' : 'Schedule queue'; }
  if (status) status.textContent = `${ok} scheduled` + (failed ? `, ${failed} failed — fix and hit Retry` : '. YouTube will publish each at its slot.');
  showToast(failed ? `${ok} scheduled, ${failed} failed` : `${ok} clip(s) scheduled`, failed ? 'error' : 'success');
  _loadSocialSchedule();
}

/* ══════════════════════════════════════════════════════════════════════════════
   Weekly automation panel
   Thin client over /api/social/weekly — the schedule, the selection rules and the dedup ledger
   all live server-side in backend/social-weekly.js, because the job has to fire whether or not
   this page (or any page) happens to be open.
   ══════════════════════════════════════════════════════════════════════════════ */

let _wkStatus = null;

const _WK_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function _wkFmt(ms) { return ms ? new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'; }

async function _loadWeekly() {
  try {
    const r = await fetch('http://localhost:3000/api/social/weekly');
    const s = await r.json();
    if (s.error) throw new Error(s.error);
    _wkStatus = s;
    _wkFillForm(s);
    _wkRenderStaged(s);
    _wkRenderHistory(s);
  } catch (e) {
    const st = el('wk-status'); if (st) st.textContent = 'Could not load automation: ' + e.message;
  }
}

function _wkFillForm(s) {
  const c = s.config || {};
  const set = (id, v) => { const n = el(id); if (n != null && n) n.value = v; };
  const chk = (id, v) => { const n = el(id); if (n) n.checked = !!v; };

  chk('wk-enabled', c.enabled);
  document.querySelectorAll('.wk-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.wkmode === (c.mode || 'review')));
  set('wk-day', String(c.dayOfWeek ?? 1));
  set('wk-time', `${String(c.hour ?? 10).padStart(2, '0')}:${String(c.minute ?? 0).padStart(2, '0')}`);
  set('wk-lookback', String(c.lookbackDays ?? 7));
  set('wk-sort', c.sort || 'views');
  set('wk-max', c.maxClips ?? 5);
  set('wk-minviews', c.minViews ?? 0);
  set('wk-slots', (c.slots || ['17:00']).join(', '));
  set('wk-offset', String(c.startOffsetHours ?? 2));
  set('wk-visibility', c.visibility || 'public');
  chk('wk-shorts', c.isShort);
  set('wk-fit', c.verticalFit || 'crop');
  _setBumperField('wk-intro-file', c.intro?.introFile || '');
  _setBumperField('wk-outro-file', c.intro?.outroFile || '');
  set('wk-tmpl-title', c.titleTemplate || SOCIAL_DEFAULT_TITLE);
  set('wk-tmpl-desc',  c.descTemplate  || SOCIAL_DEFAULT_DESC);

  const next = el('wk-next-run');
  if (next) {
    next.innerHTML = c.enabled
      ? `Next run <b>${esc(_wkFmt(s.nextRunAt))}</b>`
      : 'Automation is off';
  }
  const handled = el('wk-handled-count');
  if (handled) handled.textContent = s.handledCount ? ` ${s.handledCount} already posted.` : '';
  _wkSyncRows();
  _wkRenderDripSummary();
}

function _wkSyncRows() {
  const fit = el('wk-fit-row');
  if (fit) fit.style.display = el('wk-shorts')?.checked ? '' : 'none';
}

function _wkRenderDripSummary() {
  const sum = el('wk-drip-summary'); if (!sum) return;
  const slots = (el('wk-slots')?.value || '').split(',').map(s => s.trim()).filter(Boolean);
  const n     = parseInt(el('wk-max')?.value, 10) || 0;
  sum.textContent = slots.length && n
    ? `${n} clip${n === 1 ? '' : 's'} at ${slots.join(' & ')}`
    : '';
}

function _wkReadForm() {
  const [h, m] = String(el('wk-time')?.value || '10:00').split(':');
  const bump   = _bumperOpts('wk-intro-file', 'wk-outro-file', 'social-bumper-imgdur');
  const isShort = !!el('wk-shorts')?.checked;
  const hasBump = !!(bump.introFile || bump.outroFile);
  return {
    enabled:      !!el('wk-enabled')?.checked,
    mode:         document.querySelector('.wk-mode-btn.active')?.dataset.wkmode || 'review',
    dayOfWeek:    parseInt(el('wk-day')?.value, 10),
    hour:         parseInt(h, 10),
    minute:       parseInt(m, 10),
    lookbackDays: parseInt(el('wk-lookback')?.value, 10),
    sort:         el('wk-sort')?.value || 'views',
    maxClips:     parseInt(el('wk-max')?.value, 10),
    minViews:     parseInt(el('wk-minviews')?.value, 10),
    slots:        (el('wk-slots')?.value || '').split(',').map(s => s.trim()).filter(Boolean),
    startOffsetHours: parseInt(el('wk-offset')?.value, 10),
    visibility:   el('wk-visibility')?.value || 'public',
    isShort,
    verticalFit:  el('wk-fit')?.value || 'crop',
    intro:        (isShort || hasBump) ? { template: 'none', vertical: isShort, ...bump } : null,
    titleTemplate:   el('wk-tmpl-title')?.value || '',
    descTemplate:    el('wk-tmpl-desc')?.value  || '',
    captionTemplate: '',
    platforms:    ['youtube'],
  };
}

// ── Staged batch (review mode) ────────────────────────────────────────────────
function _wkRenderStaged(s) {
  const card = el('wk-staged-card');
  const host = el('wk-staged-rows');
  const rows = (s && s.staged) || [];
  const badge = el('social-weekly-badge');
  if (badge) { badge.style.display = rows.length ? '' : 'none'; badge.textContent = rows.length; }
  if (!card || !host) return;
  card.style.display = rows.length ? '' : 'none';
  const count = el('wk-staged-count');
  if (count) count.textContent = rows.length ? `${rows.length} clip${rows.length === 1 ? '' : 's'} from the last run` : '';
  if (!rows.length) { host.innerHTML = ''; return; }

  host.innerHTML = '';
  rows.forEach((row, i) => {
    const div = document.createElement('div');
    div.className = 'sq-row';
    div.innerHTML = `
      <img src="${esc(row.clip?.thumbnail_url || '')}" alt="">
      <div class="sq-row-main">
        <input type="text" class="input-text" data-wf="title" maxlength="100" value="${esc(row.title || '')}" style="width:100%;box-sizing:border-box;font-size:12px;">
        <details>
          <summary>Description</summary>
          <textarea data-wf="desc">${esc(row.desc || '')}</textarea>
        </details>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
        <input type="datetime-local" data-wf="at" class="input-text" value="${row.at ? _dtLocalValue(row.at) : ''}" style="font-size:11px;padding:2px 4px;">
        <span class="sq-status">${esc((row.clip?.view_count || 0).toLocaleString())} views</span>
        <button class="btn btn-ghost btn-xs" data-wrm>Remove</button>
      </div>`;
    div.querySelectorAll('[data-wf]').forEach(inp => inp.addEventListener('input', () => {
      const f = inp.dataset.wf;
      if (f === 'at') { const t = new Date(inp.value).getTime(); if (!isNaN(t)) row.at = t; }
      else row[f] = inp.value;
    }));
    div.querySelector('[data-wrm]').addEventListener('click', () => {
      rows.splice(i, 1);
      _wkRenderStaged(_wkStatus);
    });
    host.appendChild(div);
  });
}

function _wkRenderHistory(s) {
  const host = el('wk-history'); if (!host) return;
  const hist = (s && s.history) || [];
  if (!hist.length) { host.innerHTML = '<div style="color:var(--muted);font-size:12px;">No runs yet.</div>'; return; }
  host.innerHTML = '';
  hist.forEach(h => {
    const bad  = (h.errors || []).length;
    const did  = h.scheduled ? `scheduled ${h.scheduled}` : h.staged ? `staged ${h.staged}` : 'nothing to do';
    const pill = bad ? 'bad' : (h.scheduled || h.staged) ? 'ok' : 'warn';
    const row = document.createElement('div');
    row.className = 'wk-hist-row';
    row.innerHTML = `
      <span class="wk-when">${esc(_wkFmt(h.at))}</span>
      <span class="wk-what">${esc(did)} · scanned ${h.scanned || 0}${bad ? ' · ' + bad + ' failed' : ''}${h.note ? ' · ' + esc(h.note) : ''}</span>
      <span class="wk-pill ${pill}">${esc((h.trigger || '').toUpperCase())}</span>`;
    if (bad) row.title = (h.errors || []).join('\n');
    host.appendChild(row);
  });
}

// ── Wiring ────────────────────────────────────────────────────────────────────
(function _wkInit() {
  document.querySelectorAll('.wk-mode-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.wk-mode-btn').forEach(b => b.classList.toggle('active', b === btn));
  }));
  el('wk-shorts')?.addEventListener('change', _wkSyncRows);
  ['wk-slots', 'wk-max'].forEach(id => el(id)?.addEventListener('input', _wkRenderDripSummary));

  const tokenHost = el('wk-token-list');
  if (tokenHost) {
    tokenHost.innerHTML = SOCIAL_TOKENS.map(([tok, desc]) => `<span class="sq-token" title="${esc(desc)}">${esc(tok)}</span>`).join('');
    let lastField = el('wk-tmpl-title');
    ['wk-tmpl-title', 'wk-tmpl-desc'].forEach(id => el(id)?.addEventListener('focus', e => { lastField = e.currentTarget; }));
    tokenHost.querySelectorAll('.sq-token').forEach(sp => sp.addEventListener('click', () => {
      if (!lastField) return;
      lastField.value += (lastField.value && !/\s$/.test(lastField.value) ? ' ' : '') + sp.textContent;
      lastField.focus();
    }));
  }

  el('btn-wk-save')?.addEventListener('click', async () => {
    const st = el('wk-status');
    try {
      const r = await fetch('http://localhost:3000/api/social/weekly', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(_wkReadForm())
      });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || ('HTTP ' + r.status));
      _wkStatus = data.status;
      _wkFillForm(data.status);
      showToast('Automation saved');
      const c = data.status.config;
      if (st) st.textContent = c.enabled
        ? `Runs every ${_WK_DAYS[c.dayOfWeek]} at ${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')} — ${c.mode === 'auto' ? 'scheduling automatically' : 'staging for review'}.`
        : 'Saved. Automation is off — tick the box above to arm it.';
    } catch (e) {
      showToast('Save failed: ' + e.message, 'error');
      if (st) st.textContent = 'Save failed: ' + e.message;
    }
  });

  el('btn-wk-preview')?.addEventListener('click', async () => {
    const host = el('wk-preview');
    if (host) host.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:6px 0;">Checking Twitch…</div>';
    try {
      // Preview reflects the CURRENT form, so save first — otherwise it answers for the old rules.
      await fetch('http://localhost:3000/api/social/weekly', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(_wkReadForm())
      });
      const r = await fetch('http://localhost:3000/api/social/weekly/preview');
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
      if (!host) return;
      if (!d.picked.length) {
        host.innerHTML = `<div style="font-size:11px;color:var(--muted);padding:6px 0;">Nothing new in the last ${el('wk-lookback')?.value || 7} days (scanned ${d.scanned}).</div>`;
        return;
      }
      host.innerHTML = `<div style="font-size:11px;color:var(--muted);margin:8px 0 4px;">Would take ${d.picked.length} of ${d.eligible} eligible (scanned ${d.scanned}):</div>`;
      d.picked.forEach(p => {
        const row = document.createElement('div');
        row.className = 'wk-hist-row';
        row.innerHTML = `<span class="wk-what">${esc(p.title)}</span><span class="wk-when">${esc((p.clip.view_count || 0).toLocaleString())} views</span>`;
        row.title = p.desc || '';
        host.appendChild(row);
      });
    } catch (e) {
      if (host) host.innerHTML = `<div style="font-size:11px;color:#ef4444;padding:6px 0;">${esc(e.message)}</div>`;
    }
  });

  el('btn-wk-run')?.addEventListener('click', async () => {
    const mode = document.querySelector('.wk-mode-btn.active')?.dataset.wkmode || 'review';
    if (mode === 'auto' && !confirm('Run now in automatic mode?\n\nThis uploads and schedules the picked clips to YouTube straight away — no review step.')) return;
    const btn = el('btn-wk-run'), st = el('wk-status');
    if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
    if (st) st.textContent = 'Pulling clips from Twitch…';
    try {
      // Save first so the run uses what's on screen, not what was last persisted.
      await fetch('http://localhost:3000/api/social/weekly', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(_wkReadForm())
      });
      const r = await fetch('http://localhost:3000/api/social/weekly/run', { method: 'POST' });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
      _wkStatus = d.status;
      _wkFillForm(d.status); _wkRenderStaged(d.status); _wkRenderHistory(d.status);
      const e = d.entry || {};
      if (st) st.textContent = e.scheduled ? `Scheduled ${e.scheduled} clip(s).`
        : e.staged ? `Staged ${e.staged} clip(s) — review them above.`
        : (e.note || 'Nothing to do.');
      showToast(e.scheduled || e.staged ? 'Weekly run complete' : 'Nothing new to post');
    } catch (e) {
      showToast('Run failed: ' + e.message, 'error');
      if (st) st.textContent = 'Run failed: ' + e.message;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Run now'; }
    }
  });

  el('btn-wk-approve')?.addEventListener('click', async () => {
    const rows = (_wkStatus && _wkStatus.staged) || [];
    if (!rows.length) return;
    const btn = el('btn-wk-approve');
    if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
    try {
      const r = await fetch('http://localhost:3000/api/social/weekly/approve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows })
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
      _wkStatus = d.status;
      _wkRenderStaged(d.status); _wkRenderHistory(d.status); _wkFillForm(d.status);
      showToast(d.errors?.length ? `${d.scheduled} scheduled, ${d.errors.length} failed` : `${d.scheduled} clip(s) scheduled`,
        d.errors?.length ? 'error' : 'success');
      _loadSocialSchedule();
    } catch (e) {
      showToast('Approve failed: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Schedule these'; }
    }
  });

  el('btn-wk-discard')?.addEventListener('click', async () => {
    if (!confirm('Discard this batch? The clips stay eligible, so a later run can offer them again.')) return;
    try {
      const r = await fetch('http://localhost:3000/api/social/weekly/discard', { method: 'POST' });
      const d = await r.json();
      _wkStatus = d.status;
      _wkRenderStaged(d.status);
      showToast('Batch discarded');
    } catch (e) { showToast('Failed: ' + e.message, 'error'); }
  });

  el('btn-wk-forget')?.addEventListener('click', async () => {
    if (!confirm('Reset the posted-clip history?\n\nEvery clip becomes eligible again, so a run could re-post something already on YouTube.')) return;
    try {
      await fetch('http://localhost:3000/api/social/weekly/forget', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
      });
      showToast('History reset');
      _loadWeekly();
    } catch (e) { showToast('Failed: ' + e.message, 'error'); }
  });
})();

// A cron-fired run can land while the page is open — refresh so a staged batch shows up without
// the producer having to know to reload. app.js dispatches these off the WS feed.
window.addEventListener('social-weekly-event', () => _loadWeekly());

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
    const minBtn   = document.getElementById('obs-prev-min');
    const dragHdr  = document.getElementById('obs-prev-drag');
    const modeCam  = document.getElementById('obs-prev-mode-cam');
    const modeScr  = document.getElementById('obs-prev-mode-scr');
    const modeGfx  = document.getElementById('obs-prev-mode-gfx');
    const gfxWrap  = document.getElementById('obs-prev-gfx');
    const gfxIframe = document.getElementById('obs-prev-gfx-iframe');
    if (!panel || !btn) return;

    // ── State ──
    let active     = false;
    let minimized  = false;
    let mode    = 'cam';          // 'cam' | 'gfx' — SCR (screenshot polling) was removed from this panel
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

    function setMinimized(val) {
      minimized = val;
      panel.classList.toggle('minimized', minimized);
      if (minBtn) minBtn.title = minimized ? 'Restore (or double-click header)' : 'Minimize (or double-click header)';
    }

    function setMode(m) {
      mode = (m === 'gfx') ? 'gfx' : 'cam';
      modeCam.classList.toggle('active', mode === 'cam');
      if (modeGfx) modeGfx.classList.toggle('active', mode === 'gfx');
      if (modeScr) modeScr.style.display = 'none';
      fpsBtn.style.display = 'none';
      pauseBtn.style.display = 'none';
      img.style.display = 'none';
      video.style.display = (mode === 'cam') ? '' : 'none';
      if (gfxWrap) gfxWrap.style.display = (mode === 'gfx') ? '' : 'none';
    }

    // ── GFX mode: mirrors whatever scene is currently being edited in the Graphics hub.
    // Reuses the SAME scaling technique as the inline preview (fitScenePreviews() picks up any
    // .live-pv-wrapped iframe automatically) rather than a second bespoke sizing scheme. ──
    function syncGfxPreview() {
      if (!gfxIframe || typeof window._gfxCurrentPreviewUrl !== 'function') return;
      const url = window._gfxCurrentPreviewUrl();
      if (url && gfxIframe.getAttribute('src') !== url) gfxIframe.src = url;
      if (typeof window._fitScenePreviews === 'function') window._fitScenePreviews();
    }
    function startGfx() {
      syncGfxPreview();
      setMsg(gfxIframe && gfxIframe.getAttribute('src') ? '' : 'Open the Graphics hub and pick a scene to preview it here.');
    }
    function stopGfx() {
      if (gfxIframe) gfxIframe.removeAttribute('src');
    }
    // Called by the Graphics hub (gfxApplyPreview) every time the edited scene changes, so this
    // stays live even while it's not the active mode — flipping to GFX later shows the right scene
    // immediately instead of a stale one from whenever GFX was last active.
    window._obsPrevSyncGfx = syncGfxPreview;
    // Entry point for the Graphics hub's own "Pop out preview" button.
    window._obsPreviewOpenGfx = () => { if (active) switchMode('gfx'); else open('gfx'); };

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
    // preferMode lets a caller (the Graphics hub's "Pop out preview" button) open straight into
    // GFX regardless of whichever mode was last used — otherwise reopens on the persisted mode.
    function open(preferMode) {
      active = true;
      panel.style.display = '';
      btn.classList.add('active');
      fpsBtn.textContent = FPS_LBLS[fpsIdx];
      frameCount = 0; frameTs = Date.now();
      const m = preferMode || mode;
      setMode(m);
      if (m === 'gfx') startGfx(); else startCam();
    }

    function close() {
      active = false;
      setMinimized(false);
      clearTimeout(timer); clearInterval(fpsTimer);
      stopCam(); stopGfx();
      panel.style.display = 'none';
      btn.classList.remove('active');
      img.src = '';
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = ''; }
      setMsg('Connect OBS to enable preview');
    }

    function switchMode(m) {
      if (m === mode) {
        if (m === 'cam') { stopCam(); if (active) startCam(); }   // re-click CAM = retry
        else if (m === 'gfx') syncGfxPreview();                    // re-click GFX = re-sync now
        return;
      }
      if (mode === 'cam') stopCam();
      if (mode === 'gfx') stopGfx();
      setMode(m);
      if (active) {
        frameCount = 0; frameTs = Date.now();
        if (m === 'cam') startCam(); else if (m === 'gfx') startGfx();
      }
      try { localStorage.setItem('ne_obs_prev_mode', m); } catch (_) {}
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
    if (minBtn) minBtn.addEventListener('click', () => setMinimized(!minimized));
    // Double-click anywhere on the header (not on buttons/tabs) toggles minimize
    dragHdr.addEventListener('dblclick', (e) => {
      if (e.target.closest('.obs-prev-btn, .obs-prev-modetab, .obs-prev-modetabs')) return;
      setMinimized(!minimized);
    });
    modeCam.addEventListener('click', () => switchMode('cam'));
    if (modeGfx) modeGfx.addEventListener('click', () => switchMode('gfx'));
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

    // ── Resizable from the left, right, or bottom edge ──
    // Only ever adjusts width — height always follows via .obs-prev-body's own aspect-ratio:16/9,
    // so the feed can be grabbed from any of these 3 sides and can never be dragged out of 16:9.
    // Dragging the bottom edge maps its vertical delta to an equivalent width change (16/9 ratio)
    // so "make it bigger by pulling down" still works, just via width under the hood.
    const RESIZE_MIN = 320, RESIZE_MAX = 1600;
    function initResizeHandle(handle, edge) {
      if (!handle) return;
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        const rect = panel.getBoundingClientRect();
        const startX = e.clientX, startY = e.clientY, startW = rect.width;
        // Pin the panel to its current on-screen position via explicit left/top, then only the
        // dragged edge's side is left free to move — works regardless of whether the panel is
        // still at its default right/bottom-anchored spot or was already dragged elsewhere.
        panel.style.left = rect.left + 'px';
        panel.style.top = rect.top + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        handle.classList.add('is-dragging');
        function onMove(ev) {
          let newW = startW;
          if (edge === 'l') newW = startW + (startX - ev.clientX);
          else if (edge === 'r') newW = startW + (ev.clientX - startX);
          else if (edge === 'b') newW = startW + (ev.clientY - startY) * (16 / 9);
          newW = Math.max(RESIZE_MIN, Math.min(RESIZE_MAX, newW));
          panel.style.width = newW + 'px';
          if (edge === 'l') panel.style.left = (rect.right - newW) + 'px';   // keep right edge fixed
        }
        function onUp() {
          handle.classList.remove('is-dragging');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }
    initResizeHandle(document.getElementById('obs-prev-resize-l'), 'l');
    initResizeHandle(document.getElementById('obs-prev-resize-r'), 'r');
    initResizeHandle(document.getElementById('obs-prev-resize-b'), 'b');

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

