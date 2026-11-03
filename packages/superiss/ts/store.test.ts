import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection, createServer, type Socket } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import type { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { StoreDatabase } from './store.ts';
import { canonical, digest, fingerprint, object, tokenCount, type Obj } from './util.ts';
import { Engine } from './engine.ts';
import { junit } from './xml.ts';

test('schema, FTS and transactions preserve the existing database contract', () => {
  const root = mkdtempSync(join(tmpdir(), 'sis-ts-store-'));
  const path = join(root, 'state.db');
  try {
    const db = new StoreDatabase(path);
    assert.equal(db.get('PRAGMA user_version')?.user_version, 7);
    assert.ok(db.get("SELECT v FROM kv WHERE k='project_id'")?.v);
    db.run("INSERT INTO issues(id,title,status,priority,lease_epoch,created_at) VALUES(?,?,?,?,?,?)", 'task', 'Searchuniqueword', 'open', 2, 0, 1);
    assert.equal(db.get('SELECT i.id FROM issues_fts f JOIN issues i ON i.rowid=f.rowid WHERE issues_fts MATCH ?', 'Searchuniqueword')?.id, 'task');
    assert.throws(() => db.transaction(() => {
      db.run("INSERT INTO memories(key,value) VALUES('rollback','no')");
      throw Error('rollback');
    }));
    assert.equal(db.get("SELECT key FROM memories WHERE key='rollback'"), undefined);
    db.transaction(() => db.transaction(() => db.run("INSERT INTO memories(key,value) VALUES('nested','yes')")));
    const identity = db.get("SELECT v FROM kv WHERE k='project_id'")?.v;
    db.close();
    const observer = new DatabaseSync(path);
    const before = observer.prepare('PRAGMA data_version').get()?.data_version;
    const reopened = new StoreDatabase(path);
    assert.equal(reopened.get("SELECT v FROM kv WHERE k='project_id'")?.v, identity);
    reopened.close();
    assert.equal(observer.prepare('PRAGMA data_version').get()?.data_version, before);
    observer.exec('PRAGMA user_version=8; CREATE TABLE outbox_leases(id INTEGER PRIMARY KEY,owner TEXT)');
    const compatible = new StoreDatabase(path);
    assert.equal(compatible.get('PRAGMA user_version')?.user_version, 8);
    compatible.close();
    observer.exec('PRAGMA user_version=99');
    assert.throws(() => new StoreDatabase(path), /schema|version|newer/i);
    assert.equal(observer.prepare('PRAGMA user_version').get()?.user_version, 99);
    observer.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('JUnit summaries reject malformed XML and count nested suites', () => {
  const report = '<testsuites><testsuite tests="2" failures="0" errors="0" skipped="1"/><testsuite tests="1" failures="0" errors="0"/></testsuites>';
  assert.deepEqual(junit(report), { passed: true, tests: 3, failures: 0, errors: 0, skipped: 1, parsed: true });
  assert.equal(junit('<testsuite tests="1"><testcase><failure/></testcase></testsuite>').passed, false);
  assert.equal(junit('<testsuite tests="1"><testsuite tests="1" failures="1"/></testsuite>').passed, false);
  assert.equal(junit('<testsuites tests="2"><testsuite tests="2"><testsuite tests="2" errors="1"/></testsuite></testsuites>').passed, false);
  assert.equal(junit('<testsuites><testsuite><testsuite tests="1" failures="1"/><testsuite tests="1" failures="1"/></testsuite></testsuites>').failures, 2);
  assert.throws(() => junit('<testsuite tests="1"><testcase></testsuite>'));
  assert.throws(() => junit('<!DOCTYPE testsuite [<!ENTITY x SYSTEM "file:///tmp/x">]><testsuite tests="1"/>'));
});

test('canonical JSON sorts numeric and Unicode keys like Rust and Python', () => {
  assert.equal(canonical({ '2': 'two', '10': 'ten', '𐀀': 'supplementary', '': 'bmp' }), '{"10":"ten","2":"two","":"bmp","𐀀":"supplementary"}');
  const sparse = new Array(2); sparse[1] = 1;
  assert.equal(canonical(sparse), '[null,1]');
});

test('verification selects TypeScript 7.1 from PATH and honors explicit compilers', () => {
  const root = mkdtempSync(join(tmpdir(), 'sis-ts-compiler-'));
  const oldDir = join(root, 'old compiler'), newDir = join(root, 'new compiler'), tools = join(root, 'tools');
  const oldCompiler = join(oldDir, 'tsc'), newCompiler = join(newDir, 'tsc'), log = join(root, 'invocations');
  try {
    for (const directory of [oldDir, newDir, tools]) mkdirSync(directory);
    writeFileSync(oldCompiler, '#!/bin/sh\nprintf "Version 5.9.3\\n"\n');
    writeFileSync(newCompiler, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "Version 7.1.0-dev.1\\n"; else printf "compile\\n" >> "$SIS_TEST_LOG"; fi\n');
    chmodSync(oldCompiler, 0o755); chmodSync(newCompiler, 0o755);
    for (const executable of ['bun', 'python3']) {
      const path = join(tools, executable);
      writeFileSync(path, `#!/bin/sh
if [ "\${SIS_DIRECT+x}" ] || [ "\${SIS_HTTP+x}" ] || [ "\${SIS_DB+x}" ] || [ "\${SIS_SOCK+x}" ] || [ "\${SIS_ADMIN_TOKEN+x}" ] || [ "\${SIS_MAX_CLIENTS+x}" ]; then
  printf 'inherited SIS daemon setting\\n' >&2; exit 1
fi
if [ "$1" = "tests/agent_suite.py" ] && [ "\${CARGO_NET_OFFLINE-unset}" != "$SIS_EXPECT_OFFLINE" ]; then
  printf 'Cargo offline setting changed\\n' >&2; exit 1
fi
if [ "$1" = "tests/contract_suite.py" ] && [ "$2" != "--require-complete" ]; then
  printf 'contract gate is not strict\\n' >&2; exit 1
fi
printf '${executable}\\n' >> "$SIS_TEST_LOG"
`);
      chmodSync(path, 0o755);
    }
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: [oldDir, newDir, tools, '/usr/bin', '/bin'].join(':'), SIS_TEST_LOG: log,
      SIS_DIRECT: '1', SIS_HTTP: '12345', SIS_DB: '/foreign.db', SIS_SOCK: '/foreign.sock', SIS_ADMIN_TOKEN: 'synthetic', SIS_MAX_CLIENTS: '1', SIS_EXPECT_OFFLINE: 'unset' };
    delete env.SIS_TSC; delete env.SIS_TYPE_ROOTS; delete env.SIS_REFERENCE_TOOLCHAIN; delete env.CARGO_NET_OFFLINE;
    const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'verify-typescript.sh');
    const run = (override?: string, flags: string[] = [], extra: NodeJS.ProcessEnv = {}) => spawnSync('/bin/bash', [script, ...flags], { env: { ...env, ...extra, ...(override === undefined ? {} : { SIS_TSC: override }) }, encoding: 'utf8', timeout: 10000 });
    const automatic = run();
    assert.equal(automatic.status, 0, automatic.stderr);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['compile', 'bun', 'python3', 'python3', 'python3']);
    for (const offline of ['true', 'false']) {
      const configured = run(undefined, [], { CARGO_NET_OFFLINE: offline, SIS_EXPECT_OFFLINE: offline });
      assert.equal(configured.status, 0, configured.stderr);
    }
    writeFileSync(log, '');
    const explicit = run(newCompiler);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.match(readFileSync(log, 'utf8'), /^compile\n/);
    writeFileSync(log, '');
    const typecheck = run(undefined, ['--typecheck']);
    assert.equal(typecheck.status, 0, typecheck.stderr);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['compile']);
    const incompatible = run(oldCompiler);
    assert.notEqual(incompatible.status, 0);
    assert.match(incompatible.stderr, /TypeScript 7\.1 required; found Version 5\.9\.3/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('strict contract gate fails closed for missing operations', () => {
  const root = mkdtempSync(join(tmpdir(), 'sis-contract-gate-'));
  const suite = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'contract_suite.py');
  const probe = String.raw`
import importlib.util, os, sys
path, mode, strict, root = sys.argv[1:]
spec = importlib.util.spec_from_file_location('contract_suite_probe', path)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
class FakeSrv:
    def __init__(self, cmd, db, sock, logdir):
        self.sock = sock
        self.logpath = os.path.join(logdir, 'fixture.log')
    def start(self): pass
    def wait_ready(self): pass
    def stop(self): pass
def call(sock, cmd, args=None):
    if cmd == 'missing': return m.R(False, code='bad_cmd', msg='unknown cmd')
    if cmd == 'transport': raise m.TransErr('fixture transport error')
    return m.R(True, data={'id': 'fixture'})
m.Srv, m.call = FakeSrv, call
m.OPS = [mode]
m.CHECKS = [('op_coverage', m.c_smoke)]
sys.argv = ['contract_suite.py', '--serve-cmd', 'unused', '--db', os.path.join(root, 'fixture.db')]
if strict == 'yes': sys.argv.append('--require-complete')
sys.exit(m.main())
`;
  try {
    for (const [mode, strict, expected, marker] of [
      ['present', 'yes', 0, '[PASS]'], ['missing', 'yes', 1, '[MISSING]'],
      ['missing', 'no', 0, '[MISSING]'], ['transport', 'yes', 1, '[FAIL]'],
    ] as const) {
      const result = spawnSync('python3', ['-c', probe, suite, mode, strict, root], { encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, expected, result.stderr || result.stdout);
      assert.ok(result.stdout.includes(marker), result.stdout);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('bundled tokenizers match Unicode reference counts', () => {
  const input = 'नमस्ते दुनिया 🇩🇪 中文 👩‍💻';
  assert.equal(tokenCount(input, 'o200k_base'), 15);
  assert.equal(tokenCount(input, 'cl100k_base'), 27);
});

test('socket accepts valid NDJSON frames up to the protocol limit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sis-ts-socket-'));
  const sock = join(root, 'server.sock');
  const env = { ...process.env };
  delete env.SIS_HTTP;
  delete env.SIS_ADMIN_TOKEN;
  const child = spawn(process.execPath, [resolve('ts/cli.ts'), 'serve', '--db', join(root, 'project.db'), '--sock', sock], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
  try {
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon startup timed out')), 10000);
      let output = '';
      child.once('error', reject);
      child.once('exit', () => reject(new Error('daemon exited before readiness')));
      child.stderr.on('data', chunk => {
        output += chunk.toString();
        if (output.includes('serving ')) { clearTimeout(timer); resolveReady(); }
      });
    });
    const response = await new Promise<Record<string, unknown>>((resolveResponse, reject) => {
      const socket = createConnection(sock); let data = '';
      socket.setTimeout(10000, () => { socket.destroy(); reject(new Error('socket response timed out')); });
      socket.once('error', reject);
      socket.once('connect', () => socket.write(JSON.stringify({ id: 'large', cmd: 'context', args: { padding: 'x'.repeat(70000) } }) + '\n'));
      socket.on('data', chunk => {
        data += chunk.toString();
        const end = data.indexOf('\n');
        if (end >= 0) { socket.end(); resolveResponse(JSON.parse(data.slice(0, end))); }
      });
    });
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(response.id, 'large');
  } finally {
    child.kill('SIGTERM');
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
});

const cliPath = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts');

async function runCli(db: string, sock: string, command: string, args: Obj, flags: string[] = [], overrides: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; err: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, SIS_SOCK: sock };
  delete env.SIS_DIRECT; delete env.SIS_HTTP; delete env.SIS_ADMIN_TOKEN;
  Object.assign(env, overrides);
  const child = spawn(process.execPath, [cliPath, command, ...(flags.length ? flags : [JSON.stringify(args)]), '--db', db], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk.toString(); });
  child.stderr.on('data', chunk => { err += chunk.toString(); });
  return await new Promise((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', code => resolveResult({ code, out, err }));
  });
}

async function runMcpCreate(db: string, sock: string): Promise<Obj> {
  const env: NodeJS.ProcessEnv = { ...process.env, SIS_SOCK: sock };
  delete env.SIS_DIRECT; delete env.SIS_HTTP; delete env.SIS_ADMIN_TOKEN;
  const child = spawn(process.execPath, [cliPath, 'mcp', '--db', db], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk.toString(); });
  child.stderr.on('data', chunk => { err += chunk.toString(); });
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sis_create', arguments: { id: 'mcp', title: 'Test' } } }) + '\n');
  const code = await new Promise<number | null>((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); });
  assert.equal(code, 0, err);
  return object(JSON.parse(out));
}

async function connectSocket(path: string): Promise<Socket> {
  const socket = createConnection(path);
  await new Promise<void>((resolveReady, reject) => { socket.once('connect', resolveReady); socket.once('error', reject); });
  return socket;
}

async function readLine(socket: Socket): Promise<Obj> {
  return await new Promise((resolveResult, reject) => {
    let data = '';
    socket.once('error', reject);
    socket.on('data', chunk => {
      data += chunk.toString();
      const newline = data.indexOf('\n');
      if (newline >= 0) resolveResult(object(JSON.parse(data.slice(0, newline))));
    });
    socket.once('end', () => reject(new Error('socket closed before response')));
    socket.once('close', () => reject(new Error('socket closed before response')));
  });
}

test('incompatible daemon contracts are rejected before mutation on the same connection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sis-ts-identity-')), db = join(root, 'project.db'), sock = join(root, 'daemon.sock');
  writeFileSync(db, '');
  try {
    for (const [protocol, receipts, version, expected] of [[1, true, '1.0.0', 'reject'], [2, false, '1.0.0', 'reject'], [2, true, '0.9.0', 'reject'], [2, true, undefined, 'reject'], [2, true, '1.0.0', 'accept'], [2, true, '1.0.0', 'uncertain']] as const) {
      const commands: string[] = []; let connections = 0;
      const server = createServer(socket => {
        connections++; let identified = false, data = '';
        socket.on('data', chunk => {
          data += chunk.toString(); let end: number;
          while ((end = data.indexOf('\n')) >= 0) {
            const req = object(JSON.parse(data.slice(0, end))); data = data.slice(end + 1); commands.push(String(req.cmd));
            if (req.cmd === 'context') {
              identified = true;
              socket.write(JSON.stringify({ ok: true, data: { db_path: realpathSync(db), capabilities: { protocol, proof_receipts: receipts, version } } }) + '\n');
            } else if (expected === 'uncertain') socket.destroy();
            else socket.write(JSON.stringify({ ok: identified, data: { id: 'created' } }) + '\n');
          }
        });
      });
      await new Promise<void>((resolveReady, reject) => { server.once('error', reject); server.listen(sock, resolveReady); });
      try {
        const result = await runCli(db, sock, 'create', { id: 'created', title: 'Test' });
        if (expected === 'accept') {
          assert.equal(result.code, 0, result.err);
          assert.equal(connections, 1, 'identity and mutation must share one connection');
          assert.deepEqual(commands, ['context', 'create']);
        } else if (expected === 'reject') {
          assert.notEqual(result.code, 0);
          assert.deepEqual(commands, ['context'], 'no mutation may reach an incompatible daemon');
          const mcp = await runMcpCreate(db, sock);
          assert.equal(object(mcp.result).isError, true);
          assert.equal(lstatSync(db).size, 0, 'socket-backed MCP must not initialize the local database');
          assert.deepEqual(commands, ['context', 'context']);
        } else {
          assert.notEqual(result.code, 0);
          assert.equal(object(object(JSON.parse(result.err)).error).code, 'transport_uncertain');
          assert.equal(connections, 1);
          assert.deepEqual(commands, ['context', 'create'], 'uncertain mutations must not be retried');
        }
      } finally {
        await new Promise<void>(resolveClose => server.close(() => resolveClose()));
        rmSync(sock, { force: true });
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI watch --follow streams successive batches and requires a daemon', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sis-ts-follow-')), db = join(root, 'project.db'), sock = join(root, 'daemon.sock');
  writeFileSync(db, '');
  const server = createServer(socket => {
    let data = '';
    socket.on('error', () => socket.destroy());
    socket.on('data', chunk => {
      data += chunk.toString(); let end: number;
      while ((end = data.indexOf('\n')) >= 0) {
        const req = object(JSON.parse(data.slice(0, end))); data = data.slice(end + 1);
        if (req.cmd === 'context') socket.write(JSON.stringify({ ok: true, data: { db_path: realpathSync(db), capabilities: { protocol: 2, proof_receipts: true, version: '1.0.0' } } }) + '\n');
        else if (req.cmd === 'watch' && object(req.args).follow === true) socket.end([
          JSON.stringify({ ok: true, data: { events: [] }, more: true }),
          JSON.stringify({ ok: true, data: { events: [{ seq: 7 }] }, more: true }),
          '',
        ].join('\n'));
      }
    });
  });
  await new Promise<void>((resolveReady, reject) => { server.once('error', reject); server.listen(sock, resolveReady); });
  try {
    const result = await runCli(db, sock, 'watch', {}, ['--follow']);
    assert.equal(result.code, 0, result.err);
    const frames = result.out.trim().split('\n').map(line => object(JSON.parse(line)));
    assert.equal(frames.length, 2); assert.equal(frames[0].more, true);
    assert.equal(object((object(frames[1].data).events as unknown[])[0]).seq, 7);
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
  try {
    const direct = await runCli(db, sock, 'watch', {}, ['--follow'], { SIS_DIRECT: '1' });
    assert.notEqual(direct.code, 0, 'a streaming watch cannot silently fall back to direct dispatch');
    assert.equal(lstatSync(db).size, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('watch --follow delivers daemon events until the client is cancelled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sis-ts-follow-live-')), db = join(root, 'project.db'), sock = join(root, 'daemon.sock');
  const store = new StoreDatabase(db); store.close();
  const env: NodeJS.ProcessEnv = { ...process.env, SIS_SOCK: sock };
  delete env.SIS_DIRECT; delete env.SIS_HTTP; delete env.SIS_ADMIN_TOKEN;
  const daemon = spawn(process.execPath, [cliPath, 'serve', '--db', db], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const daemonExit = new Promise<void>(resolveExit => daemon.once('exit', () => resolveExit()));
  let follower: ReturnType<typeof spawn> | undefined;
  const streamLine = async (stream: Readable): Promise<Obj> => await new Promise((resolveLine, reject) => {
    let buffer = '';
    const timer = setTimeout(() => { stream.off('data', onData); reject(new Error('stream timed out')); }, 5000);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString(); const end = buffer.indexOf('\n');
      if (end >= 0) { clearTimeout(timer); stream.off('data', onData); resolveLine(object(JSON.parse(buffer.slice(0, end)))); }
    };
    stream.on('data', onData); stream.once('error', reject);
  });
  try {
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon startup timed out')), 10000); let output = '';
      daemon.once('error', reject); daemon.once('exit', () => reject(new Error('daemon exited before readiness')));
      daemon.stderr.on('data', chunk => { output += chunk.toString(); if (output.includes('serving ')) { clearTimeout(timer); resolveReady(); } });
    });
    follower = spawn(process.execPath, [cliPath, 'watch', '--follow', '--db', db], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal((await streamLine(follower.stdout!)).more, true);
    const engine = new Engine(db);
    try { await engine.dispatch('create', { id: 'event', title: 'Watch event' }, { actor: 'worker', explicit: true }); }
    finally { engine.db.close(); }
    const next = await streamLine(follower.stdout!);
    assert.ok(Array.isArray(object(next.data).events));
    assert.ok((object(next.data).events as unknown[]).some(event => object(event).issue === 'event'));
    assert.equal(follower.exitCode, null, 'follow must remain open');
    const followed = new Promise<void>(resolveExit => follower?.once('exit', () => resolveExit()));
    follower.kill('SIGINT'); await followed;
    assert.equal(daemon.exitCode, null, 'client cancellation must not stop the daemon');
  } finally {
    if (follower && follower.exitCode === null && follower.signalCode === null) follower.kill('SIGKILL');
    daemon.kill('SIGTERM'); await daemonExit;
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy lock migration preserves live, unknown and recovered ownership', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sis-ts-legacy-lock-')), db = join(root, 'project.db'), sock = join(root, 'daemon.sock'), lock = sock + '.lock';
  const store = new StoreDatabase(db); store.close();
  mkdirSync(lock, { mode: 0o700 });
  const owner = join(lock, 'owner.json'), nonce = 'sis-' + '0'.repeat(24);
  let daemon: ReturnType<typeof spawn> | undefined;
  try {
    writeFileSync(owner, JSON.stringify({ pid: process.pid, nonce }));
    assert.notEqual((await runCli(db, sock, 'serve', {})).code, 0);
    assert.equal(JSON.parse(readFileSync(owner, 'utf8')).pid, process.pid);
    const dead = 2147483647;
    assert.throws(() => process.kill(dead, 0), error => object(error).code === 'ESRCH');
    writeFileSync(owner, JSON.stringify({ pid: dead, nonce }));
    writeFileSync(join(lock, 'unknown'), 'preserve');
    assert.notEqual((await runCli(db, sock, 'serve', {})).code, 0);
    assert.equal(readFileSync(join(lock, 'unknown'), 'utf8'), 'preserve');
    rmSync(join(lock, 'unknown'));
    const env: NodeJS.ProcessEnv = { ...process.env, SIS_SOCK: sock };
    delete env.SIS_DIRECT; delete env.SIS_HTTP; delete env.SIS_ADMIN_TOKEN;
    daemon = spawn(process.execPath, [cliPath, 'serve', '--db', db], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon startup timed out')), 10000); let output = '';
      daemon?.once('error', reject); daemon?.once('exit', () => reject(new Error('daemon exited before readiness')));
      daemon?.stderr?.on('data', chunk => { output += chunk.toString(); if (output.includes('serving ')) { clearTimeout(timer); resolveReady(); } });
    });
    assert.equal(lstatSync(lock).isFile(), true);
    const backups = readdirSync(root).filter(name => name.startsWith('daemon.sock.lock.legacy-'));
    assert.equal(backups.length, 1);
    assert.equal(JSON.parse(readFileSync(join(root, backups[0], 'owner.json'), 'utf8')).pid, dead);
    const exited = new Promise<void>(resolveExit => daemon?.once('exit', () => resolveExit()));
    daemon.kill('SIGTERM'); await exited; daemon = undefined;
    writeFileSync(sock, 'preserve ordinary file');
    assert.notEqual((await runCli(db, sock, 'serve', {})).code, 0);
    assert.equal(readFileSync(sock, 'utf8'), 'preserve ordinary file');
  } finally {
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      const exited = new Promise<void>(resolveExit => daemon?.once('exit', () => resolveExit()));
      daemon.kill('SIGKILL'); await exited;
    }
    assert.equal(existsSync(root), true);
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkpoint and brief report source drift and unavailable scoped files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sis-ts-checkpoint-')), file = join(root, 'input.txt');
  writeFileSync(file, 'original');
  const engine = new Engine(join(root, 'project.db')), ctx = { actor: 'worker', explicit: true };
  try {
    await engine.dispatch('create', { id: 'task', title: 'Scoped', oracle_cmd: 'true', acceptance: 'test', allowed_paths: [file] }, ctx);
    const claim = object(await engine.dispatch('claim', { id: 'task', actor: 'worker' }, ctx));
    await engine.dispatch('checkpoint', { id: 'task', actor: 'worker', epoch: claim.epoch, cwd: root, text: 'saved', next_step: 'continue' }, ctx);
    for (const cmd of ['resume', 'brief']) {
      const checkpoint = object(object(await engine.dispatch(cmd, { id: 'task' }, ctx)).checkpoint);
      assert.equal(checkpoint.stale, false); assert.equal(checkpoint.source_stale, false);
    }
    writeFileSync(file, 'changed');
    for (const cmd of ['resume', 'brief']) {
      const checkpoint = object(object(await engine.dispatch(cmd, { id: 'task' }, ctx)).checkpoint);
      assert.equal(checkpoint.stale, true); assert.equal(checkpoint.source_stale, true);
    }
    rmSync(file);
    for (const cmd of ['resume', 'brief']) {
      const checkpoint = object(object(await engine.dispatch(cmd, { id: 'task' }, ctx)).checkpoint);
      assert.equal(checkpoint.stale, true); assert.equal(checkpoint.source_stale, true);
    }
  } finally { engine.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('legacy TypeScript fingerprints remain valid only for unchanged sources', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sis-ts-legacy-proof-'))), scope = join(root, 'scope');
  mkdirSync(scope); writeFileSync(join(scope, '2'), 'two'); writeFileSync(join(scope, '10'), 'ten');
  const engine = new Engine(join(root, 'project.db')), ctx = { actor: 'worker', explicit: true };
  try {
    await engine.dispatch('create', { id: 'task', title: 'Legacy', oracle_cmd: 'true', acceptance: 'test', allowed_paths: [scope] }, ctx);
    const claim = object(await engine.dispatch('claim', { id: 'task', actor: 'worker' }, ctx));
    const proof = object(await engine.dispatch('verify', { id: 'task', actor: 'worker', epoch: claim.epoch, cwd: scope }, ctx));
    const legacy = digest(JSON.stringify({ '2': digest('two'), '10': digest('ten') }));
    assert.notEqual(legacy, proof.source_hash);
    assert.equal(legacy, fingerprint({ allowed_paths: [scope] }, scope, join(root, 'project.db')).legacy_source_hash);
    engine.run('UPDATE proofs SET source_hash=? WHERE proof_id=?', legacy, proof.proof_id);
    const close = { id: 'task', actor: 'worker', epoch: claim.epoch, proof_id: proof.proof_id };
    writeFileSync(join(scope, '2'), 'changed');
    await assert.rejects(engine.dispatch('close', close, ctx), error => object(error).code === 'stale_proof');
    writeFileSync(join(scope, '2'), 'two');
    assert.equal(legacy, fingerprint({ allowed_paths: [scope] }, scope, join(root, 'project.db')).legacy_source_hash);
    assert.equal(object(await engine.dispatch('close', close, ctx)).ok, true);
  } finally { engine.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('failing nested JUnit cannot satisfy a required attestation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sis-ts-junit-')), source = join(root, 'input.txt'), report = join(root, 'report.xml');
  writeFileSync(source, 'source');
  writeFileSync(report, '<testsuite tests="1"><testsuite tests="1" failures="1"/></testsuite>');
  const engine = new Engine(join(root, 'project.db')), ctx = { actor: 'worker', explicit: true };
  try {
    await engine.dispatch('create', { id: 'task', title: 'JUnit', oracle_cmd: 'true', acceptance: 'test', allowed_paths: [source], meta: { attest_required: 'junit' } }, ctx);
    const claim = object(await engine.dispatch('claim', { id: 'task', actor: 'worker' }, ctx));
    const proof = object(await engine.dispatch('verify', { id: 'task', actor: 'worker', epoch: claim.epoch, cwd: root }, ctx));
    const attest = object(await engine.dispatch('attest', { id: 'task', actor: 'worker', epoch: claim.epoch, cwd: root, kind: 'junit', payload: { path: 'report.xml' } }, ctx));
    assert.equal(attest.passed, false);
    await assert.rejects(engine.dispatch('close', { id: 'task', actor: 'worker', epoch: claim.epoch, proof_id: proof.proof_id }, ctx), error => object(error).code === 'attest_required');
  } finally { engine.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('socket limits idle clients without interrupting long watch or run requests', { timeout: 45000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sis-ts-limits-')), db = join(root, 'project.db'), sock = join(root, 'daemon.sock'), source = join(root, 'input.txt');
  writeFileSync(source, 'source');
  const engine = new Engine(db), ctx = { actor: 'worker', explicit: true };
  await engine.dispatch('create', { id: 'task', title: 'Long', oracle_cmd: 'true', acceptance: 'test', allowed_paths: [source] }, ctx);
  const claim = object(await engine.dispatch('claim', { id: 'task', actor: 'worker', ttl: 120 }, ctx));
  engine.db.close();
  const env: NodeJS.ProcessEnv = { ...process.env, SIS_SOCK: sock, SIS_MAX_CLIENTS: '4' };
  delete env.SIS_DIRECT; delete env.SIS_HTTP; delete env.SIS_ADMIN_TOKEN;
  const daemon = spawn(process.execPath, [cliPath, 'serve', '--db', db], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise<void>(resolveExit => daemon.once('exit', () => resolveExit()));
  const clients: Socket[] = [];
  try {
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon startup timed out')), 10000); let output = '';
      daemon.once('error', reject); daemon.once('exit', () => reject(new Error('daemon exited before readiness')));
      daemon.stderr.on('data', chunk => { output += chunk.toString(); if (output.includes('serving ')) { clearTimeout(timer); resolveReady(); } });
    });
    for (let i = 0; i < 4; i++) clients.push(await connectSocket(sock));
    const excess = await connectSocket(sock);
    excess.setTimeout(5000, () => excess.destroy());
    assert.equal(object((await readLine(excess)).error).code, 'busy');
    excess.destroy();
    for (const client of clients.slice(1)) {
      const closed = new Promise<void>(resolveClose => client.once('close', () => resolveClose()));
      client.destroy(); await closed;
    }
    const idleClosed = new Promise<void>((resolveClose, reject) => {
      const timer = setTimeout(() => reject(new Error('idle client was not disconnected')), 35000);
      clients[0].once('close', () => { clearTimeout(timer); resolveClose(); });
    });
    const start = Date.now();
    const [watch, attest] = await Promise.all([
      runCli(db, sock, 'watch', { after: Number.MAX_SAFE_INTEGER, wait: 32 }),
      runCli(db, sock, 'attest', { id: 'task', actor: 'worker', epoch: claim.epoch, cwd: root, kind: 'run', payload: { cmd: 'sleep 32' }, timeout_secs: 40 }),
      idleClosed,
    ]);
    assert.equal(watch.code, 0, watch.err); assert.equal(attest.code, 0, attest.err);
    assert.equal(object(JSON.parse(attest.out)).passed, true);
    assert.ok(Date.now() - start >= 30000, 'in-flight operations must outlive the idle timeout');
  } finally {
    for (const client of clients) client.destroy();
    daemon.kill('SIGTERM'); await exited;
    rmSync(root, { recursive: true, force: true });
  }
});
