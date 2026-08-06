'use strict';

/* Question queue — the mailbag behind Q&A segments.
 *
 * Questions reach the queue four ways, all funnelling through addQuestion():
 *   1. a dedicated Discord channel (#questions / #mailbag) — live + a backlog pull
 *   2. a keyword prefix (default "!ask") in ANY connected chat source
 *   3. the +Q button on a row in the panel's multichat feed
 *   4. typed by hand, tagged with whichever social it came off (X, Instagram, TikTok…)
 *
 * Pure store: no I/O, no state — server.js owns persistence and broadcasting. Everything
 * here works on a plain array so it stays trivially testable.
 */

// Sources a question can be attributed to. `label` is what the on-air kicker shows
// (overlay/chat-highlight.html renders it after "QUESTION · "), `dot` colours the panel row.
const SOURCES = [
  { key: 'discord',   label: 'DISCORD',   dot: '#5865f2' },
  { key: 'twitch',    label: 'TWITCH',    dot: '#9146ff' },
  { key: 'youtube',   label: 'YOUTUBE',   dot: '#ff4d4d' },
  { key: 'kick',      label: 'KICK',      dot: '#53fc18' },
  { key: 'x',         label: 'X',         dot: '#e7e9ee' },
  { key: 'instagram', label: 'INSTAGRAM', dot: '#e1306c' },
  { key: 'tiktok',    label: 'TIKTOK',    dot: '#25f4ee' },
  { key: 'facebook',  label: 'FACEBOOK',  dot: '#1877f2' },
  { key: 'reddit',    label: 'REDDIT',    dot: '#ff4500' },
  { key: 'email',     label: 'EMAIL',     dot: '#94a3b8' },
  { key: 'other',     label: 'QUESTION',  dot: '#8b93a7' },
];
const SOURCE_KEYS = SOURCES.map(s => s.key);

const MAX_QUESTIONS = 200;   // ring cap — oldest ANSWERED questions are dropped first
const MAX_TEXT = 400;        // matches set_chat_highlight's own clamp, so nothing is cut on air
const MAX_USER = 60;

const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

function normalizeSource(s) {
  const k = String(s || '').trim().toLowerCase();
  if (k === 'twitter') return 'x';                     // producers still say Twitter
  return SOURCE_KEYS.includes(k) ? k : 'other';
}

/** On-air kicker text: "QUESTION · INSTAGRAM", or the producer's own label for a custom source. */
function kickerFor(q) {
  if (!q) return 'QUESTION';
  const custom = clean(q.sourceLabel, 24).toUpperCase();
  if (custom) return 'QUESTION · ' + custom;
  const hit = SOURCES.find(s => s.key === q.source);
  return (!hit || hit.key === 'other') ? 'QUESTION' : 'QUESTION · ' + hit.label;
}

function makeQuestion(input, idSeed) {
  const i = input || {};
  return {
    id: 'q_' + (idSeed || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8))),
    source: normalizeSource(i.source),
    sourceLabel: clean(i.sourceLabel, 24),   // only meaningful for source 'other'
    user: clean(i.user, MAX_USER),
    text: clean(i.text, MAX_TEXT),
    ts: Number(i.ts) || Date.now(),
    status: 'new',                            // new | asked | skipped
    star: !!i.star,
    origin: ['discord', 'keyword', 'chat', 'manual'].includes(i.origin) ? i.origin : 'manual',
    ref: clean(i.ref, 40),                    // platform message id — the backlog-pull dedupe key
  };
}

/** Same message id, or the same person asking the same thing — either way, don't queue it twice. */
function isDuplicate(list, q) {
  return list.some(x =>
    (q.ref && x.ref === q.ref) ||
    (x.text.toLowerCase() === q.text.toLowerCase() &&
     x.user.toLowerCase() === q.user.toLowerCase() &&
     x.source === q.source));
}

/**
 * Append unless empty/duplicate. Mutates `list` and returns the new question, or null when
 * it was dropped — callers use the null to skip the save/broadcast entirely.
 */
function addQuestion(list, input, idSeed) {
  const q = makeQuestion(input, idSeed);
  if (!q.text) return null;
  if (isDuplicate(list, q)) return null;
  list.push(q);
  // Over cap: shed answered/skipped questions oldest-first, and only fall back to dropping
  // unanswered ones once there's nothing else left to give.
  while (list.length > MAX_QUESTIONS) {
    const i = list.findIndex(x => x.status !== 'new');
    list.splice(i === -1 ? 0 : i, 1);
  }
  return q;
}

/**
 * Does this chat message open with the capture keyword? Returns the question text with the
 * keyword stripped, or null. Matching is case-insensitive and the keyword must be followed by
 * a space or end-of-message, so "!asking about x" never counts as an "!ask".
 */
function matchKeyword(text, keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  const body = String(text || '').trim();
  if (!kw || !body) return null;
  if (body.toLowerCase().slice(0, kw.length) !== kw) return null;
  const rest = body.slice(kw.length);
  if (rest && !/^[\s:,-]/.test(rest)) return null;
  const out = rest.replace(/^[\s:,-]+/, '').trim();
  return out || null;
}

module.exports = { SOURCES, SOURCE_KEYS, MAX_QUESTIONS, normalizeSource, kickerFor, makeQuestion, addQuestion, matchKeyword };
