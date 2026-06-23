const fs = require('fs');
const path = require('path');
const fsp = require('fs/promises');

const CAPTURE_COOLDOWN_MS = 3000;
const CAPTURE_COOLDOWN_FORCE_MS = 800;

/**
 * Clip library + auto-capture from OBS replay buffer.
 */
function createClipManager({ dataDir, getObsClient, onUpdate, onCapture }) {
  const clipsDir = path.join(dataDir, 'clips');
  const metaFile = path.join(dataDir, 'clips-library.json');
  let library = [];
  let montages = [];
  let settings = {
    autoCapture: true,
    replayFolder: '',
    captureRules: {
      goal: true, ace: true, clutch: true, save: true, multi_kill: true, defuse: true,
      kickoff: false, demo: false, shot: false
    }
  };
  let lastCaptureAt = 0;
  let lastCaptureError = null;
  const recentCaptureKeys = new Map();

  function load() {
    try {
      if (fs.existsSync(metaFile)) {
        const saved = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        library = Array.isArray(saved.library) ? saved.library : [];
        montages = Array.isArray(saved.montages) ? saved.montages : [];
        if (saved.settings) settings = { ...settings, ...saved.settings };
      }
    } catch (e) {
      library = [];
      montages = [];
    }
  }

  async function save() {
    try {
      await fsp.mkdir(dataDir, { recursive: true });
      await fsp.mkdir(clipsDir, { recursive: true });
      await fsp.writeFile(metaFile, JSON.stringify({ library, montages, settings }, null, 2));
    } catch (e) {
      console.error('[Clips] save failed:', e.message);
    }
    emit();
  }

  function emit() {
    if (onUpdate) {
      onUpdate({
        library: library.slice(0, 200),
        montages,
        ...settings
      });
    }
  }

  async function findNewestReplayFile(folder, afterMs) {
    if (!folder || !fs.existsSync(folder)) return null;
    const entries = await fsp.readdir(folder, { withFileTypes: true });
    let best = null;
    let bestMtime = afterMs || 0;
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (!['.mp4', '.mkv', '.mov', '.flv'].includes(ext)) continue;
      const full = path.join(folder, ent.name);
      const st = await fsp.stat(full);
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        best = full;
      }
    }
    return best;
  }

  async function importReplayFile(filePath, meta) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    await fsp.mkdir(clipsDir, { recursive: true });
    const ext = path.extname(filePath) || '.mp4';
    const id = `clip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const dest = path.join(clipsDir, `${id}${ext}`);
    try {
      await fsp.copyFile(filePath, dest);
    } catch (e) {
      // If copy fails (same drive move), try hardlink
      try {
        await fsp.link(filePath, dest);
      } catch (e2) {
        return null;
      }
    }
    const clip = {
      id,
      path: dest,
      sourceFile: path.resolve(filePath),   // original OBS folder path for staging-area matching
      name: meta.label || meta.type || 'Highlight',
      type: meta.type || 'highlight',
      game: meta.game || '',
      player: meta.player || '',
      reason: meta.reason || '',
      createdAt: Date.now(),
      duration: meta.duration || null,
      inMontage: false,
      trimIn: 0,
      trimOut: null
    };
    library.unshift(clip);
    if (library.length > 500) library.length = 500;
    await save();
    if (onCapture) onCapture(clip);
    return clip;
  }

  function shouldCapture(meta) {
    if (!settings.autoCapture && meta.type !== 'manual' && !meta.force) return false;
    if (meta.type === 'manual' || meta.force) return true;
    if (settings.captureRules[meta.type] === false) return false;
    return settings.captureRules[meta.type] !== false;
  }

  function isDuplicateCapture(meta) {
    const key = meta.captureKey
      || `${meta.type}:${meta.player || ''}:${meta.feedTs || Math.floor(Date.now() / 2000)}`;
    const prev = recentCaptureKeys.get(key);
    if (prev && Date.now() - prev < 12000) return true;
    recentCaptureKeys.set(key, Date.now());
    if (recentCaptureKeys.size > 80) {
      const cutoff = Date.now() - 60000;
      for (const [k, t] of recentCaptureKeys) {
        if (t < cutoff) recentCaptureKeys.delete(k);
      }
    }
    return false;
  }

  async function ensureReplayBuffer(obs) {
    if (!obs || !obs.isConnected()) return false;
    try {
      const active = await obs.isReplayBufferActive();
      if (!active) await obs.startReplayBuffer();
      return true;
    } catch (e) {
      return false;
    }
  }

  async function captureHighlight(meta) {
    if (!shouldCapture(meta)) return null;
    const now = Date.now();
    const cooldown = meta.force ? CAPTURE_COOLDOWN_FORCE_MS : CAPTURE_COOLDOWN_MS;
    if (now - lastCaptureAt < cooldown) return null;
    if (!meta.force && isDuplicateCapture(meta)) return null;
    lastCaptureAt = now;

    const obs = getObsClient && getObsClient();
    if (!obs || !obs.isConnected()) {
      lastCaptureError = 'OBS not connected — enable OBS in Settings.';
      console.warn('[Clips] ' + lastCaptureError);
      return null;
    }

    const buf = await ensureReplayBuffer(obs);
    if (!buf) {
      lastCaptureError = 'Replay Buffer is off — enable it in OBS (Settings → Output → Replay Buffer).';
      console.warn('[Clips] ' + lastCaptureError);
      return null;
    }

    const before = Date.now();
    // Preferred path: save + get the exact saved file from the ReplayBufferSaved
    // event, so we never have to know OBS's output folder.
    let savedPath = null;
    if (obs.saveReplayBufferAndGetPath) {
      savedPath = await obs.saveReplayBufferAndGetPath();
    } else {
      await obs.saveReplayBuffer();
    }
    if (savedPath && fs.existsSync(savedPath)) {
      lastCaptureError = null;
      return importReplayFile(savedPath, meta);
    }

    // Fallback: poll the configured replay folder for the newest file.
    const folder = settings.replayFolder;
    if (folder) {
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 400));
        const file = await findNewestReplayFile(folder, before - 2000);
        if (file) { lastCaptureError = null; return importReplayFile(file, meta); }
      }
      lastCaptureError = 'Saved a replay but could not find the file in the replay folder.';
      console.warn('[Clips] ' + lastCaptureError);
      return null;
    }

    // No event path and no folder → register a placeholder the producer can link.
    lastCaptureError = savedPath
      ? null
      : 'Saved replay, but OBS reported no path. Set the OBS replay folder, or update OBS.';
    const clip = {
      id: `clip_${Date.now()}`,
      path: null,
      name: meta.label || `${meta.type} — ${meta.player || 'highlight'}`,
      type: meta.type,
      game: meta.game,
      player: meta.player || '',
      reason: meta.reason || '',
      createdAt: Date.now(),
      pendingFile: true,
      inMontage: false,
      trimIn: 0,
      trimOut: null
    };
    library.unshift(clip);
    await save();
    return clip;
  }

  function setSettings(patch) {
    if ('autoCapture' in patch) settings.autoCapture = !!patch.autoCapture;
    if ('replayFolder' in patch) settings.replayFolder = patch.replayFolder || '';
    if (patch.captureRules) settings.captureRules = { ...settings.captureRules, ...patch.captureRules };
    save();
  }

  function removeClip(id) {
    const idx = library.findIndex((c) => c.id === id);
    if (idx < 0) return false;
    const clip = library[idx];
    if (clip.path && fs.existsSync(clip.path)) {
      try { fs.unlinkSync(clip.path); } catch (e) { /* ignore */ }
    }
    library.splice(idx, 1);
    save();
    return true;
  }

  function updateClip(id, patch) {
    const clip = library.find((c) => c.id === id);
    if (!clip) return false;
    if ('name' in patch) clip.name = patch.name;
    if ('description' in patch) clip.description = String(patch.description || '');
    if ('map' in patch) clip.map = String(patch.map || '');
    if ('trimIn' in patch) clip.trimIn = Math.max(0, Number(patch.trimIn) || 0);
    if ('trimOut' in patch) clip.trimOut = patch.trimOut != null ? Number(patch.trimOut) : null;
    save();
    return true;
  }

  function createMontage({ name, clipIds, template }) {
    const clips = clipIds.map((id) => library.find((c) => c.id === id)).filter(Boolean);
    const montage = {
      id: `montage_${Date.now()}`,
      name: name || 'Highlight Reel',
      clipIds: clips.map((c) => c.id),
      template: template || 'highlights',
      createdAt: Date.now(),
      status: 'draft'
    };
    montages.unshift(montage);
    save();
    return montage;
  }

  function reorderMontage(montageId, clipIds) {
    const m = montages.find((x) => x.id === montageId);
    if (!m || !Array.isArray(clipIds)) return false;
    m.clipIds = clipIds.filter((id) => library.some((c) => c.id === id));
    save();
    return true;
  }

  function renameMontage(montageId, name) {
    const m = montages.find((x) => x.id === montageId);
    if (!m) return false;
    const trimmed = String(name || '').trim().slice(0, 120);
    if (trimmed) m.name = trimmed;
    save();
    return true;
  }

  function deleteMontage(montageId) {
    const i = montages.findIndex((x) => x.id === montageId);
    if (i === -1) return false;
    const m = montages[i];
    if (m && m.outputPath) { try { fs.unlinkSync(m.outputPath); } catch (e) { /* ignore */ } }
    montages.splice(i, 1);
    save();
    return true;
  }

  // Delete just the encoded export file, keeping the playlist so it can be re-encoded.
  function deleteMontageExport(montageId) {
    const m = montages.find((x) => x.id === montageId);
    if (!m) return false;
    if (m.outputPath) { try { fs.unlinkSync(m.outputPath); } catch (e) { /* ignore */ } }
    delete m.outputPath;
    m.status = 'draft';
    save();
    return true;
  }

  function getClipSegmentsForMontage(montageId) {
    const m = montages.find((x) => x.id === montageId);
    if (!m) return { segments: [], template: 'highlights' };
    const segments = m.clipIds
      .map((id) => library.find((c) => c.id === id))
      .filter((c) => c && c.path)
      .map((c) => ({
        path: c.path,
        trimIn: c.trimIn || 0,
        trimOut: c.trimOut,
        name: c.name
      }));
    return { segments, template: m.template || 'highlights' };
  }

  function getClipPathsForMontage(montageId) {
    return getClipSegmentsForMontage(montageId).segments.map((s) => s.path);
  }

  function updateMontageStatus(id, status, outputPath) {
    const m = montages.find((x) => x.id === id);
    if (!m) return;
    m.status = status;
    if (outputPath) m.outputPath = outputPath;
    save();
  }

  async function linkReplayToClip(clipId, filePath) {
    const clip = library.find((c) => c.id === clipId);
    if (!clip) return null;
    return importReplayFile(filePath, { type: clip.type, game: clip.game, player: clip.player, label: clip.name });
  }

  load();
  fs.mkdirSync(clipsDir, { recursive: true });

  return {
    captureHighlight,
    importReplayFile,
    setSettings,
    removeClip,
    updateClip,
    createMontage,
    reorderMontage,
    renameMontage,
    deleteMontage,
    deleteMontageExport,
    getClipSegmentsForMontage,
    getClipPathsForMontage,
    updateMontageStatus,
    getState: () => ({ library: library.slice(0, 200), montages, ...settings }),
    getClipsDir: () => clipsDir,
    getLastError: () => lastCaptureError
  };
}

module.exports = { createClipManager };