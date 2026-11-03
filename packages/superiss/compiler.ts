import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';

interface Compiler {
  command: string;
  version: string;
  patch: bigint;
  prerelease: string[];
}

function newer(left: Compiler, right: Compiler): boolean {
  if (left.patch !== right.patch) return left.patch > right.patch;
  if (!left.prerelease.length || !right.prerelease.length) return !left.prerelease.length && !!right.prerelease.length;
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const a = left.prerelease[i], b = right.prerelease[i];
    if (a === b) continue;
    if (a === undefined || b === undefined) return b === undefined;
    const numericA = /^\d+$/u.test(a), numericB = /^\d+$/u.test(b);
    if (numericA && numericB) return BigInt(a) > BigInt(b);
    if (numericA !== numericB) return !numericA;
    return a > b;
  }
  return false;
}

/** Select only installed TypeScript 7.1 compilers; never install or change PATH. */
export function resolveTypeScript(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Pick<Compiler, 'command' | 'version'> {
  function probe(command: string): Compiler | undefined {
    const result = spawnSync(command, ['--version'], { cwd, env, encoding: 'utf8', timeout: 5000, maxBuffer: 4096 });
    if (result.error || result.status !== 0) return;
    const version = (result.stdout ?? '').trim();
    const match = /^Version 7\.1\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(version);
    if (!match) return;
    const prerelease = match[2]?.split('.') ?? [];
    if (prerelease.some(part => /^\d+$/u.test(part) && part.length > 1 && part.startsWith('0'))) return;
    return { command, version, patch: BigInt(match[1]), prerelease };
  }

  if (env.SIS_TSC !== undefined) {
    const explicit = env.SIS_TSC ? probe(env.SIS_TSC) : undefined;
    if (!explicit) throw Error('TypeScript 7.1 required: explicit SIS_TSC is empty, unavailable or incompatible; no fallback');
    return { command: explicit.command, version: explicit.version };
  }

  // npm prepends ancestor node_modules/.bin directories, which may contain older tsc versions.
  let selected: Compiler | undefined;
  const seen = new Set<string>();
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const command = resolve(cwd, directory, 'tsc');
    let identity: string;
    try { accessSync(command, constants.X_OK); identity = realpathSync(command); }
    catch { continue; }
    if (seen.has(identity)) continue;
    seen.add(identity);
    const candidate = probe(command);
    if (candidate && (!selected || newer(candidate, selected))) selected = candidate;
  }
  if (!selected) throw Error('TypeScript 7.1 required: no compatible installed compiler in PATH; set SIS_TSC explicitly');
  return { command: selected.command, version: selected.version };
}
