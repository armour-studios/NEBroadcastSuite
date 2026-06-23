// backend/draft.js — champion/hero DRAFT data + sequence engine (MOBA pick/ban).
// Sibling of backend/veto.js: same step model, but the "pool" is a champion list and
// the order is a draft order. Pure helpers; server.js owns the live state + broadcast.

// Draft orders. Each step is [action, teamIdx]; teamIdx 0 = Blue side (acts first), 1 = Red.
// LoL standard tournament draft: 6 bans, 6 picks, 4 bans, 4 picks.
const LOL = [
  ['ban', 0], ['ban', 1], ['ban', 0], ['ban', 1], ['ban', 0], ['ban', 1],   // ban phase 1
  ['pick', 0], ['pick', 1], ['pick', 1], ['pick', 0], ['pick', 0], ['pick', 1], // pick phase 1 (B R R B B R)
  ['ban', 1], ['ban', 0], ['ban', 1], ['ban', 0],                            // ban phase 2 (R B R B)
  ['pick', 1], ['pick', 0], ['pick', 0], ['pick', 1]                         // pick phase 2 (R B B R)
];

const DRAFT_FORMATS = {
  league: LOL
  // dota2 / mobile-legends / honor-of-kings: add their orders here later (engine is order-driven).
};

// Champion names for typeahead (free-text still allows anything). League list — editable.
const CHAMPIONS = {
  league: [
    'Aatrox','Ahri','Akali','Akshan','Alistar','Ambessa','Amumu','Anivia','Annie','Aphelios','Ashe','Aurelion Sol','Aurora','Azir',
    'Bard','Bel’Veth','Blitzcrank','Brand','Braum','Briar','Caitlyn','Camille','Cassiopeia','Cho’Gath','Corki',
    'Darius','Diana','Dr. Mundo','Draven','Ekko','Elise','Evelynn','Ezreal','Fiddlesticks','Fiora','Fizz','Galio','Gangplank',
    'Garen','Gnar','Gragas','Graves','Gwen','Hecarim','Heimerdinger','Hwei','Illaoi','Irelia','Ivern','Janna','Jarvan IV','Jax',
    'Jayce','Jhin','Jinx','K’Sante','Kai’Sa','Kalista','Karma','Karthus','Kassadin','Katarina','Kayle','Kayn','Kennen',
    'Kha’Zix','Kindred','Kled','Kog’Maw','LeBlanc','Lee Sin','Leona','Lillia','Lissandra','Lucian','Lulu','Lux','Malphite',
    'Malzahar','Maokai','Master Yi','Milio','Miss Fortune','Mordekaiser','Morgana','Naafiri','Nami','Nasus','Nautilus','Neeko',
    'Nidalee','Nilah','Nocturne','Nunu & Willump','Olaf','Orianna','Ornn','Pantheon','Poppy','Pyke','Qiyana','Quinn','Rakan',
    'Rammus','Rek’Sai','Rell','Renata Glasc','Renekton','Rengar','Riven','Rumble','Ryze','Samira','Sejuani','Senna','Seraphine',
    'Sett','Shaco','Shen','Shyvana','Singed','Sion','Sivir','Skarner','Smolder','Sona','Soraka','Swain','Sylas','Syndra',
    'Tahm Kench','Taliyah','Talon','Taric','Teemo','Thresh','Tristana','Trundle','Tryndamere','Twisted Fate','Twitch','Udyr',
    'Urgot','Varus','Vayne','Veigar','Vel’Koz','Vex','Vi','Viego','Viktor','Vladimir','Volibear','Warwick','Wukong','Xayah',
    'Xerath','Xin Zhao','Yasuo','Yone','Yorick','Yuumi','Zac','Zed','Zeri','Ziggs','Zilean','Zoe','Zyra'
  ]
};

function draftGames() { return Object.keys(DRAFT_FORMATS); }
function hasDraft(game) { return !!DRAFT_FORMATS[game]; }
function champions(game) { return CHAMPIONS[game] || []; }

function buildDraft(game) {
  return (DRAFT_FORMATS[game] || []).map(s => ({ action: s[0], teamIdx: s[1] }));
}
function resolveSide(teamIdx, teamStart) {
  const other = teamStart === 'a' ? 'b' : 'a';
  return teamIdx === 0 ? (teamStart || 'a') : other;
}

module.exports = { DRAFT_FORMATS, CHAMPIONS, draftGames, hasDraft, champions, buildDraft, resolveSide };
