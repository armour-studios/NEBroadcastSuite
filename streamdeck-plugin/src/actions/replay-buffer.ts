import { action, type KeyDownEvent } from "@elgato/streamdeck";
import { SuiteKeyAction } from "./base";
import { suite } from "../suite-connection";
import { tile } from "../svg";

type Settings = Record<string, never>;

@action({ UUID: "com.armour-studios.ne-broadcast.replay-buffer" })
export class ReplayBuffer extends SuiteKeyAction<Settings> {
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    await this.fire(ev.action, "obs_toggle_replay_buffer");
  }

  protected override view(): string {
    return tile({
      glyph: "replay-buffer",
      label: "BUFFER",
      sub: "OBS REPLAY",
      accent: "#ef4444",
      on: !!suite.state.obs?.replayBufferActive,
      pill: "REC"
    });
  }
}
