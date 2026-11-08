import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pullRequest, ciStatus, parseRemote } from './connectors.ts';

function fixture(){const root=mkdtempSync(join(tmpdir(),'sis-connectors-'));for(const args of [['init','-qb','main'],['remote','add','origin','https://github.com/owner/project.git']]){const r=spawnSync('git',['-C',root,...args],{encoding:'utf8'});if(r.status)throw Error(r.stderr);}return {root,cleanup(){rmSync(root,{recursive:true,force:true});}};}
const sha='a'.repeat(40);
test('Gitea and Forgejo reuse only exact branch/base matches, then create an explicit receipt',async()=>{
  const f=fixture(),saved=globalThis.fetch,seen:any[]=[];let existing=true;
  globalThis.fetch=(async(url:any,opts:any)=>{seen.push({url:String(url),opts});if(opts.method==='GET')return Response.json(existing?[{number:7,html_url:'https://forge.invalid/o/r/pulls/7',head:{ref:'sis/task'},base:{ref:'release'}}]:[]);return Response.json({number:8,html_url:'https://forge.invalid/o/r/pulls/8'});}) as any;
  try{
    const config={url:'https://forge.invalid',token:'test-only'};
    expect((await pullRequest('gitea',config,f.root,'sis/task','release','task','Title')).reused).toBe(true);expect(seen).toHaveLength(1);
    existing=false;const result=await pullRequest('forgejo',config,f.root,'sis/task','release','task','Title');expect(result.reused).toBe(false);
    expect(JSON.parse(seen[2].opts.body)).toEqual({head:'sis/task',base:'release',title:'[task] Title'});expect(seen[2].opts.redirect).toBe('error');expect(seen[2].opts.headers.authorization).toBe('token test-only');
  }finally{globalThis.fetch=saved;f.cleanup();}
});
test('REST failures, malformed receipts, truncated search and no CI checks never become success',async()=>{
  const f=fixture(),saved=globalThis.fetch;let mode='empty';
  globalThis.fetch=(async(url:any,opts:any)=>{
    if(mode==='error')return Response.json({message:'denied'},{status:403});
    if(String(url).includes('/status'))return Response.json({state:'success',statuses:[]});
    if(mode==='truncated')return Response.json(Array.from({length:100},()=>({})));
    if(opts.method==='GET')return Response.json([]);
    return Response.json({number:1,html_url:'javascript:alert(1)'});
  }) as any;
  try{
    expect((await ciStatus('gitea',{url:'https://forge.invalid'},f.root,sha)).state).toBe('none');
    await expect(pullRequest('gitea',{url:'https://forge.invalid'},f.root,'sis/task','main','task','Title')).rejects.toThrow(/receipt/);
    mode='truncated';await expect(pullRequest('gitea',{url:'https://forge.invalid'},f.root,'sis/task','main','task','Title')).rejects.toThrow(/truncated/);
    mode='error';await expect(ciStatus('forgejo',{url:'https://forge.invalid'},f.root,sha)).rejects.toThrow(/403/);
    expect(parseRemote('https://forge.invalid/../repo.git')).toBeNull();
  }finally{globalThis.fetch=saved;f.cleanup();}
});
test('GitHub CLI receives explicit repo/base and exact-HEAD checks with fail-closed pagination',async()=>{
  const f=fixture(),saved=process.env.SISF_GH,log=join(f.root,'calls'),mode=join(f.root,'mode'),program=join(f.root,'gh');
  writeFileSync(program,`#!${process.execPath}\nimport {appendFileSync,readFileSync} from 'node:fs';const a=process.argv.slice(2);appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');const mode=readFileSync(${JSON.stringify(mode)},'utf8');if(a[0]==='pr'&&a[1]==='list')console.log('[]');else if(a[0]==='pr'&&a[1]==='create')console.log('https://github.com/owner/project/pull/3');else if(a[0]==='pr')console.log(JSON.stringify({number:3,url:'https://github.com/owner/project/pull/3'}));else if(a[1].includes('check-runs'))console.log(JSON.stringify({total_count:mode==='truncated'?2:mode==='empty'?0:1,check_runs:mode==='empty'?[]:[{status:mode==='pending'?'in_progress':'completed',conclusion:mode==='failure'?'failure':'success'}]}));else console.log(JSON.stringify({total_count:0,statuses:[]}));\n`);chmodSync(program,0o755);process.env.SISF_GH=program;
  try{
    writeFileSync(mode,'success');const pr=await pullRequest('github',null,f.root,'sis/task','release','task','Title');expect(pr.number).toBe(3);
    const calls=readFileSync(log,'utf8').trim().split('\n').map(x=>JSON.parse(x));expect(calls[1]).toContain('--base');expect(calls[1][calls[1].indexOf('--base')+1]).toBe('release');expect(calls[1]).toContain('owner/project');
    for(const value of ['success','pending','failure','empty'] as const){writeFileSync(mode,value);expect((await ciStatus('github',null,f.root,sha)).state).toBe(value==='empty'?'none':value);}
    expect(readFileSync(log,'utf8')).toContain(sha);writeFileSync(mode,'truncated');await expect(ciStatus('github',null,f.root,sha)).rejects.toThrow(/truncated/);
  }finally{if(saved===undefined)delete process.env.SISF_GH;else process.env.SISF_GH=saved;f.cleanup();}
});
