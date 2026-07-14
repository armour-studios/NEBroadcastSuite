import { action, type KeyDownEvent } from "@elgato/streamdeck";
import { SuiteKeyAction } from "./base";
import { tile } from "../svg";

type Settings = Record<string, never>;

@action({ UUID: "com.armour-studios.ne-broadcast.save-replay" })
export class SaveReplay extends SuiteKeyAction<Settings> {
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    if (await this.fire(ev.action, "obs_save_replay")) await ev.action.showOk();
  }

  protected override view(): string {
    return tile({ glyph: "save-replay", label: "SAVE", sub: "REPLAY CLIP" });
  }
}
