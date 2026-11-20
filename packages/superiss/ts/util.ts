import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { accessSync, constants, existsSync, fstatSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type Value = null | boolean | number | string | Value[] | Obj;
export interface Obj { [key: string]: Value | undefined }
export class SisError extends Error { constructor(readonly code: string, message: string) { super(message); } }
export function fail(code: string, message: string): never { throw new SisError(code, message); }
export const object = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
export const array = (value: unknown): Value[] => Array.isArray(value) ? value as Value[] : [];
export const text = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
export function required(a: Obj, key: string): string { const v = a[key]; return typeof v === 'string' && v.trim() ? v : fail('bad_args', `${key} required`); }
export function number(value: unknown, name: string, fallback?: number, low = -Infinity, high = Infinity): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) fail('bad_args', `${name} must be finite and within ${low}..${high}`);
  return value;
}
export function integer(value: unknown, name: string, fallback?: number, low = 0, high = Number.MAX_SAFE_INTEGER): number { const n = number(value, name, fallback, low, high); return Number.isSafeInteger(n) ? n : fail('bad_args', `${name} must be an integer`); }
export const now = (): number => Date.now() / 1000;
export const uid = (prefix = 'sis-'): string => prefix + randomBytes(12).toString('hex');
export function canonical(value: unknown): string {
  const encode = (item: unknown): string | undefined => {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return '[' + Array.from(item, value => encode(value) ?? 'null').join(',') + ']';
    const entries = Object.entries(item).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const fields: string[] = [];
    for (const [key, value] of entries) {
      const encoded = encode(value);
      if (encoded !== undefined) fields.push(JSON.stringify(key) + ':' + encoded);
    }
    return '{' + fields.join(',') + '}';
  };
  return encode(value) ?? 'null';
}
export const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export function decode(value: unknown, fallback: Value = null): Value { if (typeof value !== 'string') return fallback; try { return JSON.parse(value) as Value; } catch { return fallback; } }
export function redact(value: Value): Value { if (Array.isArray(value)) return value.map(redact); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'admin_token').map(([k,v]) => [k, v === undefined ? null : redact(v)])); return value; }
export function admin(a: Obj): void {
  const expected = process.env.SIS_ADMIN_TOKEN;
  const supplied = text(a.admin_token);
  if (!expected || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) fail('admin_required', 'SIS_ADMIN_TOKEN and matching admin_token required');
}
export function actor(a: Obj): string { const s = required(a, 'actor'); return [...s].length <= 128 ? s : fail('bad_args', 'actor exceeds 128 characters'); }
export const ttl = (a: Obj): number => number(a.ttl, 'ttl', 1800, 1, 86400);
export function paths(value: unknown): string[] {
  if (value == null || value === '') return [];
  if (typeof value === 'string') return value.trimStart().startsWith('[') ? paths(decode(value)) : [value];
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) fail('bad_args', 'allowed_paths must contain strings');
  return value as string[];
}
export const childWhere = (alias = 'i'): string => `(json_extract(${alias}.meta_json,'$.parent')=? OR (${alias}.id LIKE ?||'.%' AND instr(substr(${alias}.id,length(?)+2),'.')=0))`;
export const rootDirectory = fileURLToPath(new URL('..', import.meta.url));

