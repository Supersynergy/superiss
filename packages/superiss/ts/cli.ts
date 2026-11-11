#!/usr/bin/env bun
import { createConnection, createServer, type Socket } from 'node:net';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { Engine, registry, type Context } from '../engine.ts';
import { VERSION } from '../runtime.ts';
import { copySqlite } from '../bridge.ts';
import { array, canonical, decode, digest, fail, git, object, required, SisError, text, uid, type Obj, type Value } from './util.ts';
import { startHttp } from './http.ts';
import { collectChanges } from './git.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { SuperissSocketClient } from './socket-client.ts';
import { runSession, writeSessionFrame } from './session.ts';

interface Options { cmd: string; payload: string[]; db?: string; sock?: string; actor?: string; idem?: string; run_id?: string; headers: boolean; tools: string[] }
function options(): Options {
  const result: Options={cmd:'serve',payload:[],headers:false,tools:[]}; let selected=false;
  const args=process.argv.slice(2), flags: Record<string,'db'|'sock'|'actor'|'idem'|'run_id'>={'--db':'db','--sock':'sock','--actor':'actor','--idem':'idem','--run-id':'run_id'};
  for (let i=0;i<args.length;i++) {
    const part=args[i];
    if (flags[part]) { if (!args[i+1]) fail('bad_args',part+' requires value'); result[flags[part]]=args[++i]; }
    else if (part==='--tool') { if (!args[i+1]) fail('bad_args','--tool requires value'); result.tools.push(args[++i]); }
    else if (part==='--mcp-headers') result.headers=true;
    else if (part==='--json') continue;
    else if (part==='--http') { if (!args[i+1]) fail('bad_args','--http requires port'); process.env.SIS_HTTP=args[++i]; }
    else if (part.startsWith('--http=')) process.env.SIS_HTTP=part.slice(7);
    else if (part==='--version') { console.log(VERSION); process.exit(0); }
    else if (part==='--help' || part==='-h') { console.log('sis <operation> [JSON | key=value ...] --db PATH [--actor NAME] [--idem KEY]\nsis serve --db PATH --sock PATH\nsis rpc --db PATH [--sock PATH] (bounded NDJSON session)\nsis mcp --db PATH [--tool NAME] [--mcp-headers]\nTypeScript 7.1 / Bun; Rust and Python are explicit reference runtimes.'); process.exit(0); }
    else if (!selected) { result.cmd=part; selected=true; }
    else result.payload.push(part);
  }
  return result;
}
function dbPath(opt: Options): string {
  if (!opt.db && !process.env.SIS_DB && process.env.SIS_CWD_DB !== '1') fail('explicit_db_required','v1 requires --db PATH, SIS_DB, or explicit SIS_CWD_DB=1');
  if (opt.db || process.env.SIS_DB) return resolve(opt.db || required({path:process.env.SIS_DB},'path'));
  if (process.env.SIS_CWD_DB==='1') return resolve('sis.db');
  let dir=process.cwd();
  while (true) {
    const folder=join(dir,'.sis');
    if (existsSync(folder)) {
      const candidates=readdirSync(folder).filter(name=>name.endsWith('.db') && statSync(join(folder,name)).isFile());
      if (candidates.length>1) fail('ambiguous_project','multiple project databases; use --db');
      if (candidates.length===1) return join(folder,candidates[0]);
    }
    const parent=dirname(dir); if (parent===dir) break; dir=parent;
  }
  fail('project_not_found','bind an existing project database with --db; SIS_CWD_DB=1 explicitly allows local sis.db');
}
function payload(opt: Options): Value {
  if (!opt.payload.length) return {};
  if (opt.payload.length===1) {
    const value=opt.payload[0];
    if (value.startsWith('@')) return JSON.parse(readFileSync(value.slice(1),'utf8')) as Value;
    if (value.startsWith('{') || value.startsWith('[')) return JSON.parse(value) as Value;
  }
  const shortcuts: Record<string,string[]>={acquire:['actor'],tokens:['text'],verify:['id','actor','epoch','cwd'],checkpoint:['id','actor','epoch','text','next_step'],handoff:['id','actor','epoch','text','next_step'],claim:['id','actor','epoch'],heartbeat:['id','actor','epoch'],close_check:['id','actor','epoch'],close:['id','actor','epoch'],unclaim:['id','actor','epoch'],claim_next:['actor'],dep:['issue','depends_on'],dep_remove:['issue','depends_on'],rename:['from','to'],gate:['name','state'],slot_acquire:['name','actor'],slot_release:['name','actor','epoch'],q:['title'],create:['title'],goal:['name','objective'],sub:['parent','title'],plan:['name'],next:['goal'],note:['id','text'],defer:['id','until'],label:['id','add'],recall:['key'],search:['q'],import:['path'],sync_import:['path'],attest:['id','actor','epoch','kind','path'],cost_add:['issue'],learn:['group_by','since'],outbox_export:['format'],remember:['key','value'],budget_claim:['issue','eur'],outbox_done:['id','err'],outbox_fail:['id','err'],ready:['lane']};
  const result: Obj={}, positionals: string[]=[]; let noFlags=false;
  const parse=(value: string): Value=>{try{return JSON.parse(value) as Value;}catch{return value;}};
  for (let i=0;i<opt.payload.length;i++) {
    const part=opt.payload[i]; if (part==='--') {noFlags=true;continue;}
    if (!noFlags && part.startsWith('--')) { const body=part.slice(2), split=body.indexOf('='), key=(split<0 ? body : body.slice(0,split)).replaceAll('-','_'); if (split>=0) result[key]=parse(body.slice(split+1)); else if (opt.payload[i+1] && !opt.payload[i+1].startsWith('--')) result[key]=parse(opt.payload[++i]); else result[key]=true; }
    else { const split=part.indexOf('='); if (split>0) result[part.slice(0,split)]=parse(part.slice(split+1)); else positionals.push(part); }
  }
  const keys=shortcuts[opt.cmd.replaceAll('-','_')] ?? ['id','actor']; positionals.forEach((value,i)=>{if (keys[i] && result[keys[i]]===undefined) result[keys[i]]=parse(value);});
  return result;
}
function context(opt: Options): Partial<Context> { return {actor:opt.actor ?? 'cli',explicit:opt.actor!==undefined,idem:opt.idem ?? null,run_id:opt.run_id ?? null}; }
function responseError(error: unknown,id: Value=null): Obj { const message=error instanceof Error ? error.message : String(error); return {id,ok:false,error:{code:error instanceof SisError ? error.code : 'internal',msg:message.slice(0,2000)}}; }
async function request(engine: Engine,input: unknown): Promise<Obj> {
  const req=object(input), id=req.id ?? null;
  if (typeof req.cmd!=='string') return responseError(new SisError('bad_request','cmd string required'),id);
  try { return {id,ok:true,data:await engine.dispatch(req.cmd,req.args ?? {},{actor:text(req.actor,'socket'),explicit:typeof req.actor==='string',idem:typeof req.idem==='string' ? req.idem : null,run_id:typeof req.run_id==='string' ? req.run_id : null})}; }
  catch (error) { return responseError(error,id); }
}
function write(socket: Socket,value: Obj): void { if (!socket.destroyed) socket.write(canonical(value)+'\n'); }
function requestTimeout(req: Obj): number {
  const args = object(req.args);
  let seconds = 0;
  if (req.cmd === 'verify' || req.cmd === 'attest' && args.kind === 'run') seconds = typeof args.timeout_secs === 'number' ? args.timeout_secs : 10;
  else if (req.cmd === 'watch') seconds = typeof args.wait === 'number' ? args.wait : 0;
  else if (req.cmd === 'search_index' && args.action === 'build') seconds = 135;
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  return Math.min(305000, Math.max(15000, (seconds + 5) * 1000));
}
async function socketCall(path: string, db: string, req: Obj, onFrame?: (frame: Obj) => void): Promise<Obj> {
  return new Promise((resolveResult,reject) => {
    const socket = createConnection(path);
    let bytes = Buffer.alloc(0), settled = false, identity = true, receivedFrame = false;
    const done = (error?: Error, value?: Obj) => {
      if (settled) return;
      settled = true; socket.destroy();
      if (error instanceof SisError) reject(error);
      else if (error) reject(new SisError('transport_uncertain','socket reply unavailable; outcome uncertain; no direct retry: '+error.message));
      else resolveResult(value ?? {});
    };
    socket.setTimeout(5000);
    socket.on('timeout', () => done(Error('timeout')));
    socket.on('connect', () => socket.write(canonical({cmd:'context',args:{}})+'\n'));
    socket.on('data', (chunk: Buffer) => {
      bytes = Buffer.concat([bytes,chunk]);
      if (bytes.length > 8*1024*1024) return done(Error('reply exceeds limit'));
      while (true) {
        const end = bytes.indexOf(10);
        if (end < 0) return;
        let reply: Obj;
        try { reply = object(JSON.parse(bytes.subarray(0,end).toString('utf8'))); } catch { return done(Error('invalid reply')); }
        bytes = bytes.subarray(end+1);
        if (!identity) {
          if (!onFrame || reply.ok !== true) return done(undefined,reply);
          receivedFrame = true; onFrame(reply);
          if (reply.more !== true) return done(undefined,{ok:true});
          continue;
        }
        const info = object(reply.data), caps = object(info.capabilities);
        let sameDb = false;
        try { sameDb = typeof info.db_path === 'string' && realpathSync(info.db_path) === realpathSync(db); } catch { /* A missing or inaccessible database is not trusted. */ }
        if (reply.ok !== true || !sameDb || caps.protocol !== 2 || caps.proof_receipts !== true || bytes.length) return done(new SisError('project_binding_mismatch','socket identity mismatch: project, protocol 2 and proof receipts required'));
        if (caps.version !== VERSION) return done(new SisError('runtime_version_mismatch',`Expected Superiss ${VERSION}, found ${String(caps.version ?? 'unknown')}; upgrade the owned daemon explicitly; no direct retry`));
        if (req.cmd === 'context') return done(undefined,reply);
        identity = false; socket.setTimeout(onFrame ? 0 : requestTimeout(req)); socket.write(canonical(req)+'\n');
        return;
      }
    });
    socket.on('error',error => done(error));
    socket.on('end',() => { if (onFrame && receivedFrame && !identity) done(undefined,{ok:true}); else done(Error('EOF before acknowledgement')); });
  });
}
interface LockLibrary { symbols: { flock: (fd: number, operation: number) => number }; close: () => void }
function lockSocket(path: string): { fd: number; library: LockLibrary } {
  const lock = path+'.lock', owner = join(lock,'owner.json'), ownUid = process.getuid?.();
  if (ownUid === undefined) fail('unsupported_platform','Unix socket locking requires a user ID');
  mkdirSync(dirname(path),{recursive:true});
  if (existsSync(lock) && lstatSync(lock).isDirectory()) {
    const dir = lstatSync(lock), names = readdirSync(lock);
    if (dir.uid !== ownUid || names.length !== 1 || names[0] !== 'owner.json') fail('socket_in_use','legacy lock ownership cannot be established');
    const info = lstatSync(owner);
    if (!info.isFile() || info.uid !== ownUid || info.nlink !== 1 || info.size > 4096) fail('socket_in_use','legacy lock ownership cannot be established');
    const marker = object(decode(readFileSync(owner,'utf8'))), pid = marker.pid;
    if (!Number.isSafeInteger(pid) || Number(pid) <= 0 || typeof marker.nonce !== 'string' || !/^sis-[0-9a-f]{24}$/u.test(marker.nonce)) fail('socket_in_use','legacy lock ownership cannot be established');
    try { process.kill(Number(pid),0); fail('socket_in_use','legacy lock owner is alive'); }
    catch (error) { if (error instanceof SisError || object(error).code !== 'ESRCH') fail('socket_in_use','legacy lock owner is alive or cannot be checked'); }
    renameSync(lock,lock+'.legacy-'+uid(''));
  }
  const ffi = createRequire(import.meta.url)('bun:ffi') as { FFIType: { i32: number }; dlopen: (path: string, symbols: Record<string,{args: number[]; returns: number}>) => LockLibrary };
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch;
  const libraries = process.platform === 'darwin' ? ['/usr/lib/libSystem.B.dylib'] : process.platform === 'linux' ? ['libc.so.6',`/lib/ld-musl-${arch}.so.1`] : [];
  let library: LockLibrary | undefined;
  for (const candidate of libraries) { try { library = ffi.dlopen(candidate,{flock:{args:[ffi.FFIType.i32,ffi.FFIType.i32],returns:ffi.FFIType.i32}}); break; } catch { /* Try the other local libc if available. */ } }
  if (!library) fail('runtime_unavailable','system flock is unavailable');
  let fd: number | undefined;
  try {
    fd = openSync(lock,constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,0o600);
    const opened = fstatSync(fd), entry = lstatSync(lock);
    if (!opened.isFile() || !entry.isFile() || opened.uid !== ownUid || opened.dev !== entry.dev || opened.ino !== entry.ino) fail('socket_in_use','lock must be an owned regular file');
    if (library.symbols.flock(fd,2|4) !== 0) fail('socket_in_use','socket lock is already held');
    const locked = lstatSync(lock);
    if (!locked.isFile() || locked.dev !== opened.dev || locked.ino !== opened.ino) fail('socket_in_use','socket lock changed while acquiring');
    return {fd,library};
  } catch (error) { if (fd !== undefined) closeSync(fd); library.close(); throw error; }
}
async function serve(engine: Engine,path: string): Promise<void> {
  const lock = lockSocket(path), timers = new Set<ReturnType<typeof setInterval>>();
  const configured = Number(process.env.SIS_MAX_CLIENTS), maxClients = Number.isInteger(configured) && configured > 0 && configured <= 1024 ? configured : 64;
  let clients = 0, socketIdentity: { dev: number; ino: number } | undefined, cleaned = false, draining = false;
  const sockets = new Set<Socket>(), inFlight = new Set<Promise<unknown>>();
  const tracked = (input: Obj): Promise<Obj> => {
    if (draining) return Promise.resolve(responseError(new SisError('shutting_down','Server is draining accepted work')));
    const work = request(engine,input); inFlight.add(work); void work.finally(() => inFlight.delete(work)); return work;
  };
  const server = createServer(socket => {
    socket.on('error',() => socket.destroy());
    if (clients >= maxClients) { write(socket,responseError(new SisError('busy','too many clients'))); socket.end(); return; }
    if (draining) { socket.end(); return; }
    clients++; sockets.add(socket); socket.once('close',() => { clients--; sockets.delete(socket); });
    const requestIds = new Set<string>();
    socket.setTimeout(30000,() => socket.destroy());
    let buffered = Buffer.alloc(0), queue = Promise.resolve(), pending = 0, watching = false;
    socket.on('data',(chunk: Buffer) => {
      if (watching || draining) return;
      buffered = Buffer.concat([buffered,chunk]);
      while (true) {
        const end = buffered.indexOf(10);
        if (end < 0) { if (buffered.length > 1048576) { write(socket,responseError(new SisError('frame_too_large','frame exceeds 1048576 bytes'))); socket.end(); } break; }
        const line = buffered.subarray(0,end); buffered = buffered.subarray(end+1);
        if (line.length > 1048576 || ++pending > 128) { write(socket,responseError(new SisError('frame_too_large','frame or queue limit exceeded'))); socket.end(); return; }
        socket.setTimeout(0);
        let input: Obj;
        try { input = object(JSON.parse(line.toString('utf8'))); } catch { pending--; write(socket,responseError(new SisError('bad_json','invalid JSON'))); continue; }
        const requestId = typeof input.request_id === 'string' ? input.request_id : undefined;
        if (input.request_id !== undefined && (!requestId || requestId.length > 128 || requestIds.has(requestId) || input.cmd === 'watch')) { pending--; write(socket,{...responseError(new SisError('bad_request_id','Unique text request_id required; watch needs a dedicated connection')),...(requestId ? {request_id:requestId} : {})}); continue; }
        if (requestId) requestIds.add(requestId);
        const respond = (result: Obj) => write(socket,requestId ? {...result,request_id:requestId} : result);
        const handle = async () => {
          let result = await tracked(input);
          if (input.cmd === 'watch' && object(input.args).follow !== true) {
            const wait = Number(object(input.args).wait ?? 0), deadline = Date.now()+Math.min(300,Math.max(0,wait))*1000;
            while (result.ok && !array(object(result.data).events).length && Date.now() < deadline && !socket.destroyed) { await delay(50); result = await tracked(input); }
          }
          if (input.cmd !== 'watch' || object(input.args).follow !== true || !result.ok) { respond(result); return; }
          watching = true;
          let after = Number(object(input.args).after ?? 0);
          const initial = array(object(result.data).events); for (const event of initial) after = Math.max(after,Number(object(event).seq));
          write(socket,{...result,more:true});
          const timer = setInterval(() => { if (socket.destroyed) { clearInterval(timer); timers.delete(timer); return; } try { const events = engine.events(undefined,after,1000); for (const event of events) after = Math.max(after,Number(event.seq)); if (events.length) write(socket,{id:input.id ?? null,ok:true,data:{events},more:true}); } catch { socket.destroy(); } },50);
          timers.add(timer); socket.once('close',() => { clearInterval(timer); timers.delete(timer); });
        };
        const work = (requestId ? handle() : queue.then(handle)).catch(error => { respond(responseError(error)); socket.end(); }).finally(() => {
          pending--; if (requestId) requestIds.delete(requestId);
          if (pending === 0 && !watching && !socket.destroyed && !draining) socket.setTimeout(30000);
        });
        if (!requestId) queue = work;
        inFlight.add(work); void work.finally(() => inFlight.delete(work));
      }
    });
  });
  const cleanup = () => {
    if (cleaned) return; cleaned = true;
    for (const timer of timers) clearInterval(timer);
    try {
      if (socketIdentity) { const entry = lstatSync(path); if (entry.isSocket() && entry.dev === socketIdentity.dev && entry.ino === socketIdentity.ino) rmSync(path); }
    } catch { /* A socket no longer owned by this process is left alone. */ }
    closeSync(lock.fd); lock.library.close(); engine.db.close();
  };
  try {
    if (existsSync(path)) {
      const entry = lstatSync(path);
      if (!entry.isSocket() || entry.uid !== process.getuid?.()) fail('socket_in_use','socket path is not an owned Unix socket');
      const live = await new Promise<boolean>(resolveResult => { const probe = createConnection(path); probe.setTimeout(500,() => { probe.destroy(); resolveResult(true); }); probe.once('connect',() => { probe.destroy(); resolveResult(true); }); probe.once('error',error => { probe.destroy(); resolveResult(!['ECONNREFUSED','ENOENT'].includes(text(object(error).code))); }); });
      if (live) fail('socket_in_use','existing socket accepts connections');
      const current = lstatSync(path);
      if (!current.isSocket() || current.uid !== entry.uid || current.dev !== entry.dev || current.ino !== entry.ino) fail('socket_in_use','socket path changed while probing');
      rmSync(path);
    }
    await new Promise<void>((resolveResult,reject) => { server.once('error',reject); server.listen(path,() => resolveResult()); });
    const bound = lstatSync(path); socketIdentity = {dev:bound.dev,ino:bound.ino};
    const { chmodSync } = await import('node:fs'); chmodSync(path,0o600);
    if (process.env.SIS_HTTP) await startHttp(engine,Number(process.env.SIS_HTTP),input => tracked(input));
    for (const signal of ['SIGTERM','SIGINT'] as const) process.once(signal,() => {
      draining = true;
      const stopped = new Promise<void>(resolveStopped => server.close(() => resolveStopped()));
      void (async () => {
        await Promise.allSettled([...inFlight]); await engine.shutdown();
        await Promise.all([...sockets].map(socket => new Promise<void>(resolveDone => {
          if (socket.destroyed) { resolveDone(); return; }
          const timeout = setTimeout(() => { socket.destroy(); resolveDone(); },1000);
          socket.end(() => { clearTimeout(timeout); socket.destroy(); resolveDone(); });
        })));
        await stopped; cleanup(); process.exit(0);
      })();
    });
    process.once('exit',cleanup);
    // Readiness is published only after graceful-stop handlers are installed.
    process.stderr.write(`serving ${path}\n`);
  } catch (error) { if (server.listening) server.close(); cleanup(); throw error; }
}
async function mcp(engine: Engine | null,opt: Options,remote?: (cmd:string,args:Value)=>Promise<Obj>,signal?:AbortSignal): Promise<void> {
  const agentNames=new Set('acquire heartbeat checkpoint resume verify close_check close brief context capabilities cancel cancel_ack tokens'.split(' '));
  const selected=registry.filter(op=>(process.env.SIS_MCP_PROFILE!=='agent' || agentNames.has(text(op.name))) && (!opt.tools.length || opt.tools.includes(text(op.name))));
  if (opt.tools.some(name=>!registry.some(op=>op.name===name))) fail('bad_args','unknown selected MCP tool');
  let buffer=Buffer.alloc(0);
  const output=(value: Obj) => writeSessionFrame(value,opt.headers);
  const handle=async(input: unknown) => {
    const req=object(input); if (req.id===undefined || typeof req.method!=='string' || req.method.startsWith('notifications/')) return;
    try {
      let result: Value;
      if (req.method==='initialize') result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'superiss',version:VERSION}};
      else if (req.method==='tools/list') result={tools:selected.map(op=>({name:'sis_'+text(op.name),description:op.description ?? '',inputSchema:op.inputSchema ?? {type:'object',additionalProperties:true}}))};
      else if (req.method==='tools/call') { const params=object(req.params), name=required(params,'name').replace(/^sis_/u,''); if (!selected.some(op=>op.name===name)) fail('bad_cmd','unknown or unselected tool'); let envelope: Obj; try { envelope=remote ? await remote(name,params.arguments ?? {}) : engine ? {ok:true,data:await engine.dispatch(name,params.arguments ?? {},context(opt))} : fail('internal','MCP backend unavailable'); } catch (error) { envelope=responseError(error); } result={content:[{type:'text',text:canonical(envelope)}],isError:!envelope.ok}; }
      else { await output({jsonrpc:'2.0',id:req.id,error:{code:-32601,message:'Method not found'}}); return; }
      await output({jsonrpc:'2.0',id:req.id,result});
    } catch (error) {
      if(error instanceof SisError && ['output_backpressure','frame_too_large'].includes(error.code))throw error;
      await output({jsonrpc:'2.0',id:req.id,error:{code:-32602,message:error instanceof Error ? error.message : String(error)}});
    }
  };
  const brokenOutput=(error:Error)=>process.stdin.destroy(error), stop=()=>process.stdin.destroy();
  process.stdout.on('error',brokenOutput);signal?.addEventListener('abort',stop,{once:true});
  try {
    for await(const chunk of process.stdin) {
      if(signal?.aborted)return;
      buffer=Buffer.concat([buffer,Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)]);
      while (buffer.length) {
        if(signal?.aborted)return;
        let frame: Buffer;
        if (buffer.subarray(0,15).toString().toLowerCase().startsWith('content-length:')) {
          const end=buffer.indexOf('\r\n\r\n'); if (end<0) break;
          const match=buffer.subarray(0,end).toString().match(/^Content-Length: (\d+)$/imu); const size=match ? Number(match[1]) : -1;
          if (size<0 || size>1048576) fail('frame_too_large','Invalid MCP frame');
          if (buffer.length<end+4+size) break; frame=buffer.subarray(end+4,end+4+size); buffer=buffer.subarray(end+4+size);
        } else { const end=buffer.indexOf(10); if (end<0) break; frame=buffer.subarray(0,end); buffer=buffer.subarray(end+1); }
        if (frame.length>1048576) fail('frame_too_large','MCP request exceeds 1 MiB');
        if (!frame.toString().trim()) continue;
        let input:unknown;
        try {input=JSON.parse(frame.toString('utf8'));}
        catch {await output({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});continue;}
        await handle(input);
      }
      if (buffer.length>1048576) fail('frame_too_large','MCP request exceeds 1 MiB');
    }
    if(buffer.length)fail('bad_frame','Incomplete MCP frame at EOF; not dispatched');
  } catch(error) {if(!signal?.aborted || error instanceof SisError && error.code==='output_backpressure')throw error;}
  finally {process.stdout.removeListener('error',brokenOutput);signal?.removeEventListener('abort',stop);}
}
async function main(): Promise<void> {
  const opt=options(); let db=dbPath(opt);
  const pending: string[]=[]; let parent=db; while (!existsSync(parent)) { pending.unshift(basename(parent)); parent=dirname(parent); } db=join(realpathSync(parent),...pending);
  if (opt.cmd === 'migrate_copy') { const args = object(payload(opt)); if (Object.keys(args).some(key => key !== 'source')) fail('bad_args','migrate_copy accepts only source'); console.log(canonical(copySqlite(required(args,'source'),db))); return; }
  const sock=opt.sock || process.env.SIS_SOCK || '/tmp/sis-'+digest(db).slice(0,20)+'.sock';
  if (opt.cmd==='serve') { const engine=new Engine(db); await serve(engine,sock); return; }
  const useSocket=process.env.SIS_DIRECT!=='1' && (opt.sock!==undefined || !!process.env.SIS_SOCK || existsSync(sock));
  const call=async(cmd:string,args:Value,withIdem=true,onFrame?: (frame: Obj) => void):Promise<Obj>=>{
    if (useSocket) {
      return socketCall(sock,db,{id:uid('req-'),cmd,args,...(opt.actor!==undefined ? {actor:opt.actor} : {}),idem:withIdem ? opt.idem ?? null : null,run_id:opt.run_id ?? null},onFrame);
    }
    const engine=new Engine(db); try{return {ok:true,data:await engine.dispatch(cmd,args,{...context(opt),idem:withIdem ? opt.idem ?? null : null})};} catch(error){return responseError(error);} finally{await engine.shutdown();engine.db.close();}
  };
  if (opt.cmd==='mcp' || opt.cmd==='rpc') {
    const client=useSocket ? new SuperissSocketClient(sock,db) : undefined;
    const engine=useSocket ? null : new Engine(db);
    const dispatch=async(input: Obj):Promise<Obj>=>{
      const req: Obj={...input,...(input.actor===undefined && opt.actor!==undefined ? {actor:opt.actor} : {}),...(input.idem===undefined && opt.idem!==undefined ? {idem:opt.idem} : {}),...(input.run_id===undefined && opt.run_id!==undefined ? {run_id:opt.run_id} : {})};
      try {
        return client ? req.cmd==='watch' ? await socketCall(sock,db,req) : await client.request(req,{timeoutMs:requestTimeout(req)}) : engine ? await request(engine,req) : fail('internal','Session backend unavailable');
      } catch(error) {return responseError(error,req.id ?? null);}
    };
    const cleanup=async()=>{client?.close();if(engine){await engine.shutdown();engine.db.close();}};
    const controller=new AbortController();
    const stop=()=>{process.exitCode=143;controller.abort();};
    process.once('SIGTERM',stop);process.once('SIGINT',stop);
    let blocked: SisError | undefined;
    try {if(opt.cmd==='mcp')await mcp(engine,opt,client ? (cmd,args)=>dispatch({cmd,args}) : undefined,controller.signal);else await runSession(dispatch,controller.signal);}
    catch(error) {if(error instanceof SisError && error.code==='output_backpressure')blocked=error;else throw error;}
    finally {process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);await cleanup();}
    if(blocked){process.stderr.write(canonical(responseError(blocked))+'\n');process.exit(2);}
    return;
  }
  let args=payload(opt);
  if (opt.cmd==='changes' && object(args).files===undefined) args=collectChanges(object(args),db);
  if (['checkpoint','handoff'].includes(opt.cmd) && object(args).cwd===undefined && !opt.payload[0]?.startsWith('{')) args={...object(args),cwd:process.cwd()};
  if (['close','checkpoint','handoff'].includes(opt.cmd) && object(args).id && git(process.cwd(),'rev-parse','--show-toplevel')) {
    const evidence=collectChanges({id:object(args).id,force:true},db);
    await call('changes',evidence,false);
  }
  if (opt.cmd==='changes' && typeof object(args).patch!=='string') { const clean={...object(args)}; delete clean.patch; args=clean; }
  const streaming = opt.cmd === 'watch' && object(args).follow === true;
  if (streaming && !useSocket) fail('transport_unavailable','watch --follow requires a running daemon');
  const result=await call(opt.cmd,args,true,streaming ? frame => console.log(canonical(frame)) : undefined);
  if (result.ok) { if (!streaming) console.log(canonical(result.data)); } else {console.error(canonical(result));process.exitCode=2;}
}
main().catch(error=>{console.error(canonical(responseError(error)));process.exitCode=2;});
