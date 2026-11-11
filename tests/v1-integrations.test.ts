import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Engine } from '../packages/superiss/engine.ts';
import { object, type Obj } from '../packages/superiss/ts/util.ts';
import { _test as forge } from '../sisf/sisf.ts';

const repo = dirname(dirname(fileURLToPath(import.meta.url))), launcher = join(repo, 'bin/sis-v1');
const env: NodeJS.ProcessEnv = { ...process.env, SIS_DIRECT: '1', SIS_SNAPSHOT: '0', PYTHONDONTWRITEBYTECODE: '1' };
for (const key of ['SIS_DB', 'SIS_SOCK', 'SIS_HTTP', 'SIS_IMPL', 'SIS_ADMIN_TOKEN', 'SIS_CONTROLLER_LOCK_FD', 'SIS_SERVICE_LOCK_FD']) delete env[key];
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sis-integrated-'))), work = join(root, 'work'), db = join(root, 'tasks.db');
  mkdirSync(work); writeFileSync(join(work, 'input'), 'accepted'); const engine = new Engine(db);
  const create = (id: string, cmd = 'printf x >> attempts; cp input output', oracle = 'test "$(cat output)" = accepted') => engine.dispatch('create', { id, title: id, owner: 'worker', budget_eur: 0, allowed_paths: ['input'], oracle_cmd: oracle, meta: { local_zero: true, execution: { cmd, cwd: work, replay_safe: false, oracle_replay_safe: true } } });
  return { root, work, db, engine, create, async close() { await engine.shutdown(); engine.db.close(); rmSync(root, { recursive: true, force: true }); } };
}
function run(db: string, id: string, extra: string[] = []) { return spawnSync(launcher, ['run', '--db', db, '--issue', id, '--actor', 'worker', '--timeout', '3', '--deadline', '20', ...extra], { env, encoding: 'utf8', timeout: 25000 }); }
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise<void>(resolve => child.once('close', () => resolve())); child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([ended, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('owned fixture failed to drain')), 5000); })]); }
  finally { if (timer) clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await ended; } }
}

test('versioned launcher completes a real zero-cost workflow, proof, close and replay readback', { skip: process.platform !== 'darwin', timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.create('one'); const result = run(f.db, 'one'); assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(join(f.work, 'output'), 'utf8'), 'accepted');
    const shown = object(await f.engine.dispatch('show', { id: 'one' })); assert.equal(object(shown.issue).status, 'closed');
    const proofs = f.engine.rows('SELECT * FROM proofs WHERE issue=?', 'one'); assert.equal(proofs.length, 1); assert.equal(proofs[0].passed, 1);
    assert.ok((shown.events_tail as Obj[]).some(e => e.op === 'close' && object(e.data).proof_id === proofs[0].proof_id));
    assert.equal(run(f.db, 'one', ['--resume']).status, 0); assert.equal(readFileSync(join(f.work, 'attempts'), 'utf8'), 'x');
  } finally { await f.close(); }
});

test('known command failure remains unclosed and explicit resume never reruns it', { skip: process.platform !== 'darwin', timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.create('failure', 'printf x >> attempts; exit 7'); const first = run(f.db, 'failure'); assert.notEqual(first.status, 0); assert.match(first.stderr, /run_failed/);
    assert.notEqual(run(f.db, 'failure', ['--resume']).status, 0); assert.equal(readFileSync(join(f.work, 'attempts'), 'utf8'), 'x');
    assert.equal(f.engine.rows('SELECT * FROM proofs WHERE issue=?', 'failure').length, 0); assert.notEqual(f.engine.issue('failure').status, 'closed');
  } finally { await f.close(); }
});