export function fingerprint(task: Obj, cwd: string, db: string): { source_hash: string; legacy_source_hash: string; cwd: string } {
  const scopes = paths(task.allowed_paths);
  if (!scopes.length) fail('missing_scope', 'allowed_paths must explicitly contain files/directories');
  const realcwd = realpathSync(cwd);
  if (!statSync(realcwd).isDirectory()) fail('bad_args', 'cwd must be a directory');
  const files = new Map<string, string>(), seen = new Set<string>();
  let size = 0;
  const ignored = new Set(['.git','.sis','.cache','.venv','__pycache__','target']);
  const dbpath = existsSync(db) ? realpathSync(db) : resolve(db);
  const contained = (base: string, path: string) => path === base || path.startsWith(base + sep);
  const walk = (path: string, boundary: string): void => {
    if (ignored.has(basename(path))) return;
    const resolved = realpathSync(path);
    if (!contained(boundary, resolved)) fail('scope_escape', `symlink escapes scope: ${path}`);
    if ([dbpath, dbpath + '-wal', dbpath + '-shm'].includes(resolved)) return;
    const st = statSync(resolved);
    if (st.isDirectory()) {
      if (lstatSync(path).isSymbolicLink()) fail('invalid_scope', 'directory symlinks are not fingerprinted');
      if (seen.has(resolved)) return;
      seen.add(resolved);
      for (const name of readdirSync(path).sort()) walk(join(path, name), boundary);
    } else if (st.isFile()) {
      const relativePath = relative(realcwd, path);
      const key = (relativePath === '..' || relativePath.startsWith('..' + sep) || isAbsolute(relativePath) ? path : relativePath).split(sep).join('/');
      if (files.has(key)) return;
      if (size + st.size > 32 * 1024 * 1024 || files.size >= 10000) fail('scope_too_large', 'scope exceeds 32 MiB or 10000 files');
      const data = readFileSync(resolved);
      size += data.length;
      if (size > 32 * 1024 * 1024) fail('scope_too_large', 'scope exceeds 32 MiB');
      files.set(key, digest(data));
    } else fail('bad_args', 'scope contains nonregular file');
  };
  for (const scope of scopes) {
    if (scope.split(/[\\/]/u).includes('..')) fail('scope_escape', 'parent traversal forbidden');
    const full = isAbsolute(scope) ? scope : join(realcwd, scope);
    if (!existsSync(full)) fail('bad_args', `scope path does not exist: ${scope}`);
    const resolved = realpathSync(full);
    if (!contained(realcwd, resolved) && !contained(resolved, realcwd)) fail('scope_escape', 'scope outside cwd');
    walk(full, statSync(resolved).isDirectory() ? resolved : realpathSync(dirname(full)));
  }
  const entries = [...files.entries()];
  const legacy = Object.fromEntries(entries.sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0));
  return { source_hash: digest(canonical(Object.fromEntries(files))), legacy_source_hash: digest(JSON.stringify(legacy)), cwd: realcwd };
}
export function git(cwd: string, ...args: string[]): string | null {
  const child = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  return child.status === 0 ? child.stdout : null;
}
// Task times are epoch seconds. Text is interpreted only by SQLite (see Engine.timeOf), so JS and SQL decisions are identical:
// ISO-prefixed text that strftime accepts is UTC, anything else reads as never due (9e18).
export const NEVER = 9e18;
export const sqlTime = (column: string): string => `(CASE WHEN ${column} IS NULL OR ${column}='' THEN NULL WHEN typeof(${column}) IN ('integer','real') THEN ${column} WHEN trim(${column}) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN COALESCE(CAST(strftime('%s',trim(${column})) AS REAL),9e18) ELSE 9e18 END)`;
export const relativeTime = (v: string): number | null => { const m = /^\+(\d+(?:\.\d+)?)([smhdw])$/u.exec(v.trim()); return m ? Number(m[1]) * ({s:1,m:60,h:3600,d:86400,w:604800} as Record<string,number>)[m[2]] : null; };
// Linux local-zero uses bubblewrap when present and user namespaces actually work; otherwise it fails closed.
let linuxSandbox: string | null | undefined;
function bubblewrap(): string | null {
  if (linuxSandbox !== undefined) return linuxSandbox;
  linuxSandbox = null;
  const configured = process.env.SIS_BWRAP;
  for (const candidate of configured ? [configured] : ['/usr/bin/bwrap','/usr/local/bin/bwrap']) {
    try { accessSync(candidate,constants.X_OK); } catch { continue; }
    const probe = spawnSync(candidate,['--die-with-parent','--unshare-all','--ro-bind','/','/','--proc','/proc','--dev','/dev','/bin/true'],{timeout:5000,stdio:'ignore'});
    if (probe.status === 0) { linuxSandbox = candidate; break; }
  }
  return linuxSandbox;
}
export function localZeroAvailable(): boolean {
  if (process.platform === 'linux') return bubblewrap() !== null;
  try { if (process.platform !== 'darwin') return false; accessSync('/usr/bin/sandbox-exec',constants.X_OK); return true; } catch { return false; }
}
export const localZeroRequirement = 'local_zero requires macOS sandbox-exec or Linux bubblewrap with working user namespaces';
// Oldest daemon a newer client may talk to. Same major, same protocol, and the daemon must advertise the operation.
export const COMPAT_FLOOR = '1.5.0';
export const opAliases: Record<string,string> = { why:'admit', q:'create', query:'list', next:'ready', goal_create:'goal', subgoal:'sub', tree:'goal_tree', merge_slot:'slot_acquire', tag:'label', comment:'note', find_duplicates:'dup_scan' };
function semver(value: unknown): number[] | null { const m = /^(\d+)\.(\d+)\.(\d+)/u.exec(typeof value === 'string' ? value : ''); return m ? m.slice(1).map(Number) : null; }
export function runtimeCompatible(caps: Obj, version: string, cmd?: string, aliases: Record<string,string> = opAliases): boolean {
  if (caps.version === version) return true;
  const daemon = semver(caps.version), own = semver(version), floor = semver(COMPAT_FLOOR)!;
  if (!daemon || !own || daemon[0] !== own[0] || !Array.isArray(caps.operations)) return false;
  for (let i = 0; i < 3; i++) { if (daemon[i] > floor[i]) break; if (daemon[i] < floor[i]) return false; }
  if (cmd === undefined) return true;
  const name = cmd.replaceAll('-','_'), ops = caps.operations as Value[];
  return ops.includes(name) || ops.includes(aliases[name] ?? name);
}
function controllerLock(): number | undefined {
  const value=process.env.SIS_CONTROLLER_LOCK_FD;if(value===undefined)return;
  if(!/^\d+$/u.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<3||Number(value)>2147483647)fail('bad_args','SIS_CONTROLLER_LOCK_FD must reference an open regular lock file');
  const fd=Number(value);
  try {
    if(!fstatSync(fd).isFile())fail('bad_args','controller lock must reference a regular file');
    if(!process.versions.bun)fail('unsupported_runtime','SIS_CONTROLLER_LOCK_FD requires the Bun runtime');
    const ffi=createRequire(import.meta.url)('bun:ffi') as {FFIType:{i32:number};dlopen:(path:string,symbols:Record<string,{args:number[];returns:number}>)=>{symbols:{flock:(fd:number,op:number)=>number};close:()=>void}};
    const library=ffi.dlopen(process.platform==='darwin'?'/usr/lib/libSystem.B.dylib':'libc.so.6',{flock:{args:[ffi.FFIType.i32,ffi.FFIType.i32],returns:ffi.FFIType.i32}});
    try{if(library.symbols.flock(fd,2|4)!==0)fail('bad_args','controller lock is held by another process');}finally{library.close();}
    return fd;
  }catch(error){if(error instanceof SisError)throw error;return fail('bad_args','controller lock unavailable or invalid');}
}
export interface Execution { exit_code: number | null; timed_out: boolean; output: string; execution?: Obj }
export function execute(command: string, cwd: string, seconds: number, localZero = false): Promise<Execution> {
  let env = { ...process.env };
  const fd=controllerLock();
  for (const key of ['SIS_ADMIN_TOKEN','SIS_SOCK','SIS_DIRECT','SIS_DB','SIS_CWD_DB','SIS_CONTROLLER_LOCK_FD','SIS_SERVICE_LOCK_FD']) delete env[key];
  const windows=process.platform==='win32';
  // Windows runs oracles through cmd.exe; everything else through POSIX sh.
  let binary=windows?(process.env.ComSpec||'cmd.exe'):'/bin/sh',args=windows?['/d','/s','/c',command]:['-c',command];
  const execution:Obj={mode:'local_zero',sandbox:process.platform==='linux'?'linux-bubblewrap':'macos-seatbelt',network:'denied',ipc:'denied',writes:'cwd',credential_environment:'cleared'};
  if(localZero&&process.platform==='linux'){
    const bwrap=bubblewrap();if(!bwrap)fail('local_zero_unavailable',localZeroRequirement);
    const real=realpathSync(cwd);
    // Order matters: hide home, runtime sockets and temp first, then bind only the task directory writable.
    binary=bwrap;args=['--die-with-parent','--new-session','--unshare-all','--ro-bind','/','/','--proc','/proc','--dev','/dev',...['/home','/root','/run','/tmp','/var/tmp','/var/run','/srv','/mnt','/media','/var/lib','/var/log','/var/mail','/var/spool','/var/backups'].flatMap(p=>{try{return lstatSync(p).isDirectory()?['--tmpfs',p]:[];}catch{return [];}}),'--bind',real,real,'--chdir',real,'--clearenv','--setenv','PATH','/usr/bin:/bin:/usr/sbin:/sbin','--setenv','HOME',real,'--setenv','TMPDIR',real,'--setenv','LANG','C','--setenv','LC_ALL','C','/bin/sh','-c',command];
    env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin'};
  } else if(localZero){
    if(!localZeroAvailable())fail('local_zero_unavailable',localZeroRequirement);
    const quoted=JSON.stringify(realpathSync(cwd));
    const profile='(version 1) (deny default) (allow process-fork process-exec sysctl-read file-read*) (deny syscall-unix (syscall-number 147)) (deny syscall-unix (syscall-number 82)) (deny syscall-unix (syscall-number 244)) (allow file-write* (subpath '+quoted+')) (deny file-read* (require-all (require-any (subpath "/Users") (subpath "/private/var/root")) (require-not (subpath '+quoted+'))))';
    binary='/usr/bin/sandbox-exec';args=['-p',profile,'/bin/sh','-c',command];env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:cwd,TMPDIR:cwd,LANG:'C',LC_ALL:'C'};
  }
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, { cwd, env, detached: !windows, windowsVerbatimArguments: windows, windowsHide: true, stdio: fd===undefined?['ignore','pipe','pipe']:['ignore','pipe','pipe',fd] });
    const chunks: Buffer[] = [];
    let bytes = 0, timed = false;
    for (const stream of [child.stdout!, child.stderr!]) stream.on('data', (data: Buffer) => { const keep = data.subarray(0, Math.max(0, 65536 - bytes)); if (keep.length) { chunks.push(keep); bytes += keep.length; } });
    const kill = () => { if (!child.pid) return; if (windows) { spawnSync('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true}); return; } try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (object(e).code !== 'ESRCH') child.kill('SIGKILL'); } };
    const timeout = setTimeout(() => { timed = true; kill(); }, seconds * 1000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => kill());
    child.once('close', code => {
      clearTimeout(timeout);
      let output = Buffer.concat(chunks).toString('utf8');
      const secret = process.env.SIS_ADMIN_TOKEN;
      if (secret) output = output.split(secret).join('[redacted]');
      resolveResult({ exit_code: code, timed_out: timed, output,...(localZero?{execution}:{}) });
    });
  });
}

