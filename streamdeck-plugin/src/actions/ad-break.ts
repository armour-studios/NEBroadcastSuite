import { action, type KeyAction, type KeyDownEvent, type KeyUpEvent } from "@elgato/streamdeck";
import { SuiteKeyAction } from "./base";
import { suite } from "../suite-connection";
import { tile } from "../svg";

type Settings = { hold?: boolean };

const HOLD_MS = 600;

/** Toggle the ad/commercial break (obs_toggle_commercial). The server remembers the
 *  scene it left and returns to it. STARTING an ad requires a hold by default —
 *  ads must only ever run on an explicit producer action; ending one is instant. */
@action({ UUID: "com.armour-studios.ne-broadcast.ad-break" })
export class AdBreak extends SuiteKeyAction<Settings> {
  #downAt = new Map<string, number>();

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const starting = !suite.state.commercial?.active;
    if (starting && ev.payload.settings.hold !== false) {
      this.#downAt.set(ev.action.id, Date.now());
      return;
    }
    await this.#toggle(ev.action);
  }

  override async onKeyUp(ev: KeyUpEvent<Settings>): Promise<void> {
    const down = this.#downAt.get(ev.action.id);
    if (down === undefined) return;
    this.#downAt.delete(ev.action.id);
    if (Date.now() - down >= HOLD_MS) await this.#toggle(ev.action);
    else await ev.action.showAlert(); // tapped, not held — an ad never starts by accident
  }

  async #toggle(a: KeyAction<Settings>): Promise<void> {
    if (await this.fire(a, "obs_toggle_commercial", {})) await a.showOk();
  }

  protected override view(): string {
    const active = !!suite.state.commercial?.active;
    return tile({
      glyph: "ad-break",
      label: active ? "END AD" : "AD BREAK",
      sub: active ? "RUNNING" : "HOLD TO START",
      accent: "#ef4444",
      on: active,
      pill: "ON AIR"
    });
  }
}
