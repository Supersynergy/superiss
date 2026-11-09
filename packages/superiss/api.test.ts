import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Engine } from './engine.ts';
import { startHttp } from './ts/http.ts';
import { object, SisError, tokenCount, type Obj } from './ts/util.ts';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sis-api-')); let engine = new Engine(join(root, 'tasks.db'));
  const probe = createServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as { port: number }).port; await new Promise<void>(r => probe.close(() => r()));
  const dispatch = async (input: Obj): Promise<Obj> => {
    try { return { ok: true, data: await engine.dispatch(String(input.cmd), input.args ?? {}, { actor: typeof input.actor === 'string' ? input.actor : 'socket', explicit: typeof input.actor === 'string', idem: typeof input.idem === 'string' ? input.idem : null }) }; }
    catch (error) { return { ok: false, error: { code: error instanceof SisError ? error.code : 'internal', msg: String(error) } }; }
  };
  let server = await startHttp(engine, port, dispatch);
  const url = 'http://127.0.0.1:' + port;
  const rpc = (body: unknown, path = '/api/v1/rpc', headers: Record<string, string> = {}) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { get engine() { return engine; }, root, url, port, rpc, async restart() { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await engine.shutdown(); engine.db.close(); engine = new Engine(join(root, 'tasks.db')); server = await startHttp(engine, port, dispatch); }, async close() { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await engine.shutdown(); engine.db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('versioned API describes every registered operation and actual runtime identity', async () => {
  const f = await fixture();
  try {
    const caps = await (await fetch(f.url + '/api/v1/capabilities')).json() as { ok: boolean; data: Obj };
    assert.equal(caps.ok, true); assert.equal(caps.data.version, '1.3.0');
    assert.ok(Array.isArray(caps.data.operations));
    const spec = await (await fetch(f.url + '/api/v1/openapi.json')).json() as { openapi: string; paths: Record<string, unknown> };
    assert.equal(spec.openapi, '3.1.0');
    for (const name of caps.data.operations as string[]) assert.ok(spec.paths['/api/v1/ops/' + name], name);
    const context = await (await fetch(f.url + '/api/v1/context')).json() as { data: Obj };
    assert.equal(object(context.data.capabilities).version, '1.3.0'); assert.ok(context.data.project_id);
    assert.equal((await fetch(f.url + '/health')).status, 200);
  } finally { await f.close(); }
});

test('claimed task updates always require the live owner and epoch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sis-update-fence-'));
  const engine = new Engine(join(root, 'tasks.db'));
  try {
    await engine.dispatch('create', { id: 'owned', title: 'original', oracle_cmd: 'true', allowed_paths: ['source'] });
    const claim = object(await engine.dispatch('claim', { id: 'owned', actor: 'owner', ttl: 60 }));
    const update = { id: 'owned', set: { title: 'unauthorized' } };
    await assert.rejects(engine.dispatch('update', update));
    await assert.rejects(engine.dispatch('update', update, { actor: 'owner', explicit: true }));
    await assert.rejects(engine.dispatch('update', { ...update, actor: 'other', epoch: claim.epoch }));
    await assert.rejects(engine.dispatch('update', { ...update, actor: 'owner', epoch: Number(claim.epoch) + 1 }));
    assert.equal(engine.issue('owned').title, 'original');
    await engine.dispatch('update', { id: 'owned', actor: 'owner', epoch: claim.epoch, set: { title: 'authorized' } });
    assert.equal(engine.issue('owned').title, 'authorized');
  } finally { await engine.shutdown(); engine.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('RPC and named operations preserve idempotency and correlation', async () => {
  const f = await fixture();
  try {
    const input = { cmd: 'create', args: { id: 'one', title: 'one' }, actor: 'api-worker', idem: 'create-one', request_id: 'req-one' };
    for (let i = 0; i < 2; i++) {
      const reply = await (await f.rpc(input)).json() as Obj;
      assert.equal(reply.ok, true); assert.equal(reply.request_id, 'req-one'); assert.equal(object(reply.data).id, 'one');
    }
    const conflict = await f.rpc({ ...input, args: { id: 'one', title: 'different' } }); assert.equal(conflict.status, 400);
    const named = await (await f.rpc({ args: { id: 'one' }, request_id: 'named' }, '/api/v1/ops/show')).json() as Obj;
    assert.equal(object(object(named.data).issue).id, 'one'); assert.equal(named.request_id, 'named');
    assert.equal((await f.rpc({ cmd: 'stats', args: {}, request_id: '' })).status, 400);
  } finally { await f.close(); }
});

test('atomic batch rolls back and rejects nested or executing commands', async () => {
  const f = await fixture();
  try {
    const reply = await (await f.rpc({ ops: [{ cmd: 'create', args: { id: 'a', title: 'a' } }, { cmd: 'create', args: { id: 'b', title: 'b' } }] }, '/api/v1/batch')).json() as Obj;
    assert.equal(reply.ok, true); assert.equal((object(reply.data).results as unknown[]).length, 2);
    assert.equal((await f.rpc({ ops: [{ cmd: 'create', args: { id: 'rollback', title: 'rollback' } }, { cmd: 'not_real' }] }, '/api/v1/batch')).status, 400);
    await assert.rejects(f.engine.dispatch('show', { id: 'rollback' }));
    for (const ops of [[{ cmd: 'batch', args: { ops: [] } }], [{ cmd: 'verify', args: {} }], [{ cmd: 'attest', args: { kind: 'run' } }], Array.from({ length: 65 }, () => ({ cmd: 'stats' }))]) {
      assert.equal((await f.rpc({ ops }, '/api/v1/batch')).status, 400);
    }
    assert.equal((await f.rpc({ cmd: 'batch', args: { ops: [{ cmd: 'batch', args: { ops: [] } }] } })).status, 400);
  } finally { await f.close(); }
});

test('HTTP rejects unsafe origins, form posts, rebinding and GET mutations before dispatch', async () => {
  const f = await fixture();
  try {
    for (const headers of [{ origin: 'https://evil.invalid' }, { 'sec-fetch-site': 'cross-site' }, { host: 'evil.invalid:' + f.port }] as Record<string, string>[]) assert.equal((await f.rpc({ cmd: 'create', args: { id: 'evil', title: 'evil' } }, '/api/v1/rpc', headers)).status, 403);
    for (const cmd of ['create', 'woop', 'verify', 'attest', 'analytics', 'analytics_report', 'migrate_copy', 'goal_create', 'subgoal', 'tag', 'comment', 'merge_slot']) {
      assert.equal((await fetch(f.url + '/op?q=' + encodeURIComponent(JSON.stringify({ cmd, args: { id: 'unsafe', title: 'unsafe' } })))).status, 405, cmd);
    }
    assert.equal((await fetch(f.url + '/op?q=' + encodeURIComponent(JSON.stringify({ cmd: 'stats' })))).status, 200);
    assert.equal((await fetch(f.url + '/op', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"cmd":"stats"}' })).status, 415);
    assert.equal((await f.rpc({ cmd: 'stats' }, '/unknown')).status, 404);
    await assert.rejects(f.engine.dispatch('show', { id: 'evil' })); await assert.rejects(f.engine.dispatch('show', { id: 'unsafe' }));
  } finally { await f.close(); }
});

test('body and envelope bounds reject invalid inputs without killing the HTTP server', async () => {
  const f = await fixture();
  try {
    for (const input of [[], null, { cmd: 'stats', args: [] }, { cmd: 42 }, { cmd: 'stats', args: 'bad' }]) assert.equal((await f.rpc(input)).status, 400);
    assert.equal((await fetch(f.url + '/api/v1/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' })).status, 400);
    assert.equal((await f.rpc({ cmd: 'create', args: { title: 'x'.repeat(1024 * 1024) } })).status, 413);
    assert.equal((await fetch(f.url + '/api/v1/capabilities')).status, 200);
  } finally { await f.close(); }
});

test('tracker snapshots page/filter the native store and reconnect from a consistent cursor', async () => {
  const f = await fixture();
  try {
    for (const id of ['a', 'b', 'c']) await f.engine.dispatch('create', { id, title: id, owner: id === 'c' ? 'other' : 'worker', lane: 'local' });
    const first = await (await fetch(f.url + '/api/v1/tracker?owner=worker&lane=local&status=open&limit=1')).json() as Obj;
    assert.equal(first.ok, true); const page = object(first.data); assert.equal(page.total, 2); assert.equal(page.next_offset, 1);
    const second = object((await (await fetch(f.url + '/api/v1/tracker?owner=worker&lane=local&status=open&limit=1&offset=1')).json() as Obj).data);
    assert.notEqual(object((page.issues as Obj[])[0]).id, object((second.issues as Obj[])[0]).id); assert.equal(second.next_offset, null);
    const cursor = page.cursor; await f.engine.dispatch('create', { id: 'later', title: 'later' }); await f.restart();
    const events = object((await (await fetch(f.url + '/api/v1/events?after=' + String(cursor))).json() as Obj).data).events as Obj[];
    assert.ok(events.some(event => event.issue === 'later')); assert.ok(events.every(event => Number(event.seq) > Number(cursor)));
    const resumed = object((await (await fetch(f.url + '/api/v1/tracker?owner=worker')).json() as Obj).data);
    assert.equal(resumed.total, 2); assert.ok(Number(resumed.cursor) > Number(cursor));
  } finally { await f.close(); }
});

test('tracker separates blocked, expired and latest failed-proof views without taking ownership', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.root, 'source'), 'one');
    for (const id of ['prerequisite', 'blocked', 'expired', 'failed']) await f.engine.dispatch('create', { id, title: id, owner: 'worker', oracle_cmd: 'false', allowed_paths: ['source'] });
    await f.engine.dispatch('dep', { issue: 'blocked', depends_on: 'prerequisite' });
    const expired = object(await f.engine.dispatch('acquire', { id: 'expired', actor: 'worker', ttl: 60 }));
    const failed = object(await f.engine.dispatch('acquire', { id: 'failed', actor: 'worker', ttl: 60 }));
    await f.engine.dispatch('verify', { id: 'failed', actor: 'worker', epoch: failed.epoch, cwd: f.root });
    f.engine.run('UPDATE issues SET lease_until=0 WHERE id=?', 'expired');
    const before = Number(f.engine.row('SELECT MAX(seq) n FROM events')?.n);
    for (const [view, id] of [['blocked', 'blocked'], ['expired', 'expired'], ['failed-proof', 'failed']]) {
      const reply = await (await fetch(f.url + '/api/v1/tracker?view=' + view)).json() as Obj;
      assert.equal(reply.ok, true, JSON.stringify(reply)); const data = object(reply.data);
      assert.deepEqual((data.issues as Obj[]).map(issue => issue.id), [id]);
    }
    assert.equal(f.engine.issue('expired').lease_epoch, expired.epoch); assert.equal(Number(f.engine.row('SELECT MAX(seq) n FROM events')?.n), before);
  } finally { await f.close(); }
});

