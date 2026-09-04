/* obs-preview.js - the OBS Program Preview panel (topbar #btn-obs-preview).
   Extracted from control-panel/social.js when the Social feature was removed (2026-09-02):
   it sat at the end of that file but has nothing to do with social publishing. Self-contained
   IIFE with no dependency on the Social page. */

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
        const res = await fetch('http://127.0.0.1:3000/api/obs/screenshot?t=' + Date.now());
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
