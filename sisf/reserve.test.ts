import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Engine } from '../packages/superiss/engine.ts';
import { _test, type Cfg } from './sisf.ts';
import { forgeAction } from './workflow.ts';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-reserve-'))), repo = join(root, 'repo'); mkdirSync(repo);
  const git = (...args: string[]): string => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-qb', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(repo, '.gitignore'), '.sisf/\n'); writeFileSync(join(repo, 'f'), 'initial\n'); git('add', '.'); git('commit', '-qm', 'initial');
  const cfg: Cfg = { db: join(root, 'tasks.db'), state: join(root, 'forge.db'), sock: join(root, 'unused.sock'), host: '127.0.0.1', port: '0', repos: { default: { path: repo, base: 'main' } }, lanes: {}, gitea: null, backend: 'git', runtime: 'current' };
  const engine = new Engine(cfg.db), state = _test.openState(cfg);
  const sis = new _test.Sis(cfg);
  sis.call = async (cmd, args = {}) => {
    try { const data = await engine.dispatch(cmd, args); if (cmd === 'context') sis.project = String((data as { project_id: string }).project_id); return { ok: true, data }; }
    catch (error) { return { ok: false, error: { code: (error as { code?: string }).code, msg: (error as Error).message } }; }
  };
  const deps = _test.dependencies(cfg, sis, state);
  return { root, repo, cfg, engine, sis, state, deps, git, async cleanup() { sis.close(); await engine.shutdown(); engine.db.close(); state.close(); rmSync(root, { recursive: true, force: true }); } };
}
const task = { id: 'task', title: 'A bounded task', actor: 'worker', oracle_cmd: 'test -f f', allowed_paths: ['f'], acceptance: 'f exists' };

test('short concurrent Forge state writes do not strand a newly created worktree', async () => {
  const f = fixture();
  const holder = spawn(process.execPath, ['-e', 'import {Database} from "bun:sqlite";const db=new Database(process.argv[1]);db.exec("BEGIN IMMEDIATE");console.log("locked");setTimeout(()=>{db.exec("ROLLBACK");db.close()},500)', f.cfg.state], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stopped = new Promise<void>(resolve => holder.once('close', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => { holder.stdout.once('data', chunk => String(chunk).includes('locked') ? resolve() : reject(Error('lock acknowledgement missing'))); holder.once('error', reject); holder.once('exit', code => { if (code) reject(Error('lock holder failed')); }); });
    await f.sis.call('context'); const result = await forgeAction(f.deps, 'reserve', task);
    expect(result.ok).toBe(true); expect(result.data.bound).toBe(true);
    expect(f.state.query('SELECT actor,epoch FROM worktrees WHERE task=?').get(task.id)).toEqual({ actor: 'worker', epoch: 1 });
    expect(f.git('worktree', 'list', '--porcelain')).toContain('locked sisf:task');
  } finally { holder.kill('SIGTERM'); await stopped; await f.cleanup(); }
});

test('reserve creates its contract and exclusive claim atomically, then binds the actual fence', async () => {
  const f = fixture(); try {
    await f.sis.call('context');
    const result = await forgeAction(f.deps, 'reserve', { ...task, idem: 'reserve-one' });
    expect(result.ok).toBe(true); expect(result.data.bound).toBe(true); expect(result.data.claim.actor).toBe('worker'); expect(result.data.claim.epoch).toBe(1);
    expect(result.data.contract.oracle_cmd).toBe(task.oracle_cmd); expect(result.data.contract.acceptance).toBe(task.acceptance);
    const stored = await f.sis.call('show', { id: task.id }); expect(stored.data.issue.status).toBe('in_progress'); expect(stored.data.issue.claim_actor).toBe('worker');
    expect(f.engine.db.all('SELECT op FROM events WHERE issue=? ORDER BY seq', task.id).map(row => row.op)).toEqual(['create', 'claim']);
    expect((await f.sis.call('ready')).data).toEqual([]);
    expect(f.git('worktree', 'list', '--porcelain')).toContain('locked sisf:task');
  } finally { await f.cleanup(); }
});

test('ten contenders for one reserved task have one owner and one binding', async () => {
  const f = fixture(); try {
    await f.sis.call('context');
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => forgeAction(f.deps, 'reserve', { ...task, actor: `worker-${i}` })));
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(f.engine.db.get('SELECT COUNT(*) AS n FROM issues WHERE id=?', task.id)?.n).toBe(1);
    expect(f.engine.db.get("SELECT COUNT(*) AS n FROM events WHERE issue=? AND op='claim'", task.id)?.n).toBe(1);
    expect(f.state.query('SELECT COUNT(*) AS n FROM worktrees').get()).toEqual({ n: 1 });
  } finally { await f.cleanup(); }
});

