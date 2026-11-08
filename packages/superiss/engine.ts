import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { Engine as CoreEngine, registry, type Context } from './ts/engine.ts';
import { canonical, object, SisError, type Obj, type Value } from './ts/util.ts';
import { Analytics } from './analytics.ts';
import { VERSION, sqliteLibrary } from './runtime.ts';
import type { ReportKind } from './bridge.ts';
export { registry, type Context };

export class Engine extends CoreEngine {
  readonly analytics: Analytics;
  private readonly verifyJobs = new Map<string, Promise<Value>>();
  private readonly verifyLimit: number;
  private closing = false;
  constructor(path: string, options: { reportTimeoutMs?: number; projectionPath?: string; verifyConcurrency?: number } = {}) {
    const limit = options.verifyConcurrency ?? Number(process.env.SIS_VERIFY_CONCURRENCY ?? 2);
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw Error('verifyConcurrency must be 1..8');
    if (options.reportTimeoutMs !== undefined && (!Number.isInteger(options.reportTimeoutMs) || options.reportTimeoutMs < 1 || options.reportTimeoutMs > 60000)) throw Error('reportTimeoutMs must be 1..60000');
    super(path); this.verifyLimit = limit;
    const source = realpathSync(this.db.path);
    this.analytics = new Analytics(source, resolve(options.projectionPath ?? source + '.analytics.duckdb'), options.reportTimeoutMs);
  }
  private versioned(value: Value): Obj {
    return { ...object(value), version: VERSION, typescript: '7.1', sqlite_version: String(this.db.get('SELECT sqlite_version() v')?.v), sqlite_library: sqliteLibrary, analytics_authority: 'sqlite', analytics_isolation: 'process', analytics_consistency: 'snapshot', forge: { version: VERSION, command: 'sis forge', backends: ['git', 'worktrunk'], proof_preflight: 'close_check' }, watch_response: 'single', multiplexing: 'request_id', verify_capacity: this.verifyLimit, verify_running: this.verifyJobs.size, operations: registry.map(op => op.name ?? null) };
  }
  override async dispatch(cmd: string, raw: Value = {}, context: Partial<Context> = {}): Promise<Value> {
    if (this.closing && !['capabilities', 'analytics_status'].includes(cmd)) throw new SisError('shutting_down', 'Engine is draining accepted work');
    if (cmd === 'verify') {
      const key = canonical({ args: raw, context: object(context) });
      const running = this.verifyJobs.get(key);
      if (running) return running;
      if (this.verifyJobs.size >= this.verifyLimit) throw new SisError('verify_busy', 'Oracle capacity full; keep the lease alive and retry with the same idempotency key after capacity frees');
      const work = super.dispatch(cmd, raw, context); this.verifyJobs.set(key, work);
      try { return await work; } finally { this.verifyJobs.delete(key); }
    }
    if (cmd === 'analytics' || cmd === 'analytics_status') {
      const args = object(raw), allowed = new Set(cmd === 'analytics' ? ['kind', 'limit'] : []);
      for (const name of Object.keys(args)) if (!allowed.has(name)) throw new SisError('bad_args', `Unknown analytics field: ${name}`);
      if (cmd === 'analytics_status') return this.analytics.status();
      if (args.kind !== undefined && typeof args.kind !== 'string' || args.limit !== undefined && typeof args.limit !== 'number') throw new SisError('bad_args', 'Analytics kind must be text and limit must be an integer');
      return this.analytics.report((args.kind ?? 'all') as ReportKind, Number(args.limit ?? 100));
    }
    const result = await super.dispatch(cmd, raw, context);
    if (cmd === 'capabilities') return this.versioned(result);
    if (cmd === 'context' || cmd === 'prime') return { ...object(result), capabilities: this.versioned(object(result).capabilities ?? {}) };
    return result;
  }
  async shutdown(): Promise<void> { this.closing = true; await Promise.allSettled([...this.verifyJobs.values()]); await this.analytics.shutdown(); }
}