test('compact loop receipt keeps scope/oracle/fence and detects persisted source drift', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.root, 'source'), 'one');
    await f.engine.dispatch('create', { id: 'loop', title: 'loop', owner: 'worker', allowed_paths: ['source'], oracle_cmd: 'true' });
    const claim = object(await f.engine.dispatch('acquire', { id: 'loop', actor: 'worker', ttl: 60 }));
    await f.engine.dispatch('checkpoint', { id: 'loop', actor: 'worker', epoch: claim.epoch, cwd: f.root, text: 'tests passed', next_step: 'run original oracle' });
    const get = async () => object((await (await fetch(f.url + '/api/v1/loops/loop')).json() as Obj).data);
    const receipt = await get(); assert.equal(receipt.verdict, 'in_progress'); assert.deepEqual(object(receipt.contract).allowed_paths, ['source']); assert.equal(object(receipt.contract).oracle_cmd, 'true');
    assert.equal(object(receipt.claim).epoch, claim.epoch); assert.equal(object(receipt.claim).actor, 'worker'); assert.equal(object(receipt.claim).valid, true);
    assert.equal(object(receipt.checkpoint).stale, false); assert.equal(object(receipt.checkpoint).next_step, 'run original oracle'); assert.equal(object(receipt.next).cmd, 'resume');
    writeFileSync(join(f.root, 'source'), 'two'); await f.restart(); const drift = await get();
    assert.equal(drift.verdict, 'source_drift'); assert.equal(object(drift.checkpoint).stale, true);
    f.engine.run('UPDATE issues SET lease_until=0 WHERE id=?', 'loop'); assert.equal(object((await get()).claim).valid, false);
    assert.equal((await fetch(f.url + '/api/v1/loops/missing')).status, 400);
  } finally { await f.close(); }
});

