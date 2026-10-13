'use strict';
// Branding: brand kits and packages, presets, banners, theme, fonts — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly; values server.js reassigns are
// read and written through ctx (savedBrandKits, savedPresets).
let
  GAMES, PACKAGE_FIELDS, activateBrandKitById, activePackage, applyBrandSlots, applyKitStyles,
  applyPackageSnapshot, applyPreset, brandId, broadcastFullState, capturePackageSnapshot,
  capturePreset, dialog, ensureKitPackages, fsp, isValidTheme, migrateThemeId, sanitizePackage,
  saveAppState, saveBrandKits, savePresets, sendImportExportResult, state,
  syncActivePreshowTopics;
let ctx;

const handlers = {
  save_scene_preset(msg, ws) {
    const { scene: _sp_scene, name: _sp_name, config: _sp_cfg } = msg.data || {};
    if (!_sp_scene || !_sp_name || _sp_name === 'Default') return;
    if (!state.scenePresets[_sp_scene]) state.scenePresets[_sp_scene] = { active: 'Default', presets: {} };
    state.scenePresets[_sp_scene].presets[_sp_name] = { label: _sp_name, config: _sp_cfg || {} };
    state.scenePresets[_sp_scene].active = _sp_name;
    if (_sp_name !== '__preview__') saveAppState();
    broadcastFullState();
  },

  delete_scene_preset(msg, ws) {
    const { scene: _dp_scene, name: _dp_name } = msg.data || {};
    if (!_dp_scene || !_dp_name || _dp_name === 'Default') return;
    const _dp_sp = state.scenePresets[_dp_scene];
    if (_dp_sp) {
      delete _dp_sp.presets[_dp_name];
      if (_dp_sp.active === _dp_name) _dp_sp.active = 'Default';
    }
    saveAppState();
    broadcastFullState();
  },

  activate_scene_preset(msg, ws) {
    const { scene: _ap_scene, name: _ap_name } = msg.data || {};
    if (!_ap_scene || !_ap_name) return;
    if (!state.scenePresets[_ap_scene]) state.scenePresets[_ap_scene] = { active: _ap_name, presets: {} };
    else state.scenePresets[_ap_scene].active = _ap_name;
    saveAppState();
    broadcastFullState();
  },

  // ── Desk Show (preshow.html) — discussion-topics rail + headline ───
  // ── Desk Show topic presets — named rundowns (pre-show / halftime / post-show…) ──
  save_preshow_preset(msg, ws) {
    const name = (msg.data?.name || '').toString().trim().slice(0, 40);
    if (!name) return;
    if (!Array.isArray(state.preshowPresets)) state.preshowPresets = [];
    const entry = {
      id: Math.random().toString(36).slice(2, 11),
      name,
      headline: (state.preshow && state.preshow.headline) || '',
      topics: JSON.parse(JSON.stringify((state.preshow && state.preshow.topics) || []))
    };
    const idx = state.preshowPresets.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
    if (idx >= 0) { entry.id = state.preshowPresets[idx].id; state.preshowPresets[idx] = entry; }
    else state.preshowPresets.push(entry);
    saveAppState();
    broadcastFullState();
  },

  apply_preshow_preset(msg, ws) {
    const preset = (state.preshowPresets || []).find((p) => p.id === msg.data?.id);
    if (!preset) return;
    state.preshow.headline = preset.headline || '';
    state.preshow.topics = JSON.parse(JSON.stringify(preset.topics || []));
    state.preshow.activeTopicIndex = 0;
    // Same rule as set_preshow: topics are brand content — persist onto the active package
    // so kit/package switches bring this rundown back.
    const kit = ctx.savedBrandKits.find((b) => b.id === state.activeBrandKitId);
    const pkg = kit ? activePackage(kit) : null;
    if (kit && pkg) { pkg.topicsHeadline = state.preshow.headline; pkg.topics = state.preshow.topics; saveBrandKits(); }
    saveAppState();
    broadcastFullState();
  },

  delete_preshow_preset(msg, ws) {
    if (Array.isArray(state.preshowPresets)) {
      state.preshowPresets = state.preshowPresets.filter((p) => p.id !== msg.data?.id);
      saveAppState();
      broadcastFullState();
    }
  },

  // (set_intro migrated to the WS_HANDLERS registry above handleControlMessage)
  set_font_family(msg, ws) {
    state.fontFamily = msg.data.fontFamily || 'Bourgeois';
    saveAppState();
    broadcastFullState();
  },

  // NOTE: 'set_theme' is handled further down in this same switch, by the validating version
  // that runs migrateThemeId() + isValidTheme(). An earlier duplicate case sat here and, being
  // first, always won — so the Settings ▸ Overlay Appearance picker (which sends the aliases
  // default/midnight/neon, see THEME_ALIASES) stored the alias raw instead of the real layout id.
  // The overlay still resolved via migrateThemeId at read time, but the design <select> has no
  // matching option for an alias, so the picker went blank. Duplicate removed.
  set_global_accent(msg, ws) {
    if (typeof msg.data.color === 'string') {
      if (!state.brand) state.brand = {};
      state.brand.color = msg.data.color;
    }
    saveAppState();
    broadcastFullState();
  },

  set_banner_visibility(msg, ws) {
    state.banner.visible = !!msg.data.visible;
    saveAppState();
    broadcastFullState();
  },

  add_banner_image(msg, ws) {
    if (msg.data.image) {
      if (!state.banner.images) state.banner.images = [];
      if (!Array.isArray(state.banner.captions)) state.banner.captions = [];
      state.banner.images.push(msg.data.image);
      state.banner.captions[state.banner.images.length - 1] = typeof msg.data.caption === 'string' ? msg.data.caption : '';
      saveAppState();
      broadcastFullState();
    }
  },

  remove_banner_image(msg, ws) {
    if (state.banner.images && typeof msg.data.index === 'number') {
      state.banner.images.splice(msg.data.index, 1);
      if (Array.isArray(state.banner.captions)) state.banner.captions.splice(msg.data.index, 1);
      saveAppState();
      broadcastFullState();
    }
  },

  // Optional per-image caption text (e.g. USE CODE NAMELESS FOR 5% OFF), rendered by the banner overlay.
  set_banner_caption(msg, ws) {
    if (typeof msg.data.index === 'number') {
      if (!Array.isArray(state.banner.captions)) state.banner.captions = [];
      state.banner.captions[msg.data.index] = typeof msg.data.text === 'string' ? msg.data.text : '';
      saveAppState();
      broadcastFullState();
    }
  },

  set_banner_interval(msg, ws) {
    state.banner.interval = Math.max(1, msg.data.interval || 10);
    saveAppState();
    broadcastFullState();
  },

  set_banner_slant(msg, ws) {
    state.banner.slant = ['right', 'left', 'box'].includes(msg.data.slant) ? msg.data.slant : 'right';
    saveAppState();
    broadcastFullState();
  },

  set_banner_header(msg, ws) {
    state.banner.header = typeof msg.data.header === 'string' ? msg.data.header.slice(0, 40) : '';
    saveAppState();
    broadcastFullState();
  },

  add_brand_kit_banner_image(msg, ws) {
    const kit = ctx.savedBrandKits.find((b) => b.id === msg.data?.id);
    if (kit && msg.data?.image) {
      if (!Array.isArray(kit.bannerImages)) kit.bannerImages = [];
      kit.bannerImages.push(msg.data.image);
      saveBrandKits();
      broadcastFullState();
    }
  },

  remove_brand_kit_banner_image(msg, ws) {
    const kit = ctx.savedBrandKits.find((b) => b.id === msg.data?.id);
    if (kit && Array.isArray(kit.bannerImages) && typeof msg.data?.index === 'number') {
      kit.bannerImages.splice(msg.data.index, 1);
      saveBrandKits();
      broadcastFullState();
    }
  },

  set_theme(msg, ws) {
    const t = msg.data?.theme;
    // Optional game: Settings ▸ Games sets a game's layout without making it the active game.
    const tg = (msg.data?.game && GAMES[msg.data.game]) ? msg.data.game : state.activeGame;
    if (t) {
      const migrated = migrateThemeId(tg, t);
      if (isValidTheme(tg, migrated)) {
        state.themesByGame[tg] = migrated;
        saveAppState();
        broadcastFullState();
      }
    }
  },

  // ── Broadcast config presets ─────────────────────────────────────────
  save_preset(msg, ws) {
    const name = (msg.data?.name || '').toString().trim();
    if (!name) return;
    const existing = ctx.savedPresets.find((p) => p.name.toLowerCase() === name.toLowerCase());
    const entry = { id: existing ? existing.id : Math.random().toString(36).slice(2, 11), name, game: state.activeGame, config: capturePreset() };
    if (existing) Object.assign(existing, entry);
    else ctx.savedPresets.push(entry);
    savePresets();
    broadcastFullState();
  },

  load_preset(msg, ws) {
    const preset = ctx.savedPresets.find((p) => p.id === msg.data?.id);
    if (preset) {
      applyPreset(preset.config);
      saveAppState();
      broadcastFullState();
    }
  },

  delete_preset(msg, ws) {
    ctx.savedPresets = ctx.savedPresets.filter((p) => p.id !== msg.data?.id);
    savePresets();
    broadcastFullState();
  },

  // ── Brand kits (client identities + sponsor sets) ────────────────────
  save_brand_kit(msg, ws) {
    const k = msg.data || {};
    const name = (k.name || '').toString().trim();
    if (!name) return;
    const existing = ctx.savedBrandKits.find((b) => b.id === k.id) ||
      ctx.savedBrandKits.find((b) => b.name.toLowerCase() === name.toLowerCase());
    const entry = {
      id: existing ? existing.id : brandId(),
      name,
      logo: k.logo || null,
      color: k.color || null,
      accent: k.accent || null,
      font: k.font || null,
      themes: (k.themes && typeof k.themes === 'object') ? k.themes : {},
      linkStyles: !!k.linkStyles,   // per-game designs above apply on go-live only when linked (see applyKitStyles)
      obsSceneCollection: (typeof k.obsSceneCollection === 'string') ? k.obsSceneCollection.trim() : '',
      obsProfile: (typeof k.obsProfile === 'string') ? k.obsProfile.trim() : '',
      packages: [],
      activePackageId: null,
    };
    if (Array.isArray(k.packages) && k.packages.length) {
      // New client: identity + an explicit list of sponsor/banner packages.
      entry.packages = k.packages.map((p) => sanitizePackage(p));
      entry.activePackageId = entry.packages.some((p) => p.id === k.activePackageId) ? k.activePackageId : entry.packages[0].id;
    } else {
      // Legacy single-package payload (sponsors/banner at the top level) → wrap into one package,
      // reusing the existing active package id so a re-save edits in place.
      const pkg = sanitizePackage({ ...k, id: (existing && existing.activePackageId) || undefined, name: (existing && (existing.packages || [])[0] && existing.packages[0].name) || 'Main' });
      entry.packages = [pkg];
      entry.activePackageId = pkg.id;
    }
    if (existing) {
      Object.assign(existing, entry);
      PACKAGE_FIELDS.forEach((f) => delete existing[f]);   // strip any legacy top-level duplicates
      // Editing a From-organization kit adopts it as your own (the next org pull won't wipe it).
      delete existing._org; delete existing._orgOwner;
    } else ctx.savedBrandKits.push(entry);
    saveBrandKits();
    // "Save & Activate" — put the saved profile on air in the same action (covers new kits
    // too, whose id only exists server-side). Plain save on the already-live kit still runs
    // the full package-activation side effects so a ★-star change takes effect in ONE save.
    if (msg.data && msg.data.activate) {
      activateBrandKitById(entry.id);
    } else if (entry.id === state.activeBrandKitId) {
      applyBrandSlots();
      syncActivePreshowTopics();
      const liveKit = existing || ctx.savedBrandKits.find((b) => b.id === entry.id);
      const snapped = applyPackageSnapshot(activePackage(liveKit), { styles: !!(liveKit && liveKit.linkStyles) });
      if (applyKitStyles(liveKit) || snapped) saveAppState();
    }
    broadcastFullState();
  },

  activate_brand_kit(msg, ws) {
    activateBrandKitById(msg.data?.id || null);
  },

  // Pick which sponsor/banner package of a profile is live (the per-stream quick-switch).
  activate_brand_package(msg, ws) {
    const kit = ctx.savedBrandKits.find((b) => b.id === msg.data?.kitId);
    if (kit) {
      ensureKitPackages(kit);
      if (kit.packages.some((p) => p.id === msg.data?.packageId)) {
        kit.activePackageId = msg.data.packageId;
        saveBrandKits();
        if (kit.id === state.activeBrandKitId) {
          applyBrandSlots();
          syncActivePreshowTopics();
          if (applyPackageSnapshot(activePackage(kit), { styles: !!kit.linkStyles })) saveAppState();
        }
        broadcastFullState();
      }
    }
  },

  // "Capture current show setup" — snapshot the live scene presets / ticker / event name /
  // board titles / caster lineup + slot labels / OBS moment mappings into a package, so
  // activating it later restores the whole show configuration.
  capture_package_snapshot(msg, ws) {
    const kit = ctx.savedBrandKits.find((b) => b.id === msg.data?.kitId);
    if (kit) {
      ensureKitPackages(kit);
      const pkg = kit.packages.find((p) => p.id === msg.data?.packageId);
      if (pkg) {
        pkg.showSnapshot = capturePackageSnapshot();
        saveBrandKits();
        broadcastFullState();
        ws.send(JSON.stringify({ type: 'brand-result', data: { ok: true, message: `Show setup captured into "${pkg.name}".` } }));
        return;
      }
    }
    ws.send(JSON.stringify({ type: 'brand-result', data: { ok: false, message: 'That brand kit or package no longer exists. Nothing was captured.' } }));
  },

  // Duplicate a whole profile (identity + every package) as a new client.
  duplicate_brand_kit(msg, ws) {
    const src = ctx.savedBrandKits.find((b) => b.id === msg.data?.id);
    if (src) {
      ensureKitPackages(src);
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = brandId();
      copy.name = 'Copy of ' + (src.name || 'Profile');
      // A copy is YOURS — left tagged as an org kit, the next organization pull deleted it.
      delete copy._org; delete copy._orgOwner;
      const idMap = {};
      copy.packages = (copy.packages || []).map((p) => { const nid = brandId(); idMap[p.id] = nid; return { ...p, id: nid }; });
      copy.activePackageId = idMap[src.activePackageId] || (copy.packages[0] && copy.packages[0].id) || null;
      ctx.savedBrandKits.splice(ctx.savedBrandKits.indexOf(src) + 1, 0, copy);
      saveBrandKits();
      broadcastFullState();
    }
  },

  export_brand_kit(msg, ws) {
    (async () => {
      const kit = ctx.savedBrandKits.find((b) => b.id === msg.data?.id);
      if (!kit) { sendImportExportResult(ws, false, 'Brand kit not found.'); return; }
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Export Brand Kit',
        defaultPath: (kit.name || 'brand-kit').replace(/[^a-z0-9]/gi, '-').toLowerCase() + '-brand-kit.json',
        filters: [{ name: 'NE Brand Kit', extensions: ['json'] }],
      });
      if (canceled || !filePath) { sendImportExportResult(ws, false, 'Export cancelled.'); return; }
      try {
        const payload = { format: 'ne-brand-kit', version: 1, exportedAt: Date.now(), kit: JSON.parse(JSON.stringify(kit)) };
        await fsp.writeFile(filePath, JSON.stringify(payload, null, 2));
        sendImportExportResult(ws, true, `Brand kit "${kit.name}" exported.`);
      } catch (e) { sendImportExportResult(ws, false, 'Export failed: ' + e.message); }
    })();
  },

  import_brand_kit(msg, ws) {
    (async () => {
      try {
        const { canceled, filePaths } = await dialog.showOpenDialog({
          title: 'Import Brand Kit',
          filters: [{ name: 'NE Brand Kit', extensions: ['json'] }],
          properties: ['openFile'],
        });
        if (canceled || !filePaths || !filePaths[0]) { sendImportExportResult(ws, false, 'Import cancelled.'); return; }
        const raw = await fsp.readFile(filePaths[0], 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.format !== 'ne-brand-kit' || !parsed.kit)
          throw new Error('Not a valid NE Brand Kit file.');
        const incoming = parsed.kit;
        if (!incoming.id) incoming.id = brandId();
        ensureKitPackages(incoming);
        const idx = ctx.savedBrandKits.findIndex((k) => (k.id && k.id === incoming.id) || k.name === incoming.name);
        if (idx >= 0) Object.assign(ctx.savedBrandKits[idx], incoming);
        else ctx.savedBrandKits.unshift(incoming);
        saveBrandKits();
        broadcastFullState();
        sendImportExportResult(ws, true, `Brand kit "${incoming.name}" imported.`);
      } catch (e) { sendImportExportResult(ws, false, 'Import failed: ' + e.message); }
    })();
  },

  // Colour mode: which source the overlays use for the two sides. Non-destructive —
  // team/brand/default each keep their own colours; this only picks the active one.
  set_color_mode(msg, ws) {
    const m = msg.data?.mode;
    if (m === 'team' || m === 'brand' || m === 'default' || m === 'game') {
      state.colorMode = m;
      state.useBrandColors = (m === 'brand');   // keep the legacy flag in sync
      saveAppState();
      broadcastFullState();
    }
  },

  set_scene_bg(msg, ws) {
    const { path, bg } = msg.data || {};
    if (typeof path === 'string' && path) {
      if (!state.sceneBg) state.sceneBg = {};
      const cleanPath = path.split('?')[0];   // strip ?timer=1 etc — overlays key by pathname
      if (bg && bg.on) {
        state.sceneBg[cleanPath] = { on: true, color: (bg.color || '#000000').slice(0, 20), op: Math.max(1, Math.min(100, Number(bg.op) || 50)) };
      } else {
        // Store explicit off so overlays can remove a URL-param bg; undefined means untouched.
        state.sceneBg[cleanPath] = { on: false };
      }
      saveAppState();
      broadcastFullState();
    }
  },

  // Legacy: old clients sent a brand-colours on/off toggle → map it onto colorMode.
  delete_brand_kit(msg, ws) {
    ctx.savedBrandKits = ctx.savedBrandKits.filter((b) => b.id !== msg.data?.id);
    if (state.activeBrandKitId === msg.data?.id) { state.activeBrandKitId = null; saveAppState(); }
    saveBrandKits();
    broadcastFullState();
  },

  // (set_ticker migrated to the WS_HANDLERS registry above handleControlMessage)
  set_background(msg, ws) {
    const bg = msg.data || {};
    if (['solid', 'gradient', 'image'].includes(bg.type)) state.background.type = bg.type;
    if (typeof bg.color1 === 'string') state.background.color1 = bg.color1.slice(0, 20);
    if (typeof bg.color2 === 'string') state.background.color2 = bg.color2.slice(0, 20);
    if (typeof bg.angle === 'number') state.background.angle = Math.max(0, Math.min(360, bg.angle));
    if (typeof bg.imageUrl === 'string') state.background.imageUrl = bg.imageUrl.slice(0, 2000);
    saveAppState();
    broadcastFullState();
  },
};

module.exports = function createBrandHandlers(c) {
  ctx = c;
  ({
    GAMES, PACKAGE_FIELDS, activateBrandKitById, activePackage, applyBrandSlots,
    applyKitStyles, applyPackageSnapshot, applyPreset, brandId, broadcastFullState,
    capturePackageSnapshot, capturePreset, dialog, ensureKitPackages, fsp, isValidTheme,
    migrateThemeId, sanitizePackage, saveAppState, saveBrandKits, savePresets,
    sendImportExportResult, state, syncActivePreshowTopics
  } = c);
  return handlers;
};
