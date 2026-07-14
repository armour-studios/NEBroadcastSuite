import streamDeck, {
  SingletonAction,
  type KeyAction,
  type SendToPluginEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
  type DidReceiveSettingsEvent
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import { suite } from "../suite-connection";
import { datasource } from "../datasources";
import { OFFLINE_IMAGE } from "../svg";

const logger = streamDeck.logger.createScope("action");

/**
 * Base for every suite key. Each key is a fully rendered SVG tile returned by the
 * subclass's view(); the base diffs the data URI per key and only pushes actual
 * changes — no reset-then-redraw (that flashed) and no getSettings round-trips
 * (those timed out): settings are cached from willAppear/didReceiveSettings.
 */
export abstract class SuiteKeyAction<T extends JsonObject> extends SingletonAction<T> {
  #settings = new Map<string, T>();
  #lastImage = new Map<string, string>();

  constructor() {
    super();
    suite.on("change", () => void this.refreshAll());
  }

  /** Pure render: build this key's tile from cached settings + suite state. */
  protected abstract view(settings: T, actionId: string): string;

  override async onWillAppear(ev: WillAppearEvent<T>): Promise<void> {
    if (!ev.action.isKey()) return;
    this.#settings.set(ev.action.id, ev.payload.settings);
    this.#lastImage.delete(ev.action.id);
    await this.render(ev.action);
  }

  override onWillDisappear(ev: WillDisappearEvent<T>): void {
    this.#settings.delete(ev.action.id);
    this.#lastImage.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<T>): Promise<void> {
    if (!ev.action.isKey()) return;
    this.#settings.set(ev.action.id, ev.payload.settings);
    await this.render(ev.action);
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonObject, T>): Promise<void> {
    const event = (ev.payload as any)?.event;
    if (typeof event !== "string") return;
    const items = datasource(event, suite.state);
    if (items) await streamDeck.ui.sendToPropertyInspector({ event, items });
  }

  protected settingsFor(action: KeyAction<T>): T {
    return this.#settings.get(action.id) ?? ({} as T);
  }

  protected async refreshAll(): Promise<void> {
    for (const a of this.actions) {
      if (!a.isKey()) continue;
      await this.render(a).catch((e) => {
        this.#lastImage.delete(a.id); // retry on the next change
        logger.warn(`render ${a.manifestId}: ${e instanceof Error ? e.message : JSON.stringify(e)}`);
      });
    }
  }

  protected async render(action: KeyAction<T>): Promise<void> {
    const img = suite.connected ? this.view(this.settingsFor(action), action.id) : OFFLINE_IMAGE;
    if (this.#lastImage.get(action.id) === img) return;
    this.#lastImage.set(action.id, img);
    await action.setImage(img);
  }

  /** Send a bridge message; alert the key when disconnected or the send fails. */
  protected async fire(action: KeyAction<T>, type: string, data: Record<string, unknown> = {}): Promise<boolean> {
    if (!suite.send(type, data)) {
      await action.showAlert();
      return false;
    }
    return true;
  }
}
