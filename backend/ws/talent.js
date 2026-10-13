'use strict';
// Talent: casters, crew, roster, stations, shifts, cameras and VDO.Ninja — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly; values server.js reassigns are
// read and written through ctx (savedFacecams, savedTeams).
let
  VDO_CRED_STRIP, broadcastFullState, buildCasterJoinUrlFromVdo, buildCasterObsUrl,
  buildCasterObsUrlFromVdo, buildListenInUrl, buildObsViewUrl, buildPlayerInterviewViewUrl,
  buildRoomListenInUrl, cleanFacecamId, clearDeskSlots, crewGamertagFor, dedupeSupport,
  deskLineupPeople, deskSlotNames, effectiveTeamColors, ensureCasterVdo, ensureGuestsVdo,
  ensureInterviewVdo, ensureObserversVdo, ensureRoomVdo, ensureTeamVdo, findTeamPlayer,
  obsSwitch, playerStreamId, resolveLineupToList, sanitizeVdoAudio, saveAppState, saveFacecams,
  saveTeams, seatDeskSlots, state, stationAutoSync, suppressAutoFill, syncCrewRosterToCloud,
  unsuppressAutoFill, vdoBase, vdoRandom, vdoSlug, wsSend;
let ctx;

const handlers = {
  // ── Casters / commentator lower-thirds ───────────────────────────────
  set_casters(msg, ws) {
    const VALID_SOCIAL = new Set(['none', 'x', 'twitch', 'youtube', 'instagram', 'tiktok', 'discord', 'facebook', 'kick', 'other']);
    // Only a message that CARRIES a list replaces the on-air casters. The desk footer's Apply sends
    // just the lower third; it used to rebuild the list from a hidden legacy form and wipe the desk.
    const hasList = Array.isArray(msg.data?.list);
    const list = hasList ? msg.data.list : [];
    if (hasList) state.casters.list = list.slice(0, 4).map((c, idx) => {
      const slot = Number(c.slot);
      const social = (c.social || 'none').toString().toLowerCase();
      const vol = Number(c.volume);
      return {
        id: c.id || Math.random().toString(36).slice(2, 11),
        name: (c.name || '').toString().slice(0, 40),
        handle: (c.handle || '').toString().slice(0, 80),
        gamertag: crewGamertagFor(c),        // desk display name (crew Handle/Gamertag field)
        socialHandle: (c.socialHandle || c.handle || '').toString().slice(0, 80),
        camUrl: (c.camUrl || '').toString().slice(0, 1000),
        // VDO building blocks (so the control panel can re-show + rebuild the clean view URL).
        streamId: (c.streamId || '').toString().slice(0, 120),
        room: (c.room || '').toString().slice(0, 120),
        volume: Number.isFinite(vol) ? Math.max(0, Math.min(100, Math.round(vol))) : 100,
        audio: sanitizeVdoAudio(c.audio),
        slot: slot >= 1 && slot <= 4 ? slot : idx + 1,
        social: VALID_SOCIAL.has(social) ? social : 'none'
      };
    });
    if (typeof msg.data?.lowerThird === 'string') {
      state.casters.lowerThird = msg.data.lowerThird.slice(0, 120);
    }
    saveAppState();
    broadcastFullState();
  },

  set_casters_visibility(msg, ws) {
    state.casters.visible = !!msg.data.visible;
    saveAppState();
    broadcastFullState();
    obsSwitch(state.casters.visible ? 'casters' : 'inGame');
  },

  set_casters_show_country(msg, ws) {
    state.casters.showCountry = !!msg.data?.showCountry;
    saveAppState();
    broadcastFullState();
  },

  // ── Show Deck shifts: save the whole allocation (slots + roles + on-shift marks) as a
  // named preset, apply one at handoff, or clear everything between shifts. ──
  save_shift(msg, ws) {
    const name = ((msg.data && msg.data.name) || '').toString().trim().slice(0, 40);
    if (!name) return;
    if (!Array.isArray(state.casters.shifts)) state.casters.shifts = [];
    const lib = state.casters.library || [];
    const slotName = (n) => {
      const e = (state.casters.lineup || []).find((x) => Number(x.slot) === n);
      const p = e && lib.find((l) => l.id === e.libraryId);
      return (p && p.name) || '';
    };
    const snapshot = {
      id: Math.random().toString(36).slice(2, 11),
      name,
      // Tag with whatever event is live right now (if any) so the credits screen can pull
      // "everyone scheduled for event X" by filtering saved shifts on this field.
      eventSlug: (state.activeEvent && state.activeEvent.slug) || '',
      eventName: (state.activeEvent && state.activeEvent.name) || '',
      slots: { 1: slotName(1), 2: slotName(2), 3: slotName(3), 4: slotName(4) },
      host: (state.casters.showRoles && state.casters.showRoles.host) || '',
      observer: (state.casters.showRoles && state.casters.showRoles.observer) || '',
      // Who is on the desk RIGHT NOW — read off the desk itself, not crew.active. That flag is
      // set from several places (station check-ins, library pull-ins) and cleared from almost
      // none, so snapshotting it baked people who had never taken a slot into the preset, and
      // applying the preset then re-marked them on shift.
      active: deskLineupPeople().map((p) => p.name),
      // Display options ride the shift too — a shift is the whole desk setup.
      showCountry: !!state.casters.showCountry,
      nameMode: state.casters.nameMode === 'name' ? 'name' : 'gamertag'
    };
    // Same name overwrites — re-saving a shift updates it instead of stacking duplicates.
    const existing = state.casters.shifts.findIndex((s) => (s.name || '').toLowerCase() === name.toLowerCase());
    if (existing >= 0) { snapshot.id = state.casters.shifts[existing].id; state.casters.shifts[existing] = snapshot; }
    else state.casters.shifts.push(snapshot);
    saveAppState();
    broadcastFullState();
  },

  apply_shift(msg, ws) {
    const shift = (state.casters.shifts || []).find((s) => s.id === (msg.data && msg.data.id));
    if (!shift) return;
    // Slots: rebuild the desk lineup for slots 1-4 from the shift's names (library entry
    // found by name, created from the crew twin when missing — same join rule as elsewhere).
    if (!Array.isArray(state.casters.library)) state.casters.library = [];
    const lib = state.casters.library;
    const findOrCreate = (nm) => {
      const k = nm.toLowerCase();
      let e = lib.find((l) => l && (l.name || '').toLowerCase() === k);
      if (e) return e;
      const crew = (state.crew || []).find((c) => c && (c.name || '').toLowerCase() === k) || {};
      e = { id: Math.random().toString(36).slice(2, 11), name: nm, handle: crew.socialHandle || '', socialHandle: crew.socialHandle || '', social: crew.social || 'none', country: crew.country || '', camUrl: '', kind: 'caster' };
      lib.push(e);
      return e;
    };
    const lineup = (state.casters.lineup || []).filter((e) => !(Number(e.slot) >= 1 && Number(e.slot) <= 4));
    [1, 2, 3, 4].forEach((n) => {
      const nm = (shift.slots && shift.slots[n] || '').toString().trim();
      if (!nm) return;
      lineup.push({ libraryId: findOrCreate(nm).id, slot: n });
    });
    state.casters.lineup = lineup;
    state.casters.showRoles = { host: shift.host || '', observer: shift.observer || '' };
    const activeSet = new Set((shift.active || []).map((n) => (n || '').toLowerCase()));
    (state.crew || []).forEach((c) => {
      if (!c) return;
      c.active = activeSet.has((c.name || '').toLowerCase());
      if (c.active) c.workedEvent = true;   // same rule as update_crew_member: going active always marks worked
    });
    state.casters.activeShiftId = shift.id;   // so the Show Deck can show which preset is currently loaded
    // Display options saved with the shift (older snapshots without them leave settings alone).
    if (typeof shift.showCountry === 'boolean') state.casters.showCountry = shift.showCountry;
    if (shift.nameMode === 'name' || shift.nameMode === 'gamertag') state.casters.nameMode = shift.nameMode;
    resolveLineupToList();
    saveAppState();
    broadcastFullState();
  },

  // ── Shift handover ────────────────────────────────────────────────────────
  // "Next shift": the crew currently on the desk have finished their stint, so they move to the
  // Off-Air Event Staff list (which is what feeds the credits screen) and the desk empties ready
  // for the incoming lineup. If a saved preset follows the loaded one it's seated automatically;
  // otherwise the desk is left blank to fill in by hand.
  shift_handover(msg, ws) {
    const people = deskLineupPeople();
    const crewByName = new Map();
    (state.crew || []).forEach((c) => { if (c && c.name) crewByName.set(c.name.trim().toLowerCase(), c); });
    if (!Array.isArray(state.casters.support)) state.casters.support = [];

    const moved = [];
    const uncredited = [];
    people.forEach((p) => {
      const c = crewByName.get(p.name.toLowerCase());
      // No crew record = nobody to credit. Reported back rather than silently dropped, because
      // "my caster vanished off the credits" is exactly the bug that would cause.
      if (!c) { uncredited.push(p.name); return; }
      const cur = state.casters.support.find((s) => s && s.crewId === c.id);
      if (cur) { if (p.role) cur.role = p.role; }
      else state.casters.support.push({ crewId: c.id, role: p.role });
      c.workedEvent = true;
      c.active = false;              // off the live desk now
      moved.push({ id: c.id, name: c.name });
    });
    dedupeSupport();

    // Remember the outgoing desk so "Prev shift" can put it back, including exactly who this
    // handover credited (so undoing removes those and only those).
    if (!Array.isArray(state.casters.shiftHistory)) state.casters.shiftHistory = [];
    const slots = deskSlotNames();
    const roles = state.casters.showRoles || {};
    if (people.length) {
      state.casters.shiftHistory.push({
        slots,
        host: roles.host || '',
        observer: roles.observer || '',
        movedCrewIds: moved.map((m) => m.id),
        shiftId: state.casters.activeShiftId || ''
      });
      if (state.casters.shiftHistory.length > 10) state.casters.shiftHistory.shift();
    }

    const prevShiftId = state.casters.activeShiftId || '';
    clearDeskSlots();

    // Seat the NEXT saved preset if there is one after the currently-loaded chip.
    const shifts = state.casters.shifts || [];
    let seated = '';
    if (shifts.length) {
      const cur = shifts.findIndex((s) => s.id === prevShiftId);
      const next = shifts[cur === -1 ? 0 : cur + 1];
      if (next) {
        seatDeskSlots(next.slots, next.host, next.observer);
        state.casters.activeShiftId = next.id;
        seated = next.name || '';
      }
    }
    saveAppState();
    broadcastFullState();
    try {
      ws.send(JSON.stringify({ type: 'shift-result', data: {
        ok: true, moved: moved.map((m) => m.name), uncredited, seated
      } }));
    } catch (e) {}
  },

  // "Prev shift": undo the last handover — the outgoing crew go back on the desk and come OFF
  // the off-air staff list, because they're on camera again (the list is explicitly for people
  // who aren't). Only the ids that handover added are removed, so anyone added by hand stays.
  shift_restore(msg, ws) {
    const hist = Array.isArray(state.casters.shiftHistory) ? state.casters.shiftHistory : [];
    const last = hist.pop();
    if (!last) {
      try { ws.send(JSON.stringify({ type: 'shift-result', data: { ok: false, message: 'No previous shift to go back to.' } })); } catch (e) {}
      return;
    }
    seatDeskSlots(last.slots, last.host, last.observer);
    if (last.shiftId) state.casters.activeShiftId = last.shiftId;
    const back = new Set(last.movedCrewIds || []);
    if (Array.isArray(state.casters.support)) {
      state.casters.support = state.casters.support.filter((s) => !(s && back.has(s.crewId)));
    }
    (state.crew || []).forEach((c) => { if (c && back.has(c.id)) c.active = true; });
    dedupeSupport();
    saveAppState();
    broadcastFullState();
    try {
      ws.send(JSON.stringify({ type: 'shift-result', data: { ok: true, restored: true } }));
    } catch (e) {}
  },

  delete_shift(msg, ws) {
    if (Array.isArray(state.casters.shifts)) {
      const id = msg.data && msg.data.id;
      state.casters.shifts = state.casters.shifts.filter((s) => s.id !== id);
      if (state.casters.activeShiftId === id) state.casters.activeShiftId = '';
      saveAppState();
      broadcastFullState();
    }
  },

  clear_shift(msg, ws) {
    state.casters.lineup = (state.casters.lineup || []).filter((e) => !(Number(e.slot) >= 1 && Number(e.slot) <= 4));
    state.casters.list = [];
    state.casters.showRoles = { host: '', observer: '' };
    state.casters.activeShiftId = '';
    state.casters.support = [];
    state.casters.shiftHistory = [];   // fresh show — nothing to hand back to
    (state.crew || []).forEach((c) => { if (c) { c.active = false; c.workedEvent = false; } });
    saveAppState();
    broadcastFullState();
  },

  // Show Deck support column — EVENT-scoped assignments [{crewId, role}]. Deliberately does NOT
  // touch crew.group: the deck is per-show, the crew record's group is their durable category on
  // the Crew page. Adding credits them (workedEvent); removing only takes the chip off the deck.
  td_support_add(msg, ws) {
    const d = msg.data || {};
    const c = (state.crew || []).find((x) => x && x.id === d.crewId);
    if (!c) return;
    if (!Array.isArray(state.casters.support)) state.casters.support = [];
    const role = String(d.role || '').slice(0, 40);
    const cur = state.casters.support.find((s) => s && s.crewId === c.id);
    if (cur) { if (role) cur.role = role; }
    else state.casters.support.push({ crewId: c.id, role });
    c.workedEvent = true;
    dedupeSupport();   // also collapses same-name twins the crewId check can't see
    saveAppState();
    broadcastFullState();
  },

  td_support_remove(msg, ws) {
    if (Array.isArray(state.casters.support)) {
      state.casters.support = state.casters.support.filter((s) => s && s.crewId !== (msg.data && msg.data.crewId));
      saveAppState();
      broadcastFullState();
    }
  },

  // Website station check-ins → desk auto-fill toggle (see stationAutoSync).
  set_station_autofill(msg, ws) {
    state.casters.autoFillFromStations = !!(msg.data && msg.data.on);
    saveAppState();
    broadcastFullState();
    if (state.casters.autoFillFromStations) stationAutoSync();
  },

  // "Re-sync desk to live feeds" — talent rotated and the desk shows a stale person on a reused web
  // slot. Force a station sync that re-identifies EVERY slot (manual entries included) to who's live.
  // stationAutoSync broadcastFullState()s itself when it changes anything.
  resync_stations(msg, ws) {
    stationAutoSync({ force: true }).catch(() => {});
  },

  // Bind THIS app to one website station ('' = all) — see stationAutoSync.
  set_station_binding(msg, ws) {
    state.casters.stationId = typeof (msg.data && msg.data.stationId) === 'string' ? msg.data.stationId : '';
    saveAppState();
    broadcastFullState();
    stationAutoSync();
  },

  // Show Deck host/observer allocation (crew member names) — casters get desk-lineup slots
  // via save_caster_to_library's deskSlot instead.
  set_show_roles(msg, ws) {
    const d = msg.data || {};
    if (!state.casters.showRoles) state.casters.showRoles = { host: '', observer: '' };
    // Same "current shift IS the lineup" auto-linkage as caster desk slots (see
    // save_caster_to_library's deskSlot handling) — a host/observer had no equivalent before,
    // so they'd never get auto-credited without someone manually adding them elsewhere.
    const findCrew = (nameOrHandle) => {
      const q = (nameOrHandle || '').trim().toLowerCase();
      if (!q || !Array.isArray(state.crew)) return null;
      return state.crew.find((c) => c && ((c.name || '').toLowerCase() === q || (c.handle || '').toLowerCase() === q)) || null;
    };
    if (typeof d.host === 'string') {
      const nextHost = d.host.slice(0, 60);
      if (nextHost !== state.casters.showRoles.host) {
        const prev = findCrew(state.casters.showRoles.host); if (prev) prev.active = false;
        const next = findCrew(nextHost); if (next) { next.active = true; next.workedEvent = true; }
        state.casters.showRoles.host = nextHost;
      }
    }
    if (typeof d.observer === 'string') {
      const nextObs = d.observer.slice(0, 60);
      if (nextObs !== state.casters.showRoles.observer) {
        const prev = findCrew(state.casters.showRoles.observer); if (prev) prev.active = false;
        const next = findCrew(nextObs); if (next) { next.active = true; next.workedEvent = true; }
        state.casters.showRoles.observer = nextObs;
      }
    }
    saveAppState();
    broadcastFullState();
  },

  // Which name the desk overlays display for each caster: their gamertag/handle (default)
  // or the crew profile's real name.
  set_casters_name_mode(msg, ws) {
    state.casters.nameMode = (msg.data && msg.data.mode) === 'name' ? 'name' : 'gamertag';
    saveAppState();
    broadcastFullState();
  },

  // Saved-caster library — reusable people you can load into any slot.
  save_caster_to_library(msg, ws) {
    const VALID_SOCIAL = new Set(['none', 'x', 'twitch', 'youtube', 'instagram', 'tiktok', 'discord', 'facebook', 'kick', 'other']);
    const d = msg.data || {};
    if (!Array.isArray(state.casters.library)) state.casters.library = [];
    const social = (d.social || 'none').toString().toLowerCase();
    const libSlot = Number(d.slot);
    const entry = {
      id: d.id || Math.random().toString(36).slice(2, 11),
      name: (d.name || '').toString().slice(0, 40),
      handle: (d.handle || '').toString().slice(0, 80),
      role: (d.role || '').toString().slice(0, 40),
      camUrl: (d.camUrl || '').toString().slice(0, 1000),
      ...(typeof d.vdoOverride === 'string' ? { vdoOverride: d.vdoOverride.slice(0, 1000) } : {}),
      social: VALID_SOCIAL.has(social) ? social : 'none',
      ...(typeof d.camSlot  === 'string' ? { camSlot:  d.camSlot.slice(0, 40) } : {}),
      ...(typeof d.country  === 'string' ? { country:  d.country.slice(0, 60) } : {}),
      ...(typeof d.socialHandle === 'string' ? { socialHandle: d.socialHandle.slice(0, 80) } : {}),
      ...(typeof d.notes    === 'string' ? { notes:    d.notes.slice(0, 500) } : {}),
      ...(['host', 'caster', 'observer'].includes(d.kind) ? { kind: d.kind } : {}),
      ...(typeof d.slot !== 'undefined' ? { slot: (libSlot >= 1 && libSlot <= 4) ? libSlot : 0 } : {})
    };
    // An id-only update (e.g. moving a lobby guest into Casters with {id, kind}) edits an existing
    // entry, so it carries no name — only reject empty messages that would CREATE a blank entry.
    const knownId = !!(d.id && state.casters.library.some(c => c.id === d.id));
    if (!knownId && !entry.name && !entry.handle && !entry.camUrl) return;
    // Backfill IDs for any legacy entries that were saved before id was added
    state.casters.library.forEach(c => { if (!c.id) c.id = Math.random().toString(36).slice(2, 11); });
    // When editing (d.id provided), match only by id. When creating, prevent duplicates by name/handle.
    let idx;
    if (d.id) {
      idx = state.casters.library.findIndex(c => c.id === d.id);
    } else {
      idx = state.casters.library.findIndex(c =>
        (entry.handle && c.handle && c.handle.toLowerCase() === entry.handle.toLowerCase()) ||
        (entry.name && c.name && c.name.toLowerCase() === entry.name.toLowerCase())
      );
    }
    if (idx >= 0) {
      // Partial update: only overwrite the fields actually present in the message, so editing
      // (e.g. just @handle from a group card) never wipes name / camUrl / kind / etc.
      const cur = state.casters.library[idx];
      if (typeof d.name    === 'string') cur.name    = entry.name;
      if (typeof d.handle  === 'string') cur.handle  = entry.handle;
      if (typeof d.role    === 'string') cur.role    = entry.role;
      if (typeof d.camUrl  === 'string') cur.camUrl  = entry.camUrl;
      if (typeof d.vdoOverride === 'string') cur.vdoOverride = d.vdoOverride.slice(0, 1000);
      if (typeof d.camSlot === 'string') cur.camSlot = d.camSlot.slice(0, 40);
      if (typeof d.country === 'string') cur.country = d.country.slice(0, 60);
      if (typeof d.socialHandle === 'string') cur.socialHandle = d.socialHandle.slice(0, 80);
      if (typeof d.notes   === 'string') cur.notes   = d.notes.slice(0, 500);
      if (typeof d.social  === 'string') cur.social  = entry.social;
      if (['host', 'caster', 'observer'].includes(d.kind)) cur.kind = d.kind;
      if (typeof d.slot !== 'undefined') cur.slot = (libSlot >= 1 && libSlot <= 4) ? libSlot : 0;
    } else {
      state.casters.library.push(entry);
    }
    // Optional: assign/clear this caster's desk-lineup slot in the SAME call (used by the crew page
    // so producers can put a caster on-air without opening the Casters lineup UI). We know the final
    // library id here, so no client-side lookup is needed. Mirrors the swap/bump logic the Casters
    // page uses: taking an occupied slot bumps its current occupant to this caster's old slot (or off).
    if (typeof d.deskSlot !== 'undefined') {
      const libId = (idx >= 0) ? state.casters.library[idx].id : entry.id;
      const slot = Math.max(0, Math.min(4, parseInt(d.deskSlot, 10) || 0));
      if (!Array.isArray(state.casters.lineup)) state.casters.lineup = [];
      let lineup = state.casters.lineup;
      let bumpedOffLibId = null;   // fully removed from the desk this call (not just moved slots)
      if (slot === 0) {
        state.casters.lineup = lineup.filter((x) => x.libraryId !== libId);
        bumpedOffLibId = libId;
      } else {
        const occ = lineup.find((x) => Number(x.slot) === slot && x.libraryId !== libId);
        const mine = lineup.find((x) => x.libraryId === libId);
        const oldSlot = mine ? Number(mine.slot) : 0;
        if (mine) mine.slot = slot;
        else lineup.push({ libraryId: libId, slot, roomId: '', streamId: libId });
        if (occ) {
          if (oldSlot) occ.slot = oldSlot;
          else { state.casters.lineup = lineup.filter((x) => x !== occ); bumpedOffLibId = occ.libraryId; }
        }
      }
      if (!state.casters.lineup.length) state.casters.list = [];   // resolveLineupToList no-ops on empty
      // "Current shift" IS the desk lineup — no separate manual on-shift toggle. A caster placed
      // on the desk (slot 1-4) is clearly working this event, so mark the matching crew record
      // active + worked so credits pick them up without a second click. Taking someone off the
      // desk (explicit pull-off, or bumped out by a swap with nowhere to fall back to) rolls them
      // off-shift too — but workedEvent is left alone so earlier-shift crew stay credited.
      if (slot >= 1 && Array.isArray(state.crew)) {
        const nm = (d.name || '').toLowerCase(), hd = (d.handle || '').toLowerCase();
        const cm = state.crew.find((c) => c && (((c.name || '').toLowerCase() === nm && nm) || (hd && (c.handle || '').toLowerCase() === hd)));
        if (cm) { cm.active = true; cm.workedEvent = true; }
      }
      if (bumpedOffLibId && Array.isArray(state.crew)) {
        const offEntry = state.casters.library.find((c) => c.id === bumpedOffLibId);
        if (offEntry) {
          const nm = (offEntry.name || '').toLowerCase(), hd = (offEntry.handle || '').toLowerCase();
          const cm = state.crew.find((c) => c && (((c.name || '').toLowerCase() === nm && nm) || (hd && (c.handle || '').toLowerCase() === hd)));
          if (cm) cm.active = false;
        }
      }
      // Keep the producer's intent against the 20s stationAutoSync: pulling someone off the desk
      // (slot 0, or bumped out with nowhere to land) suppresses auto-refill; placing them on a
      // slot clears it. This is the fix for "deleted casters keep reappearing / a phantom second
      // caster is forced back on".
      if (slot === 0) suppressAutoFill(libId);
      else unsuppressAutoFill(libId);
      if (bumpedOffLibId && bumpedOffLibId !== libId) suppressAutoFill(bumpedOffLibId);
    }
    resolveLineupToList();   // re-join so name/handle/social edits propagate to overlay immediately
    saveAppState();
    broadcastFullState();
  },

  delete_caster_from_library(msg, ws) {
    if (Array.isArray(state.casters.library)) {
      const deadId = msg.data?.id;
      suppressAutoFill(deadId);   // capture the name BEFORE the entry's gone, so auto-fill won't re-add it
      state.casters.library = state.casters.library.filter((c) => c.id !== deadId);
      // Purge the desk-lineup ref too — a lineup entry pointing at a deleted library id was
      // a GHOST: it rendered an empty nameless slot with a dead room URL and permanently
      // blocked that slot against station auto-fill.
      if (Array.isArray(state.casters.lineup)) {
        state.casters.lineup = state.casters.lineup.filter((l) => !l || l.libraryId !== deadId);
      }
      if ((state.casters.lineup || []).length) resolveLineupToList();
      else state.casters.list = [];
      saveAppState();
      broadcastFullState();
    }
  },

  set_library_cam_slot(msg, ws) {
    const d = msg.data || {};
    if (!d.id || !Array.isArray(state.casters.library)) return;
    const entry = state.casters.library.find((c) => c.id === d.id);
    if (entry) { entry.camSlot = String(d.camSlot || '').slice(0, 40); saveAppState(); broadcastFullState(); }
  },

  // ── Crew profiles (unified host/guest/caster/observer database) ──
  add_crew_member(msg, ws) {
    const d = msg.data || {};
    if (!d.name) return;
    if (!Array.isArray(state.crew)) state.crew = [];
    const id = Math.random().toString(36).slice(2, 11);
    // workedEvent: broader than active (on shift RIGHT NOW) — sticks once true so credits can
    // still find someone whose shift already ended, without having to keep them "active."
    state.crew.push({ id, name: d.name, handle: d.handle || '', role: d.role || '', group: d.group || 'casters', social: d.social || 'none', socialHandle: d.socialHandle || '', defaultCam: d.defaultCam || '', country: d.country || '', paypal: d.paypal || '', notes: d.notes || '', active: !!d.active, workedEvent: !!d.active });
    saveAppState();
    syncCrewRosterToCloud();
    broadcastFullState();
  },

  update_crew_member(msg, ws) {
    const d = msg.data || {};
    if (!d.id || !Array.isArray(state.crew)) return;
    const idx = state.crew.findIndex((c) => c.id === d.id);
    if (idx !== -1) {
      const cur = state.crew[idx];
      const nextActive = (typeof d.active === 'boolean') ? d.active : !!cur.active;
      // Going active always marks workedEvent (they're clearly working this event); going
      // inactive does NOT clear it — that's the whole point, so off-shift crew who worked
      // earlier stay creditable. An explicit d.workedEvent (the Show Deck's manual toggle) wins.
      const nextWorked = (typeof d.workedEvent === 'boolean') ? d.workedEvent : (nextActive || !!cur.workedEvent);
      // group: honour an EXPLICIT string (including '' — the "remove from Support Crew" signal),
      // otherwise keep the current group. `d.group || cur.group` swallowed '' and re-pinned them.
      state.crew[idx] = { ...cur, name: d.name || cur.name, handle: d.handle ?? cur.handle, role: d.role ?? cur.role, group: (typeof d.group === 'string') ? d.group : cur.group, social: d.social || cur.social, socialHandle: d.socialHandle ?? cur.socialHandle, defaultCam: d.defaultCam ?? cur.defaultCam ?? '', country: d.country ?? cur.country ?? '', paypal: d.paypal ?? cur.paypal ?? '', notes: d.notes ?? cur.notes ?? '', active: nextActive, workedEvent: nextWorked };
      // Crew ↔ caster-library ↔ on-air slots are twins linked by name/handle (see
      // delete_crew_member). Without this sync, editing a crew profile left STALE copies
      // in the library and on the desk — the overlay kept the old gamertag forever.
      const upd = state.crew[idx];
      const oldName = (cur.name || '').toLowerCase();
      const oldHandle = (cur.handle || '').toLowerCase();
      const matches = (e) => !!e && (((e.name || '').toLowerCase() === oldName && !!oldName)
        || (!!oldHandle && (e.handle || '').toLowerCase() === oldHandle));
      const syncEntry = (e) => {
        if (!matches(e)) return;
        e.name = upd.name;
        // Deliberately NOT e.handle: the caster-card UIs treat library `handle` as the
        // @social username, while the crew Handle/Gamertag feeds the desk display name
        // via crewGamertagFor() at resolve time — no field fight.
        if (upd.social) e.social = upd.social;
        if (upd.socialHandle !== undefined) e.socialHandle = upd.socialHandle;
        if (upd.country !== undefined) e.country = upd.country;
      };
      (state.casters.library || []).forEach(syncEntry);
      (state.casters.list || []).forEach(syncEntry);
      resolveLineupToList();   // rebuild the on-air slots from the refreshed library
      saveAppState();
      syncCrewRosterToCloud();
      broadcastFullState();
    }
  },

  delete_crew_member(msg, ws) {
    if (Array.isArray(state.crew)) {
      const member = state.crew.find((c) => c.id === msg.data?.id);
      state.crew = state.crew.filter((c) => c.id !== msg.data?.id);
      if (Array.isArray(state.casters.support)) {
        state.casters.support = state.casters.support.filter((s) => s && s.crewId !== msg.data?.id);
      }
      // Crew + caster-library are twins linked by name/handle: purge the library entry and
      // free any desk-lineup slot it held, or a "deleted" caster stays on the desk overlay.
      if (member && Array.isArray(state.casters.library)) {
        const nm = (member.name || '').toString().toLowerCase();
        const hd = (member.handle || '').toString().toLowerCase();
        const deadIds = new Set(state.casters.library
          .filter(c => (hd && c.handle && c.handle.toLowerCase() === hd) ||
                       (nm && c.name && c.name.toLowerCase() === nm))
          .map(c => c.id));
        if (deadIds.size) {
          state.casters.library = state.casters.library.filter(c => !deadIds.has(c.id));
          if (Array.isArray(state.casters.lineup)) {
            state.casters.lineup = state.casters.lineup.filter(e => !deadIds.has(e.libraryId));
          }
          if ((state.casters.lineup || []).length) resolveLineupToList();
          else if (Array.isArray(state.casters.list)) state.casters.list = state.casters.list.filter(c => !deadIds.has(c.id));
        }
      }
      saveAppState();
      syncCrewRosterToCloud();
      broadcastFullState();
    }
  },

  update_crew_order(msg, ws) {
    const ordered = msg.data?.crew;
    if (Array.isArray(ordered) && Array.isArray(state.crew) && state.crew.length) {
      const byId = new Map(state.crew.map((c) => [c && c.id, c]));
      const next = [];
      ordered.forEach((c) => { const m = c && byId.get(c.id); if (m) { next.push(m); byId.delete(c.id); } });
      byId.forEach((m) => next.push(m));
      state.crew = next;
      saveAppState();
      broadcastFullState();
    }
  },

  delete_all_crew(msg, ws) {
    state.crew = [];
    state.casters.support = [];
    saveAppState();
    syncCrewRosterToCloud();
    broadcastFullState();
  },

  // ── Show Roster: pre-show crew/player assignment + VDO generation ──────────
  add_to_roster(msg, ws) {
    const d = msg.data || {};
    if (!d.crewId || !d.groupKey) return;
    if (!Array.isArray(state.showRoster)) state.showRoster = [];
    if (state.showRoster.find((r) => r.crewId === d.crewId && r.groupKey === d.groupKey)) return;
    const member = (state.crew || []).find((c) => c.id === d.crewId);
    if (!member) return;
    state.showRoster.push({ crewId: d.crewId, groupKey: d.groupKey, camSlot: member.defaultCam || '', streamId: '', joinUrl: '', viewUrl: '' });
    saveAppState(); broadcastFullState();
  },

  remove_from_roster(msg, ws) {
    const d = msg.data || {};
    if (!Array.isArray(state.showRoster)) return;
    state.showRoster = state.showRoster.filter((r) => !(r.crewId === d.crewId && r.groupKey === d.groupKey));
    saveAppState(); broadcastFullState();
  },

  update_roster_entry(msg, ws) {
    const d = msg.data || {};
    if (!Array.isArray(state.showRoster)) return;
    const entry = state.showRoster.find((r) => r.crewId === d.crewId && r.groupKey === d.groupKey);
    if (entry && d.camSlot !== undefined) entry.camSlot = String(d.camSlot).slice(0, 40);
    saveAppState(); broadcastFullState();
  },

  generate_roster_vdo(msg, ws) {
    const d = msg.data || {};
    if (!Array.isArray(state.showRoster)) return;
    const entry = state.showRoster.find((r) => r.crewId === d.crewId && r.groupKey === d.groupKey);
    if (!entry) return;
    const member = (state.crew || []).find((c) => c.id === entry.crewId) || {};
    const gk = d.groupKey;
    let grm;
    if (gk === 'casters')             grm = ensureCasterVdo();
    else if (gk === 'hosts' || gk === 'guests') grm = ensureGuestsVdo();
    else if (gk === 'observers')      grm = ensureObserversVdo();
    else                              grm = { room: 'ne' + vdoRandom(9), password: vdoRandom(12) };
    const streamId = vdoSlug(member.handle || member.name || entry.crewId);
    const lang = state.vdo?.lang || 'en-US';
    entry.streamId = streamId; entry.vdoRoom = grm.room; entry.vdoPassword = grm.password;
    entry.joinUrl = `${vdoBase()}/?room=${grm.room}&push=${streamId}&transcribe=${lang}&webcam#p=${grm.password}`;
    entry.viewUrl = `${vdoBase()}/?room=${grm.room}&view=${streamId}&solo#p=${grm.password}`;
    saveAppState(); broadcastFullState();
  },

  generate_all_roster_vdo(msg, ws) {
    const d = msg.data || {};
    if (!Array.isArray(state.showRoster)) return;
    const gk = d.groupKey;
    let grm;
    if (gk === 'casters')             grm = ensureCasterVdo();
    else if (gk === 'hosts' || gk === 'guests') grm = ensureGuestsVdo();
    else if (gk === 'observers')      grm = ensureObserversVdo();
    else                              grm = { room: 'ne' + vdoRandom(9), password: vdoRandom(12) };
    const lang = state.vdo?.lang || 'en-US';
    state.showRoster.filter((r) => r.groupKey === gk && !r.joinUrl).forEach((entry) => {
      const member = (state.crew || []).find((c) => c.id === entry.crewId) || {};
      const streamId = vdoSlug(member.handle || member.name || entry.crewId);
      entry.streamId = streamId; entry.vdoRoom = grm.room; entry.vdoPassword = grm.password;
      entry.joinUrl = `${vdoBase()}/?room=${grm.room}&push=${streamId}&transcribe=${lang}&webcam#p=${grm.password}`;
      entry.viewUrl = `${vdoBase()}/?room=${grm.room}&view=${streamId}&solo#p=${grm.password}`;
    });
    saveAppState(); broadcastFullState();
  },

  clear_roster(msg, ws) {
    const d = msg.data || {};
    if (!Array.isArray(state.showRoster)) return;
    state.showRoster = d.groupKey ? state.showRoster.filter((r) => r.groupKey !== d.groupKey) : [];
    saveAppState(); broadcastFullState();
  },

  // Assign a human-readable camera label (e.g. "CAM1") to a team player for the DCC board
  set_player_cam_slot(msg, ws) {
    const d = msg.data || {};
    if (!d.side || !d.playerId) return;
    const team = state.teams && state.teams[d.side];
    if (!team) return;
    const player = findTeamPlayer(team, d.playerId);
    if (player) { player.camSlot = String(d.camSlot || '').slice(0, 40); saveAppState(); broadcastFullState(); }
  },

  set_roster_custom_url(msg, ws) {
    const d = msg.data || {};
    if (!Array.isArray(state.showRoster)) return;
    const entry = state.showRoster.find((r) => r.crewId === d.crewId && r.groupKey === d.groupKey);
    if (entry) { entry.customVdoUrl = String(d.customVdoUrl || '').slice(0, 512); saveAppState(); broadcastFullState(); }
  },

  // Per-member audio for a library person (caster/guest/observer) — baked into their group
  // room view URL by buildTalentGroup, and driven by the Director mixer.
  set_library_audio(msg, ws) {
    const d = msg.data || {};
    const e = (state.casters.library || []).find((c) => c.id === d.id);
    if (e) { e.audio = sanitizeVdoAudio(d.audio); saveAppState(); broadcastFullState(); }
  },

  // New room + password for a shared talent-group room (invalidates old links).
  regenerate_group_room(msg, ws) {
    const g = msg.data?.group;
    if (g === 'casters') ensureCasterVdo(true);
    else if (g === 'guests') ensureGuestsVdo(true);
    else if (g === 'observers') ensureObserversVdo(true);
    else if (g === 'interview') ensureInterviewVdo(true);
    else return;
    saveAppState();
    broadcastFullState();
  },

  // ── Nameless website events (siteEvent*) ──
  // A desk seat's camera links, on demand (they carry the room password, so they are never broadcast).
  // Same room + stream id the desk overlay views (resolveLineupToList), so the person lands on the desk.
  desk_cam_link(msg, ws) {
    const slot = Number(msg.data && msg.data.slot);
    const lineup = state.casters.lineup || [];
    const i = lineup.findIndex((e) => e && Number(e.slot) === slot && e.libraryId);
    const entry = i >= 0 ? lineup[i] : null;
    if (!entry) { wsSend(ws, 'desk-cam-link', { ok: false, slot, error: 'Nobody is in that seat.' }); return; }
    const prof = (state.casters.library || []).find((p) => p.id === entry.libraryId) || {};
    const room = (state.casters.rooms || []).find((r) => r.id === entry.roomId) || null;
    // No room yet (a fresh install): create the shared desk room now, so the button just works.
    let vdo = (room && room.vdo && room.vdo.room) ? room.vdo : ((state.casters.vdo && state.casters.vdo.room) ? state.casters.vdo : null);
    if (!vdo) { vdo = ensureCasterVdo(); resolveLineupToList(); saveAppState(); broadcastFullState(); }
    const fake = { streamId: entry.streamId || ('caster_' + (entry.slot || (i + 1))), handle: prof.handle, name: prof.name, camUrl: prof.camUrl, audio: entry.audio };
    wsSend(ws, 'desk-cam-link', { ok: true, slot, name: prof.name || '', joinUrl: buildCasterJoinUrlFromVdo(fake, vdo), viewUrl: buildCasterObsUrlFromVdo(fake, vdo) });
  },

  set_facecams_enabled(msg, ws) {
    state.facecamsEnabled = !!msg.data.enabled;
    saveAppState();
    broadcastFullState();
  },

  set_replay_cams(msg, ws) {
    state.replayCams = !!msg.data.enabled;
    saveAppState();
    broadcastFullState();
  },

  assign_camera_to_player(msg, ws) {
    const { side, playerId, cameraId } = msg.data || {};
    if (side && state.teams[side]) {
      const player = findTeamPlayer(state.teams[side], playerId);
      if (player) {
        player.assignedCamera = cameraId || null;
        saveAppState();
        broadcastFullState();
      }
    }
  },

  // ── VDO.Ninja talent workflow ────────────────────────────────────────
  set_vdo_config(msg, ws) {
    const d = msg.data || {};
    const v = state.vdo;
    if (typeof d.base === 'string' && d.base.trim()) v.base = d.base.trim().replace(/\/+$/, '');
    if (typeof d.lang === 'string' && d.lang) v.lang = d.lang;
    if (typeof d.cleanOutput === 'boolean') v.cleanOutput = d.cleanOutput;
    if (typeof d.transparent === 'boolean') v.transparent = d.transparent;
    if (typeof d.cover === 'boolean') v.cover = d.cover;
    if (d.volume !== undefined) v.volume = Math.max(0, Math.min(100, Math.round(+d.volume) || 0));
    if (typeof d.codec === 'string') v.codec = d.codec;
    if (typeof d.bitrate === 'string' || typeof d.bitrate === 'number') v.bitrate = String(d.bitrate);
    if (typeof d.buffer === 'string' || typeof d.buffer === 'number') v.buffer = String(d.buffer);
    if (typeof d.viewParams === 'string') v.viewParams = d.viewParams.slice(0, 300);
    if (typeof d.pushParams === 'string') v.pushParams = d.pushParams.slice(0, 300);
    if (typeof d.audioMono === 'boolean') v.audioMono = d.audioMono;
    if (typeof d.audioBitrate === 'string' || typeof d.audioBitrate === 'number') v.audioBitrate = String(d.audioBitrate);
    if (typeof d.audioParams === 'string') v.audioParams = d.audioParams.slice(0, 300);
    saveAppState();
    broadcastFullState();
  },

  // Auto-provision rooms/passwords for the active match teams (and stream IDs for players).
  generate_team_vdo(msg, ws) {
    const regen = !!msg.data?.regenerate;
    const sides = msg.data?.side ? [msg.data.side] : ['blue', 'orange'];
    for (const side of sides) {
      const team = state.teams[side];
      if (!team) continue;
      ensureTeamVdo(team, regen);
      if (Array.isArray(team.players)) {
        team.players.forEach((p) => { if (!p.vdoStreamId) p.vdoStreamId = playerStreamId(p); });
      }
      // Keep the library twin on the same room (set_team_vdo_creds already does); otherwise the
      // Team Library card kept handing out links to the room that was just replaced.
      if (regen && team.name && team.vdo) {
        const savedTwin = ctx.savedTeams.find((t) => t.name === team.name);
        if (savedTwin) { savedTwin.vdo = { ...team.vdo }; saveTeams(); }
      }
      // A regenerated room invalidates the old links — a listen-in feed still pointed at
      // the dead room would silently play nothing, so drop it and let the producer re-arm.
      if (regen && state.listenIn && state.listenIn.active && state.listenIn.side === side) {
        state.listenIn = { active: false, side: '', scope: '', name: '', url: '' };
      }
    }
    saveAppState();
    broadcastFullState();
  },

  // Override a player's stream ID (defaults to their sanitized gamertag).
  set_player_stream_id(msg, ws) {
    const { side, playerId, streamId } = msg.data || {};
    const player = findTeamPlayer(side && state.teams[side], playerId);
    if (player) {
      player.vdoStreamId = vdoSlug(streamId || '') || playerStreamId(player);
      saveAppState();
      broadcastFullState();
    }
  },

  // Provision a shared private VDO room for all casters + auto-assign stream IDs and rebuild camUrls.
  generate_caster_vdo(msg, ws) {
    const regen = !!msg.data?.regenerate;
    ensureCasterVdo(regen);
    if (Array.isArray(state.casters.list)) {
      state.casters.list.forEach((c, i) => {
        if (!c.streamId) c.streamId = vdoSlug(c.handle || c.name || `caster${i + 1}`);
        c.room = state.casters.vdo.room;
        c.camUrl = buildCasterObsUrl(c);
      });
    }
    saveAppState();
    broadcastFullState();
  },

  // Save (create or update) a named caster room.
  save_caster_room(msg, ws) {
    const d = msg.data || {};
    const name = (d.name || '').toString().slice(0, 60).trim();
    if (!name) return;
    if (!Array.isArray(state.casters.rooms)) state.casters.rooms = [];
    const id = (d.id || '').toString() || Math.random().toString(36).slice(2, 11);
    const idx = state.casters.rooms.findIndex(r => r.id === id);
    const existing = idx >= 0 ? state.casters.rooms[idx] : null;
    const room = { id, name, vdo: (existing && existing.vdo) || { room: '', password: '' } };
    if (idx >= 0) state.casters.rooms[idx] = room;
    else state.casters.rooms.push(room);
    // New rooms get credentials immediately (producers can still "Link existing" to override).
    if (!room.vdo.room) ensureRoomVdo(room);
    saveAppState();
    broadcastFullState();
  },

  delete_caster_room(msg, ws) {
    if (Array.isArray(state.casters.rooms)) {
      const rid = msg.data?.id;
      state.casters.rooms = state.casters.rooms.filter(r => r.id !== rid);
      if (Array.isArray(state.casters.lineup)) {
        state.casters.lineup.forEach(e => { if (e.roomId === rid) e.roomId = ''; });
      }
      resolveLineupToList();
      saveAppState();
      broadcastFullState();
    }
  },

  generate_caster_room_vdo(msg, ws) {
    if (!Array.isArray(state.casters.rooms)) return;
    const room = state.casters.rooms.find(r => r.id === msg.data?.id);
    if (!room) return;
    ensureRoomVdo(room, !!msg.data?.regenerate);
    resolveLineupToList();
    saveAppState();
    broadcastFullState();
  },

  // Plug an existing VDO room (name + password) into a MATCH TEAM or SAVED TEAM instead of
  // generating one — players' join/OBS links derive from team.vdo, so they follow instantly.
  set_team_vdo_creds(msg, ws) {
    const d = msg.data || {};
    const vroom = (d.room || '').toString().trim().replace(VDO_CRED_STRIP, '').slice(0, 100);
    const vpass = (d.password || '').toString().trim().replace(VDO_CRED_STRIP, '').slice(0, 100);
    if (!vroom) return;
    let team = null;
    if (d.side === 'blue' || d.side === 'orange') team = state.teams[d.side];
    else if (d.teamName) team = ctx.savedTeams.find(t => t.name === d.teamName);
    if (!team) return;
    team.vdo = { room: vroom, password: vpass };
    // Listen-in was playing the OLD room; stop it (as regenerating does) so it can't stay on a dead room.
    if ((d.side === 'blue' || d.side === 'orange') && state.listenIn && state.listenIn.active && state.listenIn.side === d.side) {
      state.listenIn = { active: false, side: '', scope: '', name: '', url: '' };
    }
    // Refresh the mirrored library-team room too when the match team is a saved team.
    if (d.side && team.name) {
      const savedTwin = ctx.savedTeams.find(t => t.name === team.name);
      if (savedTwin) savedTwin.vdo = { room: vroom, password: vpass };
    }
    if (d.teamName) saveTeams(); else saveAppState();
    broadcastFullState();
  },

  // Plug an existing VDO room into one of the shared talent group rooms
  // (casters = HOSTS desk, guests = LOBBY, observers = OBSERVERS).
  set_group_room_creds(msg, ws) {
    const d = msg.data || {};
    const vroom = (d.room || '').toString().trim().replace(VDO_CRED_STRIP, '').slice(0, 100);
    const vpass = (d.password || '').toString().trim().replace(VDO_CRED_STRIP, '').slice(0, 100);
    const key = d.group === 'guests' ? 'guestsVdo' : d.group === 'observers' ? 'observersVdo'
              : d.group === 'casters' ? 'vdo' : d.group === 'interview' ? 'interview' : null;
    if (!vroom || !key) return;
    state.casters[key] = { room: vroom, password: vpass };
    if (key === 'vdo') resolveLineupToList();   // caster room feeds the desk lineup URLs
    saveAppState();
    broadcastFullState();
  },

  // Plug in an existing VDO room (name + password) instead of generating new credentials.
  set_caster_room_creds(msg, ws) {
    if (!Array.isArray(state.casters.rooms)) return;
    const room = state.casters.rooms.find(r => r.id === msg.data?.id);
    if (!room) return;
    const vroom = (msg.data?.room || '').toString().trim().replace(VDO_CRED_STRIP, '').slice(0, 100);
    const vpass = (msg.data?.password || '').toString().trim().replace(VDO_CRED_STRIP, '').slice(0, 100);
    if (vroom && vpass) {
      room.vdo = { room: vroom, password: vpass };
      resolveLineupToList();
      saveAppState();
      broadcastFullState();
    }
  },

  // Designate which named room is the interview / desk room (where casters sit + interviews happen).
  set_desk_room(msg, ws) {
    const rid = (msg.data?.roomId || '').toString();
    if (!rid || (Array.isArray(state.casters.rooms) && state.casters.rooms.some(r => r.id === rid))) {
      state.casters.deskRoomId = rid;
      saveAppState();
      broadcastFullState();
    }
  },

  // Set this show's lineup — which library profiles are active, in which slots & rooms.
  set_caster_lineup(msg, ws) {
    const entries = Array.isArray(msg.data?.lineup) ? msg.data.lineup : [];
    // Casters removed by this edit get suppressed from stationAutoSync; casters still present
    // get un-suppressed — same "producer intent wins over the 20s auto-refill" rule as the Show Deck.
    const prevIds = new Set((state.casters.lineup || []).map((e) => e && e.libraryId).filter(Boolean));
    const nextIds = new Set(entries.map((e) => (e.libraryId || '').toString()).filter(Boolean));
    prevIds.forEach((id) => { if (!nextIds.has(id)) suppressAutoFill(id); });
    nextIds.forEach((id) => unsuppressAutoFill(id));
    state.casters.lineup = entries.slice(0, 6).map((e, i) => ({
      libraryId: (e.libraryId || '').toString(),
      slot: Number(e.slot) || (i + 1),
      roomId: (e.roomId || '').toString(),
      streamId: (e.streamId || '').toString().slice(0, 80),
      customCamUrl: (e.customCamUrl || '').toString().slice(0, 1000),
      audio: sanitizeVdoAudio(e.audio)
    }));
    resolveLineupToList();
    saveAppState();
    broadcastFullState();
  },

  set_slot_label(msg, ws) {
    const slot = parseInt(msg.data?.slot);
    const label = String(msg.data?.label || '').trim().slice(0, 30);
    if (slot >= 1 && slot <= 4) {
      if (!state.casters.slotLabels || typeof state.casters.slotLabels !== 'object') {
        state.casters.slotLabels = { 1: 'Caster 1', 2: 'Caster 2', 3: 'Caster 3', 4: 'Caster 4' };
      }
      state.casters.slotLabels[slot] = label || `Caster ${slot}`;
      saveAppState();
      broadcastFullState();
    }
  },

  // Interviewee → Player Spotlight Desk right cam. Stores the player's production-room solo feed
  // so spotlightdesk.html shows their live camera + audio in the right (featured) position.
  set_interviewee(msg, ws) {
    const side = (msg.data?.side || '').toString();
    const pid = msg.data?.playerId;
    const team = state.teams[side];
    if (!team) return;
    const player = (team.players || []).find((p) => p && (p.id === pid || String(p.id) === String(pid)));
    if (!player) return;
    const eff = effectiveTeamColors();
    state.casters.interviewee = {
      playerId: player.id, side, name: player.name || '', streamId: playerStreamId(player),
      teamName: team.name || '', color: (eff && eff[side]) || team.color || '',
      camUrl: buildPlayerInterviewViewUrl(player)
    };
    saveAppState();
    broadcastFullState();
  },

  clear_interviewee(msg, ws) {
    const pid = msg.data?.playerId;
    if (!pid || (state.casters.interviewee && String(state.casters.interviewee.playerId) === String(pid))) {
      state.casters.interviewee = null;
      saveAppState();
      broadcastFullState();
    }
  },

  // Track which caster overlay HTML is the active OBS source.
  set_caster_active_layout(msg, ws) {
    const VALID_LAYOUTS = new Set(['/casters.html','/singlecam.html','/duorow.html','/duorow-noscore.html','/triorow.html','/duosinglecam.html','/analystspecial.html','/campip.html','/talentbar.html','/interview.html','/quaddesk.html','/quaddesk-noscore.html','/matchup.html','/spotlightdesk.html','/vertical.html','/vertical-casters.html']);
    const path = (msg.data?.path || '').toString().slice(0, 100);
    state.casters.activeLayout = VALID_LAYOUTS.has(path) ? path : '';
    saveAppState();
    broadcastFullState();
  },

  // One-click: auto-create a room if needed, provision VDO for all rooms, auto-assign rooms to slots.
  generate_all_caster_links(msg, ws) {
    if (!Array.isArray(state.casters.lineup) || !state.casters.lineup.length) return;
    if (!Array.isArray(state.casters.rooms)) state.casters.rooms = [];
    if (!state.casters.rooms.length) {
      state.casters.rooms.push({ id: Math.random().toString(36).slice(2, 11), name: 'Main Desk', vdo: { room: '', password: '' } });
    }
    state.casters.rooms.forEach(room => ensureRoomVdo(room, false));
    const firstRoom = state.casters.rooms[0];
    state.casters.lineup.forEach((entry, i) => {
      entry.streamId = 'caster_' + (Number(entry.slot) || (i + 1));
      if (!entry.roomId && firstRoom) entry.roomId = firstRoom.id;
    });
    resolveLineupToList();
    saveAppState();
    broadcastFullState();
  },

  // Override stream ID for a player on a saved team (library, not active match).
  set_saved_team_player_stream_id(msg, ws) {
    const { teamName, playerId, streamId } = msg.data || {};
    const team = ctx.savedTeams.find(t => t.name === teamName);
    const player = findTeamPlayer(team, playerId);
    if (player) { player.vdoStreamId = vdoSlug(streamId || '') || ''; saveTeams(); }
  },

  // Per-player VDO audio override (volume / pan / mono / audio bitrate / extra params) for the
  // talent OBS feed. side = 'blue'|'orange' for a match player, or teamName for a saved-team player.
  set_player_audio(msg, ws) {
    const { side, playerId, teamName } = msg.data || {};
    const audio = sanitizeVdoAudio(msg.data?.audio);
    let player, persist;
    if (side === 'blue' || side === 'orange') {
      player = findTeamPlayer(state.teams[side], playerId);
      persist = saveAppState;
    } else if (teamName) {
      const team = ctx.savedTeams.find(t => t.name === teamName);
      player = findTeamPlayer(team, playerId);
      persist = saveTeams;
    }
    if (player) {
      if (audio) player.vdoAudio = audio; else delete player.vdoAudio;
      if (persist) persist();
      broadcastFullState();
    }
  },

  // Assign a player's VDO camera feed to a specific caster overlay slot.
  // Slots 1-4 = desk caster slots; slot 5 = the Player cam (Spotlight/Interview Desk),
  // kept in casters.playerCam so lineup rebuilds can't wipe it.
  assign_talent_cam(msg, ws) {
    const { side, playerId, teamName, slot } = msg.data || {};
    const slotNum = Number(slot);
    if (slotNum < 1 || slotNum > 5) return;
    let team, player;
    if (side === 'blue' || side === 'orange') {
      team = state.teams[side];
      player = findTeamPlayer(team, playerId);
    } else if (teamName) {
      team = ctx.savedTeams.find(t => t.name === teamName);
      player = findTeamPlayer(team, playerId);
    }
    if (!team || !player || !team.vdo?.room) return;
    const camUrl = buildObsViewUrl(team, player);
    if (!camUrl) return;
    if (slotNum === 5) {
      state.casters.playerCam = { camUrl, name: player.name || '', playerId: player.id || '', side: side || '', teamName: teamName || (team.name || '') };
      saveAppState();
      broadcastFullState();
      return;
    }
    if (!Array.isArray(state.casters.list)) state.casters.list = [];
    let entry = state.casters.list.find(c => Number(c.slot) === slotNum);
    if (!entry) {
      entry = { id: Math.random().toString(36).slice(2, 11), name: '', handle: '', camUrl: '', slot: slotNum, social: 'none', streamId: '', room: '', volume: 100 };
      state.casters.list.push(entry);
      state.casters.list.sort((a, b) => Number(a.slot) - Number(b.slot));
    }
    entry.camUrl = camUrl;
    saveAppState();
    broadcastFullState();
  },

  // Clear the slot-5 player cam.
  clear_player_cam(msg, ws) {
    state.casters.playerCam = null;
    saveAppState();
    broadcastFullState();
  },

  // Generate VDO rooms for saved teams in the library.
  // teamName = specific team; omit to provision all teams that don't have a room yet.
  generate_saved_team_vdo(msg, ws) {
    const { teamName, regenerate } = msg.data || {};
    if (teamName) {
      const team = ctx.savedTeams.find(t => t.name === teamName);
      if (team) ensureTeamVdo(team, !!regenerate);
    } else {
      ctx.savedTeams.forEach(t => { if (regenerate || !t.vdo || !t.vdo.room) ensureTeamVdo(t); });
    }
    saveTeams();
    broadcastFullState();
  },

  // Point the LISTEN IN overlay at a player (audio + live captions), or clear it.
  set_listen_in(msg, ws) {
    const { side, playerId, scope } = msg.data || {};
    const team = side && state.teams[side];
    if (!team) return;
    if (scope === 'room' || !playerId) {
      // Whole-team-room listen (primary): hear every connected player + their captions.
      state.listenIn = {
        active: true, side, scope: 'room',
        name: team.name || side.toUpperCase(),
        url: buildRoomListenInUrl(team)
      };
      saveAppState();
      broadcastFullState();
    } else {
      const player = findTeamPlayer(team, playerId);
      if (!player) {
        // Used to fall out of here doing nothing at all — no state change, no broadcast, no log,
        // so the producer clicked LISTEN and the app just sat there.
        console.warn(`[ListenIn] no player ${playerId} on ${side} (roster ids: ${(team.players || []).map((x) => x && x.id).join(', ') || 'none'})`);
        return;
      }
      state.listenIn = {
        active: true, side, scope: 'player', playerId: String(playerId),
        name: player.name || playerStreamId(player),
        url: buildListenInUrl(team, player)
      };
      saveAppState();
      broadcastFullState();
    }
  },

  clear_listen_in(msg, ws) {
    state.listenIn = { active: false, side: '', scope: '', name: '', url: '' };
    saveAppState();
    broadcastFullState();
  },

  set_listen_captions(msg, ws) {
    state.vdo.listenCaptions = !!(msg.data && msg.data.on);
    saveAppState();
    broadcastFullState();
  },

  save_facecam(msg, ws) {
    const { name, platform, platformId, link, nickname } = msg.data;
    const idx = ctx.savedFacecams.findIndex(fc => fc.name === name);
    // manuallySet marks this row as producer-touched — this WS message only ever fires from a
    // human editing the Facecams UI (cameraFacecamAutoSync mutates savedFacecams directly,
    // never through here), so it's a reliable signal regardless of what the link ends up being.
    // Needed because auto-sync's own "producer's mapping wins" check used to be a plain truthy
    // check on `link` — clearing the field to blank (the normal way to detach an unwanted
    // auto-mapping) looked identical to "never mapped," so the very next sync tick silently
    // reinstated the auto-fed link, undoing the producer's explicit removal within ~20s.
    // A placeholder id ("0" from a hidden RL account or a CS2 bot) is shared by many players;
    // storing it would hand all of them this cam. Name matching covers them instead.
    const entry = { name, platform, platformId: cleanFacecamId(platformId), link, nickname: nickname || name, manuallySet: true };
    if (idx >= 0) ctx.savedFacecams[idx] = entry;
    else ctx.savedFacecams.push(entry);
    saveFacecams();
    broadcastFullState();
  },

  delete_facecam(msg, ws) {
    ctx.savedFacecams = ctx.savedFacecams.filter(fc => fc.name !== msg.data.name);
    saveFacecams();
    broadcastFullState();
  },
};

module.exports = function createTalentHandlers(c) {
  ctx = c;
  ({
    VDO_CRED_STRIP, broadcastFullState, buildCasterJoinUrlFromVdo, buildCasterObsUrl,
    buildCasterObsUrlFromVdo, buildListenInUrl, buildObsViewUrl, buildPlayerInterviewViewUrl,
    buildRoomListenInUrl, cleanFacecamId, clearDeskSlots, crewGamertagFor, dedupeSupport,
    deskLineupPeople, deskSlotNames, effectiveTeamColors, ensureCasterVdo, ensureGuestsVdo,
    ensureInterviewVdo, ensureObserversVdo, ensureRoomVdo, ensureTeamVdo, findTeamPlayer,
    obsSwitch, playerStreamId, resolveLineupToList, sanitizeVdoAudio, saveAppState,
    saveFacecams, saveTeams, seatDeskSlots, state, stationAutoSync, suppressAutoFill,
    syncCrewRosterToCloud, unsuppressAutoFill, vdoBase, vdoRandom, vdoSlug, wsSend
  } = c);
  return handlers;
};
