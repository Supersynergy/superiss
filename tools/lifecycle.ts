import {readFileSync, writeFileSync, openSync, closeSync, existsSync, realpathSync, renameSync, unlinkSync, mkdirSync, rmdirSync} from 'node:fs';
import {resolve,dirname,basename,join} from 'node:path';
import {createHash} from 'node:crypto';
import {createConnection} from 'node:net';
import {spawn} from 'node:child_process';
const [root,command,...args]=process.argv.slice(2);
let database=process.env.SIS_DB;
for(let i=0;i<args.length;i++)if(args[i]==='--db')database=args[++i];
function fail(message:string):never{throw Error(message);}
if(!database)fail('Explicit --db or SIS_DB required; project selection is never inferred.');
const absolute=resolve(database);
const db=existsSync(absolute)?realpathSync(absolute):join(realpathSync(dirname(absolute)),basename(absolute));
const sock=process.env.SIS_SOCK||'/tmp/sis-'+createHash('sha256').update(db).digest('hex').slice(0,20)+'.sock';
const ownerPath=db+'.serve.owner.json';
async function context():Promise<any>{
 return new Promise((resolveReply,reject)=>{
  const client=createConnection(sock);let body='';
  const failRead=(error:Error)=>{client.destroy();reject(error);};
  client.setEncoding('utf8');client.setTimeout(1000,()=>failRead(Error('Daemon identity timeout')));client.on('error',failRead);
  client.once('end',()=>failRead(Error('Daemon closed before a complete identity response')));
  client.once('connect',()=>client.write('{"cmd":"context","args":{}}\n'));
  client.on('data',part=>{body+=part;if(Buffer.byteLength(body)>65536)return failRead(Error('Oversized context'));if(!body.includes('\n'))return;
   try{const reply=JSON.parse(body.split('\n')[0]),v=reply.data;client.destroy();
    if(reply.ok!==true||realpathSync(v.db_path)!==db||!v.project_id||!v.instance_id||!Number.isSafeInteger(v.pid)||v.capabilities?.protocol!==2)throw Error('Database/socket identity mismatch');resolveReply(v);
   }catch(error){failRead(error as Error);}
  });
 });
}
async function existing(){try{return await context();}catch(error){if(['ENOENT','ECONNREFUSED'].includes((error as any).code))return null;throw error;}}
async function main(){
 const live=await existing();
 if(command==='status'){console.log(JSON.stringify({up:!!live,db,sock,pid:live?.pid,project_id:live?.project_id,instance_id:live?.instance_id}));return;}
 if(command==='down'){
  if(!live){console.log(JSON.stringify({down:false,reason:'not_running'}));return;}
  if(!existsSync(ownerPath))fail('Daemon has no owner receipt from sis up; its process is preserved.');
  const owner=JSON.parse(readFileSync(ownerPath,'utf8'));
  if(owner.pid!==live.pid||owner.instance_id!==live.instance_id||owner.project_id!==live.project_id||owner.db!==db||owner.sock!==sock)fail('Daemon ownership changed; process preserved.');
  process.kill(live.pid,'SIGTERM');
  const deadline=Date.now()+3000;
  while(Date.now()<deadline){
   let alive=true;
   try { process.kill(live.pid,0); }
   catch(error){
    if((error as any).code==='ESRCH')alive=false;
    else throw error;
   }
   if(!alive){
    const saved=JSON.parse(readFileSync(ownerPath,'utf8'));
    if(saved.instance_id===live.instance_id)unlinkSync(ownerPath);
    console.log(JSON.stringify({down:true,pid:live.pid}));return;
   }
   await new Promise(r=>setTimeout(r,30));
  }
  fail('Owned daemon did not stop in 3s; no escalation performed.');
 }
 if(live){console.log(JSON.stringify({up:true,already:true,pid:live.pid}));return;}
 const fd=openSync(db+'.serve.log','a',0o600);
 const child=spawn(join(root,'bin/sis'),['serve','--db',db],{detached:true,stdio:['ignore',fd,fd],env:{...process.env,SIS_SOCK:sock}});closeSync(fd);
 let spawnError:Error|undefined;child.once('error',e=>{spawnError=e;});child.unref();
 const deadline=Date.now()+10000;
 while(Date.now()<deadline){
  if(spawnError)throw spawnError;
  const running=await existing();
  if(running){if(running.pid!==child.pid)fail('Another daemon won startup; no owner receipt replaced.');
   const temporary=ownerPath+'.'+process.pid+'.tmp';writeFileSync(temporary,JSON.stringify({db,sock,pid:running.pid,project_id:running.project_id,instance_id:running.instance_id}),{mode:0o600,flag:'wx'});renameSync(temporary,ownerPath);
   console.log(JSON.stringify({up:true,db,sock,pid:running.pid}));return;
  }
  if(child.exitCode!==null)fail('Daemon startup failed; inspect '+db+'.serve.log');
  await new Promise(r=>setTimeout(r,30));
 }
 fail('Startup timeout; reconcile the log and socket before retry.');
}
async function execute(){
 if(command==='status')return main();
 const lock=db+'.lifecycle.lock';
 try{mkdirSync(lock,{mode:0o700});}
 catch(error){if((error as any).code==='EEXIST')fail('Lifecycle busy; inspect '+lock+'/pid before recovery.');throw error;}
 try{writeFileSync(join(lock,'pid'),String(process.pid),{mode:0o600,flag:'wx'});return await main();}
 finally{unlinkSync(join(lock,'pid'));rmdirSync(lock);}
}
await execute().catch(error=>{console.error(JSON.stringify({error:{code:'lifecycle',msg:error.message}}));process.exitCode=1;});
