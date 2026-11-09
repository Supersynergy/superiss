import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Engine } from './engine.ts';
import { object, type Obj } from './ts/util.ts';
const localZeroAvailable = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

async function fixture(patch: Obj = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sis-zero-'))), db = join(root, 'tasks.db');
  writeFileSync(join(root, 'source.txt'), 'source');
  const engine = new Engine(db);
  await engine.dispatch('create', { id: 'job', title: 'job', owner: 'worker', budget_eur: 0, allowed_paths: ['source.txt'], oracle_cmd: 'true', meta: { local_zero: true, execution: { cmd: 'printf executed > output.txt', cwd: root } }, ...patch });
  const claim = object(await engine.dispatch('acquire', { id: 'job', actor: 'worker', ttl: 600 }));
  const fence: Obj = { id: 'job', actor: 'worker', epoch: claim.epoch, cwd: root };
  return { root, engine, fence, async close() { await engine.shutdown(); engine.db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('local-zero contract binds budget and security metadata and advertises execution capability', async () => {
  const f = await fixture();
  try {
    const contract = object(object(await f.engine.dispatch('contract', { id: 'job' })).task);
    assert.equal(contract.budget_eur, 0); assert.equal(object(contract.meta).local_zero, true);
    const revision = contract.revision;
    f.engine.run('UPDATE issues SET budget_eur=1 WHERE id=?', 'job');
    assert.notEqual(object(object(await f.engine.dispatch('contract', { id: 'job' })).task).revision, revision);
    assert.equal(object(await f.engine.dispatch('capabilities')).local_zero_execution, process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'));
  } finally { await f.close(); }
});

test('nonzero/missing budgets and positive subtree costs deny execution', async () => {
  for (const budget_eur of [null, 1]) {
    const f = await fixture({ budget_eur });
    try { await assert.rejects(f.engine.dispatch('verify', f.fence), { code: 'local_zero_budget' }); }
    finally { await f.close(); }
  }
  const f = await fixture();
  try {
    await f.engine.dispatch('create', { id: 'job.child', title: 'child' });
    await f.engine.dispatch('cost_add', { issue: 'job.child', cents: 1 });
    await assert.rejects(f.engine.dispatch('verify', f.fence), { code: 'budget_exceeded' });
  } finally { await f.close(); }
});

test('local-zero command mismatches deny execution when the sandbox is available', { skip: !localZeroAvailable }, async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.engine.dispatch('attest', { ...f.fence, kind: 'run', cmd: 'printf wrong > output.txt' }), { code: 'execution_mismatch' });
    assert.equal(existsSync(join(f.root, 'output.txt')), false);
  } finally { await f.close(); }
});

test('unsupported local-zero execution fails closed without writing an effect', { skip: localZeroAvailable }, async () => {
  const f = await fixture({ oracle_cmd: 'printf oracle > output.txt' });
  try {
    await assert.rejects(f.engine.dispatch('verify', f.fence), { code: 'local_zero_unavailable' });
    await assert.rejects(f.engine.dispatch('attest', { ...f.fence, kind: 'run', cmd: 'printf executed > output.txt' }), { code: 'local_zero_unavailable' });
    assert.equal(existsSync(join(f.root, 'output.txt')), false);
    assert.equal(f.engine.rows('SELECT * FROM attests WHERE issue=?', 'job').length, 0);
  } finally { await f.close(); }
});

test('local-zero keeps credentials absent and denies filesystem escapes and network access', { skip: process.platform !== 'darwin' }, async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sis-outside-'))), f = await fixture();
  const old = process.env.SIS_TEST_CREDENTIAL; process.env.SIS_TEST_CREDENTIAL = 'must-not-reach-child';
  let received = 0; const server = createServer((_req, res) => { received++; res.end('unexpected'); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const port = (server.address() as { port: number }).port;
  try {
    const output = object(await f.engine.dispatch('attest', { ...f.fence, kind: 'run', cmd: 'printf executed > output.txt' }));
    assert.equal(output.passed, true); assert.equal(readFileSync(join(f.root, 'output.txt'), 'utf8'), 'executed');
    assert.equal(object(object(output.summary).execution).network, 'denied');
    for (const [cmd, passed] of [[`test -z "$SIS_TEST_CREDENTIAL" && test "$HOME" = '${f.root}'`, true], [`printf escape > '${join(outside, 'escaped')}'`, false], [`/usr/bin/curl --max-time 1 --silent http://127.0.0.1:${port}`, false]] as const) {
      f.engine.run('UPDATE issues SET oracle_cmd=? WHERE id=?', cmd, 'job');
      const proof = object(await f.engine.dispatch('verify', { ...f.fence, timeout_secs: 3 })); assert.equal(proof.passed, passed, cmd);
    }
    assert.equal(received, 0); assert.equal(existsSync(join(outside, 'escaped')), false);
  } finally { if (old === undefined) delete process.env.SIS_TEST_CREDENTIAL; else process.env.SIS_TEST_CREDENTIAL = old; server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await f.close(); rmSync(outside, { recursive: true, force: true }); }
});

test('close_check preserves zero-budget and local-zero cost gates without closing the task', async () => {
  const policies: Obj[] = [{ budget_gate: true }, ...(process.platform === 'darwin' ? [{ local_zero: true }] : [])];
  for (const meta of policies) {
    const f = await fixture({ meta });
    try {
      const proof = object(await f.engine.dispatch('verify', f.fence));
      assert.equal(proof.passed, true);
      const close = { ...f.fence, proof_id: proof.proof_id };
      assert.equal(object(await f.engine.dispatch('close_check', close)).valid, true);
      assert.equal(f.engine.issue('job').status, 'in_progress');
      await f.engine.dispatch('create', { id: 'job.child', title: 'child' });
      await f.engine.dispatch('cost_add', { issue: 'job.child', cents: 1 });
      await assert.rejects(f.engine.dispatch('close_check', close), { code: 'budget_exceeded' });
      await assert.rejects(f.engine.dispatch('close', close), { code: 'budget_exceeded' });
      assert.equal(f.engine.issue('job').status, 'in_progress');
    } finally { await f.close(); }
  }
});

test('worker cannot raise budget or silently remove execution, controller or review policy', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.engine.dispatch('update', { ...f.fence, budget_eur: 1 }), { code: 'over_budget' });
    for (const meta of [{ local_zero: false }, {}, { controller: 'foreign' }, { review_required: false }]) await assert.rejects(f.engine.dispatch('update', { ...f.fence, meta }), { code: 'protected_field' });
  } finally { await f.close(); }
});

