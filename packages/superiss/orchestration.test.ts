import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Engine } from './engine.ts';
import { VERSION } from './runtime.ts';
import { array, object, runtimeCompatible, type Obj } from './ts/util.ts';

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sis-orch-'))), db = join(root, 'tasks.db');
  writeFileSync(join(root, 'source.txt'), 'source');
  const engine = new Engine(db);
  return { root, db, engine, async close() { await engine.shutdown(); engine.db.close(); rmSync(root, { recursive: true, force: true }); } };
}
const reasons = (report: Obj, id: string) => array(object(array(report.held).find(h => object(h).id === id)).reasons).map(r => object(r).code);

test('admit explains exactly why each task is or is not claimable', async () => {
  const f = await fixture();
  try {
    const e = f.engine;
    await e.dispatch('create', { id: 'ok', title: 'ready', oracle_cmd: 'true' });
    await e.dispatch('create', { id: 'no-oracle', title: 'no oracle' });
    await e.dispatch('create', { id: 'later', title: 'deferred', oracle_cmd: 'true' });
    await e.dispatch('defer', { id: 'later' });
    await e.dispatch('create', { id: 'dep', title: 'blocked', oracle_cmd: 'true' });
    await e.dispatch('dep', { issue: 'dep', depends_on: 'ok' });
    await e.dispatch('create', { id: 'held', title: 'claimed', oracle_cmd: 'true' });
    await e.dispatch('acquire', { id: 'held', actor: 'w', ttl: 600 });
    const report = object(await e.dispatch('admit', {}));
    assert.deepEqual(array(report.admitted).map(r => object(r).id), ['ok']);
    assert.deepEqual(reasons(report, 'no-oracle'), ['missing_oracle']);
    assert.deepEqual(reasons(report, 'later'), ['deferred']);
    assert.deepEqual(reasons(report, 'dep'), ['blocked_by']);
    assert.deepEqual(reasons(report, 'held'), ['claimed']);
    assert.equal(object(report.summary).missing_oracle, 1);
    // Admission agrees with the ready query the workers use.
    assert.deepEqual(array(await e.dispatch('ready', {})).map(r => object(r).id), ['ok']);
    assert.deepEqual(object(await e.dispatch('why', { id: 'no-oracle' })).admitted, []);
  } finally { await f.close(); }
});

test('repeated failed proofs park a task until its controller unparks it', async () => {
  const f = await fixture();
  try {
    const e = f.engine;
    await e.dispatch('create', { id: 'flaky', title: 'flaky', owner: 'boss', oracle_cmd: 'false', allowed_paths: ['source.txt'], meta: { max_failures: 2, controller: 'ctl' } });
    const claim = object(await e.dispatch('acquire', { id: 'flaky', actor: 'w', ttl: 600 }));
    const fence = { id: 'flaky', actor: 'w', epoch: claim.epoch, cwd: f.root };
    assert.equal(object(await e.dispatch('verify', fence)).parked, undefined);
    assert.equal(object(await e.dispatch('verify', fence)).parked, true);
    await assert.rejects(e.dispatch('verify', fence), { code: 'parked' });
    await assert.rejects(e.dispatch('update', { ...fence, meta: { max_failures: 99 } }), { code: 'protected_field' });
    await e.dispatch('unclaim', fence);
    assert.equal(object(await e.dispatch('acquire', { actor: 'w2', ttl: 600 })).id, null, 'parked task must not be granted');
    assert.deepEqual(array(await e.dispatch('ready', {})), []);
    assert.deepEqual(reasons(object(await e.dispatch('admit', {})), 'flaky'), ['parked']);
    assert.equal(object(await e.dispatch('stats', {})).parked, 1);
    for (const actor of ['w', 'boss']) {
      await assert.rejects(e.dispatch('unpark', { id: 'flaky', reason: 'x', actor }), { code: 'admin_required' });
    }
    await assert.rejects(e.dispatch('reopen', { id: 'flaky', actor: 'boss' }), { code: 'admin_required' }, 'owner cannot reopen a parked task');
    assert.equal(object(await e.dispatch('unpark', { id: 'flaky', reason: 'oracle fixed', actor: 'ctl' })).was_parked, true);
    assert.match(spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'cli.ts'), 'unit', 'kind=systemd', 'env={"X":"a$b"}', '--db', join(f.root, 'u.db'), '--sock', join(f.root, 'u.sock')], { encoding: 'utf8' }).stdout, /^Environment="X=a\$b"$/mu, 'no $ doubling in Environment=');
    assert.equal(object(await e.dispatch('acquire', { actor: 'w2', ttl: 600 })).id, 'flaky');
    assert.ok(e.events('flaky').some(event => event.op === 'parked'));
  } finally { await f.close(); }
});

