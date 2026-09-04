/* preflight-core.js — "what will actually go out", computed once, read everywhere.
 *
 * WHY THIS EXISTS. A run of live-show bugs all had the same shape: state that decides what goes on
 * air, set automatically, cleared almost never, and visible NOWHERE in the panel. The credits scene
 * rolled casters who had never taken a desk seat (crew.workedEvent latched by a station pull-in);
 * casters "deleted" from the desk kept reappearing (casters.autoFillSuppress); two graphics lit
 * green at once (gfxActive vs each layer's .visible). Each was found mid-show, by looking at the
 * output, because nothing on screen said what the app believed.
 *
 * So: one module that answers "what will actually go out", plus every stale-state check we know how
 * to make. It is PURE (no DOM, no I/O, no clock beyond an injected now) so the SAME code runs in
 * three places off one implementation — the same trick identity-core.js / seed-power-core.js use:
 *
 *   overlay/stream-credits.html  <script src="preflight-core.js">              the roster it rolls
 *   control-panel/index.html     <script src="../overlay/preflight-core.js">   the Preflight panel
 *
 * It is also plain CommonJS, so server.js or a flow action can require('./overlay/preflight-core')
 * and get the identical answer without a browser. Nothing does yet — that is the point of keeping
 * it dependency-free.
 *
 * The credits rule living here rather than inside the overlay is the point: a panel that computes
 * the roster its own way would drift from the scene, which is the bug all over again.
 */
