import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const script = resolve(import.meta.dirname, '../tools/sis-sync.sh');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sis-sync-'));
  const repo = join(root, 'repo'), remote = join(root, 'remote.git');
  function git(...args: string[]) {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
  }
  assert.equal(spawnSync('git', ['init', '-q', '--bare', remote]).status, 0);
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', repo]).status, 0);
  git('config', 'user.name', 'Sync test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repo, '.gitignore'), 'tasks.db\n');
  writeFileSync(join(repo, 'tasks.db'), 'fixture');
  writeFileSync(join(repo, 'tasks.issues.jsonl'), 'initial\n');
  writeFileSync(join(repo, 'foreign.txt'), 'owned by another worker\n');
  git('add', '.gitignore', 'tasks.issues.jsonl', 'foreign.txt'); git('commit', '-qm', 'initial');
  git('remote', 'add', 'origin', remote); git('push', '-qu', 'origin', 'main');
  const fake = join(root, 'sis'), calls = join(root, 'calls');
  writeFileSync(fake, `#!${process.execPath}\nimport {appendFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2);appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args.includes('snapshot'))writeFileSync(args[args.indexOf('--db')+1].replace(/\\.db$/,'')+'.issues.jsonl',process.env.SIS_TEST_SNAPSHOT);\n`, { mode: 0o755 });
  function run(mode = 'push', content = 'changed\n') {
    return spawnSync('bash', [script, mode, '--db', join(repo, 'tasks.db')], { cwd: repo, env: { ...process.env, SIS_BIN: fake, SIS_TEST_SNAPSHOT: content, SIS_ADMIN_TOKEN: 'synthetic-fixture' }, encoding: 'utf8', timeout: 15000 });
  }
  return { root, repo, git, calls, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('snapshot sync refuses a foreign index without touching bytes, HEAD or remote', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repo, 'foreign.txt'), 'staged foreign edit\n'); f.git('add', 'foreign.txt');
    const before = f.git('diff', '--cached'), head = f.git('rev-parse', 'HEAD');
    const result = f.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /staged work preserved/);
    assert.equal(f.git('diff', '--cached'), before); assert.equal(f.git('rev-parse', 'HEAD'), head);
    assert.equal(f.git('rev-parse', 'origin/main'), head); assert.equal(existsSync(f.calls), false);
  } finally { f.cleanup(); }
});

test('pull, push and sync refuse foreign tracked edits before importing or snapshotting', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repo, 'foreign.txt'), 'unstaged foreign edit\n');
    const before = f.git('diff');
    for (const mode of ['pull', 'push', 'sync']) {
      const result = f.run(mode); assert.notEqual(result.status, 0); assert.match(result.stderr, /unrelated tracked edits preserved/);
      assert.equal(f.git('diff'), before); assert.equal(existsSync(f.calls), false);
    }
  } finally { f.cleanup(); }
});

test('snapshot sync refuses a pre-staged snapshot and dirty pull snapshot', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repo, 'tasks.issues.jsonl'), 'uncommitted\n');
    assert.notEqual(f.run('pull').status, 0); assert.equal(existsSync(f.calls), false);
    f.git('add', 'tasks.issues.jsonl'); const before = f.git('diff', '--cached');
    assert.notEqual(f.run().status, 0); assert.equal(f.git('diff', '--cached'), before);
    assert.equal(existsSync(f.calls), false);
  } finally { f.cleanup(); }
});

test('unchanged snapshot creates no commit; changed snapshot commits and pushes its exact path', () => {
  const f = fixture();
  try {
    const before = f.git('rev-parse', 'HEAD');
    assert.equal(f.run('push', 'initial\n').status, 0); assert.equal(f.git('rev-parse', 'HEAD'), before);
    const changed = f.run(); assert.equal(changed.status, 0, changed.stdout + changed.stderr);
    assert.equal(f.git('show', '--format=', '--name-only', 'HEAD'), 'tasks.issues.jsonl');
    assert.equal(f.git('rev-parse', 'HEAD'), f.git('rev-parse', 'origin/main'));
    assert.equal(readFileSync(join(f.repo, 'foreign.txt'), 'utf8'), 'owned by another worker\n');
  } finally { f.cleanup(); }
});

test('failed push is a failure and preserves the local recovery commit', () => {
  const f = fixture();
  try {
    const before = f.git('rev-parse', 'HEAD'); f.git('remote', 'set-url', 'origin', join(f.root, 'missing.git'));
    const result = f.run(); assert.notEqual(result.status, 0);
    assert.notEqual(f.git('rev-parse', 'HEAD'), before);
    assert.equal(f.git('show', '--format=', '--name-only', 'HEAD'), 'tasks.issues.jsonl');
    assert.equal(readFileSync(join(f.repo, 'tasks.issues.jsonl'), 'utf8'), 'changed\n');
  } finally { f.cleanup(); }
});
