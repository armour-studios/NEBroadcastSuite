import { action, type KeyDownEvent } from "@elgato/streamdeck";
import { SuiteKeyAction } from "./base";
import { suite } from "../suite-connection";
import { clockKeySvg, parseDuration } from "../svg";

type Settings = { seconds?: number | string; title?: string; cutScene?: string; returnPrev?: boolean };

function fmt(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Toggle the break/starting-soon countdown with this key's own duration+title.
 *  While the countdown runs, the key becomes a live clock (breakScreen.endsAt is an
 *  absolute timestamp; frozenSeconds is a paused producer timer) — a 1s ticker
 *  re-renders, and the base class's diffing drops frames that didn't change.
 *  Optional autocut, same as Graphic On Air. */
@action({ UUID: "com.armour-studios.ne-broadcast.break-countdown" })
export class BreakCountdown extends SuiteKeyAction<Settings> {
  #prevScene = new Map<string, string>();

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
    if (suite.state.breakScreen?.visible) {
      await this.fire(ev.action, "set_break", { visible: false });
      await this.fire(ev.action, "set_gfx_active", { scene: "" });
      const prev = this.#prevScene.get(ev.action.id);
      this.#prevScene.delete(ev.action.id);
      if (s.returnPrev && prev) await this.fire(ev.action, "obs_switch_scene", { sceneName: prev });
    } else {
      await this.fire(ev.action, "set_break", {
        visible: true,
        seconds: parseDuration(s.seconds, 300),
        title: s.title || "STARTING SOON"
      });
      await this.fire(ev.action, "set_gfx_active", { scene: "break" });
      if (s.cutScene) {
        const current = suite.state.obs?.currentScene;
        if (current && current !== s.cutScene) this.#prevScene.set(ev.action.id, current);
        await this.fire(ev.action, "obs_switch_scene", { sceneName: s.cutScene });
      }
    }
  }

  protected override view(s: Settings): string {
    const br = suite.state.breakScreen;
    if (br?.visible) {
      const remaining = br.endsAt ? (br.endsAt - Date.now()) / 1000
        : br.frozenSeconds != null ? br.frozenSeconds
        : 0;
      const paused = !br.endsAt && br.frozenSeconds != null;
      return clockKeySvg({ value: fmt(remaining), sub: paused ? "PAUSED" : (br.title || "ON BREAK"), on: true });
    }
    return clockKeySvg({ value: fmt(parseDuration(s.seconds, 300)), sub: s.title || "STARTING SOON", on: false });
  }
}
