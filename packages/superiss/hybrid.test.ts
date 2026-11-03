import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { test } from 'node:test';
import { StoreDatabase } from './ts/store.ts';
import { Engine as CoreEngine } from './ts/engine.ts';
import type { Obj } from './ts/util.ts';
import { resolveTypeScript } from './compiler.ts';

const v1 = dirname(fileURLToPath(import.meta.url));
function compilerFixture(versions: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'sis-v1-compiler-')), log = join(root, 'probes');
  const paths = versions.map((version, i) => {
    const directory = join(root, `compiler ${i}`), path = join(directory, 'tsc');
    mkdirSync(directory);
    writeFileSync(path, `#!/bin/sh\n[ "$1" = "--version" ] || exit 79\nprintf '%s\\n' 'Version ${version}'\nprintf '%s\\n' "$0" >> "$SIS_TEST_COMPILER_LOG"\n`);
    chmodSync(path, 0o755);
    return path;
  });
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: paths.map(dirname).join(delimiter), SIS_TEST_COMPILER_LOG: log };
  delete env.SIS_TSC;
  return { root, log, paths, env, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

test('compiler selection skips npm shadows and chooses the newest installed 7.1 once per executable', () => {
  const f = compilerFixture(['5.9.3', '7.1.0-dev.20261027.1', '7.1.0-dev.20261101.1', '7.2.0']);
  try {
    const alias = join(f.root, 'compiler alias'); mkdirSync(alias); symlinkSync(f.paths[1], join(alias, 'tsc'));
    f.env.PATH += delimiter + alias + delimiter + dirname(f.paths[2]);
    assert.deepEqual(resolveTypeScript(f.env), { command: f.paths[2], version: 'Version 7.1.0-dev.20261101.1' });
    assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, 4);
  } finally { f.cleanup(); }
});

test('compiler version ordering handles numeric prereleases, stable releases and build metadata', () => {
  for (const [versions, expected] of [
    [['7.1.0-dev.20261027.9', '7.1.0-dev.20261027.10'], 1],
    [['7.1.0-dev.20261101.1', '7.1.0'], 1],
    [['7.1.0', '7.1.1-dev.1'], 1],
    [['7.1.0-rc.2', '7.1.0-rc.10'], 1],
    [['7.1.0-1', '7.1.0-alpha'], 1],
    [['7.1.0-dev', '7.1.0-dev.1'], 1],
    [['7.1.0+build.1', '7.1.0+build.2'], 0],
  ] as [string[], number][]) {
    const f = compilerFixture(versions);
    try { assert.equal(resolveTypeScript(f.env).command, f.paths[expected]); }
    finally { f.cleanup(); }
  }
});

test('compiler overrides are explicit and missing, invalid or incompatible compilers fail closed', () => {
  const f = compilerFixture(['5.9.3', '7.1.0-dev.1', '7.1.0-dev.2', '7.1.0-dev.01']);
  try {
    assert.equal(resolveTypeScript({ ...f.env, SIS_TSC: f.paths[1] }).command, f.paths[1]);
    for (const override of ['', f.paths[0], f.paths[3], join(f.root, 'missing')]) {
      assert.throws(() => resolveTypeScript({ ...f.env, SIS_TSC: override }), /explicit SIS_TSC.*no fallback/u);
    }
    assert.throws(() => resolveTypeScript({ ...f.env, PATH: dirname(f.paths[0]) }), /no compatible installed compiler/u);
    assert.throws(() => resolveTypeScript({ ...f.env, PATH: '' }), /no compatible installed compiler/u);
    writeFileSync(f.paths[1], '#!/bin/sh\nexit 17\n');
    assert.throws(() => resolveTypeScript({ ...f.env, SIS_TSC: f.paths[1] }), /explicit SIS_TSC/u);
  } finally { f.cleanup(); }
});

