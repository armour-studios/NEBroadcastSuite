'use strict';

/* ─── social-weekly.js — the "every week, without me" half of the Social page ───────────────
   Once a week this pulls the past N days of Twitch clips, drops the ones already handled,
   auto-names what's left, and either STAGES them for the producer to review or SCHEDULES them
   straight onto YouTube across the following days.

   Deliberately dependency-injected (fetchClips / publisher / onEvent) rather than reaching for
   server.js globals: the run logic is the part worth testing, and it shouldn't need a Twitch
   token or an Electron app to exercise.                                                       */

const fs   = require('fs');
const path = require('path');

let cron;
try { cron = require('node-cron'); } catch (e) { console.warn('[SocialWeekly] node-cron not installed:', e.message); }

const DAY_MS = 86400000;

const DEFAULTS = {
  enabled:      false,
  mode:         'review',        // 'review' = stage for approval | 'auto' = schedule unattended
  dayOfWeek:    1,               // 0 Sun … 6 Sat
  hour:         10,
  minute:       0,
  lookbackDays: 7,
  maxClips:     5,
  minViews:     0,
  sort:         'views',         // 'views' | 'recent'
  platforms:    ['youtube'],
  visibility:   'public',
  isShort:      false,
  verticalFit:  'crop',
  trimIn:       0,
  trimOut:      null,
  intro:        null,            // same shape encodeCompose takes (template / introFile / outroFile…)
  slots:        ['17:00', '20:00'],
  startOffsetHours: 2,           // don't publish the instant the job runs
  titleTemplate:   '',
  descTemplate:    '',
  captionTemplate: '',
};

class SocialWeekly {
  /**
   * @param {object}   o
   * @param {string}   o.userDataPath  where to persist config + the handled-clip ledger
   * @param {object}   o.publisher     SocialPublisher (addPost / publish / getSchedule)
   * @param {function} o.fetchClips    async ({ startedAt, endedAt }) => [twitch clip objects]
   * @param {function} [o.renderNames] (clip, index) => { title, desc, caption }
   * @param {function} [o.onEvent]     (type, payload) => void — for WS broadcast / toasts
   */
  constructor({ userDataPath, publisher, fetchClips, renderNames, onEvent } = {}) {
    this.path        = path.join(userDataPath || '.', 'social-weekly.json');
    this.publisher   = publisher;
    this.fetchClips  = fetchClips;
    this.renderNames = renderNames || ((clip) => ({ title: clip.title || 'Clip', desc: '', caption: '' }));
    this.onEvent     = onEvent || (() => {});
    this._job        = null;
    this._running    = false;

    const saved = this._load();
    this.config  = { ...DEFAULTS, ...(saved.config || {}) };
    this.handled = new Set(saved.handled || []);      // Twitch clip ids already staged/scheduled
    this.history = saved.history || [];               // newest first, capped
    this.staged  = saved.staged  || [];               // rows waiting for review (mode: 'review')
    this.lastRunAt = saved.lastRunAt || null;
  }

  _load() { try { return JSON.parse(fs.readFileSync(this.path, 'utf8')); } catch { return {}; } }
  _save() {
    try {
      fs.writeFileSync(this.path, JSON.stringify({
        config:  this.config,
        handled: [...this.handled].slice(-500),   // ledger is for dedup, not an archive
        history: this.history.slice(0, 20),
        staged:  this.staged,
        lastRunAt: this.lastRunAt,
      }, null, 2), 'utf8');
    } catch (e) { console.error('[SocialWeekly] save failed:', e.message); }
  }

  // ── Config ──────────────────────────────────────────────────────────────────
  getConfig() { return { ...this.config }; }

