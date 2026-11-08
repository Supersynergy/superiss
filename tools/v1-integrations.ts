import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function fail(message: string): never { throw Error(message); }
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail('Configuration object required'); }
function flag(args: string[], name: string): string | undefined { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; }
async function main(): Promise<void> {
  const [runtime, command, ...args] = process.argv.slice(2);
  if (!runtime || !isAbsolute(runtime)) fail('Absolute versioned runtime launcher required');
  if (args.some(arg => arg === '--sis' || arg.startsWith('--sis=') || arg === '--complete')) fail('Runtime version is pinned; --sis/--complete overrides are not accepted');
  let executable = process.execPath, script: string, forwarded = args;
  if (command === 'run' || command === 'runner') {
    const db = flag(args, '--db'); if (!db || !isAbsolute(db) || !existsSync(db)) fail('--db must select an existing absolute project database');
    executable = process.env.SIS_RUNNER_PYTHON || 'python3'; script = join(root, 'tools/sis_runner.py');
    forwarded = [...(command === 'run' ? ['--complete'] : []), '--sis', runtime, ...args];
  } else if (command === 'service') {
    script = join(root, 'tools/service.ts');
    if (args[0] !== 'defaults') {
      const configPath = flag(args, '--config'); if (!configPath || !isAbsolute(configPath)) fail('--config ABS required for the versioned service');
      const config = record(JSON.parse(readFileSync(configPath, 'utf8')));
      if (typeof config.sis !== 'string' || !isAbsolute(config.sis) || realpathSync(config.sis) !== realpathSync(runtime)) fail('Service runtime version mismatch: config.sis must pin this versioned launcher');
    }
  } else if (command === 'forge') script = join(root, 'sisf/sisf.ts');
  else fail('Unknown optional adapter');
  if (!existsSync(script)) fail('Optional adapter missing; package with --with-adapters. Core runtime and existing services are unchanged.');
  const child = spawn(executable, [script, ...forwarded], { stdio: 'inherit', env: process.env });
  const forward = (signal: NodeJS.Signals) => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
  const terminate = () => forward('SIGTERM'), interrupt = () => forward('SIGINT');
  process.on('SIGTERM', terminate); process.on('SIGINT', interrupt);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveResult, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolveResult({ code, signal })); });
    process.exitCode = result.code ?? (result.signal === 'SIGINT' ? 130 : 143);
  } finally { process.off('SIGTERM', terminate); process.off('SIGINT', interrupt); }
}
await main().catch(error => { console.error(JSON.stringify({ error: { code: 'adapter', msg: error instanceof Error ? error.message : String(error) } })); process.exitCode = 2; });
