const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fsp = require('fs/promises');

// Lower a child process to BELOW_NORMAL priority so encodes never starve the live broadcast.
// os.setPriority is native — the old `wmic ... setpriority` shell-out silently no-ops on
// current Windows 11 builds (wmic was removed from the OS).
function lowerPriority(pid) {
  if (process.platform !== 'win32' || !pid) return;
  try { os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { /* optional tweak */ }
}
const { getTemplate } = require('./templates');

/**
 * Background montage encoder — trim segments, optional BRB slates, concat.
 * Stream-copy when possible; ultrafast fallback. Low thread count + below-normal priority.
 */
function createMontageEncoder({ clipsDir, onProgress }) {
  const queue = [];
  let active = null;
  let ffmpegPath = 'ffmpeg';

  function setFfmpegPath(p) {
    if (p) ffmpegPath = p;
  }

  function findFfmpeg() {
    const candidates = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      'ffmpeg'
    ];
    for (const c of candidates) {
      if (c === 'ffmpeg' || fs.existsSync(c)) return c;
    }
    return 'ffmpeg';
  }

  ffmpegPath = findFfmpeg();

  function emit(job, patch) {
    Object.assign(job, patch);
    if (onProgress) onProgress({ queue: queue.map(summarize), active: active ? summarize(active) : null });
  }

  function summarize(job) {
    return {
      id: job.id,
      montageId: job.montageId || null,
      name: job.name,
      status: job.status,
      progress: job.progress || 0,
      outputPath: job.outputPath || null,
      error: job.error || null,
      template: job.template || 'highlights'
    };
  }

  // `trackTime` is only passed for the FINAL concat encode — the one long-running ffmpeg call
  // whose own elapsed `time=` really does correspond to the whole job's estimated duration. Every
  // OTHER call (trimming/normalizing each clip, one short ffmpeg process per clip) used to emit
  // this same time-based progress too, computed against the FULL job duration — since each new
  // per-clip process restarts its own `time=` at 0, that continuously stomped the monotonic
  // step-counter progress (below) back down near 0-1%, which is exactly the "jumps back to one a
  // lot" bug reported. Per-clip steps now rely solely on the step counter; only the final encode
  // gets smooth sub-step progress, filling the 90-99% band the step counter leaves for it.
  function runFfmpeg(args, job, trackTime) {
    return new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, args, { windowsHide: true, detached: false });

      lowerPriority(proc.pid);

      let stderr = '';
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
        if (trackTime && job.durationEstimate) {
          const m = stderr.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g);
          if (m) {
            const last = m[m.length - 1].replace('time=', '');
            const parts = last.split(':').map(Number);
            const secs = parts[0] * 3600 + parts[1] * 60 + parts[2];
            const frac = Math.min(1, secs / job.durationEstimate);
            emit(job, { progress: 90 + Math.round(frac * 9) });
          }
        }
      });

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.slice(-500) || `ffmpeg exit ${code}`));
      });
      proc.on('error', reject);
    });
  }

  async function trimSegment(src, out, trimIn, trimOut, job) {
    const args = ['-y', '-ss', String(trimIn || 0), '-i', src];
    if (trimOut != null && trimOut > (trimIn || 0)) {
      args.push('-t', String(trimOut - (trimIn || 0)));
    }
    args.push('-c', 'copy', out);
    try {
      await runFfmpeg(args, job);
    } catch (e) {
      args.length = 0;
      args.push('-y', '-ss', String(trimIn || 0), '-i', src);
      if (trimOut != null && trimOut > (trimIn || 0)) args.push('-t', String(trimOut - (trimIn || 0)));
      args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-c:a', 'aac', '-threads', '2', out);
      await runFfmpeg(args, job);
    }
  }

  function ffprobePath() {
    // ffprobe lives next to ffmpeg.
    if (ffmpegPath && ffmpegPath !== 'ffmpeg') return ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
    return 'ffprobe';
  }
  function probeDuration(file) {
    return new Promise((resolve) => {
      try {
        const proc = spawn(ffprobePath(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { windowsHide: true });
        let out = '';
        proc.stdout.on('data', (d) => { out += d.toString(); });
        proc.on('close', () => resolve(parseFloat(out) || 0));
        proc.on('error', () => resolve(0));
      } catch (e) { resolve(0); }
    });
  }

  function probeHasAudio(file) {
    return new Promise((resolve) => {
      try {
        const proc = spawn(ffprobePath(), ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file], { windowsHide: true });
        let out = '';
        proc.stdout.on('data', (d) => { out += d.toString(); });
        proc.on('close', () => resolve(out.trim().length > 0));
        proc.on('error', () => resolve(false));
      } catch (e) { resolve(false); }
    });
  }

  // Normalize a trimmed clip to the canonical montage format (1080p30, yuv420p, libx264,
  // AAC stereo 48k, square pixels) so EVERY segment — clips, fade dips, logo dips, slates —
  // shares identical stream parameters. The concat demuxer requires this; without it,
  // mixing copied clips with re-encoded transition segments glitches or drops the transition.
  // When { fade } is set, a short fade-in/out is baked in for a smooth dip between clips.
  async function normalizeClip(file, job, { fade } = {}) {
    const out = file.replace(/\.mp4$/i, '_n.mp4');
    const hasAudio = await probeHasAudio(file);
    let vf = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30';
    if (fade) {
      const dur = await probeDuration(file);
      const d = 0.35;
      if (dur && dur > d * 2.2) vf += `,fade=t=in:st=0:d=${d},fade=t=out:st=${(dur - d).toFixed(2)}:d=${d}`;
    }
    const args = ['-y', '-i', file];
    if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    args.push(
      '-vf', vf,
      '-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-vsync', 'cfr', '-threads', '2', '-shortest', out
    );
    await runFfmpeg(args, job);
    return out;
  }

  // Combine a run of already-normalized clips into ONE video via a real xfade/acrossfade filter
  // chain — a genuine dissolve where both clips' frames blend directly — instead of the old
  // approach of baking a fade-in/fade-out into each clip's edges then concatenating: that always
  // produced clip → black → clip, since concat just cuts between two frames that are ALREADY
  // faded to black on either side, never overlapping. Only used for the 'fade' transition when
  // there's no gap slate between clips (gapSec === 0, e.g. the default Highlight Reel template) —
  // BRB/Post-Game templates keep their existing slate-based transition, out of scope here.
  async function buildCrossfadeChain(clipFiles, outPath, job) {
    const xfd = 0.5;   // crossfade duration, seconds
    const durations = [];
    for (const f of clipFiles) durations.push(await probeDuration(f));

    const inputArgs = [];
    clipFiles.forEach((f) => inputArgs.push('-i', f));

    let vChain = '', aChain = '', cum = durations[0] || 0;
    let prevV = '0:v', prevA = '0:a';
    for (let i = 1; i < clipFiles.length; i++) {
      const offset = Math.max(0, cum - xfd);
      const vOut = `xv${i}`, aOut = `xa${i}`;
      vChain += `[${prevV}][${i}:v]xfade=transition=fade:duration=${xfd}:offset=${offset.toFixed(3)}[${vOut}];`;
      aChain += `[${prevA}][${i}:a]acrossfade=d=${xfd}[${aOut}];`;
      prevV = vOut; prevA = aOut;
      cum = cum + (durations[i] || 0) - xfd;
    }

    await runFfmpeg([
      '-y', ...inputArgs,
      '-filter_complex', vChain + aChain,
      '-map', `[${prevV}]`, '-map', `[${prevA}]`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-threads', '2', outPath
    ], job);
    return outPath;
  }

  // A short "dip to logo" segment inserted between clips. Black background + centred logo,
  // fading in and out, with a silent stereo track so it concats cleanly with the clips.
  async function generateLogoTransition(out, duration, logoPath, job) {
    const f = Math.min(0.25, duration / 2);
    const hasLogo = logoPath && fs.existsSync(logoPath);
    const args = [
      '-y',
      '-f', 'lavfi', '-i', `color=c=black:s=1920x1080:r=30:d=${duration}`,
      '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=48000`
    ];
    if (hasLogo) {
      args.push('-i', logoPath,
        '-filter_complex', `[2:v]scale=520:-1:force_original_aspect_ratio=decrease[lg];[0:v][lg]overlay=(W-w)/2:(H-h)/2,fade=t=in:st=0:d=${f},fade=t=out:st=${(duration - f).toFixed(2)}:d=${f}[v]`,
        '-map', '[v]', '-map', '1:a');
    } else {
      args.push('-vf', `fade=t=in:st=0:d=${f},fade=t=out:st=${(duration - f).toFixed(2)}:d=${f}`, '-map', '0:v', '-map', '1:a');
    }
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '128k',
      '-t', String(duration), '-pix_fmt', 'yuv420p', '-shortest', out);
    await runFfmpeg(args, job);
  }

  async function generateSlate(out, duration, title, job) {
    const safeTitle = (title || '').replace(/'/g, '').replace(/:/g, ' ');
    const vf = safeTitle
      ? `drawtext=text='${safeTitle}':fontsize=56:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`
      : 'null';
    await runFfmpeg([
      '-y',
      '-f', 'lavfi', '-i', `color=c=0x111318:s=1920x1080:r=30:d=${duration}`,
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-t', String(duration), '-shortest', out
    ], job);
  }

  // Map the REPLAYS-page export options (quality, GPU, transition) to ffmpeg
  // video-encode args. Higher quality = lower CRF / slower preset.
  function videoArgs(opts) {
    const o = opts || {};
    const QUAL = {
      low:    { crf: '28', preset: 'veryfast', cq: '32' },
      medium: { crf: '23', preset: 'fast',     cq: '26' },
      high:   { crf: '18', preset: 'medium',   cq: '20' }
    };
    const q = QUAL[o.quality] || QUAL.medium;
    if (o.gpu) {
      // NVIDIA NVENC — falls back to libx264 automatically if NVENC is unavailable
      // (the caller wraps the copy/encode in try/catch).
      return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', q.cq, '-pix_fmt', 'yuv420p'];
    }
    return ['-c:v', 'libx264', '-preset', q.preset, '-crf', q.crf, '-pix_fmt', 'yuv420p'];
  }

  async function buildConcatList(files, listPath) {
    const lines = files.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
    await fsp.writeFile(listPath, lines, 'utf8');
  }

  async function processJob(job) {
    active = job;
    emit(job, { status: 'encoding', progress: 0 });

    const outDir = path.join(clipsDir, 'exports');
    const workDir = path.join(clipsDir, 'work', job.id);
    await fsp.mkdir(outDir, { recursive: true });
    await fsp.mkdir(workDir, { recursive: true });

    const safeName = (job.name || 'montage').replace(/[^\w\-]+/g, '_').slice(0, 60);
    const ext = ({ '.mp4': 'mp4', '.mov': 'mov', '.webm': 'webm', mp4: 'mp4', mov: 'mov', webm: 'webm' })[job.opts?.format] || 'mp4';
    const outputPath = path.join(outDir, `${safeName}_${Date.now()}.${ext}`);
    const listPath = path.join(workDir, 'concat.txt');
    const tempFiles = [];

    try {
      const segments = job.segments || [];
      if (!segments.length) throw new Error('No valid clip segments');

      const tpl = getTemplate(job.template || 'highlights');
      const concatFiles = [];
      let step = 0;
      const totalSteps = segments.length * 2 + 4;
      job.durationEstimate = segments.length * 12 + (tpl.gapSec || 0) * segments.length + 10;

      if (tpl.introSec > 0) {
        const intro = path.join(workDir, 'intro.mp4');
        await generateSlate(intro, tpl.introSec, tpl.introTitle, job);
        concatFiles.push(intro);
        tempFiles.push(intro);
        emit(job, { progress: Math.round((++step / totalSteps) * 90) });
      }

      const opts = job.opts || {};
      const transition = opts.transition || 'cut';
      const logoPath = opts.transitionLogoPath || null;
      // Templates with a gap slate between clips (BRB/Post-Game) keep the old per-clip fade bake —
      // a slate is being cut to either side anyway, so there's no run of adjacent clips to actually
      // crossfade. Templates with no gap (default Highlight Reel) get a REAL crossfade instead: the
      // whole run of clips is combined afterward via buildCrossfadeChain() (xfade/acrossfade — an
      // actual dissolve, not fade-to-black-and-back).
      const useCrossfade = transition === 'fade' && !(tpl.gapSec > 0);
      const mainClipsStart = concatFiles.length;
      const mainClipFiles = [];

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (!fs.existsSync(seg.path)) continue;
        let clip = path.join(workDir, `clip_${i}.mp4`);
        await trimSegment(seg.path, clip, seg.trimIn, seg.trimOut, job);
        // For fade/logo transitions every segment must share identical stream params, so normalize
        // each clip. The per-clip fade bake only applies to the gap-slate path now.
        if (transition === 'fade' && !useCrossfade) clip = await normalizeClip(clip, job, { fade: true });
        else if (transition === 'fade' || transition === 'logo') clip = await normalizeClip(clip, job, {});
        concatFiles.push(clip);
        tempFiles.push(clip);
        if (useCrossfade) mainClipFiles.push(clip);
        emit(job, { progress: Math.round((++step / totalSteps) * 90) });

        if (i < segments.length - 1) {
          if (transition === 'logo') {
            const tr = path.join(workDir, `logo_${i}.mp4`);
            await generateLogoTransition(tr, 0.7, logoPath, job);   // dip-to-logo between clips
            concatFiles.push(tr); tempFiles.push(tr);
          } else if (tpl.gapSec > 0) {
            const gap = path.join(workDir, `gap_${i}.mp4`);
            await generateSlate(gap, tpl.gapSec, tpl.gapTitle, job);
            concatFiles.push(gap); tempFiles.push(gap);
          }
          // useCrossfade: nothing inserted between clips here — they're combined into one
          // dissolve-chained segment below instead.
        }
      }

      if (useCrossfade && mainClipFiles.length > 1) {
        const combined = path.join(workDir, 'crossfade_combined.mp4');
        await buildCrossfadeChain(mainClipFiles, combined, job);
        tempFiles.push(combined);
        // Replace the individual clip entries in concatFiles with the single combined file —
        // intro/outro slates (if any) stay in their original positions around it.
        concatFiles.splice(mainClipsStart, mainClipFiles.length, combined);
      }

      if (tpl.outroSec > 0) {
        const outro = path.join(workDir, 'outro.mp4');
        await generateSlate(outro, tpl.outroSec, tpl.outroTitle || 'GG', job);
        concatFiles.push(outro);
        tempFiles.push(outro);
      }

      if (!concatFiles.length) throw new Error('No segments produced');

      await buildConcatList(concatFiles, listPath);
      // 'cut' at default quality/no GPU can stream-copy (fast, lossless). Fade/logo transitions
      // (already re-encoded per clip/segment) and any quality/GPU choice force a consistent re-encode.
      const mustEncode = opts.gpu || (opts.quality && opts.quality !== 'medium') || transition === 'fade' || transition === 'logo';
      const vArgs = videoArgs(opts);
      const fade = [];   // fades are now applied per-clip above, not across the whole montage
      try {
        if (mustEncode) {
          await runFfmpeg([
            '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
            ...fade, ...vArgs,
            '-c:a', 'aac', '-b:a', '128k', '-threads', '2',
            '-movflags', '+faststart', outputPath
          ], job, true);
        } else {
          await runFfmpeg([
            '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
            '-c', 'copy', '-movflags', '+faststart', outputPath
          ], job, true);
        }
      } catch (e) {
        // Fallback: software encode with the chosen quality (covers NVENC-absent + copy-incompatible).
        const crf = { low: '28', medium: '23', high: '18' }[opts.quality] || '23';
        await runFfmpeg([
          '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
          ...fade,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', crf,
          '-c:a', 'aac', '-b:a', '128k', '-threads', '2',
          '-movflags', '+faststart', outputPath
        ], job, true);
      }

      emit(job, { status: 'done', progress: 100, outputPath });
    } catch (e) {
      emit(job, { status: 'error', error: e.message, progress: 0 });
    } finally {
      try { await fsp.rm(workDir, { recursive: true, force: true }); } catch (err) { /* ignore */ }
      active = null;
      pump();
    }
  }

  function pump() {
    if (active || !queue.length) {
      if (onProgress) onProgress({ queue: queue.map(summarize), active: active ? summarize(active) : null });
      return;
    }
    const job = queue.find((j) => j.status === 'queued');
    if (job) processJob(job);
    else if (onProgress) onProgress({ queue: queue.map(summarize), active: null });
  }

  function enqueue({ id, name, segments, clipPaths, montageId, template, opts }) {
    const segs = segments || (clipPaths || []).map((p) => ({ path: p, trimIn: 0, trimOut: null }));
    const job = {
      id: id || `enc_${Date.now()}`,
      name: name || 'Montage',
      segments: segs,
      template: template || 'highlights',
      montageId: montageId || null,
      opts: opts || {},
      status: 'queued',
      progress: 0,
      outputPath: null,
      error: null
    };
    queue.push(job);
    if (onProgress) onProgress({ queue: queue.map(summarize), active: active ? summarize(active) : null });
    pump();
    return job.id;
  }

  function cancel(id) {
    const idx = queue.findIndex((j) => j.id === id && j.status === 'queued');
    if (idx >= 0) queue.splice(idx, 1);
    if (onProgress) onProgress({ queue: queue.map(summarize), active: active ? summarize(active) : null });
  }

  function getQueue() {
    return { queue: queue.map(summarize), active: active ? summarize(active) : null };
  }

  // ─── Fast pre-air prep for LIVE replay push (separate from the montage pipeline above) ───
  // Raw OBS replay-buffer/highlight clips are commonly H.264 High-Profile with heavy B-frame
  // usage — efficient for storage, expensive for OBS's own Browser Source (CEF) to decode in
  // real time, which shows up as continuous lag/dropped frames that a normal browser tab doesn't
  // exhibit. This produces a Baseline-profile, B-frame-free, tight-GOP transcode of just the one
  // clip being pushed live — cached by source path+mtime+size so repeat pushes of the same clip
  // are instant, and it never touches the slower montage-quality Encode pipeline above (that one
  // already reported working fine — only raw single-clip push-to-air needed this).
  const airPrepDir = path.join(clipsDir, 'air-prep');
  const airPrepPending = new Map();   // outPath -> in-flight Promise, so concurrent pushes share one transcode

  function airPrepKeyFor(srcPath) {
    const st = fs.statSync(srcPath);
    const base = path.basename(srcPath).replace(/\.[^.]+$/, '').replace(/[^\w.\-]+/g, '_');
    return `${base}_${st.mtimeMs}_${st.size}.mp4`;
  }

  function runAirPrepFfmpeg(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, args, { windowsHide: true });
      lowerPriority(proc.pid);
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr.slice(-400) || `ffmpeg exit ${code}`)));
      proc.on('error', reject);
    });
  }

  function airPrepPrune(maxFiles) {
    try {
      const files = fs.readdirSync(airPrepDir)
        .filter((f) => f.endsWith('.mp4'))
        .map((f) => { const full = path.join(airPrepDir, f); return { full, t: fs.statSync(full).mtimeMs }; })
        .sort((a, b) => b.t - a.t);
      files.slice(maxFiles || 40).forEach(({ full }) => { try { fs.unlinkSync(full); } catch (e) { /* ignore */ } });
    } catch (e) { /* ignore */ }
  }

  // Sync peek so a caller can tell up front whether prepareForAir(srcPath) will resolve instantly
  // (already cached / already in flight) or actually need to wait on a fresh transcode.
  function isAirPrepReady(srcPath) {
    if (!srcPath || !fs.existsSync(srcPath)) return true;
    let outName;
    try { outName = airPrepKeyFor(srcPath); } catch (e) { return true; }
    const outPath = path.join(airPrepDir, outName);
    return fs.existsSync(outPath) || airPrepPending.has(outPath);
  }

  // Resolves to the prepared file's path — or the original srcPath unchanged if the source is
  // missing or the transcode fails for any reason (never blocks a replay from going to air).
  async function prepareForAir(srcPath) {
    if (!srcPath || !fs.existsSync(srcPath)) return srcPath;
    let outName;
    try { outName = airPrepKeyFor(srcPath); } catch (e) { return srcPath; }
    const outPath = path.join(airPrepDir, outName);
    if (fs.existsSync(outPath)) return outPath;
    if (airPrepPending.has(outPath)) return airPrepPending.get(outPath);

    // ffmpeg picks the output muxer from the filename's LAST extension — `foo.mp4.tmp` fails with
    // "Unable to choose an output format" because it sees `.tmp`, not `.mp4`. Keep `.mp4` last.
    const tmpPath = outPath.replace(/\.mp4$/, '.tmp.mp4');
    const job = (async () => {
      try {
        await fsp.mkdir(airPrepDir, { recursive: true });
        await runAirPrepFfmpeg([
          '-y', '-i', srcPath,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '21',
          '-profile:v', 'baseline', '-bf', '0', '-pix_fmt', 'yuv420p',
          '-g', '60', '-sc_threshold', '0',
          '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
          '-movflags', '+faststart',
          tmpPath
        ]);
        await fsp.rename(tmpPath, outPath);
        airPrepPrune();
        return outPath;
      } catch (e) {
        try { await fsp.unlink(tmpPath); } catch (err) { /* ignore */ }
        return srcPath;
      } finally {
        airPrepPending.delete(outPath);
      }
    })();
    airPrepPending.set(outPath, job);
    return job;
  }

  return { enqueue, cancel, getQueue, setFfmpegPath, ffmpegPath: () => ffmpegPath, prepareForAir, isAirPrepReady };
}

module.exports = { createMontageEncoder };