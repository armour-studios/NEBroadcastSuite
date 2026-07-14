import { action, type KeyDownEvent } from "@elgato/streamdeck";
import { SuiteKeyAction } from "./base";
import { suite } from "../suite-connection";
import { tile } from "../svg";

type Settings = { target?: string }; // "scene::source", same encoding as the in-app deck

function parseTarget(target: string | undefined): { scene: string; source: string } | null {
  if (!target) return null;
  const i = target.indexOf("::");
  if (i < 1) return null;
  return { scene: target.slice(0, i), source: target.slice(i + 2) };
}

function isEnabled(p: { scene: string; source: string }): boolean {
  const s = ((suite.state.obs?.sources as any[]) || [])
    .find((x) => x && x.scene === p.scene && x.source === p.source);
  return !!(s && s.enabled);
}

@action({ UUID: "com.armour-studios.ne-broadcast.source-toggle" })
export class SourceToggle extends SuiteKeyAction<Settings> {
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const p = parseTarget(ev.payload.settings.target);
    if (!p) { await ev.action.showAlert(); return; }
    await this.fire(ev.action, isEnabled(p) ? "obs_source_hide" : "obs_source_show", p);
  }

  protected override view(s: Settings): string {
    const p = parseTarget(s.target);
    return tile({
      glyph: "source-toggle",
      label: p ? p.source : "Source?",
      sub: p ? p.scene : "SOURCE",
      on: !!p && isEnabled(p),
      pill: "ON"
    });
  }
}
