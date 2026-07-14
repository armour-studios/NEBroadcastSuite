import { action, type KeyDownEvent } from "@elgato/streamdeck";
import { SuiteKeyAction } from "./base";
import { suite } from "../suite-connection";
import { tile } from "../svg";
import { sideColor } from "./adjust-score";

type Settings = { side?: string; team?: string };

/** Put a saved team (name, logo, colour, roster) on a side — same payload the
 *  leagues/bracket panels send (set_team preserves whatever isn't provided). */
@action({ UUID: "com.armour-studios.ne-broadcast.select-team" })
export class SelectTeam extends SuiteKeyAction<Settings> {
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const { side = "blue", team } = ev.payload.settings;
    const saved = ((suite.state.savedTeams as any[]) || []).find((t) => t && t.name === team);
    if (!saved) { await ev.action.showAlert(); return; }
    const ok = await this.fire(ev.action, "set_team", {
      side,
      name: saved.name,
      logo: saved.logo || null,
      color: saved.color || undefined,
      players: (saved.players || []).map((p: any) => ({ name: p.name, role: p.role }))
    });
    if (ok) await ev.action.showOk();
  }

  protected override view(s: Settings): string {
    const side = s.side === "orange" ? "orange" : "blue";
    const applied = !!s.team && suite.state.teams?.[side]?.name === s.team;
    return tile({
      glyph: "select-team",
      label: s.team || "Team?",
      sub: `> ${side.toUpperCase()}`,
      accent: sideColor(side, suite.state.teams?.[side]),
      on: applied,
      pill: "SET"
    });
  }
}
