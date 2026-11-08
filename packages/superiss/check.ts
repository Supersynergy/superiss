import { VERSION } from './runtime.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { resolveTypeScript } from './compiler.ts';

const root = dirname(fileURLToPath(import.meta.url));
const typesOnly = process.argv.includes('--types');
process.chdir(root);
const env: NodeJS.ProcessEnv = { ...process.env, SIS_EMIT: '0' };
for (const name of ['SIS_DB', 'SIS_SOCK', 'SIS_HTTP', 'SIS_DIRECT', 'SIS_ADMIN_TOKEN', 'SIS_IMPL', 'SIS_CWD_DB', 'SIS_SYNCHRONOUS']) delete env[name];
const stages: { name: string; ms: number }[] = [];
function run(name: string, command: string, args: string[], capture = false, timeout = 180000): string {
  const start = performance.now();
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, stdio: capture ? 'pipe' : 'inherit' });
  stages.push({ name, ms: performance.now() - start });
  if (result.error) throw result.error;
  if (result.status !== 0) { if (capture) process.stderr.write((result.stdout ?? '') + (result.stderr ?? '')); throw Error(`${name}: exit ${result.status}, signal ${result.signal}`); }
  return result.stdout ?? '';
}
const compilerStart = performance.now();
const { command: compiler, version: compilerVersion } = resolveTypeScript(env, root);
stages.push({ name: 'compiler-version', ms: performance.now() - compilerStart });
assert.match(compilerVersion, /^Version 7\.1\./u, 'v1 requires TypeScript 7.1; no silent compiler fallback');
const typeRoots = process.env.SIS_TYPE_ROOTS ?? dirname(dirname(createRequire(import.meta.url).resolve('@types/node/package.json')));
assert.ok(existsSync(join(typeRoots, 'node', 'package.json')), 'Installed Node type declarations required; do not auto-install');
run('strict-types', compiler, ['--project', 'tsconfig.json', '--typeRoots', typeRoots]);
if (typesOnly) { console.log(JSON.stringify({ passed: true, compilerVersion, compilerPath: compiler, stages })); process.exit(0); }
const origin = JSON.parse(readFileSync('ORIGIN.json', 'utf8')) as { files: { source: string; sha256: string }[] };
for (const file of origin.files) {
  const original = resolve(root, '..', file.source);
  if (existsSync(original)) assert.equal(createHash('sha256').update(readFileSync(original)).digest('hex'), file.sha256, `Original changed: ${file.source}; do not overwrite or silently adopt drift`);
}
run('inherited-unit-regressions', process.execPath, ['test', 'ts/store.test.ts', '--bail'], false, 90000);
run('hybrid-concurrency-recovery', process.execPath, ['test', 'hybrid.test.ts', 'release.test.ts', '--bail'], false, 120000);
run('protocol-contract-complete', 'python3', ['tests/contract_suite.py', '--require-complete', '--serve-cmd', `${process.execPath} ${join(root, 'cli.ts')} serve`], false, 90000);
const benchmark = JSON.parse(run('paired-cache-benchmark', process.execPath, ['benchmark.ts'], true, 30000)) as unknown;
run('build-artifacts', process.execPath, ['build', 'cli.ts', 'analytics-worker.ts', '--target=bun', '--outdir=dist']);
const temp = mkdtempSync(join(tmpdir(), 'sis-v1-artifact-'));
try {
  const response = JSON.parse(run('built-cli-smoke', process.execPath, ['dist/cli.js', 'capabilities', '--db', join(temp, 'artifact.db')], true)) as Record<string, unknown>;
  assert.equal(response.version, VERSION);
  assert.equal(response.typescript, '7.1');
  assert.equal(response.sqlite_version, '3.54.1');
  const report = JSON.parse(run('built-analytics-worker-smoke', process.execPath, ['dist/cli.js', 'analytics', 'kind=all', '--db', join(temp, 'artifact.db')], true, 45000)) as Record<string, unknown>;
  assert.equal(report.consistency, 'snapshot'); assert.equal(report.authority, 'sqlite');
  const artifactHashes = Object.fromEntries(['cli.js', 'analytics-worker.js'].map(name => [name, createHash('sha256').update(readFileSync(join('dist', name))).digest('hex')]));
  const manifest = { version: VERSION, typescript: compilerVersion, runtime: process.versions.bun, sqlite: response.sqlite_version, duckdb: report.duckdb_version, operations: response.operations, artifactHashes };
  writeFileSync('dist/version.json', JSON.stringify(manifest, null, 2) + '\n');
  const receipt = join(mkdtempSync(join(tmpdir(), 'sis-v1-receipt-')), 'check.json');
  writeFileSync(receipt, JSON.stringify({ passed: true, manifest, stages, benchmark }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, version: manifest.version, compiler: manifest.typescript, sqlite: manifest.sqlite, duckdb: manifest.duckdb, receipt, stages }));
} finally { rmSync(temp, { recursive: true, force: true }); }
