/*
  brawlhalla-legends.js — canonical Brawlhalla legend registry.

  ONE list, shared by every consumer so a legend name typed in the control panel resolves to the
  same art and the same weapon pair everywhere:
    · overlays          <script src="/brawlhalla-legends.js">            (served off :3000)
    · control panel     <script src="../overlay/brawlhalla-legends.js">  (runs from file://)

  GENERATED from the game's own static data — GET https://api.brawlhalla.com/v1/static/legends —
  so the ids and weapon pairs are the ones the live stats API reports, not hand-typed. `legend_id`
  is what a player's stats/ranked payload keys its per-legend rows on, which is how the overlay
  turns "this player's best legend" into a name and a portrait. Re-run assets/fetch-brawlhalla-legends.js
  after a patch adds a legend.

  RANDOM (legend_id 2) is deliberately absent: it is a menu option, not a pick, and it has no
  weapons, no art and never appears in a stat row.

  Art (optional) lives under assets/brawlhalla/legends/ :
    icon/<slug>.png     small square portrait — the scoreboard chip
    render/<slug>.png   full-body render      — line-up / top-8 cards
  The overlay renders a clean weapon-pair chip when a portrait is missing, so the boards are
  correct with NO art installed at all.
*/
(function (root) {
  'use strict';

  // slug = the art filename. name = the on-air display name (the API's bio_name, properly cased).
  // weapons = the legend's two signature weapons, in the API's own order (weapon_one, weapon_two)
  // — the per-legend stat rows report damage/KOs as "weapon one" / "weapon two", so the order is
  // load-bearing, not cosmetic. alt = extra spellings we accept when resolving free text.
  var LEGENDS = [
    { id: 3, slug: 'bodvar', name: 'Bödvar', weapons: ['Hammer', 'Sword'], alt: ['bodvar'] },
    { id: 4, slug: 'cassidy', name: 'Cassidy', weapons: ['Pistol', 'Hammer'] },
    { id: 5, slug: 'orion', name: 'Orion', weapons: ['RocketLance', 'Spear'] },
    { id: 6, slug: 'lord_vraxx', name: 'Lord Vraxx', weapons: ['RocketLance', 'Pistol'], alt: ['vraxx'] },
    { id: 7, slug: 'gnash', name: 'Gnash', weapons: ['Hammer', 'Spear'] },
    { id: 8, slug: 'queen_nai', name: 'Queen Nai', weapons: ['Spear', 'Katar'], alt: ['nai'] },
    { id: 9, slug: 'lucien', name: 'Lucien', weapons: ['Katar', 'Pistol'] },
    { id: 10, slug: 'hattori', name: 'Hattori', weapons: ['Sword', 'Spear'] },
    { id: 11, slug: 'sir_roland', name: 'Sir Roland', weapons: ['RocketLance', 'Sword'], alt: ['roland'] },
    { id: 12, slug: 'scarlet', name: 'Scarlet', weapons: ['Hammer', 'RocketLance'] },
    { id: 13, slug: 'thatch', name: 'Thatch', weapons: ['Sword', 'Pistol'] },
    { id: 14, slug: 'ada', name: 'Ada', weapons: ['Pistol', 'Spear'] },
    { id: 15, slug: 'sentinel', name: 'Sentinel', weapons: ['Hammer', 'Katar'] },
    { id: 16, slug: 'teros', name: 'Teros', weapons: ['Axe', 'Hammer'] },
    { id: 17, slug: 'red_raptor', name: 'Red Raptor', weapons: ['Boots', 'Orb'], alt: ['raptor'] },
    { id: 18, slug: 'ember', name: 'Ember', weapons: ['Bow', 'Katar'] },
    { id: 19, slug: 'brynn', name: 'Brynn', weapons: ['Axe', 'Spear'] },
    { id: 20, slug: 'asuri', name: 'Asuri', weapons: ['Katar', 'Sword'] },
    { id: 21, slug: 'barraza', name: 'Barraza', weapons: ['Axe', 'Pistol'] },
    { id: 22, slug: 'ulgrim', name: 'Ulgrim', weapons: ['Axe', 'RocketLance'] },
    { id: 23, slug: 'azoth', name: 'Azoth', weapons: ['Bow', 'Axe'] },
    { id: 24, slug: 'koji', name: 'Koji', weapons: ['Bow', 'Sword'] },
    { id: 25, slug: 'diana', name: 'Diana', weapons: ['Bow', 'Pistol'] },
    { id: 26, slug: 'jhala', name: 'Jhala', weapons: ['Axe', 'Sword'] },
    { id: 27, slug: 'loki', name: 'Loki', weapons: ['Katar', 'Scythe'] },
    { id: 28, slug: 'kor', name: 'Kor', weapons: ['Fists', 'Hammer'] },
    { id: 29, slug: 'wu_shang', name: 'Wu Shang', weapons: ['Fists', 'Spear'], alt: ['wushang', 'wu'] },
    { id: 30, slug: 'val', name: 'Val', weapons: ['Fists', 'Sword'] },
    { id: 31, slug: 'ragnir', name: 'Ragnir', weapons: ['Katar', 'Axe'] },
    { id: 32, slug: 'cross', name: 'Cross', weapons: ['Pistol', 'Fists'] },
    { id: 33, slug: 'mirage', name: 'Mirage', weapons: ['Scythe', 'Spear'] },
    { id: 34, slug: 'nix', name: 'Nix', weapons: ['Scythe', 'Pistol'] },
    { id: 35, slug: 'mordex', name: 'Mordex', weapons: ['Scythe', 'Fists'] },
    { id: 36, slug: 'yumiko', name: 'Yumiko', weapons: ['Bow', 'Hammer'] },
    { id: 37, slug: 'artemis', name: 'Artemis', weapons: ['RocketLance', 'Scythe'] },
    { id: 38, slug: 'caspian', name: 'Caspian', weapons: ['Fists', 'Katar'] },
    { id: 39, slug: 'sidra', name: 'Sidra', weapons: ['Cannon', 'Sword'] },
    { id: 40, slug: 'xull', name: 'Xull', weapons: ['Cannon', 'Axe'] },
    { id: 41, slug: 'isaiah', name: 'Isaiah', weapons: ['Cannon', 'Pistol'] },
    { id: 42, slug: 'kaya', name: 'Kaya', weapons: ['Spear', 'Bow'] },
    { id: 43, slug: 'jiro', name: 'Jiro', weapons: ['Sword', 'Scythe'] },
    { id: 44, slug: 'lin_fei', name: 'Lin Fei', weapons: ['Katar', 'Cannon'], alt: ['linfei'] },
    { id: 45, slug: 'zariel', name: 'Zariel', weapons: ['Fists', 'Bow'] },
    { id: 46, slug: 'rayman', name: 'Rayman', weapons: ['Fists', 'Axe'] },
    { id: 47, slug: 'dusk', name: 'Dusk', weapons: ['Spear', 'Orb'] },
    { id: 48, slug: 'fait', name: 'Fait', weapons: ['Scythe', 'Orb'] },
    { id: 49, slug: 'thor', name: 'Thor', weapons: ['Hammer', 'Orb'] },
    { id: 50, slug: 'petra', name: 'Petra', weapons: ['Fists', 'Orb'] },
    { id: 51, slug: 'vector', name: 'Vector', weapons: ['RocketLance', 'Bow'] },
    { id: 52, slug: 'volkov', name: 'Volkov', weapons: ['Axe', 'Scythe'] },
    { id: 53, slug: 'onyx', name: 'Onyx', weapons: ['Fists', 'Cannon'] },
    { id: 54, slug: 'jaeyun', name: 'Jaeyun', weapons: ['Sword', 'Greatsword'] },
    { id: 55, slug: 'mako', name: 'Mako', weapons: ['Katar', 'Greatsword'] },
    { id: 56, slug: 'magyar', name: 'Magyar', weapons: ['Hammer', 'Greatsword'] },
    { id: 57, slug: 'reno', name: 'Reno', weapons: ['Pistol', 'Orb'] },
    { id: 58, slug: 'munin', name: 'Munin', weapons: ['Bow', 'Scythe'] },
    { id: 59, slug: 'arcadia', name: 'Arcadia', weapons: ['Spear', 'Greatsword'] },
    { id: 60, slug: 'ezio', name: 'Ezio', weapons: ['Sword', 'Orb'] },
    { id: 61, slug: 'seven', name: 'Seven', weapons: ['Spear', 'Cannon'] },
    { id: 62, slug: 'thea', name: 'Thea', weapons: ['Boots', 'RocketLance'] },
    { id: 63, slug: 'tezca', name: 'Tezca', weapons: ['Boots', 'Fists'] },
    { id: 64, slug: 'vivi', name: 'Vivi', weapons: ['Boots', 'Pistol'] },
    { id: 65, slug: 'imugi', name: 'Imugi', weapons: ['Axe', 'Greatsword'] },
    { id: 66, slug: 'king_zuva', name: 'King Zuva', weapons: ['Hammer', 'Boots'], alt: ['zuva'] },
    { id: 67, slug: 'priya', name: 'Priya', weapons: ['Chakram', 'Sword'] },
    { id: 68, slug: 'ransom', name: 'Ransom', weapons: ['Chakram', 'Bow'] },
    { id: 69, slug: 'lady_vera', name: 'Lady Vera', weapons: ['Chakram', 'Scythe'], alt: ['vera'] },
    { id: 70, slug: 'rupture', name: 'Rupture', weapons: ['Katar', 'RocketLance'] },
    { id: 71, slug: 'aurus', name: 'Aurus', weapons: ['Chakram', 'Spear'] },
    { id: 72, slug: 'qinghua_baobao', name: 'Qinghua & Baobao', weapons: ['Orb', 'Cannon'] }
  ];

  // Ranked tiers, lowest first. The API hands us the tier as a STRING ("Valhallan", "Gold 3"),
  // so we never recompute one from rating — we only need the family for its colour.
  var TIERS = [
    { key: 'tin',       name: 'Tin',       color: '#7d8590' },
    { key: 'bronze',    name: 'Bronze',    color: '#a9713c' },
    { key: 'silver',    name: 'Silver',    color: '#b9c4d0' },
    { key: 'gold',      name: 'Gold',      color: '#e0a92a' },
    { key: 'platinum',  name: 'Platinum',  color: '#39c2c8' },
    { key: 'diamond',   name: 'Diamond',   color: '#7d6cf5' },
    { key: 'valhallan', name: 'Valhallan', color: '#e0383e' }
  ];

  // Asset root differs by host page: the control panel is a file:// document sitting in
  // control-panel/, every overlay is served from the :3000 root. Same rule the game logos use.
  var BASE = (root.location && root.location.protocol === 'file:') ? '../assets/' : '/assets/';

  var bySlug = {};
  var byId = {};
  var byKey = {};   // normalised name/alias -> legend

  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/ö/g, 'o').replace(/ä/g, 'a').replace(/ü/g, 'u').replace(/é/g, 'e')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  LEGENDS.forEach(function (l) {
    bySlug[l.slug] = l;
    byId[l.id] = l;
    [l.name, l.slug].concat(l.alt || []).forEach(function (k) {
      var n = norm(k);
      if (n && !byKey[n]) byKey[n] = l;
      var tight = n.replace(/ /g, '');
      if (tight && !byKey[tight]) byKey[tight] = l;
    });
  });

  // Free text (a producer's typing) OR a numeric legend_id -> legend record, or null.
  function resolve(value) {
    if (value == null || value === '') return null;
    // A bare number (or numeric string) is a legend_id straight off the stats API.
    var asId = Number(value);
    if (asId && byId[asId]) return byId[asId];
    var n = norm(value);
    if (!n) return null;
    if (byKey[n]) return byKey[n];
    var tight = n.replace(/ /g, '');
    if (byKey[tight]) return byKey[tight];
    // last resort: unique prefix match ("mord" -> Mordex) so half-typed names still land
    var hits = LEGENDS.filter(function (l) { return norm(l.name).indexOf(n) === 0; });
    return hits.length === 1 ? hits[0] : null;
  }

  function slugOf(value) { var l = resolve(value); return l ? l.slug : ''; }
  function nameOf(value) { var l = resolve(value); return l ? l.name : String(value || ''); }
  function weaponsOf(value) { var l = resolve(value); return l ? l.weapons.slice() : []; }
  function iconUrl(value) { var s = slugOf(value); return s ? BASE + 'brawlhalla/legends/icon/' + s + '.png' : ''; }
  function renderUrl(value) { var s = slugOf(value); return s ? BASE + 'brawlhalla/legends/render/' + s + '.png' : ''; }

  // "Gold 3" / "Valhallan" -> the tier record. Unknown strings fall back to Tin so a chip always
  // has a colour rather than rendering transparent.
  function tierOf(value) {
    var n = norm(value);
    if (!n) return null;
    var fam = n.split(' ')[0];
    for (var i = 0; i < TIERS.length; i++) if (TIERS[i].key === fam) return TIERS[i];
    return null;
  }
  function tierColor(value) { var t = tierOf(value); return t ? t.color : '#7d8590'; }

  root.BrawlhallaLegends = {
    list: LEGENDS,
    picks: LEGENDS,
    bySlug: bySlug,
    byId: byId,
    tiers: TIERS,
    base: BASE,
    norm: norm,
    resolve: resolve,
    slugOf: slugOf,
    nameOf: nameOf,
    weaponsOf: weaponsOf,
    iconUrl: iconUrl,
    renderUrl: renderUrl,
    tierOf: tierOf,
    tierColor: tierColor
  };
  // Flat display-name list for the Match > Teams datalist (mirrors SMASH_FIGHTERS).
  root.BRAWLHALLA_LEGENDS = LEGENDS.map(function (l) { return l.name; });
})(typeof window !== 'undefined' ? window : this);