test('interrupted controller persists a completed effect and resumes without repeating it', { skip: process.platform !== 'darwin', timeout: 30000 }, async () => {
  const f = await fixture(); let child: ChildProcess | undefined;
  try {
    await f.create('resume', '/bin/sleep 0.3; printf x >> attempts; cp input output');
    child = spawn(launcher, ['run', '--db', f.db, '--issue', 'resume', '--actor', 'worker', '--timeout', '3', '--deadline', '20'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '', interrupted = false; child.stdout!.on('data', data => { output += data; if (!interrupted && output.includes('worker_started')) { interrupted = true; child!.kill('SIGTERM'); } }); child.stderr!.on('data', data => { error += data; });
    const code = await new Promise<number | null>((resolve, reject) => { child!.once('error', reject); child!.once('close', resolve); });
    assert.equal(interrupted, true, output + error); assert.notEqual(code, 0); assert.match(error, /stopped/);
    assert.equal(object(object(await f.engine.dispatch('resume', { id: 'resume' })).checkpoint).next_step, 'run_passed');
    const resumed = run(f.db, 'resume', ['--resume']); assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
    assert.equal(readFileSync(join(f.work, 'attempts'), 'utf8'), 'x'); assert.equal(f.engine.issue('resume').status, 'closed');
  } finally { if (child) await stop(child); await f.close(); }
});

test('killed autorun controller leaves an uncertain effect fenced instead of replaying it', { timeout: 15000 }, async () => {
  const f = await fixture(); let child: ChildProcess | undefined;
  try {
    const cmd = 'printf x >> attempts; /bin/sleep 0.3; cp input output';
    await f.engine.dispatch('create', { id: 'uncertain', title: 'uncertain', owner: 'worker', allowed_paths: ['input'], oracle_cmd: 'true', meta: { autorun: { cmd, cwd: f.work } } });
    const claim = object(await f.engine.dispatch('acquire', { id: 'uncertain', actor: 'worker', ttl: 600 }));
    const job = object((object(await f.engine.dispatch('outbox_export', { actor: 'first', kind: 'autorun', ttl: 120 })).jobs as Obj[])[0]);
    const args = { id: 'uncertain', actor: 'worker', epoch: claim.epoch, cwd: f.work, kind: 'run', cmd, timeout_secs: 2, outbox_id: job.outbox_id, delivery_actor: job.delivery_actor, delivery_epoch: job.delivery_epoch, idem: job.idempotency_key };
    child = spawn(launcher, ['attest', JSON.stringify(args), '--db', f.db], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr!.on('data', data => { error += data; });
    const until = Date.now() + 3000; while (!existsSync(join(f.work, 'attempts')) && Date.now() < until && child.exitCode === null) await delay(5);
    assert.equal(existsSync(join(f.work, 'attempts')), true, error); assert.equal(child.exitCode, null, error);
    const ended = new Promise<void>(resolve => child!.once('close', () => resolve())); child.kill('SIGKILL'); await ended;
    const drained = Date.now() + 3000; while (!existsSync(join(f.work, 'output')) && Date.now() < drained) await delay(10);
    assert.equal(existsSync(join(f.work, 'output')), true); assert.equal(f.engine.rows('SELECT * FROM attests WHERE issue=?', 'uncertain').length, 0);
    f.engine.run('UPDATE sis_ts_delivery_leases SET lease_until=0 WHERE outbox_id=?', job.outbox_id);
    assert.deepEqual(object(await f.engine.dispatch('outbox_export', { actor: 'second', kind: 'autorun' })).jobs, []);
    assert.equal(f.engine.row('SELECT state FROM outbox WHERE id=?', job.outbox_id)?.state, 'failed');
    assert.match(String(object(f.engine.events().find(e => e.op === 'outbox_fail')?.data).err), /uncertain/);
    assert.equal(readFileSync(join(f.work, 'attempts'), 'utf8'), 'x');
  } finally { if (child) await stop(child); await f.close(); }
});

test('foreign claims and caller-supplied runtime overrides cannot execute a job', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await f.create('foreign'); await f.engine.dispatch('acquire', { id: 'foreign', actor: 'foreign', ttl: 60 });
    assert.notEqual(run(f.db, 'foreign').status, 0); assert.equal(existsSync(join(f.work, 'output')), false);
    const override = run(f.db, 'foreign', ['--sis', '/bin/true']); assert.notEqual(override.status, 0); assert.equal(existsSync(join(f.work, 'output')), false);
  } finally { await f.close(); }
});

test('service defaults are available but a service cannot silently select the reference runtime', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const defaults = spawnSync(launcher, ['service', 'defaults'], { env, encoding: 'utf8', timeout: 5000 }); assert.equal(defaults.status, 0, defaults.stderr); assert.equal(JSON.parse(defaults.stdout).service.extraSpendEur, 0);
    const config = join(f.root, 'config.json'); writeFileSync(config, JSON.stringify({ sis: join(repo, 'bin/sis') }));
    const refused = spawnSync(launcher, ['service', 'foreground', '--config', config], { env, encoding: 'utf8', timeout: 5000 }); assert.notEqual(refused.status, 0); assert.match(refused.stderr, /version|runtime/i);
  } finally { await f.close(); }
});

