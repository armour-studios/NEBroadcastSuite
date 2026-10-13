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
  aliases?: string[];        // other gfxActive values that mean this same layer
}

export const GFX: GfxDef[] = [
  { key: "break",     label: "Break",      stateKey: "breakScreen", msg: "set_break" },
  { key: "matchup",   label: "Matchup" },
  { key: "winner",    label: "Winner",     stateKey: "winner",    msg: "set_winner", side: true },
  { key: "intro",     label: "Line-up",    stateKey: "intro",     msg: "set_intro",  side: true },
  { key: "veto",      label: "Map Veto",   stateKey: "veto",      msg: "set_veto" },
  { key: "spotlight", label: "Spotlight",  stateKey: "watchlist", msg: "set_watchlist" },
  // set_upcoming makes the server set gfxActive='upcoming' (the panel's key); gfx.html maps both.
  { key: "schedule",  label: "Schedule",   stateKey: "upcoming",  msg: "set_upcoming", aliases: ["upcoming"] },
  { key: "standings", label: "Standings",  stateKey: "standings", msg: "set_standings" },
  { key: "bracket",   label: "Bracket",    stateKey: "bracket" },
  { key: "credits",   label: "Credits",    stateKey: "credits" },
  { key: "draft",     label: "Draft",      stateKey: "draft" },
  { key: "series",    label: "Series Score" },
  { key: "seriesstats", label: "Series Stats", stateKey: "seriesStats", msg: "set_series_stats" },
  // Battle-royale layers (Match — Lobby fills them); gfx-layer pushes only, like the panel's rail.
  { key: "brdrop",    label: "BR Drop Map" },
  { key: "brcompare", label: "BR Compare" },
  { key: "brvictory", label: "BR Victory" },
  { key: "preshow",   label: "Desk Show",  standaloneScene: "Desk Show" }
];

export function gfxByKey(key: string | undefined): GfxDef | undefined {
  return GFX.find((g) => g.key === key);
}

export function gfxIsLive(state: Record<string, any>, g: GfxDef): boolean {
  if (g.standaloneScene) return state.obs?.currentScene === g.standaloneScene;
  // gfx.html renders exactly ONE layer — state.gfxActive. While something is active, that is
  // the whole truth: a stale .visible flag (watchlist/spotlight are outside the server's
  // exclusive mirroring) used to light a second key as ON AIR, and pressing it "hid" it by
  // clearing gfxActive — taking the graphic that was really on air off instead.
  const active = state.gfxActive;
  if (active) return active === g.key || !!g.aliases?.includes(active);
  return !!(g.stateKey && state[g.stateKey] && state[g.stateKey].visible);
}
