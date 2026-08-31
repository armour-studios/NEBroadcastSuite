/*
  smash-fighters.js — canonical Super Smash Bros. Ultimate fighter registry.

  ONE list, shared by every consumer so a fighter name typed in the control panel resolves to the
  same art everywhere:
    · overlays          <script src="/smash-fighters.js">            (served off :3000)
    · control panel     <script src="../overlay/smash-fighters.js">  (runs from file://)

  Art lives under assets/smash/fighters/ and is fetched by assets/fetch-smash-fighters.js:
    stock/<slug>.png    64x64 stock icon  — the head used for stock pips
    render/<slug>.png   ~760px render     — the full-body art for placement / line-up cards

  Plain global (no modules) because the control panel is a file:// page. Everything is exposed on
  window.SmashFighters; SMASH_FIGHTERS stays available as the flat name list the old datalist used.
*/
(function (root) {
  'use strict';

  // slug = the art filename. name = the on-air display name. alt = extra spellings we accept when
  // resolving free text (producer shorthand, start.gg's character names, older name spellings).
  var FIGHTERS = [
    { slug: 'mario',              name: 'Mario' },
    { slug: 'donkey_kong',        name: 'Donkey Kong',        alt: ['dk'] },
    { slug: 'link',               name: 'Link' },
    { slug: 'samus',              name: 'Samus' },
    { slug: 'dark_samus',         name: 'Dark Samus',         echo: true },
    { slug: 'yoshi',              name: 'Yoshi' },
    { slug: 'kirby',              name: 'Kirby' },
    { slug: 'fox',                name: 'Fox' },
    { slug: 'pikachu',            name: 'Pikachu' },
    { slug: 'luigi',              name: 'Luigi' },
    { slug: 'ness',               name: 'Ness' },
    { slug: 'captain_falcon',     name: 'Captain Falcon',     alt: ['falcon', 'cf'] },
    { slug: 'jigglypuff',         name: 'Jigglypuff',         alt: ['puff'] },
    { slug: 'peach',              name: 'Peach' },
    { slug: 'daisy',              name: 'Daisy',              echo: true },
    { slug: 'bowser',             name: 'Bowser' },
    { slug: 'ice_climbers',       name: 'Ice Climbers',       alt: ['ics', 'icies'] },
    { slug: 'sheik',              name: 'Sheik' },
    { slug: 'zelda',              name: 'Zelda' },
    { slug: 'dr_mario',           name: 'Dr. Mario',          alt: ['doc'] },
    { slug: 'pichu',              name: 'Pichu' },
    { slug: 'falco',              name: 'Falco' },
    { slug: 'marth',              name: 'Marth' },
    { slug: 'lucina',             name: 'Lucina',             echo: true },
    { slug: 'young_link',         name: 'Young Link',         alt: ['yink', 'yl'] },
    { slug: 'ganondorf',          name: 'Ganondorf',          alt: ['ganon'] },
    { slug: 'mewtwo',             name: 'Mewtwo' },
    { slug: 'roy',                name: 'Roy' },
    { slug: 'chrom',              name: 'Chrom',              echo: true },
    { slug: 'mr_game_and_watch',  name: 'Mr. Game & Watch',   alt: ['game and watch', 'gnw', 'g w'] },
    { slug: 'meta_knight',        name: 'Meta Knight',        alt: ['mk'] },
    { slug: 'pit',                name: 'Pit' },
    { slug: 'dark_pit',           name: 'Dark Pit',           echo: true, alt: ['pittoo'] },
    { slug: 'zero_suit_samus',    name: 'Zero Suit Samus',    alt: ['zss'] },
    { slug: 'wario',              name: 'Wario' },
    { slug: 'snake',              name: 'Snake',              alt: ['solid snake'] },
    { slug: 'ike',                name: 'Ike' },
    { slug: 'pokemon_trainer',    name: 'Pokemon Trainer',    alt: ['pt', 'trainer'] },
    { slug: 'squirtle',           name: 'Squirtle',           hidden: true },
    { slug: 'ivysaur',            name: 'Ivysaur',            hidden: true },
    { slug: 'charizard',          name: 'Charizard',          hidden: true },
    { slug: 'diddy_kong',         name: 'Diddy Kong',         alt: ['diddy'] },
    { slug: 'lucas',              name: 'Lucas' },
    { slug: 'sonic',              name: 'Sonic' },
    { slug: 'king_dedede',        name: 'King Dedede',        alt: ['dedede', 'ddd'] },
    { slug: 'olimar',             name: 'Olimar',             alt: ['alph'] },
    { slug: 'lucario',            name: 'Lucario' },
    { slug: 'rob',                name: 'R.O.B.' },
    { slug: 'toon_link',          name: 'Toon Link',          alt: ['tink', 'tl'] },
    { slug: 'wolf',               name: 'Wolf' },
    { slug: 'villager',           name: 'Villager' },
    { slug: 'mega_man',           name: 'Mega Man' },
    { slug: 'wii_fit_trainer',    name: 'Wii Fit Trainer',    alt: ['wft', 'wii fit'] },
    { slug: 'rosalina_and_luma',  name: 'Rosalina & Luma',    alt: ['rosalina', 'rosa'] },
    { slug: 'little_mac',         name: 'Little Mac',         alt: ['mac'] },
    { slug: 'greninja',           name: 'Greninja' },
    { slug: 'mii_brawler',        name: 'Mii Brawler' },
    { slug: 'mii_swordfighter',   name: 'Mii Swordfighter' },
    { slug: 'mii_gunner',         name: 'Mii Gunner' },
    { slug: 'palutena',           name: 'Palutena',           alt: ['palu'] },
    { slug: 'pac_man',            name: 'Pac-Man' },
    { slug: 'robin',              name: 'Robin' },
    { slug: 'shulk',              name: 'Shulk' },
    { slug: 'bowser_jr',          name: 'Bowser Jr.',         alt: ['bjr'] },
    { slug: 'duck_hunt',          name: 'Duck Hunt',          alt: ['duck hunt duo', 'dhd'] },
    { slug: 'ryu',                name: 'Ryu' },
    { slug: 'ken',                name: 'Ken',                echo: true },
    { slug: 'cloud',              name: 'Cloud' },
    { slug: 'corrin',             name: 'Corrin' },
    { slug: 'bayonetta',          name: 'Bayonetta',          alt: ['bayo'] },
    { slug: 'inkling',            name: 'Inkling' },
    { slug: 'ridley',             name: 'Ridley' },
    { slug: 'simon',              name: 'Simon',              alt: ['simon belmont'] },
    { slug: 'richter',            name: 'Richter',            echo: true, alt: ['richter belmont'] },
    { slug: 'king_k_rool',        name: 'King K. Rool',       alt: ['k rool', 'krool'] },
    { slug: 'isabelle',           name: 'Isabelle' },
    { slug: 'incineroar',         name: 'Incineroar',         alt: ['incin'] },
    { slug: 'piranha_plant',      name: 'Piranha Plant',      alt: ['plant'] },
    { slug: 'joker',              name: 'Joker' },
    { slug: 'hero',               name: 'Hero' },
    { slug: 'banjo_and_kazooie',  name: 'Banjo & Kazooie',    alt: ['banjo', 'bnk'] },
    { slug: 'terry',              name: 'Terry',              alt: ['terry bogard'] },
    { slug: 'byleth',             name: 'Byleth' },
    { slug: 'min_min',            name: 'Min Min' },
    { slug: 'steve',              name: 'Steve',              alt: ['alex'] },
    { slug: 'sephiroth',          name: 'Sephiroth',          alt: ['seph'] },
    { slug: 'pyra',               name: 'Pyra',               alt: ['aegis'] },
    { slug: 'mythra',             name: 'Mythra' },
    { slug: 'kazuya',             name: 'Kazuya',             alt: ['kazuya mishima'] },
    { slug: 'sora',               name: 'Sora' }
  ];

  // Asset root differs by host page: the control panel is a file:// document sitting in
  // control-panel/, every overlay is served from the :3000 root. Same rule the game logos use.
  var BASE = (root.location && root.location.protocol === 'file:') ? '../assets/' : '/assets/';

  var bySlug = {};
  var byKey = {};   // normalised name/alias -> fighter
  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/é/g, 'e')                   // Pokemon with the accent
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }
  FIGHTERS.forEach(function (f) {
    bySlug[f.slug] = f;
    [f.name, f.slug].concat(f.alt || []).forEach(function (k) {
      var n = norm(k);
      if (n && !byKey[n]) byKey[n] = f;
      var tight = n.replace(/ /g, '');           // "zerosuitsamus", "kingkrool", "pacman"
      if (tight && !byKey[tight]) byKey[tight] = f;
    });
  });

  // Free text (a producer's typing, a start.gg character name) -> fighter record, or null.
  function resolve(value) {
    if (!value) return null;
    var n = norm(value);
    if (!n) return null;
    if (byKey[n]) return byKey[n];
    var tight = n.replace(/ /g, '');
    if (byKey[tight]) return byKey[tight];
    // last resort: unique prefix match ("sephi" -> Sephiroth) so half-typed names still land
    var hits = FIGHTERS.filter(function (f) { return norm(f.name).indexOf(n) === 0; });
    return hits.length === 1 ? hits[0] : null;
  }

  function slugOf(value) { var f = resolve(value); return f ? f.slug : ''; }
  function nameOf(value) { var f = resolve(value); return f ? f.name : String(value || ''); }
  function stockUrl(value) { var s = slugOf(value); return s ? BASE + 'smash/fighters/stock/' + s + '.png' : ''; }
  function renderUrl(value) { var s = slugOf(value); return s ? BASE + 'smash/fighters/render/' + s + '.png' : ''; }

  root.SmashFighters = {
    list: FIGHTERS,
    // the pickable roster (Pokemon Trainer's three pokemon are art-only, not separate entrants)
    picks: FIGHTERS.filter(function (f) { return !f.hidden; }),
    bySlug: bySlug,
    base: BASE,
    norm: norm,
    resolve: resolve,
    slugOf: slugOf,
    nameOf: nameOf,
    stockUrl: stockUrl,
    renderUrl: renderUrl
  };
  // Back-compat: the flat display-name list the Match > Teams datalist was built from.
  root.SMASH_FIGHTERS = root.SmashFighters.picks.map(function (f) { return f.name; });
})(typeof window !== 'undefined' ? window : this);