test('SIS_MAX_FAILURES sets the default limit; zero keeps the unlimited legacy behavior', async () => {
  const f = await fixture(), old = process.env.SIS_MAX_FAILURES;
  try {
    const e = f.engine;
    await e.dispatch('create', { id: 'x', title: 'x', oracle_cmd: 'false', allowed_paths: ['source.txt'] });
    const claim = object(await e.dispatch('acquire', { id: 'x', actor: 'w', ttl: 600 }));
    const fence = { id: 'x', actor: 'w', epoch: claim.epoch, cwd: f.root };
    for (let i = 0; i < 3; i++) await e.dispatch('verify', fence);
    delete process.env.SIS_MAX_FAILURES;
    assert.equal(e.parked(e.issue('x')).parked, false);
    process.env.SIS_MAX_FAILURES = '3';
    assert.equal(e.parked(e.issue('x')).parked, true);
  } finally { if (old === undefined) delete process.env.SIS_MAX_FAILURES; else process.env.SIS_MAX_FAILURES = old; await f.close(); }
});

test('recurrences create one deterministic instance per due slot without catch-up storms', async () => {
  const f = await fixture();
  try {
    const e = f.engine, h = 3600, t0 = Math.floor(Date.now() / 1000 / h) * h - 48 * h;
    await assert.rejects(e.dispatch('recur', { name: 'nightly', every_secs: h, template: { title: 'no oracle' } }), { code: 'missing_oracle' });
    await assert.rejects(e.dispatch('recur', { name: 'nightly', every_secs: h, template: { id: 'fixed', title: 't', oracle_cmd: 'true' } }), { code: 'bad_args' });
    await assert.rejects(e.dispatch('recur', { name: 'nightly', every_secs: h, template: { title: 't', oracle_cmd: 'true' } }), { code: 'missing_scope' });
    await e.dispatch('recur', { name: 'nightly', every_secs: h, start_at: t0, template: { title: 'Nightly report', oracle_cmd: 'test -s report.md', lane: 'ops', allowed_paths: ['report.md'] } });
    assert.deepEqual(object(await e.dispatch('recur_tick', { now: t0 - 1 })).created, []);
    assert.deepEqual(object(await e.dispatch('recur_tick', { now: t0 + 10 })).created, [`nightly-${t0}`]);
    const task = e.issue(`nightly-${t0}`);
    assert.equal(task.lane, 'ops'); assert.equal(object(task.meta).recurrence, 'nightly');
    assert.deepEqual(object(await e.dispatch('recur_tick', { now: t0 + 20 })).created, [], 'same slot is idempotent');
    // Ten hours later with the previous instance still open: skipped, one schedule advance, no backlog of ten tasks.
    const later = object(await e.dispatch('recur_tick', { now: t0 + 10 * h + 5 }));
    assert.deepEqual(later.created, []); assert.equal(object(array(later.skipped)[0]).reason, 'previous_open');
    e.run('UPDATE issues SET status=? WHERE id=?', 'closed', `nightly-${t0}`);
    assert.deepEqual(object(await e.dispatch('recur_tick', { now: t0 + 11 * h + 5 })).created, [`nightly-${t0 + 11 * h}`]);
    assert.equal(object(array(await e.dispatch('recur_list', {}))[0]).next_at, t0 + 12 * h);
    await e.dispatch('recur', { name: 'nightly', enabled: false });
    assert.deepEqual(object(await e.dispatch('recur_tick', { now: t0 + 30 * h })).created, []);
    await e.dispatch('recur', { name: 'nightly', delete: true });
    assert.deepEqual(array(await e.dispatch('recur_list', {})), []);
  } finally { await f.close(); }
});