test('tracker and receipt discovery preserve input bounds and same-origin guards', async () => {
  const f = await fixture();
  try {
    for (const query of ['limit=0', 'limit=501', 'offset=-1', 'view=nope', 'status=nope', 'limit=1&limit=2', 'unknown=x']) assert.equal((await fetch(f.url + '/api/v1/tracker?' + query)).status, 400, query);
    for (const path of ['/api/v1/tracker', '/api/v1/loops/anything']) assert.equal((await fetch(f.url + path, { headers: { origin: 'https://evil.invalid' } })).status, 403);
    const spec = await (await fetch(f.url + '/api/v1/openapi.json')).json() as { paths: Record<string, unknown> };
    assert.ok(spec.paths['/api/v1/tracker']); assert.ok(spec.paths['/api/v1/loops/{id}']);
  } finally { await f.close(); }
});

test('source-bound capsules enforce the complete text budget and invalidate drift without claiming', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.root, 'source'), 'one');
    await f.engine.dispatch('create', { id: 'capsule', title: 'capsule', allowed_paths: ['source'], oracle_cmd: 'true', meta: { review_required: true }, desc: 'optional '.repeat(4000) });
    const claim = object(await f.engine.dispatch('acquire', { id: 'capsule', actor: 'worker', ttl: 60 }));
    await f.engine.dispatch('checkpoint', { id: 'capsule', actor: 'worker', epoch: claim.epoch, cwd: f.root, text: 'ready', next_step: 'run original oracle' });
    const get = async (query = 'max_tokens=2000') => {
      const response = await fetch(f.url + '/api/v1/capsules/capsule?' + query), reply = await response.json() as Obj;
      assert.equal(response.status, 200, JSON.stringify(reply)); return object(reply.data);
    };
    const before = Number(f.engine.row('SELECT MAX(seq) n FROM events')?.n), capsule = await get();
    assert.equal(capsule.used_tokens, tokenCount(String(capsule.text), 'o200k_base')); assert.ok(Number(capsule.used_tokens) <= 2000);
    assert.equal(capsule.usable, true); assert.match(String(capsule.source_hash), /^[a-f0-9]{64}$/);
    const content = JSON.parse(String(capsule.text)) as Obj, contract = object(content.contract);
    assert.deepEqual(contract.allowed_paths, ['source']); assert.equal(contract.oracle_cmd, 'true'); assert.equal(object(contract.meta).review_required, true);
    assert.equal(object(content.claim).epoch, claim.epoch); assert.equal(content.source_hash, capsule.source_hash); assert.ok((capsule.omitted as string[]).includes('desc'));
    assert.equal(Number(f.engine.row('SELECT MAX(seq) n FROM events')?.n), before);
    const small = await fetch(f.url + '/api/v1/capsules/capsule?max_tokens=128'); assert.equal(small.status, 400);
    assert.equal(object((await small.json() as Obj).error).code, 'budget_exceeded');
    const alternate = await get('max_tokens=2000&encoding=cl100k_base'); assert.equal(alternate.used_tokens, tokenCount(String(alternate.text), 'cl100k_base'));
    writeFileSync(join(f.root, 'source'), 'two'); await f.restart(); const stale = await get();
    assert.notEqual(stale.source_hash, capsule.source_hash); assert.equal(stale.usable, false); assert.equal((JSON.parse(String(stale.text)) as Obj).verdict, 'source_drift');
    for (const query of ['max_tokens=0', 'max_tokens=8001', 'max_tokens=2&max_tokens=3', 'encoding=bad', 'unknown=x']) assert.equal((await fetch(f.url + '/api/v1/capsules/capsule?' + query)).status, 400);
    assert.equal((await fetch(f.url + '/api/v1/capsules/capsule', { headers: { origin: 'https://evil.invalid' } })).status, 403);
    const spec = await (await fetch(f.url + '/api/v1/openapi.json')).json() as Obj; assert.ok(object(spec.paths)['/api/v1/capsules/{id}']);
  } finally { await f.close(); }
});

