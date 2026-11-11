import './runtime.ts';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, lstatSync, openSync, realpathSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { snapshotRead } from './bridge.ts';
import { fail, type Obj } from './ts/util.ts';

interface SourceRow { rowid: number; title: string; desc: string; acceptance: string }
interface SourceSnapshot { project: string; sequence: number; count: number; rows: SourceRow[] }

const changes = "'create','q','update','admin_update','rename','delete','import','sync_import','plan','goal','sub','woop','compact'";
const sequenceSql = `SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE op IN (${changes})`;
const maxDocuments = 100_000;

function settings(): { model: string; extension: string; port: number } | null {
  const model = process.env.SIS_VEC_MODEL;
  const extension = process.env.SIS_VEC_EXTENSION;
  if (!model || !extension) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u.test(model)) fail('bad_args', 'SIS_VEC_MODEL is invalid');
  if (!extension.startsWith('/') || !existsSync(extension) || !statSync(extension).isFile()) return null;
  const port = Number(process.env.SIS_VEC_PORT ?? 11434);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('bad_args', 'SIS_VEC_PORT must be 1..65535');
  return { model, extension: realpathSync(extension), port };
}

function vector(values: unknown, dimensions?: number): Buffer {
  if (!Array.isArray(values) || values.length < 2 || values.length > 4096 || dimensions !== undefined && values.length !== dimensions
    || values.some(value => typeof value !== 'number' || !Number.isFinite(value))) fail('search_unavailable', 'Invalid local embedding response');
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value as number, index * 4));
  return buffer;
}

async function embed(input: string[], config: NonNullable<ReturnType<typeof settings>>): Promise<Buffer[]> {
  const response = await fetch(`http://127.0.0.1:${config.port}/api/embed`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.model, input }), redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || !response.body) fail('search_unavailable', `Local embedding model unavailable (${response.status})`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8 * 1024 * 1024) fail('search_unavailable', 'Local embedding response exceeds 8 MiB');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const reply = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { embeddings?: unknown[] };
  if (!Array.isArray(reply.embeddings) || reply.embeddings.length !== input.length) fail('search_unavailable', 'Local embedding count differs');
  const dimensions = Array.isArray(reply.embeddings[0]) ? reply.embeddings[0].length : undefined;
  return reply.embeddings.map(item => vector(item, dimensions));
}