  setConfig(patch = {}) {
    this.config = { ...this.config, ...patch };
    // Keep the cron-facing numbers sane; a NaN here silently kills the schedule. Note the
    // parse-then-clamp split: `parseInt(x) || dflt` would treat a legitimate 0 (minute 0,
    // "0 minimum views") as missing and swap in the default instead of honouring it.
    const clampInt = (v, lo, hi, dflt) => {
      const n = parseInt(v, 10);
      return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : dflt));
    };
    this.config.dayOfWeek    = clampInt(this.config.dayOfWeek,    0, 6,        0);
    this.config.hour         = clampInt(this.config.hour,         0, 23,       0);
    this.config.minute       = clampInt(this.config.minute,       0, 59,       0);
    this.config.lookbackDays = clampInt(this.config.lookbackDays, 1, 90,       7);
    this.config.maxClips     = clampInt(this.config.maxClips,     1, 50,       5);
    this.config.minViews     = clampInt(this.config.minViews,     0, 1e9,      0);
    this._save();
    this.start();   // re-arm on the new day/time
    return this.getConfig();
  }

  getStatus() {
    return {
      config:    this.getConfig(),
      running:   this._running,
      lastRunAt: this.lastRunAt,
      nextRunAt: this.nextRunAt(),
      history:   this.history.slice(0, 10),
      staged:    this.staged,
      handledCount: this.handled.size,
    };
  }

  // ── Cron ────────────────────────────────────────────────────────────────────
  start() {
    this.stop();
    if (!this.config.enabled) return;
    if (!cron) { console.warn('[SocialWeekly] node-cron missing — weekly automation disabled'); return; }
    const { minute, hour, dayOfWeek } = this.config;
    const expr = `${minute} ${hour} * * ${dayOfWeek}`;
    if (!cron.validate(expr)) { console.error('[SocialWeekly] refusing to arm an invalid cron:', expr); return; }
    this._job = cron.schedule(expr, () => {
      this.run('schedule').catch(e => console.error('[SocialWeekly] scheduled run failed:', e.message));
    });
    console.log(`[SocialWeekly] armed — ${expr} (${this.config.mode})`);
  }

  stop() { if (this._job) { this._job.stop(); this._job = null; } }

  // Next firing of the configured weekday/time, as an epoch ms. Local time, matching cron.
  nextRunAt() {
    if (!this.config.enabled) return null;
    const { dayOfWeek, hour, minute } = this.config;
    const now  = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    let delta = (dayOfWeek - next.getDay() + 7) % 7;
    if (delta === 0 && next.getTime() <= now.getTime()) delta = 7;   // today's slot already passed
    next.setDate(next.getDate() + delta);
    return next.getTime();
  }

  // ── Clip selection ──────────────────────────────────────────────────────────
  // Exposed on its own so the UI can show "here's what the next run would grab" without
  // committing to anything.
  async pickClips({ includeHandled = false } = {}) {
    const c = this.config;
    const endedAt   = new Date();
    const startedAt = new Date(endedAt.getTime() - c.lookbackDays * DAY_MS);
    const clips = await this.fetchClips({
      startedAt: startedAt.toISOString(),
      endedAt:   endedAt.toISOString(),
    }) || [];

    const eligible = clips
      .filter(cl => cl && cl.id)
      .filter(cl => (cl.view_count || 0) >= c.minViews)
      .filter(cl => includeHandled || !this.handled.has(cl.id));

    eligible.sort((a, b) => c.sort === 'recent'
      ? new Date(b.created_at || 0) - new Date(a.created_at || 0)
      : (b.view_count || 0) - (a.view_count || 0));

    return {
      window:   { from: startedAt.toISOString(), to: endedAt.toISOString() },
      scanned:  clips.length,
      eligible: eligible.length,
      picked:   eligible.slice(0, c.maxClips),
    };
  }

  // ── Drip times ──────────────────────────────────────────────────────────────
  // Same shape as the Auto Queue's slot walker: fill each day's configured times, roll to the
  // next day when they're used up, never land in the past.
  planTimes(count, fromMs = Date.now()) {
    const c     = this.config;
    const floor = fromMs + Math.max(0, Number(c.startOffsetHours) || 0) * 3600000;
    const slots = (c.slots || [])
      .map(s => /^(\d{1,2}):(\d{2})$/.exec(String(s).trim()))
      .filter(Boolean)
      .map(m => ({ h: Math.min(23, +m[1]), m: Math.min(59, +m[2]) }))
      .sort((a, b) => a.h - b.h || a.m - b.m);

    if (!slots.length) return Array.from({ length: count }, (_, i) => floor + i * DAY_MS);

    const out = [];
    const day = new Date(floor); day.setHours(0, 0, 0, 0);
    for (let d = 0; out.length < count && d < 400; d++) {
      for (const s of slots) {
        const dt = new Date(day.getFullYear(), day.getMonth(), day.getDate() + d, s.h, s.m, 0, 0).getTime();
        if (dt < floor) continue;
        out.push(dt);
        if (out.length >= count) break;
      }
    }
    while (out.length < count) out.push(floor + out.length * DAY_MS);
    return out;
  }

  // Build the post body handed to SocialPublisher for one clip.
  buildPost(clip, index, at) {
    const c = this.config;
    const { title, desc, caption } = this.renderNames(clip, index);
    return {
      clipType:     'twitch',
      clipUrl:      clip.url,
      clipVideoUrl: clip._videoUrl,
      thumbnailUrl: clip.thumbnail_url,
      title:        (title || clip.title || 'Clip').slice(0, 100),
      ytVisibility: c.visibility,
      isShort:      !!c.isShort,
      captions:     { youtube: desc || '', twitter: caption || '' },
      trimIn:       c.trimIn  || 0,
      trimOut:      c.trimOut ?? null,
      intro:        c.intro ? { ...c.intro, vertical: !!c.isShort || !!c.intro.vertical, verticalFit: c.verticalFit } : null,
      platforms:    (c.platforms && c.platforms.length) ? c.platforms : ['youtube'],
      scheduledAt:  at,
      _weekly:      true,
      _clipId:      clip.id,
    };
  }

  // ── The run ─────────────────────────────────────────────────────────────────
  // trigger: 'schedule' (cron) | 'manual' (Run now button)
  async run(trigger = 'manual') {
    if (this._running) throw new Error('A weekly run is already in progress');
    this._running = true;
    this.onEvent('social_weekly_started', { trigger });

    const entry = { at: Date.now(), trigger, mode: this.config.mode, found: 0, staged: 0, scheduled: 0, errors: [] };
    try {
      const pick = await this.pickClips();
      entry.found  = pick.picked.length;
      entry.window = pick.window;
      entry.scanned = pick.scanned;

      if (!pick.picked.length) {
        entry.note = 'No new clips in the window';
      } else {
        const times = this.planTimes(pick.picked.length);
        const rows  = pick.picked.map((clip, i) => {
          const { title, desc, caption } = this.renderNames(clip, i);
          return { clip, title, desc, caption, at: times[i], status: '' };
        });

        if (this.config.mode === 'auto') {
          // Sequential on purpose: each addPost kicks off a YouTube upload server-side, and a
          // fan-out of concurrent uploads is the fastest way to hit the API's rate limits.
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            try {
              const post = this.buildPost(row.clip, i, row.at);
              post.title = row.title; post.captions = { youtube: row.desc, twitter: row.caption };
              await this.publisher.addPost(post);
              this.handled.add(row.clip.id);
              entry.scheduled++;
            } catch (e) {
              entry.errors.push(`${row.clip.id}: ${e.message}`);
            }
          }
        } else {
          // Review mode — park the rows; the producer approves them on the Weekly tab. They are
          // NOT marked handled yet, so a discarded batch can be picked up again next week.
          this.staged = rows.map(r => ({
            clipId: r.clip.id, clip: r.clip, title: r.title, desc: r.desc, caption: r.caption, at: r.at,
          }));
          entry.staged = this.staged.length;
        }
      }
    } catch (e) {
      entry.errors.push(e.message);
      console.error('[SocialWeekly] run failed:', e.message);
    } finally {
      this._running  = false;
      this.lastRunAt = entry.at;
      this.history.unshift(entry);
      this.history = this.history.slice(0, 20);
      this._save();
      this.onEvent('social_weekly_done', { entry, status: this.getStatus() });
    }
    return entry;
  }

  // ── Review-mode approval ────────────────────────────────────────────────────
  // rows: the (possibly edited) staged rows the producer approved.
  async approveStaged(rows) {
    const list = Array.isArray(rows) && rows.length ? rows : this.staged;
    const out  = { scheduled: 0, errors: [] };
    for (let i = 0; i < list.length; i++) {
      const row = list[i];
      const clip = row.clip || (this.staged.find(s => s.clipId === row.clipId) || {}).clip;
      if (!clip) { out.errors.push(`${row.clipId}: clip data missing`); continue; }
      try {
        const post = this.buildPost(clip, i, row.at);
        post.title    = (row.title || post.title).slice(0, 100);
        post.captions = { youtube: row.desc || '', twitter: row.caption || '' };
        await this.publisher.addPost(post);
        this.handled.add(clip.id);
        out.scheduled++;
      } catch (e) {
        out.errors.push(`${clip.id}: ${e.message}`);
      }
    }
    this.staged = [];
    this._save();
    this.onEvent('social_weekly_approved', { ...out, status: this.getStatus() });
    return out;
  }

  discardStaged() {
    this.staged = [];
    this._save();
    return { ok: true };
  }

  // Let a producer un-handle a clip so it can be posted again (or clear the whole ledger).
  forget(clipId) {
    if (clipId) this.handled.delete(clipId); else this.handled.clear();
    this._save();
    return { handledCount: this.handled.size };
  }
}

module.exports = { SocialWeekly, SOCIAL_WEEKLY_DEFAULTS: DEFAULTS };
