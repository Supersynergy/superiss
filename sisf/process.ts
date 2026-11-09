import { spawn, spawnSync } from 'node:child_process';

export class CommandFailure extends Error {
  readonly execution_uncertain: boolean;
  constructor(
    readonly kind: 'spawn' | 'timeout' | 'output_limit' | 'exit',
    readonly started: boolean,
    message: string,
    readonly retained_bytes = 0,
  ) {
    super(message);
    this.name = 'CommandFailure';
    this.execution_uncertain = started;
  }
}
export function failureDetails(error: unknown, fallback = 'forge'): { code: string; msg: string; kind?: CommandFailure['kind']; started?: boolean; execution_uncertain?: boolean } {
  return error instanceof CommandFailure
    ? { code: 'command_' + error.kind, msg: error.message, kind: error.kind, started: error.started, execution_uncertain: error.execution_uncertain }
    : { code: fallback, msg: error instanceof Error ? error.message : String(error) };
}

/** Prevent ambient Git routing from redirecting a project-bound operation. */
export function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES']) delete env[key];
  return env;
}

export function git(repo: string, ...args: string[]): string | null {
  const result = spawnSync('git', ['-C', repo, ...args], { env: gitEnvironment(), timeout: 30000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) return null;
  // Reject undecodable paths instead of aliasing their bytes to U+FFFD. Keep
  // a real BOM and whitespace: both can be part of a legal scoped filename.
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.stdout).replace(/\r?\n$/, ''); }
  catch { return null; }
}

/** A bounded child; no shell interpolation, no automatic retries of writes. */
export function command(program: string, args: string[], cwd: string, timeout = 60000): Promise<string> {
  if (!Number.isFinite(timeout) || timeout <= 0) return Promise.reject(new CommandFailure('spawn', false, 'A finite positive command timeout is required'));
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env: gitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const limit = 8 * 1024 * 1024, chunks: Buffer[] = [];
    let retained = 0, stderr = Buffer.alloc(0), failure: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const signal = (name: NodeJS.Signals) => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, name); else child.kill(name); } catch { /* already exited */ }
    };
    const stop = (kind: 'timeout' | 'output_limit', message: string) => {
      if (failure) return;
      failure = new CommandFailure(kind, child.pid !== undefined, message, retained); signal('SIGTERM');
      escalation = setTimeout(() => signal('SIGKILL'), 300);
    };
    const timer = setTimeout(() => stop('timeout', 'Command timed out; reconcile its outcome before retry'), timeout);
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return;
      const take = Math.min(chunk.length, limit - retained);
      if (take) { chunks.push(Buffer.from(chunk.subarray(0, take))); retained += take; }
      if (take !== chunk.length) stop('output_limit', 'Command output limit exceeded; reconcile outcome');
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk.subarray(-4000)]).subarray(-4000); });
    child.on('error', error => { failure ??= new CommandFailure('spawn', child.pid !== undefined, error.message, retained); });
    child.on('close', code => {
      clearTimeout(timer); if (escalation) clearTimeout(escalation);
      if (failure) reject(failure);
      else if (code !== 0) reject(new CommandFailure('exit', child.pid !== undefined, `Command failed (${code}): ${stderr.toString('utf8').slice(-1000)}`, retained));
      else resolve(Buffer.concat(chunks, retained).toString('utf8').trim());
    });
  });
}
