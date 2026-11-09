import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

// Match the installed runtime's SQLite selection before opening any audit connection.
const sqliteLibrary = process.env.SIS_SQLITE_LIBRARY ?? (process.platform === 'darwin' && existsSync('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib') ? '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib' : 'system');
if (sqliteLibrary !== 'system') {
  assert.ok(existsSync(sqliteLibrary), 'configured SQLite library missing');
  const sqlite = createRequire(import.meta.url)('bun:sqlite') as { Database: { setCustomSQLite(path: string): void } };
  sqlite.Database.setCustomSQLite(sqliteLibrary);
}

export const DAY = 86400000;
const INTERVAL = 60000, MAX_GAP = 180000, ACTOR = 'superiss-v1-soak';
const INPUT = 'superiss-1.0-soak\n', ORACLE = 'test "$(cat input.txt)" = superiss-1.0-soak';
type ObjectValue = Record<string, unknown>;
export interface Entry { prev: string; seq: number; wall: number; elapsed: number; kind: string; data: ObjectValue; hash: string }
interface Config { mode: 'run' | 'probe'; bundle: string; manifestHash: string; runnerHash: string; bun: string; bunHash: string }
const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const object = (data: unknown): ObjectValue => { assert.ok(data && typeof data === 'object' && !Array.isArray(data)); return data as ObjectValue; };
export function seal(prev: string, seq: number, wall: number, elapsed: number, kind: string, data: ObjectValue): Entry {
  const entry = { prev, seq, wall, elapsed, kind, data };
  return { ...entry, hash: sha(JSON.stringify(entry)) };
}

/** Pure timeline validator. A successful production check additionally requires the real native database and exact pinned files. */
export function validateTimeline(rows: Entry[]): { samples: number; recoveries: number; elapsedSecs: number; maxGapSecs: number; lastHash: string } {
  assert.ok(rows.length >= 2 && rows[0].kind === 'start', 'missing start');
  assert.equal(rows[0].data.mode, 'run', 'probe is not 24h production evidence');
  assert.equal(rows.at(-1)?.kind, 'complete', 'missing complete evidence');
  let previous = '', wall = rows[0].wall, elapsed = 0;
  for (const [index, row] of rows.entries()) {
    assert.ok(['start', 'sample', 'complete'].includes(row.kind), 'observed error or unknown event');
    assert.equal(row.seq, index, 'chain sequence'); assert.equal(row.prev, previous, 'chain predecessor');
    assert.equal(seal(row.prev, row.seq, row.wall, row.elapsed, row.kind, row.data).hash, row.hash, 'chain hash');
    assert.ok(Number.isFinite(row.wall) && Number.isFinite(row.elapsed) && row.wall >= wall && row.elapsed >= elapsed, 'clock rollback');
    assert.ok(Math.abs(row.wall - rows[0].wall - row.elapsed) <= MAX_GAP, '24h clock discontinuity');
    previous = row.hash; wall = row.wall; elapsed = row.elapsed;
  }
  assert.ok(wall - rows[0].wall >= DAY && elapsed >= DAY, 'real 24h wall and monotonic duration required');
  const samples = rows.filter(row => row.kind === 'sample');
  assert.equal(samples.length, 1441, 'complete 24h sample cycle required');
  let lastWall = rows[0].wall, lastElapsed = 0, maxGap = 0, recoveries = 0;
  const project = samples[0]?.data.project, ids = new Set<string>(), instances = new Set<string>();
  for (const [cycle, sample] of samples.entries()) {
    assert.equal(sample.data.cycle, cycle, 'missing cycle');
    assert.equal(sample.data.id, `cycle-${cycle}`); assert.ok(typeof sample.data.proof === 'string' && sample.data.proof);
    assert.ok(typeof project === 'string' && project); assert.equal(sample.data.project, project, 'project drift');
    assert.ok(typeof sample.data.instance === 'string' && sample.data.instance && Number.isSafeInteger(sample.data.pid) && Number(sample.data.pid) > 1);
    assert.ok(!ids.has(String(sample.data.id))); ids.add(String(sample.data.id));
    const gap = Math.max(sample.wall - lastWall, sample.elapsed - lastElapsed); maxGap = Math.max(maxGap, gap);
    assert.ok(gap <= MAX_GAP, 'availability gap exceeded');
    assert.ok(sample.elapsed >= cycle * INTERVAL && sample.elapsed <= cycle * INTERVAL + MAX_GAP, 'cycle coverage gap');
    assert.equal(sample.data.analytics, cycle % 60 === 0, 'hourly analytics incomplete');
    if ([360, 720, 1080].includes(cycle)) {
      assert.ok(sample.data.recovery, 'missing recovery');
      const recovery = object(sample.data.recovery);
      assert.ok(typeof recovery.before === 'string' && typeof recovery.after === 'string' && recovery.before !== recovery.after, 'unbound recovery');
      assert.equal(recovery.after, sample.data.instance, 'recovery instance mismatch');
      assert.ok(Number.isSafeInteger(recovery.pidBefore) && Number(recovery.pidBefore) > 1 && recovery.pidAfter === sample.data.pid && recovery.pidBefore !== recovery.pidAfter && recovery.epoch === 1, 'recovery identity mismatch');
      assert.ok(!instances.has(recovery.after as string), 'replayed recovery'); instances.add(recovery.after as string); recoveries++;
    } else assert.equal(sample.data.recovery, null, 'unexpected recovery');
    lastWall = sample.wall; lastElapsed = sample.elapsed;
  }
  assert.ok(wall - lastWall <= MAX_GAP && elapsed - lastElapsed <= MAX_GAP, 'final availability gap');
  return { samples: samples.length, recoveries, elapsedSecs: elapsed / 1000, maxGapSecs: maxGap / 1000, lastHash: previous };
}

