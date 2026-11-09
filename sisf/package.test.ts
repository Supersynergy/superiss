import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { packageRelease } from '../tools/package-v1.ts';
import { VERSION } from '../packages/superiss/runtime.ts';

const repository = join(import.meta.dir,'..');
const messages = [
  {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05'}},
  {jsonrpc:'2.0',id:2,method:'tools/list'},
];
test('relocated 1.1 bundle has an exact manifest and runnable core, forge and both MCP entry points',()=>{
  const root=mkdtempSync(join(tmpdir(),'sis-v11-package-')),bundle=join(root,'relocated'),db=join(root,'smoke.db');
  const env: NodeJS.ProcessEnv={...process.env,SIS_BUN:process.execPath,SIS_DB:db,SIS_IMPL:'ts'};delete env.SIS_SOCK;
  try{
    const manifest=packageRelease(bundle);expect(manifest.version).toBe(VERSION);
    const files=readdirSync(bundle,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>join(e.parentPath,e.name).slice(bundle.length+1)).sort();
    expect(files).toEqual(['manifest.json',...Object.keys(manifest.files)].sort());
    for(const [path,hash] of Object.entries(manifest.files))expect(createHash('sha256').update(readFileSync(join(bundle,path))).digest('hex')).toBe(hash);
    expect(()=>packageRelease(bundle)).toThrow(/overwrite/);
    const run=(program:string,args:string[],input?:string)=>{const r=spawnSync(program,args,{cwd:root,env,encoding:'utf8',input,timeout:20000});expect(r.status,r.stderr).toBe(0);return r.stdout;};
    const launcher=join(bundle,'bin/sis');expect(run('bash',[launcher,'--version']).trim()).toBe(VERSION);expect(JSON.parse(run('bash',[launcher,'capabilities'])).version).toBe(VERSION);
    expect(run('bash',[launcher,'forge','--help'])).toContain(VERSION+' forge');
    expect(run('bash',[join(bundle,'bin/sisf'),'--help'])).toContain(VERSION+' forge');
    const input=messages.map(m=>JSON.stringify(m)).join('\n')+'\n';
    const core=run('node',[join(bundle,'mcp/sis-mcp.js')],input).trim().split('\n').map(line=>JSON.parse(line));
    expect(core[0].result.serverInfo.version).toBe(VERSION);expect(core[1].result.tools).toHaveLength(88);
    const forge=run('bash',[launcher,'forge','mcp'],input).trim().split('\n').map(line=>JSON.parse(line));
    expect(forge[0].result.serverInfo.version).toBe(VERSION);expect(forge[1].result.tools).toHaveLength(11);
    const reservation = forge[1].result.tools.find((tool: { name: string }) => tool.name === 'sis_forge_reserve');
    expect(reservation.inputSchema.required).toEqual(['id','actor','title','oracle_cmd','allowed_paths']);
    expect(reservation.inputSchema.required).not.toContain('epoch');
  }finally{rmSync(root,{recursive:true,force:true});}
},30000);

test('core MCP refuses a tool hidden by the worker profile',()=>{
  const root=mkdtempSync(join(tmpdir(),'sis-mcp-profile-'));
  try{
    const db=join(root,'profile.db');
    const input=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'sis_create',arguments:{id:'must-not-exist',title:'Hidden'}}})+'\n';
    const result=spawnSync(process.execPath,[join(repository,'packages/superiss/cli.ts'),'mcp','--db',db],{env:{...process.env,SIS_MCP_PROFILE:'agent',SIS_DIRECT:'1'},input,encoding:'utf8',timeout:10000});
    expect(result.status,result.stderr).toBe(0);expect(JSON.parse(result.stdout).error.message).toContain('unselected');
    const shown=spawnSync(process.execPath,[join(repository,'packages/superiss/cli.ts'),'show','must-not-exist','--db',db],{env:{...process.env,SIS_DIRECT:'1'},encoding:'utf8'});expect(shown.status).toBe(2);
  }finally{rmSync(root,{recursive:true,force:true});}
});
