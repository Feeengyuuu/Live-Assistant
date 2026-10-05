const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyRelease } = require('./verify-release.cjs');

// Explicit runtime allowlist: repository backups, test output and local account data never enter a release.
const PACKAGE_FILES = Object.freeze([
  'LICENSE',
  'NOTICE.md',
  'icon.png',
  'manifest.json',
  'src/background.js',
  'src/popup.html',
  'src/popup.js',
  'src/thumbnails.js',
]);

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(entries) {
  const localEntries = [];
  const directoryEntries = [];
  let offset = 0;
  // Store entries without compression, with fixed 1980-01-01 timestamps. Identical source bytes
  // produce identical ZIP bytes across platforms and Node versions, without third-party dependencies.
  for (const { name, data } of entries) {
    const filename = Buffer.from(name, 'utf8');
    if (data.length > 0xffffffff || offset > 0xffffffff || filename.length > 0xffff) {
      throw new Error('Package exceeds supported classic ZIP limits.');
    }
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 filenames.
    local.writeUInt16LE(0x0021, 12); // DOS date: 1980-01-01, midnight.
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    localEntries.push(local, filename, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    directoryEntries.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  const directory = Buffer.concat(directoryEntries);
  if (entries.length > 0xffff || directory.length > 0xffffffff || offset + directory.length > 0xffffffff) {
    throw new Error('Package exceeds supported classic ZIP limits.');
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localEntries, directory, end]);
}

function readPackageFile(root, name) {
  const filename = path.join(root, ...name.split('/'));
  for (let current = filename; current !== root; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Package inputs must not be symbolic links: ${name}`);
  }
  if (!fs.statSync(filename).isFile()) throw new Error(`Package input is not a regular file: ${name}`);
  return { name, data: fs.readFileSync(filename) };
}

function buildPackage({ rootDir = path.join(__dirname, '..'), outputDir } = {}) {
  const root = fs.realpathSync(rootDir);
  const entries = PACKAGE_FILES.map(name => readPackageFile(root, name));
  const manifest = JSON.parse(entries.find(entry => entry.name === 'manifest.json').data.toString('utf8'));
  const version = verifyRelease(`v${manifest.version}`, manifest);
  for (const reference of [manifest.background?.service_worker, manifest.action?.default_popup, ...Object.values(manifest.icons || {})]) {
    if (typeof reference !== 'string' || !PACKAGE_FILES.includes(reference.replace(/^\//, ''))) {
      throw new Error(`Manifest entry is not in the package allowlist: ${reference}`);
    }
  }
  for (const name of ['LICENSE', 'NOTICE.md']) {
    if (!entries.find(entry => entry.name === name).data.toString('utf8').trim()) {
      throw new Error(`Required license/attribution file is empty: ${name}`);
    }
  }
  const archive = createZip(entries);
  const destination = path.resolve(outputDir || path.join(root, 'dist'));
  fs.mkdirSync(destination, { recursive: true });
  const filename = `live-assistant-${version}.zip`;
  const archivePath = path.join(destination, filename);
  const sha256 = crypto.createHash('sha256').update(archive).digest('hex');
  fs.writeFileSync(archivePath, archive);
  fs.writeFileSync(`${archivePath}.sha256`, `${sha256}  ${filename}\n`, 'utf8');
  return { archivePath, sha256, size: archive.length, files: [...PACKAGE_FILES], version };
}

if (require.main === module) {
  const result = buildPackage();
  console.log(`Built ${result.archivePath} (${result.size} bytes, ${result.files.length} files)`);
  console.log(`SHA-256: ${result.sha256}`);
}

module.exports = { PACKAGE_FILES, buildPackage, crc32 };
