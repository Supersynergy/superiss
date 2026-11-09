import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireMergeLock, previewMergeLocks } from './merge-lock.ts';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-lock-')));
  const git = (...args: string[]) => { const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); if (r.status !== 0) throw Error(r.stderr); return r.stdout.trim(); };
  git('init', '-qb', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); writeFileSync(join(root, 'f'), 'initial'); git('add', 'f'); git('commit', '-qm', 'initial');
  return { root, git, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}
const owner = { task: 'one', actor: 'worker-a', epoch: 1, db: '/synthetic/one.db' };
test('separate project stores cannot concurrently merge the same repository/base', () => {
  const f = fixture(); try {
    const first = acquireMergeLock(f.root, 'main', owner);
    expect(() => acquireMergeLock(f.root, 'main', { ...owner, actor: 'worker-b', db: '/synthetic/two.db' })).toThrow(/lock already exists/);
    expect(previewMergeLocks(f.root)[0]?.owner).toMatchObject(owner); expect(previewMergeLocks(f.root)[0]?.owner).not.toHaveProperty('token');
    expect(first.release()).toBe(true); const second = acquireMergeLock(f.root, 'main', { ...owner, db: '/synthetic/two.db' }); expect(second.release()).toBe(true);
  } finally { f.cleanup(); }
});
test('linked worktrees share the same repository-wide merge lock', () => {
  const f = fixture(); try {
    const path = join(f.root, 'linked'); f.git('worktree', 'add', '-qb', 'work', path);
    const lock = acquireMergeLock(f.root, 'main', owner);
    expect(() => acquireMergeLock(path, 'main', { ...owner, task: 'two' })).toThrow(/lock already exists/); expect(lock.release()).toBe(true);
  } finally { f.cleanup(); }
});
test('different targets do not contend and changed owner metadata cannot be removed', () => {
  const f = fixture(); try {
    const lock = acquireMergeLock(f.root, 'main', owner), other = acquireMergeLock(f.root, 'release', owner);
    const marker = join(lock.path, 'owner.json'), data = JSON.parse(readFileSync(marker, 'utf8')); data.token = 'foreign-token'; writeFileSync(marker, JSON.stringify(data));
    expect(lock.release()).toBe(false); expect(existsSync(marker)).toBe(true); expect(other.release()).toBe(true);
  } finally { f.cleanup(); }
});
test('an abandoned or malformed lock is previewed and never reclaimed', () => {
  const f = fixture(); try {
    const lock = acquireMergeLock(f.root, 'main', owner); writeFileSync(join(lock.path, 'owner.json'), '{broken');
    expect(previewMergeLocks(f.root)[0]).toMatchObject({ path: lock.path, malformed: true });
    expect(() => acquireMergeLock(f.root, 'main', owner)).toThrow(/reconcile owner/); expect(lock.release()).toBe(false);
  } finally { f.cleanup(); }
});
test('a symlinked lock parent cannot redirect writes outside the Git common directory', () => {
  const f = fixture(); try {
    const foreign = join(f.root, 'foreign'); mkdirSync(foreign); writeFileSync(join(foreign, 'keep'), 'unchanged'); symlinkSync(foreign, join(f.root, '.git/superiss'));
    expect(() => acquireMergeLock(f.root, 'main', owner)).toThrow(/regular directory/); expect(readdirSync(foreign)).toEqual(['keep']);
    expect(previewMergeLocks(f.root)[0]?.malformed).toBe(true);
  } finally { f.cleanup(); }
});
test('oversized owner metadata cannot create an unreleasable lock', () => {
  const f = fixture(); try {
    expect(() => acquireMergeLock(f.root, 'main', { ...owner, actor: 'x'.repeat(9000) })).toThrow(/metadata/);
    expect(previewMergeLocks(f.root)).toEqual([]);
  } finally { f.cleanup(); }
});