function runtime(bundle: string): string {
  const root = realpathSync(bundle), bytes = readFileSync(join(root, 'manifest.json'));
  const manifest = object(JSON.parse(bytes.toString())); assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.sourceHash, '8913e919e4e2973618325bae00f55ef5635da81c11def7ba242c9252ed3e8717', 'expected published licensed 1.0 release');
  const files = object(manifest.files);
  assert.deepEqual(Object.keys(files).sort(), ['LICENSE', 'bin/sis', 'packages/superiss/README.md', 'packages/superiss/dist/analytics-worker.js', 'packages/superiss/dist/cli.js', 'packages/superiss/dist/v1-lifecycle.js', 'packages/superiss/ops.json', 'packages/superiss/package.json', 'packages/superiss/ts/data/cl100k_base.tiktoken', 'packages/superiss/ts/data/o200k_base.tiktoken', 'packages/superiss/web/board.html'].sort(), 'complete licensed bundle required');
  for (const [name, hash] of Object.entries(files)) {
    assert.ok(!isAbsolute(name) && !name.split(/[\\/]/u).includes('..'), 'unsafe manifest path');
    const path = realpathSync(join(root, name)); assert.ok(relative(root, path) && !relative(root, path).startsWith('..'), 'manifest scope escape');
    assert.equal(sha(readFileSync(path)), hash, 'runtime changed: ' + name);
  }
  return sha(bytes);
}
function configAt(state: string): Config { return JSON.parse(readFileSync(join(state, 'config.json'), 'utf8')) as Config; }
function checkFiles(config: Config): void {
  assert.equal(runtime(config.bundle), config.manifestHash, 'bundle manifest drift');
  assert.equal(sha(readFileSync(fileURLToPath(import.meta.url))), config.runnerHash, 'soak runner drift');
  assert.equal(sha(readFileSync(config.bun)), config.bunHash, 'Bun runtime drift');
}
export function verify(state: string): ObjectValue {
  state = realpathSync(state);
  const config = configAt(state), raw = readFileSync(join(state, 'events.jsonl'), 'utf8');
  assert.ok(raw.endsWith('\n'), 'partial journal');
  const rows = raw.trimEnd().split('\n').map(line => JSON.parse(line) as Entry);
  const summary = validateTimeline(rows);
  assert.equal(rows[0].data.configHash, sha(readFileSync(join(state, 'config.json'))), 'configuration drift');
  assert.ok(Date.now() - rows[0].wall >= DAY, '24h has not elapsed');
  auditNative(state, rows);
  return { passed: true, version: '1.0.0', ...summary, extraSpendEur: 0, manifestHash: config.manifestHash };
}

