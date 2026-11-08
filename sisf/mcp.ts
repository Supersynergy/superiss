import { createInterface } from 'node:readline';
import { VERSION } from '../packages/superiss/runtime.ts';
import { forgeOperations } from './workflow.ts';

export async function serveMCP(action: (name: string, args: any) => Promise<any>): Promise<void> {
  const descriptions: Record<string,string> = {
    bind:'Bind an active task claim to its isolated worktree.',changes:'Read the bound Git diff.',record:'Record changes and source-bound artifact evidence; does not make a Git commit.',
    'git-commit':'Commit staged files using an explicit message; all=true explicitly stages all files.',push:'Explicitly push the bound branch to origin; never force pushes.',verify:'Execute the task oracle in the bound worktree.',
    pr:'Find or create an open pull request for the bound branch/base; does not push.',ci:'Read CI for the exact bound HEAD; no checks is not success.',rebase:'Rebase onto the configured local base; verify again afterwards.',
    merge:'Preflight proof, check CI, fast-forward local base, and close the task; keeps worktree and does not push base. skip_ci=true is an explicit local-only bypass of CI, never of proof.',
  };
  const tools = forgeOperations.map(op => ({name:'sis_forge_' + op.replaceAll('-','_'),description:descriptions[op],inputSchema:{type:'object',required:['id','actor','epoch'],properties:{id:{type:'string'},actor:{type:'string'},epoch:{type:'integer',minimum:1},message:{type:'string'},all:{type:'boolean'},proof_id:{type:'string'},skip_ci:{type:'boolean'},via:{type:'string',enum:['github','gitea','forgejo']},timeout_secs:{type:'integer'},title:{type:'string'}},additionalProperties:false}}));
  let pending = 0, queue = Promise.resolve();
  const lines = createInterface({input:process.stdin,crlfDelay:Infinity});
  const send = (value: any) => {
    const frame = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(frame) + process.stdout.writableLength > 2 * 1024 * 1024) throw Error('MCP output capacity exceeded');
    process.stdout.write(frame);
  };
  const error = (id: any,code: number,message: string) => send({jsonrpc:'2.0',id,error:{code,message}});
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > 1024 * 1024 || pending >= 64) { error(null,-32600,'MCP frame/queue limit exceeded'); lines.close(); break; }
    let message: any;
    try { message = JSON.parse(line); } catch { error(null,-32700,'Parse error'); continue; }
    if (message?.jsonrpc !== '2.0' || message.id == null) continue;
    pending++;
    queue = queue.then(async () => {
      const {id,method,params} = message;
      if (method === 'initialize') return send({jsonrpc:'2.0',id,result:{protocolVersion:params?.protocolVersion || '2024-11-05',capabilities:{tools:{listChanged:false}},serverInfo:{name:'superiss-forge',version:VERSION}}});
      if (method === 'ping') return send({jsonrpc:'2.0',id,result:{}});
      if (method === 'tools/list') return send({jsonrpc:'2.0',id,result:{tools}});
      if (method !== 'tools/call') return error(id,-32601,'Unknown method');
      const op = forgeOperations.find(op => 'sis_forge_' + op.replaceAll('-','_') === params?.name);
      if (!op) return error(id,-32602,'Unknown tool');
      try { const result = await action(op,params.arguments || {}); send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}],isError:result.ok !== true}}); }
      catch (caught) { send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify({ok:false,error:{code:'forge',msg:(caught as Error).message}})}],isError:true}}); }
    }).finally(() => { pending--; });
  }
  await queue;
}
