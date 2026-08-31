const fs = require('fs');
const path = require('path');
const fsp = require('fs/promises');

const CAPTURE_COOLDOWN_MS = 3000;
const CAPTURE_COOLDOWN_FORCE_MS = 800;

// Two-stage video pipeline: 'replays' is the raw capture pool (auto-saves, instant-replay-to-air),
// 'highlights' is the curated shelf you promote keepers up into and build the stream reel from.
const FOLDERS = ['replays', 'highlights'];
const normFolder = (v) => (FOLDERS.includes(v) ? v : 'replays');

/**
 * Clip library + auto-capture from OBS replay buffer.
 */
function createClipManager({ dataDir, getObsClient, onUpdate, onCapture }) {
  const clipsDir = path.join(dataDir, 'clips');
  const metaFile = path.join(dataDir, 'clips-library.json');
  let library = [];
  let montages = [];
  let settings = {
    autoCapture: false,   // default OFF — auto-clipping is opt-in, never forced on
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
        // Migrate pre-folder libraries: raw clips default to the capture pool; a playlist seeds
        // its folder from its template (a highlights-template reel belongs on the Highlights shelf).
        library.forEach((c) => { if (c && !c.folder) c.folder = 'replays'; });
        montages.forEach((m) => { if (m && !m.folder) m.folder = (m.template === 'highlights') ? 'highlights' : 'replays'; });
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
      folder: 'replays',                           // new captures land in the raw pool; promote → highlights
      createdAt: Date.now(),
      duration: meta.duration || null,
      inMontage: false,
      trimIn: 0,
      trimOut: null,
      // ── AI training metadata (Phase 1): align the clip to the game event that spawned it ──
      eventTargetId: meta.eventTargetId || null,   // stable player/entity id (not just a name)
      gameEventTime: meta.feedTs || null,          // wall-clock ms of the triggering event
      gameClock: meta.gameClock || null,           // in-game clock at the event ("OT 2:45", seconds…)
      scoreAtEvent: meta.scoreAtEvent || null,     // { a, b }
      tags: [],                                    // producer labels (editor) — training labels
      markers: [],                                 // [{ videoTime, label }] timeline cue-points
      note: ''                                     // promoted producer note
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
      folder: 'replays',
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
    library.splice(idx, 1);
    // copyClip() can leave two library rows pointing at the same file (a Replays copy and a
    // Highlights copy of one capture) — only unlink the file once nothing else references it.
    if (clip.path && !library.some((c) => c.path === clip.path) && fs.existsSync(clip.path)) {
      try { fs.unlinkSync(clip.path); } catch (e) { /* ignore */ }
    }
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
    // AI training metadata
    if ('tags' in patch && Array.isArray(patch.tags)) {
      clip.tags = patch.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 24);
    }
    if ('markers' in patch && Array.isArray(patch.markers)) {
      clip.markers = patch.markers.filter((m) => m && typeof m.videoTime === 'number')
        .map((m) => ({ videoTime: m.videoTime, label: String(m.label || '').slice(0, 60) })).slice(0, 50);
    }
    if ('note' in patch) clip.note = String(patch.note || '');
    if ('folder' in patch) clip.folder = normFolder(patch.folder);
    save();
    return true;
  }

  // Move a clip between the Replays pool and the Highlights shelf. A clip has ONE home folder;
  // moving it only changes which list it shows under — it stays in any playlist it was already
  // dropped on (playlists reference clips by id, independent of folder), so promoting a keeper
  // mid-show never rips it out of a reel that's already built.
  function setClipFolder(id, folder) {
    const clip = library.find((c) => c.id === id);
    if (!clip) return false;
    clip.folder = normFolder(folder);
    save();
    return true;
  }

  // Copy a clip onto the OTHER shelf — unlike setClipFolder (a move), the clip keeps its spot on
  // its current shelf too, so a per-game replay can also live in the event's Highlights pool without
  // vanishing from Replays. The new row shares the same file on disk (removeClip's shared-path guard
  // keeps that safe); everything else (trims/tags/markers) is cloned so an edit doesn't leak between
  // the two copies.
  function copyClip(id, folder) {
    const clip = library.find((c) => c.id === id);
    if (!clip) return null;
    const copy = { ...clip, id: `clip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, folder: normFolder(folder), createdAt: Date.now() };
    library.unshift(copy);
    if (library.length > 500) library.length = 500;
    save();
    return copy;
  }

  // Producer-set running order for ONE shelf's clips. The pool grid is the running order for
  // "Play all" and for building a reel, so it has to be arrangeable — capture time is rarely show
  // order. Only the given folder's rows move: they're rewritten, in the supplied order, into the
  // slots that folder already occupied in the library, so the other shelf's positions are untouched
  // and anything omitted (a clip added between render and drop) keeps its place at the end.
  function reorderClips(folder, ids) {
    const f = normFolder(folder);
    const slots = [];
    library.forEach((c, i) => { if ((c.folder || 'replays') === f) slots.push(i); });
    if (!slots.length) return false;
    const mine = slots.map((i) => library[i]);
    const byId = new Map(mine.map((c) => [c.id, c]));
    const ordered = [];
    (Array.isArray(ids) ? ids : []).forEach((id) => {
      const c = byId.get(id);
      if (c && !ordered.includes(c)) ordered.push(c);
    });
    mine.forEach((c) => { if (!ordered.includes(c)) ordered.push(c); });
    slots.forEach((slot, n) => { library[slot] = ordered[n]; });
    save();
    return true;
  }

  function createMontage({ name, clipIds, template, folder }) {
    const clips = clipIds.map((id) => library.find((c) => c.id === id)).filter(Boolean);
    const fold = normFolder(folder);
    const montage = {
      id: `montage_${Date.now()}`,
      name: name || 'Highlight Reel',
      clipIds: clips.map((c) => c.id),
      template: template || 'highlights',
      folder: fold,
      createdAt: Date.now(),
      status: 'draft',
      programScene: '',                          // OBS scene this playlist plays in (live playout)
      // Highlights reels sting into air by default (the polished stream package); the raw Replays
      // pool cuts straight in (instant-replay speed matters more than a transition).
      transition: { type: fold === 'highlights' ? 'stinger' : 'cut', stinger: '' }
    };
    montages.unshift(montage);
    save();
    return montage;
  }

  // Set the live-playout settings on a playlist (OBS scene to play in + between-clip transition).
  function setMontageSettings(montageId, opts) {
    const m = montages.find((x) => x.id === montageId);
    if (!m || !opts || typeof opts !== 'object') return false;
    if (typeof opts.programScene === 'string') m.programScene = opts.programScene.slice(0, 200);
    if (opts.folder != null) m.folder = normFolder(opts.folder);
    if (typeof opts.kind === 'string') m.kind = ['replay', 'ad', ''].includes(opts.kind) ? opts.kind : '';
    if (typeof opts.loop === 'boolean') m.loop = opts.loop;
    if (typeof opts.returnEnabled === 'boolean') m.returnEnabled = opts.returnEnabled;
    if (opts.transition && typeof opts.transition === 'object') {
      const t = opts.transition;
      const cur = m.transition || {};
      m.transition = {
        type: ['cut', 'fade', 'dip', 'logo', 'stinger'].includes(t.type) ? t.type : 'cut',
        stinger: typeof t.stinger === 'string' ? t.stinger.slice(0, 2000) : (cur.stinger || '')
      };
    }
    save();
    return true;
  }

  function reorderMontage(montageId, clipIds) {
    const m = montages.find((x) => x.id === montageId);
    if (!m || !Array.isArray(clipIds)) return false;
    const next = clipIds.filter((id) => library.some((c) => c.id === id));
    const changed = JSON.stringify(next) !== JSON.stringify(m.clipIds || []);
    m.clipIds = next;
    // Adding/removing/reordering clips invalidates any existing encode — it was rendered from the OLD
    // clip set, so "Play Live" would play a STALE file (e.g. only the originally-encoded clips, which
    // looks like the playlist "froze after the first clip"). Drop the stale export so the status
    // returns to DRAFT and the next Play Live re-encodes with the current clips.
    if (changed && m.outputPath) {
      try { fs.unlinkSync(m.outputPath); } catch (e) { /* ignore */ }
      delete m.outputPath;
      m.status = 'draft';
    }
    save();
    return true;
  }

  // Copy every reel on one shelf to the other (non-destructive bulk promote). Clips are shared
  // library items referenced by id, so this clones only the playlist entries — no video file is
  // duplicated on disk. The copy is a fresh DRAFT (its own id, no stale export).
  function copyMontagesToFolder(fromFolder, toFolder) {
    const from = normFolder(fromFolder);
    const to = normFolder(toFolder);
    if (from === to) return 0;
    const src = montages.filter((m) => (m.folder || 'replays') === from);
    let n = 0;
    src.forEach((m, i) => {
      const t = m.transition || {};
      montages.unshift({
        id: `montage_${Date.now()}_${i}`,
        name: m.name,
        clipIds: [...(m.clipIds || [])],
        template: m.template || 'highlights',
        folder: to,
        createdAt: Date.now(),
        status: 'draft',
        programScene: m.programScene || '',
        transition: { type: t.type || (to === 'highlights' ? 'stinger' : 'cut'), stinger: t.stinger || '' }
      });
      n++;
    });
    if (n) save();
    return n;
  }

  // Empty a clip pool — remove every library clip on that shelf. Mirrors clearFolder's file-safety
  // rule (below) but at the clip level: a file is only unlinked once no remaining library row (on
  // EITHER shelf) still references it, so clearing Replays can never break a clip that was also
  // copied to Highlights.
  function clearClipsFolder(folder) {
    const f = normFolder(folder);
    const keep = library.filter((c) => (c.folder || 'replays') !== f);
    const removed = library.filter((c) => (c.folder || 'replays') === f);
    library = keep;
    let n = 0;
    removed.forEach((clip) => {
      if (clip.path && !library.some((c) => c.path === clip.path) && fs.existsSync(clip.path)) {
        try { fs.unlinkSync(clip.path); } catch (e) { /* ignore */ }
      }
      n++;
    });
    if (n) save();
    return n;
  }

  // Empty a shelf — remove all its reels (and any encoded export files). Clips stay in the library.
  function clearFolder(folder) {
    const f = normFolder(folder);
    const keep = [];
    let n = 0;
    montages.forEach((m) => {
      if ((m.folder || 'replays') === f) {
        if (m.outputPath) { try { fs.unlinkSync(m.outputPath); } catch (e) { /* ignore */ } }
        n++;
      } else keep.push(m);
    });
    montages = keep;
    if (n) save();
    return n;
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
    setClipFolder,
    copyClip,
    reorderClips,
    clearClipsFolder,
    copyMontagesToFolder,
    clearFolder,
    createMontage,
    setMontageSettings,
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