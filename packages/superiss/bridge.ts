import './runtime.ts';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DuckStore, type Scalar } from './duck.ts';

export interface Snapshot { project_id: string; snapshot_sequence: number; schema_version: number; source_path: string }
function metadata(db: DatabaseSync, path: string): Snapshot {
  const schema = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  if (![7, 8].includes(schema)) throw Error(`Unsupported Superiss SQLite schema ${schema}`);
  const project = db.prepare("SELECT v FROM kv WHERE k='project_id'").get()?.v;
  if (typeof project !== 'string' || !project) throw Error('SQLite project identity missing');
  const sequence = Number(db.prepare('SELECT COALESCE(MAX(seq),0) seq FROM events').get()?.seq);
  if (!Number.isSafeInteger(sequence)) throw Error('Snapshot sequence exceeds safe range');
  return { project_id: project, snapshot_sequence: sequence, schema_version: schema, source_path: path };
}
export function snapshotRead<T>(source: string, consume: (db: DatabaseSync, snapshot: Snapshot) => T): T {
  const path = realpathSync(source);
  if (!statSync(path).isFile()) throw Error('Existing SQLite source required');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250; BEGIN');
    try {
      const result = consume(db, metadata(db, path));
      if (result && typeof (result as { then?: unknown }).then === 'function') throw Error('Snapshot consumers must be synchronous');
      db.exec('COMMIT'); return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

/** Offline, no-overwrite SQLite-to-SQLite bridge. Never converts a live store. */
export function copySqlite(source: string, destination: string): Snapshot & { destination: string } {
  const src = realpathSync(source), dst = resolve(destination);
  if (src === dst || existsSync(dst)) throw Error('Destination exists; refusing same-file copy or overwrite');
  const db = new DatabaseSync(src, { readOnly: true });
  let staging: string | undefined;
  try {
    const before = metadata(db, src);
    mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
    staging = mkdtempSync(join(dirname(dst), '.sis-copy-'));
    const file = join(staging, basename(dst));
    db.prepare('VACUUM INTO ?').run(file);
    chmodSync(file, 0o600);
    const copy = new DatabaseSync(file, { readOnly: true });
    let snapshot: Snapshot;
    try {
      if (copy.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw Error('Copied SQLite integrity check failed');
      snapshot = metadata(copy, dst);
      if (snapshot.project_id !== before.project_id) throw Error('Copied project identity differs');
    } finally { copy.close(); }
    const fd = openSync(file, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(file, dst); // Atomic create-if-absent; a racing destination is never overwritten.
    const directory = openSync(dirname(dst), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
    return { ...snapshot, destination: dst };
  } finally { db.close(); if (staging) rmSync(staging, { recursive: true, force: true }); }
}

const plans = [
  { name: 'issues', key: 'id', columns: 'id,title,status,priority,type,lane,owner,claim_actor,lease_epoch,created_at,closed_at', ddl: 'id VARCHAR PRIMARY KEY,title VARCHAR,status VARCHAR,priority INTEGER,type VARCHAR,lane VARCHAR,owner VARCHAR,claim_actor VARCHAR,lease_epoch BIGINT,created_at DOUBLE,closed_at DOUBLE' },
  { name: 'events', key: 'seq', columns: 'seq,ts,op,issue,actor,data_json', ddl: 'seq BIGINT PRIMARY KEY,ts DOUBLE,op VARCHAR,issue VARCHAR,actor VARCHAR,data_json VARCHAR' },
  { name: 'costs', key: 'id', columns: 'id,issue,actor,cents,ts,currency', ddl: 'id BIGINT PRIMARY KEY,issue VARCHAR,actor VARCHAR,cents BIGINT,ts DOUBLE,currency VARCHAR' },
  { name: 'proofs', key: 'proof_id', columns: 'proof_id,issue,actor,passed,timed_out,exitcode', ddl: 'proof_id VARCHAR PRIMARY KEY,issue VARCHAR,actor VARCHAR,passed INTEGER,timed_out INTEGER,exitcode INTEGER' },
  { name: 'agent_state', key: 'issue', columns: 'issue,cancel_requested,attempt', ddl: 'issue VARCHAR PRIMARY KEY,cancel_requested INTEGER,attempt BIGINT' },
] as const;
function scalar(value: unknown): Scalar {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  if (typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) return Number(value);
  throw Error('SQLite projection value is not a safe scalar');
}
export type ReportKind = 'all' | 'summary' | 'actors' | 'daily';
export function refreshProjection(source: string, destination: string, kind: ReportKind = 'all', limit = 100) {
  if (!['all', 'summary', 'actors', 'daily'].includes(kind) || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw Error('Invalid analytics kind or limit');
  const started = performance.now();
  return snapshotRead(source, (sqlite, snapshot) => {
    if (resolve(destination) === snapshot.source_path || existsSync(destination) && realpathSync(destination) === snapshot.source_path) throw Error('SQLite and projection must be different files');
    const duck = new DuckStore(destination); let owned = false;
    try {
      const stamp = Number(duck.get("SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema='main' AND table_name='sis_analytics_meta'")?.n);
      const tables = Number(duck.get("SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema='main'")?.n);
      if (tables && !stamp) throw Error('Projection is not owned by Superiss; refusing overwrite');
      if (stamp) {
        const old = duck.get('SELECT project_id,format_version FROM sis_analytics_meta');
        if (old?.project_id !== snapshot.project_id || old?.format_version !== 1) throw Error('Projection project identity or format mismatch');
      }
      owned = true; chmodSync(duck.path, 0o600);
      const counts: Record<string, number> = {};
      duck.transaction(() => {
        duck.run('CREATE TABLE IF NOT EXISTS sis_analytics_meta(project_id VARCHAR PRIMARY KEY,format_version INTEGER,sequence BIGINT,schema_version INTEGER)');
        for (const plan of plans) {
          duck.run(`CREATE TABLE IF NOT EXISTS ${plan.name}(${plan.ddl})`);
          duck.run(`DELETE FROM ${plan.name}`);
          const columns = plan.columns.split(','); let cursor: string | number | bigint | null = null, count = 0;
          while (true) {
            const rows = cursor === null
              ? sqlite.prepare(`SELECT ${plan.columns} FROM ${plan.name} ORDER BY ${plan.key} LIMIT 1024`).all()
              : sqlite.prepare(`SELECT ${plan.columns} FROM ${plan.name} WHERE ${plan.key}>? ORDER BY ${plan.key} LIMIT 1024`).all(cursor);
            if (!rows.length) break;
            duck.appendRows(plan.name, rows.map(row => columns.map(column => scalar(row[column]))));
            cursor = rows.at(-1)![plan.key] as string | number | bigint;
            count += rows.length;
          }
          counts[plan.name] = count;
        }
        duck.run('DELETE FROM sis_analytics_meta');
        duck.run('INSERT INTO sis_analytics_meta VALUES(?,1,?,?)', snapshot.project_id, snapshot.snapshot_sequence, snapshot.schema_version);
      });
      const tasks = kind === 'all' || kind === 'summary' ? duck.all("SELECT i.status,i.lane,COUNT(*) tasks,SUM(CASE WHEN a.cancel_requested=1 THEN 1 ELSE 0 END) cancel_requested FROM issues i LEFT JOIN agent_state a ON a.issue=i.id GROUP BY i.status,i.lane ORDER BY i.status,i.lane LIMIT ?", limit) : [];
      const actors = kind === 'all' || kind === 'actors' ? duck.all("WITH e AS (SELECT actor,COUNT(*) events,COUNT(*) FILTER(WHERE op IN ('acquire','claim')) claims,COUNT(*) FILTER(WHERE op='heartbeat') heartbeats,COUNT(*) FILTER(WHERE op='close') closes,MAX(ts) last_event FROM events GROUP BY actor),c AS (SELECT actor,SUM(cents) cost_eur_cents FROM costs WHERE currency='EUR' GROUP BY actor) SELECT e.*,COALESCE(c.cost_eur_cents,0) cost_eur_cents FROM e LEFT JOIN c ON c.actor IS NOT DISTINCT FROM e.actor ORDER BY events DESC,actor LIMIT ?", limit) : [];
      const daily = kind === 'all' || kind === 'daily' ? duck.all('SELECT FLOOR(ts/86400)::BIGINT utc_day,COUNT(*) events FROM events GROUP BY utc_day ORDER BY utc_day DESC LIMIT ?', limit) : [];
      const costs = duck.all('SELECT currency,SUM(cents) cents FROM costs GROUP BY currency ORDER BY currency');
      const proofs = duck.all('SELECT passed,timed_out,COUNT(*) proofs FROM proofs GROUP BY passed,timed_out ORDER BY passed,timed_out');
      return { ...snapshot, consistency: 'snapshot', authority: 'sqlite', refreshed: true, kind, counts, tasks, actors, daily, costs, proofs, proof_latency_supported: false, duckdb_version: duck.version, import_ms: performance.now() - started, statement_stats: duck.statementStats };
    } finally {
      duck.close();
      if (owned) for (const path of [destination, destination + '.wal']) if (existsSync(path)) chmodSync(path, 0o600);
    }
  });
}