(function (root) {
  'use strict';

  // ── Identity helpers ───────────────────────────────────────────────────────
  // Trim + drop a leading @ before keying, so "Jonzey" / " Jonzey" / "@Jonzey" collapse. A person is
  // identified by ANY of their name/handle tokens: the same human arrives from the crew record
  // (gamertag "Jonzey") and from their caster-library twin (social @handle "ItzJonzey"), and a
  // display-only key duplicated them.
  const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/^@+/, '');
  const toks = (...xs) => xs.map(norm).filter(Boolean);

  // Tournament-ops crew.group values (Show Deck support roles) → the Operations credit line.
  const OPS_GROUPS = ['admin', 'coordinator', 'replay', 'stats', 'moderator', 'graphics', 'flex', 'socials'];

  // Off-air staff are credited under the role the producer picked on the deck, NOT their durable
  // Crew-page group — the same person produces one night and casts the next.
  function supportBucket(role) {
    const r = norm(role);
    if (!r) return null;                                   // no role → fall back to the crew group
    if (/produc|director/.test(r)) return 'production';
    if (/observ/.test(r)) return 'observers';
    if (/host/.test(r)) return 'hosts';
    if (/caster|play.?by.?play|colou?r|analy/.test(r)) return 'casters';
    return 'operations';   // admin, coordinator, replay, stats, moderator, graphics, flex, social
  }
  // "Producer" under a PRODUCTION heading just says the same word twice — print the role only when
  // it adds something the group label doesn't (Replay Op, Statistician, Graphics…).
  const roleSaysNothingNew = (role) => /^(caster|host|observer|producer|casters|production)$/.test(norm(role));

  /**
   * Who is seated on the desk right now, as identity tokens.
   * The caster LIBRARY is not this list — it's every person ever saved to a card — so it can only
   * ever confirm a desk seat, never earn one.
   */
  function deskIdentity(st) {
    const cs = (st && st.casters) || {};
    const lib = Array.isArray(cs.library) ? cs.library : [];
    const onDesk = new Set();
    const idKeys = (p) => toks(p && p.name, p && p.handle, p && p.gamertag, p && p.socialHandle);
    const seat = (p) => idKeys(p).forEach((k) => onDesk.add(k));
    (Array.isArray(cs.lineup) ? cs.lineup : []).forEach((e) => {
      const p = e && e.libraryId && lib.find((l) => l && l.id === e.libraryId);
      if (p) seat(p);
    });
    (Array.isArray(cs.list) ? cs.list : []).forEach(seat);
    // The two show roles seat a person too — and they say which credit line that person belongs on,
    // which their durable Crew-page group (usually 'casters') does not.
    const hostKeys = new Set(toks((cs.showRoles || {}).host));
    const obsKeys = new Set(toks((cs.showRoles || {}).observer));
    hostKeys.forEach((k) => onDesk.add(k));
    obsKeys.forEach((k) => onDesk.add(k));
    // Off-Air Event Staff (casters.support, [{crewId, role}]) — the producer's EXPLICIT "credit them
    // anyway" list. "Next shift" moves the outgoing lineup here automatically.
    const offAir = new Map();
    (Array.isArray(cs.support) ? cs.support : []).forEach((sp) => {
      if (sp && sp.crewId) offAir.set(sp.crewId, String(sp.role || ''));
    });
    return {
      onDesk, hostKeys, obsKeys, offAir,
      deskKind: (t) => (t.some((k) => hostKeys.has(k)) ? 'host' : t.some((k) => obsKeys.has(k)) ? 'observer' : null)
    };
  }

  /**
   * The credits roster, exactly as stream-credits.html renders it.
   * → [{ label, people: [{ name, role }] }]
   *
   * MEMBERSHIP IS EXPLICIT: on the desk now, on the Off-Air Event Staff list, or producer-added.
   * Deliberately NOT crew.workedEvent — that flag is set automatically and never cleared, so it
   * accumulated everyone who had ever brushed the desk since the last Clear.
   */
  function creditsGroups(st) {
    st = st || {};
    const bucket = { casters: [], hosts: [], production: [], operations: [], observers: [] };
    const seen = new Set();          // identity tokens of everyone already credited
    const crewGoverned = new Set();  // tokens of EVERY crew member — the library must never re-credit them
    const add = (b, name, role, t) => {
      const keys = (t && t.length) ? t : toks(name);
      if (!keys.length || keys.some((k) => seen.has(k))) return;
      keys.forEach((k) => seen.add(k));
      bucket[b].push({ name: String(name).trim(), role: role || '' });
    };
    const place = (name, role, group, kind, t) => {
      if (/produc|director/i.test(role || '')) return add('production', name, role, t);
      const g = (group === 'hosts' || kind === 'host') ? 'hosts'
        : (group === 'observers' || kind === 'observer') ? 'observers'
        : (['production', 'producer'].includes(group)) ? 'production'
        : (OPS_GROUPS.includes(group)) ? 'operations'
        : 'casters';
      add(g, name, role, t);
    };

    const { onDesk, offAir, deskKind } = deskIdentity(st);
    const cs = st.casters || {};
    const lib = Array.isArray(cs.library) ? cs.library : [];

    // Crew is the source of truth for who worked and their role. Record EVERY crew member as
    // governed (so the library can't re-credit them under Casters), then credit on membership.
    (st.crew || []).forEach((c) => {
      if (!c || !c.name) return;
      const t = toks(c.name, c.handle, c.socialHandle);
      t.forEach((k) => crewGoverned.add(k));
      if (t.some((k) => onDesk.has(k))) { place(c.handle || c.name, c.role, c.group, deskKind(t), t); return; }
      if (!offAir.has(c.id)) return;
      const supRole = offAir.get(c.id);
      const b = supportBucket(supRole);
      if (b) add(b, c.handle || c.name, roleSaysNothingNew(supRole) ? '' : supRole, t);
      else place(c.handle || c.name, c.role, c.group, null, t);
    });
    // Caster library — a guest/fill-in with no crew record, credited ONLY while they hold a desk
    // seat. Crediting the whole library rolled everyone ever saved to a card as if they had worked.
    lib.forEach((e) => {
      if (!e || !e.name) return;
      const t = toks(e.name, e.handle);
      if (t.some((k) => crewGoverned.has(k))) return;
      if (!t.some((k) => onDesk.has(k))) return;
      place(e.handle || e.name, e.role, null, deskKind(t) || e.kind, t);
    });
    // Producer-added talent (Graphics ▸ Stream Credits).
    (((st.credits && st.credits.talent) || [])).forEach((t) => {
      if (!t || !t.name) return;
      const tk = toks(t.name, t.handle);
      if (['casters', 'hosts', 'production', 'operations', 'observers'].includes(t.group)) add(t.group, t.name, t.role, tk);
      else place(t.name, t.role, null, null, tk);
    });

    // A–Z within each credit group (producer request).
    Object.keys(bucket).forEach((k) => bucket[k].sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })));
    const groups = [];
    if (bucket.casters.length) groups.push({ label: 'Casters', people: bucket.casters });
    if (bucket.hosts.length) groups.push({ label: 'Talent', people: bucket.hosts });
    if (bucket.production.length) groups.push({ label: 'Production', people: bucket.production });
    if (bucket.operations.length) groups.push({ label: 'Operations', people: bucket.operations });
    if (bucket.observers.length) groups.push({ label: 'Observers', people: bucket.observers });
    return groups;
  }

  /**
   * What the credits will call this person: their crew record's handle wins (that is the rule
   * creditsGroups() applies), then the library card's, then whatever name we have.
   */
  function creditedName(st, p) {
    if (!p || !p.name) return '';
    const t = toks(p.name, p.handle, p.socialHandle);
    const c = (st.crew || []).find((x) => x && x.name && toks(x.name, x.handle, x.socialHandle).some((k) => t.includes(k)));
    if (c) return c.handle || c.name;
    return p.handle || p.name;
  }

  /** The desk as it will render: slots 1-4 plus the two show roles, each with its feed status. */
  function deskRows(st) {
    st = st || {};
    const cs = st.casters || {};
    const lib = Array.isArray(cs.library) ? cs.library : [];
    const lineup = Array.isArray(cs.lineup) ? cs.lineup : [];
    const list = Array.isArray(cs.list) ? cs.list : [];
    const labels = cs.slotLabels || {};
    const rows = [];
    for (let n = 1; n <= 4; n++) {
      const entries = lineup.filter((e) => e && Number(e.slot) === n);
      const e = entries[0];
      const p = e && lib.find((l) => l && l.id === e.libraryId);
      const live = p ? list.find((x) => x && (x.id === p.id || norm(x.name) === norm(p.name))) : null;
      const name = (p && p.name) || '';
      rows.push({
        slot: n,
        label: labels[n] || ('Caster ' + n),
        name,
        // The name the CREDITS will print for this seat. The deck shows a library entry's real name
        // ("Michael Poupa") while credits prefer the gamertag ("0ofen") — same human, two strings,
        // and a preflight screen that showed only one of them would read like a mismatch.
        credited: creditedName(st, p) || name,
        feed: !!((live && live.camUrl) || (p && (p.camUrl || p.vdoOverride)) || (e && e.customCamUrl)),
        collision: entries.length > 1
      });
    }
    const roles = cs.showRoles || {};
    if (roles.host) rows.push({ slot: 0, label: 'Host', name: roles.host, credited: roles.host, feed: true, collision: false });
    if (roles.observer) rows.push({ slot: 0, label: 'Observer', name: roles.observer, credited: roles.observer, feed: true, collision: false });
    return rows;
  }

  // ── Checks ─────────────────────────────────────────────────────────────────
  // Levels: 'error' = this WILL look wrong on air; 'warn' = probably not what you meant;
  // 'info'  = invisible state you should know about before you go live.
  function checks(st, extra) {
    st = st || {};
    extra = extra || {};
    const out = [];
    const push = (level, id, title, detail, where) => out.push({ level, id, title, detail: detail || '', where: where || '' });

    const cs = st.casters || {};
    const { onDesk, offAir } = deskIdentity(st);
    const crew = Array.isArray(st.crew) ? st.crew : [];
    const rows = deskRows(st);
    const seated = rows.filter((r) => r.name);

    // ── The desk ────────────────────────────────────────────────────────────
    if (!seated.length) push('warn', 'desk-empty', 'Nothing on the desk', 'No caster slots or show roles are filled — caster scenes will render empty and the credits will have no Casters line.', 'Talent ▸ Show Deck');
    rows.filter((r) => r.collision).forEach((r) => {
      push('error', 'slot-collision', `Two people on ${r.label}`, 'More than one lineup entry claims this slot; only one will render.', 'Talent ▸ Show Deck');
    });
    rows.filter((r) => r.name && r.slot >= 1 && !r.feed).forEach((r) => {
      push('warn', 'desk-no-feed', `${r.name} has no feed`, `${r.label} is filled but carries no camera URL — the browser source will be blank.`, 'Talent ▸ Show Deck');
    });

    // ── Invisible crew state ────────────────────────────────────────────────
    // The exact shape of the credits bug: a flag set automatically, never cleared, contradicting
    // what the deck shows.
    crew.forEach((c) => {
      if (!c || !c.name) return;
      const t = toks(c.name, c.handle, c.socialHandle);
      const on = t.some((k) => onDesk.has(k));
      const off = offAir.has(c.id);
      if (c.active && !on) {
        push('warn', 'crew-active-no-slot', `${c.handle || c.name} is marked on shift but holds no slot`,
          'Something seated them once (a station check-in, a preset, a swap) and nothing cleared it. Harmless on air, but it skews a saved shift preset.', 'Talent ▸ Crew');
      }
      if (c.workedEvent && !on && !off) {
        push('info', 'worked-not-credited', `${c.handle || c.name} is flagged as having worked, but will NOT be credited`,
          'Credits roll the desk plus Off-Air Event Staff only. If they really worked tonight, add them under Off-Air Event Staff.', 'Talent ▸ Show Deck');
      }
    });
    (Array.isArray(cs.support) ? cs.support : []).forEach((sp) => {
      if (!sp || !sp.crewId) return;
      if (!crew.some((c) => c && c.id === sp.crewId)) {
        push('warn', 'support-orphan', 'Off-Air Event Staff chip points at a deleted crew member',
          'It will silently roll nothing on the credits screen. Remove and re-add them.', 'Talent ▸ Show Deck');
      }
    });
    const supp = Array.isArray(cs.autoFillSuppress) ? cs.autoFillSuppress.filter(Boolean) : [];
    if (supp.length) {
      push('info', 'autofill-suppressed', `${supp.length} caster(s) held off auto-fill`,
        `${supp.join(', ')} — pulled off the desk by hand, so station check-ins will not seat them again until they re-check-in.`, 'Talent ▸ Show Deck');
    }

    // ── Credits ─────────────────────────────────────────────────────────────
    const groups = creditsGroups(st);
    if (!groups.length) push('warn', 'credits-empty', 'The credits screen will roll no talent', 'Nobody is on the desk or on the Off-Air Event Staff list.', 'Talent ▸ Show Deck');

    // ── Graphics ────────────────────────────────────────────────────────────
    // gfxActive is the single source of "what is punched up"; each layer also carries its own
    // .visible. When those disagree the panel lights one thing and the scene renders another.
    const EXCL = extra.gfxExclusive || {
      break: 'breakScreen', winner: 'winner', intro: 'intro', veto: 'veto', draft: 'draft',
      bracket: 'bracket', schedule: 'upcoming', upcoming: 'upcoming', standings: 'standings',
      credits: 'credits', seriesstats: 'seriesStats',
      brdrop: 'br.dropmap', brcompare: 'br.compare', brvictory: 'br.victory'
    };
    const dig = (path) => String(path).split('.').reduce((cur, part) => (cur && typeof cur === 'object') ? cur[part] : undefined, st);
    const active = (typeof st.gfxActive === 'string' && st.gfxActive) ? st.gfxActive : '';
    const visibleKeys = Object.keys(EXCL).filter((k) => { const o = dig(EXCL[k]); return !!(o && o.visible); });
    if (active) {
      const o = dig(EXCL[active]);
      if (EXCL[active] && !(o && o.visible)) {
        push('error', 'gfx-active-not-visible', `"${active}" is punched up but its layer is hidden`,
          'The panel shows it live; the scene renders nothing. Re-arm it, or clear the graphic.', 'Production ▸ Graphics');
      }
    }
    // >1 exclusive layer visible = the single-select invariant broken.
    const strayVisible = visibleKeys.filter((k) => !active || EXCL[k] !== EXCL[active]);
    if (strayVisible.length) {
      push(active ? 'error' : 'warn', 'gfx-stray-visible', `${strayVisible.length} graphic(s) still marked visible: ${strayVisible.join(', ')}`,
        active ? `"${active}" is the punched-up graphic, but these layers are also flagged visible.` : 'No graphic is punched up, yet these layers are flagged visible — they may still be on screen.', 'Production ▸ Graphics');
    }

    // ── Switcher (OBS / vMix) ───────────────────────────────────────────────
    const obs = st.obs || {};
    const vmix = st.vmix || {};
    const target = (st.switcher && st.switcher.target) || 'obs';
    if (target === 'obs' && obs.enabled && !obs.connected) {
      push('error', 'obs-disconnected', 'OBS is enabled but not connected', obs.lastError ? String(obs.lastError) : 'Scene automation, audio pills and source toggles will all do nothing.', 'Settings ▸ OBS');
    }
    if (target === 'vmix' && vmix.enabled && !vmix.connected) {
      push('error', 'vmix-disconnected', 'vMix is enabled but not connected', vmix.lastError ? String(vmix.lastError) : 'Switcher actions will do nothing.', 'Settings ▸ vMix');
    }
    if (target === 'obs' && obs.connected) {
      const have = new Set((obs.availableScenes || []).map((x) => (typeof x === 'string' ? x : (x && x.sceneName) || '')).filter(Boolean));
      const configured = Object.keys(obs.scenes || {}).map((k) => ({ k, v: obs.scenes[k] })).filter((x) => x.v);
      configured.forEach(({ k, v }) => {
        if (have.size && !have.has(v)) {
          push('error', 'obs-scene-missing', `OBS scene "${v}" (${k}) no longer exists`,
            'The automation for this moment will silently do nothing — the scene was renamed or deleted in OBS.', 'Settings ▸ OBS');
        }
      });
      ['kickoff', 'scoreboardScene', 'postGame'].forEach((k) => {
        const t = obs[k];
        if (t && t.enabled && t.scene && have.size && !have.has(t.scene)) {
          push('error', 'obs-trigger-scene-missing', `Auto-trigger "${k}" points at missing scene "${t.scene}"`, 'It is switched on but the scene is gone from OBS.', 'Settings ▸ OBS');
        }
      });
    }

    // ── Teams ───────────────────────────────────────────────────────────────
    const PLACEHOLDER = /^(team a|team b|blue|orange|tbd|team blue|team orange)$/i;
    [['blue', 'Blue'], ['orange', 'Orange']].forEach(([k, label]) => {
      const t = (st.teams && st.teams[k]) || {};
      if (!t.name || PLACEHOLDER.test(String(t.name).trim())) {
        push('warn', 'team-placeholder', `${label} team is still a placeholder`, `Reads "${t.name || 'empty'}" — every scoreboard and lower third will show that.`, 'Match ▸ Teams');
      } else if (!t.logo) {
        push('info', 'team-no-logo', `${t.name} has no logo`, 'Scoreboards and the bracket will render a blank crest.', 'Match ▸ Teams');
      }
    });

    // ── Cloud ───────────────────────────────────────────────────────────────
    // Local-first: a cloud outage never stops the show, but it DOES silently stop station
    // auto-fill, the multiview publisher and the org library from updating.
    const ch = extra.cloudHealth || st.cloudHealth;
    if (ch && ch.healthy === false) {
      const secs = Math.max(1, Math.round((ch.retryInMs || 0) / 1000));
      push('warn', 'cloud-degraded', 'Cloud backend is not responding',
        `${ch.consecutiveFailures} failed request(s)${ch.lastStatus ? ` (HTTP ${ch.lastStatus})` : ''}: ${ch.lastError || 'no response'}. Background sync is paused, retrying in ~${secs}s. The show itself is unaffected.`, 'Settings ▸ Cloud');
    }

    const rank = { error: 0, warn: 1, info: 2 };
    out.sort((a, b) => rank[a.level] - rank[b.level]);
    return out;
  }

  /** The whole report the Preflight panel renders. */
  function preflight(st, extra) {
    st = st || {};
    const items = checks(st, extra);
    return {
      credits: creditsGroups(st),
      desk: deskRows(st),
      checks: items,
      counts: {
        error: items.filter((c) => c.level === 'error').length,
        warn: items.filter((c) => c.level === 'warn').length,
        info: items.filter((c) => c.level === 'info').length
      }
    };
  }

  const api = { norm, toks, deskIdentity, creditsGroups, deskRows, checks, preflight, supportBucket, OPS_GROUPS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PreflightCore = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
