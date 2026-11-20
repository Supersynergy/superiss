import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

export const VERSION = '1.6.2';
// Configure once before the first connection. Never replace or install a library.
// Only Bun can swap the SQLite library; under Node the bundled node:sqlite is used unless one was requested explicitly.
export const runtimeName = process.versions.bun ? 'bun' : 'node';
const configured = process.env.SIS_SQLITE_LIBRARY;
const candidate = configured ?? (runtimeName === 'bun' && process.platform === 'darwin' && existsSync('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib') ? '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib' : undefined);
if (candidate && candidate !== 'system' && runtimeName !== 'bun') throw Error('SIS_SQLITE_LIBRARY requires the Bun runtime');
if (candidate && candidate !== 'system') {
  if (!existsSync(candidate)) throw Error(`Configured SQLite library does not exist: ${candidate}`);
  const sqlite = createRequire(import.meta.url)('bun:sqlite') as { Database: { setCustomSQLite(path: string): void } };
  sqlite.Database.setCustomSQLite(candidate);
}
export const sqliteLibrary = candidate ?? 'system';
