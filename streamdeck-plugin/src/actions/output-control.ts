import { action, type KeyAction, type KeyDownEvent, type KeyUpEvent } from "@elgato/streamdeck";
import { SuiteKeyAction } from "./base";
import { suite } from "../suite-connection";
import { tile, fmtClock } from "../svg";

type Settings = { output?: string; hold?: boolean }; // output: "stream" (default) | "record"

const HOLD_MS = 600;

/** Live output status for the active switcher backend (OBS, or vMix when it is the target). */
function outputStatus(output: string): { linked: boolean; on: boolean; since: number } {
  const st = suite.state;
  const rec = output === "record";
  if (st.switcher?.target === "vmix") {
    const v = st.vmix || {};
    return { linked: !!(v.enabled && v.connected), on: !!(rec ? v.recording : v.streaming), since: 0 };
  }
  const o = st.obs || {};
  return {
    linked: !!o.connected,
    on: !!(rec ? o.recording : o.streaming),
    since: Number(rec ? o.recordStartedAt : o.streamStartedAt) || 0
  };
}

/** Go live / Record — the same switcher_stream / switcher_record the program bar sends, so it
 *  drives OBS or vMix, whichever is the active backend. Starting OR stopping needs a hold by
 *  default: ending a broadcast by a stray tap is the one mistake a producer can't undo. The key
 *  shows LIVE/REC with a running uptime off the suite's own start stamp. */
@action({ UUID: "com.armour-studios.ne-broadcast.output-control" })
export class OutputControl extends SuiteKeyAction<Settings> {
  #downAt = new Map<string, number>();

  constructor() {
    super();
    setInterval(() => {
      if (!suite.connected) return;
      const o = suite.state.obs || {};
      const v = suite.state.vmix || {};
      if (o.streaming || o.recording || v.streaming || v.recording) void this.refreshAll();
    }, 1000);
  }

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    if (ev.payload.settings.hold !== false) {
      this.#downAt.set(ev.action.id, Date.now());
      return;
    }
    await this.#toggle(ev.action, ev.payload.settings);
  }

  override async onKeyUp(ev: KeyUpEvent<Settings>): Promise<void> {
    const down = this.#downAt.get(ev.action.id);
    if (down === undefined) return;
    this.#downAt.delete(ev.action.id);
    if (Date.now() - down >= HOLD_MS) await this.#toggle(ev.action, ev.payload.settings);
    else await ev.action.showAlert(); // tapped, not held — refused on purpose
  }

  async #toggle(a: KeyAction<Settings>, s: Settings): Promise<void> {
    const output = s.output === "record" ? "record" : "stream";
    const st = outputStatus(output);
    if (!st.linked) { await a.showAlert(); return; }
    const type = output === "record" ? "switcher_record" : "switcher_stream";
    if (await this.fire(a, type, { on: !st.on })) await a.showOk();
  }

  protected override view(s: Settings): string {
    const rec = s.output === "record";
    const st = outputStatus(rec ? "record" : "stream");
    const hold = s.hold !== false;
    const uptime = st.on && st.since ? fmtClock((Date.now() - st.since) / 1000) : "";
    let sub: string;
    if (!st.linked) sub = suite.state.switcher?.target === "vmix" ? "VMIX OFFLINE" : "OBS OFFLINE";
    else if (st.on) sub = uptime || (rec ? "RECORDING" : "ON AIR");
    else sub = hold ? "HOLD TO START" : (rec ? "NOT RECORDING" : "OFF AIR");
    return tile({
      glyph: rec ? "replay-buffer" : "output-control",
      label: rec ? (st.on ? "STOP REC" : "RECORD") : (st.on ? "END STREAM" : "GO LIVE"),
      sub,
      accent: "#ef4444",
      on: st.on,
      pill: rec ? "REC" : "LIVE"
    });
  }
}