test('reusable local API client correlates parallel calls, preserves failures and reconnects', async () => {
  const { SuperissClient } = await import('./ts/client.ts'), f = await fixture(), client = new SuperissClient(f.url, { maxConnections: 2 });
  try {
    writeFileSync(join(f.root, 'source'), 'one');
    const input = { id: 'client', title: 'client', oracle_cmd: 'false', allowed_paths: ['source'] }, options = { actor: 'worker', idem: 'client-create' };
    for (let i = 0; i < 2; i++) assert.equal(object(await client.rpc('create', input, options)).id, 'client');
    const shows = await Promise.all(Array.from({ length: 8 }, () => client.rpc('show', { id: 'client' }))); assert.ok(shows.every(row => object(object(row).issue).id === 'client'));
    const claim = object(await client.rpc('acquire', { id: 'client', ttl: 60 }, { actor: 'worker' }));
    const proof = object(await client.rpc('verify', { id: 'client', epoch: claim.epoch, cwd: f.root }, { actor: 'worker' })); assert.equal(proof.passed, false);
    const capsule = await client.capsule('client'); assert.equal((JSON.parse(String(capsule.text)) as Obj).verdict, 'failed');
    const snapshot = await client.tracker({ limit: 1 }); assert.equal(snapshot.total, 1);
    assert.equal((await client.batch([{ cmd: 'stats' }]) as Obj[]).length, 1);
    await f.restart(); assert.equal((await client.loop('client')).id, 'client');
    await client.rpc('create', { id: 'reconnected', title: 'reconnected' });
    assert.ok(((await client.events({ after: Number(snapshot.cursor), wait: 0 })).events as Obj[]).some(event => event.issue === 'reconnected'));
    await assert.rejects(client.rpc('not_real'), (error: Error & { code?: string }) => error.code === 'bad_cmd');
    await assert.rejects(client.rpc('create', { ...input, title: 'different' }, options), (error: Error & { code?: string }) => error.code === 'idem_conflict');
  } finally { client.close(); await f.close(); }
});