const caches = new Map<string, Map<string, number>>();
export function encoding(a: Obj): string {
  if (a.encoding !== undefined) return ['o200k_base','cl100k_base'].includes(text(a.encoding)) ? text(a.encoding) : fail('unknown_tokenizer','unknown encoding');
  if (a.model === undefined) return 'o200k_base';
  const model = text(a.model);
  if (/^(gpt-4o|gpt-4\.1|gpt-5|o1|o3|o4)/u.test(model)) return 'o200k_base';
  if (/^(gpt-4($|-)|gpt-3\.5-turbo|text-embedding-3-|text-embedding-ada-002$)/u.test(model)) return 'cl100k_base';
  return fail('unknown_tokenizer','unknown model; supply encoding');
}
export function tokenCount(input: string, enc: string): number {
  if (Buffer.byteLength(input) > 1024 * 1024) fail('bad_args','text exceeds 1 MiB');
  let ranks = caches.get(enc);
  if (!ranks) {
    const file = join(rootDirectory, 'ts', 'data', enc + '.tiktoken');
    if (!existsSync(file)) fail('tokenizer_unavailable', 'bundled tokenizer vocabulary missing');
    ranks = new Map(readFileSync(file, 'utf8').trimEnd().split('\n').map(line => { const [word, rank] = line.split(' '); return [word, Number(rank)]; }));
    caches.set(enc, ranks);
  }
  const contraction = "'(?:[sStTdDmM]|[rR][eE]|[vV][eE]|[lL][lL])";
  const pattern = enc === 'cl100k_base' ? `${contraction}|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s+$|\\s*[\\r\\n]|\\s+(?!\\S)|\\s` : `[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]*[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]+(?:${contraction})?|[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]+[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]*(?:${contraction})?|\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n/]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+`;
  let count = 0;
  const words = new Map<string, number>();
  for (const match of input.matchAll(new RegExp(pattern, 'gu'))) {
    const piece = match[0];
    const cached = words.get(piece);
    if (cached !== undefined) { count += cached; continue; }
    const bytes = Buffer.from(piece);
    if (ranks.has(bytes.toString('base64'))) { count++; words.set(piece, 1); continue; }
    const starts = Array.from({length: bytes.length}, (_, i) => i);
    const ends = starts.map(i => i + 1), next = starts.map(i => i + 1 < bytes.length ? i + 1 : -1), prev = starts.map(i => i - 1), versions = starts.map(() => 0);
    type Entry = [number, number, number, number, number];
    const heap: Entry[] = [];
    const less = (a: Entry,b: Entry) => a[0] < b[0] || a[0] === b[0] && a[1] < b[1];
    const push = (left: number) => {
      if (left < 0 || next[left] < 0) return;
      const right = next[left], rank = ranks!.get(bytes.subarray(starts[left], ends[right]).toString('base64'));
      if (rank === undefined) return;
      const item: Entry = [rank, left, right, versions[left], versions[right]];
      let index = heap.length;
      heap.push(item);
      while (index > 0) { const p = (index - 1) >> 1; if (!less(item, heap[p])) break; heap[index] = heap[p]; index = p; } heap[index] = item;
    };
    const pop = (): Entry => {
      const top = heap[0], last = heap.pop()!;
      if (heap.length) { let i = 0; while (2*i+1 < heap.length) { let ch = 2*i+1; if (ch+1 < heap.length && less(heap[ch+1],heap[ch])) ch++; if (!less(heap[ch],last)) break; heap[i]=heap[ch]; i=ch; } heap[i]=last; }
      return top;
    };
    for (let i = 0; i < bytes.length - 1; i++) push(i);
    let n = bytes.length;
    while (heap.length) {
      const [,left,right,lv,rv] = pop();
      if (versions[left] !== lv || versions[right] !== rv || next[left] !== right) continue;
      ends[left] = ends[right]; next[left] = next[right]; versions[left]++; versions[right]++; next[right] = -1;
      if (next[left] >= 0) prev[next[left]] = left;
      n--; push(prev[left]); push(left);
    }
    words.set(piece,n); count += n;
  }
  return count;
}
