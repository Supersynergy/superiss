import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { VERSION } from '../runtime.ts';
import { Engine } from '../engine.ts';
import type { Obj } from './util.ts';

class Peer {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exit: Promise<number | null>;
  private lines: string[] = [];
  private receiver?: (line: string) => void;
  constructor(cmd: string, db: string, sock?: string) {
    const env: NodeJS.ProcessEnv = { ...process.env, SIS_EMIT: '0' };
    for (const key of ['SIS_SOCK', 'SIS_DB', 'SIS_DIRECT', 'SIS_HTTP']) delete env[key];
    if (sock) env.SIS_SOCK = sock;
    this.child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'cli.ts'), cmd, '--db', db], { env, stdio: 'pipe' });
    this.child.stderr.resume();
    this.exit = new Promise(resolve => this.child.once('close', resolve));
    createInterface({ input: this.child.stdout }).on('line', line => {
      if (this.receiver) { const receive = this.receiver; this.receiver = undefined; receive(line); }
      else this.lines.push(line);
    });
  }
  send(value: Obj | string): void { this.child.stdin.write(typeof value === 'string' ? value : JSON.stringify(value) + '\n'); }
  async read(): Promise<Obj> {
    const line = this.lines.shift() ?? await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { this.receiver = undefined; reject(Error('session did not answer')); }, 3000);
      this.receiver = value => { clearTimeout(timer); resolve(value); };
    });
    return JSON.parse(line) as Obj;
  }
  async stop(): Promise<void> {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
    await this.exit; clearTimeout(timer);
  }
}

test('native rpc retains one engine, request identity and idempotent mutations through EOF', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sis-rpc-')), db = join(root, 'tasks.db');
  const peer = new Peer('rpc', db);
  try {
    peer.send({ id: 1, cmd: 'context', args: {} });
    const first = await peer.read();
    assert.equal(first.ok, true);
    assert.equal((first.data as Obj).pid, peer.child.pid);
    const request = { cmd: 'create', args: { id: 'task', title: 'Überprüfung 🧪' }, actor: 'controller', idem: 'create-task' };
    for (const id of [2, 3]) {
      peer.send({ ...request, id });
      const reply = await peer.read();
      assert.equal(reply.id, id); assert.equal(reply.ok, true); assert.equal((reply.data as Obj).id, 'task');
    }
    peer.send({ id: 4, cmd: 'stats', args: {} });
    assert.equal(((await peer.read()).data as Obj).total, 1);
    peer.send({ id: 5, cmd: 'context', args: {} });
    assert.equal(((await peer.read()).data as Obj).instance_id, (first.data as Obj).instance_id);
    const encoded = Buffer.from(JSON.stringify({ id: 6, cmd: 'show', args: { id: 'task' } }) + '\n');
    peer.child.stdin.write(encoded.subarray(0, 17)); peer.child.stdin.write(encoded.subarray(17));
    assert.equal((((await peer.read()).data as Obj).issue as Obj).title, 'Überprüfung 🧪');
    await peer.stop(); assert.equal(await peer.exit, 0);
  } finally { await peer.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('native rpc termination closes its owned session without killing or replacing a daemon', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sis-rpc-stop-')), peer = new Peer('rpc', join(root, 'tasks.db'));
  try {
    peer.send({ id: 1, cmd: 'stats', args: {} }); assert.equal((await peer.read()).ok, true);
    peer.child.kill('SIGTERM'); assert.equal(await peer.exit, 143);
  } finally { await peer.stop(); rmSync(root, { recursive: true, force: true }); }
});

test('native rpc exits within its output deadline when its consumer never reads', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sis-rpc-pressure-'));
  const env: NodeJS.ProcessEnv = { ...process.env, SIS_DIRECT: '1', SIS_EMIT: '0' };
  for (const key of ['SIS_SOCK', 'SIS_DB', 'SIS_HTTP']) delete env[key];
  const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'cli.ts'), 'rpc', '--db', join(root, 'tasks.db')], { env, stdio: 'pipe' });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); }); child.stdin.on('error', () => {});
  const exit = new Promise<number | null>(resolve => child.once('exit', resolve));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    child.stdin.end(Array.from({ length: 2000 }, (_, id) => JSON.stringify({ id, cmd: 'context', args: {} }) + '\n').join(''));
    const code = await Promise.race([exit, new Promise<string>(resolve => { timer = setTimeout(() => resolve('hung'), 7500); })]);
    assert.equal(code, 2, 'a blocked stdout must not keep the process alive after its deadline: ' + stderr);
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child.stdout.destroy(); child.stdin.destroy(); await exit;
    rmSync(root, { recursive: true, force: true });
  }
});

