import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('stages an installable release from committed private source without changing it', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tick-release-test-'));
  const root = resolve('.'), npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const run = (command, args, cwd = fixture) => execFileSync(command, args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RELEASE_VERSION: '0.1.0-beta.1', RELEASE_TAG: 'beta' },
  });
  try {
    for (const path of ['.gitignore', 'package.json', 'tsconfig.json', 'src', 'docs', 'scripts', 'README.md']) {
      await cp(join(root, path), join(fixture, path), { recursive: true });
    }
    await symlink(join(root, 'node_modules'), join(fixture, 'node_modules'), 'dir');
    run('git', ['init', '-q']);
    run('git', ['add', '.']);
    run('git', ['-c', 'user.name=Tick Test', '-c', 'user.email=tick-test@example.invalid',
      'commit', '-qm', 'isolated release source']);
    const source = await readFile(join(fixture, 'package.json'), 'utf8');
    const commit = run('git', ['rev-parse', 'HEAD']).trim();
    run(process.execPath, ['scripts/prepare-release.mjs', '--output', 'pkg/test']);
    const manifest = JSON.parse(await readFile(join(fixture, 'pkg/test/manifest.json'), 'utf8'));
    const tarball = join(fixture, 'pkg/test', manifest.artifact.filename);
    const bytes = await readFile(tarball);
    assert.equal(manifest.git.commit, commit);
    assert.equal(manifest.artifact.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(manifest.artifact.integrity, 'sha512-' + createHash('sha512').update(bytes).digest('base64'));
    assert.equal(manifest.published, false);
    assert.equal(manifest.certified, false);
    const packaged = JSON.parse(run('tar', ['-xOzf', tarball, 'package/package.json']));
    assert.equal(packaged.name, '@pulse-compute/tick');
    assert.equal(packaged.version, '0.1.0-beta.1');
    assert.equal(packaged.private, undefined);
    assert.equal(packaged.devDependencies, undefined);
    assert.equal(packaged.scripts, undefined);
    assert.equal(packaged.gitHead, commit);
    assert.deepEqual(packaged.publishConfig, { access: 'public', registry: 'https://registry.npmjs.org/', tag: 'beta' });
    assert.equal(await readFile(join(fixture, 'package.json'), 'utf8'), source);
    assert.equal(run('git', ['status', '--porcelain']).trim(), '');

    const consumer = await mkdtemp(join(tmpdir(), 'tick-release-consumer-'));
    try {
      await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
      run(npm, ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball], consumer);
      const exports = Object.keys(packaged.exports);
      await writeFile(join(consumer, 'smoke.mjs'), exports.map((path) =>
        `import ${JSON.stringify('@pulse-compute/tick' + (path === '.' ? '' : path.slice(1)))};`).join('\n'));
      run(process.execPath, ['smoke.mjs'], consumer);
      run(npm, ['publish', tarball, '--offline', '--dry-run', '--ignore-scripts', '--access', 'public',
        '--tag', 'beta', '--registry', 'https://registry.npmjs.org/'], consumer);
    } finally { await rm(consumer, { recursive: true, force: true }); }

    assert.throws(() => run(process.execPath, ['scripts/prepare-release.mjs', '--output', 'pkg/test']), /Command failed/);
    assert.throws(() => run(process.execPath, ['scripts/prepare-release.mjs', '--output', '../outside']), /output must/);
    await writeFile(join(fixture, 'README.md'), source);
    assert.throws(() => run(process.execPath, ['scripts/prepare-release.mjs', '--output', 'pkg/dirty']), /dirty-checkout/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
