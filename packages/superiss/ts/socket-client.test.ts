import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { VERSION } from '../runtime.ts';
import { SuperissSocketClient } from './socket-client.ts';
import { type Obj } from './util.ts';

async function fixture(respond?: (req: Obj, socket: Socket, connection: number) => boolean) {
  const root = mkdtempSync(join(tmpdir(), 'sis-socket-client-')), db = join(root, 'tasks.db'), sock = join(root, 'server.sock');
  writeFileSync(db, '');
  const sockets = new Set<Socket>(), received: Obj[] = [];
  let connections = 0;
  const server = createServer(socket => {
    const connection = ++connections;
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    createInterface({ input: socket }).on('line', line => {
      const req = JSON.parse(line) as Obj; received.push(req);
      if (respond?.(req, socket, connection)) return;
      const data = req.cmd === 'context' ? { db_path: db, project_id: 'project-one', capabilities: { protocol: 2, proof_receipts: true, version: VERSION } } : { command: req.cmd, args: req.args ?? {} };
      socket.write(JSON.stringify({ id: req.id ?? null, ok: true, data, ...(req.request_id ? { request_id: req.request_id } : {}) }) + '\n');
    });
  });
  await new Promise<void>(resolve => server.listen(sock, resolve)); chmodSync(sock, 0o600);
  return {
    db, sock, received, connections: () => connections,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const hasCode = (code: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === code;

test('socket client multiplexes out-of-order replies after one handshake and retains request metadata', async () => {
  const f = await fixture((req, socket) => {
    if (req.cmd !== 'slow') return false;
    setTimeout(() => socket.write(JSON.stringify({ ok: true, id: req.id, data: 'slow', request_id: req.request_id }) + '\n'), 20);
    return true;
  });
  const client = new SuperissSocketClient(f.sock, f.db);
  try {
    const [slow, fast] = await Promise.all([
      client.request({ id: 1, cmd: 'slow', args: {}, actor: 'worker', idem: 'one', run_id: 'run' }),
      client.request({ id: 2, cmd: 'stats', args: {} }),
    ]);
    assert.equal(slow.id, 1); assert.equal(slow.data, 'slow'); assert.equal(fast.id, 2);
    assert.equal(f.connections(), 1); assert.equal(f.received.filter(req => req.cmd === 'context').length, 1);
    const sent = f.received.find(req => req.cmd === 'slow')!;
    assert.equal(sent.actor, 'worker'); assert.equal(sent.idem, 'one'); assert.equal(sent.run_id, 'run');
    await client.request({ cmd: 'ready', args: {} }); assert.equal(f.connections(), 1);
  } finally { client.close(); await f.close(); }
});

test('socket client rejects wrong database, protocol, runtime and unsafe socket permissions before mutation', async () => {
  for (const kind of ['database', 'protocol', 'runtime', 'permissions']) {
    const f = await fixture((req, socket) => {
      if (req.cmd !== 'context' || kind === 'permissions') return false;
      socket.write(JSON.stringify({ ok: true, data: { db_path: kind === 'database' ? '/missing-database' : f.db, project_id: 'project-one',
        capabilities: { protocol: kind === 'protocol' ? 1 : 2, proof_receipts: true, version: kind === 'runtime' ? '0.0.0' : VERSION } } }) + '\n');
      return true;
    });
    if (kind === 'permissions') chmodSync(f.sock, 0o666);
    const client = new SuperissSocketClient(f.sock, f.db);
    try {
      await assert.rejects(client.request({ cmd: 'create', args: { title: 'must not dispatch' } }));
      assert.equal(f.received.filter(req => req.cmd === 'create').length, 0);
      if (kind === 'permissions') assert.equal(f.connections(), 0);
    } finally { client.close(); await f.close(); }
  }
});

test('lost acknowledgement is never replayed; later calls reconnect and revalidate project identity', async () => {
  const f = await fixture((req, socket) => {
    if (req.cmd !== 'create') return false;
    socket.destroy(); return true;
  });
  const client = new SuperissSocketClient(f.sock, f.db);
  try {
    await assert.rejects(client.request({ cmd: 'create', args: { title: 'once' }, idem: 'once' }), hasCode('transport_uncertain'));
    assert.equal(f.received.filter(req => req.cmd === 'create').length, 1);
    const reply = await client.request({ cmd: 'stats', args: {} }); assert.equal(reply.ok, true);
    assert.equal(f.connections(), 2);
    assert.equal(f.received.filter(req => req.cmd === 'context').length, 2);
    assert.equal(f.received.filter(req => req.cmd === 'create').length, 1);
  } finally { client.close(); await f.close(); }
  const changed = await fixture((req, socket, connection) => {
    if (req.cmd === 'create') { socket.destroy(); return true; }
    if (req.cmd !== 'context' || connection === 1) return false;
    socket.write(JSON.stringify({ ok: true, data: { db_path: changed.db, project_id: 'different-project', capabilities: { version: VERSION, protocol: 2, proof_receipts: true } } }) + '\n');
    return true;
  });
  const bound = new SuperissSocketClient(changed.sock, changed.db);
  try {
    await assert.rejects(bound.request({ cmd: 'create', args: {} }), hasCode('transport_uncertain'));
    await assert.rejects(bound.request({ cmd: 'stats', args: {} }), hasCode('project_binding_mismatch'));
    assert.equal(changed.received.filter(req => req.cmd === 'stats').length, 0);
  } finally { bound.close(); await changed.close(); }
});

test('pending limits, request bounds, deadlines and aborts settle without retry or server cancellation', async () => {
  const f = await fixture(req => req.cmd !== 'context');
  const client = new SuperissSocketClient(f.sock, f.db, { maxPending: 1 });
  try {
    await assert.rejects(client.request({ cmd: 'create', args: { value: 'x'.repeat(1048576) } }), hasCode('frame_too_large'));
    await assert.rejects(client.request({ cmd: 'watch', args: { follow: true } }), hasCode('bad_args'));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(client.request({ cmd: 'stats' }, { signal: controller.signal }), hasCode('aborted'));
    assert.equal(f.connections(), 0);
    const work = client.request({ cmd: 'stats' }, { timeoutMs: 80 });
    await assert.rejects(client.request({ cmd: 'stats' }), hasCode('busy'));
    await assert.rejects(work, hasCode('transport_uncertain'));
    assert.equal(f.received.filter(req => req.cmd === 'stats').length, 1);
    const signal = new AbortController(), next = client.request({ cmd: 'ready' }, { signal: signal.signal });
    const rejection = assert.rejects(next, error => hasCode('aborted')(error) || hasCode('transport_uncertain')(error));
    signal.abort(); await rejection;
    client.close();
    await assert.rejects(client.request({ cmd: 'stats' }), hasCode('client_closed'));
  } finally { client.close(); await f.close(); }
});

test('malformed and uncorrelated replies fail closed rather than satisfying another request', async () => {
  for (const body of ['not json\n', '{"ok":true,"data":1,"request_id":"wrong"}\n']) {
    const f = await fixture((req, socket) => {
      if (req.cmd === 'context') return false;
      socket.write(body); return true;
    });
    const client = new SuperissSocketClient(f.sock, f.db);
    try { await assert.rejects(client.request({ cmd: 'stats' }), hasCode('transport_uncertain')); }
    finally { client.close(); await f.close(); }
  }
});
