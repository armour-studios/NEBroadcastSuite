/**
 * NE Broadcast Suite — OBS Scene Collection Generator v2
 *
 * BGG-style layout: three cam-framing scenes (=> Host Cam / => Caster 1 Cam / => Caster 2 Cam)
 * are created as self-contained "utility" scenes and auto-embedded in all caster desk layouts:
 *   DuoCam Row     — Caster 1 left, Caster 2 right
 *   TrioCam Row    — Caster 1 | Caster 2 | Host (three equal slots)
 *   Analyst Desk   — Caster 1 & 2 small (left column), Host large (right)
 *   Duo SingleCam  — Caster 1 fills screen
 *
 * Replacing an NDI source: swap the VDO.ninja URL directly inside the => Cam scene;
 * every layout that embeds it updates instantly — no re-cropping needed.
 *
 * CLI:  node obs/build-scene-collection.js [--host-url=URL] [--caster1-url=URL] [--caster2-url=URL]
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
    boundsType  = 0,          // 0=none 1=stretch 2=scale-outer 3=scale-inner
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
function generateSceneCollection({
  name           = COLLECTION_NAME,
  hostCamUrl     = '',    // VDO.ninja view URL for the Host / Analyst
  caster1CamUrl  = '',    // VDO.ninja view URL for Caster 1
  caster2CamUrl  = '',    // VDO.ninja view URL for Caster 2
  stingerPath    = '',    // local .webm stinger path (optional)
  backgroundPath = '',    // local looping background video path (optional)
} = {}) {

  // ── Shared media / capture sources ─────────────────────────────────────────
  const bgLoop      = makeMediaLoop('Background Loop', backgroundPath);
  const gameCapture = makeGameCapture(
    'Game Capture',
    'Rocket League (64-bit, DX11, Cooked):LaunchUnrealUWindowsClient:RocketLeague.exe'
  );

  // ── Camera browser sources (raw VDO.ninja feeds) ──────────────────────────
  // These live ONLY inside the => Cam framing scenes.
  // To swap a caster's feed: change the URL in the framing scene; all layouts update.
  const vdoHost    = makeBrowser('[VDO] Host',     hostCamUrl    || 'https://vdo.ninja/?view=HOST_STREAM_ID');
  const vdoCaster1 = makeBrowser('[VDO] Caster 1', caster1CamUrl || 'https://vdo.ninja/?view=CASTER1_STREAM_ID');
  const vdoCaster2 = makeBrowser('[VDO] Caster 2', caster2CamUrl || 'https://vdo.ninja/?view=CASTER2_STREAM_ID');

  // ── HTML overlay browser sources ──────────────────────────────────────────
  const gfxRlHud      = makeBrowser('[GFX] RL Overlay',    '/rl-hud.html');
  const gfxCs2Hud     = makeBrowser('[GFX] CS2 Overlay',   '/csgo.html');
  const gfxDuoRow     = makeBrowser('[GFX] Duo Row',        '/duorow.html');
  const gfxTrioRow    = makeBrowser('[GFX] Trio Row',       '/triorow.html');
  const gfxDuoSingle  = makeBrowser('[GFX] Duo SingleCam',  '/duosinglecam.html');
  const gfxAnalyst    = makeBrowser('[GFX] Analyst Desk',   '/analystspecial.html');
  const gfxAway       = makeBrowser('[GFX] Away Screen',    '/awayfull.html',          { restart: true, shutdown: true });
  const gfxCountdown  = makeBrowser('[GFX] Countdown',      '/countdown.html',         { restart: true, shutdown: true });
  const gfxWinner     = makeBrowser('[GFX] Winner',         '/winner.html',            { restart: true, shutdown: true });
  const gfxTeam1      = makeBrowser('[GFX] Team 1 Intro',   '/intro.html?side=blue',   { restart: true, shutdown: true });
  const gfxTeam2      = makeBrowser('[GFX] Team 2 Intro',   '/intro.html?side=orange', { restart: true, shutdown: true });
  const gfxMapVeto    = makeBrowser('[GFX] Map Veto',        '/mapscreen.html',         { restart: true, shutdown: true });
  const gfxBracket    = makeBrowser('[GFX] Bracket',         '/bracket.html');
  const gfxReplay     = makeBrowser('[GFX] Replay',          '/replay.html',            { restart: true, shutdown: true });
  const gfxTransition = makeBrowser('[GFX] Transition',      '/transitionbgg.html',     { restart: true, shutdown: true });

  // ── Cam framing scenes (=> Host Cam / => Caster 1 Cam / => Caster 2 Cam) ─
  // Pattern matches BGG Overlay's "=> Caster N NDI Framing" scenes.
  // Each is a full-canvas scene containing ONE camera feed (VDO.ninja browser source).
  // Embedded into caster desk layouts with specific crop + scale per slot.
  function camScene(sceneName, vdoSrc) {
    const il = itemList();
    il.add(vdoSrc.name, vdoSrc.uuid, { locked: false, ...FULL_INNER });
    return makeScene(sceneName, il.get(), { showInMultiview: false, transitionMs: 0 });
  }

  const sceneHostCam    = camScene('=> Host Cam',     vdoHost);
  const sceneCaster1Cam = camScene('=> Caster 1 Cam', vdoCaster1);
  const sceneCaster2Cam = camScene('=> Caster 2 Cam', vdoCaster2);

  // ── In Game ────────────────────────────────────────────────────────────────
  // Game capture bottom, RL overlay on top; CS2 overlay hidden (toggle per game).
  {
    const il = itemList();
    il.add(gameCapture.name, gameCapture.uuid, { locked: false, ...FULL });
    il.add(gfxRlHud.name,    gfxRlHud.uuid,   { locked: false, ...FULL });
    il.add(gfxCs2Hud.name,   gfxCs2Hud.uuid,  { locked: false, visible: false, ...FULL, showMs: 300, hideMs: 300 });
    var sceneInGame = makeScene('In Game', il.get(), { transitionMs: 500 });
  }

  // ── DuoCam Row ─────────────────────────────────────────────────────────────
  // Two casters side-by-side in a lower-third frame.
  // Crop [320,180,320,180] extracts the 1280×720 centre of the 1920×1080 cam scene.
  const DUO_CROP = [320, 180, 320, 180];
  {
    const il = itemList();
    il.add(bgLoop.name,           bgLoop.uuid,            { ...FULL,        colorPreset: 5 });
    il.add(sceneCaster1Cam.name,  sceneCaster1Cam.uuid,   {
      pos: { x: 86, y: 276 }, scale: { x: 0.6625, y: 0.6625 }, bounds: { x: 1, y: 1 },
      crop: DUO_CROP, colorPreset: 4,
    });
    il.add(sceneCaster2Cam.name,  sceneCaster2Cam.uuid,   {
      pos: { x: 986, y: 276 }, scale: { x: 0.6625, y: 0.6625 }, bounds: { x: 1, y: 1 },
      crop: DUO_CROP, colorPreset: 4,
    });
    il.add(gfxDuoRow.name,        gfxDuoRow.uuid,         { ...FULL,        colorPreset: 7 });
    il.add(gfxTransition.name,    gfxTransition.uuid,     { ...FULL_STRETCH,colorPreset: 6 });
    var sceneDuoCam = makeScene('DuoCam Row', il.get(), { transitionMs: 300 });
  }

  // ── TrioCam Row ────────────────────────────────────────────────────────────
  // Three equal-width slots: Caster 1 | Caster 2 | Host.
  // Crop [480,180,480,180] extracts the 960×720 centre of each cam scene.
  const TRIO_CROP = [480, 180, 480, 180];
  {
    const il = itemList();
    il.add(bgLoop.name,          bgLoop.uuid,           { ...FULL,        colorPreset: 5 });
    il.add(sceneCaster1Cam.name, sceneCaster1Cam.uuid,  {
      pos: { x: 98,   y: 312 }, scale: { x: 0.5625, y: 0.5625 }, bounds: { x: 1, y: 1 },
      crop: TRIO_CROP, colorPreset: 4,
    });
    il.add(sceneCaster2Cam.name, sceneCaster2Cam.uuid,  {
      pos: { x: 690,  y: 312 }, scale: { x: 0.5625, y: 0.5625 }, bounds: { x: 1, y: 1 },
      crop: TRIO_CROP, colorPreset: 4,
    });
    il.add(sceneHostCam.name,    sceneHostCam.uuid,     {
      pos: { x: 1282, y: 312 }, scale: { x: 0.5625, y: 0.5625 }, bounds: { x: 1, y: 1 },
      crop: TRIO_CROP, colorPreset: 4,
    });
    il.add(gfxTrioRow.name,      gfxTrioRow.uuid,       { ...FULL,        colorPreset: 7 });
    il.add(gfxTransition.name,   gfxTransition.uuid,    { ...FULL, visible: false, colorPreset: 6 });
    var sceneTrioCam = makeScene('TrioCam Row', il.get(), { transitionMs: 300 });
  }

  // ── Analyst Desk ───────────────────────────────────────────────────────────
  // Host large (right), Caster 1 top-left small, Caster 2 bottom-left small.
  const ANALYST_CROP = [320, 180, 320, 180];
  {
    const il = itemList();
    il.add(bgLoop.name,          bgLoop.uuid,           { ...FULL,        colorPreset: 5 });
    il.add(sceneCaster1Cam.name, sceneCaster1Cam.uuid,  {
      pos: { x: 125, y: 194 }, scale: { x: 0.375, y: 0.375 }, bounds: { x: 1, y: 1 },
      crop: ANALYST_CROP, colorPreset: 4,
    });
    il.add(sceneCaster2Cam.name, sceneCaster2Cam.uuid,  {
      pos: { x: 125, y: 559 }, scale: { x: 0.375, y: 0.375 }, bounds: { x: 1, y: 1 },
      crop: ANALYST_CROP, colorPreset: 4,
    });
    il.add(sceneHostCam.name,    sceneHostCam.uuid,     {
      pos: { x: 659, y: 195 }, scale: { x: 0.8875, y: 0.8875 }, bounds: { x: 1, y: 1 },
      crop: ANALYST_CROP, colorPreset: 4,
    });
    il.add(gfxAnalyst.name,      gfxAnalyst.uuid,       { ...FULL,        colorPreset: 7 });
    il.add(gfxTransition.name,   gfxTransition.uuid,    { ...FULL, visible: false, colorPreset: 6 });
    var sceneAnalyst = makeScene('Analyst Desk', il.get(), { transitionMs: 300 });
  }

  // ── Duo SingleCam ──────────────────────────────────────────────────────────
  // Caster 1 fills screen at 1.5× zoom (centre-cropped to face).
  {
    const il = itemList();
    il.add(bgLoop.name,           bgLoop.uuid,           { ...FULL,         colorPreset: 5 });
    il.add(sceneCaster1Cam.name,  sceneCaster1Cam.uuid,  {
      pos: { x: 0, y: 0 }, scale: { x: 1.5, y: 1.5 }, bounds: { x: 1, y: 1 },
      crop: [320, 180, 320, 180], colorPreset: 4,
    });
    il.add(gfxDuoSingle.name,     gfxDuoSingle.uuid,    { ...FULL,         colorPreset: 7 });
    il.add(gfxTransition.name,    gfxTransition.uuid,   { ...FULL_STRETCH, visible: false, colorPreset: 6 });
    var sceneDuoSingle = makeScene('Duo SingleCam', il.get(), { transitionMs: 300 });
  }

  // ── Simple full-screen overlay scenes ─────────────────────────────────────
  function simpleScene(sceneName, gfxSrc, transMs, multiview = true) {
    const il = itemList();
    il.add(bgLoop.name,   bgLoop.uuid,   { ...FULL,         colorPreset: 5 });
    il.add(gfxSrc.name,   gfxSrc.uuid,  { ...FULL_STRETCH, colorPreset: 7 });
    return makeScene(sceneName, il.get(), { transitionMs: transMs, showInMultiview: multiview });
  }

  const sceneAway      = simpleScene('Away / Standby',     gfxAway,      500);
  const sceneCountdown = simpleScene('Break (Countdown)',   gfxCountdown, 300);
  const sceneWinner    = simpleScene('Post-Game (Winner)',  gfxWinner,    500);
  const sceneTeam1     = simpleScene('Team 1 Intro',        gfxTeam1,     500, false);
  const sceneTeam2     = simpleScene('Team 2 Intro',        gfxTeam2,     500, false);
  const sceneMapVeto   = simpleScene('Map Veto',             gfxMapVeto,   500);
  const sceneBracket   = simpleScene('Bracket',              gfxBracket,   300);
  const sceneReplay    = simpleScene('Replay',               gfxReplay,    500, false);

  // Divider — blank separator in the OBS scene list
  const sceneDivider = makeScene('____________________', [], { showInMultiview: false });

  // ── Scene order ────────────────────────────────────────────────────────────
  // Production scenes first, utility cam-framing scenes at the bottom (BGG convention).
  const allScenes = [
    sceneInGame,
    sceneReplay,
    sceneCountdown,
    sceneWinner,
    sceneDuoCam,
    sceneTrioCam,
    sceneAnalyst,
    sceneDuoSingle,
    sceneAway,
    sceneTeam1,
    sceneTeam2,
    sceneMapVeto,
    sceneBracket,
    sceneDivider,
    // ── utility ──
    sceneHostCam,
    sceneCaster1Cam,
    sceneCaster2Cam,
  ];

  // ── All non-scene sources ─────────────────────────────────────────────────
  const sharedSources = [
    bgLoop, gameCapture,
    vdoHost, vdoCaster1, vdoCaster2,
    gfxRlHud, gfxCs2Hud,
    gfxDuoRow, gfxTrioRow, gfxDuoSingle, gfxAnalyst,
    gfxAway, gfxCountdown, gfxWinner, gfxTeam1, gfxTeam2,
    gfxMapVeto, gfxBracket, gfxReplay, gfxTransition,
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
    hostCamUrl:    args['host-url']    || '',
    caster1CamUrl: args['caster1-url'] || '',
    caster2CamUrl: args['caster2-url'] || '',
    backgroundPath: args['bg-path']    || '',
  });

  const outPath = path.join(__dirname, 'NE-Broadcast-Suite.json');
  fs.writeFileSync(outPath, JSON.stringify(collection, null, 2));
  console.log(`Wrote ${outPath} — ${collection.scene_order.length} scenes, ${collection.sources.length} sources.`);
  console.log('Import in OBS: Scene Collection → Import → select the .json file.');
  console.log('');
  console.log('Cam scenes to update after import:');
  console.log('  => Host Cam     → set [VDO] Host URL to your Host VDO.ninja view link');
  console.log('  => Caster 1 Cam → set [VDO] Caster 1 URL');
  console.log('  => Caster 2 Cam → set [VDO] Caster 2 URL');
  console.log('(Or pass --host-url=, --caster1-url=, --caster2-url= to pre-populate.)');
}

module.exports = { generateSceneCollection };