export function auditNative(state: string, rows: Entry[]): void {
  const config = configAt(state);
  checkFiles(config); assert.equal(readFileSync(join(state, 'input.txt'), 'utf8'), INPUT);
  const samples = rows.filter(row => row.kind === 'sample');
  const db = new DatabaseSync(join(state, 'tasks.db'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM costs WHERE cents<>0').get()?.n), 0, 'nonzero costs');
    assert.equal(Number(db.prepare('SELECT count(*) AS n FROM issues').get()?.n), samples.length, 'unexpected or missing tasks');
    const statement = db.prepare('SELECT i.status,i.owner,i.budget_eur,i.oracle_cmd,i.allowed_paths,i.lease_epoch,p.actor,p.epoch,p.passed,p.exitcode,p.timed_out,p.revision,p.source_hash,p.cwd FROM issues i JOIN proofs p ON p.issue=i.id WHERE i.id=? AND p.proof_id=?');
    for (const row of samples) {
      const proof = statement.get(String(row.data.id), String(row.data.proof)); assert.ok(proof, 'native proof missing');
      assert.equal(proof.status, 'closed'); assert.equal(proof.owner, ACTOR); assert.equal(proof.actor, ACTOR); assert.equal(proof.budget_eur, 0);
      assert.equal(proof.passed, 1); assert.equal(proof.exitcode, 0); assert.equal(proof.timed_out, 0); assert.equal(proof.epoch, 1); assert.equal(proof.lease_epoch, 1);
      assert.equal(proof.oracle_cmd, ORACLE); assert.deepEqual(JSON.parse(String(proof.allowed_paths)), ['input.txt']);
      assert.equal(proof.revision, row.data.revision); assert.equal(proof.source_hash, sha('{"input.txt":"' + sha(INPUT) + '"}')); assert.equal(proof.cwd, state);
      const closed = db.prepare("SELECT data_json FROM events WHERE issue=? AND actor=? AND op='close' ORDER BY seq DESC LIMIT 1").get(String(row.data.id), ACTOR);
      assert.equal(object(JSON.parse(String(closed?.data_json))).proof_id, row.data.proof, 'native close receipt missing');
    }
  } finally { db.close(); }
}

async function run(mode: 'run' | 'probe', bundle: string, state: string): Promise<void> {
  bundle = realpathSync(bundle); state = resolve(state); assert.ok(!existsSync(state), 'existing state preserved');
  const config: Config = { mode, bundle, manifestHash: runtime(bundle), runnerHash: sha(readFileSync(fileURLToPath(import.meta.url))), bun: realpathSync(process.execPath), bunHash: sha(readFileSync(process.execPath)) };
  mkdirSync(state, { mode: 0o700 }); state = realpathSync(state);
  writeFileSync(join(state, 'config.json'), JSON.stringify(config) + '\n', { mode: 0o600, flag: 'wx' });
  writeFileSync(join(state, 'input.txt'), INPUT, { mode: 0o400, flag: 'wx' });
  const launcher = join(bundle, 'bin/sis'), db = join(state, 'tasks.db'), sock = join(state, 'rpc.sock');
  assert.ok(Buffer.byteLength(sock) < 100, 'socket path too long');
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: state, TMPDIR: state, LANG: 'C.UTF-8', SIS_BUN: config.bun, SIS_EMIT: '0', SIS_SNAPSHOT: '0', SIS_SYNCHRONOUS: 'FULL' };
  for (const key of ['SIS_DUCKDB_LIBRARY', 'SIS_SQLITE_LIBRARY']) if (process.env[key]) env[key] = process.env[key];
  const stop = new AbortController(); process.once('SIGTERM', () => stop.abort()); process.once('SIGINT', () => stop.abort());
  const start = performance.now(), wall = Date.now(); let previous = '', seq = 0, daemon: ChildProcess | undefined;
  const record = (kind: string, data: ObjectValue) => {
    const entry = seal(previous, seq++, Date.now(), performance.now() - start, kind, data);
    const fd = openSync(join(state, 'events.jsonl'), 'a', 0o600);
    try { appendFileSync(fd, JSON.stringify(entry) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    previous = entry.hash;
  };
  const rpc = (command: string, args: ObjectValue = {}): ObjectValue => {
    const result = spawnSync(launcher, [command, JSON.stringify(args), '--db', db, '--sock', sock], { cwd: state, env, encoding: 'utf8', timeout: command === 'verify' ? 310000 : 45000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, `${command}: ${result.stderr || result.stdout || result.error}`);
    const value = object(JSON.parse(result.stdout)); assert.notEqual(value.ok, false, JSON.stringify(value)); return value;
  };
  const alive = () => daemon && daemon.exitCode === null && daemon.signalCode === null;
  async function waitExit(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((accept, reject) => { const timer = setTimeout(() => reject(Error('owned daemon exit timeout')), 10000); child.once('exit', () => { clearTimeout(timer); accept(); }); });
  }
  async function boot(): Promise<ObjectValue> {
    const fd = openSync(join(state, 'daemon.log'), 'a', 0o600);
    try { daemon = spawn(launcher, ['serve', '--db', db, '--sock', sock], { cwd: state, env, stdio: ['ignore', fd, fd] }); }
    finally { closeSync(fd); }
    let error: Error | undefined; daemon.once('error', failure => { error = failure; });
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline) {
      if (error) throw error; assert.ok(alive(), 'owned daemon exited during startup');
      if (existsSync(sock)) {
        const context = rpc('context'); assert.equal(context.pid, daemon.pid);
        const capabilities = object(context.capabilities); assert.equal(capabilities.version, '1.0.0'); assert.equal(capabilities.protocol, 2);
        assert.equal(capabilities.proof_receipts, true); assert.equal((capabilities.operations as unknown[]).length, 87);
        assert.equal(context.db_path, db); return context;
      }
      await pause(50, undefined, { signal: stop.signal });
    }
    throw Error('owned daemon startup timeout');
  }
  record('start', { mode, configHash: sha(readFileSync(join(state, 'config.json'))), startedAt: wall });
  let success = false, recoveries = 0;
  try {
    let context = await boot(); const project = context.project_id;
    console.log(JSON.stringify({ started: true, mode, state, version: '1.0.0', earliestCompletion: new Date(wall + DAY).toISOString(), pid: daemon?.pid }));
    const last = mode === 'probe' ? 3 : 1440;
    for (let cycle = 0; cycle <= last; cycle++) {
      if (stop.signal.aborted) throw Error('soak interrupted');
      if (mode === 'run') await pause(Math.max(0, cycle * INTERVAL - (performance.now() - start)), undefined, { signal: stop.signal });
      assert.ok(alive(), 'unexpected daemon exit');
      const id = `cycle-${cycle}`;
      rpc('create', { id, title: 'Superiss 1.0 soak ' + cycle, owner: ACTOR, budget_eur: 0, oracle_cmd: ORACLE, allowed_paths: ['input.txt'] });
      const claim = rpc('claim', { id, actor: ACTOR, ttl: 600 }); assert.equal(claim.epoch, 1);
      const fence = { id, actor: ACTOR, epoch: claim.epoch };
      rpc('heartbeat', { ...fence, ttl: 600 });
      rpc('checkpoint', { ...fence, cwd: state, text: 'Persistent real soak fixture', next_step: 'verify and close after optional owned daemon restart' });
      let recovery: ObjectValue | null = null;
      if (mode === 'probe' ? cycle > 0 : [360, 720, 1080].includes(cycle)) {
        const before = rpc('context'); assert.equal(before.pid, daemon?.pid); assert.equal(before.instance_id, context.instance_id);
        const child = daemon!; child.kill('SIGKILL'); await waitExit(child);
        // This socket belongs to the exited child in our exclusively created private state directory.
        if (existsSync(sock)) unlinkSync(sock);
        context = await boot(); assert.equal(context.project_id, project); assert.notEqual(context.instance_id, before.instance_id);
        const issue = object(rpc('show', { id }).issue); assert.equal(issue.status, 'in_progress'); assert.equal(issue.claim_actor, ACTOR); assert.equal(issue.lease_epoch, claim.epoch);
        rpc('heartbeat', { ...fence, ttl: 600 });
        recovery = { before: before.instance_id, after: context.instance_id, pidBefore: before.pid, pidAfter: context.pid, epoch: claim.epoch }; recoveries++;
      }
      const proof = rpc('verify', { ...fence, cwd: state, timeout_secs: 300 }); assert.equal(proof.passed, true);
      rpc('close', { ...fence, proof_id: proof.proof_id }); assert.equal(object(rpc('show', { id }).issue).status, 'closed');
      const analytics = cycle % 60 === 0;
      if (analytics) {
        checkFiles(config);
        const report = rpc('analytics'); assert.equal(report.authority, 'sqlite'); assert.equal(report.consistency, 'snapshot'); assert.match(String(report.duckdb_version), /^v2\.0\./u);
      }
      record('sample', { cycle, id, proof: proof.proof_id, revision: proof.revision, project, instance: context.instance_id, pid: context.pid, analytics, recovery });
    }
    success = true;
  } catch (error) { record('error', { message: String(error) }); throw error; }
  finally {
    if (alive()) { const child = daemon!; child.kill('SIGTERM'); await waitExit(child); }
  }
  if (success) {
    record('complete', {});
    const rows = readFileSync(join(state, 'events.jsonl'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line) as Entry);
    auditNative(state, rows);
    const report = mode === 'run' ? verify(state) : { passed: false, probePassed: true, nativeValidated: true, samples: 4, recoveries, reason: 'probe_is_not_24h_proof' };
    writeFileSync(join(state, mode === 'run' ? 'result.json' : 'probe.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify(report));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, first, second, ...extra] = process.argv.slice(2); assert.equal(extra.length, 0, 'unexpected options');
    if (command === 'verify') { assert.ok(first && !second); console.log(JSON.stringify(verify(first))); }
    else { assert.ok((command === 'run' || command === 'probe') && first && second, 'Usage: v1-soak.ts run|probe PINNED_BUNDLE NEW_STATE | verify STATE'); await run(command, first, second); }
  } catch (error) { console.error(JSON.stringify({ passed: false, error: String(error) })); process.exitCode = 1; }
}
