// Game Config bundles (state.gameConfigs[gameId]) — producer-authored maps / characters / roles /
// role icons that extend a built-in game. normalizeGameConfig() is the single gate every bundle
// passes through (Save, Import, Export) so the merge-by-id in veto.js / draft.js always gets clean
// rows: stable ids, no blank overrides, bounded image sizes.

const MAX_ITEMS = 400;
const MAX_IMAGE_CHARS = 4 * 1024 * 1024;   // ~3MB of base64 — uploads are downscaled client-side long before this

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 80);

function slugify(name) {
  return String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Images are an uploaded data-URI, a served path (/assets/…) or an http(s) URL. Anything else
// (javascript:, file paths, oversize blobs) is dropped rather than stored.
function cleanImage(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || s.length > MAX_IMAGE_CHARS) return '';
  if (/^data:image\/(png|jpe?g|webp|gif|svg\+xml|avif);/i.test(s)) return s;
  if (/^(https?:\/\/|\/)[^\s"'<>]+$/i.test(s)) return s;
  return '';
}

// rows: client rows [{id,name,image,<extra>}]; built: the game's built-in list [{id,name,...}].
// An id is kept when it names a built-in row (that's an override); otherwise the row adopts the
// built-in id whose NAME it matches, or a slug of its own name — never the editor's random uid,
// so re-saving the same bundle doesn't mint duplicates.
function normalizeRows(rows, built, extraKey) {
  const builtById = {}, builtByName = {};
  (built || []).forEach((b) => { if (b && b.id) { builtById[b.id] = b; if (b.name) builtByName[String(b.name).toLowerCase()] = b; } });
  const out = {};
  (Array.isArray(rows) ? rows : []).slice(0, MAX_ITEMS).forEach((r) => {
    if (!r || typeof r !== 'object') return;
    const name = str(r.name, 60);
    const base = builtById[r.id] || builtByName[name.toLowerCase()];
    const id = base ? base.id : slugify(name);
    if (!id) return;                       // unnamed new row — nothing to key it on
    const row = { id };
    if (name && !(base && String(base.name || '').toLowerCase() === name.toLowerCase())) row.name = name;   // an unchanged name isn't an override
    const image = cleanImage(r.image);
    if (image) row.image = image;
    const extra = str(r[extraKey], 40);
    if (extra) row[extraKey] = extra;
    // A brand-new row must at least carry a name; an override only carries what it changes, so a
    // blank field never wipes the built-in value in the {...built, ...custom} merge.
    if (!base && !row.name) return;
    out[id] = row;
  });
  return Object.values(out);
}

function normalizeGameConfig(bundle, built) {
  const b = (bundle && typeof bundle === 'object') ? bundle : {};
  const bi = built || {};
  const roles = [];
  const seen = new Set();
  (Array.isArray(b.roles) ? b.roles : []).slice(0, 40).forEach((r) => {
    const v = str(r, 30); const k = v.toLowerCase();
    if (v && !seen.has(k)) { seen.add(k); roles.push(v); }
  });
  const roleIcons = {};
  const ri = (b.roleIcons && typeof b.roleIcons === 'object') ? b.roleIcons : {};
  Object.keys(ri).slice(0, 60).forEach((k) => {
    const key = str(k, 30).toLowerCase(); const img = cleanImage(ri[k]);
    if (key && img) roleIcons[key] = img;
  });
  const modes = (Array.isArray(b.modes) ? b.modes : []).slice(0, 60)
    .filter((m) => m && str(m.name, 60))
    .map((m) => ({ id: str(m.id, 40) || slugify(m.name), name: str(m.name, 60), description: str(m.description, 200) }));
  return {
    ...b,                                   // keeps keys owned elsewhere (e.g. pois from set_br_pois)
    format: 'ne-game-config', version: 1,
    game: str(b.game, 40),
    configId: str(b.configId, 80), author: str(b.author, 60), gameVersion: str(b.gameVersion, 60),
    maps: normalizeRows(b.maps, bi.maps, 'type'),
    characters: normalizeRows(b.characters, bi.characters, 'role'),
    roles, roleIcons, modes
  };
}

module.exports = { normalizeGameConfig, slugify, cleanImage };
