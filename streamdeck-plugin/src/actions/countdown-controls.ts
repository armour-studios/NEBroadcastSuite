import { action, type KeyAction, type KeyDownEvent } from "@elgato/streamdeck";
import { SuiteKeyAction } from "./base";
import { suite } from "../suite-connection";
import { tile, textKeySvg, fmtClock, parseDuration } from "../svg";
import { BREAK_TITLES } from "./countdown-clock";

type Settings = {
  op?: string;           // start | pause | stop | reset | visibility | add | sub | headline | cycle
  seconds?: number | string;   // start / reset duration
  title?: string;              // start title, or headline preset ("custom" = customTitle)
  customTitle?: string;
  amount?: number | string;    // add / sub seconds
};

const chosenTitle = (s: Settings): string =>
  s.title === "custom" ? ((s.customTitle || "").trim() || BREAK_TITLES[0]) : (s.title || BREAK_TITLES[0]);

/** Every countdown operation in one action (modelled on the EsportsDash layout the
 *  producer knows): start, pause/resume, stop, reset, show/hide, add/subtract time,
 *  set or cycle the headline. All ops are set_break merges — the server accepts
 *  seconds (restart from now), endsAt (absolute), frozenSeconds (paused) or title
 *  independently, so each op touches only its own field. */
@action({ UUID: "com.armour-studios.ne-broadcast.countdown-controls" })
export class CountdownControls extends SuiteKeyAction<Settings> {
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const s = ev.payload.settings;
    const br = suite.state.breakScreen || {};
    const amt = parseDuration(s.amount, 30);
    switch (s.op) {
      case "pause": {
        if (!br.visible) { await ev.action.showAlert(); return; }
        if (br.endsAt) await this.fire(ev.action, "set_break", { frozenSeconds: Math.max(0, Math.round((br.endsAt - Date.now()) / 1000)) });
        else if (br.frozenSeconds != null) await this.fire(ev.action, "set_break", { seconds: br.frozenSeconds });
        else await ev.action.showAlert();
        return;
      }
      case "stop": {
        // set_break {visible:false} already clears gfxActive when the break is the live layer.
        // An unconditional set_gfx_active('') here also took down whatever OTHER graphic was on
        // air (a Winner pushed after the break) whenever the producer stopped the countdown.
        await this.fire(ev.action, "set_break", { visible: false });
        return;
      }
      case "reset": {
        if (await this.fire(ev.action, "set_break", { seconds: parseDuration(s.seconds, 300) })) await ev.action.showOk();
        return;
      }
      case "visibility": {
        await this.fire(ev.action, "set_break", { visible: !br.visible });
        return;
      }
      case "add":
      case "sub": {
        const delta = s.op === "add" ? amt : -amt;
        if (br.endsAt) {
          await this.fire(ev.action, "set_break", { endsAt: Math.max(Date.now() + 1000, br.endsAt + delta * 1000) });
        } else if (br.frozenSeconds != null) {
          await this.fire(ev.action, "set_break", { frozenSeconds: Math.max(0, br.frozenSeconds + delta) });
        } else {
          await ev.action.showAlert(); // no timer to adjust
        }
        return;
      }
      case "headline": {
        if (await this.fire(ev.action, "set_break", { title: chosenTitle(s) })) await ev.action.showOk();
        return;
      }
      case "cycle": {
        const idx = BREAK_TITLES.indexOf((br.title || "").toUpperCase());
        await this.fire(ev.action, "set_break", { title: BREAK_TITLES[(idx + 1) % BREAK_TITLES.length] });
        return;
      }
      default: { // start
        await this.fire(ev.action, "set_break", {
          visible: true,
          seconds: parseDuration(s.seconds, 300),
          title: typeof s.title === "string" && s.title ? chosenTitle(s) : undefined
        });
        await this.fire(ev.action, "set_gfx_active", { scene: "break" });
      }
    }
  }

  protected override view(s: Settings): string {
    const br = suite.state.breakScreen || {};
    const on = !!br.visible;
    const amt = parseDuration(s.amount, 30);
    const dur = fmtClock(parseDuration(s.seconds, 300));
    switch (s.op) {
      case "pause":      return tile({ glyph: "break-countdown", label: br.frozenSeconds != null ? "RESUME" : "PAUSE", sub: "COUNTDOWN", accent: "#f59e0b", on: on && br.frozenSeconds != null, pill: "PAUSED" });
      case "stop":       return tile({ glyph: "clear-gfx", label: "STOP", sub: "COUNTDOWN", accent: "#ef4444", on, pill: "LIVE" });
      case "reset":      return tile({ glyph: "series-control", label: "RESET", sub: `TO ${dur}`, accent: "#f59e0b", on, pill: "LIVE" });
      case "visibility": return tile({ glyph: "source-toggle", label: on ? "HIDE" : "SHOW", sub: "BREAK SCREEN", accent: "#f59e0b", on, pill: "SHOWN" });
      case "add":        return tile({ glyph: "plus", label: `+${fmtClock(amt)}`, sub: "ADD TIME", accent: "#f59e0b", on, pill: "LIVE" });
      case "sub":        return tile({ glyph: "minus", label: `-${fmtClock(amt)}`, sub: "LESS TIME", accent: "#f59e0b", on, pill: "LIVE" });
      case "headline":   return tile({ glyph: "break-countdown", label: chosenTitle(s), sub: "SET HEADLINE", accent: "#f59e0b", on, pill: "LIVE" });
      case "cycle": {
        const current = (br.title || "").trim() || BREAK_TITLES[0];
        const next = BREAK_TITLES[(BREAK_TITLES.indexOf(current.toUpperCase()) + 1) % BREAK_TITLES.length];
        return textKeySvg({ text: current, sub: `NEXT: ${next}`, on });
      }
      default:           return tile({ glyph: "break-countdown", label: "START", sub: dur, accent: "#f59e0b", on, pill: "LIVE" });
    }
  }
}
