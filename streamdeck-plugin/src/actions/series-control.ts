import { action, type KeyAction, type KeyDownEvent, type KeyUpEvent } from "@elgato/streamdeck";
import { SuiteKeyAction } from "./base";
import { suite } from "../suite-connection";
import { tile } from "../svg";

type Settings = { command?: string; hold?: boolean };

const HOLD_MS = 600;

const isDestructive = (cmd: string): boolean => cmd === "reset_series" || cmd === "clear_scoreboard";

/** Series utilities: reset, swap teams, game number, clear scoreboard.
 *  Destructive commands (reset/clear) require a short hold so a stray tap
 *  mid-broadcast can't wipe the series — the in-app panel confirms these too. */
@action({ UUID: "com.armour-studios.ne-broadcast.series-control" })
export class SeriesControl extends SuiteKeyAction<Settings> {
  #downAt = new Map<string, number>();

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const cmd = ev.payload.settings.command || "reset_series";
    if (isDestructive(cmd) && ev.payload.settings.hold !== false) {
      this.#downAt.set(ev.action.id, Date.now());
      return;
    }
    await this.#run(ev.action, cmd);
  }

  override async onKeyUp(ev: KeyUpEvent<Settings>): Promise<void> {
    const down = this.#downAt.get(ev.action.id);
    if (down === undefined) return;
    this.#downAt.delete(ev.action.id);
    if (Date.now() - down >= HOLD_MS) {
      await this.#run(ev.action, ev.payload.settings.command || "reset_series");
    } else {
      await ev.action.showAlert(); // tapped, not held — refused on purpose
    }
  }

  async #run(a: KeyAction<Settings>, cmd: string): Promise<void> {
    let ok = false;
    switch (cmd) {
      case "swap_teams":       ok = await this.fire(a, "swap_teams", {}); break;
      case "game_plus":        ok = await this.fire(a, "adjust_game_number", { delta: 1 }); break;
      case "game_minus":       ok = await this.fire(a, "adjust_game_number", { delta: -1 }); break;
      case "clear_scoreboard": ok = await this.fire(a, "clear_scoreboard", {}); break;
      case "reset_series":
      default:                 ok = await this.fire(a, "reset_series", {}); break;
    }
    if (ok) await a.showOk();
  }

  protected override view(s: Settings): string {
    const st = suite.state;
    const game = `GAME ${st.game?.number ?? 1} OF ${st.bestOf ?? 5}`;
    const score = `${st.series?.blue ?? 0} - ${st.series?.orange ?? 0}`;
    switch (s.command) {
      case "swap_teams":       return tile({ glyph: "swap", label: "SWAP", sub: "TEAMS" });
      case "game_plus":        return tile({ glyph: "plus", label: "GAME +", sub: game });
      case "game_minus":       return tile({ glyph: "minus", label: "GAME -", sub: game });
      case "clear_scoreboard": return tile({ glyph: "clear-gfx", label: "CLEAR", sub: "SCOREBOARD" });
      default:                 return tile({ glyph: "series-control", label: "RESET", sub: score });
    }
  }
}
