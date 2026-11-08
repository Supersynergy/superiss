import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { StoreDatabase } from './store.ts';
import { actor, admin, array, canonical, childWhere, decode, digest, encoding, execute, fail, fingerprint, integer, localZeroAvailable, now, number, object, paths, redact, required, rootDirectory, SisError, text, tokenCount, ttl, uid, type Obj, type Value } from './util.ts';
import { extension } from './extension.ts';

export interface Context { actor: string; explicit: boolean; idem: string | null; run_id: string | null; payload_hash: string }
export const registry = array(object(JSON.parse(readFileSync(join(rootDirectory,'ops.json'),'utf8'))).ops).map(object);
const mutations = new Set('create q update admin_update dep dep_remove claim claim_next acquire heartbeat unclaim reclaim close reopen delete defer undefer label rename note changes checkpoint handoff cancel cancel_ack remember import batch budget_claim outbox_done outbox_fail compact gate slot_acquire slot_release merge_slot goal sub plan attest cost_add outbox_export sync_import'.split(' '));
const aliases: Record<string,string> = { q:'create', query:'list', next:'ready', goal_create:'goal', subgoal:'sub', tree:'goal_tree', merge_slot:'slot_acquire', tag:'label', comment:'note', find_duplicates:'dup_scan' };
const issueFields = 'id title status priority type owner oracle_cmd allowed_paths lane budget_eur acceptance desc lease_until lease_epoch claim_actor created_at closed_at defer_until expires_at'.split(' ');
const editable = new Set('title priority type owner oracle_cmd allowed_paths lane budget_eur acceptance desc meta_json defer_until expires_at'.split(' '));
const statuses = ['open','in_progress','blocked','deferred','closed','cancelled'];
const ignoredSnapshots = new Set('heartbeat remember outbox_done outbox_fail gate slot_acquire slot_release merge_slot cancel cancel_ack checkpoint changes attest cost_add outbox_export'.split(' '));
const blocked = `NOT EXISTS(SELECT 1 FROM deps d LEFT JOIN issues b ON b.id=d.depends_on WHERE d.issue=i.id AND COALESCE(d.type,'blocks')='blocks' AND COALESCE(b.status,'open')!='closed') AND NOT EXISTS(SELECT 1 FROM deps d LEFT JOIN gates g ON g.name=d.depends_on WHERE d.issue=i.id AND d.type='gate' AND COALESCE(g.state,'closed')!='open')`;
const ready = `(i.status='open' OR (i.status='deferred' AND i.defer_until IS NOT NULL AND i.defer_until<=?)) AND (i.defer_until IS NULL OR i.defer_until<=?) AND (i.expires_at IS NULL OR i.expires_at>?) AND i.type NOT IN ('goal','epic') AND i.oracle_cmd IS NOT NULL AND trim(i.oracle_cmd)!='' AND NOT EXISTS(SELECT 1 FROM cancellations x WHERE x.issue=i.id AND x.requested!=0) AND NOT EXISTS(SELECT 1 FROM issues child WHERE json_extract(child.meta_json,'$.parent')=i.id OR (child.id LIKE i.id||'.%' AND instr(substr(child.id,length(i.id)+2),'.')=0))`;
const instanceId = uid('sis-instance-');
function parameter(value: unknown): string | number | null | Uint8Array { if (value == null) return null; if (typeof value === 'string' || typeof value === 'number' || value instanceof Uint8Array) return value; if (typeof value === 'boolean') return Number(value); return canonical(value); }

