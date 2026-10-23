import {Database} from 'bun:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,realpathSync,statSync,fstatSync,openSync,fsyncSync,closeSync,renameSync,unlinkSync,appendFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';

export type ServiceConfig={schema?:1;id:string;db:string;goal:string;actor:string;stateDir:string;sis:string;jobRoot:string;
 zeroCostLock?:1;extraSpendEur?:0;providerMode?:'local-only';pollMs?:number;maxConcurrent?:number;timeoutSecs?:number;deadlineSecs?:number;maxRestarts?:number;watchdogSecs?:number;
 soak?:{startedAt:number;durationSecs:number;intervalSecs:number;maxGapSecs:number;feBin:string;fixtureRoot:string;durationOverrideForTest?:number}};
type Config=ServiceConfig & {zeroCostLock:1;extraSpendEur:0;providerMode:'local-only';pollMs:number;maxConcurrent:number;timeoutSecs:number;deadlineSecs:number;maxRestarts:number;watchdogSecs:number};
type Worker={pid:number;birth:string;issue:string;startedAt:number;cwd?:string};
type Outcome={terminal:boolean;code:number|null;at:number;error:string;nextAt:number;busyUntil?:number};
type State={id:string;configHash:string;instance:string;pid:number;pidBirth:string;startedAt:number;heartbeatAt:number;heartbeatMonotonicMs:number;currentWorkers:Worker[];outcomes:Record<string,Outcome>;attempts:Record<string,number>;tickErrors:{at:number;error:string}[];paused:boolean};
const SCRIPT=realpathSync(import.meta.path),ROOT=dirname(dirname(SCRIPT));
export const SERVICE_DEFAULTS=Object.freeze({zeroCostLock:1 as const,extraSpendEur:0 as const,providerMode:'local-only' as const,pollMs:1000,maxConcurrent:4,timeoutSecs:10,deadlineSecs:60,maxRestarts:3,watchdogSecs:120});
export const AGENT_DEFAULTS=Object.freeze({transport:'codex-host-included',auth:'reuse-existing-authorized',model:'gpt-6-luna',maxConcurrent:3,reservePercent:2,extraSpendEur:0,autoDispatch:true,paidFallback:false});
export function agentAdmission(receipt:any,now=Date.now()):{dispatchAuthorized:false;requiresLiveHostCheck:true;eligible:boolean;reason:string|null;remainingPercent?:number;slots?:number}{
 const advisory={dispatchAuthorized:false as const,requiresLiveHostCheck:true as const};
 const deny=(reason:string)=>({...advisory,eligible:false,reason});
 if(receipt?.source!=='mcp__codex_app__get_usage_limits'||!Number.isFinite(receipt.observedAt)||receipt.observedAt>now||now-receipt.observedAt>300000)return deny('fresh_host_quota_required');
 const usage=receipt.usage,limit=usage?.rateLimitsByLimitId?.codex??usage?.rateLimits;
 if(usage?.ordinaryUsageAllowed!==true||!usage?.accountId||limit?.limitId!=='codex'||!limit.planType||limit.rateLimitReachedType||limit.spendControlReached!==false)return deny('included_transport_unavailable');
 const credit=limit.credits;
 if(credit?.hasCredits!==false||credit?.unlimited!==false||String(credit?.balance)!=='0')return deny('paid_fallback_not_disabled');
 const windows=[limit.primary,limit.secondary].filter(v=>v!=null);
 if(!windows.length||windows.some(v=>!Number.isFinite(v.usedPercent)||v.usedPercent<0||v.usedPercent>100||!Number.isFinite(v.resetsAt)||v.resetsAt*1000<=now))return deny('unknown_quota_window');
 const remainingPercent=Math.min(...windows.map(v=>100-v.usedPercent));if(remainingPercent<=AGENT_DEFAULTS.reservePercent)return deny('quota_reserve');
 const cap=receipt.capacity;if(!integer(cap?.ownActive,0,3)||!integer(cap?.freeSlots,0,3)||![cap?.foreignScopes,cap?.ownScopes].every(a=>Array.isArray(a)&&a.every((v:unknown)=>typeof v==='string'&&isAbsolute(v)))||cap.ownActive>0&&cap.ownScopes.length===0)return deny('fresh_capacity_required');
 const slots=Math.min(AGENT_DEFAULTS.maxConcurrent-cap.ownActive,cap.freeSlots);if(slots<1)return deny('capacity_full');
 return {...advisory,eligible:true,reason:null,remainingPercent,slots};
}
export function agentReady(c:Config,receipt:any){
 const admission=agentAdmission(receipt);if(!admission.eligible)return {...admission,ready:[]};
 const tasks=native(c,'ready',{goal:c.goal,owner:c.actor,limit:100}),ready:any[]=[];
 const occupied=[...receipt.capacity.foreignScopes,...receipt.capacity.ownScopes].map((p:string)=>physicalPath(p));
 for(const row of tasks){if(ready.length>=admission.slots!)break;const t=native(c,'show',{id:row.id}).issue,contract=native(c,'contract',{id:row.id}),bound=JSON.parse(contract.contract_text),e=bound.meta?.execution,cwd=e?.cwd;
   if(bound.owner!==c.actor||bound.budget_eur!==0||t.meta?.parent!==c.goal||e?.kind!=='host-agent'||e.auto_dispatch!==true||e.transport!==AGENT_DEFAULTS.transport||typeof cwd!=='string'||!isAbsolute(cwd)||!existsSync(cwd)||!inside(realpathSync(cwd),c.jobRoot)||typeof bound.oracle_cmd!=='string'||!bound.oracle_cmd.trim()||/^(?:true|:|exit\s+0)\s*;?$/.test(bound.oracle_cmd.trim()))continue;
   const paths=bound.allowed_paths;
   if(!Array.isArray(paths)||!paths.length||paths.some((p:unknown)=>typeof p!=='string'||!p))continue;
   const scopes=paths.map((p:string)=>physicalPath(resolve(cwd,p)));if(scopes.some((p:string)=>!inside(p,c.jobRoot)||occupied.some((o:string)=>inside(p,o)||inside(o,p))))continue;
   ready.push({id:t.id,title:t.title,cwd,scopes,revision:contract.revision,oracle:bound.oracle_cmd});occupied.push(...scopes);
 }
 return {...admission,ready};
}
export function enqueueAgent(c:Config,task:any){
 const fields=['id','title','desc','oracle_cmd','allowed_paths','priority','cwd'];
 if(!task||Object.keys(task).some(k=>!fields.includes(k))||typeof task.title!=='string'||!task.title.trim()||typeof task.oracle_cmd!=='string'||!task.oracle_cmd.trim()||/^(?:true|:|exit\s+0)\s*;?$/.test(task.oracle_cmd.trim())||typeof task.cwd!=='string'||!isAbsolute(task.cwd)||!existsSync(task.cwd)||!inside(realpathSync(task.cwd),c.jobRoot)||!Array.isArray(task.allowed_paths)||!task.allowed_paths.length||task.allowed_paths.some((p:unknown)=>typeof p!=='string'||!p||!inside(physicalPath(resolve(task.cwd,p as string)),c.jobRoot)))throw Error('bounded agent task required');
 const {cwd,...args}=task;return native(c,'create',{...args,owner:c.actor,budget_eur:0,meta:{parent:c.goal,execution:{kind:'host-agent',cwd:realpathSync(cwd),auto_dispatch:true,transport:AGENT_DEFAULTS.transport}}});
}
export function canonical(value:any):string{return JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);}
const hash=(v:unknown)=>createHash('sha256').update(typeof v==='string'?v:canonical(v)).digest('hex');
const inside=(p:string,base:string)=>{const r=relative(base,p);return r===''||(!r.startsWith('..')&&!isAbsolute(r));};
const integer=(n:unknown,lo:number,hi:number)=>typeof n==='number'&&Number.isInteger(n)&&n>=lo&&n<=hi;
function physicalPath(p:string){const tail:string[]=[];let parent=p;while(!existsSync(parent)){tail.unshift(parent.slice(parent.lastIndexOf('/')+1));const next=dirname(parent);if(next===parent)throw Error('path has no existing parent');parent=next;}return join(realpathSync(parent),...tail);}
export async function loadConfig(path:string):Promise<Config>{return resolveConfig(JSON.parse(readFileSync(path,'utf8')));}
export function resolveConfig(raw:any):Config{
 for(const k of ['id','db','goal','actor','stateDir','sis','jobRoot'])if(typeof raw[k]!=='string'||!raw[k].trim())throw Error(`config.${k} required`);
 if(!/^[a-z][a-z0-9-]{0,47}$/.test(raw.id)||/[\r\n\0]/.test(raw.actor+raw.goal))throw Error('invalid service identity');
 for(const k of ['db','stateDir','sis','jobRoot']){if(!isAbsolute(raw[k])||resolve(raw[k])!==raw[k]||physicalPath(raw[k])!==raw[k])throw Error(`config.${k} must be absolute and canonical`);}
 const c={...SERVICE_DEFAULTS,...raw} as Config;
 if(c.zeroCostLock!==1||c.extraSpendEur!==0||c.providerMode!=='local-only')throw Error('zeroCostLock=1 and local-only extraSpendEur=0 required');
 if(!integer(c.pollMs,200,60000)||!integer(c.maxConcurrent,1,16)||!integer(c.timeoutSecs,1,60)||!integer(c.deadlineSecs,5,300)||!integer(c.maxRestarts,0,6)||!integer(c.watchdogSecs,10,600))throw Error('invalid service bounds');
 if(c.deadlineSecs<c.timeoutSecs+5||c.watchdogSecs*1000<=c.pollMs)throw Error('inconsistent deadline/watchdog');
 if(inside(c.db,c.jobRoot)||inside(c.stateDir,c.jobRoot)||inside(c.sis,c.jobRoot))throw Error('DB, state and service executable must be outside jobRoot');
 if(c.soak&&(c.soak.durationSecs!==86400||!integer(c.soak.startedAt,1,Number.MAX_SAFE_INTEGER)))throw Error('24h soak needs duration 86400 and actual startedAt');
 return c;
}
function atomic(file:string,value:unknown){mkdirSync(dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+randomUUID()+'.tmp',fd=openSync(tmp,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,file);const dir=openSync(dirname(file),'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
const stateFile=(c:Config)=>join(c.stateDir,c.id+'.state.json');
const ownerFile=(c:Config)=>join(c.stateDir,c.id+'.owner.json');
const pauseFile=(c:Config)=>join(c.stateDir,'paused');
function readState(c:Config):State|null{if(!existsSync(stateFile(c)))return null;try{const s=JSON.parse(readFileSync(stateFile(c),'utf8'));if(s.id!==c.id||s.configHash!==hash(c)||!Array.isArray(s.currentWorkers)||!s.attempts||!s.outcomes)throw Error('identity');return s;}catch{throw Error('state corrupt or identity mismatch; reconciliation required');}}
function log(c:Config,message:string){const file=join(c.stateDir,c.id+'.log');if(existsSync(file)&&statSync(file).size>1024*1024)renameSync(file,file+'.1');appendFileSync(file,`${new Date().toISOString()} ${message.slice(0,3000)}\n`,{mode:0o600});}
function command(args:string[],timeout=10000){const r=Bun.spawnSync(args,{env:{...process.env,SIS_DIRECT:'1',SIS_SOCK:undefined,SIS_SNAPSHOT:'0'},stdout:'pipe',stderr:'pipe',timeout});if(r.exitCode!==0)throw Error(`command_failed:${args[1]??args[0]}:${r.stderr.toString().slice(-1000)}`);return r.stdout.toString();}
function native(c:Config,op:string,args:any={}){const d=JSON.parse(command([c.sis,op,canonical(args),'--db',c.db]));if(d.ok===false)throw Error(d.error?.code??'native_rejected');return d.data??d;}
export function processIdentity(pid:number):string|null{if(!Number.isSafeInteger(pid)||pid<2)return null;const p=Bun.spawnSync(['/bin/ps','-p',String(pid),'-o','uid=,stat=,lstart='],{stdout:'pipe',stderr:'ignore',timeout:1000});if(p.exitCode!==0)return null;const parts=p.stdout.toString().trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);return !parts||parts[2].startsWith('Z')?null:parts[1]+' '+parts[3];}
function persist(c:Config,s:State){atomic(stateFile(c),s);}
function recordFailure(c:Config,s:State,e:unknown){const error=String((e as Error).message??e);s.tickErrors.push({at:Date.now(),error});s.tickErrors=s.tickErrors.slice(-100);persist(c,s);log(c,error);}
function eligible(c:Config,id:string){const t=native(c,'show',{id}).issue;const cwd=t.meta?.execution?.cwd;if(typeof cwd!=='string'||!isAbsolute(cwd)||!existsSync(cwd)||!inside(realpathSync(cwd),c.jobRoot))return null;return t.owner===c.actor&&t.budget_eur===0&&t.meta?.local_zero===true&&t.meta?.parent===c.goal?t:null;}
function reconcile(c:Config,s:State){
 s.currentWorkers=s.currentWorkers.filter(w=>{if(processIdentity(w.pid)===w.birth)return true;const t=native(c,'show',{id:w.issue}).issue;if(t.status==='closed')s.outcomes[w.issue]={terminal:true,code:0,at:Date.now(),error:'reconciled closed native task',nextAt:0};return false;});
}
function startWorker(c:Config,s:State,id:string,cwd:string){
 const p=spawn(c.sis,['run','--db',c.db,'--issue',id,'--actor',c.actor,'--timeout',String(c.timeoutSecs),'--deadline',String(c.deadlineSecs),'--resume'],{stdio:['ignore','pipe','pipe'],env:{...process.env,SIS_DIRECT:'1',SIS_SOCK:undefined}});
 if(!p.pid)throw Error('worker_spawn_failed');
 let output='';for(const stream of [p.stdout,p.stderr])stream.on('data',b=>{output=(output+b).slice(-65536);});
 const pid=p.pid,identity=processIdentity(pid);if(!identity){p.kill('SIGTERM');throw Error('worker_identity_missing');}
 s.attempts[id]=(s.attempts[id]??0)+1;s.currentWorkers.push({pid,birth:identity,issue:id,startedAt:Date.now(),cwd});persist(c,s);
 p.once('error',e=>recordFailure(c,s,e));
 p.once('close',code=>{
   s.currentWorkers=s.currentWorkers.filter(w=>w.pid!==pid);const busy=/\bbusy:/.test(output),known=/run_failed|verify_failed|task_failed|recovery_required|owner_mismatch|cost_authorization|cancel_requested|foreign_claim|stale_proof|incompatible_runtime/.test(output);
   const prior=s.outcomes[id],busyUntil=prior?.busyUntil??Date.now()+(c.deadlineSecs+20)*1000;
   if(busy)s.attempts[id]=Math.max(0,s.attempts[id]-1);
   s.outcomes[id]={terminal:code===0||known||(!busy&&s.attempts[id]>c.maxRestarts)||(busy&&Date.now()>busyUntil),code,at:Date.now(),error:code===0?'':output.slice(-2000),nextAt:Date.now()+Math.max(500,c.pollMs),busyUntil};
   const completed=Object.keys(s.outcomes).filter(k=>s.outcomes[k].terminal&&s.outcomes[k].code===0);while(completed.length>100){const old=completed.shift()!;delete s.outcomes[old];delete s.attempts[old];}
   persist(c,s);
 });
}
async function dispatch(c:Config,s:State){
 const ready=native(c,'ready',{goal:c.goal,owner:c.actor,limit:100,fields:['id']}) as {id:string}[];
 const db=new Database(c.db,{readonly:true});let ids:string[];try{db.exec('PRAGMA busy_timeout=3000');const resumed=(db.query("SELECT id FROM issues WHERE json_extract(meta_json,'$.parent')=? AND status='in_progress' ORDER BY priority,created_at LIMIT 100").all(c.goal) as {id:string}[]).map(r=>r.id);ids=[...new Set([...resumed,...ready.map(t=>t.id)])];}finally{db.close();}
 for(const id of ids){
   if(s.currentWorkers.length>=c.maxConcurrent)break;if(s.currentWorkers.some(w=>w.issue===id))continue;
   const outcome=s.outcomes[id];if(outcome?.terminal||outcome?.nextAt>Date.now())continue;
   const t=eligible(c,id);if(!t||t.claim_actor&&t.claim_actor!==c.actor&&t.lease_until>Date.now()/1000)continue;
   const cwd=realpathSync(t.meta.execution.cwd);
   if(s.currentWorkers.some(w=>!w.cwd||inside(w.cwd,cwd)||inside(cwd,w.cwd)))continue;
   const cp=native(c,'resume',{id});if(cp.cancel_requested)continue;
   let phase='';try{phase=JSON.parse(cp.checkpoint?.text??'{}').phase??'';}catch{phase='corrupt';}
   if(['run_failed','verify_failed','corrupt'].includes(phase)){s.outcomes[id]={terminal:true,code:1,at:Date.now(),error:'known failed or corrupt checkpoint',nextAt:0};persist(c,s);continue;}
   if((s.attempts[id]??0)>c.maxRestarts){s.outcomes[id]={terminal:true,code:1,at:Date.now(),error:'retry_exhausted',nextAt:0};persist(c,s);continue;}
   startWorker(c,s,id,cwd);
 }
}
async function daemon(c:Config){
 const inherited=Number(process.env.SIS_SERVICE_LOCK_FD);if(!Number.isSafeInteger(inherited)||inherited<100||!fstatSync(inherited).isFile())throw Error('foreground lock descriptor required');
 const owner=JSON.parse(readFileSync(ownerFile(c),'utf8'));if(owner.pid!==process.pid||owner.instance!==process.env.SIS_SERVICE_INSTANCE||owner.configHash!==hash(c))throw Error('lock owner mismatch');
 const context=native(c,'context');if(context.capabilities?.local_zero_execution!==true)throw Error('local-zero native core required');
 const goal=native(c,'show',{id:c.goal}).issue;if(goal.owner!==c.actor)throw Error('service goal owner mismatch');
 let s=readState(c);if(!s)s={id:c.id,configHash:hash(c),instance:owner.instance,pid:process.pid,pidBirth:'',startedAt:Date.now(),heartbeatAt:0,heartbeatMonotonicMs:0,currentWorkers:[],outcomes:{},attempts:{},tickErrors:[],paused:false};
 s.instance=owner.instance;s.pid=process.pid;s.pidBirth=processIdentity(process.pid)??'';s.paused=existsSync(pauseFile(c));
 let stopping=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});const start=performance.now();
 while(!stopping){
   s.heartbeatAt=Date.now();s.heartbeatMonotonicMs=Math.round(performance.now()-start);s.paused=existsSync(pauseFile(c));persist(c,s);
   try{reconcile(c,s);if(!s.paused){if(c.soak)await (await import('./service-soak')).tick(c);await dispatch(c,s);}}catch(e){recordFailure(c,s,e);if(c.soak)(await import('./service-soak')).recordError(c,e);}
   persist(c,s);await Bun.sleep(c.pollMs);
 }
 const until=Date.now()+c.deadlineSecs*1000;while(s.currentWorkers.length&&Date.now()<until){reconcile(c,s);persist(c,s);await Bun.sleep(100);}
 persist(c,s);if(s.currentWorkers.length)throw Error('drain deadline exceeded; workflow locks retained by live children');
}
async function foreground(c:Config,path:string){
 mkdirSync(c.stateDir,{recursive:true,mode:0o700});
 const python=process.env.SIS_SERVICE_PYTHON??'/usr/bin/python3';
 const p=spawn(python,[join(ROOT,'tools/service-lock.py'),join(c.stateDir,c.id+'.lock'),ownerFile(c),hash(c),process.execPath,SCRIPT,'daemon','--config',path],{stdio:'inherit'});
 const stop=(signal:NodeJS.Signals)=>{if(p.exitCode===null)p.kill(signal);};process.on('SIGTERM',()=>stop('SIGTERM'));process.on('SIGINT',()=>stop('SIGINT'));
 p.once('error',e=>{console.error(e.message);process.exitCode=1;});const code=await new Promise<number|null>(r=>p.once('close',r));if(code!==0)throw Error(`service foreground exited ${code}`);
}
const label=(c:Config,kind:string)=>`com.openai.superiss.${c.id}.${kind}`;
const plistFile=(c:Config,kind:string)=>join(homedir(),'Library/LaunchAgents',label(c,kind)+'.plist');
const receiptFile=(c:Config)=>join(c.stateDir,c.id+'.installation.json');
const xml=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
export function launchArguments(text:string){const found=text.match(/arguments = \{\s*\n([\s\S]*?)\n\s*\}/);if(!found)throw Error('launchd arguments unavailable');return found[1].split('\n').map(s=>s.trim()).filter(Boolean);}
function ownedJob(c:Config,path:string,kind:string){const p=Bun.spawnSync(['/bin/launchctl','print',`gui/${process.getuid!()}/${label(c,kind)}`],{stdout:'pipe',stderr:'pipe',timeout:5000});if(p.exitCode!==0){if(/could not find service|no such process/i.test(p.stderr.toString()))return false;throw Error('launchd status unavailable');}const expected=[process.execPath,SCRIPT,kind==='main'?'foreground':'watchdog','--config',path];if(canonical(launchArguments(p.stdout.toString()))!==canonical(expected))throw Error('foreign loaded launchd job preserved');return true;}
function plist(c:Config,path:string,kind:string){const args=[process.execPath,SCRIPT,kind==='main'?'foreground':'watchdog','--config',path];return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label(c,kind)}</string><key>ProgramArguments</key><array>${args.map(v=>`<string>${xml(v)}</string>`).join('')}</array><key>RunAtLoad</key><true/>${kind==='main'?'<key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>':'<key>StartInterval</key><integer>30</integer>'}<key>ProcessType</key><string>Background</string><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>`;}
function installation(c:Config,path:string){
 if(!existsSync(receiptFile(c)))throw Error('owned installation receipt absent');const r=JSON.parse(readFileSync(receiptFile(c),'utf8'));
 if(r.configHash!==hash(c)||r.configPath!==path||r.script!==SCRIPT||r.scriptHash!==hash(readFileSync(SCRIPT,'utf8')))throw Error('installation identity changed');
 for(const kind of ['main','watchdog'])if(r.plists[kind]!==hash(readFileSync(plistFile(c,kind),'utf8')))throw Error('foreign or changed plist preserved');return r;
}
function manage(c:Config,path:string,action:string){
 if(process.platform!=='darwin')throw Error('launchd requires macOS');const domain=`gui/${process.getuid!()}`;
 if(action==='uninstall'){installation(c,path);for(const kind of ['watchdog','main'])ownedJob(c,path,kind);atomic(pauseFile(c),{paused:true});for(const kind of ['watchdog','main']){const r=Bun.spawnSync(['/bin/launchctl','bootout',`${domain}/${label(c,kind)}`],{stdout:'pipe',stderr:'pipe',timeout:5000});if(r.exitCode!==0&&!/could not find service|no such process/i.test(r.stderr.toString()))throw Error('launchd bootout failed: '+r.stderr.toString());unlinkSync(plistFile(c,kind));}unlinkSync(receiptFile(c));return;}
 if(existsSync(receiptFile(c)))installation(c,path);else for(const k of ['main','watchdog'])if(existsSync(plistFile(c,k)))throw Error('foreign plist preserved');
 for(const kind of ['main','watchdog'])if(ownedJob(c,path,kind)&&!existsSync(receiptFile(c)))throw Error('loaded service has no own installation receipt; preserved');
 const plists:Record<string,string>={};for(const k of ['main','watchdog']){const text=plist(c,path,k),file=plistFile(c,k);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text,{mode:0o600});command(['/usr/bin/plutil','-lint',file]);plists[k]=hash(text);}
 atomic(receiptFile(c),{schema:1,id:c.id,configHash:hash(c),configPath:path,script:SCRIPT,scriptHash:hash(readFileSync(SCRIPT,'utf8')),plists});
 for(const kind of ['main','watchdog']){const loaded=Bun.spawnSync(['/bin/launchctl','print',`${domain}/${label(c,kind)}`],{stdout:'ignore',stderr:'ignore',timeout:5000});if(loaded.exitCode!==0)command(['/bin/launchctl','bootstrap',domain,plistFile(c,kind)],5000);}
}
export function watchdogDecision(c:Config,s:State,owner:any){
 if(s.configHash!==hash(c)||owner.configHash!==s.configHash||owner.pid!==s.pid||owner.instance!==s.instance)throw Error('watchdog ownership mismatch');
 const live=processIdentity(owner.pid);if(!live||live!==s.pidBirth)throw Error('watchdog PID identity changed or gone');
 return Date.now()-s.heartbeatAt>c.watchdogSecs*1000;
}
function watchdog(c:Config,path:string){
 installation(c,path);if(!ownedJob(c,path,'main'))throw Error('owned launchd service absent');const s=readState(c);if(!s)throw Error('state missing; no restart');const owner=JSON.parse(readFileSync(ownerFile(c),'utf8'));if(!watchdogDecision(c,s,owner))return;
 const file=join(c.stateDir,c.id+'.watchdog.json');const old=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{restarts:[]};const restarts=(old.restarts as number[]).filter(t=>Date.now()-t<3600000);if(restarts.length>=3)throw Error('watchdog restart cap reached');
 atomic(file,{restarts:[...restarts,Date.now()],instance:s.instance});command(['/bin/launchctl','kickstart','-k',`gui/${process.getuid!()}/${label(c,'main')}`],5000);
}
async function main(){const [op,...args]=process.argv.slice(2);if(op==='defaults'){console.log(JSON.stringify({service:SERVICE_DEFAULTS,agents:AGENT_DEFAULTS}));return;}const i=args.indexOf('--config'),agentOp=['agent-ready','enqueue-agent'].includes(op);const requested=i<0&&agentOp?join(homedir(),'.local/state/superiss-service/agents/config.json'):args[i+1];if(!requested||!isAbsolute(requested))throw Error('--config ABS required');const path=realpathSync(requested),c=await loadConfig(path);
 if(op==='agent-ready'){const q=args.indexOf('--quota');if(q<0||!args[q+1])throw Error('--quota required');console.log(JSON.stringify(agentReady(c,JSON.parse(readFileSync(args[q+1],'utf8')))));return;}
 if(op==='enqueue-agent'){const t=args.indexOf('--task');if(t<0||!args[t+1])throw Error('--task required');console.log(JSON.stringify(enqueueAgent(c,JSON.parse(readFileSync(args[t+1],'utf8')))));return;}
 if(op==='foreground')return foreground(c,path);if(op==='daemon')return daemon(c);if(op==='install'||op==='uninstall')return manage(c,path,op);if(op==='watchdog')return watchdog(c,path);
 if(op==='pause'){atomic(pauseFile(c),{paused:true,at:Date.now()});return;}if(op==='resume'){if(existsSync(pauseFile(c)))unlinkSync(pauseFile(c));return;}
 if(op==='status'){const s=readState(c),running=!!s&&processIdentity(s.pid)===s.pidBirth;console.log(JSON.stringify({running,healthy:running&&Date.now()-s!.heartbeatAt<=c.watchdogSecs*1000,paused:existsSync(pauseFile(c)),state:s}));return;}throw Error('unknown service command');
}
if(import.meta.main)main().catch(e=>{console.error(JSON.stringify({error:String(e.message)}));process.exitCode=1;});
