import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { packageRelease } from '../tools/package-v1.ts';
import { Engine } from '../packages/superiss/engine.ts';

const env: NodeJS.ProcessEnv = { ...process.env, SIS_DIRECT: '1', PYTHONDONTWRITEBYTECODE: '1' };
for (const key of ['SIS_DB', 'SIS_SOCK', 'SIS_HTTP', 'SIS_IMPL', 'SIS_ADMIN_TOKEN', 'SIS_CONTROLLER_LOCK_FD', 'SIS_SERVICE_LOCK_FD']) delete env[key];

test('optional adapters are hash-bound, relocated and executable without the source tree', { timeout: 60000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sis-adapters-'))); let engine: Engine | undefined, daemon: ChildProcess | undefined;
  try {
    const built = join(root, 'built'), home = join(root, 'relocated'), data = join(root, 'data'), work = join(data, 'work'); mkdirSync(work, { recursive: true }); writeFileSync(join(work, 'input'), 'accepted');
    const release = await packageRelease(built, { adapters: true }); assert.equal(release.version, '1.3.0'); assert.deepEqual(release.adapters, ['workflow', 'service', 'forge']);
    for (const path of ['tools/v1-integrations.ts', 'tools/sis_runner.py', 'tools/sis_workflow.py', 'tools/service.ts', 'tools/service-lock.py', 'tools/service-soak.ts', 'sisf/sisf.ts']) assert.ok(release.files[path], path);
    renameSync(built, home); const launcher = join(home, 'bin/sis'), db = join(data, 'tasks.db');
    engine = new Engine(db); await engine.dispatch('create', { id: 'packaged', title: 'portable', owner: 'worker', budget_eur: 0, allowed_paths: ['input'], oracle_cmd: 'test "$(cat output)" = accepted', meta: { local_zero: true, execution: { cmd: 'cp input output', cwd: work, replay_safe: true, oracle_replay_safe: true } } });
    const defaults = spawnSync(launcher, ['service', 'defaults'], { cwd: home, env, encoding: 'utf8', timeout: 5000 }); assert.equal(defaults.status, 0, defaults.stderr); assert.equal(JSON.parse(defaults.stdout).service.extraSpendEur, 0);
    const sock = join(data, 'tasks.sock'); daemon = spawn(launcher, ['serve', '--db', db, '--sock', sock], { cwd: home, env, stdio: 'ignore' });
    for (let i = 0; i < 100 && !existsSync(sock) && daemon.exitCode === null; i++) await delay(20);
    assert.equal(existsSync(sock), true, 'packaged daemon did not bind its isolated socket');
    const forge = spawnSync(launcher, ['forge', 'health', '--db', db, '--sock', sock], { cwd: home, env, encoding: 'utf8', timeout: 5000 }); assert.equal(forge.status, 0, forge.stdout + forge.stderr); assert.equal(JSON.parse(forge.stdout).sis_daemon, true);
    if (process.platform === 'darwin') {
      const workflow = spawnSync(launcher, ['run', '--db', db, '--issue', 'packaged', '--actor', 'worker', '--timeout', '3', '--deadline', '20'], { cwd: home, env, encoding: 'utf8', timeout: 25000 }); assert.equal(workflow.status, 0, workflow.stdout + workflow.stderr); assert.equal(engine.issue('packaged').status, 'closed'); assert.equal(readFileSync(join(work, 'output'), 'utf8'), 'accepted');
    }
    assert.equal(existsSync(join(home, '.venv')), false);
  } finally {
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) { const ended = new Promise<void>(resolve => daemon!.once('close', () => resolve())); daemon.kill('SIGTERM'); const timer = setTimeout(() => daemon!.kill('SIGKILL'), 5000); try { await ended; } finally { clearTimeout(timer); } }
    if (engine) { await engine.shutdown(); engine.db.close(); } rmSync(root, { recursive: true, force: true });
  }
});
