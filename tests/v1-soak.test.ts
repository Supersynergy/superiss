import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DAY, validateTimeline, seal, auditNative, type Entry } from '../tools/v1-soak.ts';
import { DatabaseSync } from 'node:sqlite';

function fixture(): Entry[] {
  const rows: Entry[] = [];
  const add = (kind: string, elapsed: number, data: Record<string, unknown> = {}) => rows.push(seal(rows.at(-1)?.hash ?? '', rows.length, 1800000000000 + elapsed, elapsed, kind, data));
  add('start', 0, { mode: 'run' });
  for (let cycle = 0; cycle <= 1440; cycle++) {
    const chaos = [360, 720, 1080].includes(cycle);
    add('sample', cycle * 60000, { cycle, id: `cycle-${cycle}`, proof: `proof-${cycle}`, project: 'project', instance: chaos ? `new-${cycle}` : 'instance', pid: 42, analytics: cycle % 60 === 0, recovery: chaos ? { before: `old-${cycle}`, after: `new-${cycle}`, pidBefore: 41, pidAfter: 42, epoch: 1 } : null });
  }
  add('complete', DAY, {});
  return rows;
}
function reseal(rows: Entry[]): Entry[] { return rows.map((row, i) => (rows[i] = seal(i ? rows[i - 1].hash : '', i, row.wall, row.elapsed, row.kind, row.data))); }

describe('real 24-hour evidence gate', () => {
  test('accepts a complete synthetic timeline only in the pure validator', () => assert.equal(validateTimeline(fixture()).samples, 1441));
  test('rejects a short run even if its wall clock jumps forward', () => {
    const rows = fixture().map(row => ({ ...row, elapsed: row.elapsed / 1000 }));
    assert.throws(() => validateTimeline(reseal(rows)), /24h/);
  });
  test('never accepts the probe as production', () => {
    const rows = fixture(); rows[0].data.mode = 'probe';
    assert.throws(() => validateTimeline(reseal(rows)), /probe/);
  });
  test('rejects changed journal bytes', () => { const rows = fixture(); rows[7].data.proof = 'edited'; assert.throws(() => validateTimeline(rows), /chain/); });
  test('rejects a gap even with a valid hash chain', () => {
    const rows = fixture(); rows.splice(10, 4); assert.throws(() => validateTimeline(reseal(rows)), /gap|cycle/);
  });
  test('rejects clock rollback and missing end evidence', () => {
    const rows = fixture(); rows[20].wall = rows[19].wall - 1; assert.throws(() => validateTimeline(reseal(rows)), /clock/);
    assert.throws(() => validateTimeline(fixture().slice(0, -1)), /complete/);
  });
  test('rejects missing, unrelated or unbound recovery and missing analytics', () => {
    for (const change of ['recovery', 'analytics', 'instance']) {
      const rows = fixture();
      for (const row of rows.filter(r => r.kind === 'sample')) {
        if (change === 'recovery') row.data.recovery = null;
        if (change === 'analytics') row.data.analytics = false;
        if (change === 'instance' && row.data.recovery) row.data.instance = 'unrelated';
      }
      assert.throws(() => validateTimeline(reseal(rows)), /recovery|analytics/);
    }
  });
  test('rejects explicit failures', () => {
    const rows = fixture(); rows.splice(2, 0, seal('', 0, rows[1].wall, rows[1].elapsed, 'error', { message: 'failed' }));
    assert.throws(() => validateTimeline(reseal(rows)), /error/);
  });
});

test('installed 1.0 bundle: real persistence, native proofs and three owned crash recoveries; short probe cannot pass 24h', { timeout: 100000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sis-v1-soak-test-'));
  const bundle = process.env.SIS_SOAK_BUNDLE ?? '/Users/master/.local/share/superiss/releases/1.0.0-8913e919e4e2';
  try {
    const script = resolve(dirname(fileURLToPath(import.meta.url)), '../tools/v1-soak.ts');
    const result = spawnSync(process.execPath, [script, 'probe', bundle, join(dir, 'run')], { encoding: 'utf8', timeout: 90000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(readFileSync(join(dir, 'run/probe.json'), 'utf8'));
    assert.equal(report.recoveries, 3); assert.equal(report.samples, 4); assert.equal(report.passed, false); assert.equal(report.nativeValidated, true);
    const verify = spawnSync(process.execPath, [script, 'verify', join(dir, 'run')], { encoding: 'utf8', timeout: 15000 });
    assert.notEqual(verify.status, 0); assert.match(verify.stderr, /probe/);
    const refused = spawnSync(process.execPath, [script, 'probe', bundle, join(dir, 'run')], { encoding: 'utf8', timeout: 15000 });
    assert.notEqual(refused.status, 0);
    const rows = readFileSync(join(dir, 'run/events.jsonl'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line) as Entry);
    const database = new DatabaseSync(join(dir, 'run/tasks.db'));
    database.exec('UPDATE proofs SET passed=0'); database.close();
    assert.throws(() => auditNative(join(dir, 'run'), rows), /0 !== 1/);
    const manifest = JSON.parse(readFileSync(join(dir, 'run/config.json'), 'utf8')); manifest.bundle = dir;
    writeFileSync(join(dir, 'run/config.json'), JSON.stringify(manifest));
    assert.notEqual(spawnSync(process.execPath, [script, 'verify', join(dir, 'run')], { encoding: 'utf8', timeout: 15000 }).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