test('run attestation is forbidden in a transaction and invalid inherited lock fails before spawn', async () => {
  const f = await fixture(localZeroAvailable ? {} : { meta: {} }); const old = process.env.SIS_CONTROLLER_LOCK_FD;
  try {
    await assert.rejects(f.engine.dispatch('batch', { ops: [{ cmd: 'attest', args: { ...f.fence, kind: 'run', cmd: 'printf executed > output.txt' } }] }));
    process.env.SIS_CONTROLLER_LOCK_FD = 'not-a-descriptor';
    await assert.rejects(f.engine.dispatch('verify', f.fence), { code: 'bad_args' });
  } finally { if (old === undefined) delete process.env.SIS_CONTROLLER_LOCK_FD; else process.env.SIS_CONTROLLER_LOCK_FD = old; await f.close(); }
});

test('autorun export and execution require the matching delivery fence and never redeliver a live lease', async () => {
  // Delivery fencing is portable; sandbox execution is tested separately and
  // remains enabled here on hosts that provide it.
  const policy: Obj = localZeroAvailable ? { local_zero: true } : {};
  const f = await fixture({ meta: { ...policy, execution: { cmd: 'true', cwd: '.' }, autorun: { cmd: 'true' } } });
  try {
    const exported = object(await f.engine.dispatch('outbox_export', { actor: 'runner', kind: 'autorun', ttl: 120, limit: 1 }));
    const job = object((exported.jobs as Obj[])[0]); assert.equal(job.delivery_actor, 'runner'); assert.equal(job.delivery_epoch, 1);
    assert.equal((object(await f.engine.dispatch('outbox_export', { actor: 'other', kind: 'autorun' })).jobs as unknown[]).length, 0);
    await assert.rejects(f.engine.dispatch('outbox_done', { id: job.outbox_id, actor: 'other', epoch: 1 }), { code: 'stale_fence' });
    f.engine.run('UPDATE issues SET meta_json=? WHERE id=?', JSON.stringify({ ...policy, execution: { cmd: 'true', cwd: f.root } }), 'job');
    const run: Obj = { ...f.fence, kind: 'run', cmd: 'true', outbox_id: job.outbox_id, delivery_actor: 'runner', delivery_epoch: 1, idem: job.idempotency_key };
    await assert.rejects(f.engine.dispatch('attest', { ...run, delivery_epoch: 2 }), { code: 'stale_fence' });
    assert.equal(object(await f.engine.dispatch('attest', run)).passed, true);
    await f.engine.dispatch('outbox_done', { id: job.outbox_id, actor: 'runner', epoch: 1 });
    await assert.rejects(f.engine.dispatch('outbox_fail', { id: job.outbox_id, actor: 'runner', epoch: 1 }), { code: 'stale_fence' });
  } finally { await f.close(); }
});

