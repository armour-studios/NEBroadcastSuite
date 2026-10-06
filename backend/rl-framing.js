'use strict';
// Frames the Rocket League Stats API TCP stream into complete JSON objects.
//
// RL writes bare JSON objects back to back with no guaranteed delimiter, and a single TCP read can hold
// half an object, several objects, or both. The previous "split on }{" approach always held back the
// last piece even when it was complete (so a lone MatchEnded sat in the buffer until the next event),
// and could split inside a string. This scans brace depth while respecting strings/escapes, so it emits
// exactly the objects that are complete and keeps only a genuine partial tail.
//
// feed(buffer) -> { messages: [string,...], rest: string }
function frameJson(buf) {
  const messages = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  let consumed = 0;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { if (depth > 0) inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; continue; }
    if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0) { messages.push(buf.slice(start, i + 1)); consumed = i + 1; start = -1; }
    }
  }
  // Anything after the last complete object: keep from the open brace if one is pending,
  // otherwise it is inter-message noise (whitespace/newlines) and is dropped.
  const rest = depth > 0 && start >= 0 ? buf.slice(start) : '';
  return { messages, rest };
}
module.exports = { frameJson };
