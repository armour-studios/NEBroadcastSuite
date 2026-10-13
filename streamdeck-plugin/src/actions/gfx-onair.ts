import { action, type KeyDownEvent } from "@elgato/streamdeck";
import { SuiteKeyAction } from "./base";
import { suite } from "../suite-connection";
import { gfxByKey, gfxIsLive } from "../gfx";
import { tile } from "../svg";

type Settings = { gfx?: string; side?: string; cutScene?: string; returnPrev?: boolean };

/** The side leading the series (Match — Teams), or "" on a tie / 0-0 — the Winner graphic follows
 *  this instead of a per-button side, so ONE key always crowns the right team. */
function leadingSide(state: Record<string, any>): "blue" | "orange" | "" {
  const b = Number(state.series?.blue) || 0;
  const o = Number(state.series?.orange) || 0;
  return b > o ? "blue" : o > b ? "orange" : "";
}

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
      // The server's set_gfx_active mirroring deliberately skips the watchlist/spotlight flag, so
      // replacing a live Spotlight would leave watchlist.visible stuck on (watchlist.html stays up
      // and the key stays lit). Hide it first — exactly what the panel's rail does via its Clear.
      const prev = gfxByKey(suite.state.gfxActive);
      if (prev && prev !== g && prev.key === "spotlight" && prev.msg) await this.fire(ev.action, prev.msg, { visible: false });
      if (g.msg) {
        const payload: Record<string, unknown> = { visible: true };
        if (g.side) {
          if (g.msg === "set_winner") {
            // The Winner graphic ALWAYS shows whoever is winning the series (from Match — Teams), so
            // one button is always right — there is no side to configure (the key's side setting is
            // Line-up's alone). A 0-0 tie has no champion to name, so it falls back to blue. Sending
            // no name and no subtitle is deliberate: the suite clears the last winner's team and
            // refreshes the score line from the live series score.
            payload.side = leadingSide(suite.state) || "blue";
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
      sub: this.#sub(s, g),
      on: !!g && gfxIsLive(suite.state, g),
      pill: "ON AIR"
    });
  }

  /** Winner keys show the team they'd crown right now (live from the series score), so the producer
   *  can SEE it tracking Match — Teams instead of trusting it; other keys keep the cut-scene hint. */
  #sub(s: Settings, g: ReturnType<typeof gfxByKey>): string {
    if (g?.msg === "set_winner") {
      const lead = leadingSide(suite.state);
      if (!lead) return "0-0 — NO LEAD";
      const name = suite.state.teams?.[lead]?.name;
      return (name || (lead === "orange" ? "Orange" : "Blue")).toUpperCase();
    }
    return s.cutScene ? `+ ${s.cutScene}` : "GRAPHIC";
  }
}
