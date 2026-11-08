import '../runtime.ts';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

type Parameter = null | number | bigint | string | Uint8Array;
export type SqlRow = Record<string, null | number | bigint | string | Uint8Array>;

const schema = `
CREATE TABLE IF NOT EXISTS issues(id TEXT PRIMARY KEY,title TEXT,status TEXT DEFAULT 'open',priority INT DEFAULT 2,type TEXT DEFAULT 'task',owner TEXT,oracle_cmd TEXT,allowed_paths TEXT,lane TEXT,budget_eur REAL,acceptance TEXT,"desc" TEXT,lease_until REAL,lease_epoch INT DEFAULT 0,claim_actor TEXT,created_at REAL,closed_at REAL,meta_json TEXT,defer_until REAL,expires_at REAL);
CREATE TABLE IF NOT EXISTS deps(issue TEXT,depends_on TEXT,type TEXT DEFAULT 'blocks',PRIMARY KEY(issue,depends_on));
CREATE TABLE IF NOT EXISTS claims(actor TEXT,issue TEXT,claim_id TEXT,epoch INT,hb_at REAL,run_id TEXT,PRIMARY KEY(actor,issue));
CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,ts REAL,op TEXT,issue TEXT,actor TEXT,run_id TEXT,idem TEXT,data_json TEXT);
CREATE TABLE IF NOT EXISTS memories(key TEXT PRIMARY KEY,value TEXT,updated_at REAL);
CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT,payload TEXT,state TEXT DEFAULT 'pending',attempts INT DEFAULT 0,run_id TEXT);
CREATE TABLE IF NOT EXISTS sis_ts_delivery_leases(outbox_id INTEGER PRIMARY KEY,actor TEXT NOT NULL,epoch INTEGER NOT NULL,lease_until REAL NOT NULL);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY,v TEXT);
CREATE TABLE IF NOT EXISTS gates(name TEXT PRIMARY KEY,state TEXT DEFAULT 'closed',payload TEXT,updated_at REAL);
CREATE TABLE IF NOT EXISTS slots(name TEXT PRIMARY KEY,holder TEXT,epoch INT DEFAULT 0,lease_until REAL,claim_id TEXT,updated_at REAL);
CREATE TABLE IF NOT EXISTS proofs(proof_id TEXT PRIMARY KEY,issue TEXT,actor TEXT,epoch INTEGER,revision TEXT,source_hash TEXT,cwd TEXT,oracle TEXT,exitcode INTEGER,passed INTEGER,timed_out INTEGER,output TEXT,review_receipt TEXT);
CREATE TABLE IF NOT EXISTS checkpoints(seq INTEGER PRIMARY KEY AUTOINCREMENT,issue TEXT,actor TEXT,epoch INTEGER,revision TEXT,source_hash TEXT,cwd TEXT,text TEXT,next_step TEXT,artifacts TEXT,ts REAL);
CREATE TABLE IF NOT EXISTS cancellations(issue TEXT PRIMARY KEY,requested INTEGER DEFAULT 0,actor TEXT,ts REAL);
CREATE TABLE IF NOT EXISTS agent_state(issue TEXT PRIMARY KEY,cancel_requested INTEGER DEFAULT 0,attempt INTEGER DEFAULT 0,last_error TEXT);
CREATE TABLE IF NOT EXISTS attests(attest_id TEXT PRIMARY KEY,issue TEXT,actor TEXT,epoch INTEGER,revision TEXT,source_hash TEXT,cwd TEXT,kind TEXT,payload TEXT,summary TEXT,passed INTEGER,ts REAL);
CREATE TABLE IF NOT EXISTS costs(id INTEGER PRIMARY KEY AUTOINCREMENT,issue TEXT,actor TEXT,run_id TEXT,wave TEXT,tokens_in INTEGER DEFAULT 0,tokens_out INTEGER DEFAULT 0,cents INTEGER DEFAULT 0,currency TEXT DEFAULT 'EUR',note TEXT,ts REAL);
CREATE INDEX IF NOT EXISTS idx_events_issue ON events(issue,seq);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_deps_issue ON deps(issue);
CREATE INDEX IF NOT EXISTS idx_deps_on ON deps(depends_on);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status,priority);
`;
const fts = `
DROP TRIGGER IF EXISTS issues_fts_ai;
DROP TRIGGER IF EXISTS issues_fts_ad;
DROP TRIGGER IF EXISTS issues_fts_au;
DROP TABLE IF EXISTS issues_fts;
CREATE VIRTUAL TABLE issues_fts USING fts5(title,"desc",acceptance,content='issues');
CREATE TRIGGER issues_fts_ai AFTER INSERT ON issues BEGIN INSERT INTO issues_fts(rowid,title,"desc",acceptance) VALUES(new.rowid,new.title,new."desc",new.acceptance); END;
CREATE TRIGGER issues_fts_ad AFTER DELETE ON issues BEGIN INSERT INTO issues_fts(issues_fts,rowid,title,"desc",acceptance) VALUES('delete',old.rowid,old.title,old."desc",old.acceptance); END;
CREATE TRIGGER issues_fts_au AFTER UPDATE ON issues BEGIN INSERT INTO issues_fts(issues_fts,rowid,title,"desc",acceptance) VALUES('delete',old.rowid,old.title,old."desc",old.acceptance); INSERT INTO issues_fts(rowid,title,"desc",acceptance) VALUES(new.rowid,new.title,new."desc",new.acceptance); END;
INSERT INTO issues_fts(issues_fts) VALUES('rebuild');
`;

