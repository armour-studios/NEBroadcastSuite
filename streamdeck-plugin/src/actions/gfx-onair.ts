import { action, type KeyDownEvent } from "@elgato/streamdeck";
import { SuiteKeyAction } from "./base";
import { suite } from "../suite-connection";
import { gfxByKey, gfxIsLive } from "../gfx";
import { tile } from "../svg";

type Settings = { gfx?: string; side?: string; cutScene?: string; returnPrev?: boolean };

/** Toggle an exclusive full-screen graphic, mirroring the panel's GOLIVE toggles:
 *  the per-graphic message carries params (winner/intro side), then set_gfx_active
 *  does the exclusive switch server-side (only one graphic renders at a time).
 *  Like the panel's autocut option, an optional cutScene also switches OBS when the
 *  graphic goes live; returnPrev cuts back to whatever was live when it hides. */
@action({ UUID: "com.armour-studios.ne-broadcast.gfx-onair" })
export class GfxOnAir extends SuiteKeyAction<Settings> {
  #prevScene = new Map<string, string>();

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const s = ev.payload.settings;
    const g = gfxByKey(s.gfx);
    if (!g) { await ev.action.showAlert(); return; }
    // Standalone scenes (Desk Show): live = the program is on that scene, so the
    // toggle is a pair of switcher cuts — there and back — not a gfx-layer push.
    if (g.standaloneScene) {
      if (gfxIsLive(suite.state, g)) {
        const prev = this.#prevScene.get(ev.action.id);
        this.#prevScene.delete(ev.action.id);
        const back = prev || suite.state.preshow?.homeScene;
        if (back) await this.fire(ev.action, "obs_switch_scene", { sceneName: back });
        else await ev.action.showAlert(); // nowhere to return to — pick a scene key instead
      } else {
        const current = suite.state.obs?.currentScene;
        if (current && current !== g.standaloneScene) this.#prevScene.set(ev.action.id, current);
        await this.fire(ev.action, "obs_switch_scene", { sceneName: g.standaloneScene });
      }
      return;
    }
    if (gfxIsLive(suite.state, g)) {
      if (g.msg) await this.fire(ev.action, g.msg, { visible: false });
      await this.fire(ev.action, "set_gfx_active", { scene: "" });
      const prev = this.#prevScene.get(ev.action.id);
      this.#prevScene.delete(ev.action.id);
      if (s.returnPrev && prev) await this.fire(ev.action, "obs_switch_scene", { sceneName: prev });
    } else {
      if (g.msg) {
        const payload: Record<string, unknown> = { visible: true };
        if (g.side) {
          if (g.msg === "set_winner") {
            // The Winner graphic ALWAYS shows whoever is winning the series (from Match — Teams), so
            // one button is always right — no per-side buttons, no team setup. We resolve the leader
            // from live state here (a tie falls back to the button's side / blue).
            const b = Number(suite.state.series?.blue) || 0;
            const o = Number(suite.state.series?.orange) || 0;
            payload.side = b > o ? "blue" : o > b ? "orange" : (s.side === "orange" ? "orange" : "blue");
          } else {
            payload.side = s.side === "orange" ? "orange" : "blue";   // Line-up uses the chosen side
          }
        }
        await this.fire(ev.action, g.msg, payload);
      }
      await this.fire(ev.action, "set_gfx_active", { scene: g.key });
      if (s.cutScene) {
        const current = suite.state.obs?.currentScene;
        if (current && current !== s.cutScene) this.#prevScene.set(ev.action.id, current);
        await this.fire(ev.action, "obs_switch_scene", { sceneName: s.cutScene });
      }
    }
  }

  protected override view(s: Settings): string {
    const g = gfxByKey(s.gfx);
    return tile({
      glyph: "gfx-onair",
      label: g ? g.label : "Graphic?",
      sub: s.cutScene ? `+ ${s.cutScene}` : "GRAPHIC",
      on: !!g && gfxIsLive(suite.state, g),
      pill: "ON AIR"
    });
  }
}
