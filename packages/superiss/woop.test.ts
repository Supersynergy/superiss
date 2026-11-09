import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Engine } from './engine.ts';
import { object, SisError, type Obj } from './ts/util.ts';

const stages = ['implementation', 'delivery', 'outcome'] as const;
function input(id = 'super-synergy-appointment'): Obj {
  return { id, name: 'SuperSynergy: private appointment', owner: 'controller',
    wish: 'Find a suitable private appointment', outcome: 'Customer confirms the agreed appointment',
    obstacle: 'No confirmed available slot', if: 'If the slot is unavailable', then: 'Ask for one alternative before booking',
    stages: Object.fromEntries(stages.map(stage => [stage, {
      oracle_cmd: 'test -s input.txt', allowed_paths: ['input.txt'], acceptance: `${stage}: declared example oracle passes`,
    }])) };
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sis-woop-'));
  writeFileSync(join(root, 'input.txt'), 'Synthetic SuperSynergy appointment fixture; no real customer confirmation\n');
  const engine = new Engine(join(root, 'tasks.db'));
  return { root, engine, async close() { await engine.shutdown(); engine.db.close(); rmSync(root, { recursive: true, force: true }); } };
}
const bad = (error: unknown) => error instanceof SisError && error.code === 'bad_args';

test('WOOP creates exactly one native goal and three ordered tasks without claims or invented evidence', async () => {
  const f = await fixture();
  try {
    const a = input(), result = object(await f.engine.dispatch('woop', a));
    assert.equal(result.goal, a.id);
    assert.deepEqual(result.children, [`${a.id}.1`, `${a.id}.2`, `${a.id}.3`]);
    assert.deepEqual(result.stages, Object.fromEntries(stages.map((s, i) => [s, `${a.id}.${i + 1}`])));
    assert.equal(object(await f.engine.dispatch('count')).count, 4);
    assert.equal(f.engine.row('SELECT COUNT(*) n FROM proofs')?.n, 0);
    for (const [i, stage] of stages.entries()) {
      const id = `${a.id}.${i + 1}`, task = f.engine.issue(id), contract = f.engine.contract(id);
      assert.equal(task.status, 'open'); assert.equal(task.claim_actor, null); assert.equal(task.owner, 'controller');
      assert.equal(task.oracle_cmd, 'test -s input.txt');
      const woop = object(object(object(contract.meta).customer_outcome).woop);
      assert.equal(woop.v, 1); assert.equal(woop.stage, stage); assert.equal(woop.wish, a.wish);
      assert.equal(woop.goal_id, a.id); assert.deepEqual(woop.stages, result.stages);
      assert.deepEqual(contract.blocked_by, i ? [`${a.id}.${i}`] : []);
    }
    assert.deepEqual((await f.engine.dispatch('ready') as Obj[]).map(x => x.id), [`${a.id}.1`]);
    assert.equal(f.engine.issue(a.id).oracle_cmd, object(object(a.stages).outcome).oracle_cmd);
    assert.equal(f.engine.issue(a.id).customer_confirmation, undefined);
  } finally { await f.close(); }
});

test('WOOP validates bounded exact input before creating any rows', async () => {
  const f = await fixture();
  try {
    const a = input(), impl = object(object(a.stages).implementation);
    const invalid: Obj[] = [
      {...a, owner: ''}, {...a, wish: 'x'.repeat(401)}, {...a, id: 'wild%card'}, {...a, if: null},
      {...a, stages: {implementation: impl}}, {...a, stages: {...object(a.stages), extra: impl}},
      {...a, stages: {...object(a.stages), delivery: {...impl, allowed_paths: []}}},
      {...a, stages: {...object(a.stages), delivery: {...impl, allowed_paths: [' ']}}},
      {...a, stages: {...object(a.stages), outcome: {...impl, oracle_cmd: ''}}},
      {...a, stages: {...object(a.stages), outcome: {...impl, customer_confirmed: true}}},
      {...a, subs: []}, {...a, meta: {customer_confirmed: true}},
    ];
    for (const value of invalid) { await assert.rejects(f.engine.dispatch('woop', value), bad); assert.equal(object(await f.engine.dispatch('count')).count, 0); }
    await f.engine.dispatch('woop', {...a, wish: 'x'.repeat(400)});
    assert.equal(object(await f.engine.dispatch('count')).count, 4);
  } finally { await f.close(); }
});

