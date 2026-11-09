import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Engine } from './engine.ts';
import { canonical, digest, object, SisError, tokenCount, type Obj } from './ts/util.ts';

const intent: Obj = { v: 1, source: 'synthetic_fixture', desired_outcome: 'Find a private appointment',
  bottleneck: 'No confirmed available slot', customer_acceptance: 'A suitable slot is confirmed', evidence_refs: [] };

async function fixture(extra: Obj = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sis-customer-outcome-'));
  writeFileSync(join(root, 'input.txt'), 'fixed synthetic source\n');
  const engine = new Engine(join(root, 'tasks.db'));
  await engine.dispatch('create', { id: 'delivery', title: 'Synthetic delivery',
    acceptance: 'Fixed source oracle passes', oracle_cmd: 'printf verified', allowed_paths: ['input.txt'],
    ...extra });
  return { root, engine, async close() { await engine.shutdown(); engine.db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('native contract keeps declared customer intent without promoting it to proof or authority', async () => {
  const f = await fixture({ meta: { customer_outcome: intent, arbitrary_instruction: 'do not copy me', review_required: true } });
  try {
    const reply = object(await f.engine.dispatch('contract', { id: 'delivery' }));
    const task = object(reply.structured), meta = object(task.meta);
    assert.deepEqual(meta.customer_outcome, intent);
    assert.equal(meta.review_required, true);
    assert.equal(meta.arbitrary_instruction, undefined);
    assert.equal(task.status, 'open');
    assert.equal(task.customer_confirmation, undefined);
    assert.equal(task.proof_id, undefined);
    assert.deepEqual(object(JSON.parse(String(reply.contract_text))).meta, meta);
  } finally { await f.close(); }
});

test('compact briefs retain intent when description is omitted and reject budgets below mandatory context', async () => {
  const f = await fixture({ desc: 'unneeded historical description '.repeat(2000), meta: { customer_outcome: intent } });
  try {
    const mandatory = { ...f.engine.contract('delivery') };
    delete mandatory.desc;
    const budget = tokenCount(JSON.stringify(JSON.parse(canonical(mandatory)), null, 2), 'o200k_base');
    const brief = object(await f.engine.dispatch('brief', { id: 'delivery', max_tokens: budget }));
    assert.ok((brief.omitted as string[]).includes('desc'));
    assert.deepEqual(object(object(brief.structured).meta).customer_outcome, intent);
    assert.deepEqual(object(object(JSON.parse(String(brief.contract_text))).meta).customer_outcome, intent);
    await assert.rejects(f.engine.dispatch('brief', { id: 'delivery', max_tokens: budget - 1 }),
      (error: unknown) => error instanceof SisError && error.code === 'budget_exceeded');
    await assert.rejects(f.engine.dispatch('acquire', { actor: 'worker', max_tokens: budget - 1 }),
      (error: unknown) => error instanceof SisError && error.code === 'budget_exceeded');
    assert.equal(f.engine.issue('delivery').status, 'open');
    assert.equal(f.engine.issue('delivery').lease_epoch, 0);
  } finally { await f.close(); }
});

test('existing acquire and resume paths carry intent with the same revision and live fence', async () => {
  const f = await fixture({ meta: { customer_outcome: intent } });
  try {
    const acquired = object(await f.engine.dispatch('acquire', { actor: 'worker', max_tokens: 2000 }));
    assert.equal(acquired.id, 'delivery');
    assert.deepEqual(object(object(object(acquired.contract).structured).meta).customer_outcome, intent);
    const resumed = object(await f.engine.dispatch('resume', { id: 'delivery' }));
    assert.equal(object(resumed.contract).revision, acquired.revision);
    assert.deepEqual(object(object(object(resumed.contract).structured).meta).customer_outcome, intent);
    assert.equal(f.engine.issue('delivery').claim_actor, 'worker');
    assert.equal(f.engine.issue('delivery').lease_epoch, acquired.epoch);
  } finally { await f.close(); }
});

test('legacy contracts without an outcome key retain their exact hash input and shape', async () => {
  const f = await fixture({ meta: { unrelated_metadata: 'still not part of a contract' } });
  try {
    const contract = f.engine.contract('delivery');
    const original: Obj = { id: 'delivery', title: 'Synthetic delivery', desc: '',
      acceptance: 'Fixed source oracle passes', oracle_cmd: 'printf verified', allowed_paths: ['input.txt'],
      owner: null, lane: null, dependencies: [], budget_eur: null,
      meta: { local_zero: null, execution: null, budget_gate: null, review_required: null, attest_required: null } };
    assert.equal(contract.revision, digest(canonical(original)));
    assert.deepEqual(contract.meta, original.meta);
    assert.equal(Object.hasOwn(object(contract.meta), 'customer_outcome'), false);
    const before = contract.revision;
    await f.engine.dispatch('update', { id: 'delivery', set: { meta: { unrelated_metadata: 'changed' } } });
    assert.equal(f.engine.contract('delivery').revision, before);
  } finally { await f.close(); }
});

test('changing declared customer intent invalidates an old proof without weakening ownership or close gates', async () => {
  const f = await fixture({ meta: { customer_outcome: intent } });
  try {
    const claim = object(await f.engine.dispatch('claim', { id: 'delivery', actor: 'worker', ttl: 60 }));
    const binding = { id: 'delivery', actor: 'worker', epoch: claim.epoch };
    const proof = object(await f.engine.dispatch('verify', { ...binding, cwd: f.root, timeout_secs: 10 }));
    assert.equal(proof.passed, true);
    const changed = { ...intent, bottleneck: 'Changed declared bottleneck' };
    await assert.rejects(f.engine.dispatch('update', { ...binding, actor: 'other', set: { meta: { customer_outcome: changed } } }));
    await f.engine.dispatch('update', { ...binding, expected_revision: proof.revision, set: { meta: { customer_outcome: changed } } });
    assert.notEqual(f.engine.contract('delivery').revision, proof.revision);
    await assert.rejects(f.engine.dispatch('close', { ...binding, proof_id: proof.proof_id }),
      (error: unknown) => error instanceof SisError && error.code === 'stale_proof');
    assert.equal(f.engine.issue('delivery').status, 'in_progress');
  } finally { await f.close(); }
});
