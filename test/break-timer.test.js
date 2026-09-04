// Exercises the set_break merge rules that decide whether a borrowed clock is armed, without
// booting the app: the same expressions, pulled out and driven with the real message shapes.
const assert = require('assert');
function merge(cur, b) {
  const out = {
    visible: ('visible' in b) ? !!b.visible : !!cur.visible,
    endsAt: ('frozenSeconds' in b) ? null
      : ('seconds' in b) ? (b.seconds > 0 ? 1000000 + Math.round(b.seconds * 1000) : null)
      : ('endsAt' in b ? (b.endsAt || null) : (cur.endsAt ?? null)),
    frozenSeconds: ('frozenSeconds' in b) ? (b.frozenSeconds != null ? Math.max(0, Math.round(b.frozenSeconds)) : null)
      : (('seconds' in b || 'endsAt' in b || 'until' in b) ? null : (cur.frozenSeconds ?? null)),
  };
  if (b.visible === false && !('seconds' in b) && !('endsAt' in b) && !('until' in b) && !('frozenSeconds' in b)) {
    out.endsAt = null; out.frozenSeconds = null;
  }
  return out;
}
const armed = (b) => (b.frozenSeconds != null || !!b.endsAt);   // what the desk scenes now ask

let st = { visible: false, endsAt: null, frozenSeconds: null };
st = merge(st, { seconds: 300 });                       // top-bar Start — no `visible`
assert.strictEqual(st.visible, false, 'Start must not punch the break graphic on air');
assert.ok(armed(st), 'Start arms the clock the desk scenes borrow');

st = merge(st, { frozenSeconds: 120 });                 // Pause
assert.ok(armed(st), 'a paused timer still shows its frozen value');

st = merge(st, { seconds: 120 });                       // Resume
assert.ok(armed(st) && st.endsAt, 'resume re-anchors endsAt');

st = merge(st, { visible: false });                     // Hide → disarms
assert.ok(!armed(st), 'Hide clears the countdown for every scene that borrows it');

st = merge({ visible: false, endsAt: null, frozenSeconds: null }, { visible: true, seconds: 300 });
assert.ok(st.visible && armed(st), 'Show countdown arms AND shows');
st = merge(st, { visible: false, seconds: 600 });        // not a bare Hide
assert.ok(armed(st), 'a message that also sets a timer is setting one, not hiding one');

console.log('PASS  break timer arming — 7 assertions');
