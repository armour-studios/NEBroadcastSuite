import { action, type KeyDownEvent } from "@elgato/streamdeck";
import { SuiteKeyAction } from "./base";
import { suite } from "../suite-connection";
import { tile, textKeySvg } from "../svg";

type Settings = { mode?: string }; // "next" (default) | "prev" | "current" | "stop"

/** Navigate the panel's Run of Show. The rundown runner lives in the control panel,
 *  so keys send 'rundown_control' ops the server relays to it; the panel publishes
 *  state.rundownStatus (current/next/prev labels + position) for the key faces. */
@action({ UUID: "com.armour-studios.ne-broadcast.run-of-show" })
export class RunOfShow extends SuiteKeyAction<Settings> {
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const mode = ev.payload.settings.mode || "next";
    const op = mode === "current" ? "run" : mode;
    await this.fire(ev.action, "rundown_control", { op });
  }

  protected override view(s: Settings): string {
    const rs = suite.state.rundownStatus || {};
    const running = !!rs.running;
    const posSub = running ? `${rs.pos || 0}/${rs.total || 0}` : "RUN OF SHOW";
    switch (s.mode) {
      case "prev":
        return textKeySvg({ text: rs.prev || (running ? "AT TOP" : "NOT RUNNING"), sub: `GO BACK - ${posSub}`, on: running, accent: "#7c5cff" });
      case "current":
        return textKeySvg({ text: running ? (rs.current || "...") : "IDLE", sub: running ? `NOW ${posSub} - RERUN` : "PRESS = START", on: running, accent: "#7c5cff" });
      case "stop":
        return tile({ glyph: "clear-gfx", label: "END SHOW", sub: running ? rs.current || "" : "NOT RUNNING", accent: "#ef4444", on: running, pill: "LIVE" });
      default: // next
        return textKeySvg({ text: rs.next || (running ? "END OF SHOW" : "FROM TOP"), sub: running ? `NEXT - NOW: ${rs.current || ""}` : "START SHOW", on: running, accent: "#7c5cff" });
    }
  }
}
