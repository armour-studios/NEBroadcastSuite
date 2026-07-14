import { action, type KeyDownEvent } from "@elgato/streamdeck";
import { SuiteKeyAction } from "./base";
import { suite } from "../suite-connection";
import { tile } from "../svg";

type Settings = { flowId?: string };

/** Run a manual Flow. Self-scoped: fire_flow_manual only triggers the given id. */
@action({ UUID: "com.armour-studios.ne-broadcast.fire-flow" })
export class FireFlow extends SuiteKeyAction<Settings> {
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const id = ev.payload.settings.flowId;
    if (!id) { await ev.action.showAlert(); return; }
    if (await this.fire(ev.action, "fire_flow_manual", { id })) await ev.action.showOk();
  }

  protected override view(s: Settings): string {
    const flow = ((suite.state.flows as any[]) || []).find((f) => f && f.id === s.flowId);
    return tile({ glyph: "fire-flow", label: flow ? flow.name || "Flow" : "Flow?", sub: "FLOW", accent: "#7c5cff" });
  }
}
