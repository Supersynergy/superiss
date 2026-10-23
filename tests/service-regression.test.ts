import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,realpathSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('real job completion remains visible in durable service state',async()=>{
 const base=realpathSync(mkdtempSync(join(tmpdir(),'sis-service-state-'))),root=join(import.meta.dir,'..'),sis=join(root,'bin/sis'),db=join(base,'private.db'),jobs=join(base,'jobs');mkdirSync(jobs);
 const call=(cmd:string,args:any)=>{const p=Bun.spawnSync([sis,cmd,JSON.stringify(args),'--db',db],{stdout:'pipe',stderr:'pipe'});if(p.exitCode)throw Error(p.stderr.toString());return JSON.parse(p.stdout.toString());};
 call('goal',{name:'test',id:'test',owner:'worker'});writeFileSync(join(jobs,'input'),'accepted');
 call('create',{id:'test.1',title:'Local fixture',owner:'worker',budget_eur:0,allowed_paths:['input'],oracle_cmd:'test -s output',meta:{parent:'test',local_zero:true,execution:{cmd:'cp input output',cwd:jobs,replay_safe:true,oracle_replay_safe:true}}});
 const config=join(base,'config.json'),state=join(base,'state');writeFileSync(config,JSON.stringify({id:'regression',db,goal:'test',actor:'worker',stateDir:state,sis,jobRoot:jobs,extraSpendEur:0,providerMode:'local-only',pollMs:200}));
 const p=Bun.spawn([process.execPath,join(root,'tools/service.ts'),'foreground','--config',config],{stdout:'ignore',stderr:'ignore'});
 try{const until=Date.now()+8000;let status='';while(Date.now()<until){status=call('show',{id:'test.1'}).issue.status;if(status==='closed')break;await Bun.sleep(100);}expect(status).toBe('closed');await Bun.sleep(500);const s=JSON.parse(readFileSync(join(state,'regression.state.json'),'utf8'));expect(s.attempts['test.1']).toBeGreaterThan(0);expect(s.outcomes['test.1'].terminal).toBe(true);
 }finally{p.kill('SIGTERM');await Promise.race([p.exited,Bun.sleep(3000)]);if(p.exitCode===null){p.kill('SIGKILL');await p.exited;}rmSync(base,{recursive:true,force:true});}
},15000);
