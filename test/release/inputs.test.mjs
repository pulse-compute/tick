import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseInputs } from '../../scripts/prepare-release.mjs';

test('accepts exact beta and stable release versions', () => {
  assert.deepEqual(releaseInputs('0.1.0-beta.1', 'beta'), { version: '0.1.0-beta.1', tag: 'beta' });
  assert.deepEqual(releaseInputs('1.0.0', 'latest'), { version: '1.0.0', tag: 'latest' });
  assert.deepEqual(releaseInputs('1.0.0-rc.2', 'next'), { version: '1.0.0-rc.2', tag: 'next' });
});

test('rejects versions npm cannot represent as exact releases and untrusted input', () => {
  for (const version of [undefined, '', '0.0.0', 'v1.0.0', '^1.0.0', '01.2.3', '1.0.0-beta.01',
    '1.0.0+build', '1.0', '1.0.0;echo secret', '1.0.0\n', '9007199254740992.0.0']) {
    assert.throws(() => releaseInputs(version, 'beta'), /version must/);
  }
});

test('requires an explicit supported tag and keeps prereleases off latest', () => {
  for (const tag of [undefined, '', 'Beta', '--access=restricted', '1.0.0']) {
    assert.throws(() => releaseInputs('1.0.0', tag), /tag must/);
  }
  assert.throws(() => releaseInputs('0.1.0-beta.1', 'latest'), /prereleases cannot/);
});