export class StoreDatabase {
  private readonly database: DatabaseSync;
  private depth = 0;
  private readonly statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  private readonly counts = { prepares: 0, hits: 0, evictions: 0 };
  private readonly cacheLimit: number;
  private readonly busyMs: number;
  readonly path: string;
  constructor(path: string, options: { statementCacheSize?: number } = {}) {
    this.cacheLimit = options.statementCacheSize ?? 64;
    this.busyMs = Number(process.env.SIS_SQLITE_BUSY_MS ?? 250);
    if (!Number.isInteger(this.cacheLimit) || this.cacheLimit < 0 || this.cacheLimit > 512) throw Error('statementCacheSize must be 0..512');
    if (!Number.isInteger(this.busyMs) || this.busyMs < 25 || this.busyMs > 5000) throw Error('SIS_SQLITE_BUSY_MS must be 25..5000');
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    this.database = new DatabaseSync(this.path, { enableForeignKeyConstraints: false });
    try {
      this.exec(`PRAGMA busy_timeout=${this.busyMs};`);
      const version = Number(this.get('PRAGMA user_version')?.user_version);
      if (version > 8) throw Error(`Database schema version ${version} is newer than supported version 8`);
      chmodSync(this.path, 0o600);
      if (String(this.get('PRAGMA journal_mode')?.journal_mode).toLowerCase() !== 'wal') this.exec('PRAGMA journal_mode=WAL;');
      this.exec(`PRAGMA synchronous=${process.env.SIS_SYNCHRONOUS === 'NORMAL' ? 'NORMAL' : 'FULL'};`);
      if (version >= 7) {
        for (const name of ['issues', 'proofs', 'checkpoints', 'claims', 'kv', 'attests', 'costs']) {
          if (!this.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name)) throw Error(`Invalid schema: missing ${name}`);
        }
        return;
      }
      this.transaction(() => {
        this.exec(schema);
        const add = (table: string, name: string, definition: string) => {
          if (!this.all(`PRAGMA table_info(${table})`).some(row => row.name === name)) this.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        };
        add('issues', 'meta_json', 'TEXT');
        add('issues', 'defer_until', 'REAL');
        add('issues', 'expires_at', 'REAL');
        add('deps', 'type', "TEXT DEFAULT 'blocks'");
        const columns = this.all('PRAGMA table_info(checkpoints)').map(row => row.name);
        if (columns.includes('id') && !columns.includes('seq')) this.exec('ALTER TABLE checkpoints RENAME COLUMN id TO seq');
        if (columns.includes('created_at') && !columns.includes('ts')) this.exec('ALTER TABLE checkpoints RENAME COLUMN created_at TO ts');
        this.exec(fts);
        this.run("INSERT OR IGNORE INTO kv(k,v) VALUES('project_id',?)", 'sis-project-' + randomBytes(16).toString('hex'));
        this.exec('PRAGMA user_version=7');
      });
    } catch (error) {
      this.database.close();
      throw error;
    }
  }
  get statementStats() { return { ...this.counts, cached: this.statements.size }; }
  private prepared(sql: string): ReturnType<DatabaseSync['prepare']> {
    const cached = this.statements.get(sql);
    if (cached) { this.counts.hits++; this.statements.delete(sql); this.statements.set(sql, cached); return cached; }
    const statement = this.database.prepare(sql); this.counts.prepares++;
    if (this.cacheLimit) {
      if (this.statements.size >= this.cacheLimit) { this.statements.delete(this.statements.keys().next().value!); this.counts.evictions++; }
      this.statements.set(sql, statement);
    }
    return statement;
  }
  get(sql: string, ...parameters: Parameter[]): SqlRow | undefined { return this.prepared(sql).get(...parameters); }
  all(sql: string, ...parameters: Parameter[]): SqlRow[] { return this.prepared(sql).all(...parameters); }
  run(sql: string, ...parameters: Parameter[]) { return this.prepared(sql).run(...parameters); }
  exec(sql: string): void {
    if (/(?:^|;)\s*(?:CREATE|ALTER|DROP|REINDEX|VACUUM)\b/iu.test(sql)) this.statements.clear();
    const deadline = Date.now() + this.busyMs;
    while (true) {
      try { this.database.exec(sql); return; }
      catch (error) {
        if (this.depth || !/^PRAGMA|^BEGIN IMMEDIATE/u.test(sql) || !/database is locked|SQLITE_BUSY/u.test(String(error)) || Date.now() >= deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
      }
    }
  }
  get inTransaction(): boolean { return this.depth > 0; }
  transaction<T>(operation: () => T): T {
    if (this.depth) return operation();
    this.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = operation();
      this.exec('COMMIT');
      return result;
    } catch (error) {
      this.exec('ROLLBACK');
      throw error;
    } finally { this.depth--; }
  }
  close(): void { this.statements.clear(); this.database.close(); }
}
