/**
 * The suite's exclusive full-screen graphics (overlay/gfx.html renders exactly one).
 * Mirrors GOLIVE_TRIGGERS + SCENE_META in control-panel/app.js and GFX_EXCLUSIVE_VISIBLE
 * in server.js: `msg` carries per-graphic params (side), `stateKey` is the .visible flag
 * we light the key from; set_gfx_active does the exclusive mirroring server-side.
 * Standalone entries (Desk Show) are their own OBS scene — going live is a switcher cut,
 * not a gfx-layer push, exactly like the panel's hasPush rows.
 */
export interface GfxDef {
  key: string;               // set_gfx_active scene key
  label: string;
  stateKey?: string;         // state field with a .visible flag
  msg?: string;              // per-graphic show/hide message, when one exists
  side?: boolean;            // show() takes a blue/orange side param (winner, intro)
  standaloneScene?: string;  // OBS scene name — live = program is on this scene
}

export const GFX: GfxDef[] = [
  { key: "break",     label: "Break",      stateKey: "breakScreen", msg: "set_break" },
  { key: "matchup",   label: "Matchup" },
  { key: "winner",    label: "Winner",     stateKey: "winner",    msg: "set_winner", side: true },
  { key: "intro",     label: "Line-up",    stateKey: "intro",     msg: "set_intro",  side: true },
  { key: "veto",      label: "Map Veto",   stateKey: "veto",      msg: "set_veto" },
  { key: "spotlight", label: "Spotlight",  stateKey: "watchlist", msg: "set_watchlist" },
  { key: "schedule",  label: "Schedule",   stateKey: "upcoming",  msg: "set_upcoming" },
  { key: "standings", label: "Standings",  stateKey: "standings", msg: "set_standings" },
  { key: "bracket",   label: "Bracket",    stateKey: "bracket" },
  { key: "credits",   label: "Credits",    stateKey: "credits" },
  { key: "draft",     label: "Draft",      stateKey: "draft" },
  { key: "preshow",   label: "Desk Show",  standaloneScene: "Desk Show" }
];

export function gfxByKey(key: string | undefined): GfxDef | undefined {
  return GFX.find((g) => g.key === key);
}

export function gfxIsLive(state: Record<string, any>, g: GfxDef): boolean {
  if (g.standaloneScene) return state.obs?.currentScene === g.standaloneScene;
  if (state.gfxActive === g.key) return true;
  if (g.stateKey && state[g.stateKey] && state[g.stateKey].visible) return true;
  return false;
}
