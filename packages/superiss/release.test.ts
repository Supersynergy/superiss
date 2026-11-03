import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { Analytics } from './analytics.ts';

test('release checker never re-enables the disabled automatic mac-resource wrapper', () => {
  assert.ok(!readFileSync(new URL('./check.ts', import.meta.url), 'utf8').includes('mac-resource-run'));
});

test('analytics uses bounded run-guard directly without an admission override', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sis-release-guard-'));
  const log = join(root, 'args.json');
  const saved = { PATH: process.env.PATH, SIS_V1_RESOURCE_ADMITTED: process.env.SIS_V1_RESOURCE_ADMITTED };
  let analytics: Analytics | undefined;
  try {
    const guard = join(root, 'run-guard');
    writeFileSync(guard, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nconst args=process.argv.slice(2);writeFileSync(${JSON.stringify(log)},JSON.stringify(args));\nconst sep=args.indexOf('--');const source=args[sep+3],token=args.at(-1);\nconsole.log(JSON.stringify({token,type:'started',pid:process.pid}));\nconsole.log(JSON.stringify({token,type:'result',data:{authority:'sqlite',consistency:'snapshot',source_path:source}}));\n`);
    chmodSync(guard, 0o755);
    const forbidden = join(root, 'mac-resource-run');
    writeFileSync(forbidden, '#!/bin/sh\nexit 79\n'); chmodSync(forbidden, 0o755);
    process.env.PATH = root + delimiter + (saved.PATH ?? '');
    delete process.env.SIS_V1_RESOURCE_ADMITTED;
    const source = join(root, 'source.db');
    analytics = new Analytics(source, join(root, 'report.duckdb'), 1000);
    assert.equal((await analytics.report()).authority, 'sqlite');
    const args = JSON.parse(readFileSync(log, 'utf8')) as string[];
    assert.deepEqual(args.slice(0, 7), ['--timeout', '1', '--max-rss-gb', '1', '--threads', '2', '--']);
    assert.equal(args[7], process.execPath);
  } finally {
    await analytics?.shutdown();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
