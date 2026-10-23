import {afterEach,describe,expect,test} from 'bun:test';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {loadConfig,launchArguments} from '../tools/service.ts';

let root='';
afterEach(async()=>{if(root)await rm(root,{recursive:true,force:true});root='';});
async function fixture(patch:Record<string,unknown>={}){root=await realpath(await mkdtemp(join(tmpdir(),'sis-service-')));const c={id:'test',db:join(root,'db.sqlite'),goal:'goal-1',actor:'tester',stateDir:join(root,'state'),sis:'/bin/true',jobRoot:join(root,'jobs'),extraSpendEur:0,providerMode:'local-only',...patch};const path=join(root,'config.json');await writeFile(path,JSON.stringify(c));return {path,c};}
describe('service config contract',()=>{
 test('launchd identity parser retains exact arguments and rejects absent identity',()=>{expect(launchArguments('arguments = {\n  /opt/bun\n  /path with space/service.ts\n  foreground\n}\n')).toEqual(['/opt/bun','/path with space/service.ts','foreground']);expect(()=>launchArguments('unrelated job')).toThrow();});
 test('applies bounded defaults to explicit local-only configuration',async()=>{const {path}=await fixture();const c=await loadConfig(path);expect(c.pollMs).toBe(1000);expect(c.maxConcurrent).toBe(4);expect(c.zeroCostLock).toBe(1);});
 test('rejects provider mode, cost and path escape',async()=>{for(const patch of [{providerMode:'remote'},{extraSpendEur:0.01},{jobRoot:'/tmp/jobs',stateDir:'/tmp/jobs/state'}]){const {path}=await fixture(patch);await expect(loadConfig(path)).rejects.toThrow();await rm(root,{recursive:true,force:true});root='';}});
 test('test-only short soak needs explicit override',async()=>{const {path}=await fixture({soak:{durationSecs:60}});await expect(loadConfig(path)).rejects.toThrow('86400');});
 test('foreground starts and drains against a private native Superiss DB',async()=>{
  root=await realpath(await mkdtemp(join(tmpdir(),'sis-service-live-')));const repo=join(import.meta.dir,'..');const db=join(root,'private.db');
  const created=spawnSync(join(repo,'bin/sis'),['goal_create',JSON.stringify({name:'lifecycle',objective:'private lifecycle',owner:'tester'}),'--db',db,'--json'],{encoding:'utf8'});
  expect(created.status).toBe(0);const goal=JSON.parse(created.stdout).id;
  const cfg={id:'private',db,goal,actor:'tester',stateDir:join(root,'state'),sis:join(repo,'bin/sis'),jobRoot:join(root,'jobs'),extraSpendEur:0,providerMode:'local-only',pollMs:200};const config=join(root,'config.json');await writeFile(config,JSON.stringify(cfg));
  const child=spawn('/opt/homebrew/bin/bun',[join(repo,'tools/service.ts'),'foreground','--config',config],{stdio:'ignore'});
  try{await new Promise<void>((resolve,reject)=>{const t=setTimeout(()=>reject(Error('service startup timeout')),5000);const check=setInterval(async()=>{try{const s=JSON.parse(await readFile(join(cfg.stateDir,'private.state.json'),'utf8'));if(s.heartbeatAt){clearTimeout(t);clearInterval(check);resolve();}}catch{}},50);child.once('error',reject);});
   child.kill('SIGTERM');const code=await new Promise<number|null>(resolve=>child.once('close',resolve));expect(code).toBe(0);const s=JSON.parse(await readFile(join(cfg.stateDir,'private.state.json'),'utf8'));expect(s.configHash).toHaveLength(64);expect(s.currentWorkers).toHaveLength(0);
  }finally{if(child.exitCode===null)child.kill('SIGKILL');}
 });
});
