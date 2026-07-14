import { action, type KeyDownEvent } from "@elgato/streamdeck";
import { SuiteKeyAction } from "./base";
import { suite } from "../suite-connection";
import { tile } from "../svg";

type Settings = { input?: string };

function isMuted(input: string | undefined): boolean {
  const i = ((suite.state.obs?.audioInputs as any[]) || []).find((x) => x && x.name === input);
  return !!(i && i.muted);
}

/** Toggle an OBS audio input's mute from live state (key lights red while muted). */
@action({ UUID: "com.armour-studios.ne-broadcast.audio-mute" })
export class AudioMute extends SuiteKeyAction<Settings> {
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const input = ev.payload.settings.input;
    if (!input) { await ev.action.showAlert(); return; }
    await this.fire(ev.action, isMuted(input) ? "obs_input_unmute" : "obs_input_mute", { inputName: input });
  }

  protected override view(s: Settings): string {
    return tile({
      glyph: "audio-mute",
      label: s.input || "Input?",
      sub: "AUDIO",
      accent: "#ef4444",
      on: isMuted(s.input),
      pill: "MUTED"
    });
  }
}
