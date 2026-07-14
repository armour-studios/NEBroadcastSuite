import { action, type KeyDownEvent } from "@elgato/streamdeck";
import { SuiteKeyAction } from "./base";
import { tile } from "../svg";

type Settings = { description?: string };

/** Drop a stream marker on the Twitch VOD (POST /api/twitch/marker). */
@action({ UUID: "com.armour-studios.ne-broadcast.twitch-marker" })
export class TwitchMarker extends SuiteKeyAction<Settings> {
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    try {
      const res = await fetch("http://127.0.0.1:3000/api/twitch/marker", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: ev.payload.settings.description || undefined }),
        signal: AbortSignal.timeout(10000)
      });
      const j: any = await res.json().catch(() => ({}));
      if (res.ok && j.ok !== false && !j.error) await ev.action.showOk();
      else await ev.action.showAlert();
    } catch {
      await ev.action.showAlert();
    }
  }

  protected override view(s: Settings): string {
    return tile({ glyph: "twitch-marker", label: "MARKER", sub: s.description || "VOD MARKER", accent: "#a970ff" });
  }
}
