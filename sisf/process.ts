import { spawn, spawnSync } from 'node:child_process';

/** Prevent ambient Git routing from redirecting a project-bound operation. */
export function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES']) delete env[key];
  return env;
}

export function git(repo: string, ...args: string[]): string | null {
  const result = spawnSync('git', ['-C', repo, ...args], { env: gitEnvironment(), encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** A bounded child; no shell interpolation, no automatic retries of writes. */
export function command(program: string, args: string[], cwd: string, timeout = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env: gitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', failure: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const signal = (name: NodeJS.Signals) => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, name); else child.kill(name); } catch { /* already exited */ }
    };
    const stop = (message: string) => {
      if (failure) return;
      failure = Error(message); signal('SIGTERM');
      escalation = setTimeout(() => signal('SIGKILL'), 300);
    };
    const timer = setTimeout(() => stop('Command timed out; reconcile its outcome before retry'), timeout);
    child.stdout.on('data', chunk => { stdout += chunk; if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) stop('Command output limit exceeded; reconcile outcome'); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', error => { failure ??= error; });
    child.on('close', code => {
      clearTimeout(timer); if (escalation) clearTimeout(escalation);
      if (failure) reject(failure);
      else if (code !== 0) reject(Error(`Command failed (${code}): ${stderr.slice(-1000)}`));
      else resolve(stdout.trim());
    });
  });
}
