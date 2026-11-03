import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packageRelease, type ReleaseManifest } from './package-v1.ts';
import { object } from '../packages/superiss/ts/util.ts';
import { resolveTypeScript } from '../packages/superiss/compiler.ts';
import { createRequire } from 'node:module';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), 'sis-v1-publish-'));
const checks: string[] = [];
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const env: NodeJS.ProcessEnv = { ...process.env, SIS_BUN: process.execPath };
for (const name of Object.keys(env)) if (name.startsWith('SIS_') && !['SIS_BUN', 'SIS_SQLITE_LIBRARY', 'SIS_DUCKDB_LIBRARY'].includes(name)) delete env[name];
try {
  const compiler = resolveTypeScript(process.env, repository);
  const typeRoots = process.env.SIS_TYPE_ROOTS ?? dirname(dirname(createRequire(import.meta.url).resolve('@types/node/package.json')));
  const types = spawnSync(compiler.command, ['--strict', '--skipLibCheck', '--noEmit', '--allowImportingTsExtensions', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--target', 'ES2023', '--types', 'node', '--typeRoots', typeRoots, 'tools/package-v1.ts', 'tools/check-v1-publication.ts', 'tools/v1-lifecycle.ts'], { cwd: repository, encoding: 'utf8', timeout: 30000 });
  assert.equal(types.status, 0, types.stdout + types.stderr);
  checks.push('strict-typescript-7.1-packaging-tools');
  const bundle = join(scratch, 'bundle');
  const manifest = packageRelease(bundle);
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.sourceHash.length, 64);
  const files = readdirSync(bundle, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(bundle.length + 1)).sort();
  assert.deepEqual(files, ['manifest.json', ...Object.keys(manifest.files)].sort());
  assert.deepEqual(JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8')) as ReleaseManifest, manifest);
  for (const [path, hash] of Object.entries(manifest.files)) assert.equal(sha(join(bundle, path)), hash, path);
  assert.ok(Object.keys(manifest.files).some(path => path.endsWith('web/board.html')));
  assert.ok(Object.hasOwn(manifest.files, 'LICENSE'));
  assert.equal(readFileSync(join(bundle, 'LICENSE'), 'utf8'), readFileSync(join(repository, 'LICENSE'), 'utf8'));
  checks.push('exact-file-manifest-sha256-and-mit-license');
  const cli = join(bundle, 'bin', 'sis'), db = join(scratch, 'source.db');
  function run(command: string, args: object = {}, database = db, overrides: NodeJS.ProcessEnv = {}) {
    const parameters = ['up', 'down', 'status'].includes(command) ? [] : [JSON.stringify(args)];
    const result = spawnSync('/bin/bash', [cli, command, ...parameters, '--db', database], { cwd: scratch, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 45000 });
    assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
    return object(JSON.parse(result.stdout));
  }
  const caps = run('capabilities');
  assert.equal(caps.version, '1.0.0'); assert.equal(caps.protocol, 2); assert.equal(caps.proof_receipts, true);
  assert.ok(Array.isArray(caps.operations)); assert.equal(caps.operations.length, 87);
  checks.push('relocated-launcher-version-and-contract');
  const portProbe = createServer();
  await new Promise<void>((resolve, reject) => { portProbe.once('error', reject); portProbe.listen(0, '127.0.0.1', resolve); });
  const address = portProbe.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>(resolve => portProbe.close(() => resolve()));
  const up = run('up', {}, db, { SIS_HTTP: String(port) });
  assert.equal(up.up, true); assert.equal(up.version, '1.0.0');
  try {
    const status = run('status'); assert.equal(status.pid, up.pid); assert.equal(status.up, true);
    const page = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(5000) });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), readFileSync(join(bundle, 'packages/superiss/web/board.html'), 'utf8'));
    const health = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(5000) });
    assert.equal(health.status, 200); assert.equal(object(await health.json()).ok, true);
    checks.push('relocated-http-board-and-health');
    assert.equal(run('up').pid, up.pid);
    const ownerPath = db + '.serve.owner.json', owner = readFileSync(ownerPath, 'utf8');
    try {
      writeFileSync(ownerPath, JSON.stringify({ ...JSON.parse(owner), pid: 1 }));
      const refused = spawnSync('/bin/bash', [cli, 'down', '--db', db], { cwd: scratch, env, encoding: 'utf8', timeout: 10000 });
      assert.notEqual(refused.status, 0); assert.equal(run('status').pid, up.pid);
    } finally { writeFileSync(ownerPath, owner); }
    const actor = 'release-verifier';
  writeFileSync(join(scratch, 'input.txt'), 'release\n');
  run('create', { id: 'smoke', title: 'Release lifecycle', oracle_cmd: 'test "$(cat input.txt)" = release', allowed_paths: ['input.txt'], owner: actor });
  assert.equal(object(object(run('resume', { id: 'smoke' }).contract).task).status, 'open');
  assert.equal(object(run('contract', { id: 'smoke' }).task).oracle_cmd, 'test "$(cat input.txt)" = release');
  const claim = run('claim', { id: 'smoke', actor });
  const fence = { id: 'smoke', actor, epoch: claim.epoch };
  run('heartbeat', fence);
  run('checkpoint', { ...fence, cwd: scratch, text: 'Bundled runtime check', next_step: 'verify then close' });
  const proof = run('verify', { ...fence, cwd: scratch, timeout_secs: 300 });
  assert.equal(proof.passed, true);
  run('close', { ...fence, proof_id: proof.proof_id });
  assert.equal(object(run('show', { id: 'smoke' }).issue).status, 'closed');
    checks.push('fenced-create-resume-contract-checkpoint-verify-close-readback');
  } finally { assert.equal(run('down').down, true); }
  assert.equal(run('status').up, false);
  checks.push('owned-up-status-down-and-foreign-receipt-preservation');
  const before = sha(db), copy = join(scratch, 'copy.db');
  run('migrate_copy', { source: db }, copy);
  assert.equal(sha(db), before);
  assert.equal(object(run('show', { id: 'smoke' }, copy).issue).status, 'closed');
  const duplicate = spawnSync('/bin/bash', [cli, 'migrate_copy', JSON.stringify({ source: db }), '--db', copy], { cwd: scratch, env, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(duplicate.status, 0);
  assert.equal(sha(db), before);
  checks.push('copy-compatibility-no-source-mutation-no-overwrite');
  assert.ok(Number(run('tokens', { text: 'Grüße 世界', encoding: 'o200k_base' }).tokens) > 0);
  const report = run('analytics');
  assert.equal(report.authority, 'sqlite'); assert.equal(report.consistency, 'snapshot');
  assert.match(String(report.duckdb_version), /^v2\.0\./u);
  checks.push('bundled-tokenizers-and-analytics-worker');
  const sock = join(scratch, 'old.sock'), commands: string[] = [];
  const server = createServer(socket => {
    let bytes = '';
    socket.on('data', data => {
      bytes += data;
      const end = bytes.indexOf('\n');
      if (end < 0) return;
      const request = JSON.parse(bytes.slice(0, end)); bytes = bytes.slice(end + 1);
      commands.push(request.cmd);
      socket.write(JSON.stringify({ ok: true, data: { db_path: realpathSync(db), project_id: 'old-project', instance_id: 'old-instance', pid: process.pid, capabilities: { version: '0.9.0', protocol: 2, proof_receipts: true } } }) + '\n');
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(sock, resolve); });
  try {
    const child = spawn('/bin/bash', [cli, 'create', '{"id":"must-not-write","title":"Blocked"}', '--db', db, '--sock', sock], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    clearTimeout(timer);
    assert.equal(code, 2, stderr); assert.match(stderr, /runtime_version_mismatch/u);
    assert.deepEqual(commands, ['context']);
    for (const command of ['up', 'status', 'down']) {
      const lifecycle = spawn('/bin/bash', [cli, command, '--db', db, '--sock', sock], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let error = ''; lifecycle.stderr.on('data', data => { error += data; });
      const timeout = setTimeout(() => lifecycle.kill('SIGKILL'), 10000);
      const result = await new Promise<number | null>((resolve, reject) => { lifecycle.once('error', reject); lifecycle.once('close', resolve); });
      clearTimeout(timeout); assert.equal(result, 1, error); assert.match(error, /runtime_version_mismatch/u);
    }
    assert.deepEqual(commands, ['context', 'context', 'context', 'context']);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  checks.push('legacy-daemon-version-rejected-before-mutation');
  console.log(JSON.stringify({ passed: true, repository, version: manifest.version, sourceHash: manifest.sourceHash, checks }));
} finally { rmSync(scratch, { recursive: true, force: true }); }
