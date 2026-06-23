const fs = require('fs');
const path = require('path');

function listThemes(themesDir) {
  if (!fs.existsSync(themesDir)) return [];

  return fs.readdirSync(themesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const themePath = path.join(themesDir, entry.name, 'theme.json');
      if (!fs.existsSync(themePath)) {
        return { id: entry.name, valid: false };
      }

      try {
        const manifest = JSON.parse(fs.readFileSync(themePath, 'utf8'));
        return { id: entry.name, valid: true, manifest };
      } catch {
        return { id: entry.name, valid: false };
      }
    });
}

module.exports = {
  listThemes
};
