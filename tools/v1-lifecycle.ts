import { VERSION } from '../packages/superiss/runtime.ts';
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, realpathSync, renameSync, unlinkSync, mkdirSync, rmdirSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';

interface Identity { pid: number; project_id: string; instance_id: string }
const [launcher, command, ...args] = process.argv.slice(2);
const expectedVersion = VERSION;
function fail(message: string): never { throw Error(message); }
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function code(error: unknown): unknown { return record(error).code; }
function pause(): Promise<void> { return new Promise(resolve => setTimeout(resolve, 30)); }
let database = process.env.SIS_DB, explicitSock: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--db') database = args[++i];
  else if (args[i] === '--sock') explicitSock = args[++i];
  else fail('Lifecycle accepts only --db and --sock; use serve for other options.');
}
if (!launcher || !['up', 'down', 'status'].includes(command ?? '') || !database) fail('Usage: sis up|down|status --db PATH [--sock PATH]');
const absolute = resolve(database);
const db = existsSync(absolute) ? realpathSync(absolute) : join(realpathSync(dirname(absolute)), basename(absolute));
const sock = explicitSock ?? process.env.SIS_SOCK ?? '/tmp/sis-' + createHash('sha256').update(db).digest('hex').slice(0, 20) + '.sock';
const ownerPath = db + '.serve.owner.json';
async function context(): Promise<Identity> {
  return await new Promise((resolveReply, reject) => {
    const client = createConnection(sock); let body = '';
    const stop = (error: Error) => { client.destroy(); reject(error); };
    client.setEncoding('utf8'); client.setTimeout(1000, () => stop(Error('Daemon identity timeout')));
    client.on('error', stop); client.once('end', () => stop(Error('Daemon closed before identity response')));
    client.once('connect', () => client.write('{"cmd":"context","args":{}}\n'));
    client.on('data', part => {
      body += part;
      if (Buffer.byteLength(body) > 65536) return stop(Error('Oversized daemon identity'));
      if (!body.includes('\n')) return;
      try {
        const reply = record(JSON.parse(body.split('\n')[0]!)), value = record(reply.data), caps = record(value.capabilities);
        if (reply.ok !== true || typeof value.db_path !== 'string' || realpathSync(value.db_path) !== db || typeof value.project_id !== 'string' || !value.project_id || typeof value.instance_id !== 'string' || !value.instance_id || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 1 || caps.protocol !== 2 || caps.proof_receipts !== true) fail('Database/socket identity mismatch; daemon preserved.');
        if (caps.version !== expectedVersion) fail('runtime_version_mismatch: Expected Superiss ' + expectedVersion + '; daemon preserved.');
        client.destroy(); resolveReply({ pid: value.pid, project_id: value.project_id, instance_id: value.instance_id });
      } catch (error) { stop(error instanceof Error ? error : Error(String(error))); }
    });
  });
}
async function existing(): Promise<Identity | null> { try { return await context(); } catch (error) { if (['ENOENT', 'ECONNREFUSED'].includes(String(code(error)))) return null; throw error; } }
async function main(): Promise<void> {
  const live = await existing();
  if (command === 'status') { console.log(JSON.stringify({ up: !!live, version: expectedVersion, db, sock, ...live })); return; }
  if (command === 'down') {
    if (!live) { console.log(JSON.stringify({ down: false, reason: 'not_running' })); return; }
    if (!existsSync(ownerPath)) fail('Daemon has no owner receipt from this launcher; process preserved.');
    const owner = record(JSON.parse(readFileSync(ownerPath, 'utf8')));
    if (owner.version !== expectedVersion || owner.pid !== live.pid || owner.instance_id !== live.instance_id || owner.project_id !== live.project_id || owner.db !== db || owner.sock !== sock) fail('Daemon ownership changed; process preserved.');
    process.kill(live.pid, 'SIGTERM');
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      let alive = true;
      try { process.kill(live.pid, 0); } catch (error) { if (code(error) === 'ESRCH') alive = false; else throw error; }
      if (!alive) {
        const saved = record(JSON.parse(readFileSync(ownerPath, 'utf8')));
        if (saved.instance_id === live.instance_id) unlinkSync(ownerPath);
        console.log(JSON.stringify({ down: true, pid: live.pid })); return;
      }
      await pause();
    }
    fail('Owned daemon did not stop in 3s; no escalation performed.');
  }
  if (live) { console.log(JSON.stringify({ up: true, already: true, version: expectedVersion, ...live })); return; }
  if (existsSync(ownerPath)) fail('Stale owner receipt preserved; reconcile before startup.');
  const fd = openSync(db + '.serve.log', 'a', 0o600);
  const child = spawn(resolve(launcher!), ['serve', '--db', db, '--sock', sock], { detached: true, stdio: ['ignore', fd, fd], env: process.env });
  closeSync(fd);
  let spawnError: Error | undefined; child.once('error', error => { spawnError = error; }); child.unref();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    const running = await existing();
    if (running) {
      if (running.pid !== child.pid) fail('Another daemon won startup; owner receipt preserved.');
      const temporary = ownerPath + '.' + process.pid + '.tmp';
      writeFileSync(temporary, JSON.stringify({ version: expectedVersion, db, sock, ...running }), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, ownerPath);
      console.log(JSON.stringify({ up: true, version: expectedVersion, db, sock, ...running })); return;
    }
    if (child.exitCode !== null) fail('Daemon startup failed; inspect ' + db + '.serve.log');
    await pause();
  }
  fail('Startup outcome unknown; reconcile the log and socket before retry.');
}
async function execute(): Promise<void> {
  if (command === 'status') return await main();
  const lock = db + '.lifecycle.lock';
  try { mkdirSync(lock, { mode: 0o700 }); } catch (error) { if (code(error) === 'EEXIST') fail('Lifecycle busy; foreign lock preserved.'); throw error; }
  try { writeFileSync(join(lock, 'pid'), String(process.pid), { mode: 0o600, flag: 'wx' }); await main(); }
  finally { unlinkSync(join(lock, 'pid')); rmdirSync(lock); }
}
await execute().catch(error => { console.error(JSON.stringify({ error: { code: 'lifecycle', msg: error instanceof Error ? error.message : String(error) } })); process.exitCode = 1; });
