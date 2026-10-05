const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyRelease } = require('../scripts/verify-release.cjs');

test('release accepts its exact manifest version and rejects a mislabeled artifact', () => {
  assert.equal(verifyRelease('v1.3.4', { version:'1.3.4' }), '1.3.4');
  assert.throws(() => verifyRelease('v1.3.3', { version:'1.3.4' }), /does not match/);
  for (const tag of ['', 'main', 'v1.3.4\nmalformed', 'v1.3.4;other', 'refs/heads/main']) {
    assert.throws(() => verifyRelease(tag, { version:'1.3.4' }));
  }
});
