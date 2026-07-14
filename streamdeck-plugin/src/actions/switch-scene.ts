import { action, type KeyDownEvent } from "@elgato/streamdeck";
import { SuiteKeyAction } from "./base";
import { suite } from "../suite-connection";
import { tile } from "../svg";

type Settings = { scene?: string };

/** Cut the program to a scene — routed through the suite's switcherCut(), so it
 *  works for whichever backend is active (OBS or vMix). */
@action({ UUID: "com.armour-studios.ne-broadcast.switch-scene" })
export class SwitchScene extends SuiteKeyAction<Settings> {
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const scene = ev.payload.settings.scene;
    if (!scene) { await ev.action.showAlert(); return; }
    await this.fire(ev.action, "obs_switch_scene", { sceneName: scene });
  }

  protected override view(s: Settings): string {
    return tile({
      glyph: "switch-scene",
      label: s.scene || "Scene?",
      sub: "SCENE",
      accent: "#ef4444",
      on: !!s.scene && suite.state.obs?.currentScene === s.scene,
      pill: "LIVE"
    });
  }
}
