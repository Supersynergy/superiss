import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, lstatSync, readFileSync, readdirSync, openSync, writeFileSync, fsyncSync, closeSync, unlinkSync, rmdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './process.ts';

export interface MergeOwner { task: string; actor: string; epoch: number; db: string }
export class MergeLockConflict extends Error {
  readonly code = 'merge_locked';
  constructor(readonly lock_path: string) { super(`Repository/base merge lock already exists; reconcile owner before retry: ${lock_path}`); }
}
function directory(repo: string, create = false): string {
  const common = git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (!common) throw Error('Cannot establish Git common directory for merge locking');
  let path = realpathSync(common);
  for (const name of ['superiss', 'merge-locks']) {
    path = join(path, name);
    if (create) { try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
    try { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Merge lock directory is not an owned regular directory'); }
    catch (error) { if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
  }
  return path;
}
export function acquireMergeLock(repo: string, target: string, owner: MergeOwner): { path: string; release(): boolean } {
  const token = randomBytes(24).toString('hex'), contents = JSON.stringify({ ...owner, target, token, created_at: Date.now() / 1000 });
  if (Buffer.byteLength(contents) > 8192) throw Error('Merge owner metadata exceeds 8 KiB');
  const parent = directory(repo, true);
  const path = join(parent, createHash('sha256').update(target).digest('hex') + '.lock');
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new MergeLockConflict(path); throw error; }
  const identity = lstatSync(path), marker = join(path, 'owner.json');
  const fd = openSync(marker, 'wx', 0o600);
  try { writeFileSync(fd, contents); fsyncSync(fd); }
  finally { closeSync(fd); }
  return { path, release() {
    try {
      const current = lstatSync(path), file = lstatSync(marker);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || !file.isFile() || file.isSymbolicLink()) return false;
      const names = readdirSync(path);
      if (names.length !== 1 || names[0] !== 'owner.json' || file.size > 8192 || JSON.parse(readFileSync(marker, 'utf8')).token !== token) return false;
      unlinkSync(marker); rmdirSync(path); return true;
    } catch { return false; }
  } };
}
/** Read only. No PID/lease-based reclamation and no ownership transfer. */
export function previewMergeLocks(repo: string): { path: string; owner: unknown; malformed?: true; error?: string }[] {
  let parent: string;
  try { parent = directory(repo); }
  catch (error) { return [{ path: repo, owner: null, malformed: true, error: (error as Error).message }]; }
  let names: string[];
  try { names = readdirSync(parent); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (names.length > 1000) throw Error('Merge lock preview exceeds 1000 entries; inspect the Git common directory');
  return names.filter(name => /^[a-f0-9]{64}\.lock$/.test(name)).map(name => {
    const path = join(parent, name), marker = join(path, 'owner.json');
    try {
      const dir = lstatSync(path), file = lstatSync(marker);
      if (!dir.isDirectory() || dir.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() || file.size > 8192) throw Error('Invalid merge lock');
      const value: unknown = JSON.parse(readFileSync(marker, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid owner');
      const { token: _token, ...owner } = value as Record<string, unknown>;
      return { path, owner };
    } catch { return { path, owner: null, malformed: true as const }; }
  });
}
