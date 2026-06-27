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

function makeBrowser(name, url, { restart = false, shutdown = false, w = 1920, h = 1080 } = {}) {
  return {
    prev_ver: 536936450, name, uuid: randomUUID(),
    id: 'browser_source', versioned_id: 'browser_source',
    settings: {
      url: url.startsWith('http') ? url : OVERLAY_HOST + url,
      width: w, height: h,
      restart_when_active: restart,
      shutdown,
      css: 'body { background: rgba(0,0,0,0); margin: 0; overflow: hidden; }',
    },
    ...AUDIO_BASE, mixers: 0, hotkeys: BROWSER_HK,
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
  const vdoHost    = makeBrowser('[CAM] Host (slot 3)',     '/castercam.html?slot=3');
  const vdoCaster1 = makeBrowser('[CAM] Caster 1 (slot 1)', '/castercam.html?slot=1');
  const vdoCaster2 = makeBrowser('[CAM] Caster 2 (slot 2)', '/castercam.html?slot=2');
  const vdoCaster4 = makeBrowser('[CAM] Caster 4 (slot 4)', '/castercam.html?slot=4');

  // ── Game HUD overlay sources (transparent, sit over Game Capture) ──────────
  const gfxRlHud   = makeBrowser('[GFX] RL HUD',            '/rl-hud.html');
  const gfxCs2Hud  = makeBrowser('[GFX] CS2 HUD',           '/csgo.html');
  const gfxValHud  = makeBrowser('[GFX] Valorant HUD',      '/valorant.html');
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
  const gfxSpotlight = makeBrowser('[GFX] Spotlight Desk', '/spotlightdesk.html' + co);
  const gfxInterview = makeBrowser('[GFX] Interview',      '/interview.html' + co);
  // Cams embedded always (responsive / multi-cam layouts — combined cams regardless of mode):
  const gfxMatchup   = makeBrowser('[GFX] Matchup',        '/matchup.html');
  const gfxCampip    = makeBrowser('[GFX] Cam PIP',        '/campip.html');
  const gfxTalentbar = makeBrowser('[GFX] Talent Bar',     '/talentbar.html');

  // ── Full-screen graphic sources ────────────────────────────────────────────
  const gfxAway       = makeBrowser('[GFX] Away Screen',    '/countdown.html',         { restart: true, shutdown: true });
  const gfxCountdown  = makeBrowser('[GFX] Countdown',      '/countdown.html',         { restart: true, shutdown: true });
  const gfxWinner     = makeBrowser('[GFX] Winner',         '/winner.html',            { restart: true, shutdown: true });
  const gfxTeam1      = makeBrowser('[GFX] Team 1 Intro',   '/intro.html?side=blue',   { restart: true, shutdown: true });
  const gfxTeam2      = makeBrowser('[GFX] Team 2 Intro',   '/intro.html?side=orange', { restart: true, shutdown: true });
  const gfxMapVeto    = makeBrowser('[GFX] Map Veto',        '/mapscreen.html',         { restart: true, shutdown: true });
  const gfxDraft      = makeBrowser('[GFX] Draft',           '/draft.html');
  const gfxBracket    = makeBrowser('[GFX] Bracket',         '/bracket.html');
  const gfxUpcoming   = makeBrowser('[GFX] Upcoming',        '/upcoming.html');
  const gfxStandings  = makeBrowser('[GFX] Standings',       '/standings.html');
  const gfxReplay     = makeBrowser('[GFX] Replay',          '/replay.html',            { restart: true, shutdown: true });
  const gfxTransition = makeBrowser('[GFX] Transition',      '/transitionbgg.html',     { restart: true, shutdown: true });

  // ── Draggable add-on overlays (no dedicated scene; drop onto any scene) ─────
  const gfxSponsor  = makeBrowser('[GFX] Sponsor Banner',   '/sponsor-banner.html');
  const gfxListenIn = makeBrowser('[GFX] Listen-In Captions', '/listen-in.html');
  const gfxIntCam   = makeBrowser('[GFX] Interviewee Cam',  '/int-cam.html');

  // ── Cam framing scenes (=> Host Cam / => Caster 1 Cam / …) ─────────────────
  // Each is a full-canvas scene containing ONE camera feed (VDO.ninja browser source),
  // embedded into desk layouts with per-slot crop + scale. Always shipped so a producer
  // can hand-place a cam anywhere; used automatically by the desks in separated mode.
  function camScene(sceneName, vdoSrc) {
    const il = itemList();
    il.add(vdoSrc.name, vdoSrc.uuid, { locked: false, ...FULL_INNER });
    return makeScene(sceneName, il.get(), { showInMultiview: false, transitionMs: 0 });
  }

  const sceneHostCam    = camScene('=> Host Cam',     vdoHost);
  const sceneCaster1Cam = camScene('=> Caster 1 Cam', vdoCaster1);
  const sceneCaster2Cam = camScene('=> Caster 2 Cam', vdoCaster2);
  const sceneCaster4Cam = camScene('=> Caster 4 Cam', vdoCaster4);

  // ── Generic helpers ─────────────────────────────────────────────────────────
  // Full-screen graphic over the looping background.
  function simpleScene(sceneName, gfxSrc, transMs, multiview = true) {
    const il = itemList();
    il.add(bgLoop.name,  bgLoop.uuid,  { ...FULL,         colorPreset: 5 });
    il.add(gfxSrc.name,  gfxSrc.uuid,  { ...FULL_STRETCH, colorPreset: 7 });
    return makeScene(sceneName, il.get(), { transitionMs: transMs, showInMultiview: multiview });
  }

  // Caster desk: background → cam utility scenes (behind holes) → overlay graphic → transition.
  // The overlay HTML runs with ?cams=off so its cam holes are transparent; the utility scenes
  // show through. Users can swap the browser source in any => Cam scene for Discord, NDI, etc.
  function deskScene(sceneName, gfxSrc, addCams) {
    const il = itemList();
    il.add(bgLoop.name, bgLoop.uuid, { ...FULL, colorPreset: 5 });
    if (addCams) addCams(il);
    il.add(gfxSrc.name, gfxSrc.uuid, { ...FULL, colorPreset: 7 });
    il.add(gfxTransition.name, gfxTransition.uuid, { ...FULL_STRETCH, visible: false, colorPreset: 6 });
    return makeScene(sceneName, il.get(), { transitionMs: 300 });
  }

  // Gameplay scene: Game Capture on the bottom, a stack of game HUDs (only `active` shown),
  // plus optional extra overlay layers (PIP cams / talent bar) on top.
  function gameScene(sceneName, activeHud, extras = []) {
    const huds = [gfxRlHud, gfxCs2Hud, gfxValHud, gfxOwHud, gfxMrHud];
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
  const sceneReplay   = simpleScene('Replay', gfxReplay, 500, false);

  // ── Caster / desk scenes ─────────────────────────────────────────────────
  // Separated-mode hole geometry. Each cam scene (a full 16:9 source) is COVER-framed into the
  // exact transparent hole the overlay renders, so it fills the hole and any overflow is hidden
  // behind the opaque desk graphic on top. The rectangles below were measured from the live
  // overlays at 1920×1080 (?cams=off) — see _measure-holes.js / scene-base.js ?guide=1.
  //   bounds_type 3 = OBS SCALE_OUTER (cover/fill, crop overflow). pos = hole top-left, bounds = hole size.
  const frame = (x, y, w, h) => ({ pos: { x, y }, scale: { x: 1, y: 1 }, bounds: { x: w, y: h }, boundsType: 3, colorPreset: 4 });

  const sceneSingle = deskScene('SingleCam', gfxSingle, il => {
    il.add(sceneCaster1Cam.name, sceneCaster1Cam.uuid, frame(371, 238, 1178, 673));
  });
  const sceneDuoCam = deskScene('DuoCam Row', gfxDuoRow, il => {
    il.add(sceneCaster1Cam.name, sceneCaster1Cam.uuid, frame(24,  248, 928, 522));
    il.add(sceneCaster2Cam.name, sceneCaster2Cam.uuid, frame(968, 248, 928, 522));
  });
  const sceneTrioCam = deskScene('TrioCam Row', gfxTrioRow, il => {
    il.add(sceneCaster1Cam.name, sceneCaster1Cam.uuid, frame(25,   160, 611, 843));
    il.add(sceneCaster2Cam.name, sceneCaster2Cam.uuid, frame(654,  160, 611, 843));
    il.add(sceneHostCam.name,    sceneHostCam.uuid,    frame(1284, 160, 611, 843));
  });
  const sceneQuad = deskScene('Quad Desk', gfxQuad, il => {
    il.add(sceneCaster1Cam.name, sceneCaster1Cam.uuid, frame(278, 130, 673, 371));
    il.add(sceneCaster2Cam.name, sceneCaster2Cam.uuid, frame(969, 130, 673, 371));
    il.add(sceneHostCam.name,    sceneHostCam.uuid,    frame(278, 568, 673, 371));
    il.add(sceneCaster4Cam.name, sceneCaster4Cam.uuid, frame(969, 568, 673, 371));
  });
  const sceneAnalyst = deskScene('Analyst Desk', gfxAnalyst, il => {
    il.add(sceneCaster1Cam.name, sceneCaster1Cam.uuid, frame(25,  20,  598, 437));
    il.add(sceneCaster2Cam.name, sceneCaster2Cam.uuid, frame(25,  528, 598, 437));
    il.add(sceneHostCam.name,    sceneHostCam.uuid,    frame(641, 174, 1254, 705));
  });
  const sceneDuoSingle = deskScene('Duo SingleCam', gfxDuoSingle, il => {
    il.add(sceneCaster1Cam.name, sceneCaster1Cam.uuid, frame(361, 232, 1198, 684));
  });
  const sceneSpotlight = deskScene('Spotlight Desk', gfxSpotlight, il => {
    il.add(sceneCaster1Cam.name, sceneCaster1Cam.uuid, frame(31, 331, 718, 414));
  });
  const sceneInterview = deskScene('Interview', gfxInterview, il => {
    il.add(sceneCaster1Cam.name, sceneCaster1Cam.uuid, frame(29,  268, 917, 526));
    il.add(sceneCaster2Cam.name, sceneCaster2Cam.uuid, frame(974, 268, 917, 526));
  });
  // Matchup embeds its own (small, responsive) caster strip — combined cams regardless of mode.
  const sceneMatchup = deskScene('Matchup', gfxMatchup, null);

  // ── Pre-game / break / standalone graphic scenes ──────────────────────────
  const sceneAway      = simpleScene('Away / Standby',     gfxAway,      500);
  const sceneCountdown = simpleScene('Break (Countdown)',  gfxCountdown, 300);
  const sceneMapVeto   = simpleScene('Map Veto',           gfxMapVeto,   500);
  const sceneDraft     = simpleScene('Draft',              gfxDraft,     300);
  const sceneTeam1     = simpleScene('Team 1 Intro',       gfxTeam1,     500, false);
  const sceneTeam2     = simpleScene('Team 2 Intro',       gfxTeam2,     500, false);
  const sceneUpcoming  = simpleScene('Upcoming',           gfxUpcoming,  300);
  const sceneStandings = simpleScene('Standings',          gfxStandings, 300);
  const sceneBracket   = simpleScene('Bracket',            gfxBracket,   300);
  const sceneWinner    = simpleScene('Post-Game (Winner)', gfxWinner,    500);

  // Dividers — blank separators in the OBS scene list
  const dividerLive  = makeScene('───  LIVE  ───',    [], { showInMultiview: false });
  const dividerDesk  = makeScene('───  DESK  ───',    [], { showInMultiview: false });
  const dividerUtil  = makeScene('───  UTILITY  ───', [], { showInMultiview: false });

  // ── Scene order ────────────────────────────────────────────────────────────
  const allScenes = [
    // Pre-game / break
    sceneAway,
    sceneCountdown,
    sceneMapVeto,
    sceneDraft,
    sceneMatchup,
    sceneTeam1,
    sceneTeam2,
    sceneUpcoming,
    sceneStandings,
    sceneBracket,
    // Live
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
    sceneQuad,
    sceneAnalyst,
    sceneDuoSingle,
    sceneSpotlight,
    sceneInterview,
    sceneWinner,
    // Utility — cam framing scenes
    dividerUtil,
    sceneHostCam,
    sceneCaster1Cam,
    sceneCaster2Cam,
    sceneCaster4Cam,
  ];

  // ── All non-scene sources ─────────────────────────────────────────────────
  const sharedSources = [
    bgLoop, gameCapture,
    vdoHost, vdoCaster1, vdoCaster2, vdoCaster4,
    gfxRlHud, gfxCs2Hud, gfxValHud, gfxOwHud, gfxMrHud,
    gfxSingle, gfxDuoRow, gfxTrioRow, gfxDuoSingle, gfxAnalyst, gfxQuad, gfxSpotlight, gfxInterview,
    gfxMatchup, gfxCampip, gfxTalentbar,
    gfxAway, gfxCountdown, gfxWinner, gfxTeam1, gfxTeam2,
    gfxMapVeto, gfxDraft, gfxBracket, gfxUpcoming, gfxStandings, gfxReplay, gfxTransition,
    gfxSponsor, gfxListenIn, gfxIntCam,
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
