import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { _test } from './sisf';

const source = resolve(import.meta.dir, '..');
const env: NodeJS.ProcessEnv = { ...process.env, SIS_DIRECT: '1', SIS_SNAPSHOT: '0' };
for (const key of ['SIS_DB', 'SIS_SOCK', 'SIS_HTTP', 'SIS_IMPL', 'SISF_PORT', 'SISF_ACTORS', 'SISF_REPO', 'SISF_GITEA_URL', 'SISF_GITEA_TOKEN']) delete env[key];
async function until(check: () => boolean | Promise<boolean>, detail: () => string, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(20); }
  throw new Error(detail());
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise<void>(r => child.once('close', () => r())); child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([ended, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('fixture process did not stop')), 2000); })]); }
  finally { if (timer) clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await ended; } }
}
async function fixture(ids: string[], actors?: string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sisf-reconcile-'))), repo = join(root, 'repo'), db = join(root, 'tasks.db'), sock = join(root, 'sis.sock');
  mkdirSync(repo);
  const git = (...args: string[]) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 5000 }); if (r.status !== 0) throw Error(r.stderr); return r.stdout.trim(); };
  git('init', '-qb', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repo, 'f'), 'initial\n'); git('add', 'f'); git('commit', '-qm', 'initial');
  const seeded = spawnSync(process.execPath, [join(source, 'packages/superiss/cli.ts'), 'batch', JSON.stringify({ ops: ids.map(id => ({ cmd: 'create', args: { id, title: id, allowed_paths: ['.'], oracle_cmd: 'true' } })) }), '--db', db], { env, encoding: 'utf8', timeout: 5000 });
  if (seeded.status !== 0) throw Error(seeded.stdout + seeded.stderr);
  const daemon = spawn(process.execPath, [join(source, 'packages/superiss/cli.ts'), 'serve', '--db', db, '--sock', sock], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let daemonError = ''; daemon.stderr!.on('data', d => { daemonError += d; });
  const cfg = { db, sock, state: db + '.sisf.state.db', repos: { default: { path: repo } }, lanes: {}, gitea: null };
  const native = new _test.Sis(cfg as any); let forge: ChildProcess | undefined, base = '', forgeError = '';
  async function startForge() {
    forgeError = ''; base = '';
    forge = spawn(process.execPath, [join(source, 'sisf/sisf.ts'), 'serve', '--db', db, '--sock', sock, '--repo', repo, '--port', '0', ...(actors ? ['--actors', actors.join(',')] : [])], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    forge.stderr!.on('data', d => { forgeError += d; const m = forgeError.match(/http 127\.0\.0\.1:(\d+)/); if (m) base = 'http://127.0.0.1:' + m[1]; });
    await until(() => !!base, () => forgeError);
  }
  try { await until(() => existsSync(sock), () => daemonError); await startForge(); }
  catch (e) { if (forge) await stop(forge); await stop(daemon); native.close(); rmSync(root, { recursive: true, force: true }); throw e; }
  return {
    root, repo, db, cfg, native, git, get error() { return forgeError; },
    async get(path: string) { const r = await fetch(base + path); return { status: r.status, body: await r.json() as any }; },
    async rpc(cmd: string, args: Record<string, unknown>) { const r = await fetch(base + '/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, args }) }); return { status: r.status, body: await r.json() as any }; },
    async restart() { await stop(forge!); await startForge(); },
    async close() { native.close(); if (forge) await stop(forge); await stop(daemon); rmSync(root, { recursive: true, force: true }); },
  };
}

test('a new claim epoch records a durable conflict while later tasks bind and old work is preserved', async () => {
  const f = await fixture(['t1', 't2']);
  try {
    const first = await f.native.call('acquire', { id: 't1', actor: 'old', ttl: 1 }); expect(first.ok).toBe(true);
    const path = join(f.repo, '.sisf/wt/t1'); await until(() => existsSync(join(path, 'f')), () => f.error);
    writeFileSync(join(path, 'keep'), 'old owner work'); const locked = f.git('worktree', 'list', '--porcelain');
    const lockPath = f.git('-C', path, 'rev-parse', '--git-path', 'locked'), lockBytes = readFileSync(lockPath, 'utf8');
    await delay(1100);
    const second = await f.native.call('acquire', { id: 't1', actor: 'new', ttl: 120 }); expect(second.ok).toBe(true); expect(second.data.epoch).toBe(first.data.epoch + 1);
    expect((await f.native.call('acquire', { id: 't2', actor: 'other', ttl: 120 })).ok).toBe(true);
    await until(() => existsSync(join(f.repo, '.sisf/wt/t2/f')), () => 'later task was blocked: ' + f.error, 2000);
    const preview = await f.get('/sisf/reconcile'); expect(preview.status).toBe(200); expect(preview.body.ok).toBe(true);
    expect(preview.body.data.conflicts).toHaveLength(1);
    const conflict = preview.body.data.conflicts[0]; expect(conflict.task).toBe('t1'); expect(conflict.actor).toBe('new'); expect(conflict.epoch).toBe(second.data.epoch); expect(conflict.code).toBe('binding_owner_changed');
    expect(readFileSync(join(path, 'keep'), 'utf8')).toBe('old owner work'); expect(f.git('worktree', 'list', '--porcelain')).toContain('locked sisf:t1'); expect(locked).toContain('branch refs/heads/sis/t1');
    expect(f.git('-C', path, 'branch', '--show-current')).toBe('sis/t1'); expect(readFileSync(lockPath, 'utf8')).toBe(lockBytes);
    expect((await f.get('/health')).body.ok).toBe(true);
    const state = new Database(f.cfg.state, { readonly: true }); const cursor = state.query<{v:string}, []>("SELECT v FROM kv WHERE k='last_seq'").get()!.v; state.close();
    await f.restart(); expect((await f.get('/sisf/reconcile')).body.data.conflicts).toEqual(preview.body.data.conflicts);
    const state2 = new Database(f.cfg.state, { readonly: true }); expect(Number(state2.query<{v:string}, []>("SELECT v FROM kv WHERE k='last_seq'").get()!.v)).toBeGreaterThanOrEqual(Number(cursor)); state2.close();
    expect(readFileSync(join(path, 'keep'), 'utf8')).toBe('old owner work'); expect(f.git('-C', path, 'branch', '--show-current')).toBe('sis/t1'); expect(readFileSync(lockPath, 'utf8')).toBe(lockBytes);
    const cli = spawnSync(process.execPath, [join(source, 'sisf/sisf.ts'), 'reconcile', '--db', f.db, '--sock', f.cfg.sock], { env, encoding: 'utf8', timeout: 5000 });
    expect(cli.status).toBe(0); expect(JSON.parse(cli.stdout).data.conflicts).toEqual(preview.body.data.conflicts);
  } finally { await f.close(); }
}, 15000);

test('ten concurrent clients get distinct bindings and one shared task has exactly one winner', async () => {
  const actors = Array.from({length:10}, (_, i) => 'worker-' + i), ids = actors.map((_, i) => 'task-' + i);
  const f = await fixture([...ids, 'shared', 'foreign'], actors);
  try {
    const independent = await Promise.all(ids.map((id, i) => f.rpc('acquire', { id, actor: actors[i], ttl: 120 })));
    expect(independent.every(r => r.body.ok && r.body.data.sisf.bound)).toBe(true);
    expect(new Set(independent.map(r => r.body.data.sisf.worktree)).size).toBe(10); expect(new Set(independent.map(r => r.body.data.sisf.branch)).size).toBe(10);
    const contested = await Promise.all(actors.map(actor => f.rpc('acquire', { id: 'shared', actor, ttl: 120 })));
    expect(contested.filter(r => r.body.ok)).toHaveLength(1);
    const denied = await f.rpc('acquire', { id: 'foreign', actor: 'not-allowed', ttl: 120 }); expect(denied.status).toBe(403); expect((await f.native.call('show', { id: 'foreign' })).data.issue.status).toBe('open');
    const stale = await f.rpc('changes', { id: ids[0], actor: actors[0], epoch: 999 }); expect(stale.body.ok).toBe(false);
    const trees = (await f.get('/sisf/worktrees')).body.data; expect(trees).toHaveLength(11); expect(trees.every((w: any) => w.epoch === 1 && actors.includes(w.actor))).toBe(true);
  } finally { await f.close(); }
}, 20000);

test('native and Git inspection failures remain retryable instead of becoming task conflict receipts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sisf-infrastructure-'));
  const cfg: any = { state: join(root, 'state.db'), repos: { default: { path: join(root, 'missing-repo') } }, lanes: {} };
  const state = _test.openState(cfg);
  const sis: any = { project: 'fixture', call: async () => ({ ok: false, error: { code: 'database_busy' } }) };
  try {
    await expect(_test.reconcileEvent(cfg, sis, state, { op: 'acquire', issue: 't', seq: 1 })).rejects.toThrow(/show failed/);
    sis.call = async () => ({ ok: true, data: { issue: { status: 'in_progress', claim_actor: 'a', lease_epoch: 1, lease_until: Date.now()/1000 + 60 } } });
    await expect(_test.reconcileEvent(cfg, sis, state, { op: 'acquire', issue: 't', seq: 1 })).rejects.toThrow(/cannot inspect/);
    expect(_test.reconcilePreview(state).data.conflicts).toHaveLength(0);
  } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
});
