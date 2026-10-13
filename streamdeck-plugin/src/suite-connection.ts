import { EventEmitter } from "node:events";
import WebSocket from "ws";
import streamDeck from "@elgato/streamdeck";

const logger = streamDeck.logger.createScope("suite");

/** Loose view of the suite's full_state payload — we only read a handful of fields. */
export type SuiteState = Record<string, any>;

/**
 * The single WebSocket to the NE Broadcast Suite control bridge (ws://127.0.0.1:3001).
 * Every action fires through send() and re-renders off the merged state cache; the
 * server pushes a full snapshot on connect, then light live-tier frames on change.
 */
class SuiteConnection extends EventEmitter {
  #ws: WebSocket | null = null;
  #state: SuiteState = {};
  #connected = false;
  #attempt = 0;
  #timer: NodeJS.Timeout | null = null;
  #renderTimer: NodeJS.Timeout | null = null;
  #opening = false;
  #lastSeen = 0;
  readonly url = "ws://127.0.0.1:3001";
  readonly tokenUrl = "http://127.0.0.1:3000/api/ws-token";

  get connected(): boolean { return this.#connected; }
  get state(): SuiteState { return this.#state; }

  start(): void {
    void this.#open();
    // Half-open watchdog: the suite pings every client every 15s, so 45s of total silence means
    // the socket is dead without a close (sleep/resume, a killed app, a dropped adapter). Without
    // this the keys kept showing stale "connected" state and every press silently went nowhere.
    setInterval(() => {
      if (this.#connected && this.#ws && Date.now() - this.#lastSeen > 45000) {
        logger.info("no traffic from the suite for 45s - reconnecting");
        try { this.#ws.terminate(); } catch { /* close handler reconnects */ }
      }
    }, 10000);
  }

  /** Reset backoff and retry now — wired to applicationDidLaunch / systemDidWakeUp.
   *  force: drop a socket that still LOOKS open (after a wake it is usually half-open). */
  kick(force = false): void {
    this.#attempt = 0;
    if (force && this.#connected && this.#ws) {
      try { this.#ws.terminate(); } catch { /* close handler reconnects */ }
      return;
    }
    if (!this.#connected) {
      if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
      this.#reconnectSoon(250);
    }
  }

  /** The bridge only demands ?token= when the producer LAN-exposes it (WS_HOST=0.0.0.0), but
   *  then it refuses every tokenless handshake with a 401 — the plugin used to retry forever.
   *  Same trust boundary as the panel: fetch it from the local API (best-effort, '' on failure). */
  async #fetchToken(): Promise<string> {
    try {
      const res = await fetch(this.tokenUrl, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return "";
      const j: any = await res.json().catch(() => null);
      return j && typeof j.token === "string" ? j.token : "";
    } catch {
      return "";
    }
  }

  send(type: string, data: Record<string, unknown> = {}): boolean {
    if (!this.#connected || !this.#ws) return false;
    try {
      this.#ws.send(JSON.stringify({ type, data }));
      return true;
    } catch (e) {
      logger.warn(`send ${type} failed: ${(e as Error).message}`);
      return false;
    }
  }

  async #open(): Promise<void> {
    if (this.#opening) return;
    this.#opening = true;
    let token = "";
    try { token = await this.#fetchToken(); } finally { this.#opening = false; }
    if (this.#ws) { try { this.#ws.terminate(); } catch { /* already dead */ } }
    const ws = new WebSocket(token ? `${this.url}/?token=${encodeURIComponent(token)}` : this.url);
    this.#ws = ws;
    this.#connected = false;
    const seen = () => { if (this.#ws === ws) this.#lastSeen = Date.now(); };
    ws.on("ping", seen);

    ws.on("open", () => {
      if (this.#ws !== ws) return;
      this.#connected = true;
      this.#attempt = 0;
      this.#lastSeen = Date.now();
      logger.info(`connected to ${this.url}`);
      // Identify ourselves — register uses TOP-LEVEL fields (not the {type,data}
      // envelope); the suite's Integrations page lights its Stream Deck chip off this.
      try { ws.send(JSON.stringify({ type: "register", role: "control", client: "streamdeck" })); } catch { /* next state push covers it */ }
      this.#emitChange();
    });

    ws.on("message", (buf) => {
      if (this.#ws !== ws) return;
      this.#lastSeen = Date.now();
      let msg: any;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (!msg || typeof msg !== "object" || !msg.data) return;
      // full_state = snapshot or light live tier; state_update = lean game tick.
      // Both merge shallowly — light frames omit library keys, the cache keeps them.
      if (msg.type === "full_state" || msg.type === "state_update") {
        Object.assign(this.#state, msg.data);
        this.#emitChange();
      }
    });

    const drop = () => {
      if (this.#ws !== ws) return;
      const was = this.#connected;
      this.#connected = false;
      this.#ws = null;
      if (was) { logger.info("disconnected"); this.#emitChange(); }
      this.#reconnectSoon();
    };
    ws.on("close", drop);
    ws.on("error", (e) => { logger.debug(`ws error: ${e.message}`); drop(); });
  }

  #reconnectSoon(ms?: number): void {
    if (this.#timer) return;
    const delay = ms ?? Math.min(5000, 1000 * 2 ** Math.min(this.#attempt++, 3));
    this.#timer = setTimeout(() => { this.#timer = null; void this.#open(); }, delay);
  }

  /** Debounce renders: full_state bursts coalesce at ~40ms server-side, and Stream Deck
   *  caps key image updates at 10/sec — 150ms keeps every key comfortably under it. */
  #emitChange(): void {
    if (this.#renderTimer) return;
    this.#renderTimer = setTimeout(() => {
      this.#renderTimer = null;
      this.emit("change");
    }, 150);
  }
}

export const suite = new SuiteConnection();
