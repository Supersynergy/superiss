import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

export const VERSION = '1.0.0';
// Configure once before the first connection. Never replace or install a library.
const configured = process.env.SIS_SQLITE_LIBRARY;
const candidate = configured ?? (process.platform === 'darwin' && existsSync('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib') ? '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib' : undefined);
if (candidate && candidate !== 'system') {
  if (!existsSync(candidate)) throw Error(`Configured SQLite library does not exist: ${candidate}`);
  const sqlite = createRequire(import.meta.url)('bun:sqlite') as { Database: { setCustomSQLite(path: string): void } };
  sqlite.Database.setCustomSQLite(candidate);
}
export const sqliteLibrary = candidate ?? 'system';
