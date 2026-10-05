const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
for (const file of fs.readdirSync(path.join(root, 'src')).filter(name => name.endsWith('.js'))) {
  execFileSync(process.execPath, ['--check', path.join(root, 'src', file)], { stdio: 'inherit' });
}
for (const file of [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.icons)]) {
  if (!fs.existsSync(path.join(root, file.replace(/^\//, '')))) throw new Error(`Missing extension entry: ${file}`);
}
console.log('JavaScript syntax and manifest entry files verified.');
