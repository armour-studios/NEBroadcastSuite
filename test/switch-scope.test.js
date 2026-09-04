// node test/switch-scope.test.js
//
// Guards a bug class that is invisible at a glance and silent at runtime.
//
// A switch body is ONE block scope shared by every case, but `let` / `const` / `class` are not
// hoisted-initialized the way `function` is. Entering a case jumps straight to its label, so a
// declaration written between cases NEVER runs — the binding stays in its temporal dead zone and
// the first case to touch it throws `ReferenceError: Cannot access 'x' before initialization`.
//
// That is exactly how "Reset series stopped working" happened: `let _smashGameClosed = false;` was
// written mid-switch in server.js, `case 'reset_series'` assigned it as its first statement, the
// ReferenceError was swallowed by the WS handler's try/catch, and the button silently did nothing.
// The Smash auto-advance was dead for the same reason.
//
// Declarations INSIDE a case's own `{ }` block are fine — this only flags the switch-body level.
'use strict';
const fs = require('fs');
const path = require('path');

const FILES = ['server.js'];
let failures = 0;

function lineIndex(src) {
  const off = [];
  let acc = 0;
  for (const l of src.split('\n')) { off.push(acc); acc += l.length + 1; }
  return (i) => {
    let lo = 0, hi = off.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (off[m] <= i) lo = m; else hi = m - 1; }
    return lo + 1;
  };
}

// Walks a switch body from its opening brace, skipping strings, template literals, comments and
// regex literals, and reports let/const/class declared at depth 1 (the switch body itself).
function scanSwitchBody(src, braceAt, lineOf) {
  let depth = 0, prevSig = '';
  const hits = [];
  let i = braceAt;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) break;
        if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
          let d = 1; i += 2;
          while (i < src.length && d) { if (src[i] === '{') d++; else if (src[i] === '}') d--; i++; }
          continue;
        }
        i++;
      }
      prevSig = q; continue;
    }
    if (c === '/' && /[=(,:[!&|?{};+\-*%~^<>]/.test(prevSig)) {
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') { while (i < src.length && src[i] !== ']') i++; }
        if (src[i] === '/' || src[i] === '\n') break;
        i++;
      }
      prevSig = '/'; continue;
    }
    if (c === '{') { depth++; prevSig = c; continue; }
    if (c === '}') { depth--; if (depth === 0) break; prevSig = c; continue; }
    if (depth === 1 && /[a-z]/i.test(c)) {
      const m = /^(let|const|class)\s+([A-Za-z_$][\w$]*)/.exec(src.slice(i, i + 60));
      if (m && !/[\w$.]/.test(src[i - 1] || ' ')) {
        hits.push({ line: lineOf(i), kind: m[1], name: m[2] });
        i += m[0].length - 1;
        prevSig = 'x';
        continue;
      }
    }
    if (!/\s/.test(c)) prevSig = c;
  }
  return { hits, end: i };
}

for (const file of FILES) {
  const full = path.join(__dirname, '..', file);
  const src = fs.readFileSync(full, 'utf8');
  const lineOf = lineIndex(src);
  const re = /\bswitch\s*\([^)]*\)\s*\{/g;
  let m, switches = 0, found = 0;
  while ((m = re.exec(src)) !== null) {
    switches++;
    const braceAt = m.index + m[0].length - 1;
    const { hits } = scanSwitchBody(src, braceAt, lineOf);
    for (const h of hits) {
      found++;
      console.log(`FAIL  ${file}:${h.line}  \`${h.kind} ${h.name}\` is declared in a switch BODY`);
      console.log(`      Every case jumps past it, so it stays in its temporal dead zone and the`);
      console.log(`      first case that touches it throws ReferenceError. Move it to module scope,`);
      console.log(`      or wrap that case in its own { } block if it is genuinely case-local.`);
    }
  }
  if (!found) console.log(`PASS  ${file} — ${switches} switch statements, no block-scoped declarations in any switch body`);
  failures += found;
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nall passed');
process.exit(failures ? 1 : 0);
