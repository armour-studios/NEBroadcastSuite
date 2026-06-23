const fs = require('fs');
const path = require('path');
const fsp = require('fs/promises');

const EDITABLE_EXT = new Set(['.html', '.css', '.js']);

function createOverlayEditor({ overlayDir, overridesDir }) {
  function normalizeRel(input) {
    let rel = (input || '').toString().replace(/\\/g, '/').trim();
    if (!rel) throw new Error('Missing path');
    if (rel.startsWith('/')) rel = rel.slice(1);
    if (rel.includes('..')) throw new Error('Invalid path');
    const ext = path.extname(rel).toLowerCase();
    if (!EDITABLE_EXT.has(ext)) throw new Error('Only .html, .css, and .js files can be edited');
    return rel;
  }

  function originalPath(rel) {
    return path.join(overlayDir, rel);
  }

  function overridePath(rel) {
    return path.join(overridesDir, rel);
  }

  async function readFileSafe(filePath) {
    return fsp.readFile(filePath, 'utf8');
  }

  async function getSource(relInput) {
    const rel = normalizeRel(relInput);
    const orig = originalPath(rel);
    if (!fs.existsSync(orig)) throw new Error('Original file not found');
    const isOverride = fs.existsSync(overridePath(rel));
    const content = await readFileSafe(isOverride ? overridePath(rel) : orig);
    const original = await readFileSafe(orig);
    return { path: `/${rel}`, rel, content, isOverride, originalLength: original.length };
  }

  async function saveOverride(relInput, content) {
    const rel = normalizeRel(relInput);
    if (!fs.existsSync(originalPath(rel))) throw new Error('Original file not found');
    await fsp.mkdir(path.dirname(overridePath(rel)), { recursive: true });
    await fsp.writeFile(overridePath(rel), content, 'utf8');
    return { path: `/${rel}`, rel, isOverride: true };
  }

  async function revert(relInput) {
    const rel = normalizeRel(relInput);
    const ovr = overridePath(rel);
    if (fs.existsSync(ovr)) await fsp.unlink(ovr);
    return { path: `/${rel}`, rel, isOverride: false };
  }

  async function listOverrides() {
    if (!fs.existsSync(overridesDir)) return [];
    const out = [];
    async function walk(dir, prefix) {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
        if (ent.isDirectory()) await walk(path.join(dir, ent.name), rel);
        else if (EDITABLE_EXT.has(path.extname(ent.name).toLowerCase())) out.push(`/${rel}`);
      }
    }
    await walk(overridesDir, '');
    return out.sort();
  }

  function resolveFileForRequest(urlPath) {
    let rel = (urlPath || '/').replace(/^\//, '') || 'index.html';
    if (!path.extname(rel)) rel += '.html';
    try {
      normalizeRel(rel);
    } catch (e) {
      return null;
    }
    const ovr = overridePath(rel);
    if (fs.existsSync(ovr)) return ovr;
    const orig = originalPath(rel);
    if (fs.existsSync(orig)) return orig;
    return null;
  }

  return {
    getSource,
    saveOverride,
    revert,
    listOverrides,
    resolveFileForRequest
  };
}

module.exports = { createOverlayEditor };