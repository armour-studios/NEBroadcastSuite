import { action, type KeyDownEvent } from "@elgato/streamdeck";
import { SuiteKeyAction } from "./base";
import { suite } from "../suite-connection";
import { tile } from "../svg";

type Settings = { overlay?: string };

/** The persistent/stacking overlays (NOT the exclusive gfx layer) — these sit on top
 *  of gameplay and can stack with a graphic. Mirrors the panel's ONAIR_SCENES rows. */
export const OVERLAYS = [
  { key: "ticker",    label: "Ticker",         msg: "set_ticker",             path: "ticker" },
  { key: "casters",   label: "Casters / Desk", msg: "set_casters_visibility", path: "casters" },
  { key: "banner",    label: "Sponsor Banner", msg: "set_banner_visibility",  path: "banner" },
  { key: "spotlight", label: "Player Spotlight", msg: "set_spotlight",        path: "spotlight" },
  { key: "teamspot",  label: "Team Spotlight", msg: "set_team_spotlight",     path: "teamSpotlight" }
];

@action({ UUID: "com.armour-studios.ne-broadcast.overlay-toggle" })
export class OverlayToggle extends SuiteKeyAction<Settings> {
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const o = OVERLAYS.find((x) => x.key === ev.payload.settings.overlay);
    if (!o) { await ev.action.showAlert(); return; }
    const visible = !!suite.state[o.path]?.visible;
    await this.fire(ev.action, o.msg, { visible: !visible });
  }

  protected override view(s: Settings): string {
    const o = OVERLAYS.find((x) => x.key === s.overlay);
    return tile({
      glyph: "overlay-toggle",
      label: o ? o.label : "Overlay?",
      sub: "STACKING",
      on: !!o && !!suite.state[o.path]?.visible,
      pill: "ON AIR"
    });
  }
}