test('a failed claim rolls back the task creation rather than exposing unclaimed work', async () => {
  const f = fixture(); try {
    await f.sis.call('context');
    const call = f.sis.call.bind(f.sis);
    f.sis.call = (cmd, args = {}) => call(cmd, cmd === 'batch' ? { ...args, ops: ((args.ops as { cmd: string; args: Record<string, unknown> }[]) ?? []).map(op => op.cmd === 'claim' ? { ...op, args: { ...op.args, actor: '' } } : op) } : args);
    const result = await forgeAction(f.deps, 'reserve', task); expect(result.ok).toBe(false);
    expect(f.engine.db.get('SELECT COUNT(*) AS n FROM issues WHERE id=?', task.id)?.n).toBe(0);
    expect(f.git('branch', '--list', 'sis/task')).toBe('');
  } finally { await f.cleanup(); }
});

test('binding failure preserves the claim and a foreign unbound directory', async () => {
  const f = fixture(); try {
    await f.sis.call('context'); const foreign = join(f.repo, '.sisf/wt/task'); mkdirSync(foreign, { recursive: true }); writeFileSync(join(foreign, 'keep'), 'foreign work');
    const result = await forgeAction(f.deps, 'reserve', task);
    expect(result.ok).toBe(false); expect(result.data.claim_preserved).toBe(true); expect(result.data.bound).toBe(false);
    expect((await f.sis.call('show', { id: task.id })).data.issue.claim_actor).toBe('worker'); expect(readFileSync(join(foreign, 'keep'), 'utf8')).toBe('foreign work');
    expect(f.state.query('SELECT task FROM worktrees').get()).toBeNull();
  } finally { await f.cleanup(); }
});

test('stable idempotency reuses the reservation but returns the current contract', async () => {
  const f = fixture(); try {
    await f.sis.call('context'); const input = { ...task, idem: 'stable-reservation' };
    const first = await forgeAction(f.deps, 'reserve', input);
    await f.engine.dispatch('update', { id: task.id, actor: 'worker', epoch: first.data.claim.epoch, acceptance: 'updated current contract' });
    const second = await forgeAction(f.deps, 'reserve', input);
    expect(second.ok).toBe(true); expect(second.data.claim.claim_id).toBe(first.data.claim.claim_id); expect(second.data.path).toBe(first.data.path);
    expect(second.data.contract.acceptance).toBe('updated current contract');
    expect(f.engine.db.get("SELECT COUNT(*) AS n FROM events WHERE issue=? AND op='claim'", task.id)?.n).toBe(1);
  } finally { await f.cleanup(); }
});

test('invalid reservation input and configured actor scope fail before task creation', async () => {
  const f = fixture(); try {
    await f.sis.call('context');
    for (const input of [{ ...task, oracle_cmd: '' }, { ...task, allowed_paths: [] }, { ...task, allowed_paths: ['../escape'] }, { ...task, actor: '' }, { ...task, ttl: 59 }]) await expect(forgeAction(f.deps, 'reserve', input)).rejects.toThrow();
    f.cfg.actors = ['another-worker']; await expect(forgeAction(f.deps, 'reserve', task)).rejects.toThrow(/actor/);
    expect(f.engine.db.get('SELECT COUNT(*) AS n FROM issues')?.n).toBe(0);
  } finally { await f.cleanup(); }
});

test('a lost native acknowledgement can be reconciled with the same key without a second claim', async () => {
  const f = fixture(); try {
    await f.sis.call('context'); const call = f.sis.call.bind(f.sis); let lose = true;
    f.sis.call = async (cmd, args = {}) => { const result = await call(cmd, args); if (cmd === 'batch' && lose) { lose = false; throw Error('synthetic acknowledgement lost'); } return result; };
    const input = { ...task, idem: 'lost-ack' };
    await expect(forgeAction(f.deps, 'reserve', input)).rejects.toThrow(/acknowledgement lost/);
    expect((await call('show', { id: task.id })).data.issue.status).toBe('in_progress');
    const retry = await forgeAction(f.deps, 'reserve', input); expect(retry.ok).toBe(true);
    expect(f.engine.db.get("SELECT COUNT(*) AS n FROM events WHERE issue=? AND op='claim'", task.id)?.n).toBe(1);
  } finally { await f.cleanup(); }
});