export class SearchProjection {
  readonly path: string;
  private readonly configuredModel: string;
  private lastError: string | null = null;
  constructor(readonly source: string, project: string) {
    this.configuredModel = process.env.SIS_VEC_MODEL ?? '';
    this.path = source + '.search-vec-' + createHash('sha256').update(project + '\0' + this.configuredModel).digest('hex').slice(0, 12) + '.sqlite';
  }
  private snapshot(includeRows = false): SourceSnapshot {
    return snapshotRead(this.source, (db, info) => {
      const rows = includeRows ? db.prepare('SELECT rowid,COALESCE(title,\'\') AS title,COALESCE("desc",\'\') AS "desc",COALESCE(acceptance,\'\') AS acceptance FROM issues ORDER BY rowid').all() as unknown as SourceRow[] : [];
      if (rows.length > maxDocuments) fail('search_unavailable', 'Search projection exceeds 100000 issues');
      return { project: info.project_id, sequence: Number(db.prepare(sequenceSql).get()?.seq ?? 0),
        count: includeRows ? rows.length : Number(db.prepare('SELECT COUNT(*) AS n FROM issues').get()?.n ?? 0), rows };
    });
  }
  private metadata(): Obj | null {
    if (!existsSync(this.path)) return null;
    const file = lstatSync(this.path);
    if (!file.isFile() || file.isSymbolicLink()) fail('search_unavailable', 'Search projection must be a regular file');
    const db = new DatabaseSync(this.path, { readOnly: true });
    try {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sis_vec_meta'").get()) fail('search_unavailable', 'Refusing an unowned search database');
      const row = db.prepare('SELECT project,source,model,sequence,issue_count,dimensions,format FROM sis_vec_meta').get();
      if (!row || row.format !== 2) fail('search_unavailable', 'Search projection format is unsupported');
      return row as Obj;
    } finally { db.close(); }
  }
  status(): Obj {
    try {
      const config = settings(), snapshot = this.snapshot();
      if (!config) return { ready: false, reason: 'disabled', path: this.path, last_error: this.lastError };
      if (config.model !== this.configuredModel) return { ready: false, reason: 'model_changed', path: this.path, last_error: this.lastError };
      const meta = this.metadata();
      if (!meta) return { ready: false, reason: 'index_missing', path: this.path, last_error: this.lastError };
      if (meta.project !== snapshot.project || meta.source !== this.source) return { ready: false, reason: 'project_mismatch', path: this.path, last_error: this.lastError };
      if (meta.model !== config.model || Number(meta.sequence) !== snapshot.sequence || Number(meta.issue_count) !== snapshot.count)
        return { ready: false, reason: 'stale', path: this.path, last_error: this.lastError };
      return { ready: true, reason: 'ready', path: this.path, sequence: snapshot.sequence, dimensions: meta.dimensions, model: config.model, last_error: this.lastError };
    } catch (error) {
      this.lastError = String(error);
      return { ready: false, reason: 'unavailable', path: this.path, last_error: this.lastError };
    }
  }
  async rebuild(): Promise<Obj> {
    const config = settings();
    if (!config) fail('search_unavailable', 'Set SIS_VEC_MODEL and an existing absolute SIS_VEC_EXTENSION to build the optional index');
    if (config.model !== this.configuredModel) fail('search_unavailable', 'Restart the runtime after changing SIS_VEC_MODEL');
    const before = this.snapshot(true);
    const previous = this.metadata();
    if (previous && (previous.project !== before.project || previous.source !== this.source || previous.model !== config.model))
      fail('search_unavailable', 'Refusing a projection owned by another source, project or model');
    const embedded: Buffer[] = [];
    const deadline = performance.now() + 120_000;
    for (let start = 0; start < before.rows.length; start += 16) {
      if (performance.now() > deadline) fail('search_unavailable', 'Search rebuild exceeded 120 seconds');
      const batch = before.rows.slice(start, start + 16).map(row => `${row.title}\n${row.desc}\n${row.acceptance}`.slice(0, 4096));
      embedded.push(...await embed(batch, config));
    }
    const dimensions = embedded[0]?.length ? embedded[0].length / 4 : (await embed(['Superiss empty search index'], config))[0]!.length / 4;
    if (!dimensions || embedded.some(value => value.length !== dimensions * 4)) fail('search_unavailable', 'Inconsistent embedding dimensions');
    const after = this.snapshot();
    if (after.sequence !== before.sequence || after.count !== before.count) fail('search_stale', 'Issues changed during embedding; rebuild on a fresh snapshot');
    if (!previous) closeSync(openSync(this.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
    const db = new DatabaseSync(this.path, { allowExtension: true });
    try {
      chmodSync(this.path, 0o600);
      db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      try {
        if (!previous) {
          if (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get()?.n !== 0)
            fail('search_unavailable', 'Refusing an unowned search database');
          db.exec('CREATE TABLE sis_vec_meta(project TEXT PRIMARY KEY,source TEXT NOT NULL,model TEXT NOT NULL,sequence INTEGER NOT NULL,issue_count INTEGER NOT NULL,dimensions INTEGER NOT NULL,format INTEGER NOT NULL)');
          db.prepare('INSERT INTO sis_vec_meta(project,source,model,sequence,issue_count,dimensions,format) VALUES(?,?,?,-1,-1,?,2)')
            .run(before.project, this.source, config.model, dimensions);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      db.loadExtension(config.extension);
      db.exec('BEGIN IMMEDIATE');
      try {
        const meta = db.prepare('SELECT project,source,model,dimensions FROM sis_vec_meta').get();
        if (meta && (meta.project !== before.project || meta.source !== this.source || meta.model !== config.model || meta.dimensions !== dimensions))
          fail('search_unavailable', 'Search projection identity or dimensions differ');
        if (!meta) fail('search_unavailable', 'Search projection lost its ownership marker');
        db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS issues_vec USING vec0(id INTEGER PRIMARY KEY,embedding float[${dimensions}] distance_metric=cosine)`);
        db.exec('DELETE FROM issues_vec');
        const insert = db.prepare('INSERT INTO issues_vec(id,embedding) VALUES(?,?)');
        before.rows.forEach((row, index) => {
          if (index % 128 === 0 && performance.now() > deadline) fail('search_unavailable', 'Search rebuild exceeded 120 seconds');
          const id = Number(row.rowid);
          if (!Number.isSafeInteger(id)) fail('search_unavailable', 'Issue rowid exceeds the supported range');
          insert.run(BigInt(id), embedded[index]!);
        });
        db.prepare('INSERT INTO sis_vec_meta(project,source,model,sequence,issue_count,dimensions,format) VALUES(?,?,?,?,?,?,2) ON CONFLICT(project) DO UPDATE SET sequence=excluded.sequence,issue_count=excluded.issue_count')
          .run(before.project, this.source, config.model, before.sequence, before.count, dimensions);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
    this.lastError = null;
    return { indexed: before.rows.length, sequence: before.sequence, model: config.model, path: this.path, ...this.status() };
  }
  async candidates(query: string, limit: number): Promise<number[] | null> {
    const config = settings();
    if (!config || config.model !== this.configuredModel || this.status().ready !== true) return null;
    const snapshot = this.snapshot();
    const [embedding] = await embed([query.slice(0, 1024)], config);
    const latest = this.snapshot();
    if (latest.sequence !== snapshot.sequence || latest.count !== snapshot.count) return null;
    const db = new DatabaseSync(this.path, { readOnly: true, allowExtension: true });
    try {
      db.loadExtension(config.extension);
      const meta = db.prepare('SELECT sequence,issue_count,dimensions FROM sis_vec_meta').get();
      if (Number(meta?.sequence) !== snapshot.sequence || Number(meta?.issue_count) !== snapshot.count || embedding?.length !== Number(meta?.dimensions) * 4) return null;
      const rows = db.prepare('SELECT id FROM issues_vec WHERE embedding MATCH ? AND k=? ORDER BY distance').all(embedding, BigInt(Math.min(1000, Math.max(20, limit * 4))));
      const after = this.snapshot();
      if (after.sequence !== snapshot.sequence || after.count !== snapshot.count) return null;
      return rows.map(row => Number(row.id));
    } finally { db.close(); }
  }
  note(error: unknown): void { this.lastError = error instanceof Error ? error.message : String(error); }
}