test('a version-bound foreground service closes a real isolated task and drains its own workers', { skip: process.platform !== 'darwin', timeout: 20000 }, async () => {
  const f = await fixture(); let service: ChildProcess | undefined;
  try {
    await f.engine.dispatch('goal', { id: 'service-goal', name: 'fixture', owner: 'worker' });
    await f.engine.dispatch('create', { id: 'service-job', title: 'fixture', owner: 'worker', budget_eur: 0, allowed_paths: ['input'], oracle_cmd: 'test -s output', meta: { parent: 'service-goal', local_zero: true, execution: { cmd: 'cp input output', cwd: f.work, replay_safe: true, oracle_replay_safe: true } } });
    const config = join(f.root, 'service.json'), state = join(f.root, 'state'); writeFileSync(config, JSON.stringify({ id: 'integrated', db: f.db, goal: 'service-goal', actor: 'worker', stateDir: state, sis: launcher, jobRoot: f.work, pollMs: 200, timeoutSecs: 3, deadlineSecs: 15 }));
    service = spawn(launcher, ['service', 'foreground', '--config', config], { env, stdio: ['ignore', 'ignore', 'pipe'] }); let error = ''; service.stderr!.on('data', data => { error += data; });
    const until = Date.now() + 10000; while (f.engine.issue('service-job').status !== 'closed' && Date.now() < until && service.exitCode === null) await delay(50);
    assert.equal(f.engine.issue('service-job').status, 'closed', error); await stop(service); assert.equal(service.exitCode, 0, error);
    const saved = JSON.parse(readFileSync(join(state, 'integrated.state.json'), 'utf8')) as { currentWorkers: unknown[]; outcomes: Record<string, { terminal: boolean; code: number }> };
    assert.equal(saved.currentWorkers.length, 0); assert.equal(saved.outcomes['service-job'].terminal, true); assert.equal(saved.outcomes['service-job'].code, 0);
  } finally { if (service) await stop(service); await f.close(); }
});

test('Forge consumes the TypeScript single-frame wait-watch then the next socket response', { timeout: 10000 }, async () => {
  const f = await fixture(), sock = join(f.root, 'runtime.sock');
  const daemon = spawn(launcher, ['serve', '--db', f.db, '--sock', sock], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const client = new forge.Sis({ db: f.db, sock, port: '8766', host: '127.0.0.1', state: join(f.root, 'forge.db'), repos: {}, gitea: null, lanes: {} });
  try {
    let error = ''; daemon.stderr!.on('data', data => { error += data; }); const until = Date.now() + 3000; while (!existsSync(sock) && Date.now() < until && daemon.exitCode === null) await delay(20); assert.ok(existsSync(sock), error);
    const context = await client.call('context'); assert.equal(context.data.capabilities.version, '1.5.1');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { const watched = await Promise.race([client.call('watch', { after: 9007199254740991, wait: 0.05 }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Forge waited for a nonexistent second watch frame')), 800); })]); assert.equal(watched.ok, true); assert.deepEqual(watched.data.events, []); }
    finally { if (timer) clearTimeout(timer); }
    const stats = await client.call('stats'); assert.equal(stats.ok, true); assert.equal(typeof stats.data.total, 'number');
  } finally { client.close(); await stop(daemon); await f.close(); }
});
