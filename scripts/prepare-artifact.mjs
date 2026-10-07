// Private review tarball only. This command never tags, releases or publishes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { resolve, relative, basename, sep } from 'node:path';
const root = process.cwd(), npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const fail = (code) => { throw new Error(code); };
const errors = new Set(['usage', 'output-must-be-under-pkg', 'dirty-checkout', 'private-package-required',
  'runtime-dependencies-forbidden', 'unexpected-package-file', 'missing-export', 'checkout-changed', 'output-already-exists']);
const git = (...args) => run('git', args).trim();
const clean = () => { if (git('status', '--porcelain', '--untracked-files=normal')) fail('dirty-checkout'); };
const docs = ['architecture', 'fastly-kv', 'core', 'execution', 'trigger', 'bindings', 'conformance', 's3', 'operations'];
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output' || !args[1]) fail('usage');
  const output = resolve(root, args[1]), selected = relative(resolve(root, 'pkg'), output);
  if (!selected || selected.startsWith('..' + sep) || selected === '..' || selected.includes(sep)
    || !/^[A-Za-z0-9_-]{1,96}$/.test(selected)) fail('output-must-be-under-pkg');
  clean();
  const metadata = JSON.parse(await readFile('package.json', 'utf8'));
  if (metadata.private !== true || metadata.name !== '@pulse-compute/tick' || metadata.version !== '0.0.0') fail('private-package-required');
  if (['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies']
    .some((key) => Object.keys(metadata[key] ?? {}).length)) fail('runtime-dependencies-forbidden');
  const commit = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
  await mkdir(resolve(root, 'pkg'), { recursive: true });
  try { await mkdir(output, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') fail('output-already-exists'); throw e; }
  run(npm, ['run', 'build']);
  clean();
  const [packed] = JSON.parse(run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', output]));
  const files = new Set(packed.files.map((entry) => entry.path));
  const allowed = new Set(['package.json', 'README.md', ...docs.map((name) => `docs/${name}.md`)]);
  if ([...files].some((path) => !allowed.has(path) && !/^dist\/[A-Za-z0-9_/-]+(?:\.js|\.d\.ts)$/.test(path))) fail('unexpected-package-file');
  for (const entry of Object.values(metadata.exports)) {
    for (const target of Object.values(entry)) {
      if (typeof target !== 'string' || !target.startsWith('./dist/') || !files.has(target.slice(2))) fail('missing-export');
    }
  }
  if (!files.has('docs/operations.md')) fail('missing-export');
  clean();
  if (git('rev-parse', 'HEAD') !== commit || git('rev-parse', 'HEAD^{tree}') !== tree) fail('checkout-changed');
  if (basename(packed.filename) !== packed.filename || !packed.filename.endsWith('.tgz')) fail('unexpected-package-file');
  const path = resolve(output, packed.filename), bytes = await readFile(path);
  const report = { schema: 'tick.private-artifact.v1', status: 'unreleased', certified: false, publicationAuthorized: false,
    createdAt: new Date().toISOString(), git: { commit, tree }, package: { name: metadata.name, version: metadata.version, private: true, runtimeDependencies: 0 },
    artifact: { filename: packed.filename, bytes: bytes.length, files: files.size, sha256: createHash('sha256').update(bytes).digest('hex'),
      integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') },
    checks: { build: true, packedExports: true, cleanCommittedSource: true },
    note: 'Build/pack checks only. Full CI, independent review and selected-provider live gates are separate evidence; this manifest grants no release authority.' };
  await chmod(path, 0o600);
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error('Tick private artifact preparation failed: ' + (errors.has(error?.message) ? error.message : 'build-or-pack-unavailable'));
  process.exitCode = 1;
}
