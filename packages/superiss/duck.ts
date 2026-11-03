import { createRequire } from 'node:module';
import { existsSync, mkdirSync, openSync, closeSync, readSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type Scalar = string | number | boolean | null;
export type Row = Record<string, Scalar>;
type Argument = number | bigint | Buffer | null;
type Result = number | bigint | boolean | null | undefined;
interface Library { symbols: Record<string, (...args: Argument[]) => Result>; close(): void }
interface FFI {
  FFIType: Record<'ptr' | 'i32' | 'i64' | 'u64' | 'f64' | 'bool' | 'void', number>;
  CString: new (pointer: number) => { toString(): string };
  dlopen(path: string, symbols: Record<string, { args: number[]; returns: number }>): Library;
}
const ffi = createRequire(import.meta.url)('bun:ffi') as FFI;
const F = ffi.FFIType;
const declarations = {
  duckdb_library_version: { args: [], returns: F.ptr },
  duckdb_create_config: { args: [F.ptr], returns: F.i32 },
  duckdb_set_config: { args: [F.ptr, F.ptr, F.ptr], returns: F.i32 },
  duckdb_destroy_config: { args: [F.ptr], returns: F.void },
  duckdb_open_ext: { args: [F.ptr, F.ptr, F.ptr, F.ptr], returns: F.i32 },
  duckdb_close: { args: [F.ptr], returns: F.void },
  duckdb_connect: { args: [F.ptr, F.ptr], returns: F.i32 },
  duckdb_disconnect: { args: [F.ptr], returns: F.void },
  duckdb_prepare: { args: [F.ptr, F.ptr, F.ptr], returns: F.i32 },
  duckdb_prepare_error: { args: [F.ptr], returns: F.ptr },
  duckdb_destroy_prepare: { args: [F.ptr], returns: F.void },
  duckdb_clear_bindings: { args: [F.ptr], returns: F.i32 },
  duckdb_appender_create: { args: [F.ptr, F.ptr, F.ptr, F.ptr], returns: F.i32 },
  duckdb_appender_error: { args: [F.ptr], returns: F.ptr },
  duckdb_appender_column_count: { args: [F.ptr], returns: F.u64 },
  duckdb_appender_end_row: { args: [F.ptr], returns: F.i32 },
  duckdb_appender_flush: { args: [F.ptr], returns: F.i32 },
  duckdb_appender_destroy: { args: [F.ptr], returns: F.i32 },
  duckdb_append_null: { args: [F.ptr], returns: F.i32 },
  duckdb_append_int64: { args: [F.ptr, F.i64], returns: F.i32 },
  duckdb_append_double: { args: [F.ptr, F.f64], returns: F.i32 },
  duckdb_append_bool: { args: [F.ptr, F.bool], returns: F.i32 },
  duckdb_append_varchar_length: { args: [F.ptr, F.ptr, F.u64], returns: F.i32 },
  duckdb_bind_varchar_length: { args: [F.ptr, F.u64, F.ptr, F.u64], returns: F.i32 },
  duckdb_bind_double: { args: [F.ptr, F.u64, F.f64], returns: F.i32 },
  duckdb_bind_boolean: { args: [F.ptr, F.u64, F.bool], returns: F.i32 },
  duckdb_bind_null: { args: [F.ptr, F.u64], returns: F.i32 },
  duckdb_execute_prepared: { args: [F.ptr, F.ptr], returns: F.i32 },
  duckdb_destroy_result: { args: [F.ptr], returns: F.void },
  duckdb_result_error: { args: [F.ptr], returns: F.ptr },
  duckdb_column_count: { args: [F.ptr], returns: F.u64 },
  duckdb_row_count: { args: [F.ptr], returns: F.u64 },
  duckdb_column_name: { args: [F.ptr, F.u64], returns: F.ptr },
  duckdb_column_type: { args: [F.ptr, F.u64], returns: F.i32 },
  duckdb_value_is_null: { args: [F.ptr, F.u64, F.u64], returns: F.bool },
  duckdb_value_varchar: { args: [F.ptr, F.u64, F.u64], returns: F.ptr },
  duckdb_free: { args: [F.ptr], returns: F.void },
};
const cstring = (text: string): Buffer => {
  if (text.includes('\0')) throw Error('NUL not permitted in a native identifier');
  return Buffer.from(text + '\0');
};
const pointer = (buffer: Buffer): number => Number(buffer.readBigUInt64LE());

/** Experimental 64-bit C ABI binding. No extension download or npm dependency. */
export class DuckStore {
  readonly path: string;
  readonly version: string;
  private readonly library: Library;
  private readonly database = Buffer.alloc(8);
  private readonly connection = Buffer.alloc(8);
  private closed = false;
  private depth = 0;
  private readonly statements = new Map<string, Buffer>();
  private readonly counts = { prepares: 0, hits: 0, evictions: 0 };
  get statementStats() { return { ...this.counts, cached: this.statements.size }; }
  private clearStatements(): void {
    for (const prepared of this.statements.values()) this.call('duckdb_destroy_prepare', prepared);
    this.statements.clear();
  }
  private lockLibrary: Library | undefined;
  private lockFd: number | undefined;
  private lockOwned = false;
  constructor(path: string) {
    if (!['arm64', 'x64'].includes(process.arch)) throw Error('Prototype requires the 64-bit DuckDB C ABI');
    if (!path.endsWith('.duckdb')) throw Error('Use a separate .duckdb file; SQLite stores are never migrated');
    mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.path = existsSync(path) ? realpathSync(path) : resolve(realpathSync(dirname(resolve(path))), path.split('/').at(-1)!);
    if (existsSync(this.path)) {
      const fd = openSync(this.path, 'r');
      try { const header = Buffer.alloc(16); readSync(fd, header, 0, 16, 0); if (header.toString().startsWith('SQLite format 3')) throw Error('SQLite input refused; no in-place conversion'); }
      finally { closeSync(fd); }
    }
    const library = process.env.SIS_DUCKDB_LIBRARY ?? (process.platform === 'darwin' ? '/opt/homebrew/opt/duckdb/lib/libduckdb.dylib' : 'libduckdb.so');
    this.library = ffi.dlopen(library, declarations);
    this.version = this.string(this.call('duckdb_library_version'));
    const config = Buffer.alloc(8);
    try {
      this.lockLibrary = ffi.dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', { flock: { args: [F.i32, F.i32], returns: F.i32 } });
      this.lockFd = openSync(this.path + '.prototype.lock', 'a', 0o600);
      if (this.lockLibrary.symbols.flock(this.lockFd, 2 | 4) !== 0) throw Error('Prototype database ownership lock is held; use its socket, not a second direct writer');
      this.lockOwned = true;
      if (!/^v2\.0\./u.test(this.version)) throw Error(`DuckDB 2.0 required; found ${this.version}`);
      if (this.call('duckdb_create_config', config) !== 0) throw Error('DuckDB configuration unavailable');
      for (const [name, value] of Object.entries({ threads: '2', memory_limit: '512MB', enable_external_access: 'false', autoinstall_known_extensions: 'false', autoload_known_extensions: 'false' })) {
        if (this.call('duckdb_set_config', pointer(config), cstring(name), cstring(value)) !== 0) throw Error(`DuckDB configuration rejected: ${name}`);
      }
      const error = Buffer.alloc(8);
      if (this.call('duckdb_open_ext', cstring(this.path), this.database, pointer(config), error) !== 0) {
        try { throw Error(this.string(pointer(error)) || 'DuckDB open failed'); }
        finally { if (pointer(error)) this.call('duckdb_free', pointer(error)); }
      }
      if (this.call('duckdb_connect', pointer(this.database), this.connection) !== 0) throw Error('DuckDB connect failed');
    } catch (error) {
      if (pointer(config)) { this.call('duckdb_destroy_config', config); config.fill(0); }
      this.close(); throw error;
    } finally { if (pointer(config)) this.call('duckdb_destroy_config', config); }
  }
  private call(name: string, ...args: Argument[]): Result { return this.library.symbols[name](...args); }
  private string(value: Result): string { return value ? new ffi.CString(Number(value)).toString() : ''; }
  private query(sql: string, params: Scalar[], collect: boolean): Row[] {
    if (this.closed) throw Error('DuckDB store closed');
    const jsonRows = collect && /^\s*(?:SELECT|WITH)\b/iu.test(sql);
    if (jsonRows) sql = `SELECT to_json(__sis_row) AS __sis_json FROM (${sql.replace(/;+\s*$/u, '')}) __sis_row`;
    if (/^\s*(?:CREATE|ALTER|DROP)\b/iu.test(sql)) this.clearStatements();
    const cached = this.statements.get(sql);
    const prepared = cached ?? Buffer.alloc(8);
    // duckdb_result: three idx_t fields followed by three pointers (stable C ABI).
    const result = Buffer.alloc(48);
    try {
      if (cached) {
        this.counts.hits++; this.statements.delete(sql); this.statements.set(sql, cached);
        if (this.call('duckdb_clear_bindings', pointer(prepared)) !== 0) throw Error('Cannot reset prepared bindings');
      } else {
        if (this.call('duckdb_prepare', pointer(this.connection), cstring(sql), prepared) !== 0) throw Error(this.string(this.call('duckdb_prepare_error', pointer(prepared))));
        this.counts.prepares++;
        if (this.statements.size >= 64) {
          const first = this.statements.keys().next().value!;
          this.call('duckdb_destroy_prepare', this.statements.get(first)!); this.statements.delete(first); this.counts.evictions++;
        }
        this.statements.set(sql, prepared);
      }
      params.forEach((value, i) => {
        let state: Result;
        if (value === null) state = this.call('duckdb_bind_null', pointer(prepared), i + 1);
        else if (typeof value === 'number') {
          if (!Number.isFinite(value)) throw Error('Nonfinite database parameter');
          state = this.call('duckdb_bind_double', pointer(prepared), i + 1, value);
        } else if (typeof value === 'boolean') state = this.call('duckdb_bind_boolean', pointer(prepared), i + 1, Number(value));
        else { const bytes = Buffer.from(value); state = this.call('duckdb_bind_varchar_length', pointer(prepared), i + 1, bytes.length ? bytes : Buffer.alloc(1), bytes.length); }
        if (state !== 0) throw Error(`DuckDB parameter ${i + 1} rejected`);
      });
      if (this.call('duckdb_execute_prepared', pointer(prepared), result) !== 0) throw Error(this.string(this.call('duckdb_result_error', result)));
      if (!collect) return [];
      if (jsonRows) {
        return Array.from({ length: Number(this.call('duckdb_row_count', result)) }, (_, row) => {
          const value = this.call('duckdb_value_varchar', result, 0, row);
          try {
            const json = this.string(value);
            // The JSON envelope preserves embedded NUL without unsafe by-value C structs.
            for (const token of json.matchAll(/"(?:\\.|[^"\\])*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/gu)) {
              if (token[1] && !/[.eE]/u.test(token[1]) && !Number.isSafeInteger(Number(token[1]))) throw Error('Database numeric result exceeds safe JavaScript range');
            }
            const data = JSON.parse(json) as Record<string, unknown>;
            return Object.fromEntries(Object.entries(data).map(([key, item]) => [key, item === null || ['string', 'number', 'boolean'].includes(typeof item) ? item as Scalar : JSON.stringify(item)]));
          } finally { if (value) this.call('duckdb_free', Number(value)); }
        });
      }
      const columns = Number(this.call('duckdb_column_count', result));
      const count = Number(this.call('duckdb_row_count', result));
      const names = Array.from({ length: columns }, (_, col) => this.string(this.call('duckdb_column_name', result, col)));
      const types = names.map((_, col) => Number(this.call('duckdb_column_type', result, col)));
      return Array.from({ length: count }, (_, row) => Object.fromEntries(names.map((name, col): [string, Scalar] => {
        if (this.call('duckdb_value_is_null', result, col, row)) return [name, null];
        const value = this.call('duckdb_value_varchar', result, col, row);
        try {
          const text = this.string(value), type = types[col];
          if (type === 1) return [name, text === 'true'];
          if (type >= 2 && type <= 11 || type === 16) {
            const n = Number(text);
            if (!Number.isFinite(n) || type !== 10 && type !== 11 && !Number.isSafeInteger(n)) throw Error('Database numeric result exceeds safe JavaScript range');
            return [name, n];
          }
          return [name, text];
        } finally { if (value) this.call('duckdb_free', Number(value)); }
      })));
    } catch (error) { this.statements.delete(sql); throw error; }
    finally {
      this.call('duckdb_destroy_result', result);
      if (!this.statements.has(sql) && pointer(prepared)) this.call('duckdb_destroy_prepare', prepared);
    }
  }
  appendRows(table: string, rows: Scalar[][]): void {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(table)) throw Error('Invalid appender table identifier');
    if (!rows.length) return;
    this.transaction(() => {
      const appender = Buffer.alloc(8); let failed = false;
      const check = (state: Result) => { if (state !== 0) throw Error(this.string(this.call('duckdb_appender_error', pointer(appender))) || 'DuckDB appender failed'); };
      try {
        check(this.call('duckdb_appender_create', pointer(this.connection), null, cstring(table), appender));
        const width = Number(this.call('duckdb_appender_column_count', pointer(appender)));
        for (const row of rows) {
          if (row.length !== width) throw Error('Appender row column count mismatch');
          for (const value of row) {
            if (value === null) check(this.call('duckdb_append_null', pointer(appender)));
            else if (typeof value === 'boolean') check(this.call('duckdb_append_bool', pointer(appender), Number(value)));
            else if (typeof value === 'number') {
              if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) throw Error('Unsafe appender number');
              check(Number.isInteger(value) ? this.call('duckdb_append_int64', pointer(appender), BigInt(value)) : this.call('duckdb_append_double', pointer(appender), value));
            } else { const bytes = Buffer.from(value); check(this.call('duckdb_append_varchar_length', pointer(appender), bytes.length ? bytes : Buffer.alloc(1), bytes.length)); }
          }
          check(this.call('duckdb_appender_end_row', pointer(appender)));
        }
        check(this.call('duckdb_appender_flush', pointer(appender)));
      } catch (error) { failed = true; throw error; }
      finally { const state = this.call('duckdb_appender_destroy', appender); if (!failed && state !== 0) throw Error('DuckDB appender finalization failed'); }
    });
  }
  all(sql: string, ...params: Scalar[]): Row[] { return this.query(sql, params, true); }
  get(sql: string, ...params: Scalar[]): Row | undefined { return this.all(sql, ...params)[0]; }
  run(sql: string, ...params: Scalar[]): void { this.query(sql, params, false); }
  transaction<T>(operation: () => T): T {
    if (this.depth) return operation();
    this.run('BEGIN TRANSACTION'); this.depth++;
    try {
      const result = operation();
      if (result && typeof (result as { then?: unknown }).then === 'function') throw Error('Transactions must be synchronous');
      this.run('COMMIT'); return result;
    } catch (error) { this.run('ROLLBACK'); throw error; }
    finally { this.depth--; }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearStatements();
    if (pointer(this.connection)) this.call('duckdb_disconnect', this.connection);
    if (pointer(this.database)) this.call('duckdb_close', this.database);
    this.library.close();
    if (this.lockFd !== undefined) {
      if (this.lockOwned) this.lockLibrary!.symbols.flock(this.lockFd, 8);
      closeSync(this.lockFd);
    }
    this.lockLibrary?.close();
  }
}
