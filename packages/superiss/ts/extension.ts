import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { junit } from './xml.ts';
import type { Engine, Context } from './engine.ts';
import { array, canonical, decode, digest, fail, fingerprint, git, integer, now, number, object, required, text, type Obj, type Value } from './util.ts';

export function extension(e: Engine,cmd: string,a: Obj,c: Context): Value {
  switch (cmd) {
    case 'dup_scan': {
      const tasks = a.id ? [e.issue(a.id)] : e.issues("SELECT * FROM issues WHERE status!='closed'"), all = e.issues("SELECT * FROM issues WHERE status!='closed'"), minimum = integer(a.min,'min',2,1);
      const words = (title: unknown) => new Set(text(title).toLowerCase().split(/[^a-z0-9]+/u).filter(w=>w.length>=4));
      const trigrams = (title: unknown) => { const s=text(title).toLowerCase(); return new Set(Array.from({length:Math.max(0,s.length-2)},(_,i)=>s.slice(i,i+3))); };
      const overlap = (x: Set<string>,y: Set<string>) => [...x].filter(w=>y.has(w)).length;
      const result: Obj[] = [];
      for (const task of tasks) for (const other of all) {
        if (task.id === other.id) continue;
        const x=words(task.title),y=words(other.title),shared=overlap(x,y); if (shared<minimum) continue;
        const tx=trigrams(task.title),ty=trigrams(other.title),tri=overlap(tx,ty), score=.6*shared/Math.max(1,x.size+y.size-shared)+.4*tri/Math.max(1,tx.size+ty.size-tri);
        if (score>=number(a.threshold,'threshold',0,0,1)) result.push({id:task.id,dup:other.id,shared,score:Math.round(score*1000)/1000,title:task.title,dup_title:other.title});
      }
      return result.sort((x,y)=>Number(y.shared)-Number(x.shared));
    }
    case 'changes': {
      e.issue(required(a,'id'));
      if (a.files !== undefined && !Array.isArray(a.files)) fail('bad_args','files must be an array');
      const files=array(a.files).slice(0,80), adds=files.reduce<number>((n,v)=>n+Number(object(v).adds ?? 0),0), dels=files.reduce<number>((n,v)=>n+Number(object(v).dels ?? 0),0), hash=digest(canonical(files)).slice(0,16);
      const last=e.row("SELECT data_json FROM events WHERE issue=? AND op='changes' ORDER BY seq DESC LIMIT 1",a.id);
      if (a.force !== true && a.patch == null && last && object(decode(last.data_json)).fingerprint===hash) return {id:a.id,files,adds,dels,unchanged:true};
      e.emit(cmd,a.id ?? null,c,{files,base:a.base ?? null,head:a.head ?? null,head_subject:a.head_subject ?? null,branch:a.branch ?? null,repo:a.repo ?? null,patch:a.patch ?? null,patch_truncated:a.patch_truncated ?? null,fingerprint:hash,summary:{files:files.length,adds,dels}});
      return {id:a.id,files,adds,dels};
    }
    case 'who': {
      const requested=resolve(text(a.repo,'.')), root=git(requested,'rev-parse','--show-toplevel')?.trim();
      if (!root) fail('not_a_git_repo',requested);
      const scope=e.rows("SELECT id,status,claim_actor,allowed_paths FROM issues WHERE status IN ('open','in_progress')");
      const events=e.rows("SELECT e.issue,e.actor,e.seq,e.data_json,i.status,i.claim_actor FROM events e JOIN issues i ON i.id=e.issue JOIN(SELECT issue,MAX(seq) s FROM events WHERE op='changes' GROUP BY issue) last ON last.issue=e.issue AND last.s=e.seq");
      const dirty: Obj[]=[], by=new Map<string,Obj>();
      const status=git(root,'status','--porcelain=v1','-z','-uall') ?? '';
      const entries=status.split('\0');
      for (let i=0;i<entries.length;i++) {
        const line=entries[i]; if (line.length<4) continue;
        const state=line.slice(0,2).trim(), path=line.slice(3), renamed=state.includes('R') ? entries[++i] : undefined;
        let claims=events.filter(event=>array(object(decode(event.data_json)).files).some(f=>object(f).path===path)).map(event=>({issue:event.issue,actor:event.actor,seq:event.seq,status:event.status,claim_actor:event.claim_actor,via:'changes'}));
        if (!claims.length) claims=scope.filter(row=>{
          const stored=text(row.allowed_paths), paths=stored.startsWith('[') ? array(decode(stored)).map(v=>text(v)) : [stored];
          return paths.some(s=>{const p=s.replace(/^\.\//u,'').replace(/\*\*$/u,'').replace(/\/$/u,''); return p && (path===p || path.startsWith(p+'/'));});
        }).map(row=>({issue:row.id,actor:null,seq:undefined,status:row.status,claim_actor:row.claim_actor,via:'scope'}));
        for (const claim of claims) { const key=text(claim.issue), item=by.get(key) ?? {issue:claim.issue,actor:claim.actor,status:claim.status,claim_actor:claim.claim_actor,files:0}; item.files=Number(item.files)+1; by.set(key,item); }
        dirty.push({path,status:state,claims,...(renamed ? {renamed_from:renamed} : {})});
      }
      const orphaned=dirty.filter(d=>!array(d.claims).length).map(d=>d.path ?? null);
      return {repo:root,head:git(root,'rev-parse','HEAD')?.trim() ?? null,branch:git(root,'branch','--show-current')?.trim() || null,dirty,summary:{dirty:dirty.length,matched:dirty.length-orphaned.length,by_issue:[...by.values()],orphaned}};
    }
    case 'export': {
      const issues=e.issues('SELECT * FROM issues ORDER BY created_at,id');
      if (a.format==='bd') return {format:'bd',n:issues.length,issues:issues.map(row=>({id:row.id,title:row.title,description:row.desc,status:row.status,issue_type:row.type,priority:row.priority,labels:array(object(row.meta).labels),created_at:row.created_at,closed_at:row.closed_at,acceptance:row.acceptance,oracle_cmd:row.oracle_cmd,owner:row.owner,lane:row.lane,dependencies:e.rows('SELECT issue issue_id,depends_on depends_on_id,type FROM deps WHERE issue=? ORDER BY depends_on',row.id)}))};
      const events=e.rows('SELECT * FROM events ORDER BY seq'); return {issues,deps:e.rows('SELECT * FROM deps ORDER BY issue,depends_on'),events,events_count:events.length};
    }
    case 'sync_export': {
      const issues=e.issues('SELECT * FROM issues ORDER BY id').map(row=>({...row,deps:e.rows('SELECT depends_on AS "on",COALESCE(type,\'blocks\') type FROM deps WHERE issue=? ORDER BY depends_on',row.id)}));
      return {k:'sis-sync',v:1,schema:7,project_id:e.row("SELECT v FROM kv WHERE k='project_id'")?.v,exported_at:now(),issues,memories:e.rows('SELECT * FROM memories ORDER BY key'),proofs:e.rows('SELECT * FROM proofs'),attests:e.rows('SELECT * FROM attests'),events:a.events===true ? e.events() : []};
    }
    case 'import': case 'sync_import': return importStore(e,cmd,a,c);
    case 'attest': {
      const task=e.active(a,c), source=fingerprint(task,text(a.cwd,e.projectRoot()),e.dbPath), revision=e.revision(a.id), kind=required(a,'kind');
      if (Buffer.byteLength(canonical(a.payload ?? null)) > 65536) fail('bad_args','payload exceeds 64 KiB');
      const payload=object(a.payload), args={...payload,...a};
      let summary: Obj;
      if (kind==='artifact') {
        const ref=required({ref:a.ref ?? payload.ref ?? a.path},'ref');
        summary={passed:true,ref,digest:payload.digest ?? null};
      } else if (kind==='coverage') {
        const percent=number(args.percent,'percent',undefined,0,100), minimum=number(args.min,'min',0);
        summary={passed:percent>=minimum,percent,min:minimum};
      } else if (kind==='smoke') {
        const url=required(args,'url'), status=integer(args.status,'status',undefined,100,599), expected=integer(args.expect,'expect',200,-Number.MAX_SAFE_INTEGER);
        summary={passed:status===expected,status,expect:expected,url};
      } else if (kind==='custom') {
        if (typeof args.passed!=='boolean') fail('bad_args','custom needs passed bool');
        summary={passed:args.passed,note:args.note ?? null};
      } else if (kind==='junit') {
        const root=realpathSync(source.cwd), path=realpathSync(resolve(root,required(args,'path')));
        if ((path!==root && !path.startsWith(root+sep)) || !statSync(path).isFile()) fail('bad_args','junit path must be a file inside cwd');
        if (statSync(path).size > 4*1024*1024) fail('bad_args','junit file exceeds 4 MiB');
        summary=junit(readFileSync(path,'utf8'));
      } else fail('bad_args','unknown attest kind');
      return e.storeAttest(a,c,revision,source,summary);
    }
    case 'cost_add': {
      const issue=required(a,'issue'); e.issue(issue);
      const tokensIn=integer(a.tokens_in,'tokens_in',0), tokensOut=integer(a.tokens_out,'tokens_out',0), cents=a.cents===undefined ? Math.round(number(a.eur,'eur',0,0)*100) : integer(a.cents,'cents',0), currency=text(a.currency,'EUR');
      if (!/^[A-Z]{3}$/u.test(currency)) fail('bad_args','currency must be an ISO code');
      const row=e.run('INSERT INTO costs(issue,actor,run_id,wave,tokens_in,tokens_out,cents,currency,note,ts) VALUES(?,?,?,?,?,?,?,?,?,?)',issue,c.actor,c.run_id,a.wave,tokensIn,tokensOut,cents,currency,a.note,now());
      e.emit(cmd,issue,c,{tokens_in:tokensIn,tokens_out:tokensOut,cents,currency}); return {ok:true,id:Number(row.lastInsertRowid),cents,eur:cents/100};
    }
    case 'cost_list': {
      let where=' WHERE 1=1'; const params: unknown[]=[];
      for (const key of ['issue','actor','run_id','wave']) if (a[key]!=null) { where+=` AND ${key}=?`; params.push(a[key]); }
      return e.rows('SELECT * FROM costs'+where+' ORDER BY id DESC LIMIT ?',...params,integer(a.limit,'limit',100,1,1000));
    }
    case 'cost_rollup': {
      const id=required(a,'id'), task=e.issue(id), descendants=e.rows("WITH RECURSIVE sub(x) AS (SELECT ? UNION SELECT i.id FROM issues i JOIN sub s ON json_extract(i.meta_json,'$.parent')=s.x OR (i.id LIKE s.x||'.%' AND instr(substr(i.id,length(s.x)+2),'.')=0)) SELECT x FROM sub",id), ids=descendants.map(r=>r.x), marks=ids.map(()=>'?').join(',');
      const aggregate='COALESCE(SUM(tokens_in),0) tokens_in,COALESCE(SUM(tokens_out),0) tokens_out,COALESCE(SUM(cents),0) cents,COUNT(*) entries';
      const totals=e.row(`SELECT ${aggregate} FROM costs WHERE issue IN (${marks})`,...ids) ?? {}; totals.eur=Number(totals.cents ?? 0)/100;
      const group=(key: string) => e.rows(`SELECT COALESCE(${key},'(none)') key,${aggregate} FROM costs WHERE issue IN (${marks}) GROUP BY ${key} ORDER BY cents DESC`,...ids);
      return {id,issues:ids.length,totals,by_issue:group('issue'),by_actor:group('actor'),by_wave:group('wave'),budget_eur:task.budget_eur};
    }
    case 'learn': {
      const by=text(a.group_by,'actor'), since=number(a.since,'since',0,0); if (!['actor','wave','kind','issue'].includes(by)) fail('bad_args','group_by must be actor|wave|kind|issue');
      const groups=new Map<string,Obj>(), group=(key: unknown) => { const k=text(key,'(none)'), g=groups.get(k) ?? {key:k}; groups.set(k,g); return g; };
      const key=(table: string) => by==='actor' || by==='issue' ? table+'.'+by : by==='wave' ? `(SELECT wave FROM costs WHERE issue=${table}.issue AND wave IS NOT NULL LIMIT 1)` : `(SELECT kind FROM attests WHERE issue=${table}.issue LIMIT 1)`;
      for (const table of ['attests','proofs']) for (const row of e.rows(`SELECT COALESCE(${key(table)},'(none)') key,COUNT(*) n,SUM(passed) passed FROM ${table}${table==='attests' ? ' WHERE ts>=?' : ''} GROUP BY key`,...(table==='attests' ? [since] : []))) { const g=group(row.key), label=table==='proofs' ? 'proof' : 'attest'; g[table]=row.n; g[table+'_passed']=row.passed; g[label+'_pass_rate']=Number(row.passed ?? 0)/Math.max(1,Number(row.n)); }
      for (const row of e.rows(`SELECT COALESCE(${key('costs')},'(none)') key,SUM(cents) cents,SUM(tokens_in) tokens_in,SUM(tokens_out) tokens_out,COUNT(*) cost_entries FROM costs WHERE ts>=? GROUP BY key`,since)) Object.assign(group(row.key),row);
      const issueKey=by==='issue' ? 'id' : by==='actor' ? "COALESCE(claim_actor,(SELECT actor FROM proofs WHERE issue=issues.id ORDER BY rowid DESC LIMIT 1),'(none)')" : by==='wave' ? "COALESCE((SELECT wave FROM costs WHERE issue=issues.id AND wave IS NOT NULL LIMIT 1),'(none)')" : "COALESCE((SELECT kind FROM attests WHERE issue=issues.id LIMIT 1),'(none)')";
      for (const row of e.rows(`SELECT ${issueKey} key,COUNT(*) issues,SUM(status='closed') closed,AVG(CASE WHEN status='closed' AND closed_at>created_at THEN closed_at-created_at END) accept_secs FROM issues GROUP BY key`)) Object.assign(group(row.key),row);
      return {group_by:by,since,groups:[...groups.values()].sort((x,y)=>Number(y.cents ?? 0)-Number(x.cents ?? 0))};
    }
    case 'outbox_export': {
      const format=text(a.format,'raw'),runner=a.actor===undefined?null:required(a,'actor'),duration=number(a.ttl,'ttl',120,5,3600),time=now();
      if(runner!==null)e.db.exec('CREATE TABLE IF NOT EXISTS sis_ts_delivery_leases(outbox_id INTEGER PRIMARY KEY,actor TEXT NOT NULL,epoch INTEGER NOT NULL,lease_until REAL NOT NULL)');
      const deliveryTable=e.row("SELECT name FROM sqlite_master WHERE type='table' AND name='sis_ts_delivery_leases'")?'sis_ts_delivery_leases':'(SELECT NULL outbox_id,NULL lease_until)';
      if(runner===null&&a.ttl!==undefined||runner!==null&&a.drain===true)fail('bad_args','delivery ttl needs actor; leased exports require acknowledgement, not drain');
      if(runner!==null){
        for(const row of e.rows("SELECT o.id,k.v FROM outbox o JOIN sis_ts_delivery_leases l ON l.outbox_id=o.id JOIN kv k ON k.k='sis:autorun-effect:'||o.id WHERE o.kind='autorun' AND o.state='running' AND l.lease_until<=?",time)){
          const effect=object(decode(row.v)),receipt=object(effect.receipt),known=effect.state==='complete'&&typeof receipt.passed==='boolean',passed=known&&receipt.passed===true;
          e.run('UPDATE outbox SET state=? WHERE id=?',passed?'done':'failed',row.id);
          e.emit(passed?'outbox_done':'outbox_fail',null,c,{id:row.id,recovered:true,attest_id:known?receipt.attest_id??null:null,err:known?(passed?null:'command failed or timed out'):'execution_uncertain: reconcile effect before retry'});
        }
        e.run("UPDATE outbox SET state='failed' WHERE state='running' AND attempts>=3 AND id IN(SELECT outbox_id FROM sis_ts_delivery_leases WHERE lease_until<=?)",time);
      }
      const rows=e.rows("SELECT o.id,o.kind,o.payload,o.run_id FROM outbox o LEFT JOIN "+deliveryTable+" l ON l.outbox_id=o.id WHERE (o.state='pending' OR (? AND o.state='running' AND l.lease_until<=? AND o.attempts<3)) AND (? IS NULL OR o.kind=?) ORDER BY o.id LIMIT ?",runner!==null,time,a.kind,a.kind,integer(a.limit,'limit',100,1,500));
      const jobs=rows.map(row=>{const job:Obj={outbox_id:row.id,kind:row.kind,payload:decode(row.payload,text(row.payload)),run_id:row.run_id};if(runner!==null){e.run('INSERT INTO sis_ts_delivery_leases(outbox_id,actor,epoch,lease_until) VALUES(?,?,1,?) ON CONFLICT(outbox_id) DO UPDATE SET actor=excluded.actor,epoch=sis_ts_delivery_leases.epoch+1,lease_until=excluded.lease_until',row.id,runner,time+duration);e.run("UPDATE outbox SET state='running',attempts=attempts+1 WHERE id=?",row.id);const epoch=e.row('SELECT epoch FROM sis_ts_delivery_leases WHERE outbox_id=?',row.id)?.epoch;Object.assign(job,{delivery_actor:runner,delivery_epoch:epoch,lease_until:time+duration,idempotency_key:`outbox-${String(row.id)}-delivery-${String(epoch)}`});}return job;}); let out: Obj;
      if (format==='raw') out={format,jobs};
      else if (format==='pgboss-sql') out={format,sql:jobs.map(job=>"INSERT INTO pgboss.job(name,data) VALUES('sis-event','"+canonical(job).replaceAll("'","''")+"'::jsonb);\n").join('')};
      else if (format==='hatchet') out={format,jobs:jobs.map(job=>({workflow:'sis-event',input:job}))};
      else if (format==='temporal') out={format,jobs:jobs.map(job=>({workflowType:'SisEvent',taskQueue:a.task_queue ?? 'sis',workflowId:'sis-outbox-'+job.outbox_id,args:[job]}))};
      else fail('bad_args','unknown export format');
      if (a.drain===true) for (const row of rows) e.run("UPDATE outbox SET state='done' WHERE id=?",row.id);
      e.emit(cmd,null,c,{format,n:rows.length,drained:a.drain===true}); return {...out,n:rows.length,drained:a.drain===true};
    }
    case 'spans': { const emit=process.env.SIS_EMIT; if (!emit || emit==='0') return {enabled:false,spans:[]}; const path=emit==='1' ? resolve(dirname(e.dbPath),'spans.jsonl') : emit; const lines=existsSync(path) ? readFileSync(path,'utf8').trim().split('\n').filter(Boolean) : []; return {enabled:true,path,spans:lines.slice(-integer(a.limit,'limit',100,1,500)).map(line=>decode(line))}; }
    default: return fail('bad_cmd',cmd);
  }
}

function importStore(e: Engine,cmd: string,a: Obj,c: Context): Value {
  let items: Value[];
  if (cmd==='sync_import') {
    const bundle=a.path ? object(decode(readFileSync(required(a,'path'),'utf8'))) : typeof a.json==='string' ? object(decode(a.json)) : object(a.json);
    if (bundle.k!=='sis-sync' || number(bundle.schema,'schema',0,0)>8) fail('bad_args','invalid/newer sync bundle');
    items=[bundle];
  } else if (a.path) items=readFileSync(required(a,'path'),'utf8').split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line) as Value);
  else if (typeof a.jsonl==='string') items=a.jsonl.split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line) as Value);
  else if (Array.isArray(a.jsonl)) items=a.jsonl.map(item=>typeof item==='string' ? JSON.parse(item) as Value : item);
  else items=[a];
  let applied=0, skipped=0, memories=0, proofs=0, attests=0; const conflicts: Obj[]=[];
  const columns=new Set('id title status priority type owner oracle_cmd allowed_paths lane budget_eur acceptance desc lease_until lease_epoch claim_actor created_at closed_at defer_until expires_at meta_json'.split(' '));
  const importIssue=(input: Obj,bd=false) => {
    const row={...input}, id=text(row.id); if (!id) { skipped++; return; }
    const prior=e.row('SELECT * FROM issues WHERE id=?',id);
    if (prior && prior.status!=='closed' && Number(prior.lease_until ?? 0)>now()) { conflicts.push({id,reason:'active_claim',actor:prior.claim_actor}); return; }
    if (bd && prior?.status==='closed' && row.status!=='closed' && a.force!==true) { conflicts.push({id,reason:'would_reopen'}); return; }
    if (row.meta_json===undefined && row.meta!==undefined) row.meta_json=canonical(row.meta);
    if (row.desc===undefined) row.desc=row.descr ?? row.description ?? '';
    if (bd) { row.type=row.issue_type ?? row.type ?? 'task'; row.status=['open','in_progress','closed','deferred'].includes(text(row.status)) ? row.status : 'open'; row.meta_json=canonical({labels:array(row.labels)}); row.created_at=prior?.created_at ?? row.created_at ?? now(); }
    if (row.priority===undefined && row.prio!==undefined) row.priority=row.prio;
    if (row.created_at===undefined) row.created_at=now();
    const keys=Object.keys(row).filter(key=>columns.has(key));
    e.run(`INSERT OR REPLACE INTO issues(${keys.map(k=>'"'+k+'"').join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,...keys.map(k=>row[k]));
    const deps=bd ? array(row.dependencies).map(value=>{const d=object(value);return {on:d.depends_on_id ?? d.depends_on,type:d.type};}) : array(row.deps).map(object);
    if (row.deps!==undefined) e.run('DELETE FROM deps WHERE issue=?',id);
    for (const d of deps) if (d.on) e.run('INSERT OR IGNORE INTO deps(issue,depends_on,type) VALUES(?,?,?)',id,d.on,d.type ?? 'blocks');
    applied++;
  };
  const importEvent=(row: Obj) => { const fields='seq ts op issue actor run_id idem data_json'.split(' '); const data: Obj={...row,ts:row.ts ?? now(),data_json:row.data_json ?? canonical(row.data ?? null)}; const keys=fields.filter(k=>data[k]!==undefined); e.run(`INSERT OR IGNORE INTO events(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,...keys.map(k=>data[k])); };
  for (const item of items) {
    const row=object(item);
    if (row.issues || row.events || cmd==='sync_import') {
      for (const issue of array(row.issues)) importIssue(object(issue));
      for (const event of array(row.events)) importEvent(object(event));
      for (const memory of array(row.memories)) { const m=object(memory); if (typeof m.key!=='string' || m.value==null) continue; memories+=Number(e.run('INSERT INTO memories(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE excluded.updated_at>memories.updated_at',m.key,m.value,m.updated_at ?? now()).changes); }
      for (const [table,entries] of [['proofs',row.proofs],['attests',row.attests]] as const) {
        const allowed=table==='proofs' ? 'proof_id issue actor epoch revision source_hash cwd oracle exitcode passed timed_out output review_receipt'.split(' ') : 'attest_id issue actor epoch revision source_hash cwd kind payload summary passed ts'.split(' ');
        for (const entry of array(entries)) { const receipt=object(entry); if (!receipt[allowed[0]]) continue; const n=Number(e.run(`INSERT OR IGNORE INTO ${table}(${allowed.join(',')}) VALUES(${allowed.map(()=>'?').join(',')})`,...allowed.map(k=>receipt[k] ?? (k==='review_receipt' ? 'null' : null))).changes); if (table==='proofs') proofs+=n; else attests+=n; }
      }
    } else if (row.op==='upsert') importIssue({...object(row.data),id:row.issue ?? object(row.data).id});
    else if (row.k==='sis-snapshot') continue;
    else if (row.op || row.seq) importEvent(row);
    else importIssue(row,a.format==='bd' || row.issue_type!==undefined || row.description!==undefined);
  }
  e.emit(cmd,null,c,{applied,skipped,conflicts:conflicts.length,memories,proofs,attests});
  return cmd==='sync_import' ? {applied,skipped,conflicts,memories,proofs,attests,remote_project:object(items[0]).project_id ?? null} : {n:applied,conflicts};
}
