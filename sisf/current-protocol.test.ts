import { test, expect } from 'bun:test';
import { createServer } from 'node:net';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _test } from './sisf.ts';
import { VERSION } from '../packages/superiss/runtime.ts';

async function fixture(version=VERSION){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'sis-protocol-v11-'))),db=join(root,'project.db'),sock=join(root,'server.sock');writeFileSync(db,'fixture');
  const commands:string[]=[];
  const server=createServer(socket=>{let buffer='';socket.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const req=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);commands.push(req.cmd);const respond=(data:any)=>socket.write(JSON.stringify({ok:true,data})+'\n');if(req.cmd==='context')respond({project_id:'current',db_path:db,capabilities:{version,protocol:2,proof_receipts:true}});else if(req.cmd==='watch')respond({events:[{seq:1}]});else if(req.cmd==='verify')setTimeout(()=>respond({passed:true}),100);else respond({id:req.args.id,heartbeat:true});}});});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(sock,resolve);});
  const client=new _test.Sis({db,sock} as any);
  return {client,commands,async cleanup(){client.close();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true});}};
}
test('current single-frame watch settles and does not consume the next command response',async()=>{
  const f=await fixture();try{expect((await f.client.call('watch',{wait:1})).data.events).toHaveLength(1);expect((await f.client.call('show',{id:'next'})).data.id).toBe('next');}finally{await f.cleanup();}
},2000);
test('forge rejects a 1.0 daemon before a mutation',async()=>{
  const f=await fixture('1.0.0');try{await expect(f.client.call('claim',{id:'must-not-write',actor:'worker'})).rejects.toThrow(/runtime_version_mismatch/);expect(f.commands).toEqual(['context']);}finally{await f.cleanup();}
},2000);
test('a long oracle on the adapter does not serialize a heartbeat behind it',async()=>{
  const f=await fixture();try{await f.client.call('context');let finished=false;const oracle=f.client.call('verify',{id:'task'}).then(value=>{finished=true;return value;});await new Promise(resolve=>setTimeout(resolve,20));expect((await f.client.call('heartbeat',{id:'task'})).data.heartbeat).toBe(true);expect(finished).toBe(false);expect((await oracle).data.passed).toBe(true);}finally{await f.cleanup();}
},2000);
