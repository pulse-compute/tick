// Prepare a publishable tarball; this script never publishes or changes source metadata.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm, chmod } from 'node:fs/promises';
import { resolve, relative, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

export function releaseInputs(version, tag) {
  const number = '(?:0|[1-9][0-9]*)';
  const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
  const pattern = new RegExp(`^${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?$`);
  if (typeof version !== 'string' || version.length > 128 || pattern.exec(version)?.[0] !== version || version === '0.0.0'
    || version.split('-')[0].split('.').some((part) => !Number.isSafeInteger(Number(part)))) {
    throw new Error('version must be an exact nonzero SemVer without build metadata');
  }
  if (!['beta', 'next', 'latest'].includes(tag)) throw new Error('tag must be beta, next or latest');
  if (tag === 'latest' && version.includes('-')) throw new Error('prereleases cannot use latest');
  return { version, tag };
}

async function main() {
  const { version, tag } = releaseInputs(process.env.RELEASE_VERSION, process.env.RELEASE_TAG);
  const args = process.argv.slice(2), root = process.cwd();
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const run = (command, values, cwd = root) => execFileSync(command, values, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (args.length === 1 && args[0] === '--validate') {
    const [major, minor, patch] = run(npm, ['--version']).trim().split('.').map(Number);
    if (!(major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1))))) {
      throw new Error('publishing requires npm >=11.5.1');
    }
    console.log(`Release inputs valid: @pulse-compute/tick@${version} (${tag}).`);
    return;
  }
  if (args.length !== 2 || args[0] !== '--output') throw new Error('usage: --output pkg/FRESH_COHORT');
  const output = resolve(root, args[1]), cohort = relative(resolve(root, 'pkg'), output);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(cohort) || cohort.includes(sep)) throw new Error('output must be a fresh directory under pkg');
  await mkdir(resolve(root, 'pkg'), { recursive: true });
  await mkdir(output, { mode: 0o700 }); // An existing output is never reused.
  const source = `pkg/${cohort}-source`;
  run(process.execPath, ['scripts/prepare-artifact.mjs', '--output', source]);
  const sourceManifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  const sourceTarball = resolve(source, sourceManifest.artifact.filename);
  const stage = await mkdtemp(join(tmpdir(), 'tick-release-'));
  try {
    run('tar', ['-xzf', sourceTarball, '-C', stage]);
    const packageRoot = join(stage, 'package'), metadataPath = join(packageRoot, 'package.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    metadata.version = version;
    delete metadata.private;
    delete metadata.scripts;
    delete metadata.devDependencies;
    metadata.gitHead = sourceManifest.git.commit;
    metadata.publishConfig = { access: 'public', registry: 'https://registry.npmjs.org/', tag };
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
    const [packed] = JSON.parse(run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', output], packageRoot));
    const sourceFiles = run('tar', ['-tzf', sourceTarball]).trim().split('\n').sort();
    const releaseFiles = packed.files.map(({ path }) => `package/${path}`).sort();
    if (JSON.stringify(sourceFiles) !== JSON.stringify(releaseFiles)) throw new Error('release file set changed');
    for (const path of packed.files.map(({ path }) => path).filter((path) => path !== 'package.json')) {
      const original = await readFile(resolve(root, path));
      const staged = await readFile(join(packageRoot, path));
      if (!original.equals(staged)) throw new Error('release content changed');
    }
    if (run('git', ['status', '--porcelain', '--untracked-files=normal']).trim()
      || run('git', ['rev-parse', 'HEAD']).trim() !== sourceManifest.git.commit
      || run('git', ['rev-parse', 'HEAD^{tree}']).trim() !== sourceManifest.git.tree) {
      throw new Error('checkout changed during release preparation');
    }
    const tarball = join(output, packed.filename), bytes = await readFile(tarball);
    await chmod(tarball, 0o600);
    const manifest = { schema: 'tick.npm-artifact.v1', status: 'prepared', published: false, certified: false,
      createdAt: new Date().toISOString(), git: sourceManifest.git,
      package: { name: metadata.name, version, tag, access: 'public', runtimeDependencies: 0 },
      artifact: { filename: packed.filename, bytes: bytes.length, files: packed.files.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') },
      note: 'Prepared from clean committed source. Publication and provider certification are separate actions.' };
    await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(manifest, null, 2));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`Tick release preparation failed: ${error.message}`); process.exitCode = 1; });
}
