/* search-core.js — one matcher for every search box in the suite.
 *
 * Every filter box used to do its own `name.toLowerCase().includes(q)`, which meant a producer
 * typing "nmls" found nothing, "TSM Reborn" only matched if you typed the words in order, and a
 * one-character typo returned an empty list mid-show. This is the shared scorer they all call now.
 *
 * What a query can be:
 *   substring      "storm"   → Thunder Storm
 *   word prefix    "th st"   → Thunder Storm      (each word must land somewhere)
 *   acronym        "ts"      → Thunder Storm      (initials of the words)
 *   subsequence    "thstm"   → Thunder Storm      (in-order letters, gaps penalised)
 *   typo           "thnuder" → Thunder Storm      (one transposition/edit, short queries only)
 *
 * Scores are comparable across items so callers can sort by them. Higher is better; a negative
 * score means "no match" and the item should be dropped.
 *
 * Loaded before app.js — everything else may depend on it, it depends on nothing.
 */
(function (global) {
  'use strict';

  // Tiers are spaced far enough apart that a better *kind* of match always outranks a worse kind
  // regardless of field weight, so a real substring hit can never lose to a lucky fuzzy one.
  var T_EXACT   = 1000;  // the field IS the query
  var T_PREFIX  = 700;   // field starts with it
  var T_WORD    = 500;   // a word inside the field starts with it
  var T_ACRONYM = 380;   // initials spell it
  var T_SUB     = 260;   // appears anywhere
  var T_FUZZY   = 120;   // in-order letters
  var T_TYPO    = 60;    // within one edit of a word

  function norm(s) {
    if (s == null) return '';
    var t = String(s).toLowerCase();
    // Strip accents so "Ünder" is reachable by typing "under".
    try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
    return t;
  }

  // Word starts: index 0 plus every position after a separator or a lower→Upper camel boundary,
  // so "streamQueue" and "Stream Queue" both give the same acronym "sq".
  function wordStarts(raw) {
    var out = [];
    var prevSep = true;
    for (var i = 0; i < raw.length; i++) {
      var c = raw[i];
      var isSep = !/[a-z0-9]/i.test(c);
      if (isSep) { prevSep = true; continue; }
      var camel = i > 0 && /[a-z0-9]/.test(raw[i - 1]) && /[A-Z]/.test(c);
      if (prevSep || camel) out.push(i);
      prevSep = false;
    }
    return out;
  }

  // Damerau-Levenshtein (optimal string alignment) capped at `max`. Transposition counts as ONE
  // edit, not two — "thnuder" for "thunder" is the typo people actually make, and plain Levenshtein
  // scores it 2 and throws the match away. Bails out as soon as a whole row exceeds the budget,
  // which keeps it cheap on the long non-matching strings that dominate a big list.
  function editWithin(a, b, max) {
    var la = a.length, lb = b.length;
    if (Math.abs(la - lb) > max) return false;
    var prev2 = null, prev = new Array(lb + 1), cur = new Array(lb + 1), i, j;
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      cur[0] = i;
      var best = cur[0];
      for (j = 1; j <= lb; j++) {
        var cost = a[i - 1] === b[j - 1] ? 0 : 1;
        var v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          v = Math.min(v, prev2[j - 2] + 1);
        }
        cur[j] = v;
        if (v < best) best = v;
      }
      if (best > max) return false;
      prev2 = prev; prev = cur; cur = new Array(lb + 1);
    }
    return prev[lb] <= max;
  }

  // In-order letter match. Returns a 0..1 quality: consecutive runs and word-start landings score
  // high, scattered letters score low, so "sq" prefers "Stream Queue" over "Sponsor Packages".
  //
  // The first matched letter MUST land on a word start. That one rule is what separates a real
  // abbreviation ("bkt" → Bracket, "nmls" → Nameless Esports) from letters that merely happen to
  // appear in order ("veto" → "E-v-en-t-Ops"), which a quality threshold alone cannot do — the
  // junk match scored higher than both good ones.
  function fuzzy(hay, needle, starts) {
    var hi = 0, ni = 0, hits = 0, runs = 0, run = 0, startHits = 0, first = -1;
    var startSet = starts;
    while (hi < hay.length && ni < needle.length) {
      if (hay[hi] === needle[ni]) {
        hits++;
        if (run > 0) runs++;
        run++;
        if (startSet.indexOf(hi) !== -1) startHits++;
        if (first === -1) first = hi;
        ni++;
      } else {
        run = 0;
      }
      hi++;
    }
    if (ni < needle.length) return -1;
    if (starts.indexOf(first) === -1) return -1;
    var density = needle.length / Math.max(1, hay.length);
    return Math.min(1, (runs / needle.length) * 0.5 + (startHits / needle.length) * 0.3 + density * 0.2);
  }

  /* Score one query word against one field. -1 = miss.
   *
   * `loose` enables the two forgiving tiers (subsequence + typo). Callers turn it OFF for fields
   * that are bags of vocabulary rather than names — a section chip, a hidden keyword list, a
   * concatenated data-search blob. Subsequence matching over a long blob finds letters in almost
   * anything ("veto" hides inside "Video Editor" and inside "vdo ninja cameras api key stations"),
   * which filled the results with matches no human would call matches. On a real name it's the
   * feature that lets "bkt" find Bracket, so it stays on by default.
   */
  function scoreWord(field, word, loose, bag) {
    if (!field || !word) return -1;

    // A "bag" field is a concatenation of many words (a hidden keyword list, a data-search blob,
    // a joined roster) rather than a name. Whole-field exact/prefix/acronym tiers are meaningless
    // on one — matching the blob's FIRST word earned the 700-point prefix tier purely because of
    // list order, which let a keyword mention outrank the panel actually named after the query
    // ("startgg" ranked Tournament Platforms above Tournaments (start.gg)). Bags start at the
    // word-start tier.
    if (!bag) {
      if (field === word) return T_EXACT;
      if (field.indexOf(word) === 0) return T_PREFIX + Math.round(60 * word.length / field.length);
    }

    var starts = wordStarts(field);

    // Word-start prefix — the most common real hit ("queue" → "Stream Queue").
    for (var i = 0; i < starts.length; i++) {
      if (field.startsWith(word, starts[i])) return T_WORD + Math.round(40 * word.length / field.length);
    }

    // Acronym: initials of the words, in order. Meaningless across a bag of unrelated keywords.
    if (!bag && word.length >= 2 && starts.length >= 2) {
      var acr = '';
      for (var a = 0; a < starts.length; a++) acr += field[starts[a]];
      if (acr === word) return T_ACRONYM + 40;
      if (acr.indexOf(word) === 0) return T_ACRONYM;
    }

    var at = field.indexOf(word);
    if (at !== -1) return T_SUB + Math.round(40 * word.length / field.length) - Math.min(20, at);

    // Punctuation-insensitive retry, once the literal comparisons have failed. Typing "startgg"
    // must find "start.gg", "tsm" must find "T.S.M", "kaisa" must find "Kai'Sa" — a dot in the
    // middle of a name was enough to make the name itself unmatchable, leaving the query to be
    // decided by whichever keyword list happened to mention it. Scored just below the literal
    // tiers so an exact spelling always wins.
    var sf = field.replace(/[^a-z0-9]+/g, '');
    var sw = word.replace(/[^a-z0-9]+/g, '');
    if (sw && (sf !== field || sw !== word)) {
      if (!bag) {
        if (sf === sw) return T_EXACT - 60;
        if (sf.indexOf(sw) === 0) return T_PREFIX - 60;
      }
      if (sf.indexOf(sw) !== -1) return T_SUB - 40;
    }

    if (!loose) return -1;

    // Fuzzy only pays off once there's enough of a query to be meaningful; below 3 chars it matches
    // nearly everything and the result list turns to noise.
    if (word.length >= 3) {
      var q = fuzzy(field, word, starts);
      if (q >= 0) return T_FUZZY + Math.round(q * 90);
    }

    // Typo tolerance, per word of the field. Budget grows with length: one edit for short words,
    // two once the word is long enough that two typos are plausible.
    if (word.length >= 4) {
      var max = word.length >= 8 ? 2 : 1;
      var parts = field.split(/[^a-z0-9]+/);
      for (var p = 0; p < parts.length; p++) {
        var pt = parts[p];
        if (!pt || Math.abs(pt.length - word.length) > max) continue;
        if (editWithin(pt, word, max)) return T_TYPO + Math.round(30 / max);
      }
    }
    return -1;
  }

  /* Score a query against a set of weighted fields.
   *
   * fields: array of strings, or of { text, weight } (weight defaults to 1; the primary display
   * name should be ~2 so a name hit beats a hit buried in keyword vocabulary).
   *
   * Every query word must land on SOME field (AND across words, OR across fields) — that's what
   * makes multi-word queries like "gold rl hud" progressively narrow instead of widening.
   *
   * opts.any relaxes that to "at least one word", ranking by how many words landed. Callers use it
   * as a SECOND pass when strict matching found nothing: "dark mode" returned an empty list purely
   * because nothing anywhere contains the word "mode", which reads as "the app doesn't have this"
   * rather than "one of your words was noise".
   */
  function score(query, fields, opts) {
    var words = tokens(query);
    if (!words.length) return 0;

    var fs = [];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f == null) continue;
      var text = typeof f === 'string' ? f : f.text;
      if (!text) continue;
      fs.push({
        t: norm(text),
        w: (typeof f === 'string' ? 1 : (f.weight == null ? 1 : f.weight)),
        // { fuzzy: false } turns off the forgiving tiers; { bag: true } additionally says
        // "this is a concatenation, not a name" and also implies fuzzy: false. See scoreWord.
        loose: (typeof f === 'string' ? true : (f.fuzzy !== false && !f.bag)),
        bag: (typeof f === 'string' ? false : !!f.bag)
      });
    }
    if (!fs.length) return -1;

    var any = !!(opts && opts.any);
    var total = 0, matched = 0;
    for (var wi = 0; wi < words.length; wi++) {
      var best = -1;
      for (var fi = 0; fi < fs.length; fi++) {
        var s = scoreWord(fs[fi].t, words[wi], fs[fi].loose, fs[fi].bag);
        if (s < 0) continue;
        s = s * fs[fi].w;
        if (s > best) best = s;
      }
      if (best < 0) {
        if (!any) return -1;            // this word landed nowhere — not a match
        continue;
      }
      total += best;
      matched++;
    }
    if (!matched) return -1;
    // Average over the number of words TYPED, not the number that matched, so an unmatched word
    // costs its full share. Averaging over matched-only made "thunder zzzz" outrank "thunder
    // storm": adding a real but lower-tier second word dragged the mean down, while a garbage word
    // was merely a flat penalty. In strict mode every word matched, so this is the plain average.
    // The small bonus then favours rows that satisfied more of the query.
    return total / words.length + (matched - 1) * 8;
  }

  function tokens(query) {
    return norm(query).split(/\s+/).filter(Boolean);
  }

  /* True/false convenience for the many call sites that only need "does this row survive the box". */
  function matches(query, fields) {
    if (!query || !String(query).trim()) return true;
    return score(query, fields) >= 0;
  }

  /* Filter + rank a list in one call. getFields(item) returns the same shape `score` takes.
   * An empty query returns the list untouched (and in its original order). */
  function filter(list, query, getFields, opts) {
    var arr = Array.isArray(list) ? list : [];
    if (!query || !String(query).trim()) return arr.slice();
    var limit = (opts && opts.limit) || 0;
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var s = score(query, getFields(arr[i], i) || []);
      if (s < 0) continue;
      if (opts && opts.boost) s += opts.boost(arr[i], i) || 0;
      out.push({ item: arr[i], s: s, i: i });
    }
    out.sort(function (a, b) { return (b.s - a.s) || (a.i - b.i); });
    if (limit) out = out.slice(0, limit);
    return out.map(function (x) { return x.item; });
  }

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }

  /* Escaped HTML with the matched stretches wrapped in <mark>. Marks every query word that occurs
   * as a substring; fuzzy-only hits are left unmarked rather than scattering marks over stray
   * letters, which reads as noise. */
  function highlight(text, query) {
    var raw = String(text == null ? '' : text);
    var words = tokens(query);
    if (!words.length) return esc(raw);
    var low = norm(raw);
    var hits = [];
    for (var w = 0; w < words.length; w++) {
      var from = 0, at;
      while ((at = low.indexOf(words[w], from)) !== -1) {
        hits.push([at, at + words[w].length]);
        from = at + words[w].length;
      }
    }
    if (!hits.length) return esc(raw);
    hits.sort(function (a, b) { return a[0] - b[0]; });
    // Merge overlaps so nested/adjacent hits don't produce broken nested <mark> tags.
    var merged = [hits[0]];
    for (var h = 1; h < hits.length; h++) {
      var last = merged[merged.length - 1];
      if (hits[h][0] <= last[1]) last[1] = Math.max(last[1], hits[h][1]);
      else merged.push(hits[h]);
    }
    var out = '', pos = 0;
    for (var m = 0; m < merged.length; m++) {
      out += esc(raw.slice(pos, merged[m][0])) + '<mark>' + esc(raw.slice(merged[m][0], merged[m][1])) + '</mark>';
      pos = merged[m][1];
    }
    return out + esc(raw.slice(pos));
  }

  /* Filter a set of already-rendered cards in place: hide the misses, and order the hits best-first.
   *
   * The card grids (teams, flows, scenes, camera rows) render once and then only show/hide, so they
   * used to leave the best match wherever the library happened to put it — with 200 teams a good
   * match could sit below the fold of a "filtered" grid. `order` works on the flex/grid containers
   * these all use, so ranking costs nothing and needs no re-render.
   *
   * getFields(node) → fields for score(); pass `extra(node)` in opts to AND in a non-text filter
   * (an origin chip, a group nav) that must apply regardless of the query.
   * Returns { shown, total }.
   */
  function rankNodes(nodes, query, getFields, opts) {
    opts = opts || {};
    var list = Array.prototype.slice.call(nodes);
    var q = query && String(query).trim();
    var scored = [];
    var shown = 0;
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      var pass = opts.extra ? !!opts.extra(n) : true;
      var s = (pass && q) ? score(q, getFields(n) || []) : (pass ? 0 : -1);
      if (s < 0) { n.style.display = 'none'; n.style.order = ''; continue; }
      n.style.display = '';
      shown++;
      scored.push({ n: n, s: s, i: i });
    }
    if (!q) {
      // No query — restore the library's own order rather than leaving a stale ranking behind.
      for (var c = 0; c < scored.length; c++) scored[c].n.style.order = '';
      return { shown: shown, total: list.length };
    }
    scored.sort(function (a, b) { return (b.s - a.s) || (a.i - b.i); });
    for (var r = 0; r < scored.length; r++) scored[r].n.style.order = String(r);
    return { shown: shown, total: list.length };
  }

  /* Wire a plain filter box: debounced input + Escape-to-clear, calling back with the query.
   * Returns a function that re-runs the current query (handy after the underlying list changes). */
  function bindBox(input, onQuery, delay) {
    if (!input) return function () {};
    var timer = null;
    var fire = function () { try { onQuery(input.value.trim()); } catch (e) { console.error(e); } };
    input.addEventListener('input', function () {
      clearTimeout(timer);
      // Short queries scan the whole list on every keystroke; a small debounce keeps a 2000-row
      // library from stuttering while still feeling instant.
      timer = setTimeout(fire, delay == null ? 90 : delay);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && input.value) { e.stopPropagation(); input.value = ''; clearTimeout(timer); fire(); }
    });
    return fire;
  }

  /* Arrow-key navigation for a search box that renders results into a container.
   *
   * Several result dropdowns were mouse-only — you could type a query and then had to reach for
   * the mouse to take the first hit, which is the wrong ergonomics for a box you're typing in.
   * This binds Up/Down/Enter/Escape over whatever the container currently holds, re-reading the
   * DOM on each keypress so it doesn't care when or how the list was re-rendered.
   *
   * itemSelector picks the clickable rows; activeClass is toggled on the current one (style it,
   * or pass one the page already styles). Enter clicks the row, so the existing click handler
   * stays the single definition of what picking a result does.
   */
  function bindListNav(input, container, itemSelector, opts) {
    if (!input || !container) return;
    opts = opts || {};
    var activeClass = opts.activeClass || 'is-kbd-active';
    var idx = -1;
    var items = function () { return Array.prototype.slice.call(container.querySelectorAll(itemSelector)); };
    var visible = function () { return container.offsetParent !== null && !container.hidden; };
    var paint = function (list) {
      list.forEach(function (n, i) {
        n.classList.toggle(activeClass, i === idx);
        if (i === idx && n.scrollIntoView) n.scrollIntoView({ block: 'nearest' });
      });
    };
    // Any re-render invalidates the selection — a stale index would point at a different result.
    input.addEventListener('input', function () { idx = -1; });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { idx = -1; if (opts.onEscape) opts.onEscape(); return; }
      if (!visible()) return;
      var list = items();
      if (!list.length) return;
      // stopImmediatePropagation on the keys we consume: these boxes usually already have their
      // own Enter handler that fires a fresh search, and we must not both pick a result AND
      // re-run the query. Bind this BEFORE that handler so ours wins when a row is selected.
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopImmediatePropagation(); idx = (idx + 1) % list.length; paint(list); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); idx = (idx <= 0 ? list.length : idx) - 1; paint(list); }
      else if (e.key === 'Enter' && idx >= 0 && list[idx]) {
        e.preventDefault(); e.stopImmediatePropagation();
        // Some of these lists are wired on mousedown (to beat the input's blur), where .click()
        // never reaches the handler — those pass their own `pick`.
        if (opts.pick) opts.pick(list[idx]); else list[idx].click();
        idx = -1;
      }
    });
  }

  global.NESearch = {
    score: score,
    matches: matches,
    filter: filter,
    rankNodes: rankNodes,
    highlight: highlight,
    tokens: tokens,
    norm: norm,
    esc: esc,
    bindBox: bindBox,
    bindListNav: bindListNav
  };
})(typeof window !== 'undefined' ? window : globalThis);
