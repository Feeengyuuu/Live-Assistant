const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function getManifestResources(manifest) {
  const defaultIcon = manifest.action?.default_icon;
  let actionIcons = [];
  if (typeof defaultIcon === 'string') actionIcons = [defaultIcon];
  else if (defaultIcon !== undefined) {
    if (!defaultIcon || typeof defaultIcon !== 'object' || Array.isArray(defaultIcon) || !Object.keys(defaultIcon).length) {
      throw new Error('action.default_icon must be an image path or a non-empty size-to-path object.');
    }
    actionIcons = Object.values(defaultIcon);
  }
  const files = [manifest.background?.service_worker, manifest.action?.default_popup, ...Object.values(manifest.icons || {}), ...actionIcons];
  for (const file of files) {
    if (typeof file !== 'string' || !file.trim()) throw new Error(`Invalid extension resource path: ${file}`);
  }
  return [...new Set(files)];
}

function checkManifestFiles(root, manifest) {
  for (const file of getManifestResources(manifest)) {
    const filename = path.resolve(root, file.replace(/^\//, ''));
    const relative = path.relative(root, filename);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Extension resource is outside the project: ${file}`);
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) throw new Error(`Missing extension entry: ${file}`);
  }
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  for (const file of fs.readdirSync(path.join(root, 'src')).filter(name => name.endsWith('.js'))) {
    execFileSync(process.execPath, ['--check', path.join(root, 'src', file)], { stdio: 'inherit' });
  }
  checkManifestFiles(root, manifest);
  console.log('JavaScript syntax and manifest entry files verified.');
}

module.exports = { getManifestResources, checkManifestFiles };