export class Engine {
  readonly db: StoreDatabase;
  generation = 0;
  constructor(readonly dbPath: string) { this.db = new StoreDatabase(dbPath); }
  rows(sql: string,...params: unknown[]): Obj[] { return this.db.all(sql,...params.map(parameter)) as Obj[]; }
  row(sql: string,...params: unknown[]): Obj | undefined { return this.db.get(sql,...params.map(parameter)) as Obj | undefined; }
  run(sql: string,...params: unknown[]) { return this.db.run(sql,...params.map(parameter)); }
  issue(id: unknown): Obj { const row = this.row('SELECT * FROM issues WHERE id=?',id); if (!row) fail('not_found', `issue ${id}`); row.meta = decode(row.meta_json,{}); delete row.meta_json; return row; }
  issues(sql: string,...params: unknown[]): Obj[] { return this.rows(sql,...params).map(row => { row.meta = decode(row.meta_json,{}); delete row.meta_json; return row; }); }
  emit(op: string,id: Value,c: Context,data: Value): void { this.run('INSERT INTO events(ts,op,issue,actor,run_id,idem,data_json) VALUES(?,?,?,?,?,?,?)', now(),op,id,c.actor,c.run_id,c.idem,canonical(redact(data))); }
  state(task: Obj): string {
    if (task.status === 'closed') return 'closed';
    const verified = this.row("SELECT data_json FROM events WHERE issue=? AND op='verify' ORDER BY seq DESC LIMIT 1", task.id);
    if (verified) return object(decode(verified.data_json)).passed ? 'verified' : 'evidence';
    if (this.row("SELECT 1 FROM events WHERE issue=? AND op IN ('checkpoint','changes') LIMIT 1",task.id)) return 'evidence';
    return task.claim_actor || Number(task.lease_until) > now() ? 'claimed' : 'queued';
  }
  events(id?: Value, since = 0, limit = 1000): Obj[] {
    return this.rows(`SELECT * FROM events WHERE seq>?${id === undefined ? '' : ' AND issue=?'} ORDER BY seq LIMIT ?`,since,...(id === undefined ? [] : [id]),limit).map(row => ({ ...row, data:decode(row.data_json) }));
  }
  contract(id: unknown): Obj {
    const row = this.issue(id);
    const deps = this.rows("SELECT d.depends_on,COALESCE(d.type,'blocks') type,b.status,g.state gate_state FROM deps d LEFT JOIN issues b ON b.id=d.depends_on LEFT JOIN gates g ON g.name=d.depends_on WHERE d.issue=? ORDER BY d.depends_on,d.type",id);
    const base: Obj = {id:row.id,title:row.title,desc:row.desc,acceptance:row.acceptance,oracle_cmd:row.oracle_cmd,allowed_paths:paths(row.allowed_paths),owner:row.owner,lane:row.lane,dependencies:deps.map(d => ({depends_on:d.depends_on,type:d.type}))};
    base.budget_eur=row.budget_eur ?? null;base.meta=Object.fromEntries(['local_zero','execution','budget_gate','review_required','attest_required'].map(key=>[key,object(row.meta)[key] ?? null]));
    const revision = digest(canonical(base));
    const dependencies = deps.map(d => { const kind = d.type, state = kind === 'gate' ? d.gate_state ?? 'closed' : d.status ?? 'missing'; return {depends_on:d.depends_on,type:kind,state:kind === 'gate' || kind === 'blocks' ? state : null,blocked:kind === 'blocks' && state !== 'closed' || kind === 'gate' && state !== 'open'}; });
    return {...base,status:row.status,type:row.type,dependencies,revision,blocked_by:dependencies.filter(d=>d.blocked).map(d=>d.depends_on ?? null)};
  }
  revision(id: unknown): string { return text(this.contract(id).revision); }
  expected(a: Obj): void { if (a.expected_revision !== undefined && a.expected_revision !== this.revision(a.id)) fail('revision_conflict','expected_revision does not match'); }
  cancelled(id: unknown): boolean { return Number(this.row('SELECT requested FROM cancellations WHERE issue=?',id)?.requested ?? 0) !== 0; }
  active(a: Obj,c: Context,allowCancel = false): Obj {
    const id = required(a,'id'), who = this.who(a,c), epoch = integer(a.epoch,'epoch');
    const task = this.issue(id);
    if (epoch !== task.lease_epoch) fail('stale_fence','epoch differs');
    if (task.status !== 'in_progress' || task.claim_actor !== who) fail('not_claimed','actor does not hold claim');
    if (Number(task.lease_until ?? 0) <= now()) fail('lease_expired','lease expired');
    if (!allowCancel && this.cancelled(id)) fail('cancel_requested','cancellation requested');
    return task;
  }
  who(a: Obj,c: Context): string { return actor({...a,actor:a.actor ?? (c.explicit ? c.actor : undefined)}); }
  private context(a: Obj,input: Partial<Context>): Context {
    const who = a.actor ?? input.actor ?? 'socket';
    if (typeof who !== 'string') fail('bad_args','actor must be a string');
    for (const key of ['idem','run_id']) if (a[key] != null && typeof a[key] !== 'string') fail('bad_args',`${key} must be a string`);
    return {actor:who,explicit:a.actor !== undefined || input.explicit === true || input.actor !== undefined && input.explicit !== false,idem:text(a.idem,text(input.idem)) || null,run_id:text(a.run_id,text(input.run_id)) || null,payload_hash:digest(canonical(Object.fromEntries(Object.entries(a).filter(([k])=>!['idem','admin_token'].includes(k)))))};
  }
  cached(cmd: string,c: Context): Value | undefined {
    if (!c.idem) return undefined;
    const stored = this.row('SELECT v FROM kv WHERE k=?','idem:'+c.idem);
    if (!stored) return undefined;
    const item = object(decode(stored.v));
    if (item.cmd !== cmd || item.actor !== c.actor || item.payload_hash !== c.payload_hash) fail('idem_conflict','idempotency key reused for different actor, command or payload');
    return item.data ?? null;
  }
  save(cmd: string,c: Context,data: Value): Value {
    if (c.idem) this.run('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v','idem:'+c.idem,canonical({cmd,actor:c.actor,payload_hash:c.payload_hash,data}));
    return data;
  }
  normalize(cmd: string,args: unknown): { cmd: string; a: Obj } {
    cmd = cmd.replaceAll('-','_');
    if (!registry.some(op=>op.name===cmd) && !Object.hasOwn(aliases,cmd)) fail('bad_cmd',cmd);
    if (Array.isArray(args)) { if (cmd !== 'dep') fail('bad_args','arguments must be an object'); return {cmd,a:{deps:args as Value[]}}; }
    if (args != null && typeof args !== 'object') fail('bad_args','arguments must be an object');
    return {cmd,a:object(args)};
  }
  exec(command: string,args: unknown = {},input: Partial<Context> = {}): Value {
    const {cmd,a} = this.normalize(command,args), c = this.context(a,input);
    if (cmd==='verify' || cmd==='attest' && a.kind==='run') fail('bad_args','execution cannot run inside batch');
    if (['admin_update','import','sync_import'].includes(cmd)) admin(a);
    if (!mutations.has(cmd) && !mutations.has(aliases[cmd])) return this.operation(aliases[cmd] ?? cmd,a,c);
    return this.db.transaction(() => { const cached = this.cached(cmd,c); if (cached !== undefined) return cached; return this.save(cmd,c,this.operation(aliases[cmd] ?? cmd,a,c)); });
  }
  async dispatch(command: string,args: unknown = {},input: Partial<Context> = {}): Promise<Value> {
    const {cmd,a} = this.normalize(command,args), c = this.context(a,input);
    const start = performance.now();
    try {
      let data: Value;
      if (cmd === 'verify' || cmd === 'attest' && a.kind === 'run') {
        const work = async () => {
          const cached = this.cached(cmd,c); if (cached !== undefined) return cached;
          return cmd === 'verify' ? this.verify(a,c) : this.attestRun(a,c);
        };
        if (c.idem) {
          const folder = join(dirname(this.dbPath),'.sis','verify-locks'); mkdirSync(folder,{recursive:true,mode:0o700});
          const lock = join(folder,digest(resolve(this.dbPath)+'\0'+c.idem));
          const deadline = Date.now() + (number(a.timeout_secs,'timeout_secs',10,1,300)+5)*1000;
          while (true) { try { mkdirSync(lock,{mode:0o700}); break; } catch (e) { if (object(e).code !== 'EEXIST') throw e; if (Date.now() >= deadline) fail('busy','bounded verification wait exceeded'); await delay(25); } }
          try { data = await work(); } finally { rmSync(lock,{recursive:true}); }
        } else data = await work();
      } else data = this.exec(cmd,a,input);
      if (mutations.has(cmd) || cmd === 'verify') { this.generation++; if (!ignoredSnapshots.has(cmd)) this.snapshot(); }
      const emit = process.env.SIS_EMIT;
      if (emit && emit !== '0') {
        const path = emit === '1' ? join(dirname(this.dbPath),'spans.jsonl') : emit;
        mkdirSync(dirname(path),{recursive:true});
        appendFileSync(path,canonical({op:cmd,issue:a.id ?? null,actor:c.actor,ms:performance.now()-start,ok:true,ts:now()})+'\n');
      }
      return data;
    } catch (error) {
      if (error instanceof SisError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/UNIQUE constraint/i.test(message)) fail(cmd === 'create' || cmd === 'q' ? 'exists' : 'conflict',message);
      throw error;
    }
  }
  snapshot(): Obj {
    const file = join(dirname(this.dbPath),basename(this.dbPath).replace(/\.[^.]*$/u,'')+'.issues.jsonl');
    const rows = this.issues('SELECT * FROM issues ORDER BY id');
    const out = [{k:'sis-snapshot',v:1},...rows.map(row=>({op:'upsert',issue:row.id,data:{...row,deps:this.rows('SELECT depends_on AS "on",COALESCE(type,\'blocks\') type FROM deps WHERE issue=? ORDER BY depends_on',row.id)}}))].map(canonical).join('\n')+'\n';
    if (existsSync(file) && readFileSync(file,'utf8') === out) return {path:file,issues:rows.length,unchanged:true};
    const tmp = file+'.'+uid('')+'.tmp'; writeFileSync(tmp,out,{mode:0o600}); renameSync(tmp,file);
    return {path:file,issues:rows.length};
  }
  private checkpointInfo(task: Obj, checkpoint: Obj, revision: Value | undefined): Obj {
    let sourceStale = true;
    try {
      const source = fingerprint(task,text(checkpoint.cwd),this.dbPath);
      sourceStale = checkpoint.source_hash !== source.source_hash && checkpoint.source_hash !== source.legacy_source_hash;
    } catch { /* Unavailable source cannot prove a checkpoint current. */ }
    return {...checkpoint,artifacts:decode(checkpoint.artifacts,[]),source_stale:sourceStale,stale:checkpoint.revision !== revision || sourceStale};
  }
  brief(a: Obj): Obj {
    const task = this.contract(required(a,'id')), enc = encoding(a);
    const max = a.max_tokens === undefined ? undefined : integer(a.max_tokens,'max_tokens',undefined,1);
    const latest = this.row("SELECT data_json FROM events WHERE issue=? AND op='changes' ORDER BY seq DESC LIMIT 1",a.id);
    const body: Obj = {...task}, omitted: string[] = [];
    if (a.since === undefined) omitted.push('history');
    else {
      const since = integer(a.since,'since');
      body.history = this.rows('SELECT seq,ts,op,data_json FROM events WHERE issue=? AND seq>? ORDER BY seq LIMIT 50',a.id,since).map(row=>({seq:row.seq,ts:row.ts,op:row.op,data:decode(row.data_json)}));
    }
    if (latest) body.changes = decode(latest.data_json);
    const render = () => JSON.stringify(JSON.parse(canonical(body)),null,2);
    let contractText = render(), tokens = tokenCount(contractText,enc);
    for (const field of ['history','changes','desc']) if (max !== undefined && tokens > max && Object.hasOwn(body,field)) {
      delete body[field]; omitted.push(field); contractText = render(); tokens = tokenCount(contractText,enc);
    }
    if (max !== undefined && tokens > max) fail('budget_exceeded',`mandatory contract requires ${tokens} tokens`);
    const checkpoint = this.row('SELECT seq,actor,epoch,revision,source_hash,cwd,text,next_step,artifacts,ts FROM checkpoints WHERE issue=? ORDER BY seq DESC LIMIT 1',a.id);
    const cp = checkpoint ? this.checkpointInfo(this.issue(a.id),checkpoint,task.revision) : null;
    const cursor = this.row('SELECT COALESCE(MAX(seq),0) n FROM events WHERE issue=?',a.id)?.n ?? 0;
    return {id:a.id,text:contractText,tokens,exact:true,omitted,checkpoint:cp,cursor,contract_text:contractText,revision:task.revision,task:body,structured:body,encoding:enc,max_tokens:max ?? null,used_tokens:tokens,mandatory_tokens:tokens,anchors:[],priors:null};
  }
  private eligible(task: Obj,a: Obj): boolean {
    if ((task.status !== 'open' && task.status !== 'deferred' && !(task.status === 'in_progress' && Number(task.lease_until) <= now())) || this.cancelled(task.id)) return false;
    if (task.type === 'goal' || task.type === 'epic') {
      if (a.finalize !== true || !object(this.operation('goal_done',{id:task.id},this.context({},{}))).done) return false;
    } else if (this.row(`SELECT 1 FROM issues i WHERE ${childWhere()}`,task.id,task.id,task.id)) return false;
    if (!text(task.oracle_cmd).trim() || Number(task.defer_until ?? 0) > now() || task.status === 'deferred' && task.defer_until == null || task.expires_at != null && Number(task.expires_at) <= now()) return false;
    if (a.lane != null && a.lane !== task.lane) return false;
    if (a.goal != null && !this.row(`WITH RECURSIVE sub(x) AS (SELECT ? UNION SELECT i.id FROM issues i JOIN sub s ON json_extract(i.meta_json,'$.parent')=s.x OR (i.id LIKE s.x||'.%' AND instr(substr(i.id,length(s.x)+2),'.')=0)) SELECT 1 FROM sub WHERE x=?`,a.goal,task.id)) return false;
    return this.row(`SELECT 1 FROM issues i WHERE i.id=? AND ${blocked}`,task.id) !== undefined;
  }
  private grant(cmd: string,a: Obj,c: Context): Value {
    const who = this.who(a,c), lifetime = ttl(a);
    if (a.finalize === true && !a.id) fail('bad_args','finalize requires explicit id');
    const candidates = a.id ? [this.issue(a.id)] : this.issues(`SELECT i.* FROM issues i WHERE i.status IN ('open','deferred','in_progress') AND (i.status!='in_progress' OR COALESCE(i.lease_until,0)<=?) AND COALESCE(i.type,'task') NOT IN ('goal','epic') AND ${blocked} ORDER BY CASE WHEN i.status='in_progress' THEN 1 ELSE 0 END,i.priority,i.created_at,i.id`,now());
    for (const task of candidates) {
      if (!this.eligible(task,a)) continue;
      const brief = cmd === 'acquire' ? this.brief({...a,id:task.id}) : undefined;
      this.run('DELETE FROM claims WHERE issue=?',task.id);
      this.run("UPDATE issues SET status='in_progress',claim_actor=?,lease_until=?,lease_epoch=lease_epoch+1 WHERE id=?",who,now()+lifetime,task.id);
      const updated = this.issue(task.id), claimId = uid('claim-');
      this.run('INSERT INTO claims(actor,issue,claim_id,epoch,hb_at,run_id) VALUES(?,?,?,?,?,?)',who,task.id,claimId,updated.lease_epoch,now(),c.run_id);
      this.emit(cmd,task.id ?? null,c,{claim_id:claimId,epoch:updated.lease_epoch});
      this.run('INSERT INTO agent_state(issue,attempt,last_error) VALUES(?,0,NULL) ON CONFLICT(issue) DO UPDATE SET attempt=agent_state.attempt+1,last_error=NULL',task.id);
      const autorun = object(task.meta).autorun, command = typeof autorun === 'string' ? autorun : text(object(autorun).cmd);
      if (command) this.run("INSERT INTO outbox(kind,payload,run_id) VALUES('autorun',?,?)",canonical({issue:task.id,actor:who,epoch:updated.lease_epoch,cmd:command,cwd:object(autorun).cwd ?? null}),c.run_id);
      return {id:task.id,claim_id:claimId,epoch:updated.lease_epoch,lease_until:updated.lease_until,revision:this.revision(task.id),...(brief ? {contract:brief} : {}),...(command ? {autorun:true} : {})};
    }
    if (cmd === 'claim' || a.id) fail('not_claimable','issue is not a ready executable leaf');
    return {id:null};
  }
  private recordedCost(id: Value | undefined): number { return Number(this.row("WITH RECURSIVE sub(id) AS (SELECT ? UNION SELECT i.id FROM issues i JOIN sub s ON json_extract(i.meta_json,'$.parent')=s.id OR (i.id LIKE s.id||'.%' AND instr(substr(i.id,length(s.id)+2),'.')=0)) SELECT COALESCE(SUM(CASE WHEN cents>0 THEN cents ELSE 0 END),0) n FROM costs WHERE issue IN(SELECT id FROM sub)",id)?.n ?? 0); }
  private localZero(task: Obj): boolean {
    if(object(task.meta).local_zero!==true)return false;
    if(task.budget_eur!==0)fail('local_zero_budget','local_zero requires budget_eur exactly 0');
    if(this.recordedCost(task.id)>0)fail('budget_exceeded','local_zero refuses recorded positive costs');
    if(!localZeroAvailable())fail('local_zero_unavailable','local_zero requires macOS sandbox-exec');
    return true;
  }
  deliveryFence(a: Obj,state?: string): Obj | undefined {
    if(!this.row("SELECT name FROM sqlite_master WHERE type='table' AND name='sis_ts_delivery_leases'"))return;
    const lease=this.row('SELECT actor,epoch,lease_until FROM sis_ts_delivery_leases WHERE outbox_id=?',a.id);
    if(!lease)return;
    if(a.actor!==lease.actor||a.epoch!==lease.epoch||Number(lease.lease_until)<=now())fail('stale_fence','outbox actor, delivery epoch and live lease required');
    if(state){const current=this.row('SELECT state FROM outbox WHERE id=?',a.id)?.state;if(current!=='running'&&current!==state)fail('stale_fence','delivery finalized with a different outcome');}
    return lease;
  }
  private autorunDelivery(a: Obj,c: Context,cmd: string,remaining: number): void {
    if(a.outbox_id===undefined)return;
    const lease=this.deliveryFence({id:a.outbox_id,actor:a.delivery_actor,epoch:a.delivery_epoch});
    if(!lease||c.idem!==`outbox-${String(a.outbox_id)}-delivery-${String(a.delivery_epoch)}`||Number(lease.lease_until)<=now()+remaining)fail('stale_fence','matching delivery idempotency key and sufficient lease required');
    const payload=object(decode(this.row("SELECT payload FROM outbox WHERE id=? AND kind='autorun' AND state='running'",a.outbox_id)?.payload));
    if(payload.issue!==a.id||payload.actor!==c.actor||payload.epoch!==a.epoch||payload.cmd!==cmd||typeof payload.cwd==='string'&&resolve(payload.cwd)!==resolve(text(a.cwd,this.projectRoot())))fail('stale_fence','execution does not match leased job');
  }
  async verify(a: Obj,c: Context): Promise<Value> {
    const task = this.active(a,c); this.expected(a);const localZero=this.localZero(task);
    const oracle = text(task.oracle_cmd); if (!oracle.trim()) fail('missing_oracle','executable oracle required');
    const revision = this.revision(a.id), before = fingerprint(task,required(a,'cwd'),this.dbPath);
    const result = await execute(oracle,before.cwd,integer(a.timeout_secs,'timeout_secs',10,1,300),localZero);
    return this.db.transaction(() => {
      const current = this.active(a,c), after = fingerprint(current,before.cwd,this.dbPath);this.localZero(current);
      if (revision !== this.revision(a.id) || before.source_hash !== after.source_hash) fail('stale_proof','contract or source changed during verification');
      const proof = uid('proof-'), passed = result.exit_code === 0 && !result.timed_out;
      this.run('INSERT INTO proofs(proof_id,issue,actor,epoch,revision,source_hash,cwd,oracle,exitcode,passed,timed_out,output,review_receipt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',proof,a.id,c.actor,a.epoch,revision,before.source_hash,before.cwd,oracle,result.exit_code,passed,result.timed_out,result.output,canonical(redact(a.review_receipt ?? null)));
      const out = {proof_id:proof,passed,exit_code:result.exit_code,timed_out:result.timed_out,revision,source_hash:before.source_hash,...(result.execution?{execution:result.execution}:{})};
      this.emit('verify',a.id ?? null,c,out); this.run('UPDATE agent_state SET last_error=? WHERE issue=?',passed ? null : result.output,a.id);
      return this.save('verify',c,out);
    });
  }
  async attestRun(a: Obj,c: Context): Promise<Value> {
    const task = this.active(a,c), before = fingerprint(task,text(a.cwd,this.projectRoot()),this.dbPath), revision = this.revision(a.id);this.expected(a);const localZero=this.localZero(task);
    if (Buffer.byteLength(canonical(a.payload ?? null)) > 65536) fail('bad_args','payload exceeds 64 KiB');
    const cmd = required({cmd:a.cmd ?? object(a.payload).cmd},'cmd');
    if (Buffer.byteLength(cmd) > 8192) fail('bad_args','run cmd exceeds 8 KiB');
    const policy=object(task.meta),execution=object(policy.execution);let matches=false;try{matches=typeof execution.cwd==='string'&&fingerprint(task,execution.cwd,this.dbPath).cwd===before.cwd;}catch{/* Unavailable execution directory is not trusted. */}
    if(localZero&&Object.hasOwn(policy,'execution')&&(execution.cmd!==cmd||!matches))fail('execution_mismatch','run cmd/cwd differs from meta.execution');
    const seconds=integer(a.timeout_secs,'timeout_secs',10,1,60);this.autorunDelivery(a,c,cmd,seconds+2);
    const effectKey=a.outbox_id===undefined?null:`sis:autorun-effect:${String(a.outbox_id)}`;
    if(effectKey)this.db.transaction(()=>{
      this.active(a,c);this.autorunDelivery(a,c,cmd,seconds+2);
      if(this.row('SELECT 1 FROM kv WHERE k=?',effectKey))fail('execution_uncertain','effect already started; reconcile its durable receipt before retry');
      // Commit before spawn: a lost controller must never imply that no effect occurred.
      this.run('INSERT INTO kv(k,v) VALUES(?,?)',effectKey,canonical({state:'started'}));
    });
    const result = await execute(cmd,before.cwd,seconds,localZero);
    return this.db.transaction(() => {
      const current = this.active(a,c);this.localZero(current);this.autorunDelivery(a,c,cmd,0);
      if (revision !== this.revision(a.id) || fingerprint(current,before.cwd,this.dbPath).source_hash !== before.source_hash) fail('stale_proof','source changed during run');
      const receipt=this.storeAttest(a,c,revision,before,{passed:result.exit_code === 0 && !result.timed_out,cmd,exit_code:result.exit_code,timed_out:result.timed_out,output:result.output,...(result.execution?{execution:result.execution}:{})});
      if(effectKey)this.run('UPDATE kv SET v=? WHERE k=?',canonical({state:'complete',receipt}),effectKey);
      return this.save('attest',c,receipt);
    });
  }
  storeAttest(a: Obj,c: Context,revision: string,source: {source_hash:string;cwd:string},summary: Obj): Value {
    const id = uid('attest-'), passed = summary.passed === true, kind = required(a,'kind');
    this.run('INSERT INTO attests(attest_id,issue,actor,epoch,revision,source_hash,cwd,kind,payload,summary,passed,ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',id,a.id,c.actor,a.epoch,revision,source.source_hash,source.cwd,kind,canonical(redact(a.payload ?? null)),canonical(summary),passed,now());
    const out = {attest_id:id,passed,kind,revision,source_hash:source.source_hash,summary}; this.emit('attest',a.id ?? null,c,out); return out;
  }
  projectRoot(): string { return basename(dirname(this.dbPath)) === '.sis' ? dirname(dirname(this.dbPath)) : dirname(this.dbPath); }
  private close(a: Obj,c: Context): Value {
    const task = this.issue(required(a,'id')), who = this.who(a,c), epoch = integer(a.epoch,'epoch');
    if (task.status !== 'closed') this.active(a,c);
    else if (task.lease_epoch !== epoch) fail('stale_fence','closed claim differs');
    if (this.cancelled(a.id)) fail('cancel_requested','task cancellation requested');
    const proof = this.row('SELECT * FROM proofs WHERE proof_id=? AND issue=?',a.proof_id,a.id);
    if (!proof || !proof.passed) fail('proof_required','successful stored proof_id required');
    let source: ReturnType<typeof fingerprint>;
    try { source = fingerprint(task,text(proof.cwd),this.dbPath); } catch { return fail('stale_proof','proof source unavailable'); }
    if (proof.actor !== who || proof.epoch !== epoch || proof.revision !== this.revision(a.id) || (proof.source_hash !== source.source_hash && proof.source_hash !== source.legacy_source_hash) || proof.oracle !== task.oracle_cmd) fail('stale_proof','proof does not match current contract/source/claim');
    if (task.status === 'closed') return {ok:true};
    const meta = object(task.meta);
    if (meta.review_required === true) {
      const r = object(decode(proof.review_receipt));
      if (!text(r.reviewer).trim() || r.reviewer === who || r.verdict !== 'pass' || r.revision !== proof.revision || r.source_hash !== proof.source_hash || !text(r.artifact,text(r.artifact_ref)).trim()) fail('review_required','matching independent review receipt required');
    }
    if (Object.hasOwn(meta,'attest_required')) {
      const requiredKinds = meta.attest_required;
      if (requiredKinds !== true && typeof requiredKinds !== 'string' && (!Array.isArray(requiredKinds) || requiredKinds.some(kind=>typeof kind !== 'string'))) fail('bad_args','meta.attest_required must be true, string or string array');
      const kinds = typeof requiredKinds === 'string' ? [requiredKinds] : array(requiredKinds);
      const have = this.rows('SELECT kind FROM attests WHERE issue=? AND revision=? AND source_hash IN (?,?) AND passed=1',a.id,proof.revision,source.source_hash,source.legacy_source_hash).map(r=>r.kind);
      if (!have.length || kinds.some(k=>!have.includes(k))) fail('attest_required','matching current-source attest required');
    }
    this.localZero(task);
    if (meta.budget_gate === true) {
      if(task.budget_eur==null)fail('budget_missing','budget_gate requires an explicit budget');
      const spent = Number(this.row("WITH RECURSIVE sub(id) AS (SELECT ? UNION SELECT i.id FROM issues i JOIN sub s ON json_extract(i.meta_json,'$.parent')=s.id OR (i.id LIKE s.id||'.%' AND instr(substr(i.id,length(s.id)+2),'.')=0)) SELECT COALESCE(SUM(c.cents),0) n FROM costs c WHERE c.issue IN (SELECT id FROM sub)",a.id)?.n ?? 0);
      const budget = Math.trunc(Number(task.budget_eur ?? 0)*100);
      if (spent > budget) fail('budget_exceeded',`cost rollup ${spent}c exceeds budget ${budget}c`);
    }
    if ((task.type === 'goal' || task.type === 'epic') && object(this.operation('goal_done',{id:task.id},c)).done !== true) fail('children_open','container children still open');
    this.run("UPDATE issues SET status='closed',closed_at=?,claim_actor=NULL,lease_until=NULL WHERE id=?",now(),a.id); this.run('DELETE FROM claims WHERE issue=?',a.id);
    this.emit('close',a.id ?? null,c,{proof_id:proof.proof_id,reason:a.reason ?? null,epoch});
    this.run("INSERT INTO outbox(kind,payload,run_id) VALUES('lesson',?,?)",canonical({issue:a.id,type:task.type,lesson:`closed ${a.id} (${task.type}): ${task.title}`,reason:a.reason ?? null,actor:who,proof_id:proof.proof_id}),c.run_id);
    return {ok:true};
  }
  private list(a: Obj,readyOnly = false,countOnly = false): Value {
    let where = readyOnly ? ` WHERE ${ready} AND ${blocked}` : ' WHERE 1=1';
    const params: unknown[] = readyOnly ? [now(),now(),now()] : [];
    for (const key of readyOnly ? ['lane'] : ['status','type','lane','owner','priority']) if (a[key] != null) { where += ` AND i.${key}=?`; params.push(key === 'priority' ? integer(a[key],'priority',undefined,-2147483648) : a[key]); }
    if (a.label != null) { where += " AND EXISTS(SELECT 1 FROM json_each(i.meta_json,'$.labels') l WHERE l.value=?)"; params.push(a.label); }
    if (a.q != null) { where += ' AND (i.title LIKE ? OR i."desc" LIKE ?)'; params.push('%'+text(a.q)+'%','%'+text(a.q)+'%'); }
    if (a.goal != null) { where += ` AND i.id IN (WITH RECURSIVE sub(x) AS (SELECT ? UNION SELECT i.id FROM issues i JOIN sub s ON json_extract(i.meta_json,'$.parent')=s.x OR (i.id LIKE s.x||'.%' AND instr(substr(i.id,length(s.x)+2),'.')=0)) SELECT x FROM sub)`; params.push(a.goal); }
    if (countOnly) return this.row('SELECT COUNT(*) n FROM issues i'+where,...params)?.n ?? 0;
    if (a.cursor != null && a.cursor !== '') {
      const cursor = object(decode(a.cursor));
      if (!Number.isSafeInteger(cursor.priority) || typeof cursor.created_at !== 'number' || !Number.isFinite(cursor.created_at) || typeof cursor.id !== 'string') fail('bad_cursor','malformed cursor');
      where += ' AND (i.priority,i.created_at,i.id)>(?,?,?)'; params.push(cursor.priority,cursor.created_at,cursor.id);
    }
    const limit = integer(a.limit,'limit',1000,1,1000);
    let rows = this.issues('SELECT i.* FROM issues i'+where+' ORDER BY i.priority,i.created_at,i.id LIMIT ?',...params,limit+1);
    const more = rows.length > limit; rows = rows.slice(0,limit);
    const last = rows.at(-1), cursor = more && last ? canonical({priority:last.priority,created_at:last.created_at,id:last.id}) : null;
    if (a.fields !== undefined) {
      if (!Array.isArray(a.fields) || a.fields.some(k=>typeof k !== 'string' || !issueFields.includes(k) && k !== 'meta_json')) fail('bad_args','invalid issue fields');
      rows = rows.map(row=>Object.fromEntries(array(a.fields).map(k=>[text(k),row[text(k)]])));
    } else for (const row of rows) { row.run_state = this.state(row); const change = this.row("SELECT data_json FROM events WHERE issue=? AND op='changes' ORDER BY seq DESC LIMIT 1",row.id); if (change) row.changes = object(decode(change.data_json)).files; }
    return a.paginate === true || Object.hasOwn(a,'cursor') ? {items:rows,next_cursor:cursor} : rows;
  }
  operation(cmd: string,a: Obj,c: Context): Value {
    switch (cmd) {
      case 'create': {
        const title = required(a,'title'), id = a.id === undefined ? uid() : required(a,'id');
        if (this.row('SELECT 1 FROM issues WHERE id=?',id)) fail('exists',id);
        if (a.budget_eur != null) number(a.budget_eur,'budget_eur',undefined,0);
        if (a.allowed_paths !== undefined) paths(a.allowed_paths);
        if(a.meta!==undefined&&(a.meta===null||typeof a.meta!=='object'||Array.isArray(a.meta)))fail('bad_args','meta must be an object');
        const meta = {...object(a.meta)}; if (a.parent) meta.parent = a.parent;
        this.run('INSERT INTO issues(id,title,"desc",type,priority,status,owner,oracle_cmd,allowed_paths,lane,budget_eur,acceptance,created_at,meta_json,lease_epoch,defer_until,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)',id,title,a.desc ?? a.descr ?? '',a.type ?? 'task',integer(a.priority ?? a.prio,'priority',2,-2147483648),a.status === 'deferred' ? 'deferred' : 'open',a.owner,a.oracle_cmd,a.allowed_paths,a.lane,a.budget_eur,a.acceptance,now(),canonical(meta),a.defer_until,a.expires_at ?? (a.ttl_secs != null ? now()+number(a.ttl_secs,'ttl_secs',undefined,0) : null));
        this.emit('create',id,c,{title}); return {id};
      }
      case 'update': case 'admin_update': {
        const task = this.issue(required(a,'id'));
        const changes: Obj = {}, rename: Record<string,string> = {descr:'desc',prio:'priority',meta:'meta_json'};
        if (typeof a.field === 'string') changes[rename[a.field] ?? a.field] = a.value;
        if (cmd === 'admin_update') required(a,'reason');
        for (const [key,value] of Object.entries({...object(a.set),...a})) if (editable.has(rename[key] ?? key) || cmd === 'admin_update' && ['status','closed_at','lease_until','claim_actor'].includes(key)) changes[rename[key] ?? key] = value;
        if (!Object.keys(changes).length) fail('bad_args','nothing to update');
        for (const key of Object.keys(changes)) {
          if (!editable.has(key) && !(cmd === 'admin_update' && ['status','closed_at','lease_until','claim_actor'].includes(key))) fail('protected_field',key);
          if (key === 'status' && !statuses.includes(text(changes[key]))) fail('bad_args','invalid status');
        }
        if (task.status === 'in_progress' && cmd !== 'admin_update') this.active(a,c);
        if (changes.allowed_paths !== undefined) paths(changes.allowed_paths);
        if (changes.budget_eur != null) number(changes.budget_eur,'budget_eur',undefined,0);
        if(cmd!=='admin_update'){
          if(Object.hasOwn(changes,'budget_eur')&&task.budget_eur!=null&&(changes.budget_eur==null||Number(changes.budget_eur)>Number(task.budget_eur)))fail('over_budget','worker budget cannot increase');
          if(Object.hasOwn(changes,'meta_json')){const meta=typeof changes.meta_json==='string'?decode(changes.meta_json):changes.meta_json;if(meta===null||typeof meta!=='object'||Array.isArray(meta))fail('bad_args','meta must be an object');for(const key of ['controller','local_zero','execution','budget_gate','review_required','attest_required'])if(canonical(object(meta)[key])!==canonical(object(task.meta)[key]))fail('protected_field','security metadata requires admin_update');}
        }
        this.expected(a);
        const keys = Object.keys(changes); this.run('UPDATE issues SET '+keys.map(k=>`"${k}"=?`).join(',')+' WHERE id=?',...keys.map(k=>changes[k]),a.id);
        this.emit(cmd,a.id ?? null,c,{fields:keys.sort(),reason:a.reason ?? null}); return {ok:true};
      }
      case 'dep': {
        const deps = a.deps === undefined ? [a] : array(a.deps).map(object);
        for (const d of deps) {
          const id = required(d,'issue'), on = required(d,'depends_on'), kind = text(d.type,text(a.type,'blocks'));
          if (kind === 'blocks' && (id === on || this.row("WITH RECURSIVE anc(x) AS (SELECT ? UNION SELECT depends_on FROM deps d JOIN anc x ON d.issue=x.x WHERE COALESCE(d.type,'blocks')='blocks') SELECT 1 FROM anc WHERE x=?",on,id))) fail('dep_cycle','dependency cycle');
          this.run('INSERT OR REPLACE INTO deps(issue,depends_on,type) VALUES(?,?,?)',id,on,kind); this.emit('dep',id,c,{depends_on:on,type:kind});
        }
        return {ok:true,n:deps.length};
      }
      case 'dep_list': { const id = a.id ?? a.issue; return this.rows('SELECT issue,depends_on,COALESCE(type,\'blocks\') type FROM deps'+(id ? ' WHERE issue=? OR depends_on=?' : '')+' ORDER BY issue,depends_on',...(id ? [id,id] : [])); }
      case 'dep_remove': { const id = required(a,'issue'), on = required(a,'depends_on'); if (!this.run('DELETE FROM deps WHERE issue=? AND depends_on=?',id,on).changes) fail('not_found','dependency'); this.emit(cmd,id,c,{depends_on:on}); return {ok:true}; }
      case 'ready': return this.list(a,true);
      case 'list': return this.list(a);
      case 'count': return {count:this.list(a,false,true)};
      case 'claim': case 'claim_next': case 'acquire': return this.grant(cmd,a,c);
      case 'heartbeat': { this.active(a,c,true); const until = now()+ttl(a); this.run('UPDATE issues SET lease_until=? WHERE id=?',until,a.id); this.run('UPDATE claims SET hb_at=? WHERE issue=? AND actor=?',now(),a.id,c.actor); this.emit(cmd,a.id ?? null,c,{epoch:a.epoch}); return {ok:true,lease_until:until,cancel_requested:this.cancelled(a.id)}; }
      case 'unclaim': { this.active(a,c,true); this.run("UPDATE issues SET status='open',claim_actor=NULL,lease_until=NULL,lease_epoch=lease_epoch+1 WHERE id=?",a.id); this.run('DELETE FROM claims WHERE issue=?',a.id); this.emit(cmd,a.id ?? null,c,{}); return {ok:true}; }
      case 'reclaim': { const rows = this.rows("UPDATE issues SET status='open',claim_actor=NULL,lease_until=NULL,lease_epoch=lease_epoch+1 WHERE status='in_progress' AND lease_until<? RETURNING id",now()); for (const row of rows) { this.run('DELETE FROM claims WHERE issue=?',row.id); this.emit(cmd,row.id ?? null,c,{}); } return {reclaimed:rows.map(r=>r.id ?? null)}; }
      case 'close': return this.close(a,c);
      case 'reopen': {
        const task = this.issue(required(a,'id')), who = this.who(a,c); if (who !== task.owner && who !== object(task.meta).controller) admin(a);
        if (a.epoch !== undefined && integer(a.epoch,'epoch') !== task.lease_epoch) fail('stale_fence','epoch differs');
        this.run("UPDATE issues SET status='open',closed_at=NULL,claim_actor=NULL,lease_until=NULL,lease_epoch=lease_epoch+1 WHERE id=?",a.id); this.run('DELETE FROM claims WHERE issue=?',a.id); this.run('INSERT INTO cancellations(issue,requested,actor,ts) VALUES(?,0,?,?) ON CONFLICT(issue) DO UPDATE SET requested=0',a.id,who,now()); this.emit(cmd,a.id ?? null,c,{reason:a.reason ?? null}); return {ok:true};
      }
      case 'delete': case 'defer': case 'undefer': case 'rename': {
        const id = cmd === 'rename' ? required(a,'from') : required(a,'id'), task = this.issue(id);
        if (task.status === 'in_progress') this.active({...a,id},c,true);
        if (cmd === 'delete') { this.run('DELETE FROM deps WHERE issue=? OR depends_on=?',id,id); this.run('DELETE FROM claims WHERE issue=?',id); this.run('DELETE FROM issues WHERE id=?',id); }
        else if (cmd === 'rename') { const to = required(a,'to'); if (this.row('SELECT id FROM issues WHERE id=?',to)) fail('exists',to); this.run('UPDATE issues SET id=? WHERE id=?',to,id); this.run("UPDATE issues SET meta_json=json_set(meta_json,'$.parent',?) WHERE json_extract(meta_json,'$.parent')=?",to,id); this.run('UPDATE deps SET issue=? WHERE issue=?',to,id); this.run('UPDATE deps SET depends_on=? WHERE depends_on=?',to,id); this.run('UPDATE claims SET issue=? WHERE issue=?',to,id); this.emit(cmd,to,c,{from:id}); return {id:to}; }
        else this.run('UPDATE issues SET status=?,defer_until=? WHERE id=?',cmd === 'defer' ? 'deferred' : 'open',cmd === 'defer' ? a.until ?? a.defer_until : null,id);
        this.emit(cmd,id,c,{}); return {ok:true};
      }
      case 'show': { const task = this.issue(required(a,'id')), contract = this.contract(a.id); task.run_state = this.state(task); const change = this.row("SELECT data_json FROM events WHERE issue=? AND op='changes' ORDER BY seq DESC LIMIT 1",a.id); if (change) task.changes = object(decode(change.data_json)).files; return {issue:task,deps:this.rows('SELECT depends_on,type FROM deps WHERE issue=?',a.id),blocked_by:contract.blocked_by,revision:contract.revision,events_tail:this.events(a.id,0,integer(a.limit,'limit',100,1,1000)),attests:this.rows('SELECT * FROM attests WHERE issue=? ORDER BY ts DESC LIMIT 10',a.id)}; }
      case 'search': { const query = required(a,'q'), limit = integer(a.limit,'limit',20,1,1000); try { return this.issues('SELECT i.* FROM issues_fts JOIN issues i ON i.rowid=issues_fts.rowid WHERE issues_fts MATCH ? ORDER BY rank,i.created_at LIMIT ?',query,limit); } catch { return this.issues('SELECT * FROM issues WHERE title LIKE ? OR "desc" LIKE ? OR acceptance LIKE ? ORDER BY priority,created_at LIMIT ?','%'+query+'%','%'+query+'%','%'+query+'%',limit); } }
      case 'children': return this.issues(`SELECT i.* FROM issues i WHERE ${childWhere()} ORDER BY priority,created_at,id`,required(a,'id'),a.id,a.id);
      case 'label': { const task = this.issue(required(a,'id')), meta = {...object(task.meta)}; const labels = new Set(array(meta.labels).map(v=>text(v))); for (const label of typeof a.add === 'string' ? [a.add] : array(a.add).map(v=>text(v))) labels.add(label); for (const label of typeof a.remove === 'string' ? [a.remove] : array(a.remove).map(v=>text(v))) labels.delete(label); meta.labels = [...labels]; this.run('UPDATE issues SET meta_json=? WHERE id=?',canonical(meta),a.id); this.emit(cmd,a.id ?? null,c,{labels:meta.labels}); return {labels:meta.labels}; }
      case 'note': { this.issue(required(a,'id')); const value = required(a,'text'); this.emit(cmd,a.id ?? null,c,{text:value}); return {ok:true}; }
      case 'comments': return this.events(required(a,'id')).filter(e=>e.op==='note').map(e=>({ts:e.ts,actor:e.actor,text:object(e.data).text}));
      case 'history': return this.events(required(a,'id'));
      case 'checkpoint': case 'handoff': {
        const message = required(a,'text'), next = required(a,'next_step'); if (!Array.isArray(a.artifacts ?? [])) fail('bad_args','artifacts must be an array');
        if (Buffer.byteLength(canonical({text:message,next_step:next,artifacts:a.artifacts ?? []})) > 16384) fail('bad_args','checkpoint exceeds 16 KiB');
        const task = this.active(a,c); this.expected(a); const source = fingerprint(task,text(a.cwd,this.projectRoot()),this.dbPath), revision = this.revision(a.id);
        const receipt = this.run('INSERT INTO checkpoints(issue,actor,epoch,revision,source_hash,cwd,text,next_step,artifacts,ts) VALUES(?,?,?,?,?,?,?,?,?,?)',a.id,c.actor,a.epoch,revision,source.source_hash,source.cwd,message,next,canonical(a.artifacts ?? []),now());
        this.emit('checkpoint',a.id ?? null,c,{checkpoint_id:Number(receipt.lastInsertRowid),revision,source_hash:source.source_hash});
        if (cmd === 'handoff') { this.operation('unclaim',a,c); this.emit('handoff',a.id ?? null,c,{to:a.to ?? null,next_step:next}); }
        return {ok:true,checkpoint_id:Number(receipt.lastInsertRowid),revision,source_hash:source.source_hash,...(cmd === 'handoff' ? {released:true} : {})};
      }
      case 'resume': { const task = this.issue(required(a,'id')), events = this.events(a.id,integer(a.since,'since',0),100), checkpoint = this.row('SELECT * FROM checkpoints WHERE issue=? ORDER BY seq DESC LIMIT 1',a.id); const cp = checkpoint ? this.checkpointInfo(task,checkpoint,this.revision(a.id)) : null; const changes = this.row("SELECT data_json FROM events WHERE issue=? AND op='changes' ORDER BY seq DESC LIMIT 1",a.id); return {id:a.id,contract:this.operation('contract',a,c),checkpoint:cp,cancel_requested:this.cancelled(a.id),attempt:this.row('SELECT attempt FROM agent_state WHERE issue=?',a.id)?.attempt ?? 0,last_error:this.row('SELECT last_error FROM agent_state WHERE issue=?',a.id)?.last_error ?? null,changes:changes ? decode(changes.data_json) : null,run_state:this.state(task),events,cursor:events.at(-1)?.seq ?? a.since ?? 0}; }
      case 'cancel': { const task = this.issue(required(a,'id')), who = this.who(a,c); if (who !== object(task.meta).controller) this.active(a,c,true); this.run('INSERT INTO cancellations(issue,requested,actor,ts) VALUES(?,1,?,?) ON CONFLICT(issue) DO UPDATE SET requested=1,actor=excluded.actor,ts=excluded.ts',a.id,who,now()); this.emit(cmd,a.id ?? null,c,{}); return {ok:true,cancel_requested:true}; }
      case 'cancel_ack': { this.active(a,c,true); if (!this.cancelled(a.id)) fail('bad_state','cancellation intent required'); this.run("UPDATE issues SET status='cancelled',claim_actor=NULL,lease_until=NULL,lease_epoch=lease_epoch+1 WHERE id=?",a.id); this.run('DELETE FROM claims WHERE issue=?',a.id); this.emit(cmd,a.id ?? null,c,{}); return {ok:true}; }
      case 'contract': { const task = this.contract(required(a,'id')); return {contract_text:JSON.stringify(JSON.parse(canonical(task)),null,2),revision:task.revision,task,structured:task,anchors:[],priors:null}; }
      case 'brief': return this.brief(a);
      case 'tokens': { const input = typeof a.text === 'string' ? a.text : fail('bad_args','text required'), enc = encoding(a); return {tokens:tokenCount(input,enc),encoding:enc,exact:true,algorithm:'tiktoken',billing:false}; }
      case 'capabilities': return {local_zero_execution:localZeroAvailable(),outbox_delivery_leases:true,watch_wait_frames:1,version:'0.8.0',implementation:'typescript',typescript:'7.1',protocol:2,schema:7,schema_version:Number(this.row('PRAGMA user_version')?.user_version),project_id:this.row("SELECT v FROM kv WHERE k='project_id'")?.v,operations:registry.map(op=>op.name ?? null),encodings:['o200k_base','cl100k_base'],proof_receipts:true,billing:false,token_billing:false,durability:this.row('PRAGMA synchronous')?.synchronous,...(a.schemas === true ? {ops:registry} : {})};
      case 'context': { const caps = object(this.operation('capabilities',a,c)); return {project_id:caps.project_id,pid:process.pid,instance_id:instanceId,db_path:resolve(this.dbPath),capabilities:caps,stats:this.operation('stats',a,c)}; }
      case 'watch': return {events:this.events(undefined,integer(a.after,'after',0),integer(a.limit,'limit',1000,1,1000))};
      case 'lint': return {needs_oracle:this.rows("SELECT id,title FROM issues WHERE status!='closed' AND (oracle_cmd IS NULL OR oracle_cmd='') AND (acceptance IS NULL OR acceptance='') ORDER BY priority").map(r=>({...r,missing:['oracle_cmd','acceptance']}))};
      case 'types': return ['task','bug','feature','epic','goal','chore','question','doc','decision','event'];
      case 'statuses': return statuses;
      case 'prime': return {protocol:'Superiss protocol 2; explicit project DB; NDJSON Unix socket or CLI',loop:'acquire -> work inside contract -> verify -> close(proof_id) -> readback',rules:['heartbeat before expiry','no mutation retry after uncertain transport','mandatory acceptance survives token budgets'],capabilities:this.operation('capabilities',{},c)};
      case 'orphans': return this.issues("WITH RECURSIVE live(id) AS (SELECT i.id FROM issues i WHERE i.status='open' AND (i.type='epic' OR NOT EXISTS(SELECT 1 FROM deps d WHERE d.issue=i.id)) UNION SELECT d.issue FROM deps d JOIN live l ON d.depends_on=l.id JOIN issues s ON s.id=d.issue WHERE s.status='open') SELECT * FROM issues WHERE status='open' AND id NOT IN(SELECT id FROM live)");
      case 'stats': { const by = Object.fromEntries(this.rows('SELECT status,COUNT(*) n FROM issues GROUP BY status').map(r=>[text(r.status),r.n])); return {total:Number(this.row('SELECT COUNT(*) n FROM issues')?.n),open:by.open ?? 0,in_progress:by.in_progress ?? 0,closed:by.closed ?? 0,deferred:by.deferred ?? 0,blocked:this.row(`SELECT COUNT(*) n FROM issues i WHERE status='open' AND NOT(${blocked})`)?.n,ready:this.row(`SELECT COUNT(*) n FROM issues i WHERE ${ready} AND ${blocked}`,now(),now(),now())?.n,pending_outbox:this.row("SELECT COUNT(*) n FROM outbox WHERE state='pending'")?.n}; }
      case 'review': return {stats:this.operation('stats',a,c),needs_oracle:object(this.operation('lint',a,c)).needs_oracle,stale:this.operation('stale',a,c),gates:this.operation('gate_list',a,c),slots:this.operation('slot_list',a,c),orphans:this.operation('orphans',a,c),pending_outbox:this.row("SELECT COUNT(*) n FROM outbox WHERE state='pending'")?.n};
      case 'stale': return this.issues("SELECT * FROM issues WHERE status='in_progress' AND lease_until<? ORDER BY lease_until",a.now ?? now());
      case 'remember': { const key = required(a,'key'); this.run('INSERT INTO memories(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',key,typeof a.value === 'string' ? a.value : canonical(a.value ?? null),now()); this.emit(cmd,null,c,{key}); return {ok:true}; }
      case 'recall': return this.rows('SELECT key,value,updated_at FROM memories'+(a.key != null ? ' WHERE key=?' : '')+' ORDER BY key',...(a.key != null ? [a.key] : []));
      case 'batch': { if (!Array.isArray(a.ops)) fail('bad_args','batch needs ops array'); const results = a.ops.map(item=>{ const op=object(item); return this.exec(required(op,'cmd'),op.args,{...c,idem:typeof op.idem === 'string' ? op.idem : null,run_id:typeof op.run_id === 'string' ? op.run_id : c.run_id}); }); return {results}; }
      case 'budget_claim': { const id = required(a,'issue'), eur = number(a.eur,'eur',undefined,0), task = this.issue(id); if (task.budget_eur != null && Number(task.budget_eur) < eur) fail('over_budget','requested budget exceeds balance'); if (task.budget_eur != null) this.run('UPDATE issues SET budget_eur=budget_eur-? WHERE id=?',eur,id); const remaining = task.budget_eur == null ? null : Number(task.budget_eur)-eur; this.emit(cmd,id,c,{eur,remaining}); return {ok:true,remaining}; }
      case 'outbox_list': return this.rows('SELECT * FROM outbox'+(a.state != null ? ' WHERE state=?' : '')+' ORDER BY id',...(a.state != null ? [a.state] : []));
      case 'outbox_done': case 'outbox_fail': { const id = integer(a.id,'id',undefined,-Number.MAX_SAFE_INTEGER);const lease=this.deliveryFence(a,cmd==='outbox_done'?'done':'failed'); const n = this.run(cmd === 'outbox_done' ? "UPDATE outbox SET state='done' WHERE id=?" : lease?"UPDATE outbox SET state='failed' WHERE id=?":"UPDATE outbox SET state='failed',attempts=attempts+1 WHERE id=?",id); if (!n.changes) fail('not_found','outbox row'); this.emit(cmd,null,c,{id,err:a.err ?? null}); return {ok:true}; }
      case 'compact': { const cutoff = now()-number(a.days,'days',30,0)*86400, archive = text(a.archive_path,this.dbPath+'.events-archive.jsonl'), rows = this.rows('SELECT * FROM events WHERE ts<? ORDER BY seq',cutoff); if (rows.length) { appendFileSync(archive,rows.map(canonical).join('\n')+'\n'); this.run('DELETE FROM events WHERE ts<?',cutoff); } const reaped = this.run('DELETE FROM issues WHERE expires_at IS NOT NULL AND expires_at<=?',now()).changes; return {archived:rows.length,kept:this.row('SELECT COUNT(*) n FROM events')?.n,reaped:Number(reaped),archive_path:archive}; }
      case 'gate': { const name = required(a,'name'); if (a.state != null) { if (!['open','closed'].includes(text(a.state))) fail('bad_args','gate state must be open or closed'); this.run('INSERT INTO gates(name,state,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET state=excluded.state,payload=excluded.payload,updated_at=excluded.updated_at',name,a.state,a.payload,now()); this.emit(cmd,null,c,{name,state:a.state}); } return {name,state:this.row('SELECT state FROM gates WHERE name=?',name)?.state ?? 'closed'}; }
      case 'gate_list': return this.rows('SELECT * FROM gates ORDER BY name');
      case 'slot_acquire': { const name = required(a,'name'), who = this.who(a,c), lifetime = ttl(a), slot = this.row('SELECT * FROM slots WHERE name=?',name); if (slot && Number(slot.lease_until)>now()) { if (slot.holder === who) return slot; fail('slot_held','slot held'); } const epoch = Number(slot?.epoch ?? 0)+1, until = now()+lifetime, claim = uid('slot-'); this.run('INSERT INTO slots(name,holder,epoch,lease_until,claim_id,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET holder=excluded.holder,epoch=excluded.epoch,lease_until=excluded.lease_until,claim_id=excluded.claim_id,updated_at=excluded.updated_at',name,who,epoch,until,claim,now()); this.emit(cmd,null,c,{name,epoch}); return {name,holder:who,epoch,lease_until:until,claim_id:claim}; }
      case 'slot_release': { const name = required(a,'name'), who = this.who(a,c), epoch = integer(a.epoch,'epoch'), slot = this.row('SELECT * FROM slots WHERE name=?',name); if (!slot) fail('not_found','slot'); if (slot.holder !== who || slot.epoch !== epoch || Number(slot.lease_until)<=now()) fail('stale_fence','slot holder, epoch and lease must match'); this.run('UPDATE slots SET holder=NULL,lease_until=NULL,claim_id=NULL,updated_at=? WHERE name=?',now(),name); this.emit(cmd,null,c,{name,epoch}); return {name,released:true}; }
      case 'slot_list': return this.rows('SELECT * FROM slots ORDER BY name');
      case 'goal': { const name = required(a,'name'), slug = name.toLowerCase().replaceAll('ä','ae').replaceAll('ö','oe').replaceAll('ü','ue').replaceAll('ß','ss').replace(/[^a-z0-9]+/gu,'-').replace(/^-|-$/gu,'').slice(0,40) || 'goal'; let id = text(a.id,'sis-'+slug); if (a.id == null) for (let n = 2; this.row('SELECT id FROM issues WHERE id=?',id); n++) id = 'sis-'+slug+'-'+n; const meta = {...object(a.meta),...(a.objective ? {objective:a.objective} : {}),...(a.target ? {target:a.target} : {})}; return this.operation('create',{...a,id,title:name,type:'goal',meta},c); }
      case 'sub': { const parent = required(a,'parent'); this.issue(parent); const suffixes = this.rows('SELECT id FROM issues WHERE id LIKE ?',parent+'.%').map(r=>text(r.id).slice(parent.length+1)).filter(s=>/^\d+$/u.test(s)).map(Number); const id = parent+'.'+(Math.max(0,...suffixes)+1); return this.operation('create',{...a,id,parent},c); }
      case 'plan': { let subs = array(a.subs); if (a.template) { const saved = this.row('SELECT value FROM memories WHERE key=?','template:'+text(a.template)); if (!saved) fail('not_found','plan template'); subs = array(object(decode(saved.value)).subs); } for (const [i,value] of subs.entries()) { const sub = object(value); if (sub.deps !== undefined && !Array.isArray(sub.deps)) fail('bad_args','deps must be array'); for (const d of array(sub.deps)) { integer(d,'dependency index',undefined,0,subs.length-1); if (d===i) fail('dep_cycle','self dependency'); } } const goal = object(this.operation('goal',a,c)).id, ids = subs.map(sub=>object(this.operation('sub',{...object(sub),parent:goal},c)).id ?? null); for (const [i,sub] of subs.entries()) for (const dep of array(object(sub).deps)) this.operation('dep',{issue:ids[i],depends_on:ids[Number(dep)]},c); if (a.save_as) this.operation('remember',{key:'template:'+text(a.save_as),value:{name:a.name,subs}},c); return {goal,name:a.name,children:ids}; }
      case 'goal_tree': { const tree = (task: Obj,seen: Set<string>): Obj => { const id=text(task.id); if (seen.has(id) || seen.size>10000) fail('dep_cycle','goal hierarchy cycle'); const next=new Set(seen).add(id); return {...task,children:array(this.operation('children',{id},c)).map(k=>tree(object(k),next))}; }; if (a.id) return tree(this.issue(a.id),new Set()); return this.issues("SELECT * FROM issues WHERE type='goal' AND status!='closed' ORDER BY priority,created_at").map(task=>tree(task,new Set())); }
      case 'goal_done': { const id = required(a,'id'), task = this.issue(id); const rows = this.rows(`WITH RECURSIVE sub(x) AS (SELECT i.id FROM issues i WHERE ${childWhere()} UNION SELECT i.id FROM issues i JOIN sub s ON json_extract(i.meta_json,'$.parent')=s.x OR (i.id LIKE s.x||'.%' AND instr(substr(i.id,length(s.x)+2),'.')=0)) SELECT id FROM issues WHERE id IN(SELECT x FROM sub) AND status!='closed' ORDER BY id`,id,id,id); return {id,done:rows.length===0,open:rows.map(r=>r.id ?? null),oracle_cmd:task.oracle_cmd,hint:rows.length ? 'children still open' : 'subtree closed; verify final oracle'}; }
      case 'epic': { const task = this.issue(required(a,'id')), children = array(this.operation('children',a,c)), counts: Obj = {total:children.length}; for (const child of children) { const key = text(object(child).status,'open'); counts[key]=Number(counts[key] ?? 0)+1; } counts.pct_done=children.length ? Math.floor(Number(counts.closed ?? 0)*100/children.length) : 0; return {issue:task,children,counts}; }
      case 'snapshot': return this.snapshot();
      default: return extension(this,cmd,a,c);
    }
  }
}
