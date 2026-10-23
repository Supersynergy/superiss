import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {canonical,loadConfig,processIdentity,watchdogDecision,agentReady,enqueueAgent} from '../tools/service';

const repo=realpathSync(join(import.meta.dir,'..')),sis=join(repo,'bin/sis'),script=join(repo,'tools/service.ts');
const fixtures:Fixture[]=[];
const env={...process.env,SIS_IMPL:'rs',SIS_DIRECT:'1',SIS_SOCK:undefined,SIS_DB:undefined,SIS_HTTP:undefined,SIS_SNAPSHOT:'0',SIS_ADMIN_TOKEN:'private-service-chaos-fixture'};
async function until<T>(read:()=>T|undefined|false,description:string,ms=10000):Promise<T>{const end=Date.now()+ms;while(Date.now()<end){const value=read();if(value)return value;await Bun.sleep(40);}throw Error('timeout: '+description);}
class Fixture{
 base=realpathSync(mkdtempSync(join(tmpdir(),'sis-service-chaos-')));db=join(this.base,'private.db');jobs=join(this.base,'jobs');stateDir=join(this.base,'state');config=join(this.base,'config.json');
 processes:ReturnType<typeof Bun.spawn>[]=[];identities=new Map<number,string>();
 c={id:'chaos',db:this.db,goal:'chaos-goal',actor:'worker',stateDir:this.stateDir,sis,jobRoot:this.jobs,extraSpendEur:0,providerMode:'local-only',pollMs:200,timeoutSecs:5,deadlineSecs:15,maxRestarts:3,watchdogSecs:10};
 constructor(){fixtures.push(this);mkdirSync(this.jobs);mkdirSync(this.stateDir);writeFileSync(join(this.jobs,'input'),'source-bound fixture\n');writeFileSync(this.config,JSON.stringify(this.c));this.call('goal',{name:'private chaos',id:this.c.goal,owner:this.c.actor});}
 call(op:string,args:unknown={}){const p=Bun.spawnSync([sis,op,JSON.stringify(args),'--db',this.db],{env,stdout:'pipe',stderr:'pipe',timeout:10000});if(p.exitCode!==0)throw Error(op+': '+p.stdout.toString()+p.stderr.toString());const r=JSON.parse(p.stdout.toString());return r.data??r;}
 task(id='job',cmd='cp input output',patch:Record<string,unknown>={}){this.call('create',{id,title:'Private chaos fixture '+id,owner:'worker',budget_eur:0,allowed_paths:['input'],oracle_cmd:'test -s output',meta:{parent:this.c.goal,local_zero:true,execution:{cmd,cwd:this.jobs,replay_safe:false,oracle_replay_safe:false}},...patch});}
 state(){const file=join(this.stateDir,'chaos.state.json');return existsSync(file)?JSON.parse(readFileSync(file,'utf8')):undefined;}
 start(){const p=Bun.spawn([process.execPath,script,'foreground','--config',this.config],{env,stdout:'pipe',stderr:'pipe'});this.processes.push(p);return p;}
 op(op:string){const p=Bun.spawnSync([process.execPath,script,op,'--config',this.config],{env,stdout:'pipe',stderr:'pipe',timeout:5000});expect(p.exitCode).toBe(0);return p;}
 remember(pid:number){const birth=processIdentity(pid);if(!birth)throw Error('owned process disappeared: '+pid);const ps=Bun.spawnSync(['/bin/ps','-p',String(pid),'-o','command='],{stdout:'pipe'}).stdout.toString();if(!ps.includes(this.base))throw Error('refusing foreign PID '+pid+': '+ps);this.identities.set(pid,birth);return pid;}
 signal(pid:number,signal:NodeJS.Signals){if(!this.identities.has(pid))this.remember(pid);if(processIdentity(pid)===this.identities.get(pid))process.kill(pid,signal);}
 async healthy(){return until(()=>{const s=this.state();return s?.heartbeatAt&&processIdentity(s.pid)===s.pidBirth?s:undefined;},'daemon heartbeat');}
 async closed(id='job'){await until(()=>this.call('show',{id}).issue.status==='closed','native fenced close');return until(()=>this.state()?.outcomes[id]?.terminal&&this.state(),'durable terminal outcome');}
 async stop(){const s=this.state();if(s&&processIdentity(s.pid)===s.pidBirth)this.signal(s.pid,'SIGTERM');await Promise.all(this.processes.map(async p=>{await Promise.race([p.exited,Bun.sleep(3000)]);if(p.exitCode===null){p.kill('SIGKILL');await p.exited;}}));}
 async cleanup(){let s;try{s=this.state();}catch{}if(s){for(const w of s.currentWorkers??[])if(processIdentity(w.pid)===w.birth)this.signal(w.pid,'SIGTERM');if(processIdentity(s.pid)===s.pidBirth)this.signal(s.pid,'SIGTERM');}await Promise.all(this.processes.map(async p=>{await Promise.race([p.exited,Bun.sleep(1500)]);if(p.exitCode===null){p.kill('SIGKILL');await p.exited;}}));for(const [pid,birth] of this.identities)if(processIdentity(pid)===birth)process.kill(pid,'SIGKILL');rmSync(this.base,{recursive:true,force:true});}
}
afterEach(async()=>{for(const f of fixtures.splice(0))await f.cleanup();});