test('npm types resolves the compiler without a manual override despite an older PATH entry', () => {
  const f = compilerFixture(['5.9.3']);
  try {
    f.env.PATH += delimiter + (process.env.PATH ?? '');
    const result = spawnSync('npm', ['--prefix', v1, 'run', 'types'], { env: f.env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const receipt = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    assert.equal(receipt.passed, true);
    assert.match(receipt.compilerVersion, /^Version 7\.1\./u);
    assert.notEqual(receipt.compilerPath, f.paths[0]);
  } finally { f.cleanup(); }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sis-v1-')), path = join(root, 'project.db');
  const engine = new CoreEngine(path);
  writeFileSync(join(root, 'input.txt'), 'v1 source\n');
  return { root, path, engine, duck: join(root, 'analytics.duckdb'), cleanup() { engine.db.close(); rmSync(root, { recursive: true, force: true }); } };
}
const task = (id: string, extra: Obj = {}): Obj => ({ id, title: id, oracle_cmd: 'printf verified', allowed_paths: ['input.txt'], ...extra });
function call(sock: string, cmd: string, args: Obj = {}, timeout = 60000): Promise<Obj> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(sock); let input = '';
    socket.setTimeout(timeout, () => socket.destroy(Error('test request timeout')));
    socket.on('connect', () => socket.write(JSON.stringify({ cmd, args }) + '\n'));
    socket.on('error', reject);
    socket.on('data', chunk => { input += chunk; const index = input.indexOf('\n'); if (index >= 0) { socket.end(); resolve(JSON.parse(input.slice(0, index)) as Obj); } });
  });
}
async function serve(path: string, root: string) {
  const sock = join(root, 'server.sock'); let stderr = '';
  const child = spawn(process.execPath, [join(v1, 'cli.ts'), 'serve', '--db', path, '--sock', sock], { cwd: v1, env: { ...process.env, SIS_EMIT: '0' }, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr!.on('data', data => { stderr += data; });
  const exited = new Promise<number | null>(resolve => child.on('exit', resolve));
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw Error(`server exited: ${stderr}`);
    try { if ((await call(sock, 'capabilities', {}, 500)).ok === true) return { sock, child, exited, async stop() { child.kill('SIGTERM'); await exited; } }; } catch { /* bounded readiness retry, no mutation */ }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  child.kill('SIGTERM'); await exited; throw Error(`server not ready: ${stderr}`);
}

test('bounded per-connection statement cache rebinds, evicts, and survives DDL/errors', () => {
  const root = mkdtempSync(join(tmpdir(), 'sis-v1-cache-'));
  const db = new StoreDatabase(join(root, 'cache.db'), { statementCacheSize: 2 });
  try {
    const before = db.statementStats.prepares;
    for (let i = 0; i < 10; i++) assert.equal(db.get('SELECT ? AS n', i)?.n, i);
    assert.equal(db.statementStats.prepares - before, 1);
    assert.ok(db.statementStats.hits >= 9);
    db.get('SELECT 2 AS n'); db.get('SELECT 3 AS n');
    assert.ok(db.statementStats.cached <= 2);
    assert.throws(() => db.get('SELECT no_such_column FROM no_such_table'));
    db.exec('CREATE TABLE cache_ddl(a INTEGER)'); db.all('SELECT * FROM cache_ddl');
    db.exec('ALTER TABLE cache_ddl ADD COLUMN b TEXT');
    db.run('INSERT INTO cache_ddl VALUES(?,?)', 1, 'ok');
    assert.deepEqual({ ...db.get('SELECT * FROM cache_ddl') }, { a: 1, b: 'ok' });
    assert.equal(db.get('PRAGMA synchronous')?.synchronous, 2);
    const uncached = new StoreDatabase(join(root, 'uncached.db'), { statementCacheSize: 0 });
    try {
      const baseline = uncached.statementStats.prepares;
      for (let i = 0; i < 10; i++) assert.equal(uncached.get('SELECT ? AS n', i)?.n, i);
      assert.equal(uncached.statementStats.prepares - baseline, 10);
      assert.equal(uncached.statementStats.cached, 0);
    } finally { uncached.close(); }
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('runtime loads the installed SQLite release and reports real versions', async () => {
  const f = fixture();
  try {
    const { Engine } = await import('./engine.ts'); const e = new Engine(f.path);
    try {
      const caps = await e.dispatch('capabilities', {}) as Obj;
      assert.equal(caps.version, '1.0.0'); assert.equal(caps.typescript, '7.1');
      assert.equal(caps.sqlite_version, '3.54.1'); assert.equal(caps.durability, 2);
      assert.ok((caps.operations as string[]).includes('analytics'));
      assert.ok((caps.operations as string[]).includes('acquire'));
      assert.equal((await e.dispatch('context', {}) as Obj).capabilities && ((await e.dispatch('context', {}) as Obj).capabilities as Obj).version, '1.0.0');
    } finally { await e.shutdown(); e.db.close(); }
  } finally { f.cleanup(); }
});

test('SQLite copy bridge refuses overwrite, preserves source, and produces an independent verified database', async () => {
  const f = fixture();
  try {
    const { copySqlite } = await import('./bridge.ts');
    await f.engine.dispatch('create', task('copy-me'));
    const before = readFileSync(f.path), target = join(f.root, 'copy.db');
    const copied = copySqlite(f.path, target);
    assert.equal(copied.project_id, f.engine.db.get("SELECT v FROM kv WHERE k='project_id'")?.v);
    assert.deepEqual(readFileSync(f.path), before);
    const db = new StoreDatabase(target);
    try { assert.equal(db.get("SELECT title FROM issues WHERE id='copy-me'")?.title, 'copy-me'); assert.equal(db.get('PRAGMA integrity_check')?.integrity_check, 'ok'); }
    finally { db.close(); }
    const copyBytes = readFileSync(target);
    assert.throws(() => copySqlite(f.path, target), /exist|overwrite/u);
    assert.deepEqual(readFileSync(target), copyBytes);
    assert.throws(() => copySqlite(f.path, f.path), /same|exist|overwrite/u);
    await f.engine.dispatch('create', task('source-only'));
    const independent = new StoreDatabase(target);
    try { assert.equal(independent.get("SELECT id FROM issues WHERE id='source-only'"), undefined); }
    finally { independent.close(); }
  } finally { f.cleanup(); }
});

test('snapshot reads stay consistent while SQLite commits continue', async () => {
  const f = fixture();
  try {
    const { snapshotRead } = await import('./bridge.ts');
    await f.engine.dispatch('create', task('before'));
    snapshotRead(f.path, (db, metadata) => {
      const count = db.prepare('SELECT COUNT(*) n FROM issues').get()?.n;
      f.engine.db.run("INSERT INTO issues(id,title,created_at) VALUES('after','after',1)");
      f.engine.db.run("INSERT INTO events(ts,op,data_json) VALUES(1,'test','{}')");
      assert.equal(db.prepare('SELECT COUNT(*) n FROM issues').get()?.n, count);
      assert.equal(db.prepare('SELECT MAX(seq) seq FROM events').get()?.seq, metadata.snapshot_sequence);
    });
    assert.ok(f.engine.db.get("SELECT id FROM issues WHERE id='after'"));
  } finally { f.cleanup(); }
});

test('DuckDB appender is atomic, typed, preserves NUL/Unicode, and statement caching rebinds', async () => {
  const f = fixture();
  try {
    const { DuckStore } = await import('./duck.ts'); const db = new DuckStore(f.duck);
    try {
      db.run('CREATE TABLE appender_test(n BIGINT,label VARCHAR,v DOUBLE)');
      db.appendRows('appender_test', [[1, 'Grüße\0ok', 2.5], [2, '', null]]);
      assert.deepEqual(db.all('SELECT * FROM appender_test ORDER BY n'), [{ n: 1, label: 'Grüße\0ok', v: 2.5 }, { n: 2, label: '', v: null }]);
      const before = db.statementStats.prepares;
      for (let i = 0; i < 5; i++) assert.equal(db.get('SELECT ?::INTEGER n', i)?.n, i);
      assert.equal(db.statementStats.prepares - before, 1);
      assert.throws(() => db.appendRows('appender_test', [[3, 'prefix', 1], [4, 'short']]), /column|row/u);
      assert.equal(db.get('SELECT COUNT(*) n FROM appender_test')?.n, 2);
      assert.throws(() => db.appendRows('appender_test; DROP TABLE appender_test', []), /identifier/u);
      assert.throws(() => db.get("SELECT * FROM read_text('/etc/passwd')"), /disabled|external|permission/u);
    } finally { db.close(); }
  } finally { f.cleanup(); }
});

test('projection has explicit ownership, fresh snapshot watermark and no duplicate imports', async () => {
  const f = fixture(), other = fixture();
  try {
    const { refreshProjection } = await import('./bridge.ts');
    await f.engine.dispatch('create', task('projected'));
    const first = refreshProjection(f.path, f.duck, 'all', 100);
    assert.equal(first.project_id, f.engine.db.get("SELECT v FROM kv WHERE k='project_id'")?.v);
    assert.equal(first.snapshot_sequence, f.engine.db.get('SELECT MAX(seq) seq FROM events')?.seq);
    assert.equal((first.counts as Obj).issues, 1);
    const second = refreshProjection(f.path, f.duck, 'all', 100);
    assert.deepEqual(second.counts, first.counts);
    f.engine.db.run("UPDATE issues SET status='closed' WHERE id='projected'");
    const changed = refreshProjection(f.path, f.duck, 'all', 100);
    assert.ok((changed.tasks as Obj[]).some(row => row.status === 'closed'));
    assert.throws(() => refreshProjection(other.path, f.duck, 'all', 100), /project|ownership/u);
    assert.equal(f.engine.db.get("SELECT status FROM issues WHERE id='projected'")?.status, 'closed');
    assert.throws(() => refreshProjection(f.path, f.path, 'all', 100), /separate|duckdb|SQLite/u);
  } finally { f.cleanup(); other.cleanup(); }
});

test('many socket clients get unique claims; analytics and an oracle do not block heartbeats', async () => {
  const f = fixture(); let server: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    for (let i = 0; i < 24; i++) await f.engine.dispatch('create', task(`parallel-${i}`));
    f.engine.db.transaction(() => { for (let i = 0; i < 20000; i++) f.engine.db.run("INSERT INTO events(ts,op,actor,data_json) VALUES(?,'sample',?,'{}')", 100 + i, `worker-${i % 16}`); });
    server = await serve(f.path, f.root);
    const claims = await Promise.all(Array.from({ length: 32 }, (_, i) => call(server!.sock, 'acquire', { actor: `agent-${i}`, ttl: 30, cwd: f.root })));
    for (const reply of claims) assert.equal(reply.ok, true, JSON.stringify(reply));
    const payloads = claims.map(reply => reply.data as Obj);
    const granted = payloads.filter(item => typeof item.id === 'string');
    assert.equal(granted.length, 24); assert.equal(new Set(granted.map(item => item.id)).size, 24);
    const idle = payloads.filter(item => item.id === null);
    assert.equal(idle.length, 8);
    for (const item of idle) { assert.equal(item.epoch, undefined); assert.equal(item.claim_id, undefined); }

    const grant = granted[0], actor = String(f.engine.db.get('SELECT claim_actor FROM issues WHERE id=?', String(grant.id))?.claim_actor);
    const epoch = Number(grant.epoch);
    const heartbeat = { id: grant.id, actor, epoch };
    const report = call(server.sock, 'analytics', { kind: 'all', limit: 100 });
    const times: number[] = [];
    for (let i = 0; i < 20; i++) { const start = performance.now(); const reply = await call(server.sock, 'heartbeat', heartbeat); times.push(performance.now() - start); assert.equal(reply.ok, true, JSON.stringify(reply)); }
    assert.ok(Math.max(...times) < 1000, `heartbeat maximum ${Math.max(...times)}ms`);
    const result = await report; assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(((result.data as Obj).counts as Obj).issues, 24);
    await call(server.sock, 'update', { id: grant.id, oracle_cmd: `${process.execPath} -e 'await Bun.sleep(250)'` });
    const verify = call(server.sock, 'verify', { ...heartbeat, cwd: f.root, timeout_secs: 10 });
    const reply = await call(server.sock, 'heartbeat', heartbeat); assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(((await verify).data as Obj).passed, true);
  } finally { if (server) await server.stop(); f.cleanup(); }
});

test('request_id multiplexing permits heartbeats ahead of a report on one connection', async () => {
  const f = fixture(); let server: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    await f.engine.dispatch('create', task('mux'));
    const grant = await f.engine.dispatch('acquire', { id: 'mux', actor: 'mux-worker', cwd: f.root, ttl: 30 }) as Obj;
    server = await serve(f.path, f.root);
    const replies = await new Promise<Obj[]>((resolve, reject) => {
      const socket = createConnection(server!.sock); let input = ''; const messages: Obj[] = [];
      socket.setTimeout(60000, () => socket.destroy(Error('multiplex timeout'))); socket.on('error', reject);
      socket.on('connect', () => { socket.write(JSON.stringify({ request_id: 'report', cmd: 'analytics', args: { kind: 'all' } }) + '\n'); socket.write(JSON.stringify({ request_id: 'heartbeat', cmd: 'heartbeat', args: { id: 'mux', actor: 'mux-worker', epoch: grant.epoch } }) + '\n'); });
      socket.on('data', chunk => { input += chunk; let end: number; while ((end = input.indexOf('\n')) >= 0) { messages.push(JSON.parse(input.slice(0, end)) as Obj); input = input.slice(end + 1); } if (messages.length === 2) { socket.end(); resolve(messages); } });
    });
    assert.equal(replies[0].request_id, 'heartbeat');
    for (const reply of replies) assert.equal(reply.ok, true, JSON.stringify(reply));
  } finally { if (server) await server.stop(); f.cleanup(); }
});

test('report timeout is bounded, child is cleaned up and the SQLite authority remains usable', async () => {
  const f = fixture();
  try {
    const { Engine } = await import('./engine.ts'); const e = new Engine(f.path, { reportTimeoutMs: 1 });
    try { await assert.rejects(e.dispatch('analytics', { kind: 'all' }), /timeout/u); assert.equal(e.analytics.status().running, false); await e.dispatch('stats', {}); assert.equal(e.db.get('SELECT COUNT(*) n FROM issues')?.n, 0); }
    finally { await e.shutdown(); e.db.close(); }
    const next = new Engine(f.path);
    try { assert.equal((await next.dispatch('analytics', { kind: 'all' }) as Obj).project_id, f.engine.db.get("SELECT v FROM kv WHERE k='project_id'")?.v); }
    finally { await next.shutdown(); next.db.close(); }
  } finally { f.cleanup(); }
});

test('oracle capacity is bounded, duplicate verifies coalesce, and heartbeats stay available', async () => {
  const f = fixture(); const { Engine } = await import('./engine.ts');
  const e = new Engine(f.path, { verifyConcurrency: 1 }); const pending: Promise<unknown>[] = [];
  try {
    for (const id of ['capacity-a', 'capacity-b']) await f.engine.dispatch('create', task(id, { oracle_cmd: `${process.execPath} -e 'await Bun.sleep(250)'` }));
    const a = await f.engine.dispatch('claim', { id: 'capacity-a', actor: 'owner', ttl: 30 }) as Obj;
    const b = await f.engine.dispatch('claim', { id: 'capacity-b', actor: 'owner', ttl: 30 }) as Obj;
    const args = { id: a.id!, actor: 'owner', epoch: a.epoch!, cwd: f.root, timeout_secs: 3 };
    const first = e.dispatch('verify', args), joined = e.dispatch('verify', args); pending.push(first, joined);
    await assert.rejects(e.dispatch('verify', { ...args, id: b.id!, epoch: b.epoch! }), (error: unknown) => (error as { code?: string }).code === 'verify_busy');
    await e.dispatch('heartbeat', { id: a.id!, actor: 'owner', epoch: a.epoch! });
    const [one, two] = await Promise.all([first, joined]) as Obj[];
    assert.equal(one.passed, true); assert.equal(two.proof_id, one.proof_id);
    assert.equal(e.db.get("SELECT COUNT(*) n FROM proofs WHERE issue='capacity-a'")?.n, 1);
    assert.equal(e.db.get("SELECT COUNT(*) n FROM proofs WHERE issue='capacity-b'")?.n, 0);
  } finally { await Promise.allSettled(pending); await e.shutdown(); e.db.close(); f.cleanup(); }
});

test('graceful shutdown drains an accepted oracle and preserves the proof', async () => {
  const f = fixture(); let server: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    await f.engine.dispatch('create', task('drain', { oracle_cmd: `${process.execPath} -e 'await Bun.sleep(300)'` }));
    const grant = await f.engine.dispatch('acquire', { id: 'drain', actor: 'drain-worker', cwd: f.root, ttl: 30 }) as Obj;
    server = await serve(f.path, f.root);
    const verified = call(server.sock, 'verify', { id: 'drain', actor: 'drain-worker', epoch: grant.epoch, cwd: f.root, timeout_secs: 10 });
    for (let i = 0; i < 100 && f.engine.db.get('SELECT COUNT(*) n FROM proofs')?.n === 0; i++) { if (i === 3) { server.child.kill('SIGTERM'); break; } await new Promise(resolve => setTimeout(resolve, 20)); }
    const reply = await verified; assert.equal(reply.ok, true, JSON.stringify(reply)); assert.equal((reply.data as Obj).passed, true);
    assert.equal(await server.exited, 0); assert.equal(existsSync(server.sock), false);
    assert.equal(f.engine.db.get('SELECT COUNT(*) n FROM proofs WHERE passed=1')?.n, 1);
    server = undefined;
  } finally { if (server) await server.stop(); f.cleanup(); }
});
