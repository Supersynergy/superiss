import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Engine } from './engine.ts';
import { array, canonical, encoding, fail, fingerprint, integer, number, object, rootDirectory, SisError, text, tokenCount, type Obj } from './util.ts';

const reads = new Set('context capabilities stats list query count ready next show search children contract brief resume tokens watch lint types statuses prime orphans review stale recall comments history dep_list goal_tree tree goal_done gate_list slot_list outbox_list cost_list cost_rollup learn dup_scan find_duplicates close_check'.split(' '));
function envelope(value: unknown): Obj {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('bad_args','request must be an object');
  const input = object(value);
  if (typeof input.cmd !== 'string' || !input.cmd.trim()) fail('bad_args','cmd required');
  if (input.args !== undefined && (input.args === null || typeof input.args !== 'object' || Array.isArray(input.args))) fail('bad_args','args must be an object');
  if (input.request_id !== undefined && (typeof input.request_id !== 'string' || !input.request_id.trim() || input.request_id.length > 128)) fail('bad_args','request_id must be nonempty and within 128 characters');
  if (input.cmd.replaceAll('-','_') === 'batch') {
    const ops = object(input.args).ops;
    if (!Array.isArray(ops) || ops.length > 64) fail('bad_args','batch needs at most 64 operations');
    for (const item of ops) { const op=object(item), cmd=text(op.cmd).replaceAll('-','_'); if (cmd==='batch' || cmd==='verify' || cmd==='attest' && object(op.args).kind==='run') fail('bad_args','batch cannot nest or execute commands'); envelope(item); }
  }
  return input;
}
function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve,reject) => {
    const chunks: Buffer[] = []; let size = 0, oversized = false;
    req.on('data',(chunk: Buffer) => { size+=chunk.length; if (size>1024*1024) { if (!oversized) { oversized=true; reject(new SisError('frame_too_large','request exceeds 1 MiB')); } } else chunks.push(chunk); });
    req.once('end',() => { if (!oversized) resolve(Buffer.concat(chunks).toString('utf8')); }); req.once('error',reject); req.once('aborted',() => reject(new SisError('bad_args','request aborted')));
  });
}
function tracker(engine: Engine, query: URLSearchParams): Obj {
  const allowed=new Set(['limit','offset','owner','lane','status','view']);
  for(const key of query.keys())if(!allowed.has(key)||query.getAll(key).length!==1)fail('bad_args','unknown or repeated tracker filter');
  const limit=integer(Number(query.get('limit')??100),'limit',undefined,1,500),offset=integer(Number(query.get('offset')??0),'offset'),view=query.get('view')??'all';
  if(!['all','blocked','expired','failed-proof'].includes(view))fail('bad_args','unknown tracker view');
  const clauses=['1=1'],params:(string|number)[]=[];
  for(const key of ['owner','lane','status'])if(query.has(key)){
    const value=query.get(key)!;
    if(!value.trim()||value.length>128||key==='status'&&!array(engine.exec('statuses')).includes(value))fail('bad_args','invalid '+key);
    clauses.push(`i.${key}=?`);params.push(value);
  }
  if(view==='expired'){clauses.push("i.status='in_progress' AND COALESCE(i.lease_until,0)<=?");params.push(Date.now()/1000);}
  if(view==='failed-proof')clauses.push('(SELECT p.passed FROM proofs p WHERE p.issue=i.id ORDER BY p.rowid DESC LIMIT 1)=0');
  if(view==='blocked')clauses.push("i.status NOT IN('closed','cancelled') AND (EXISTS(SELECT 1 FROM deps d LEFT JOIN issues b ON b.id=d.depends_on WHERE d.issue=i.id AND COALESCE(d.type,'blocks')='blocks' AND (b.id IS NULL OR b.status<>'closed')) OR EXISTS(SELECT 1 FROM deps d LEFT JOIN gates g ON g.name=d.depends_on WHERE d.issue=i.id AND d.type='gate' AND COALESCE(g.state,'closed')<>'open'))");
  return engine.db.transaction(()=>{
    const where=clauses.join(' AND '),total=Number(engine.row('SELECT COUNT(*) n FROM issues i WHERE '+where,...params)?.n??0);
    const issues=engine.issues('SELECT i.* FROM issues i WHERE '+where+' ORDER BY i.priority,i.created_at,i.id LIMIT ? OFFSET ?',...params,limit,offset);
    return {cursor:Number(engine.row('SELECT COALESCE(MAX(seq),0) n FROM events')?.n),total,offset,next_offset:offset+issues.length<total?offset+issues.length:null,issues,view,stats:engine.exec('stats')};
  });
}
function loopReceipt(engine: Engine, encoded: string, query?: URLSearchParams): Obj {
  if(query)for(const key of query.keys())if(!['max_tokens','encoding'].includes(key)||query.getAll(key).length!==1)fail('bad_args','unknown or repeated capsule option');
  const max=query?integer(Number(query.get('max_tokens')??2000),'max_tokens',undefined,128,8000):2000,enc=query?encoding({encoding:query.get('encoding')??'o200k_base'}):'o200k_base';
  let id:string;try{id=decodeURIComponent(encoded);}catch{fail('bad_args','invalid encoded issue id');}
  if(!id.trim()||id.length>256)fail('bad_args','invalid issue id');
  return engine.db.transaction(()=>{
    const resume=object(engine.exec('resume',{id})),task=object(object(resume.contract).task),issue=engine.issue(id),checkpoint=resume.checkpoint==null?null:object(resume.checkpoint),proof=engine.row('SELECT * FROM proofs WHERE issue=? ORDER BY rowid DESC LIMIT 1',id),cancelled=resume.cancel_requested===true;
    const valid=issue.status==='in_progress'&&Number(issue.lease_until)>Date.now()/1000&&!cancelled;
    const verdict=task.status==='closed'?'closed':cancelled?'cancel_requested':checkpoint?.stale===true?'source_drift':task.status==='in_progress'&&!valid?'lease_expired':proof?.passed===0?'failed':text(task.status);
    const receipt:Obj={id,verdict,contract:task,claim:{actor:issue.claim_actor??null,epoch:issue.lease_epoch??null,lease_until:issue.lease_until??null,valid},checkpoint,proof:proof?{proof_id:proof.proof_id,passed:proof.passed===1,revision:proof.revision,source_hash:proof.source_hash,source_current:null,exit_code:proof.exitcode??null,timed_out:proof.timed_out===1}:null,failing:proof?.passed===0?['oracle']:[],next:{cmd:'resume',args:{id}},changes:resume.changes??[],timings:null};
    if(!query)return receipt;
    const source=fingerprint(issue,text(checkpoint?.cwd,engine.projectRoot()),engine.dbPath),sourceStale=checkpoint!==null&&(checkpoint.stale===true||![source.source_hash,source.legacy_source_hash].includes(text(checkpoint.source_hash))),usable=valid&&!sourceStale,omitted:string[]=[];
    let capsule:Obj={...receipt,checkpoint:sourceStale?{...checkpoint,stale:true,source_stale:true}:checkpoint,verdict:sourceStale&&!['closed','cancel_requested'].includes(verdict)?'source_drift':verdict,source_hash:source.source_hash,usable},body=canonical(capsule),tokens=tokenCount(body,enc);
    for(const field of ['changes','desc'])if(tokens>max){
      capsule=field==='desc'?{...capsule,contract:Object.fromEntries(Object.entries(task).filter(([key])=>key!=='desc'))}:Object.fromEntries(Object.entries(capsule).filter(([key])=>key!==field));
      omitted.push(field);body=canonical(capsule);tokens=tokenCount(body,enc);
    }
    if(tokens>max)fail('budget_exceeded',`mandatory capsule requires ${tokens} tokens`);
    return {id,revision:task.revision,source_hash:source.source_hash,usable,text:body,used_tokens:tokens,max_tokens:max,encoding:enc,omitted};
  });
}
function openapi(caps: Obj): Obj {
  const names=array(caps.operations).map(name=>text(name));
  const rpc: Obj={type:'object',required:['cmd'],properties:{cmd:{type:'string',enum:names},args:{type:'object'},actor:{type:'string'},idem:{type:'string'},run_id:{type:'string'},request_id:{type:'string',minLength:1,maxLength:128}}};
  const post=(schema: Obj,operationId: string): Obj=>({post:{operationId,requestBody:{required:true,content:{'application/json':{schema}}},responses:{'200':{description:'RPC envelope; explicit verdicts remain authoritative'},'400':{description:'Invalid input or operation rejected'},'403':{description:'Loopback Host and same-origin required'},'413':{description:'Request exceeds 1 MiB'}}}});
  const ops=array(caps.ops).map(object);
  return {openapi:'3.1.0',info:{title:'Superiss local API',version:text(caps.version)},servers:[{url:'/'}],paths:{'/api/v1/rpc':post(rpc,'rpc'),'/api/v1/batch':post({type:'object',required:['ops'],properties:{ops:{type:'array',maxItems:64,items:rpc}}},'batch'),...Object.fromEntries(names.map(name=>['/api/v1/ops/'+name,post({type:'object',properties:{args:object(ops.find(op=>op.name===name)?.inputSchema),actor:{type:'string'},idem:{type:'string'},request_id:{type:'string'}}},name)])),...Object.fromEntries(['capabilities','context','events','openapi.json','tracker'].map(name=>['/api/v1/'+name,{get:{responses:{'200':{description:name}}}}])), '/api/v1/capsules/{id}':{get:{parameters:[{name:'id',in:'path',required:true,schema:{type:'string',maxLength:256}},{name:'max_tokens',in:'query',schema:{type:'integer',minimum:128,maximum:8000,default:2000}},{name:'encoding',in:'query',schema:{type:'string',enum:['o200k_base','cl100k_base']}}],responses:{'200':{description:'Source-bound capsule; budget applies to complete text, not JSON envelope'},'400':{description:'Invalid input, unavailable source or mandatory context exceeds budget'}}}},'/api/v1/loops/{id}':{get:{parameters:[{name:'id',in:'path',required:true,schema:{type:'string',maxLength:256}}],responses:{'200':{description:'Native source-bound loop receipt; timing remains unknown unless measured'}}}}},'x-security-boundary':'Local trusted clients only; never expose through a remote proxy without separate authentication.'};
}
export async function startHttp(engine: Engine,port: number,dispatch: (request: Obj)=>Promise<Obj>): Promise<Server> {
  integer(port,'http port',undefined,1,65535);
  const server=createServer({maxHeaderSize:16384},async(req,res)=>{
    const send=(value: Obj,status=200)=>{ if (!res.destroyed && !res.writableEnded) { res.writeHead(status,{'content-type':'application/json; charset=utf-8','x-content-type-options':'nosniff','cache-control':'no-store'}); res.end(canonical(value)); } };
    const call=async(value: unknown)=>{const input=envelope(value),out=await dispatch(input);send({...out,...(input.request_id!==undefined?{request_id:input.request_id}:{})},out.ok===false?400:200);};
    try {
      const authority=req.headers.host ?? '', allowed=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
      if (!allowed.has(authority) || req.headers['sec-fetch-site']==='cross-site' || req.headers.origin && req.headers.origin!==`http://${authority}`) { send({ok:false,error:{code:'forbidden_origin',msg:'loopback Host and same-origin required'}},403); return; }
      const url=new URL(req.url ?? '/',`http://${authority}`),path=url.pathname;
      if (req.method==='GET' && (path==='/' || path==='/board.html')) { res.writeHead(200,{'content-type':'text/html; charset=utf-8','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'"}); res.end(readFileSync(join(rootDirectory,'web','board.html'))); return; }
      if(req.method==='GET'&&path==='/api/v1/tracker'){send({ok:true,data:tracker(engine,url.searchParams)});return;}
      if(req.method==='GET'&&path.startsWith('/api/v1/capsules/')&&!path.slice('/api/v1/capsules/'.length).includes('/')){send({ok:true,data:loopReceipt(engine,path.slice('/api/v1/capsules/'.length),url.searchParams)});return;}
      if(req.method==='GET'&&path.startsWith('/api/v1/loops/')&&!path.slice('/api/v1/loops/'.length).includes('/')){send({ok:true,data:loopReceipt(engine,path.slice('/api/v1/loops/'.length))});return;}
      if (req.method==='GET' && path==='/health') { send({ok:true,data:{ok:true}}); return; }
      if (req.method==='GET' && path==='/board') { send({ok:true,data:{stats:await engine.dispatch('stats'),issues:await engine.dispatch('list',{limit:1000})}}); return; }
      if (req.method==='GET' && ['/api/v1/capabilities','/api/v1/context','/api/v1/openapi.json'].includes(path)) {
        const out=await dispatch({cmd:path.endsWith('/context')?'context':'capabilities',args:{schemas:true}});
        send(path.endsWith('/openapi.json') && out.ok===true?openapi(object(out.data)):out,out.ok===false?400:200); return;
      }
      if (req.method==='GET' && ['/events','/api/v1/events'].includes(path)) {
        const after=integer(Number(url.searchParams.get('after') ?? 0),'after'),wait=number(Number(url.searchParams.get('wait') ?? 0),'wait',undefined,0,300),limit=integer(Number(url.searchParams.get('limit') ?? 1000),'limit',undefined,1,1000),until=Date.now()+wait*1000;
        let result=await dispatch({cmd:'watch',args:{after,limit}});
        while (result.ok===true && !array(object(result.data).events).length && Date.now()<until && !res.destroyed) { await delay(Math.min(50,Math.max(0,until-Date.now()))); if (!res.destroyed) result=await dispatch({cmd:'watch',args:{after,limit}}); }
        if(result.ok===true){const data=object(result.data),events=array(data.events);result={...result,data:{...data,next_after:object(events.at(-1)).seq ?? after}};}
        send(result,result.ok?200:400); return;
      }
      if (req.method==='GET' && path==='/op') {
        const input=envelope(JSON.parse(url.searchParams.get('q') ?? '{}'));
        if (!reads.has(text(input.cmd).replaceAll('-','_'))) {send({ok:false,error:{code:'method_not_allowed',msg:'use POST for mutations'}},405);return;}
        await call(input);return;
      }
      const named=path.startsWith('/api/v1/ops/')?path.slice('/api/v1/ops/'.length):null;
      if (req.method==='POST' && (['/','/op','/api/v1/rpc','/api/v1/batch'].includes(path) || named && !named.includes('/'))) {
        if (!/^application\/json(?:\s*;|\s*$)/iu.test(text(req.headers['content-type']))) {send({ok:false,error:{code:'unsupported_media_type',msg:'application/json required'}},415);req.resume();return;}
        if (Number(req.headers['content-length'])>1024*1024) {send({ok:false,error:{code:'frame_too_large',msg:'request exceeds 1 MiB'}},413);req.resume();return;}
        const value: unknown=JSON.parse(await body(req));if(value===null || typeof value!=='object' || Array.isArray(value))fail('bad_args','request must be an object');const input=object(value);
        if(path==='/api/v1/batch'){const {ops,...rest}=input;await call({...rest,cmd:'batch',args:{ops}});}
        else if(named){if(input.cmd!==undefined && input.cmd!==named)fail('bad_args','cmd differs from named route');await call({...input,cmd:named});}
        else await call(input);return;
      }
      send({ok:false,error:{code:'not_found',msg:'unknown HTTP route'}},404);
    } catch(error) {const code=error instanceof SisError?error.code:error instanceof SyntaxError?'bad_json':'internal';send({ok:false,error:{code,msg:error instanceof Error?error.message.slice(0,2000):String(error)}},code==='frame_too_large'?413:code==='internal'?500:400);}
  });
  server.maxConnections=128;server.headersTimeout=10000;server.requestTimeout=15000;server.keepAliveTimeout=1000;server.setTimeout(310000);
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
  server.on('error',error=>process.stderr.write(`superiss HTTP: ${error.message}\n`));
  return server;
}