test('cached reservation acknowledgement never adopts a newer owner or epoch', async () => {
  const f = fixture(); try {
    await f.sis.call('context'); const input = { ...task, idem: 'old-fence' }; await forgeAction(f.deps, 'reserve', input);
    f.engine.db.run('UPDATE issues SET claim_actor=?,lease_epoch=2 WHERE id=?', 'new-owner', task.id);
    const retry = await forgeAction(f.deps, 'reserve', input); expect(retry.ok).toBe(false); expect(retry.data.bound).toBe(false);
    expect((await f.sis.call('show', { id: task.id })).data.issue.claim_actor).toBe('new-owner');
    expect((f.state.query('SELECT actor,epoch FROM worktrees').get() as { actor: string; epoch: number })).toEqual({ actor: 'worker', epoch: 1 });
  } finally { await f.cleanup(); }
});

test('ownership drift during contract lookup cannot create a stale binding', async () => {
  const f = fixture(); try {
    await f.sis.call('context'); const call = f.sis.call.bind(f.sis);
    f.sis.call = async (cmd, args = {}) => { const result = await call(cmd, args); if (cmd === 'contract') f.engine.db.run('UPDATE issues SET claim_actor=?,lease_epoch=2 WHERE id=?', 'new-owner', task.id); return result; };
    const result = await forgeAction(f.deps, 'reserve', task);
    expect(result.ok).toBe(false); expect(result.data.bound).toBe(false); expect(f.state.query('SELECT task FROM worktrees').get()).toBeNull();
    expect(f.git('branch', '--list', 'sis/task')).toBe(''); expect((await call('show', { id: task.id })).data.issue.claim_actor).toBe('new-owner');
  } finally { await f.cleanup(); }
});

test('ownership drift during Git binding preserves the tree but cannot report an owned binding', async () => {
  const f = fixture(); try {
    await f.sis.call('context'); const bind = f.deps.bind;
    f.deps.bind = (...args) => { const result = bind(...args); f.engine.db.run('UPDATE issues SET claim_actor=?,lease_epoch=2 WHERE id=?', 'new-owner', task.id); return result; };
    const result = await forgeAction(f.deps, 'reserve', task);
    expect(result.ok).toBe(false); expect(result.data.bound).toBe(false); expect(result.data.reconcile_required).toBe(true);
    expect(f.git('branch', '--list', 'sis/task')).toBeTruthy(); expect(readFileSync(join(result.data.worktree, 'f'), 'utf8')).toBe('initial\n');
    expect((await f.sis.call('show', { id: task.id })).data.issue.claim_actor).toBe('new-owner');
  } finally { await f.cleanup(); }
});

test('the real CLI reserves through its version-bound native socket and returns a reusable fence', async () => {
  const f = fixture(), source = join(import.meta.dir, '..');
  const env: NodeJS.ProcessEnv = { ...process.env, SIS_DB: f.cfg.db, SIS_SOCK: f.cfg.sock, SIS_DIRECT: '1', SIS_IMPL: 'ts' }; delete env.SIS_HTTP;
  const daemon = spawn(process.execPath, [join(source, 'packages/superiss/cli.ts'), 'serve', '--db', f.cfg.db, '--sock', f.cfg.sock], { cwd: f.root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostic = ''; daemon.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-3000); });
  const stopped = new Promise<void>(resolve => daemon.once('close', () => resolve()));
  try {
    for (let i = 0; i < 150 && !existsSync(f.cfg.sock) && daemon.exitCode === null; i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(f.cfg.sock), diagnostic).toBe(true);
    const result = spawnSync(process.execPath, [join(source, 'sisf/sisf.ts'), 'reserve', task.id, '--db', f.cfg.db, '--sock', f.cfg.sock, '--repo', f.repo, '--actor', task.actor, '--title', task.title, '--oracle', task.oracle_cmd, '--paths', JSON.stringify(task.allowed_paths), '--idem', 'real-cli'], { env, encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    const reserved = JSON.parse(result.stdout); expect(reserved.ok).toBe(true); expect(reserved.data.bound).toBe(true); expect(reserved.data.claim.epoch).toBe(1);
    const read = spawnSync(process.execPath, [join(source, 'sisf/sisf.ts'), 'changes', task.id, '--db', f.cfg.db, '--sock', f.cfg.sock, '--repo', f.repo, '--actor', task.actor, '--epoch', String(reserved.data.claim.epoch)], { env, encoding: 'utf8', timeout: 10_000 });
    expect(read.status, read.stderr).toBe(0); expect(JSON.parse(read.stdout).ok).toBe(true);
  } finally {
    daemon.kill('SIGTERM'); const kill = setTimeout(() => daemon.kill('SIGKILL'), 1000);
    try { await stopped; } finally { clearTimeout(kill); await f.cleanup(); }
  }
}, 20_000);