test('native MCP also closes a blocked output channel instead of buffering indefinitely', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sis-mcp-pressure-')), db = join(root, 'tasks.db');
  const engine = new Engine(db);
  await engine.dispatch('create', { id: 'large', title: 'Large read', desc: 'x'.repeat(600000) });
  await engine.shutdown(); engine.db.close();
  const env: NodeJS.ProcessEnv = { ...process.env, SIS_DIRECT: '1', SIS_EMIT: '0' };
  for (const key of ['SIS_SOCK', 'SIS_DB', 'SIS_HTTP']) delete env[key];
  const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'cli.ts'), 'mcp', '--db', db], { env, stdio: 'pipe' });
  child.stderr.resume(); child.stdin.on('error', () => {});
  const exit = new Promise<number | null>(resolve => child.once('exit', resolve));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    child.stdin.end(Array.from({ length: 4 }, (_, id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'sis_show', arguments: { id: 'large' } } }) + '\n').join(''));
    const code = await Promise.race([exit, new Promise<string>(resolve => { timer = setTimeout(() => resolve('hung'), 7500); })]);
    assert.equal(code, 2);
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child.stdout.destroy(); child.stdin.destroy(); await exit;
    rmSync(root, { recursive: true, force: true });
  }
});

test('bounded MCP input preserves Content-Length framing and selected tools', () => {
  const root = mkdtempSync(join(tmpdir(), 'sis-mcp-headers-'));
  const env: NodeJS.ProcessEnv = { ...process.env, SIS_DIRECT: '1' };
  for (const key of ['SIS_SOCK', 'SIS_DB', 'SIS_HTTP']) delete env[key];
  try {
    const requests = [{ jsonrpc: '2.0', id: 1, method: 'initialize' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }];
    const input = requests.map(req => { const body = JSON.stringify(req); return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`; }).join('');
    const result = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'cli.ts'), 'mcp', '--db', join(root, 'tasks.db'), '--tool', 'stats', '--mcp-headers'], { env, input, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    let bytes = Buffer.from(result.stdout); const replies: Obj[] = [];
    while (bytes.length) {
      const end = bytes.indexOf('\r\n\r\n'); assert.ok(end > 0);
      const size = Number(bytes.subarray(0, end).toString().match(/^Content-Length: (\d+)$/u)?.[1]);
      assert.ok(Number.isSafeInteger(size)); replies.push(JSON.parse(bytes.subarray(end + 4, end + 4 + size).toString()) as Obj);
      bytes = bytes.subarray(end + 4 + size);
    }
    assert.equal(replies.length, 2);
    assert.equal(((replies[0].result as Obj).serverInfo as Obj).version, VERSION);
    assert.deepEqual(((replies[1].result as Obj).tools as Obj[]).map(tool => tool.name), ['sis_stats']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native rpc bounds malformed, oversized and incomplete input without executing it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sis-rpc-input-'));
  const peer = new Peer('rpc', join(root, 'tasks.db'));
  try {
    peer.send('not json\n');
    assert.equal(((await peer.read()).error as Obj).code, 'bad_json');
    peer.send({ id: 1, cmd: 'stats', args: {} });
    assert.equal((await peer.read()).ok, true);
    peer.send('x'.repeat(1048577));
    assert.equal(((await peer.read()).error as Obj).code, 'frame_too_large');
    assert.equal(await peer.exit, 2);
  } finally { await peer.stop(); rmSync(root, { recursive: true, force: true }); }
  const other = mkdtempSync(join(tmpdir(), 'sis-rpc-eof-')), partial = new Peer('rpc', join(other, 'tasks.db'));
  try {
    partial.send('{"cmd":"create","args":{"title":"not dispatched"}}');
    partial.child.stdin.end();
    assert.equal(((await partial.read()).error as Obj).code, 'bad_frame');
    assert.equal(await partial.exit, 2);
  } finally { await partial.stop(); rmSync(other, { recursive: true, force: true }); }
});

test('MCP socket backend reuses one identity-bound connection for successive tool calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sis-mcp-reuse-')), db = join(root, 'tasks.db'), sock = join(root, 'server.sock');
  writeFileSync(db, '');
  let connections = 0, handshakes = 0;
  const server = createServer(socket => {
    connections++;
    createInterface({ input: socket }).on('line', line => {
      const req = JSON.parse(line) as Obj;
      if (req.cmd === 'context') handshakes++;
      const data = req.cmd === 'context'
        ? { db_path: db, project_id: 'project-one', capabilities: { protocol: 2, proof_receipts: true, version: VERSION } }
        : { total: 0 };
      socket.write(JSON.stringify({ id: req.id ?? null, ok: true, data, ...(req.request_id ? { request_id: req.request_id } : {}) }) + '\n');
    });
  });
  await new Promise<void>(resolve => server.listen(sock, resolve)); chmodSync(sock, 0o600);
  const peer = new Peer('mcp', db, sock);
  try {
    for (const id of [1, 2, 3]) {
      peer.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'sis_stats', arguments: {} } });
      const reply = await peer.read(), result = reply.result as Obj;
      assert.equal(result.isError, false);
    }
    assert.equal(connections, 1);
    assert.equal(handshakes, 1);
    await peer.stop(); assert.equal(await peer.exit, 0);
  } finally {
    await peer.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
