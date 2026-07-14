import type { SuiteState } from "./suite-connection";
import { GFX } from "./gfx";

type Item = { label: string; value: string; disabled?: boolean };
type ItemGroup = { label?: string; children: Item[] };

const str = (v: unknown): string => (typeof v === "string" ? v : (v as any)?.name || "");

/**
 * Property-inspector datasources: sdpi components request these by event name
 * (sendToPlugin {event}) and we answer with {event, items} built from live state.
 */
export function datasource(event: string, state: SuiteState): Array<Item | ItemGroup> | null {
  switch (event) {
    case "getScenes":
      return ((state.obs?.availableScenes as unknown[]) || [])
        .map(str).filter(Boolean)
        .map((s) => ({ label: s, value: s }));

    case "getAudioInputs":
      return ((state.obs?.audioInputs as any[]) || [])
        .map((i) => str(i.name ?? i)).filter(Boolean)
        .map((n) => ({ label: n, value: n }));

    case "getSources": {
      // Grouped by scene; value is "scene::source" (same encoding as the in-app deck).
      const groups = new Map<string, Item[]>();
      for (const s of (state.obs?.sources as any[]) || []) {
        if (!s || !s.scene || !s.source) continue;
        if (!groups.has(s.scene)) groups.set(s.scene, []);
        groups.get(s.scene)!.push({ label: s.source, value: `${s.scene}::${s.source}` });
      }
      return [...groups.entries()].map(([label, children]) => ({ label, children }));
    }

    case "getFlows":
      return ((state.flows as any[]) || [])
        .filter((f) => f && f.id)
        .map((f) => ({ label: f.name || f.id, value: f.id }));

    case "getTeams":
      return ((state.savedTeams as any[]) || [])
        .filter((t) => t && t.name)
        .map((t) => ({ label: t.name, value: t.name }));

    case "getSides": {
      const blue = state.teams?.blue?.name || "Blue";
      const orange = state.teams?.orange?.name || "Orange";
      return [
        { label: `Blue side (${blue})`, value: "blue" },
        { label: `Orange side (${orange})`, value: "orange" }
      ];
    }

    case "getGfx":
      return GFX.map((g) => ({ label: g.label, value: g.key }));

    default:
      return null;
  }
}
