/** Paired tokenizer transport probe; process initialization is recorded separately. */
import {spawn, spawnSync} from 'node:child_process';
import {createConnection} from 'node:net';
import {existsSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
const [binary, output, db] = process.argv.slice(2);
const socketPath='/tmp/sis-tokenbench-'+process.pid+'.sock';
const req={cmd:'tokens',args:{text:'hello world',encoding:'o200k_base'}};
const deadline=performance.now()+30000;
const daemon=spawn(binary,['serve','--db',db],{env:{...process.env,SIS_SOCK:socketPath,SIS_HTTP:''},stdio:['ignore','ignore','pipe']});
let diagnostics=''; daemon.stderr.on('data', chunk=>{diagnostics=(diagnostics+chunk).slice(-4096);});
function acceptance(reply:any){const value=reply.ok===true?reply.data:reply;if(value.tokens!==2||value.exact!==true||value.billing!==false)throw Error('Tokenizer oracle failed');}
async function socketCall(){
 const start=performance.now();
 return await new Promise<number>((resolve,reject)=>{
  const socket=createConnection(socketPath);let data='';
  const fail=(e:Error)=>{socket.destroy();reject(e);};
  socket.setEncoding('utf8');socket.setTimeout(3000,()=>fail(Error('Socket deadline')));
  socket.on('error',fail);socket.once('connect',()=>socket.write(JSON.stringify(req)+'\n'));
  socket.on('data',part=>{data+=part;if(data.length>65536)return fail(Error('Oversized output'));if(data.includes('\n')){try{acceptance(JSON.parse(data.split('\n')[0]));socket.destroy();resolve(performance.now()-start);}catch(e){fail(e as Error);}}});
 });
}
function cliCall(){
 const start=performance.now();const r=spawnSync(binary,['tokens',JSON.stringify(req.args),'--db',db],{encoding:'utf8',timeout:3000,maxBuffer:65536});
 if(r.status!==0||r.error)throw Error(r.stderr||String(r.error));acceptance(JSON.parse(r.stdout));return performance.now()-start;
}
try{
 while(!existsSync(socketPath)){if(daemon.exitCode!==null||performance.now()>deadline)throw Error(diagnostics||'Daemon failed');await new Promise(r=>setTimeout(r,10));}
 const initializationMs=await socketCall();
 const pairs=[];
 for(let i=0;i<20;i++){
  if(performance.now()>deadline)throw Error('Probe deadline');
  let cliMs:number,socketMs:number;
  if(i%2){socketMs=await socketCall();cliMs=cliCall();}else{cliMs=cliCall();socketMs=await socketCall();}
  pairs.push({pair:i,cliMs,socketMs});
 }
 const median=(values:number[])=>{values.sort((a,b)=>a-b);return(values[9]+values[10])/2;};
 writeFileSync(output,JSON.stringify({binarySha256:createHash('sha256').update(readFileSync(binary)).digest('hex'),request:req,oracle:'tokens=2 exact=true billing=false',pairs,processInitializationMs:initializationMs,medianCliMs:median(pairs.map(p=>p.cliMs)),medianWarmDaemonMs:median(pairs.map(p=>p.socketMs)),cacheState:'new CLI process versus initialized daemon; OS cache uncontrolled',providerCost:null},null,2)+'\n');
}finally{
 const exited=new Promise<void>(resolve=>daemon.once('exit',()=>resolve()));daemon.kill('SIGTERM');
 await Promise.race([exited,new Promise<void>(resolve=>setTimeout(()=>{if(daemon.exitCode===null)daemon.kill('SIGKILL');resolve();},1000))]);
 rmSync(socketPath,{force:true});
}