test('API client rejects remote or credential URLs, enforces deadlines and cancellation', async () => {
  const { SuperissClient } = await import('./ts/client.ts');
  for (const url of ['https://127.0.0.1:1', 'http://example.invalid', 'http://user:secret@localhost:1', 'http://127.0.0.1:1/path', 'http://127.0.0.1:1?token=x']) assert.throws(() => new SuperissClient(url));
  const f = await fixture(), client = new SuperissClient(f.url, { maxConnections: 1 });
  try {
    await assert.rejects(client.events({ after: 9007199254740991, wait: 1 }, { timeoutMs: 10 }), (error: Error & { code?: string }) => error.code === 'timeout');
    const abort = new AbortController(), pending = client.events({ after: 9007199254740991, wait: 1 }, { signal: abort.signal }); abort.abort();
    await assert.rejects(pending, (error: Error) => error.name === 'AbortError');
    await assert.rejects(client.rpc('stats', {}, { signal: AbortSignal.abort() }));
    await assert.rejects(client.rpc('create', { title: 'x'.repeat(1024 * 1024) }), (error: Error & { code?: string }) => error.code === 'frame_too_large');
    assert.ok(object(await client.rpc('stats')));
    client.close(); await assert.rejects(client.rpc('stats'), (error: Error & { code?: string }) => error.code === 'client_closed');
  } finally { client.close(); await f.close(); }
});

