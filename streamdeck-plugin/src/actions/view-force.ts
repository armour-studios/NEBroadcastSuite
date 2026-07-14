import { action, type KeyDownEvent } from "@elgato/streamdeck";
import { SuiteKeyAction } from "./base";
import { tile } from "../svg";

type Settings = { view?: string };

/** Force the in-game overlay to the HUD or the post-game scoreboard view. */
@action({ UUID: "com.armour-studios.ne-broadcast.view-force" })
export class ViewForce extends SuiteKeyAction<Settings> {
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const msg = ev.payload.settings.view === "scoreboard" ? "force_scoreboard" : "force_hud";
    if (await this.fire(ev.action, msg)) await ev.action.showOk();
  }

  protected override view(s: Settings): string {
    const sb = s.view === "scoreboard";
    return tile({ glyph: "view-force", label: sb ? "SCOREBOARD" : "HUD", sub: "OVERLAY VIEW" });
  }
}
