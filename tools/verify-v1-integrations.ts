import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stages: { name: string; ms: number }[] = [];
for (const [name, args] of [
  ['snapshot-index-isolation', ['test', 'tests/sis-sync.test.ts']],
  ['original-hybrid-gate', ['packages/superiss/check.ts']],
  ['api-local-zero-regressions', ['test', 'packages/superiss/api.test.ts', 'packages/superiss/local-zero.test.ts']],
  ['workflow-service-forge', ['test', 'tests/v1-integrations.test.ts']],
  ['relocated-adapters', ['test', 'tests/v1-package.test.ts']],
  ['service-regressions', ['test', 'tests/service-defaults.test.ts', 'tests/service-regression.test.ts']],
  ['forge-regressions', ['test', 'sisf/contract.test.ts', 'sisf/regression.test.ts', 'sisf/reconcile.test.ts']],
] as const) {
  const start = performance.now();
  // The retained service fixture explicitly uses the installed Python reference;
  // a TypeScript integration gate must not implicitly build another toolchain.
  const result = spawnSync(process.execPath, [...args], { cwd: root, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ...(name === 'service-regressions' ? { SIS_IMPL: 'py' } : {}) }, stdio: 'inherit', timeout: 240000 });
  stages.push({ name, ms: performance.now() - start });
  if (result.error || result.status !== 0) { console.error(JSON.stringify({ passed: false, stage: name, exit: result.status, signal: result.signal, error: result.error?.message, stages })); process.exit(1); }
}
console.log(JSON.stringify({ passed: true, stages }));
