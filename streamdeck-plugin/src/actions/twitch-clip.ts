import { action, type KeyDownEvent } from "@elgato/streamdeck";
import { SuiteKeyAction } from "./base";
import { tile } from "../svg";

type Settings = Record<string, never>;

/** Dual clip: saves the OBS replay buffer AND creates a Twitch clip in one press
 *  (the suite's POST /api/twitch/clip endpoint does both). */
@action({ UUID: "com.armour-studios.ne-broadcast.twitch-clip" })
export class TwitchClip extends SuiteKeyAction<Settings> {
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    try {
      const res = await fetch("http://127.0.0.1:3000/api/twitch/clip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(10000)
      });
      const j: any = await res.json().catch(() => ({}));
      if (res.ok && (j.twitch || j.obs)) await ev.action.showOk();
      else await ev.action.showAlert();
    } catch {
      await ev.action.showAlert();
    }
  }

  protected override view(): string {
    return tile({ glyph: "twitch-clip", label: "CLIP", sub: "TWITCH + OBS", accent: "#a970ff" });
  }
}