test('real OS lock admits one of two simultaneous foreground daemons',async()=>{
 const f=new Fixture(),a=f.start(),b=f.start();const s=await f.healthy();f.remember(s.pid);
 await until(()=>a.exitCode!==null||b.exitCode!==null,'singleton rejection');
 expect([a.exitCode,b.exitCode].filter(code=>code===null)).toHaveLength(1);
 const loser=a.exitCode===null?b:a;expect(await loser.exited).not.toBe(0);expect(await new Response(loser.stderr).text()).toContain('service already running');
 const owner=JSON.parse(readFileSync(join(f.stateDir,'chaos.owner.json'),'utf8'));expect(owner.pid).toBe(s.pid);await f.stop();
},15000);

test('worker SIGKILL resumes from native receipt without replaying its effect',async()=>{
 const f=new Fixture();f.task('job','printf x >> runs; printf "%s" $$ > shell.pid; sleep 1; cp input output');f.start();await f.healthy();
 await until(()=>existsSync(join(f.jobs,'shell.pid')),'real execution shell marker');
 const worker=await until(()=>f.state()?.currentWorkers[0],'owned controller');f.remember(worker.pid);f.signal(worker.pid,'SIGKILL');
 const state=await f.closed();expect(readFileSync(join(f.jobs,'runs'),'utf8')).toBe('x');expect(state.attempts.job).toBeGreaterThan(1);expect(state.currentWorkers).toHaveLength(0);await f.stop();
},20000);

test('daemon SIGKILL releases OS lock and restart reconciles live private work',async()=>{
 const f=new Fixture();f.task('job','printf x >> runs; printf "%s" $$ > shell.pid; sleep 1; cp input output');const original=f.start(),s=await f.healthy();
 await until(()=>existsSync(join(f.jobs,'shell.pid')),'execution before daemon crash');f.remember(s.pid);f.signal(s.pid,'SIGKILL');await original.exited;
 const replacement=f.start();const resumed=await until(()=>{const next=f.state();return next?.pid!==s.pid&&processIdentity(next?.pid)===next?.pidBirth?next:undefined;},'restart with new daemon identity');
 expect(resumed.instance).not.toBe(s.instance);expect(replacement.exitCode).toBeNull();await f.closed();expect(readFileSync(join(f.jobs,'runs'),'utf8')).toBe('x');await f.stop();
},20000);

test('pause survives foreground restart and explicit resume dispatches the job',async()=>{
 const f=new Fixture();f.task();f.op('pause');f.start();await f.healthy();await Bun.sleep(600);expect(f.state().paused).toBe(true);expect(f.state().attempts).toEqual({});await f.stop();
 f.start();await f.healthy();await Bun.sleep(600);expect(f.state().paused).toBe(true);expect(f.call('show',{id:'job'}).issue.status).toBe('open');f.op('resume');await f.closed();await f.stop();
},20000);

test('known command failure becomes terminal and does not spin after restart',async()=>{
 const f=new Fixture();f.task('job','printf x >> failures; exit 7',{oracle_cmd:'printf v >> unexpected-oracle; test -s output'});f.start();await f.healthy();
 await until(()=>f.state()?.outcomes.job?.terminal,'terminal known run failure');expect(f.state().outcomes.job.error).toContain('run_failed');await Bun.sleep(700);expect(f.state().attempts.job).toBe(1);expect(readFileSync(join(f.jobs,'failures'),'utf8')).toBe('x');expect(existsSync(join(f.jobs,'unexpected-oracle'))).toBe(false);await f.stop();
 f.start();await f.healthy();await Bun.sleep(700);expect(f.state().attempts.job).toBe(1);expect(f.call('show',{id:'job'}).issue.status).not.toBe('closed');await f.stop();
},20000);