test('review regressions: poisoned inputs cannot wedge grants, schedules or parking', async () => {
  const f = await fixture();
  try {
    const e = f.engine, h = 3600, t0 = Math.floor(Date.now() / 1000 / h) * h - 5 * h;
    for (const bad of [-1, 1.5, 'abc', 5000]) await assert.rejects(e.dispatch('create', { title: 'bad', oracle_cmd: 'true', meta: { max_failures: bad } }), { code: 'bad_args' });
    // A value smuggled in directly still cannot break grants; JS and SQL agree that it disables parking.
    await e.dispatch('create', { id: 'raw', title: 'raw', oracle_cmd: 'true' });
    e.run("UPDATE issues SET meta_json=json_set(meta_json,'$.max_failures','abc') WHERE id='raw'");
    assert.deepEqual(array(await e.dispatch('ready', {})).map(r => object(r).id), ['raw']);
    assert.equal(object(await e.dispatch('acquire', { actor: 'w', ttl: 600 })).id, 'raw');
    for (const template of [{ title: 't', oracle_cmd: 'true', allowed_paths: ['.'], priority: 'zzz' }, { title: 't', oracle_cmd: 'true', allowed_paths: [1] }, { title: 't', oracle_cmd: 'true', allowed_paths: ['.'], type: 'goal' }])
      await assert.rejects(e.dispatch('recur', { name: 'bad', every_secs: h, template }), { code: 'bad_args' });
    // A spec corrupted after definition disables itself; healthy specs still run in the same tick.
    await e.dispatch('recur', { name: 'aaa', every_secs: h, start_at: t0, template: { title: 'A', oracle_cmd: 'true', allowed_paths: ['.'] } });
    await e.dispatch('recur', { name: 'bbb', every_secs: h, start_at: t0, template: { title: 'B', oracle_cmd: 'true', allowed_paths: ['.'] } });
    e.run("UPDATE kv SET v=json_set(v,'$.template.priority','zzz') WHERE k='recur:aaa'");
    const tick = object(await e.dispatch('recur_tick', {}));
    assert.deepEqual(tick.created, [`bbb-${t0 + 5 * h}`]);
    assert.equal(object(array(tick.skipped)[0]).reason, 'error');
    assert.equal(object(array(await e.dispatch('recur_list', {}))[0]).enabled, false);
    // A far-future clock is clamped: the schedule is not pushed decades ahead.
    await e.dispatch('recur', { name: 'ccc', every_secs: h, start_at: t0, template: { title: 'C', oracle_cmd: 'true', allowed_paths: ['.'] } });
    await e.dispatch('recur_tick', { now: 9_000_000_000 });
    assert.ok(Number(object(array(await e.dispatch('recur_list', {})).find(r => object(r).name === 'ccc')).next_at) < Date.now() / 1000 + 2 * h);
    // Replacing a schedule with a new cadence does not collide with already created slots.
    await e.dispatch('recur', { name: 'bbb', every_secs: 600, start_at: t0 + 7, template: { title: 'B2', oracle_cmd: 'true', allowed_paths: ['.'] } });
    e.run('UPDATE issues SET status=? WHERE id=?', 'closed', `bbb-${t0 + 5 * h}`);
    assert.equal(array(object(await e.dispatch('recur_tick', {})).created).length, 1);
    // Rename carries failures; delete and re-create starts clean.
    await e.dispatch('create', { id: 'p', title: 'p', oracle_cmd: 'false', allowed_paths: ['source.txt'], meta: { max_failures: 1 } });
    const claim = object(await e.dispatch('acquire', { id: 'p', actor: 'w', ttl: 600 }));
    await e.dispatch('verify', { id: 'p', actor: 'w', epoch: claim.epoch, cwd: f.root });
    await e.dispatch('unclaim', { id: 'p', actor: 'w', epoch: claim.epoch });
    await e.dispatch('rename', { from: 'p', to: 'q' });
    assert.equal(e.parked(e.issue('q')).parked, true);
    await e.dispatch('delete', { id: 'q' });
    await e.dispatch('create', { id: 'q', title: 'q again', oracle_cmd: 'true', meta: { max_failures: 1 } });
    assert.equal(e.parked(e.issue('q')).parked, false);
    // Store-wide baseline: historical failures stop counting once parking is enabled.
    await e.dispatch('create', { id: 'old', title: 'old', oracle_cmd: 'false', allowed_paths: ['source.txt'] });
    const oc = object(await e.dispatch('acquire', { id: 'old', actor: 'w', ttl: 600 }));
    for (let i = 0; i < 2; i++) await e.dispatch('verify', { id: 'old', actor: 'w', epoch: oc.epoch, cwd: f.root });
    const prior = process.env.SIS_ADMIN_TOKEN, priorMax = process.env.SIS_MAX_FAILURES;
    try {
      process.env.SIS_MAX_FAILURES = '2';
      assert.equal(e.parked(e.issue('old')).parked, true);
      await assert.rejects(e.dispatch('unpark', { all: true, reason: 'enable' }), { code: 'admin_required' });
      process.env.SIS_ADMIN_TOKEN = 'tok';
      assert.ok(Number(object(await e.dispatch('unpark', { all: true, reason: 'enable parking', admin_token: 'tok' })).baseline) > 0);
      assert.equal(e.parked(e.issue('old')).parked, false);
    } finally {
      if (prior === undefined) delete process.env.SIS_ADMIN_TOKEN; else process.env.SIS_ADMIN_TOKEN = prior;
      if (priorMax === undefined) delete process.env.SIS_MAX_FAILURES; else process.env.SIS_MAX_FAILURES = priorMax;
    }
    const caps = object(await e.dispatch('capabilities', {}));
    assert.equal(caps.parking, true); assert.equal(caps.recurrence, true);
  } finally { await f.close(); }
});

