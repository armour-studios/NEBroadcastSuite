/**
 * NE Broadcast Suite — OBS Scene Collection Generator v3
 *
 * Generates the downloadable OBS scene collection that mirrors the suite's overlay set:
 *   • Pre-game / break — Away, Countdown, Map Veto, Draft, Matchup, Team Intros,
 *     Upcoming, Standings, Bracket
 *   • Live — In Game (Game Capture + per-game HUD stack: RL / CS2 / Valorant / Overwatch /
 *     Marvel Rivals), In Game — Cam PIP, In Game — Talent Bar, Replay
 *   • Desk / casters — SingleCam, DuoCam Row, TrioCam Row, Quad Desk, Analyst Desk,
 *     Duo SingleCam, Spotlight Desk, Interview, Post-Game (Winner)
 *   • Utility — => Host/Caster 1/2/4 Cam framing scenes (one VDO.ninja feed each)
 *   • Draggable add-ons (sources only) — Sponsor Banner, Listen-In Captions, Interviewee Cam
 *
 * CAMERA MODEL (the "holes" in the desk overlays):
 *   combined  (DEFAULT) — each desk overlay embeds the caster cams itself from the
 *     control-panel cam URLs. Pixel-perfect, no per-scene setup, one audio fader.
 *   separated — desk overlays run frames-only (?cams=off) and the => Cam scenes are
 *     framed in behind each hole for a per-caster OBS audio fader.
 *
 * CLI:  node obs/build-scene-collection.js [--audio-mode=combined|separated]
 *                 [--host-url=URL] [--caster1-url=URL] [--caster2-url=URL] [--caster4-url=URL]
 *                 [--bg-path=FILE] [--stinger=FILE]
 * API:  const { generateSceneCollection } = require('./obs/build-scene-collection')
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// ─── Constants ────────────────────────────────────────────────────────────────
const OVERLAY_HOST  = 'http://localhost:3000';
const MAIN_CANVAS   = '6c69626f-6273-4c00-9d88-c5136d61696e'; // OBS main canvas UUID (fixed)
const COLLECTION_NAME = 'NE Broadcast Suite';

// Scene-list label colors (ARGB uint32, A=0xBF semi-transparent — matches OBS preset tints).
// These appear as colored left-stripes in OBS's Scenes panel for quick category scanning.
const SCENE_COLORS = {
  none:     0,           // no label
  pregame:  3208970239,  // 0xBF44FFFF  cyan   — pre-game / break
  gameplay: 3221202995,  // 0xBFFFA833  orange — live gameplay
  desk:     3208970052,  // 0xBF44FF44  green  — caster desk
  postgame: 3221225267,  // 0xBFFFFF33  yellow — post-game / winner
  utility:  3214975136,  // 0xBFA0A0A0  gray   — utility cam framing scenes
};

// ─── Low-level source builders ────────────────────────────────────────────────
const AUDIO_BASE = {
  mixers: 255, sync: 0, flags: 0, volume: 1.0, balance: 0.5,
  enabled: true, muted: false,
  'push-to-mute': false, 'push-to-mute-delay': 0,
  'push-to-talk': false, 'push-to-talk-delay': 0,
  hotkeys: {}, deinterlace_mode: 0, deinterlace_field_order: 0,
  monitoring_type: 0, private_settings: {},
};

const BROWSER_HK = {
  'libobs.mute': [], 'libobs.unmute': [],
  'libobs.push-to-mute': [], 'libobs.push-to-talk': [],
  'ObsBrowser.Refresh': [],
};

function makeBrowser(name, url, { restart = false, shutdown = false, w = 1920, h = 1080, rerouteAudio = false } = {}) {
  return {
    prev_ver: 536936450, name, uuid: randomUUID(),
    id: 'browser_source', versioned_id: 'browser_source',
    settings: {
      url: url.startsWith('http') ? url : OVERLAY_HOST + url,
      width: w, height: h,
      restart_when_active: restart,
      shutdown,
      // reroute_audio = OBS captures the page's audio as its OWN source with its own fader/track —
      // used for the per-caster cam feeds so each caster keeps a separate audio track.
      ...(rerouteAudio ? { reroute_audio: true } : {}),
      css: 'body { background: rgba(0,0,0,0); margin: 0; overflow: hidden; }',
    },
    // Rerouted (caster cam) sources MUST be on the output tracks or their voices never reach
    // the stream/recording (mixers is a track bitmask; 255 = all tracks, OBS's default).
    ...AUDIO_BASE, mixers: rerouteAudio ? 255 : 0, hotkeys: BROWSER_HK,
  };
}

function makeGameCapture(name, window_) {
  return {
    prev_ver: 536936450, name, uuid: randomUUID(),
    id: 'game_capture', versioned_id: 'game_capture',
    settings: { window: window_ || '', capture_mode: 'window', capture_cursor: false },
    ...AUDIO_BASE, mixers: 0,
    hotkeys: {
      'libobs.mute': [], 'libobs.unmute': [],
      'libobs.push-to-mute': [], 'libobs.push-to-talk': [],
      'hotkey_start': [], 'hotkey_stop': [],
    },
  };
}

function makeMediaLoop(name, file) {
  return {
    prev_ver: 536936450, name, uuid: randomUUID(),
    id: 'ffmpeg_source', versioned_id: 'ffmpeg_source',
    settings: {
      local_file: file || '',
      looping: true,
      close_when_inactive: true,
      clear_on_media_end: false,
      restart_on_activate: false,
    },
    ...AUDIO_BASE, muted: true, mixers: 255,
    hotkeys: {
      'libobs.mute': [], 'libobs.unmute': [],
      'libobs.push-to-mute': [], 'libobs.push-to-talk': [],
      'MediaSource.Restart': [], 'MediaSource.Play': [],
      'MediaSource.Pause': [], 'MediaSource.Stop': [],
    },
    private_settings: { mixer_hidden: true },
  };
}

// ─── Scene item builder ───────────────────────────────────────────────────────
// Returns a builder scoped to one scene; IDs are sequential within that scene.
function itemList() {
  let nextId = 1;
  const items = [];

  function add(name, sourceUuid, {
    visible = true,
    locked  = true,
    pos     = { x: 0.0, y: 0.0 },
    scale   = { x: 1.0, y: 1.0 },
    bounds  = { x: 0.0, y: 0.0 },
    boundsType  = 0,          // OBS enum: 0=none 1=stretch 2=scale-inner(fit) 3=scale-outer(cover/fill)
    crop        = [0, 0, 0, 0], // [left, top, right, bottom]
    colorPreset = 0,
    showMs = 0, hideMs = 0,
  } = {}) {
    const id = nextId++;
    items.push({
      name, source_uuid: sourceUuid,
      visible, locked, rot: 0.0,
      scale_ref: { x: 1920.0, y: 1080.0 },
      align: 5, bounds_type: boundsType, bounds_align: 0, bounds_crop: false,
      crop_left: crop[0], crop_top: crop[1], crop_right: crop[2], crop_bottom: crop[3],
      id, group_item_backup: false,
      pos, scale, bounds,
      scale_filter: 'disable', blend_method: 'default', blend_type: 'normal',
      show_transition: { duration: showMs },
      hide_transition: { duration: hideMs },
      private_settings: colorPreset ? { color: '', 'color-preset': colorPreset } : {},
    });
  }

  return { add, get: () => items };
}

// Shorthand layout presets for item positioning
const FULL         = { pos: { x: 0, y: 0 }, scale: { x: 1.0, y: 1.0 }, bounds: { x: 0.0, y: 0.0 }, boundsType: 0 };
const FULL_STRETCH = { pos: { x: 0, y: 0 }, scale: { x: 1.0, y: 1.0 }, bounds: { x: 1920.0, y: 1080.0 }, boundsType: 2 };
const FULL_INNER   = { pos: { x: 0, y: 0 }, scale: { x: 1.0, y: 1.0 }, bounds: { x: 1920.0, y: 1080.0 }, boundsType: 3 };

// ─── Scene builder ────────────────────────────────────────────────────────────
function makeScene(name, items, {
  canvasUuid      = MAIN_CANVAS,
  showInMultiview = true,
  transitionMs    = 300,
  color           = 0,   // SCENE_COLORS.* — shows as a colored stripe in OBS Scenes panel
} = {}) {
  const hotkeys = { 'OBSBasic.SelectScene': [] };
  items.forEach(it => {
    hotkeys[`libobs.show_scene_item.${it.id}`] = [];
    hotkeys[`libobs.hide_scene_item.${it.id}`] = [];
  });
  return {
    prev_ver: 536936450, name, uuid: randomUUID(),
    id: 'scene', versioned_id: 'scene',
    settings: { custom_size: false, id_counter: items.length + 1, items },
    ...AUDIO_BASE, mixers: 0, hotkeys,
    canvas_uuid: canvasUuid,
    color,
    private_settings: { show_in_multiview: showInMultiview, transition_duration: transitionMs },
  };
}

// ─── Main generator ───────────────────────────────────────────────────────────
// Camera workflow (always "separated"):
//   Each desk overlay runs with ?cams=off — cam holes are fully transparent.
//   The => Caster N Cam utility scenes sit behind the overlay in OBS at the exact
//   pixel coordinates of each hole. By default each => Cam scene contains a
//   castercam.html?slot=N browser source that auto-updates when caster assignments
//   change in the control panel. Users can swap the browser source for any OBS
//   source (Discord webcam, window capture, NDI, etc.) without rebuilding the collection.
function generateSceneCollection({
  name           = COLLECTION_NAME,
  stingerPath    = '',    // local .webm stinger path (optional)
  backgroundPath = '',    // local looping background video path (optional)
} = {}) {
  const co = '?cams=off';   // overlays always run frames-only; cams come from OBS utility scenes

  // ── Shared media / capture sources ─────────────────────────────────────────
  const bgLoop      = makeMediaLoop('Background Loop', backgroundPath);
  const gameCapture = makeGameCapture(
    'Game Capture',
    'Rocket League (64-bit, DX11, Cooked):LaunchUnrealUWindowsClient:RocketLeague.exe'
  );

  // ── Camera browser sources (stable per-slot caster feeds) ─────────────────
  // These live ONLY inside the => Cam framing scenes. Each is a PERMANENT browser source
  // pointed at castercam.html?slot=N — the page resolves whichever caster is currently
  // assigned to that desk slot over WS and renders their live VDO.ninja view. The OBS URL
  // never changes, so swapping rooms / custom view links / re-assigning casters just works
  // with NO need to regenerate or reinstall the collection. (Slot map: 1=C1 2=C2 3=Host 4=C4.)
  const vdoHost    = makeBrowser('[CAM] Host (slot 3)',     '/castercam.html?slot=3', { rerouteAudio: true });
  const vdoCaster1 = makeBrowser('[CAM] Caster 1 (slot 1)', '/castercam.html?slot=1', { rerouteAudio: true });
  const vdoCaster2 = makeBrowser('[CAM] Caster 2 (slot 2)', '/castercam.html?slot=2', { rerouteAudio: true });
  const vdoCaster4 = makeBrowser('[CAM] Caster 4 (slot 4)', '/castercam.html?slot=4', { rerouteAudio: true });
  const vdoPlayer  = makeBrowser('[CAM] Player (slot 5)',   '/castercam.html?slot=5', { rerouteAudio: true });

  // ── Game HUD overlay sources (transparent, sit over Game Capture) ──────────
  const gfxRlHud   = makeBrowser('[GFX] RL HUD',            '/rl-hud.html');
  const gfxCs2Hud  = makeBrowser('[GFX] CS2 HUD',           '/csgo.html');
  const gfxValHud  = makeBrowser('[GFX] Valorant HUD',      '/valorant.html');
  const gfxLolHud  = makeBrowser('[GFX] LoL HUD',           '/lol-hud.html');
  const gfxOwHud   = makeBrowser('[GFX] Overwatch HUD',     '/overwatch.html');
  const gfxMrHud   = makeBrowser('[GFX] Marvel Rivals HUD', '/marvel-rivals.html');

  // ── Caster / desk overlay sources (the holes carry cams) ───────────────────
  // `co` adds ?cams=off ONLY in separated mode so the overlay leaves its holes clear.
  const gfxSingle    = makeBrowser('[GFX] SingleCam',      '/singlecam.html' + co);
  const gfxDuoRow    = makeBrowser('[GFX] Duo Row',        '/duorow.html' + co);
  const gfxTrioRow   = makeBrowser('[GFX] Trio Row',       '/triorow.html' + co);
  const gfxDuoSingle = makeBrowser('[GFX] Duo SingleCam',  '/duosinglecam.html' + co);
  const gfxAnalyst   = makeBrowser('[GFX] Analyst Desk',   '/analystspecial.html' + co);
  const gfxQuad      = makeBrowser('[GFX] Quad Desk',      '/quaddesk.html' + co);
  const gfxPreshow   = makeBrowser('[GFX] Desk Show',      '/preshow.html' + co);
  const gfxSpotlight = makeBrowser('[GFX] Spotlight Desk', '/spotlightdesk.html' + co + '&casters=1');
  const gfxInterview     = makeBrowser('[GFX] Interview',       '/interview.html' + co);
  const gfxInterviewDesk = makeBrowser('[GFX] Interview Desk',  '/interview-desk.html' + co);
  // Cams embedded always (responsive / multi-cam layouts — combined cams regardless of mode):
  const gfxMatchup   = makeBrowser('[GFX] Matchup',        '/matchup.html');
  const gfxCampip    = makeBrowser('[GFX] Cam PIP',        '/campip.html');
  const gfxTalentbar = makeBrowser('[GFX] Talent Bar',     '/talentbar.html');

  // ── Full-screen graphic sources ────────────────────────────────────────────
  const gfxAway        = makeBrowser('[GFX] Away Screen',    '/countdown.html',               { restart: true, shutdown: true });
  const gfxCountdown   = makeBrowser('[GFX] Countdown',      '/countdown.html',               { restart: true, shutdown: true });
  const gfxWinner      = makeBrowser('[GFX] Winner',         '/winner.html',                  { restart: true, shutdown: true });
  const gfxWinTeam1    = makeBrowser('[GFX] Team 1 Winner',  '/winner.html?side=blue',        { restart: true, shutdown: true });
  const gfxWinTeam2    = makeBrowser('[GFX] Team 2 Winner',  '/winner.html?side=orange',      { restart: true, shutdown: true });
  const gfxTeam1       = makeBrowser('[GFX] Team 1 Intro',   '/intro.html?side=blue',         { restart: true, shutdown: true });
  const gfxTeam2       = makeBrowser('[GFX] Team 2 Intro',   '/intro.html?side=orange',       { restart: true, shutdown: true });
  const gfxMapVeto    = makeBrowser('[GFX] Map Veto',        '/mapscreen.html',         { restart: true, shutdown: true });
  const gfxDraft      = makeBrowser('[GFX] Draft',           '/draft.html');
  const gfxBracket    = makeBrowser('[GFX] Bracket',         '/bracket.html');
  const gfxUpcoming   = makeBrowser('[GFX] Upcoming',        '/schedule.html');
  const gfxStandings  = makeBrowser('[GFX] Standings',       '/standings.html');
  const gfxReplay     = makeBrowser('[GFX] Replay',          '/replay.html',            { restart: true, shutdown: true });
  const gfxTransition = makeBrowser('[GFX] Transition',      '/transitionbgg.html',     { restart: true, shutdown: true });

  // ── Draggable add-on overlays (no dedicated scene; drop onto any scene) ─────
  const gfxTicker      = makeBrowser('[GFX] Ticker',              '/ticker.html');
  const gfxSponsorRail = makeBrowser('[GFX] Sponsor Rail',        '/sponsor-rail.html');
  const gfxSponsor     = makeBrowser('[GFX] Sponsor Banner',      '/sponsor-banner.html');
  const gfxListenIn = makeBrowser('[GFX] Listen-In Captions', '/listen-in.html');
  const gfxIntCam   = makeBrowser('[GFX] Interviewee Cam',  '/int-cam.html');

  // ── Cam framing scenes (=> Host Cam / => Caster 1 Cam / …) ─────────────────
  // Each is a full-canvas scene containing ONE camera feed (VDO.ninja browser source),
  // embedded into desk layouts with per-slot crop + scale. Always shipped so a producer
  // can hand-place a cam anywhere; used automatically by the desks in separated mode.
  function camScene(sceneName, vdoSrc) {
    const il = itemList();
    // locked: true — prevents accidental drag in OBS; source can still be swapped via right-click → Properties.
    il.add(vdoSrc.name, vdoSrc.uuid, { locked: true, ...FULL_INNER });
    return makeScene(sceneName, il.get(), { showInMultiview: false, transitionMs: 0, color: SCENE_COLORS.utility });
  }

  const sceneHostCam    = camScene('=> Host Cam',     vdoHost);
  const sceneCaster1Cam = camScene('=> Caster 1 Cam', vdoCaster1);
  const sceneCaster2Cam = camScene('=> Caster 2 Cam', vdoCaster2);
  const sceneCaster4Cam = camScene('=> Caster 4 Cam', vdoCaster4);
  const scenePlayerCam  = camScene('=> Player Cam',   vdoPlayer);

  // ── Generic helpers ─────────────────────────────────────────────────────────
  // Full-screen graphic over the looping background.
  function simpleScene(sceneName, gfxSrc, transMs, multiview = true, color = 0) {
    const il = itemList();
    il.add(bgLoop.name,  bgLoop.uuid,  { ...FULL,         colorPreset: 5 });
    il.add(gfxSrc.name,  gfxSrc.uuid,  { ...FULL_STRETCH, colorPreset: 7 });
    return makeScene(sceneName, il.get(), { transitionMs: transMs, showInMultiview: multiview, color });
  }

  // Caster desk: background → cam utility scenes (behind holes) → overlay graphic → transition.
  // The overlay HTML runs with ?cams=off so its cam holes are transparent; the utility scenes
  // show through. Users can swap the browser source in any => Cam scene for Discord, NDI, etc.
  function deskScene(sceneName, gfxSrc, addCams, color = 0) {
    const il = itemList();
    il.add(bgLoop.name, bgLoop.uuid, { ...FULL, colorPreset: 5 });
    if (addCams) addCams(il);
    il.add(gfxSrc.name, gfxSrc.uuid, { ...FULL, colorPreset: 7 });
    il.add(gfxTransition.name, gfxTransition.uuid, { ...FULL_STRETCH, visible: false, colorPreset: 6 });
    return makeScene(sceneName, il.get(), { transitionMs: 300, color });
  }

  // Gameplay scene: Game Capture on the bottom, a stack of game HUDs (only `active` shown),
  // plus optional extra overlay layers (PIP cams / talent bar) on top.
  function gameScene(sceneName, activeHud, extras = []) {
    const huds = [gfxRlHud, gfxCs2Hud, gfxValHud, gfxLolHud, gfxOwHud, gfxMrHud];
    const il = itemList();
    il.add(gameCapture.name, gameCapture.uuid, { locked: false, ...FULL });
    huds.forEach(h => il.add(h.name, h.uuid, { locked: false, visible: h === activeHud, ...FULL, showMs: 300, hideMs: 300 }));
    extras.forEach(x => il.add(x.name, x.uuid, { ...FULL, colorPreset: 7 }));
    return makeScene(sceneName, il.get(), { transitionMs: 500 });
  }

  // ── Gameplay scenes ──────────────────────────────────────────────────────
  const sceneInGame   = gameScene('In Game', gfxRlHud);                    // un-hide your game's HUD
  const scenePipCams  = gameScene('In Game — Cam PIP', gfxRlHud, [gfxCampip]);
  const sceneTalent   = gameScene('In Game — Talent Bar', gfxRlHud, [gfxTalentbar]);
  const sceneReplay   = simpleScene('Replay', gfxReplay, 500, false, SCENE_COLORS.gameplay);

  // Apply gameplay color to the three In Game scenes (gameScene() builds directly, so set color after)
  sceneInGame.color   = SCENE_COLORS.gameplay;
  scenePipCams.color  = SCENE_COLORS.gameplay;
  sceneTalent.color   = SCENE_COLORS.gameplay;

  // ── Caster / desk scenes ─────────────────────────────────────────────────
  // Separated-mode hole geometry. Each cam scene (a full 16:9 source) is COVER-framed into the
  // exact transparent hole the overlay renders, so it fills the hole and any overflow is hidden
  // behind the opaque desk graphic on top. The rectangles below were measured from the live
  // overlays at 1920×1080 (?cams=off) — see _measure-holes.js / scene-base.js ?guide=1.
  //   bounds_type 3 = OBS SCALE_OUTER (cover/fill, crop overflow). pos = hole top-left, bounds = hole size.
  const frame = (x, y, w, h) => ({ pos: { x, y }, scale: { x: 1, y: 1 }, bounds: { x: w, y: h }, boundsType: 3, colorPreset: 4 });

  // All frame() positions below are inner cam-hole pixel rects at 1920×1080 (?cams=off).
  // Formula: x = stage_pad_l + card_border_l, y = zone_y + zone_pad_t + centering_offset + card_border_t + ::before_h
  // w = card_inner_w, h = card_inner_w × 9/16 (or flex-stretch h for preshow).
  const sceneSingle = deskScene('SingleCam', gfxSingle, il => {
    // --cam-w:1180, border:1, ::before:3, --cam-plate-h:58, --hud-h:120, stage-pad:16/24
    // cam-card 726px tall, centered in 900px zone-cams content → y=237+1+3=241; w=1178, h=1178×9/16=663
    il.add(sceneCaster1Cam.name, sceneCaster1Cam.uuid, frame(371, 241, 1178, 663));
  }, SCENE_COLORS.desk);
  const sceneDuoCam = deskScene('DuoCam Row', gfxDuoRow, il => {
    // no border on cam-card, ::before:2, --cam-plate-h:54, zone splits evenly → zone-cams top=250; y=250+2=252
    il.add(sceneCaster1Cam.name, sceneCaster1Cam.uuid, frame(24,  252, 928, 522));
    il.add(sceneCaster2Cam.name, sceneCaster2Cam.uuid, frame(968, 252, 928, 522));
  }, SCENE_COLORS.desk);
  const sceneTrioCam = deskScene('TrioCam Row', gfxTrioRow, il => {
    // 3 cards × 613.3px outer (611px inner), border:1, stage-pad:56/24, zone-pb:10px (always),
    // zone-cams inner=842px; frames-only hides ::before(3px) → card-h=400; offset=(842-400)/2=221
    // hole y = 56+128+10+14+221+1(border) = 430; cam3 x=24+613.3×2+16×2+1=1284
    il.add(sceneCaster1Cam.name, sceneCaster1Cam.uuid, frame(25,   430, 611, 344));
    il.add(sceneCaster2Cam.name, sceneCaster2Cam.uuid, frame(654,  430, 611, 344));
    il.add(sceneHostCam.name,    sceneHostCam.uuid,    frame(1284, 430, 611, 344));
  }, SCENE_COLORS.desk);
  const sceneQuad = deskScene('Quad Desk', gfxQuad, il => {
    // 2×2 CSS Grid, max-width:1280px, gap:16px, hud:100px, stage-pad:14/24/26
    // grid left = (1872-1280)/2+24=320; card=(1280-16)/2=632 outer; hole=630 (border 1px each)
    // hole h=354 (630×9/16); frames-only hides ::before(3) → card-h=402; zone-cams-inner=916
    // row-center-offset=(916-820)/2=48; hole y = 14+100+12+48+1=175 / 593
    il.add(sceneCaster1Cam.name, sceneCaster1Cam.uuid, frame(321, 175, 630, 354));
    il.add(sceneCaster2Cam.name, sceneCaster2Cam.uuid, frame(969, 175, 630, 354));
    il.add(sceneHostCam.name,    sceneHostCam.uuid,    frame(321, 593, 630, 354));
    il.add(sceneCaster4Cam.name, sceneCaster4Cam.uuid, frame(969, 593, 630, 354));
  }, SCENE_COLORS.desk);
  const sceneAnalyst = deskScene('Analyst Desk', gfxAnalyst, il => {
    // stage-pad:16/24/14; zone-footer:12px (padding-top, always); an-body=1038px
    // Left: 600px col, 2 cams stacked, justify:center; frames-only hides ::before(3) → card-h=388
    // stack=792px; center-offset=(1038-792)/2=123; hole y=16+123+1(border)=140
    // cam2 card-top=16+123+388+16=543; cam2 hole y=544; w=598(hole in 600px card), h=336
    // Right: 1256px (flex:1); hud=104px+gap=12 above cam; an-right justify:center
    //   frames-only cam-h=757; block=873; center-offset=(1038-873)/2=82.5; cam top=16+82.5+116=214.5
    il.add(sceneCaster1Cam.name, sceneCaster1Cam.uuid, frame(25,  140, 598, 336));
    il.add(sceneCaster2Cam.name, sceneCaster2Cam.uuid, frame(25,  544, 598, 336));
    il.add(sceneHostCam.name,    sceneHostCam.uuid,    frame(641, 217, 1254, 705));
  }, SCENE_COLORS.desk);
  const sceneDuoSingle = deskScene('Duo SingleCam', gfxDuoSingle, il => {
    // --cam-w:1200, border:1, ::before:3, --cam-plate-h:60, --hud-h:122, stage-pad:16/24
    // cam-card 739px tall, centered in 898px zone-cams content → y=231.5+1+3=236; h=1198×9/16=674
    il.add(sceneCaster1Cam.name, sceneCaster1Cam.uuid, frame(361, 236, 1198, 674));
  }, SCENE_COLORS.desk);
  const sceneSpotlight = deskScene('Spotlight Desk', gfxSpotlight, il => {
    // sp-stage pad: 32/26/16; header 58px(flex:0 0 58px)+16px-mb=74px; zone-footer margin-top:12px → sp-body=946px
    // sp-body top = 32+74 = 106px; frames-only hides ::before on both cards + border-color transparent
    // Left (analyst): 500px col; align-self:flex-start; card border=1px; hole y=106+1=107; w=498(500-2), h=280(498×9/16)
    il.add(sceneCaster1Cam.name, sceneCaster1Cam.uuid, frame(27,  107, 498, 280));
    // Right (player): 1920-52-500-20=1348px col; x=26+500+20+1=547; align-self:stretch; ::before hidden
    // hole y=106+1=107; w=1346(1348-2), h=757(1346×9/16)
    il.add(scenePlayerCam.name,  scenePlayerCam.uuid,  frame(547, 107, 1346, 757));
  }, SCENE_COLORS.desk);
  // Interview Desk — host (slot 1, left 38%) + guest/interviewee (right 62%)
  // id-stage pad: 28/24/16; header ~80px; body h=904px; cards centered in body.
  // Left (host): card=467px → offset=(904-467)/2=219; hole y=28+80+219+4=331; w=720, h=405
  // Right (guest): card=714px → offset=(904-714)/2=95; hole y=28+80+95+4=207; x=24+720+18=762, w=1134, h=638
  const sceneInterviewDesk = deskScene('Interview Desk', gfxInterviewDesk, il => {
    il.add(sceneCaster1Cam.name, sceneCaster1Cam.uuid, frame(24,  331,  720, 405));
    il.add(scenePlayerCam.name,  scenePlayerCam.uuid,  frame(762, 207, 1134, 638));
  }, SCENE_COLORS.desk);
  const sceneInterview = deskScene('VS / Head-to-Head', gfxInterview, il => {
    // iv-body flex-row gap:26, border:1, ::before:4, --cam-plate-h:64; each card 919px outer (917px inner)
    // stage-pad:30/28/18, header~44px → iv-body top=74, h=972; cam-card 587px centered → y=266.5+1+4=272
    // h=917×9/16=517; cam2 x=28+919+26+iv-vs_w+26+1 (verified against current x=974 source positions)
    il.add(sceneCaster1Cam.name, sceneCaster1Cam.uuid, frame(29,  272, 917, 517));
    il.add(sceneCaster2Cam.name, sceneCaster2Cam.uuid, frame(974, 272, 917, 517));
  }, SCENE_COLORS.desk);
  // Matchup embeds its own (small, responsive) caster strip — combined cams regardless of mode.
  const sceneMatchup = deskScene('Matchup', gfxMatchup, null, SCENE_COLORS.pregame);
  // Desk Show — two tall cam holes (left/right) + topics rail + footer. Rects computed from
  // preshow.html at 1920×1080 (?cams=off): stage pad 20/24/18, 16px gap, 104px footer → zone-top 922px;
  // cams column 1552px split into two 769px cards (14px gap), each card = 2px accent + hole + 50px plate.
  const scenePreshow = deskScene('Desk Show', gfxPreshow, il => {
    il.add(sceneCaster1Cam.name, sceneCaster1Cam.uuid, frame(25,  23, 767, 868));
    il.add(sceneCaster2Cam.name, sceneCaster2Cam.uuid, frame(808, 23, 767, 868));
  }, SCENE_COLORS.pregame);

  // ── Pre-game / break / standalone graphic scenes ──────────────────────────
  const sceneAway      = simpleScene('Away / Standby',     gfxAway,      500, true,  SCENE_COLORS.pregame);
  const sceneCountdown = simpleScene('Break (Countdown)',  gfxCountdown, 300, true,  SCENE_COLORS.pregame);
  const sceneMapVeto   = simpleScene('Map Veto',           gfxMapVeto,   500, true,  SCENE_COLORS.pregame);
  const sceneDraft     = simpleScene('Draft',              gfxDraft,     300, true,  SCENE_COLORS.pregame);
  const sceneTeam1     = simpleScene('Team 1 Intro',       gfxTeam1,     500, false, SCENE_COLORS.pregame);
  const sceneTeam2     = simpleScene('Team 2 Intro',       gfxTeam2,     500, false, SCENE_COLORS.pregame);
  const sceneUpcoming  = simpleScene('Upcoming',           gfxUpcoming,  300, true,  SCENE_COLORS.pregame);
  const sceneStandings = simpleScene('Standings',          gfxStandings, 300, true,  SCENE_COLORS.pregame);
  const sceneBracket   = simpleScene('Bracket',            gfxBracket,   300, true,  SCENE_COLORS.pregame);
  // Post-game winner scenes — side param pre-selects which team side winner.html highlights.
  const sceneWinner    = simpleScene('Post-Game (Winner)', gfxWinner,    500, true,  SCENE_COLORS.postgame);
  const sceneTeam1Win  = simpleScene('Team 1 Win',         gfxWinTeam1,  500, true,  SCENE_COLORS.postgame);
  const sceneTeam2Win  = simpleScene('Team 2 Win',         gfxWinTeam2,  500, true,  SCENE_COLORS.postgame);

  // Category dividers — blank separator scenes that group the list in OBS (no scene folders in OBS).
  const dividerPre      = makeScene('═══  PRE-GAME  ═══',   [], { showInMultiview: false, color: SCENE_COLORS.pregame  });
  const dividerLive     = makeScene('═══  GAMEPLAY  ═══',   [], { showInMultiview: false, color: SCENE_COLORS.gameplay });
  const dividerDesk     = makeScene('═══  DESK  ═══',       [], { showInMultiview: false, color: SCENE_COLORS.desk     });
  const dividerPostGame = makeScene('═══  POST-GAME  ═══',  [], { showInMultiview: false, color: SCENE_COLORS.postgame });
  const dividerUtil     = makeScene('═══  UTILITY  ═══',    [], { showInMultiview: false, color: SCENE_COLORS.utility  });

  // ── Scene order ────────────────────────────────────────────────────────────
  const allScenes = [
    // Pre-game / break / graphics
    dividerPre,
    sceneAway,
    sceneCountdown,
    sceneMatchup,
    sceneTeam1,
    sceneTeam2,
    sceneMapVeto,
    sceneDraft,
    sceneUpcoming,
    sceneStandings,
    sceneBracket,
    scenePreshow,
    // Live gameplay
    dividerLive,
    sceneInGame,
    scenePipCams,
    sceneTalent,
    sceneReplay,
    // Desk / casters
    dividerDesk,
    sceneSingle,
    sceneDuoCam,
    sceneTrioCam,
    sceneDuoSingle,
    sceneQuad,
    sceneAnalyst,
    sceneSpotlight,
    sceneInterviewDesk,
    sceneInterview,
    // Post-game
    dividerPostGame,
    sceneWinner,
    sceneTeam1Win,
    sceneTeam2Win,
    // Utility — cam framing scenes
    dividerUtil,
    sceneHostCam,
    sceneCaster1Cam,
    sceneCaster2Cam,
    sceneCaster4Cam,
    scenePlayerCam,
  ];

  // ── All non-scene sources ─────────────────────────────────────────────────
  const sharedSources = [
    bgLoop, gameCapture,
    vdoHost, vdoCaster1, vdoCaster2, vdoCaster4, vdoPlayer,
    gfxRlHud, gfxCs2Hud, gfxValHud, gfxLolHud, gfxOwHud, gfxMrHud,
    gfxSingle, gfxDuoRow, gfxTrioRow, gfxDuoSingle, gfxAnalyst, gfxQuad, gfxSpotlight, gfxInterview, gfxInterviewDesk, gfxPreshow,
    gfxMatchup, gfxCampip, gfxTalentbar,
    gfxAway, gfxCountdown, gfxWinner, gfxWinTeam1, gfxWinTeam2, gfxTeam1, gfxTeam2,
    gfxMapVeto, gfxDraft, gfxBracket, gfxUpcoming, gfxStandings, gfxReplay, gfxTransition,
    gfxTicker, gfxSponsorRail, gfxSponsor, gfxListenIn, gfxIntCam,
  ];

  // ── Audio capture stubs ───────────────────────────────────────────────────
  function audioCap(capName, id_) {
    return {
      prev_ver: 536936450, name: capName, uuid: randomUUID(),
      id: id_, versioned_id: id_,
      settings: { device_id: 'default' },
      ...AUDIO_BASE,
      hotkeys: { 'libobs.mute': [], 'libobs.unmute': [], 'libobs.push-to-mute': [], 'libobs.push-to-talk': [] },
    };
  }

  return {
    name,
    DesktopAudioDevice1: audioCap('Desktop Audio', 'wasapi_output_capture'),
    AuxAudioDevice1:     audioCap('Mic/Aux',        'wasapi_input_capture'),
    groups: [],
    scene_order: allScenes.map(s => ({ name: s.name })),
    current_scene:         'In Game',
    current_program_scene: 'In Game',
    current_transition:    'Fade',
    transition_duration:   300,
    transitions: [
      { name: 'NE Stinger',  id: 'obs_stinger_transition', settings: { transition_point: 1500, path: stingerPath || '' } },
      { name: 'Luma Wipe',   id: 'wipe_transition',        settings: { luma_image: 'cloud.png', luma_softness: 0, luma_invert: true } },
    ],
    quick_transitions: [],
    saved_projectors:  [],
    preview_locked:    false,
    scaling_enabled:   false, scaling_level: 0, scaling_off_x: 0.0, scaling_off_y: 0.0,
    modules: {},
    resolution: { x: 1920, y: 1080 },
    version: 2,
    sources: [...sharedSources, ...allScenes],
  };
}

// ─── CLI usage ────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter(a => a.startsWith('--'))
      .map(a => {
        const [k, ...v] = a.slice(2).split('=');
        return [k, v.join('=')];
      })
  );

  const collection = generateSceneCollection({
    backgroundPath: args['bg-path'] || '',
    stingerPath:    args['stinger'] || '',
  });

  const outPath = path.join(__dirname, 'NE-Broadcast-Suite.json');
  fs.writeFileSync(outPath, JSON.stringify(collection, null, 2));
  console.log(`Wrote ${outPath} — ${collection.scene_order.length} scenes, ${collection.sources.length} sources.`);
  console.log('Import in OBS: Scene Collection → Import → select the .json file.');
  console.log('');
  console.log('Each desk scene has the => Caster N Cam utility scenes placed behind the overlay holes.');
  console.log('By default each cam scene shows the caster assigned in the control panel (castercam.html?slot=N).');
  console.log('To use Discord/NDI/webcam instead: open the => Caster N Cam scene in OBS and swap the source.');
}

module.exports = { generateSceneCollection };