test('foreign owner, positive budget and absent local-zero authorization never dispatch',async()=>{
 const f=new Fixture();f.task('foreign','printf x > forbidden-owner',{owner:'another'});f.task('paid','printf x > forbidden-paid',{budget_eur:1});f.task('unapproved','printf x > forbidden-unapproved',{meta:{parent:f.c.goal,execution:{cmd:'printf x > forbidden-unapproved',cwd:f.jobs}}});f.task('accepted');f.start();await f.healthy();await f.closed('accepted');await Bun.sleep(600);
 for(const id of ['foreign','paid','unapproved']){expect(f.call('show',{id}).issue.status).toBe('open');expect(f.state().attempts[id]).toBeUndefined();}for(const file of ['forbidden-owner','forbidden-paid','forbidden-unapproved'])expect(existsSync(join(f.jobs,file))).toBe(false);await f.stop();
},15000);

test('goal owner mismatch refuses startup before executing an otherwise eligible task',async()=>{
 const f=new Fixture();f.task();f.c.actor='foreign';writeFileSync(f.config,JSON.stringify(f.c));const p=f.start();expect(await p.exited).not.toBe(0);expect(await new Response(p.stderr).text()).toContain('service goal owner mismatch');expect(existsSync(join(f.jobs,'output'))).toBe(false);expect(f.state()).toBeUndefined();
},10000);

test('configured jobRoot rejects task execution in a sibling work directory',async()=>{
 const f=new Fixture(),outside=join(f.base,'outside-job-root');mkdirSync(outside);writeFileSync(join(outside,'input'),'outside fixture');
 f.task('outside','cp input output',{meta:{parent:f.c.goal,local_zero:true,execution:{cmd:'cp input output',cwd:outside,replay_safe:false,oracle_replay_safe:false}}});f.task('control');f.start();await f.healthy();await f.closed('control');await Bun.sleep(600);
 expect(existsSync(join(outside,'output'))).toBe(false);expect(f.state().attempts.outside).toBeUndefined();expect(f.call('show',{id:'outside'}).issue.status).toBe('open');await f.stop();
},15000);

test('corrupt durable state fails closed and preserves bytes for reconciliation',async()=>{
 const f=new Fixture();f.task();const file=join(f.stateDir,'chaos.state.json');writeFileSync(file,'{interrupted state');const p=f.start();expect(await p.exited).not.toBe(0);expect(await new Response(p.stderr).text()).toContain('state corrupt or identity mismatch');expect(readFileSync(file,'utf8')).toBe('{interrupted state');expect(existsSync(join(f.jobs,'output'))).toBe(false);
},10000);

test('watchdog rejects foreign ownership and changed process birth using live identity',async()=>{
 const f=new Fixture();f.op('pause');f.start();const state=await f.healthy(),c=await loadConfig(f.config),owner=JSON.parse(readFileSync(join(f.stateDir,'chaos.owner.json'),'utf8'));
 expect(watchdogDecision(c,state,owner)).toBe(false);expect(()=>watchdogDecision(c,state,{...owner,instance:'foreign'})).toThrow('ownership mismatch');expect(()=>watchdogDecision(c,state,{...owner,pid:process.pid})).toThrow('ownership mismatch');expect(()=>watchdogDecision(c,{...state,pidBirth:'foreign birth'},owner)).toThrow('PID identity changed');
 expect(processIdentity(state.pid)).toBe(state.pidBirth);expect(state.configHash).toBe(createHash('sha256').update(canonical(c)).digest('hex'));await f.stop();
},10000);

test('four default workers run in disjoint workspaces and overlapping scopes wait',async()=>{
 const f=new Fixture();delete (f.c as any).maxConcurrent;
 for(let n=0;n<5;n++){const dir=join(f.jobs,'lane-'+n);mkdirSync(dir);writeFileSync(join(dir,'input'),'lane '+n);const id='lane-'+n;f.task(id,'sleep 1; cp input output',{meta:{parent:f.c.goal,local_zero:true,execution:{cmd:'sleep 1; cp input output',cwd:dir,replay_safe:false,oracle_replay_safe:false}}});}
 f.task('overlap','sleep 1; cp input output',{meta:{parent:f.c.goal,local_zero:true,execution:{cmd:'sleep 1; cp input output',cwd:join(f.jobs,'lane-0'),replay_safe:false,oracle_replay_safe:false}}});writeFileSync(f.config,JSON.stringify(f.c));f.start();await f.healthy();
 const parallel=await until(()=>{const s=f.state();return s?.currentWorkers.length===4?s:undefined;},'four disjoint workers');expect(new Set(parallel.currentWorkers.map((w:any)=>w.cwd)).size).toBe(4);expect(parallel.currentWorkers.some((w:any)=>w.issue==='overlap')).toBe(false);
 for(const id of ['lane-0','lane-1','lane-2','lane-3','lane-4','overlap'])await f.closed(id);expect(f.state().tickErrors).toEqual([]);await f.stop();
},20000);

