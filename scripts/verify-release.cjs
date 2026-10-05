const fs = require('node:fs');
const path = require('node:path');

function verifyRelease(tag, manifest) {
  if (!/^v\d+\.\d+\.\d+(?:\.\d+)?$/.test(tag || '')) throw new Error('Release tag must be vMAJOR.MINOR.PATCH (optionally a fourth version component).');
  if (tag.slice(1) !== manifest.version) throw new Error(`Tag ${tag} does not match manifest version ${manifest.version}.`);
  return manifest.version;
}

if (require.main === module) {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../manifest.json'), 'utf8'));
  console.log(`Release version verified: ${verifyRelease(process.argv[2], manifest)}`);
}
module.exports = { verifyRelease };
