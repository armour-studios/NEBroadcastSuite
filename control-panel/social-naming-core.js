/* social-naming-core.js — pure (DOM-free) {token} engine for clip titles/descriptions.
 *
 * Shared deliberately: the control panel fills these templates while a producer watches, and the
 * weekly automation in backend/social-weekly.js fills the SAME templates at 10am on a Monday with
 * nobody looking. Two copies of this would drift, and the drift would only show up as a wrong
 * title on a published video. Kept free of DOM/globals so server.js can require() it and Node can
 * unit-test it (export guard at the bottom).
 *
 * The interesting part is not substitution, it's what happens when a token resolves to nothing:
 * an unplayed clip has no event, no teams, no round. Naively filling leaves "| vs |" or a blank
 * line mid-description. fillTemplate() works line by line and deletes any line that was made only
 * of tokens and came out empty, then tidies the punctuation the missing values stranded.
 */
(function (root) {
  'use strict';

  // [token, human description] — the description drives the clickable token list in the UI.
  const TOKENS = [
    ['{clip_title}',  "the clip's Twitch title"],
    ['{clipper}',     'who created the clip'],
    ['{broadcaster}', 'the channel it came from'],
    ['{game}',        'Twitch category, else the active game'],
    ['{views}',       'clip view count'],
    ['{duration}',    'clip length in seconds'],
    ['{date}',        'clip date, YYYY-MM-DD'],
    ['{date_long}',   'clip date, written out'],
    ['{clip_url}',    'link back to the Twitch clip'],
    ['{event}',       'current event name'],
    ['{team_a}',      'blue-side team name'],
    ['{team_b}',      'orange-side team name'],
    ['{round}',       'current round label'],
    ['{n}',           'position in the batch, 1-based'],
  ];

  const DEFAULT_TITLE   = '{clip_title} | {event}';
  const DEFAULT_DESC    = '{clip_title}\n\n{event}\n{round}\n{team_a} vs {team_b}\n\nClipped by {clipper} — {clip_url}';
  const DEFAULT_CAPTION = '{clip_title} {clip_url}';

  function titleCaseSlug(s) {
    return String(s || '').split(/[-_\s]+/).filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  /**
   * @param {object} clip  a Twitch Helix clip (title, creator_name, game_id, view_count, …)
   * @param {number} index 0-based position in the batch
   * @param {object} show  { eventName, roundLabel, activeGame, teams:{blue:{name},orange:{name}} }
   * @param {object} games map of Twitch game_id → category name
   */
  function tokenValues(clip, index, show, games) {
    clip = clip || {}; show = show || {}; games = games || {};
    const teams   = show.teams || {};
    const created = clip.created_at ? new Date(clip.created_at) : null;
    return {
      '{clip_title}':  clip.title || '',
      '{clipper}':     clip.creator_name || '',
      '{broadcaster}': clip.broadcaster_name || '',
      '{game}':        games[clip.game_id] || titleCaseSlug(show.activeGame) || '',
      '{views}':       clip.view_count != null ? Number(clip.view_count).toLocaleString() : '',
      '{duration}':    clip.duration ? Math.round(clip.duration) + 's' : '',
      '{date}':        created ? created.toISOString().slice(0, 10) : '',
      '{date_long}':   created ? created.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '',
      '{clip_url}':    clip.url || '',
      '{event}':       show.eventName || '',
      '{team_a}':      (teams.blue   && teams.blue.name)   || '',
      '{team_b}':      (teams.orange && teams.orange.name) || '',
      '{round}':       show.roundLabel || '',
      '{n}':           String((index || 0) + 1),
    };
  }

  // Drop the punctuation left stranded by tokens that resolved to nothing.
  function tidyLine(line) {
    return String(line)
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*([|·—–-])\s*(?:\1\s*)+/g, ' $1 ')     // "A |  | B" → "A | B"
      .replace(/\(\s*\)|\[\s*\]/g, '')                    // empty brackets left by a missing token
      .replace(/\s+([,.!?])/g, '$1')
      .replace(/^[\s|·—–]+/, '')
      .replace(/[\s|·—–]+$/, '')
      // "{team_a} vs {team_b}" with a side (or both) blank leaves a stranded connector.
      .replace(/^\s*vs\.?(\s+|$)/i, '')
      .replace(/\s+vs\.?\s*$/i, '')
      .trim();
  }

  function fillTemplate(tmpl, clip, index, show, games) {
    const vals  = tokenValues(clip, index, show, games);
    const subst = (line) => {
      let out = line;
      for (const tok of Object.keys(vals)) out = out.split(tok).join(vals[tok]);
      return out;
    };
    const kept = [];
    for (const line of String(tmpl == null ? '' : tmpl).split('\n')) {
      const wasBlank = !line.trim();
      const filled   = tidyLine(subst(line));
      if (!filled && !wasBlank) continue;   // whole line evaporated — drop it, don't leave a gap
      kept.push(filled);
    }
    return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * One call for all three fields. `tmpl` may omit any field to fall back to the default.
   * @returns {{title:string, desc:string, caption:string}}
   */
  function renderNames(clip, index, show, games, tmpl) {
    tmpl = tmpl || {};
    const title = fillTemplate(tmpl.title || DEFAULT_TITLE, clip, index, show, games).slice(0, 100);
    return {
      title:   title || String((clip && clip.title) || 'Clip').slice(0, 100),
      desc:    fillTemplate(tmpl.desc    || DEFAULT_DESC,    clip, index, show, games),
      caption: fillTemplate(tmpl.caption || DEFAULT_CAPTION, clip, index, show, games).slice(0, 280),
    };
  }

  const api = { TOKENS, DEFAULT_TITLE, DEFAULT_DESC, DEFAULT_CAPTION,
    titleCaseSlug, tokenValues, tidyLine, fillTemplate, renderNames };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SocialNamingCore = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