test('lost delivery ACK reconciles a durable run receipt after restart without replay', async () => {
  const f = await fixture({ meta: { autorun: 'printf x >> effect' } });
  try {
    const job = object((object(await f.engine.dispatch('outbox_export', { actor: 'first', kind: 'autorun' })).jobs as Obj[])[0]);
    const receipt = object(await f.engine.dispatch('attest', { ...f.fence, kind: 'run', cmd: 'printf x >> effect', timeout_secs: 2, outbox_id: job.outbox_id, delivery_actor: job.delivery_actor, delivery_epoch: job.delivery_epoch, idem: job.idempotency_key }));
    assert.equal(receipt.passed, true);
    f.engine.run('UPDATE sis_ts_delivery_leases SET lease_until=0 WHERE outbox_id=?', job.outbox_id);
    const restarted = new Engine(f.engine.dbPath);
    try {
      assert.deepEqual(object(await restarted.dispatch('outbox_export', { actor: 'second', kind: 'autorun' })).jobs, []);
      assert.equal(restarted.row('SELECT state FROM outbox WHERE id=?', job.outbox_id)?.state, 'done');
      assert.equal(restarted.rows('SELECT * FROM attests WHERE issue=?', 'job').length, 1);
      assert.equal(readFileSync(join(f.root, 'effect'), 'utf8'), 'x');
    } finally { await restarted.shutdown(); restarted.db.close(); }
  } finally { await f.close(); }
});

test('expired deliveries fence old runners and exhaust after three leased attempts', async () => {
  const f = await fixture({ meta: { autorun: 'true' } });
  try {
    let job: Obj = {};
    for (let attempt = 1; attempt <= 3; attempt++) {
      job = object((object(await f.engine.dispatch('outbox_export', { actor: 'runner', kind: 'autorun', ttl: 5 })).jobs as Obj[])[0]);
      assert.equal(job.delivery_epoch, attempt);
      f.engine.run('UPDATE sis_ts_delivery_leases SET lease_until=0 WHERE outbox_id=?', job.outbox_id);
      await assert.rejects(f.engine.dispatch('outbox_done', { id: job.outbox_id, actor: 'runner', epoch: attempt }), { code: 'stale_fence' });
    }
    assert.deepEqual(object(await f.engine.dispatch('outbox_export', { actor: 'runner', kind: 'autorun' })).jobs, []);
    assert.equal(f.engine.row('SELECT state FROM outbox WHERE id=?', job.outbox_id)?.state, 'failed');
  } finally { await f.close(); }
});
