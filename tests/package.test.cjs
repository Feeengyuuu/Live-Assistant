const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildPackage, crc32 } = require('../scripts/build-package.cjs');

// Keep this expectation independent from the builder so removing a required asset fails a test.
const EXPECTED_FILES = [
  'LICENSE', 'NOTICE.md', 'icon.png', 'manifest.json',
  'src/assets/title-wordmark.png', 'src/background.js', 'src/popup.html', 'src/popup.js', 'src/thumbnails.js',
];
const WORDMARK_FIXTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN/8AAAAASUVORK5CYII=',
  'base64',
);

function fixture(t) {
  const base = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'live-assistant-package-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), base, 'cleanup must stay inside its own temporary directory');
    assert.match(path.basename(resolved), /^live-assistant-package-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  for (const name of EXPECTED_FILES) {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, name === 'src/assets/title-wordmark.png' ? WORDMARK_FIXTURE : `fixture ${name}\n`);
  }
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    version: '1.3.4', background: { service_worker: '/src/background.js' },
    action: { default_popup: '/src/popup.html' }, icons: { 128: 'icon.png' },
  }));
  return root;
}

function readArchive(filename) {
  const bytes = fs.readFileSync(filename);
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  const count = bytes.readUInt16LE(end + 10);
  const result = new Map();
  let central = bytes.readUInt32LE(end + 16);
  for (let entry = 0; entry < count; entry++) {
    assert.equal(bytes.readUInt32LE(central), 0x02014b50);
    assert.equal(bytes.readUInt16LE(central + 10), 0, 'stored ZIP method does not depend on a compressor');
    const filenameLength = bytes.readUInt16LE(central + 28);
    const name = bytes.subarray(central + 46, central + 46 + filenameLength).toString('utf8');
    const local = bytes.readUInt32LE(central + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const dataStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const size = bytes.readUInt32LE(central + 24);
    result.set(name, bytes.subarray(dataStart, dataStart + size));
    central += 46 + filenameLength + bytes.readUInt16LE(central + 30) + bytes.readUInt16LE(central + 32);
  }
  assert.equal(central, end, 'central directory ends immediately before the ZIP footer');
  return result;
}

test('package contains exactly the runtime and complete attribution files, excluding private and development files', (t) => {
  const root = fixture(t);
  for (const name of ['output/account-data.json', 'backup-20260418/src/popup.js', 'src/private-account.json', 'src/assets/private-account.json', '.git/config']) {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, 'must never ship');
  }
  const result = buildPackage({ rootDir: root });
  const archive = readArchive(result.archivePath);
  assert.deepEqual([...archive.keys()], EXPECTED_FILES);
  assert.deepEqual(result.files, EXPECTED_FILES);
  assert.deepEqual(archive.get('src/assets/title-wordmark.png'), WORDMARK_FIXTURE, 'wordmark binary bytes are preserved');
  for (const [name, bytes] of archive) assert.deepEqual(bytes, fs.readFileSync(path.join(root, name)));
  assert.equal(path.basename(result.archivePath), 'live-assistant-1.3.4.zip');
  assert.equal(result.sha256, crypto.createHash('sha256').update(fs.readFileSync(result.archivePath)).digest('hex'));
  assert.equal(fs.readFileSync(`${result.archivePath}.sha256`, 'utf8'), `${result.sha256}  live-assistant-1.3.4.zip\n`);
});

test('identical file bytes produce identical archives despite filesystem timestamp changes', (t) => {
  const root = fixture(t);
  const first = buildPackage({ rootDir: root, outputDir: path.join(root, 'first') });
  for (const name of EXPECTED_FILES) fs.utimesSync(path.join(root, name), new Date(0), new Date());
  const second = buildPackage({ rootDir: root, outputDir: path.join(root, 'second') });
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(fs.readFileSync(first.archivePath), fs.readFileSync(second.archivePath));
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'CRC-32 matches the standard reference vector');
});

test('missing attribution and unpackaged manifest entry points fail before writing an archive', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'NOTICE.md'), '');
  assert.throws(() => buildPackage({ rootDir: root }), /attribution file is empty/);
  assert.equal(fs.existsSync(path.join(root, 'dist')), false);
  fs.writeFileSync(path.join(root, 'NOTICE.md'), 'Upstream and fork attribution');
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.background.service_worker = '/src/not-packaged.js';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => buildPackage({ rootDir: root }), /not in the package allowlist/);
});

test('a missing title wordmark fails packaging instead of shipping a broken popup', (t) => {
  const root = fixture(t);
  fs.unlinkSync(path.join(root, 'src/assets/title-wordmark.png'));
  assert.throws(() => buildPackage({ rootDir: root }), /ENOENT/);
  assert.equal(fs.existsSync(path.join(root, 'dist')), false);
});