test('WOOP replay is idempotent and payload conflicts or orphan collisions never leave partial plans', async () => {
  const f = await fixture();
  try {
    const a = {...input(), actor: 'controller', idem: 'woop-once'};
    assert.deepEqual(await f.engine.dispatch('woop', a), await f.engine.dispatch('woop', a));
    await assert.rejects(f.engine.dispatch('woop', {...a, wish: 'changed'}), e => e instanceof SisError && e.code === 'idem_conflict');
    await assert.rejects(f.engine.dispatch('woop', input()), e => e instanceof SisError && e.code === 'exists');
    await f.engine.dispatch('create', {id: 'orphan.7', title: 'foreign child'});
    await assert.rejects(f.engine.dispatch('woop', input('orphan')), e => e instanceof SisError && e.code === 'exists');
    assert.equal(object(await f.engine.dispatch('count')).count, 5);
    await assert.rejects(f.engine.dispatch('show', {id: 'orphan'}));
    await assert.rejects(f.engine.dispatch('batch', {ops: [{cmd: 'woop', args: input('rollback')}, {cmd: 'create', args: {id: 'orphan.7', title: 'collision'}}]}));
    assert.equal(object(await f.engine.dispatch('count')).count, 5);
  } finally { await f.close(); }
});

test('WOOP survives reopen and retains mandatory intent through acquire, brief and resume', async () => {
  const f = await fixture();
  try {
    const a = input(); await f.engine.dispatch('woop', a);
    const acquired = object(await f.engine.dispatch('acquire', {actor: 'worker', max_tokens: 3000}));
    const intent = object(object(object(object(acquired.contract).structured).meta).customer_outcome);
    assert.equal(object(intent.woop).then, a.then);
    const resumed = object(await f.engine.dispatch('resume', {id: acquired.id}));
    assert.deepEqual(object(object(object(resumed.contract).structured).meta).customer_outcome, intent);
    await assert.rejects(f.engine.dispatch('brief', {id: acquired.id, max_tokens: 1}), e => e instanceof SisError && e.code === 'budget_exceeded');
    const second = new Engine(join(f.root, 'tasks.db'));
    try { assert.deepEqual(object(second.contract(acquired.id).meta).customer_outcome, intent); }
    finally { await second.shutdown(); second.db.close(); }
  } finally { await f.close(); }
});

test('WOOP closes each phase only through its native oracle and fence; changed intent invalidates proof', async () => {
  const f = await fixture();
  try {
    const a = input(); await f.engine.dispatch('woop', a);
    await assert.rejects(f.engine.dispatch('claim', {id: `${a.id}.2`, actor: 'worker'}));
    for (const [i] of stages.entries()) {
      const id = `${a.id}.${i + 1}`, claim = object(await f.engine.dispatch('claim', {id, actor: 'worker'}));
      const binding = {id, actor: 'worker', epoch: claim.epoch};
      let proof = object(await f.engine.dispatch('verify', {...binding, cwd: f.root, timeout_secs: 10}));
      assert.equal(proof.passed, true);
      if (i === 0) {
        const meta = object(f.engine.issue(id).meta), intent = object(meta.customer_outcome);
        await f.engine.dispatch('update', {...binding, set: {meta: {...meta, customer_outcome: {...intent, woop: {...object(intent.woop), obstacle: 'Changed obstacle'}}}}});
        await assert.rejects(f.engine.dispatch('close', {...binding, proof_id: proof.proof_id}), e => e instanceof SisError && e.code === 'stale_proof');
        proof = object(await f.engine.dispatch('verify', {...binding, cwd: f.root, timeout_secs: 10}));
        assert.equal(proof.passed, true);
      }
      await assert.rejects(f.engine.dispatch('close', {...binding, actor: 'other', proof_id: proof.proof_id}));
      await f.engine.dispatch('close', {...binding, proof_id: proof.proof_id});
      assert.equal(f.engine.issue(id).status, 'closed');
    }
    assert.equal(object(await f.engine.dispatch('goal_done', {id: a.id})).done, true);
    assert.equal(f.engine.issue(a.id).status, 'open');
    assert.equal(f.engine.issue(a.id).customer_confirmation, undefined);
  } finally { await f.close(); }
});


test('WOOP rejects case-folded native hierarchy collisions before creating inconsistent phase references', async () => {
  const f = await fixture();
  try {
    const first = object(await f.engine.dispatch('woop', input('Demo')));
    await assert.rejects(f.engine.dispatch('woop', input('demo')), e => e instanceof SisError && e.code === 'exists');
    assert.equal(object(await f.engine.dispatch('count')).count, 4);
    assert.deepEqual(first.children, ['Demo.1', 'Demo.2', 'Demo.3']);
    await f.engine.dispatch('create', {id: 'Orphan.7', title: 'foreign orphan'});
    await assert.rejects(f.engine.dispatch('woop', input('orphan')), e => e instanceof SisError && e.code === 'exists');
    assert.equal(object(await f.engine.dispatch('count')).count, 5);
  } finally { await f.close(); }
});
