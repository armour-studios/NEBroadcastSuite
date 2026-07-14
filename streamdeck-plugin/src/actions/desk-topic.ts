import { action, type KeyDownEvent } from "@elgato/streamdeck";
import { SuiteKeyAction } from "./base";
import { suite } from "../suite-connection";
import { tile } from "../svg";

type Settings = { mode?: string }; // "next" | "prev"

/** Step the Desk Show discussion-topics rail. Advancing a topic also cuts OBS to
 *  the topic's own scene when one is set — same behaviour as clicking the topic
 *  active in the panel. The key shows the CURRENT topic and position. */
@action({ UUID: "com.armour-studios.ne-broadcast.desk-topic" })
export class DeskTopic extends SuiteKeyAction<Settings> {
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const pre = suite.state.preshow || {};
    const topics: any[] = Array.isArray(pre.topics) ? pre.topics : [];
    if (!topics.length) { await ev.action.showAlert(); return; }
    const step = ev.payload.settings.mode === "prev" ? -1 : 1;
    const idx = (((pre.activeTopicIndex || 0) + step) % topics.length + topics.length) % topics.length;
    await this.fire(ev.action, "set_preshow", { activeTopicIndex: idx });
    const sceneName = topics[idx]?.sceneName || "";
    if (sceneName) await this.fire(ev.action, "obs_switch_scene", { sceneName });
  }

  protected override view(s: Settings): string {
    const pre = suite.state.preshow || {};
    const topics: any[] = Array.isArray(pre.topics) ? pre.topics : [];
    const idx = Math.min(pre.activeTopicIndex || 0, Math.max(0, topics.length - 1));
    const prev = s.mode === "prev";
    return tile({
      glyph: "desk-topic",
      label: topics.length ? (topics[idx]?.text || `Topic ${idx + 1}`) : "No topics",
      sub: topics.length ? `${prev ? "PREV" : "NEXT"} - ${idx + 1}/${topics.length}` : "DESK SHOW",
      accent: "#7c5cff",
      on: topics.length > 0,
      pill: prev ? "BACK" : "NEXT"
    });
  }
}
