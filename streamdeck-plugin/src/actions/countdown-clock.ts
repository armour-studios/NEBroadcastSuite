import { action, type KeyDownEvent } from "@elgato/streamdeck";
import { SuiteKeyAction } from "./base";
import { suite } from "../suite-connection";
import { clockKeySvg, textKeySvg, fmtClock } from "../svg";

type Settings = {
  press?: string;        // "pause" (default) | "title" | "cycle" | "none"
  format?: string;       // "auto" (default) | "hms" (hh:mm:ss) | "ms" (mm:ss)
  title?: string;        // preset text, or "custom"
  customTitle?: string;
  pressPauses?: boolean; // legacy v0.2 checkbox — false meant "display only"
};

export const BREAK_TITLES = ["STARTING SOON", "BE RIGHT BACK", "UP NEXT", "TECHNICAL DIFFICULTIES"];

function chosenTitle(s: Settings): string {
  if (s.title === "custom") return (s.customTitle || "").trim() || BREAK_TITLES[0];
  return s.title || BREAK_TITLES[0];
}

/** Display-first countdown clock: ticks the live break timer every second.
 *  Press modes: pause/resume the timer (set_break frozenSeconds/seconds — same
 *  fields the producer rail uses), set the break headline to a chosen preset
 *  (set_break merges title without touching the running timer), or cycle the
 *  presets: STARTING SOON / BE RIGHT BACK / UP NEXT / TECHNICAL DIFFICULTIES. */
@action({ UUID: "com.armour-studios.ne-broadcast.countdown-clock" })
export class CountdownClock extends SuiteKeyAction<Settings> {
  constructor() {
    super();
    setInterval(() => {
      if (suite.connected && suite.state.breakScreen?.visible && suite.state.breakScreen?.endsAt) {
        void this.refreshAll();
      }
    }, 1000);
  }

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const s = ev.payload.settings;
    const mode = s.press || (s.pressPauses === false ? "none" : "pause");
    const br = suite.state.breakScreen;
    switch (mode) {
      case "none":
        return;
      case "title": {
        if (await this.fire(ev.action, "set_break", { title: chosenTitle(s) })) await ev.action.showOk();
        return;
      }
      case "cycle": {
        const idx = BREAK_TITLES.indexOf((br?.title || "").toUpperCase());
        const next = BREAK_TITLES[(idx + 1) % BREAK_TITLES.length];
        await this.fire(ev.action, "set_break", { title: next });
        return;
      }
      default: { // pause / resume
        if (!br?.visible) { await ev.action.showAlert(); return; }
        if (br.endsAt) {
          const remaining = Math.max(0, Math.round((br.endsAt - Date.now()) / 1000));
          await this.fire(ev.action, "set_break", { frozenSeconds: remaining });
        } else if (br.frozenSeconds != null) {
          await this.fire(ev.action, "set_break", { seconds: br.frozenSeconds });
        } else {
          await ev.action.showAlert(); // visible but no timer to pause/resume
        }
      }
    }
  }

  protected override view(s: Settings): string {
    const br = suite.state.breakScreen;
    const mode = s.press || (s.pressPauses === false ? "none" : "pause");
    // Cycle keys show WHAT'S ON SCREEN as the key face, plus what a press brings next.
    if (mode === "cycle") {
      const current = (br?.title || "").trim() || BREAK_TITLES[0];
      const idx = BREAK_TITLES.indexOf(current.toUpperCase());
      const next = BREAK_TITLES[(idx + 1) % BREAK_TITLES.length];
      return textKeySvg({ text: current, sub: `NEXT: ${next}`, on: !!br?.visible });
    }
    // Title-setter keys advertise what they will set; everything else shows the live headline.
    const fmt = (sec: number) => fmtClock(sec, s.format);
    const idleSub = mode === "title" ? `SET: ${chosenTitle(s)}` : "NO COUNTDOWN";
    if (!br?.visible) return clockKeySvg({ value: fmt(0).replace(/\d/g, "-"), sub: idleSub, on: false });
    const liveSub = mode === "title" ? `SET: ${chosenTitle(s)}` : (br.title || "COUNTDOWN");
    if (br.endsAt) return clockKeySvg({ value: fmt((br.endsAt - Date.now()) / 1000), sub: liveSub, on: true });
    if (br.frozenSeconds != null) return clockKeySvg({ value: fmt(br.frozenSeconds), sub: mode === "pause" ? "PAUSED - PRESS" : liveSub, on: true, accent: "#8b93a7" });
    return clockKeySvg({ value: fmt(0).replace(/\d/g, "-"), sub: liveSub, on: true });
  }
}
