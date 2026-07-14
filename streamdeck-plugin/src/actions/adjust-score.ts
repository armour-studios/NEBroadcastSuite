import { action, type KeyDownEvent } from "@elgato/streamdeck";
import { SuiteKeyAction } from "./base";
import { suite } from "../suite-connection";
import { scoreKeySvg } from "../svg";

type Settings = { side?: string; delta?: number | string };

export function sideColor(side: string, team: any): string {
  return team?.color || (side === "blue" ? "#3b82f6" : "#f59e0b");
}

/** Add/remove a series win. The server auto-advances the game number (adjust_series). */
@action({ UUID: "com.armour-studios.ne-broadcast.adjust-score" })
export class AdjustScore extends SuiteKeyAction<Settings> {
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const { side = "blue", delta = 1 } = ev.payload.settings;
    await this.fire(ev.action, "adjust_series", { side, delta: Number(delta) || 1 });
  }

  protected override view(s: Settings): string {
    const side = s.side === "orange" ? "orange" : "blue";
    const team = suite.state.teams?.[side];
    const delta = Number(s.delta) || 1;
    return scoreKeySvg({
      color: sideColor(side, team),
      name: team?.name || side.toUpperCase(),
      value: String(suite.state.series?.[side] ?? 0),
      badge: delta > 0 ? `+${delta}` : String(delta)
    });
  }
}