test('closing a client cancels queued work before it can dispatch an effect', async () => {
  const { SuperissClient } = await import('./ts/client.ts'); let calls = 0, entered!: () => void;
  const seen = new Promise<void>(resolve => { entered = resolve; });
  const server = createHttpServer((req, _res) => { calls++; req.resume(); entered(); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const client = new SuperissClient('http://127.0.0.1:' + (server.address() as { port: number }).port, { maxConnections: 1, timeoutMs: 100 });
  try {
    const active = assert.rejects(client.rpc('stats')); await seen;
    const queued = assert.rejects(client.rpc('create', { id: 'must-not-run' }), (error: Error & { code?: string }) => error.code === 'client_closed');
    client.close(); await Promise.all([active, queued]); assert.equal(calls, 1);
  } finally { client.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test('API client never replays a lost acknowledgement, follows redirects or accepts wrong correlation', async () => {
  const { SuperissClient } = await import('./ts/client.ts'); let calls = 0, mode = 'drop';
  const server = createHttpServer((req, res) => { calls++; req.resume(); if (mode === 'drop') req.socket.destroy(); else if (mode === 'redirect') { res.writeHead(302, { location: 'http://example.invalid' }); res.end(); } else res.end(JSON.stringify({ ok: true, data: {}, request_id: 'wrong' })); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const port = (server.address() as { port: number }).port, client = new SuperissClient('http://127.0.0.1:' + port);
  try {
    await assert.rejects(client.rpc('create', { id: 'effect' })); assert.equal(calls, 1);
    mode = 'redirect'; await assert.rejects(client.rpc('stats'), (error: Error & { code?: string }) => error.code === 'http_error'); assert.equal(calls, 2);
    mode = 'wrong'; await assert.rejects(client.rpc('stats'), (error: Error & { code?: string }) => error.code === 'correlation_mismatch'); assert.equal(calls, 3);
  } finally { client.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test('versioned events preserve cursor and bounded long-poll validation', async () => {
  const f = await fixture();
  try {
    await f.rpc({ cmd: 'create', args: { id: 'event', title: 'event' } });
    const reply = await (await fetch(f.url + '/api/v1/events?after=0&wait=0')).json() as Obj;
    assert.equal(reply.ok, true); assert.ok((object(reply.data).events as unknown[]).length > 0);
    await f.rpc({ cmd: 'create', args: { id: 'event-2', title: 'event 2' } });
    const first = await (await fetch(f.url + '/api/v1/events?after=0&limit=1')).json() as Obj, data = object(first.data), events = data.events as Obj[];
    assert.equal(events.length, 1); assert.equal(data.next_after, events[0].seq);
    const second = await (await fetch(f.url + '/api/v1/events?after=' + String(data.next_after) + '&limit=1')).json() as Obj;
    assert.equal((object(second.data).events as Obj[]).length, 1); assert.ok(Number(object(second.data).next_after) > Number(data.next_after));
    for (const query of ['after=-1', 'after=oops', 'wait=301']) assert.equal((await fetch(f.url + '/api/v1/events?' + query)).status, 400);
    const before = Date.now();
    const empty = await (await fetch(f.url + '/api/v1/events?after=9007199254740991&wait=0.1')).json() as Obj;
    assert.deepEqual(object(empty.data).events, []); assert.equal(object(empty.data).next_after, 9007199254740991); assert.ok(Date.now() - before < 1500);
  } finally { await f.close(); }
});


test('WOOP API and board retain separate native phase evidence through proof, drift and restart', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.root, 'input.txt'), 'synthetic SuperSynergy example\n');
    const stages = ['implementation', 'delivery', 'outcome'];
    const args = {id: 'woop-api', name: 'SuperSynergy appointment example', owner: 'controller',
      wish: '<img src=x onerror=alert(1)>', outcome: 'Confirmed suitable slot', obstacle: 'No available slot',
      if: 'If unavailable', then: 'Request an alternative', stages: Object.fromEntries(stages.map(stage => [stage,
        {oracle_cmd: 'test -s input.txt', allowed_paths: ['input.txt'], acceptance: `${stage} oracle passes`}]))};
    const request = {args, actor: 'controller', idem: 'woop-api-once'};
    for (let i = 0; i < 2; i++) {
      const reply = object(await (await f.rpc(request, '/api/v1/ops/woop')).json());
      assert.equal(reply.ok, true); assert.equal(object(reply.data).goal, 'woop-api');
    }
    const board = async () => object(object(await (await fetch(f.url + '/board')).json()).data);
    const initial = await board(), receipt = object(object(initial.woop_receipts)['woop-api.1']);
    assert.equal(receipt.proof, null);
    assert.equal((initial.issues as Obj[]).length, 4);
    assert.equal((initial.goals as Obj[]).length, 1);
    const claim = object(await f.engine.dispatch('claim', {id: 'woop-api.1', actor: 'worker'}));
    const binding = {id: 'woop-api.1', actor: 'worker', epoch: claim.epoch};
    const proof = object(await f.engine.dispatch('verify', {...binding, cwd: f.root, timeout_secs: 10}));
    assert.equal(proof.passed, true);
    let current = object(object((await board()).woop_receipts)['woop-api.1']);
    assert.equal(object(current.proof).passed, true); assert.equal(object(current.proof).source_current, null);
    assert.equal(current.revision, object(current.proof).revision);
    await f.engine.dispatch('update', {...binding, set: {acceptance: 'Changed acceptance'}});
    current = object(object((await board()).woop_receipts)['woop-api.1']);
    assert.notEqual(current.revision, object(current.proof).revision);
    const snapshot = await board(), goal = (snapshot.goals as Obj[])[0];
    const shown = (goal.children as Obj[]).find(x => x.id === 'woop-api.1')!;
    assert.equal(shown.acceptance, 'Changed acceptance');
    assert.equal(shown.acceptance, (snapshot.issues as Obj[]).find(x => x.id === shown.id)!.acceptance);
    await f.restart();
    current = object(object((await board()).woop_receipts)['woop-api.1']);
    assert.notEqual(current.revision, object(current.proof).revision);
    assert.equal(f.engine.issue('woop-api.2').status, 'open');
  } finally { await f.close(); }
});