test('newer clients accept same-major daemons from the compatibility floor that offer the operation', () => {
  const ops = ['create', 'ready', 'admit'];
  assert.equal(runtimeCompatible({ version: VERSION }, VERSION, 'anything'), true);
  assert.equal(runtimeCompatible({ version: '1.5.1', operations: ops }, VERSION, 'create'), true);
  assert.equal(runtimeCompatible({ version: '1.5.1', operations: ops }, VERSION, 'next'), true, 'aliases resolve');
  assert.equal(runtimeCompatible({ version: '1.5.1', operations: ops }, VERSION, 'why'), true);
  assert.equal(runtimeCompatible({ version: '1.5.1', operations: ops }, VERSION, 'recur'), false, 'missing operation');
  assert.equal(runtimeCompatible({ version: '1.5.1' }, VERSION, 'create'), false, 'operations must be advertised');
  assert.equal(runtimeCompatible({ version: '1.4.0', operations: ops }, VERSION, 'create'), false, 'below floor');
  assert.equal(runtimeCompatible({ version: '0.9.0', operations: ops }, VERSION, 'create'), false, 'other major');
  assert.equal(runtimeCompatible({ version: 'x' }, VERSION), false);
});

test('unit generator prints systemd and launchd services for the bound database', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sis-unit-')));
  try {
    const db = join(root, '.sis', 'office.db'), sock = join(root, '.sis', 'office.sock');
    const run = (...args: string[]) => spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'cli.ts'), 'unit', ...args, '--db', db, '--sock', sock], { encoding: 'utf8', env: { ...process.env, SIS_DB: '', SIS_SOCK: '' } });
    const systemd = run('kind=systemd', 'user=devin', 'bin=/opt/superiss/bin/sis', 'name=superiss-office');
    assert.equal(systemd.status, 0, systemd.stderr);
    assert.match(systemd.stdout, /^ExecStart="\/opt\/superiss\/bin\/sis" "serve" "--db" ".*office\.db" "--sock" ".*office\.sock"$/mu);
    assert.match(systemd.stdout, /^User=devin$/mu); assert.match(systemd.stdout, /^Restart=always$/mu);
    assert.match(systemd.stdout, /^Environment="SIS_MAX_FAILURES=10"$/mu); assert.match(systemd.stdout, /^WorkingDirectory=\/.*sis-unit-[^/"]+$/mu);
    const plist = run('kind=launchd', 'name=office');
    assert.equal(plist.status, 0, plist.stderr); assert.match(plist.stdout, /<key>KeepAlive<\/key><true\/>/u); assert.match(plist.stdout, /ai\.superiss\.office/u);
    assert.notEqual(run('kind=systemd', 'env={"SIS_ADMIN_TOKEN":"x"}').status, 0, 'secrets never go into unit files');
    assert.notEqual(run('kind=systemd', 'user=root\nExecStartPre=/bin/evil').status, 0, 'no directive injection');
    assert.match(run('kind=systemd', 'bin=/opt/a%h$HOME/sis').stdout, /^ExecStart="\/opt\/a%%h\$\$HOME\/sis"/mu, 'specifiers and variables are escaped');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
