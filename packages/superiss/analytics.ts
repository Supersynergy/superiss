import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { object, SisError, type Obj } from './ts/util.ts';
import type { ReportKind } from './bridge.ts';

interface Job { key: string; child: ChildProcess; promise: Promise<Obj>; stop(reason: SisError): void }
export class Analytics {
  private job: Job | undefined;
  private closed = false;
  private completed = 0;
  private coalesced = 0;
  private lastError: string | null = null;
  constructor(readonly source: string, readonly projection: string, readonly timeoutMs = 30000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw Error('reportTimeoutMs must be 1..60000');
  }
  status() { return { running: !!this.job, completed: this.completed, coalesced: this.coalesced, last_error: this.lastError, projection: this.projection, max_concurrency: 1 }; }
  report(kind: ReportKind = 'all', limit = 100): Promise<Obj> {
    if (!['all', 'summary', 'actors', 'daily'].includes(kind) || !Number.isInteger(limit) || limit < 1 || limit > 1000) return Promise.reject(new SisError('bad_args', 'Invalid analytics kind or limit'));
    if (this.closed) return Promise.reject(new SisError('analytics_closed', 'Analytics service closed'));
    const key = `${kind}:${limit}`;
    if (this.job) {
      if (this.job.key !== key) return Promise.reject(new SisError('analytics_busy', 'A different read-only report is running; retry after it completes'));
      this.coalesced++; return this.job.promise;
    }
    const token = randomBytes(16).toString('hex'), started = performance.now();
    const worker = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './analytics-worker.ts' : './analytics-worker.js', import.meta.url));
    const guard = ['--timeout', String(Math.max(1, Math.ceil(this.timeoutMs / 1000))), '--max-rss-gb', '1', '--threads', '2', '--', process.execPath, worker, this.source, this.projection, kind, String(limit), token];
    const child = spawn('run-guard', guard, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const decoder = new StringDecoder('utf8');
    let buffer = '', stderr = '', workerPid: number | undefined, failure: Error | undefined, data: Obj | undefined, done = false;
    let escalation: NodeJS.Timeout | undefined;
    const signal = (name: NodeJS.Signals) => {
      if (done) return;
      // Only the nonce-matched worker and our own wrapper are signalled.
      if (workerPid) { try { process.kill(workerPid, name); } catch { /* already exited */ } }
      try { child.kill(name); } catch { /* already exited */ }
    };
    const stop = (reason: SisError) => {
      if (done || failure) return;
      failure = reason; signal('SIGTERM');
      escalation = setTimeout(() => signal('SIGKILL'), 500);
    };
    let job: Job;
    const promise = new Promise<Obj>((resolve, reject) => {
      const timeout = setTimeout(() => stop(new SisError('analytics_timeout', 'Analytics timeout; SQLite remains authoritative')), this.timeoutMs);
      child.stdout!.on('data', (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer) > 1048576) { stop(new SisError('analytics_protocol', 'Worker frame limit exceeded')); return; }
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line) continue;
          try {
            const frame = object(JSON.parse(line));
            if (frame.token !== token) throw Error('Worker identity differs');
            if (frame.type === 'started' && !workerPid && Number.isSafeInteger(frame.pid) && Number(frame.pid) > 1 && frame.pid !== process.pid) workerPid = Number(frame.pid);
            else if (frame.type === 'result' && !data) data = object(frame.data);
            else throw Error('Unexpected worker frame');
          } catch (error) { stop(new SisError('analytics_protocol', String(error))); }
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-16384); });
      child.on('error', error => { failure ??= error; });
      child.on('close', code => {
        done = true; clearTimeout(timeout); if (escalation) clearTimeout(escalation);
        if (this.job === job) this.job = undefined;
        if (!failure && (code !== 0 || !data || data.authority !== 'sqlite' || data.consistency !== 'snapshot' || data.source_path !== this.source)) failure = new SisError('analytics_failed', `Read-only worker failed (${code}): ${stderr.slice(-1500)}`);
        if (failure) { this.lastError = failure.message; reject(failure); }
        else { this.completed++; this.lastError = null; resolve({ ...data!, total_ms: performance.now() - started }); }
      });
    });
    job = { key, child, promise, stop }; this.job = job;
    return promise;
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.job) { const job = this.job; job.stop(new SisError('analytics_cancelled', 'Owned analytics worker cancelled during shutdown')); await job.promise.catch(() => undefined); }
  }
}
