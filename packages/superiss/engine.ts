import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { Engine as CoreEngine, registry, type Context } from './ts/engine.ts';
import { canonical, object, SisError, type Obj, type Value } from './ts/util.ts';
import { Analytics } from './analytics.ts';
import { SearchProjection } from './search.ts';
import { VERSION, sqliteLibrary } from './runtime.ts';
import type { ReportKind } from './bridge.ts';
export { registry, type Context };

export class Engine extends CoreEngine {
  readonly analytics: Analytics;
  readonly searchProjection: SearchProjection;
  private indexJob: Promise<Obj> | undefined;
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
    this.searchProjection = new SearchProjection(source, String(this.db.get("SELECT v FROM kv WHERE k='project_id'")?.v));
  }
  private versioned(value: Value): Obj {
    return { ...object(value), version: VERSION, typescript: '7.1', sqlite_version: String(this.db.get('SELECT sqlite_version() v')?.v), sqlite_library: sqliteLibrary, analytics_authority: 'sqlite', analytics_isolation: 'process', analytics_consistency: 'snapshot', search_projection: { authority: 'sqlite', default: 'fts5', mode: 'opt-in-hybrid', ...this.searchProjection.status() }, forge: { version: VERSION, command: 'sis forge', backends: ['git', 'worktrunk'], proof_preflight: 'close_check' }, rpc_session: { transport: 'ndjson', max_request_bytes: 1048576, max_response_bytes: 8388608, dispatch: 'serial', mutation_replay: false }, watch_response: 'single', multiplexing: 'request_id', verify_capacity: this.verifyLimit, verify_running: this.verifyJobs.size, operations: registry.map(op => op.name ?? null) };
  }
  override async dispatch(cmd: string, raw: Value = {}, context: Partial<Context> = {}): Promise<Value> {
    if (this.closing && !['capabilities', 'analytics_status'].includes(cmd)) throw new SisError('shutting_down', 'Engine is draining accepted work');
    if (cmd === 'search_index') {
      const args = object(raw), action = args.action ?? 'status';
      if (Object.keys(args).some(key => key !== 'action') || !['status', 'build'].includes(String(action))) throw new SisError('bad_args', 'search_index action must be status or build');
      if (action === 'status') return this.searchProjection.status();
      if (!this.indexJob) {
        const job = this.searchProjection.rebuild();
        this.indexJob = job;
        void job.finally(() => { if (this.indexJob === job) this.indexJob = undefined; }).catch(() => undefined);
      }
      return this.indexJob;
    }
    if (cmd === 'search') {
      const args = object(raw), mode = args.mode ?? 'lexical';
      if (mode !== 'lexical' && mode !== 'hybrid') throw new SisError('bad_args', 'search mode must be lexical or hybrid');
      const limit = args.limit === undefined ? 20 : Number(args.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new SisError('bad_args', 'search limit must be 1..1000');
      if (mode === 'lexical') return super.dispatch(cmd, { ...args, mode: undefined }, context);
      if (typeof args.q !== 'string' || !args.q.trim()) throw new SisError('bad_args', 'search q required');
      const candidates = Math.min(1000, Math.max(20, limit * 4));
      const lexical = await super.dispatch(cmd, { q: args.q, limit: candidates }, context) as Obj[];
      let semantic: number[] | null;
      try { semantic = await this.searchProjection.candidates(args.q, candidates); }
      catch (error) { this.searchProjection.note(error); semantic = null; }
      if (!semantic?.length) return lexical.slice(0, limit);
      const ranks = new Map<string, { score: number; issue: Obj }>();
      lexical.forEach((issue, rank) => ranks.set(String(issue.id), { issue, score: 1 / (61 + rank) }));
      for (const [rank, rowid] of semantic.entries()) {
        const issue = this.issues('SELECT * FROM issues WHERE rowid=?', rowid)[0];
        if (!issue) continue;
        const id = String(issue.id), previous = ranks.get(id);
        ranks.set(id, { issue, score: (previous?.score ?? 0) + 1 / (61 + rank) });
      }
      return [...ranks.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(row => row.issue);
    }
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
  async shutdown(): Promise<void> { this.closing = true; await Promise.allSettled([...this.verifyJobs.values(), ...(this.indexJob ? [this.indexJob] : [])]); await this.analytics.shutdown(); }
}
