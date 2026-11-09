import { expect, test } from 'bun:test';
import { command, git } from './process.ts';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('real Git pathname bytes cannot alias valid Unicode scopes and preserve a leading BOM', () => {
  const repo = mkdtempSync(join(tmpdir(), 'forge-raw-git-'));
  const raw = (args: string[], input?: Buffer): Buffer => {
    const result = spawnSync('git', ['-C', repo, ...args], { input, timeout: 5000 });
    expect(result.status, result.stderr.toString('utf8')).toBe(0); return result.stdout;
  };
  try {
    raw(['init', '--bare', '--object-format=sha1', '-q']);
    const empty = raw(['mktree', '-z'], Buffer.alloc(0)).toString('ascii').trim();
    const blob = raw(['hash-object', '-w', '--stdin'], Buffer.from('fixture')).toString('ascii').trim();
    const diff = (name: Buffer) => {
      const tree = raw(['mktree', '-z'], Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), name, Buffer.from([0])])).toString('ascii').trim();
      const args = ['diff', '--name-only', '-z', empty, tree, '--'];
      expect(raw(args)).toEqual(Buffer.concat([name, Buffer.from([0])]));
      return git(repo, ...args);
    };
    for (const name of ['\ufffdf', '\ufefff']) expect(diff(Buffer.from(name))).toBe(name + '\0');
    for (const bytes of [[0xff, 0x66], [0xc3], [0xc0, 0xaf]]) expect(diff(Buffer.from(bytes))).toBeNull();
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('command preserves UTF8 characters split across stdout chunks and final newline content', async () => {
  const output = await command(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0xc3])); setTimeout(()=>process.stdout.write(Buffer.from([0xbc,10,120])),30)'], tmpdir());
  expect(output).toBe('ü\nx');
});
test('a missing executable is a known not-started command, not an uncertain replay', async () => {
  const error = await command('/definitely-not-an-installed-forge-command', [], tmpdir()).catch(error => error);
  expect(error.kind).toBe('spawn'); expect(error.execution_uncertain).toBe(false); expect(error.started).toBe(false);
});
test('a timed out dispatched command has an explicitly uncertain outcome', async () => {
  const error = await command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], tmpdir(), 80).catch(error => error);
  expect(error.kind).toBe('timeout'); expect(error.started).toBe(true); expect(error.execution_uncertain).toBe(true);
});
test('output overflow is bounded and classified without retaining the excess', async () => {
  const error = await command(process.execPath, ['-e', 'const b=Buffer.alloc(1024*1024,120); for(let i=0;i<16;i++) process.stdout.write(b); setInterval(()=>{},1000)'], tmpdir(), 5000).catch(error => error);
  expect(error.kind).toBe('output_limit'); expect(error.execution_uncertain).toBe(true); expect(error.retained_bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
});
