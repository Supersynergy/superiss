import {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,realpathSync,existsSync,copyFileSync,chmodSync,openSync,fsyncSync,closeSync,renameSync,utimesSync,statSync,readdirSync} from 'node:fs';
import {resolve,join,dirname,relative} from 'node:path';
import type {ServiceConfig} from './service';
import {canonical,processIdentity,resolveConfig,loadConfig} from './service';

type Soak = {startedAt:number;durationSecs:number;intervalSecs:number;maxGapSecs:number;feBin:string;fixtureRoot:string;durationOverrideForTest?:number};
type Config = ServiceConfig & {soak?:Soak};
type Case = {name:string;args:string[];expected?:string[];text?:string;exit?:number};
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
const quote=(v:string)=>`'${v.replace(/'/g,"'\\''")}'`;
function inputs(config:Config){const found:Record<string,string>={};const root=realpathSync(config.jobRoot);function walk(p:string){if(p===join(root,'outputs'))return;const target=realpathSync(p);if(target!==root&&!target.startsWith(root+'/'))throw Error('input_scope_escape');if(statSync(p).isDirectory()){for(const name of readdirSync(p).sort())walk(join(p,name));}else{const data=readFileSync(p);found[relative(root,p)]=createHash('sha256').update(data).digest('hex');}}walk(root);return found;}
export function atomic(file:string,value:unknown) {
  mkdirSync(dirname(file),{recursive:true,mode:0o700});
  const tmp=file+`.${process.pid}.tmp`,fd=openSync(tmp,'w',0o600);
  try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(tmp,file);const dir=openSync(dirname(file),'r');try{fsyncSync(dir);}finally{closeSync(dir);}
}
function run(args:string[],cwd?:string,env?:Record<string,string|undefined>) {
  const r=Bun.spawnSync(args,{cwd,env:env??process.env,stdout:'pipe',stderr:'pipe',timeout:15000});
  if(r.exitCode!==0)throw Error(`command_failed: ${args[1]??args[0]}: ${r.stderr.toString().slice(0,500)}`);
  return r.stdout.toString();
}
function native(config:Config,cmd:string,args:unknown) {
  const raw=run([config.sis,cmd,canonical(args),'--db',config.db],undefined,{...process.env,SIS_DIRECT:'1',SIS_SNAPSHOT:'0'});
  const data=JSON.parse(raw);if(data.ok===false)throw Error(`native_rejected: ${data.error?.code}`);return data.data??data;
}
function audit(config:Config) {
  mkdirSync(config.stateDir,{recursive:true,mode:0o700});
  const db=new Database(join(config.stateDir,'soak.sqlite'),{create:true});
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY,wall INTEGER,kind TEXT,payload TEXT,previous TEXT,hash TEXT);
    CREATE TABLE IF NOT EXISTS batches(cycle INTEGER PRIMARY KEY,created INTEGER,ids TEXT);
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);`);
  return db;
}
function event(db:Database,kind:string,data:unknown,now=Date.now()) {
  db.transaction(()=>{
    const prev=db.query('SELECT hash FROM events ORDER BY seq DESC LIMIT 1').get() as {hash:string}|null;
    const payload=canonical(data),previous=prev?.hash??'',hash=digest(previous+'\n'+now+'\n'+kind+'\n'+payload);
    db.query('INSERT INTO events(wall,kind,payload,previous,hash) VALUES(?,?,?,?,?)').run(now,kind,payload,previous,hash);
  })();
}
function settings(config:Config):Soak {
  const s=config.soak;if(!s)throw Error('missing_soak');
  if(config.extraSpendEur!==0||config.providerMode!=='local-only')throw Error('cost_authorization_required');
  if(!Number.isSafeInteger(s.startedAt)||s.startedAt<=0||s.durationSecs!==86400)throw Error('real_24h_contract_required');
  if(!Number.isFinite(s.intervalSecs)||s.intervalSecs<10||s.intervalSecs>7200)throw Error('invalid_soak_interval');
  if(!Number.isFinite(s.maxGapSecs)||s.maxGapSecs<10||s.maxGapSecs>600)throw Error('invalid_gap_bound');
  if(s.durationOverrideForTest!==undefined&&(!Number.isFinite(s.durationOverrideForTest)||s.durationOverrideForTest<1||s.durationOverrideForTest>120))throw Error('invalid_test_duration');
  for(const p of [s.feBin,s.fixtureRoot])if(!p.startsWith('/')||!realpathSync(p).startsWith(realpathSync(config.jobRoot)+'/'))throw Error('unsafe_fixture');
  return s;
}
export function cases(root:string):Case[] {
  const src=['src/cli.ts','src/engine.ts','src-sibling/no.ts','src/search.test.ts','src/service.ts'];
  return [
    {name:'extension-single',args:['search','ext:ts sort:name'],expected:src},
    {name:'extension-union',args:['search','ext:png;jpg sort:name'],expected:['images/logo.png','images/photo.jpg']},
    {name:'filename-spaces',args:['search','name:"Q4 Bericht"'],expected:['Reports/Q4 Bericht.pdf']},
    {name:'unicode-name',args:['search','name:"überblick"'],expected:['docs/überblick.md']},
    {name:'folder-boundary',args:['search',`in:"${root}/src/" ext:ts sort:name`],expected:src.filter(p=>!p.startsWith('src-sibling/'))},
    {name:'negative-term',args:['search','ext:ts !test sort:name'],expected:src.filter(p=>!p.includes('test'))},
    {name:'zero-byte',args:['search','size:=0'],expected:['empty.txt']},
    {name:'size-lower-bound',args:['search','ext:pdf size:>1k'],expected:['Reports/Q4 Bericht.pdf']},
    {name:'size-range',args:['search','ext:pdf size:1..1024'],expected:['Reports/invoice-2026.pdf']},
    {name:'name-descending',args:['search','ext:ts sort:name-desc'],expected:[...src].reverse()},
    {name:'size-sort',args:['search','ext:pdf sort:big'],expected:['Reports/Q4 Bericht.pdf','Reports/invoice-2026.pdf']},
    {name:'date-sort',args:['search','ext:pdf sort:old'],expected:['Reports/invoice-2026.pdf','Reports/Q4 Bericht.pdf']},
    {name:'natural-language',args:['search','(PDFs größer als 1 KB)'],expected:['Reports/Q4 Bericht.pdf']},
    {name:'zero-results',args:['search','zzzz-no-such-file-17824'],expected:[]},
    {name:'bounded-page',args:['search','ext:ts sort:name','--limit','2'],expected:src.slice(0,2)},
    {name:'next-page',args:['search','ext:ts sort:name','--limit','2','--offset','2'],expected:src.slice(2,4)},
    {name:'favorites',args:['search','favorites:true ext:md'],expected:['README.md']},
    {name:'hide-dotfiles',args:['search','omit:hidden ext:txt sort:name'],expected:['empty.txt','archive/old.txt','readme-notes.txt']},
    {name:'text-preview',args:['preview',join(root,'README.md')],text:'Find Everything service fixture'},
    {name:'invalid-size-rejected',args:['search','size:banana'],exit:1,text:'size'},
  ];
}
export function prepare(config:Config,source:string) {
  config=resolveConfig(config) as Config;
  if(!config.soak)throw Error('missing_soak');
  if(existsSync(join(config.stateDir,'soak.sqlite')))throw Error('soak_already_initialized');
  mkdirSync(config.jobRoot,{recursive:true,mode:0o700});
  const root=config.soak.fixtureRoot;mkdirSync(root,{recursive:true});
  const files:Record<string,string>={'README.md':'Find Everything service fixture\n','docs/README.md':'docs\n','readme-notes.txt':'notes\n','src/engine.ts':'engine\n','src/cli.ts':'cli\n','src/service.ts':'service\n','src/search.test.ts':'test\n','src-sibling/no.ts':'sibling\n','docs/roadmap.md':'roadmap\n','docs/überblick.md':'unicode\n','Reports/Q4 Bericht.pdf':'P'.repeat(2048),'Reports/invoice-2026.pdf':'I'.repeat(512),'Reports/budget.csv':'a,b\n','images/logo.png':'PNG','images/photo.jpg':'JPEG','audio/laser.wav':'audio','archive/old.txt':'archive','data/αριθμός.json':'{}','.secret.txt':'synthetic, not a credential','empty.txt':''};
  for(const [name,content] of Object.entries(files)){const p=join(root,name);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,content);}
  utimesSync(join(root,'Reports/invoice-2026.pdf'),new Date('2020-01-01'),new Date('2020-01-01'));
  copyFileSync(source,config.soak.feBin);chmodSync(config.soak.feBin,0o400);
  mkdirSync(join(config.jobRoot,'outputs'),{recursive:true});
  const env={...process.env,FE_DATA_DIR:join(config.jobRoot,'cache'),FE_CONFIG_DIR:join(config.jobRoot,'config'),FE_FAVORITES_FILE:join(config.jobRoot,'pins.json')};
  const cli=[process.execPath,config.soak.feBin];
  run([...cli,'index',root,'--name','soak','--preset','folder','--json'],config.jobRoot,env);
  run([...cli,'prepare','--index','soak','--json'],config.jobRoot,env);
  run([...cli,'properties','--index','soak','--max-files','100','--json'],config.jobRoot,env);
  run([...cli,'favorites','add',join(root,'README.md'),'--json'],config.jobRoot,env);
  atomic(join(config.jobRoot,'cases.json'),cases(root));
  writeFileSync(join(config.jobRoot,'oracle.js'),`import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';\nconst [index,file]=process.argv.slice(2);const c=JSON.parse(fs.readFileSync('cases.json','utf8'))[Number(index)];\nconst out=fs.readFileSync(file,'utf8');if(c.expected){const got=JSON.parse(out);assert.deepEqual(got.paths,c.expected.map(p=>path.join(${JSON.stringify(root)},p)));assert.notEqual(got.complete,false);}else assert(out.toLowerCase().includes(c.text.toLowerCase()));console.log(JSON.stringify({passed:true,case:c.name}));\n`,{mode:0o400});
  settings(config);
  native(config,'plan',{id:config.goal,name:config.goal,owner:config.actor,objective:'Private 24-hour local Find Everything soak',oracle_cmd:'false',allowed_paths:[join(config.jobRoot,'cases.json')],subs:[]});
  const db=audit(config);try{
    db.query('INSERT INTO meta VALUES (?,?)').run('config',digest(canonical(config)));
    db.query('INSERT INTO meta VALUES (?,?)').run('source',digest(readFileSync(config.soak.feBin,'utf8')));
    db.query('INSERT INTO meta VALUES (?,?)').run('inputs',canonical(inputs(config)));
    event(db,'start',{startedAt:config.soak.startedAt,source:digest(readFileSync(config.soak.feBin,'utf8')),durationSecs:86400,testOverride:config.soak.durationOverrideForTest??null});
  }finally{db.close();}
}
function queue(config:Config,cycle:number,scopes:string[]) {
  const s=settings(config),suite=cases(s.fixtureRoot);
  return suite.map((c,index)=>{
    const id=`${config.goal}.c${cycle}-${index+1}`,file=`outputs/c${cycle}-${index+1}.json`,err=`outputs/c${cycle}-${index+1}.err`;
    const flags=c.args[0]==='search'?['--index','soak','--json']:[];
    const command=[process.execPath,s.feBin,...c.args,...flags].map(quote).join(' ');
    const environment=`FE_DATA_DIR=${quote(join(config.jobRoot,'cache'))} FE_CONFIG_DIR=${quote(join(config.jobRoot,'config'))} FE_FAVORITES_FILE=${quote(join(config.jobRoot,'pins.json'))}`;
    const cmd=`${index===0?'/bin/sleep 8; ':''}${environment} ${command} > ${quote(file)} 2> ${quote(err)}; code=$?; test "$code" -eq ${c.exit??0}`;
    return {cmd:'create',args:{id,title:`${c.name} cycle ${cycle}`,owner:config.actor,budget_eur:0,oracle_cmd:`${quote(process.execPath)} oracle.js ${index} ${quote(c.exit?err:file)}`,acceptance:`Exact fixture oracle for ${c.name}`,
      allowed_paths:scopes,meta:{parent:config.goal,local_zero:true,budget_gate:true,use_case:c.name,cycle,execution:{cmd,cwd:config.jobRoot,replay_safe:true,oracle_replay_safe:true}}}};
  });
}
function identity(pid:number) {
  const p=Bun.spawnSync(['/bin/ps','-p',String(pid),'-o','uid=,lstart=,command='],{stdout:'pipe',stderr:'ignore',timeout:1000});
  return p.exitCode===0?p.stdout.toString().trim():'';
}
function chaos(config:Config,db:Database) {
  const stateFile=join(config.stateDir,`${config.id}.state.json`),ownerFile=join(config.stateDir,`${config.id}.owner.json`);
  if(!existsSync(stateFile)||!existsSync(ownerFile))return;
  const state=JSON.parse(readFileSync(stateFile,'utf8')),owner=JSON.parse(readFileSync(ownerFile,'utf8'));
  if(state.configHash!==digest(canonical(config))||owner.configHash!==state.configHash||owner.instance!==state.instance||owner.pid!==state.pid||processIdentity(state.pid)!==state.pidBirth)throw Error('chaos_service_identity_mismatch');
  const batches=db.query('SELECT cycle,ids FROM batches ORDER BY cycle').all() as {cycle:number;ids:string}[];
  const tasks=new Database(config.db,{readonly:true});tasks.exec('PRAGMA busy_timeout=3000');
  try{for(const b of batches){
    const id=(JSON.parse(b.ids) as string[])[0];
    const killed=db.query("SELECT payload FROM events WHERE kind='worker_killed' AND json_extract(payload,'$.issue')=?").get(id);
    const row=tasks.query('SELECT status,claim_actor FROM issues WHERE id=?').get(id) as {status:string;claim_actor:string}|null;
    if(killed){if(row?.status==='closed'&&!db.query("SELECT seq FROM events WHERE kind='worker_recovered' AND json_extract(payload,'$.issue')=?").get(id))event(db,'worker_recovered',{issue:id});continue;}
    if(row?.status!=='in_progress'||row.claim_actor!==config.actor)continue;
    for(const worker of state.currentWorkers??[]){
      if(worker.issue!==id||processIdentity(worker.pid)!==worker.birth)continue;
      const pid=worker.pid,detail=run(['/bin/ps','-p',String(pid),'-o','ppid=,command=']).trim(),match=detail.match(/^(\d+)\s+(.+)$/);
      if(!match||Number(match[1])!==state.pid)continue;
      const cmd=match[2],argv=cmd.split(/\s+/),issueArg=argv.indexOf('--issue'),dbArg=argv.indexOf('--db'),actorArg=argv.indexOf('--actor');
      if(!argv.some(v=>v.endsWith('/tools/sis_runner.py'))||!argv.includes('--complete')||argv[issueArg+1]!==id||argv[dbArg+1]!==config.db||argv[actorArg+1]!==config.actor)continue;
      const before=identity(pid);if(!before||before!==identity(pid)||processIdentity(pid)!==worker.birth)continue;
      const binding={issue:id,pid,identity:digest(before),configHash:state.configHash,instance:state.instance,birth:worker.birth};
      event(db,'kill_requested',binding);
      try{process.kill(pid,'SIGKILL');}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')break;throw e;}
      event(db,'worker_killed',binding);break;
    }
  }}finally{tasks.close();}
}
let awakeForPid=0;
export function recordError(input:ServiceConfig,error:unknown){const config=input as Config,db=audit(config);try{event(db,'error',{message:String((error as Error).message??error)});}finally{db.close();}}
export async function tick(input:ServiceConfig):Promise<void> {
  const config=resolveConfig(input) as Config,s=settings(config),db=audit(config),now=Date.now();
  try{
    const bound=db.query('SELECT value FROM meta WHERE key=?').get('config') as {value:string}|null;
    if(bound?.value!==digest(canonical(config)))throw Error('soak_configuration_drift');
    if(digest(readFileSync(s.feBin,'utf8'))!==(db.query('SELECT value FROM meta WHERE key=?').get('source') as {value:string}).value)throw Error('findeverything_source_drift');
    const protectedInputs=JSON.parse((db.query('SELECT value FROM meta WHERE key=?').get('inputs') as {value:string}).value);
    if(canonical(inputs(config))!==canonical(protectedInputs))throw Error('soak_input_drift');
    const last=db.query("SELECT wall FROM events WHERE kind='sample' ORDER BY seq DESC LIMIT 1").get() as {wall:number}|null;
    if(last&&now<last.wall)throw Error('clock_rollback');
    if(!last||now-last.wall>=30000)event(db,'sample',{pid:process.pid,uptimeSecs:process.uptime(),paused:existsSync(join(config.stateDir,'paused'))},now);
    const duration=(s.durationOverrideForTest??s.durationSecs)*1000,end=s.startedAt+duration;
    if(now>=end){chaos(config,db);if(!db.query("SELECT seq FROM events WHERE kind='production_ended'").get())event(db,'production_ended',{end});return;}
    if(awakeForPid!==process.pid&&process.platform==='darwin'&&s.durationOverrideForTest===undefined){
      Bun.spawn(['/usr/bin/caffeinate','-i','-w',String(process.pid),'-t',String(Math.ceil((end-now)/1000)+180)],{stdout:'ignore',stderr:'ignore'});awakeForPid=process.pid;
    }
    chaos(config,db);
    const cycle=Math.floor((now-s.startedAt)/(s.intervalSecs*1000));
    if(cycle<0||db.query('SELECT cycle FROM batches WHERE cycle=?').get(cycle))return;
    const previous=db.query('SELECT ids FROM batches ORDER BY cycle DESC LIMIT 1').get() as {ids:string}|null;
    if(previous){const tasks=new Database(config.db,{readonly:true});try{tasks.exec('PRAGMA busy_timeout=3000');for(const id of JSON.parse(previous.ids))if((tasks.query('SELECT status FROM issues WHERE id=?').get(id) as {status:string}|null)?.status!=='closed')return;}finally{tasks.close();}}
    const ops=queue(config,cycle,Object.keys(protectedInputs).sort());
    native(config,'batch',{ops,idem:`soak-batch:${config.goal}:${cycle}`});
    db.query('INSERT INTO batches VALUES (?,?,?)').run(cycle,now,canonical(ops.map(o=>o.args.id)));
    event(db,'batch_created',{cycle,ids:ops.map(o=>o.args.id),cases:ops.map(o=>o.args.meta.use_case)},now);
  }finally{db.close();}
}
export function verify(config:Config) {
  config=resolveConfig(config) as Config;
  const s=settings(config);if(s.durationOverrideForTest!==undefined)throw Error('test_override_is_not_24h_proof');
  const path=join(config.stateDir,'soak.sqlite');if(!existsSync(path))throw Error('soak_not_started');
  const db=new Database(path,{readonly:true});try{
    const meta=db.query('SELECT value FROM meta WHERE key=?').get('config') as {value:string}|null;
    if(meta?.value!==digest(canonical(config)))throw Error('soak_configuration_drift');
    const source=db.query('SELECT value FROM meta WHERE key=?').get('source') as {value:string}|null;
    if(source?.value!==digest(readFileSync(s.feBin,'utf8')))throw Error('findeverything_source_drift');
    const inputRow=db.query('SELECT value FROM meta WHERE key=?').get('inputs') as {value:string}|null;
    if(!inputRow)throw Error('input_manifest_missing');const manifest=JSON.parse(inputRow.value);
    for(const required of ['cases.json','oracle.js',relative(config.jobRoot,s.feBin)])if(typeof manifest[required]!=='string')throw Error('input_manifest_incomplete');
    if(canonical(inputs(config))!==canonical(manifest))throw Error('soak_input_drift');
    const inputHash=digest(canonical(manifest)),scopes=Object.keys(manifest).sort();
    const rows=db.query('SELECT * FROM events ORDER BY seq').all() as {seq:number;wall:number;kind:string;payload:string;previous:string;hash:string}[];
    if(rows.length===0||rows[0].kind!=='start'||rows[0].wall<s.startedAt||Math.abs(rows[0].wall-s.startedAt)>60000)throw Error('invalid_start_evidence');
    let previous='';for(const row of rows){if(row.previous!==previous||row.hash!==digest(previous+'\n'+row.wall+'\n'+row.kind+'\n'+row.payload))throw Error('evidence_chain_corrupt');previous=row.hash;}
    if(Date.now()-s.startedAt<86400000)throw Error('24h_not_elapsed');
    const samples=rows.filter(r=>r.kind==='sample');
    if(!samples.length||samples.at(-1)!.wall<s.startedAt+86400000)throw Error('24h_samples_incomplete');
    const relevant=samples.filter(r=>r.wall<=s.startedAt+86400000+s.maxGapSecs*1000);let last=s.startedAt,maxGap=0;
    if(!relevant.length||relevant.at(-1)!.wall<s.startedAt+86400000)throw Error('24h_samples_incomplete');
    for(const sample of relevant){if(sample.wall<last)throw Error('clock_rollback');maxGap=Math.max(maxGap,sample.wall-last);last=sample.wall;const data=JSON.parse(sample.payload);if(data.paused)throw Error('paused_during_soak');}
    if(maxGap>s.maxGapSecs*1000)throw Error('availability_gap_exceeded');
    if(rows.some(r=>r.kind==='error'))throw Error('observed_soak_error');
    const recovered=rows.filter(r=>r.kind==='worker_recovered'),recoveredIds=new Set<string>();
    for(const r of recovered){const id=JSON.parse(r.payload).issue,killed=rows.find(k=>k.kind==='worker_killed'&&JSON.parse(k.payload).issue===id&&k.wall<=r.wall),requested=killed&&rows.find(k=>k.kind==='kill_requested'&&k.payload===killed.payload&&k.wall<=killed.wall);if(!killed||!requested)throw Error('unbound_recovery_event');const binding=JSON.parse(killed.payload);if(binding.configHash!==digest(canonical(config))||!binding.instance||!binding.identity||!binding.birth||!Number.isSafeInteger(binding.pid))throw Error('invalid_kill_binding');recoveredIds.add(id);}
    if(recoveredIds.size<3)throw Error('chaos_recovery_incomplete');
    const batches=db.query('SELECT cycle,created,ids FROM batches ORDER BY cycle').all() as {cycle:number;created:number;ids:string}[];
    const required=Math.ceil(86400/s.intervalSecs);
    if(batches.length!==required||batches.some((b,i)=>b.cycle!==i||b.created<s.startedAt+i*s.intervalSecs*1000||b.created>s.startedAt+(i+1)*s.intervalSecs*1000))throw Error('workload_cycles_incomplete');
    const tasks=new Database(config.db,{readonly:true});let closed=0;try{tasks.exec('PRAGMA busy_timeout=3000');
      if(tasks.query('SELECT id FROM costs WHERE cents<>0 LIMIT 1').get())throw Error('nonzero_cost_observed');
      for(const b of batches){const ids=JSON.parse(b.ids);if(!Array.isArray(ids)||ids.length!==20||new Set(ids).size!==20||ids.some((id,i)=>id!==`${config.goal}.c${b.cycle}-${i+1}`))throw Error('invalid_batch_members');for(const [index,id] of ids.entries()){
        const task=tasks.query('SELECT status,owner,budget_eur,meta_json,allowed_paths,oracle_cmd,lease_epoch FROM issues WHERE id=?').get(id) as any;
        const metadata=task&&JSON.parse(task.meta_json);
        if(!task||task.status!=='closed'||task.owner!==config.actor||task.budget_eur!==0||metadata.local_zero!==true||metadata.parent!==config.goal||metadata.use_case!==cases(s.fixtureRoot)[index].name)throw Error(`unfinished_or_foreign_task:${id}`);
        const expected=queue(config,b.cycle,scopes)[index].args,contract=native(config,'contract',{id});
        const allowed=typeof task.allowed_paths==='string'?JSON.parse(task.allowed_paths):task.allowed_paths;
        if(canonical(allowed)!==canonical(scopes)||task.oracle_cmd!==expected.oracle_cmd||canonical(metadata.execution)!==canonical(expected.meta.execution))throw Error(`task_contract_drift:${id}`);
        if(!tasks.query('SELECT proof_id FROM proofs WHERE issue=? AND actor=? AND epoch=? AND revision=? AND source_hash=? AND passed=1 AND exitcode=0 AND timed_out=0').get(id,config.actor,task.lease_epoch,contract.revision,inputHash)||!tasks.query("SELECT attest_id FROM attests WHERE issue=? AND actor=? AND epoch=? AND revision=? AND source_hash=? AND kind='run' AND passed=1").get(id,config.actor,task.lease_epoch,contract.revision,inputHash))throw Error(`missing_current_native_proof:${id}`);closed++;
      }}
      for(const id of recoveredIds)if(!batches.some(b=>JSON.parse(b.ids).includes(id)))throw Error('foreign_recovery_event');
    }finally{tasks.close();}
    return {passed:true,elapsedSecs:(Date.now()-s.startedAt)/1000,closedTasks:closed,useCases:20,cycles:batches.length,recoveredWorkers:recovered.length,maxGapSecs:maxGap/1000,extraSpendEur:0,lastHash:previous};
  }finally{db.close();}
}
if(import.meta.main){
  try{
    const [cmd,...args]=process.argv.slice(2),value=(key:string)=>{const i=args.indexOf(key);if(i<0||!args[i+1])throw Error(`missing_${key}`);return args[i+1];};
    if(cmd==='agents-verify'){
      const report=JSON.parse(readFileSync(value('--report'),'utf8'));if(report.passed!==true||report.agents?.length<2||report.agents.some((a:any)=>a.model!=='gpt-6-luna'||a.status!=='completed'||a.extraSpendEur!==0))throw Error('luna_evidence_incomplete');console.log(JSON.stringify({passed:true,agents:report.agents.length}));
    }else{
      const config=await loadConfig(value('--config')) as Config;
      if(cmd==='init'){prepare(config,value('--source'));console.log(JSON.stringify({initialized:true}));}
      else if(cmd==='tick'){await tick(config);console.log(JSON.stringify({ticked:true}));}
      else if(cmd==='verify')console.log(JSON.stringify(verify(config)));
      else throw Error('unknown_soak_command');
    }
  }catch(e){console.error(JSON.stringify({passed:false,error:String((e as Error).message)}));process.exitCode=1;}
}