test('host agent selection requires explicit authorization, live quota and conflict-free native readiness',async()=>{
 const f=new Fixture(),model=(id:string,patch:Record<string,unknown>={})=>f.task(id,'unused',{meta:{parent:f.c.goal,execution:{kind:'host-agent',cwd:f.jobs,auto_dispatch:true,transport:'codex-host-included'}},...patch});
 model('approved');model('overlap');model('foreign',{owner:'another'});model('paid',{budget_eur:1});model('unapproved',{meta:{parent:f.c.goal,cwd:f.jobs,transport:'codex-host-included'}});model('blocked');f.call('dep',{issue:'blocked',depends_on:'approved',type:'blocks'});
 const config=await loadConfig(f.config),quota={source:'mcp__codex_app__get_usage_limits',observedAt:Date.now(),capacity:{ownActive:0,freeSlots:3,ownScopes:[] as string[],foreignScopes:[] as string[]},usage:{ordinaryUsageAllowed:true,accountId:'fixture',rateLimits:{limitId:'codex',planType:'pro',spendControlReached:false,rateLimitReachedType:null,credits:{hasCredits:false,unlimited:false,balance:'0'},primary:{usedPercent:41,resetsAt:Math.floor(Date.now()/1000)+3600}}}};
 expect(agentReady(config,{}).ready).toEqual([]);const result=agentReady(config,quota);expect(result.eligible).toBe(true);expect(result.dispatchAuthorized).toBe(false);expect(result.ready.map(t=>t.id)).toEqual(['approved']);expect(f.call('show',{id:'approved'}).issue.claim_actor).toBeNull();quota.capacity.foreignScopes=[join(f.jobs,'input')];expect(agentReady(config,quota).ready).toEqual([]);quota.capacity.foreignScopes=[];quota.capacity.ownActive=1;expect(agentReady(config,quota).reason).toBe('fresh_capacity_required');quota.capacity.ownScopes=[join(f.jobs,'input')];expect(agentReady(config,quota).ready).toEqual([]);
},10000);

test('blocked dependencies wait without consuming retries, then start automatically',async()=>{
 const f=new Fixture();f.c.maxRestarts=0;writeFileSync(f.config,JSON.stringify(f.c));
 for(const id of ['before','after']){const cwd=join(f.jobs,id);mkdirSync(cwd);writeFileSync(join(cwd,'input'),id);const cmd=id==='before'?'sleep 2; cp input output':'cp input output';f.task(id,cmd,{meta:{parent:f.c.goal,local_zero:true,execution:{cmd,cwd,replay_safe:false,oracle_replay_safe:false}}});}
 f.call('dep',{issue:'after',depends_on:'before',type:'blocks'});f.start();await f.healthy();await Bun.sleep(700);expect(f.state().attempts.after).toBeUndefined();await f.closed('before');await f.closed('after');expect(f.state().attempts.after).toBe(1);await f.stop();
},15000);

test('enqueue-agent supplies zero-cost owner and transport defaults without broadening file scope',async()=>{
 const f=new Fixture(),c=await loadConfig(f.config),task={id:'automatic',title:'Explicit fixture task',cwd:f.jobs,oracle_cmd:'test -s input',allowed_paths:['input']};enqueueAgent(c,task);const t=f.call('show',{id:'automatic'}).issue;expect(t.owner).toBe(c.actor);expect(t.budget_eur).toBe(0);expect(t.meta.execution.auto_dispatch).toBe(true);expect(t.meta.execution.transport).toBe('codex-host-included');expect(t.meta.execution.cwd).toBe(f.jobs);expect(t.claim_actor).toBeNull();expect(()=>enqueueAgent(c,{...task,id:'bad',allowed_paths:['../outside']})).toThrow();expect(()=>enqueueAgent(c,{...task,id:'bad',owner:'foreign'})).toThrow();const before=f.call('contract',{id:'automatic'}).revision;f.call('update',{id:'automatic',actor:c.actor,meta:{parent:c.goal,execution:{...t.meta.execution,auto_dispatch:false}}});expect(f.call('contract',{id:'automatic'}).revision).not.toBe(before);
},10000);
