import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Engine } from './engine.ts';
import { array, canonical, integer, now, object, rootDirectory, SisError, type Obj } from './util.ts';

export async function startHttp(engine: Engine,port: number,dispatch: (request: Obj)=>Promise<Obj>): Promise<Server> {
  integer(port,'http port',undefined,1,65535);
  const server=createServer({maxHeaderSize:16384},async(req,res)=>{
    const send=(value: Obj,status=200)=>{ if (!res.destroyed && !res.writableEnded) { res.writeHead(status,{'content-type':'application/json; charset=utf-8','x-content-type-options':'nosniff','cache-control':'no-store'}); res.end(canonical(value)); } };
    try {
      const authority=req.headers.host ?? '', allowed=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
      if (!allowed.has(authority)) { send({ok:false,error:{code:'forbidden_origin',msg:'loopback Host required'}},403); return; }
      if (req.headers.origin && req.headers.origin!==`http://${authority}`) { send({ok:false,error:{code:'forbidden_origin',msg:'same-origin request required'}},403); return; }
      const url=new URL(req.url ?? '/',`http://${authority}`);
      if (req.method==='GET' && (url.pathname==='/' || url.pathname==='/board.html')) { res.writeHead(200,{'content-type':'text/html; charset=utf-8','x-content-type-options':'nosniff'}); res.end(readFileSync(join(rootDirectory,'web','board.html'))); return; }
      if (req.method==='GET' && url.pathname==='/health') { send({ok:true,data:{ok:true}}); return; }
      if (req.method==='GET' && url.pathname==='/board') { send({ok:true,data:{stats:await engine.dispatch('stats'),issues:await engine.dispatch('list',{limit:1000})}}); return; }
      if (req.method==='GET' && url.pathname==='/events') {
        const after=Number(url.searchParams.get('after') ?? 0), wait=Number(url.searchParams.get('wait') ?? 0);
        integer(after,'after'); if (!Number.isFinite(wait) || wait<0 || wait>300) throw new SisError('bad_args','wait must be within 0..300');
        let result=await dispatch({cmd:'watch',args:{after,limit:1000}}); const until=now()+wait;
        while (!array(object(result.data).events).length && now()<until && !res.destroyed) { await delay(50); result=await dispatch({cmd:'watch',args:{after,limit:1000}}); }
        send(result,result.ok ? 200 : 400); return;
      }
      let input: Obj;
      if (req.method==='GET' && url.pathname==='/op') input=object(JSON.parse(url.searchParams.get('q') ?? '{}'));
      else if (req.method==='POST') {
        const chunks: Buffer[]=[]; let size=0;
        for await (const chunk of req) { const data=Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size+=data.length; if (size>1024*1024) { send({ok:false,error:{code:'frame_too_large',msg:'request exceeds 1 MiB'}},413); req.destroy(); return; } chunks.push(data); }
        input=object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } else { send({ok:false,error:{code:'not_found',msg:'unknown HTTP route'}},404); return; }
      const result=await dispatch(input); send(result,result.ok ? 200 : 400);
    } catch (error) { send({ok:false,error:{code:error instanceof SisError ? error.code : error instanceof SyntaxError ? 'bad_json' : 'internal',msg:error instanceof Error ? error.message.slice(0,2000) : String(error)}},400); }
  });
  server.maxConnections=128; server.headersTimeout=10000; server.requestTimeout=15000; server.keepAliveTimeout=5000; server.setTimeout(310000);
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  server.on('error',error=>process.stderr.write(`superiss HTTP: ${error.message}\n`));
  return server;
}
