import { action, type KeyDownEvent } from "@elgato/streamdeck";
import { SuiteKeyAction } from "./base";
import { suite } from "../suite-connection";
import { scoreKeySvg } from "../svg";
import { sideColor } from "./adjust-score";

type Settings = { side?: string; score?: number | string };

/** Set a team's series score to an exact value — sent as a delta against the live score,
 *  since the bridge vocabulary only has adjust_series. */
@action({ UUID: "com.armour-studios.ne-broadcast.set-score" })
export class SetScore extends SuiteKeyAction<Settings> {
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const side = ev.payload.settings.side === "orange" ? "orange" : "blue";
    const target = Math.max(0, Number(ev.payload.settings.score) || 0);
    const delta = target - (Number(suite.state.series?.[side]) || 0);
    if (delta === 0) { await ev.action.showOk(); return; }
    if (await this.fire(ev.action, "adjust_series", { side, delta })) await ev.action.showOk();
  }

  protected override view(s: Settings): string {
    const side = s.side === "orange" ? "orange" : "blue";
    const team = suite.state.teams?.[side];
    return scoreKeySvg({
      color: sideColor(side, team),
      name: team?.name || side.toUpperCase(),
      value: `=${Math.max(0, Number(s.score) || 0)}`,
      badge: "SET"
    });
  }
}
