import { action, type KeyDownEvent } from "@elgato/streamdeck";
import { SuiteKeyAction } from "./base";
import { suite } from "../suite-connection";
import { tile } from "../svg";

type Settings = Record<string, never>;

/** Take every exclusive graphic off air — set_gfx_active('') clears the active
 *  layer and mirrors all exclusive .visible flags off server-side. */
@action({ UUID: "com.armour-studios.ne-broadcast.clear-gfx" })
export class ClearGfx extends SuiteKeyAction<Settings> {
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    if (await this.fire(ev.action, "set_gfx_active", { scene: "" })) await ev.action.showOk();
  }

  protected override view(): string {
    const active = suite.state.gfxActive;
    return tile({ glyph: "clear-gfx", label: "CLEAR", sub: active ? `LIVE: ${String(active).toUpperCase()}` : "NO GFX LIVE" });
  }
}
