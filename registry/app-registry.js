const fs = require('fs');
const path = require('path');
const { validateManifest } = require('./manifest-schema');

const MODULES_DIR = path.join(__dirname, '..', 'modules');
const MANIFEST_CACHE_TTL = 60000;
let _manifestsCache = null;
let _cacheTime = 0;

function loadManifests() {
  const now = Date.now();
  if (_manifestsCache && (now - _cacheTime) < MANIFEST_CACHE_TTL) {
    return _manifestsCache;
  }
  const manifests = [];
  try {
    const files = fs.readdirSync(MODULES_DIR);
    for (const file of files) {
      if (file.endsWith('.module.json')) {
        const filePath = path.join(MODULES_DIR, file);
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const manifest = JSON.parse(content);
          const result = validateManifest(manifest, file);
          if (result.valid) {
            manifests.push(manifest);
          }
        } catch (e) {
          console.warn(`[registry] Failed to load ${file}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    console.error(`[registry] Failed to read modules dir: ${e.message}`);
  }
  _manifestsCache = manifests.sort((a, b) => (a.order || 0) - (b.order || 0));
  _cacheTime = now;
  return _manifestsCache;
}

function getModuleById(id) {
  return loadManifests().find((m) => m.id === id);
}

function getNavSections() {
  const manifests = loadManifests();
  const sections = {};
  for (const m of manifests) {
    if (m.showInNav !== false) {
      const section = m.navSection || 'default';
      if (!sections[section]) sections[section] = [];
      sections[section].push(m);
    }
  }
  return sections;
}

module.exports = {
  loadManifests,
  getModuleById,
  getNavSections,
  validateManifest,
};
