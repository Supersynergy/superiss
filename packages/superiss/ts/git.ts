import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { git, required, SisError, text, type Obj } from './util.ts';

export function collectChanges(a: Obj,db: string): Obj {
  const requested=resolve(text(a.repo,'.')), root=git(requested,'rev-parse','--show-toplevel')?.trim();
  if (!root) throw new SisError('not_a_git_repo',requested);
  const requestedBase=text(a.base,'HEAD');
  const base=git(root,'rev-parse','--verify','--end-of-options',requestedBase+'^{commit}')?.trim();
  if (!base) throw new SisError('bad_args','base must identify an existing commit');
  const files=new Map<string,Obj>(), mirror=basename(db).replace(/\.db$/u,'')+'.issues.jsonl';
  const excluded=(path: string)=>path.split('/').some(part=>['.git','.sis','.sisf'].includes(part)) || path===mirror || path.endsWith('/'+mirror);
  const statuses=(git(root,'diff','--name-status','-z','--find-renames',base,'--') ?? '').split('\0');
  for (let i=0;i<statuses.length;) {
    const state=statuses[i++]; if (!state) continue;
    const first=statuses[i++], renamed=state.startsWith('R') || state.startsWith('C'), path=renamed ? statuses[i++] : first;
    if (!path || excluded(path)) continue;
    files.set(path,{path,status:state[0],adds:0,dels:0,hunks:[],...(renamed ? {renamed_from:first} : {})});
  }
  const counts=(git(root,'diff','--numstat','-z','--find-renames',base,'--') ?? '').split('\0');
  for (let i=0;i<counts.length;i++) {
    const match=/^([^\t]+)\t([^\t]+)\t(.*)$/u.exec(counts[i]); if (!match) continue;
    let path=match[3]; if (!path) { i++; path=counts[++i]; }
    const item=files.get(path); if (!item) continue;
    item.adds=match[1]==='-' ? 0 : Number(match[1]); item.dels=match[2]==='-' ? 0 : Number(match[2]); if (match[1]==='-') item.binary=true;
  }
  const diff=git(root,'diff','--no-ext-diff','--find-renames','--unified=0',base,'--') ?? '';
  const unquote=(value: string)=>{ if (value.startsWith('"')) { try { return String(JSON.parse(value)); } catch { return value; } } return value; };
  for (const chunk of diff.split(/^diff --git /mu).slice(1)) {
    const plus=chunk.match(/^\+\+\+ (.+)$/mu)?.[1], minus=chunk.match(/^--- (.+)$/mu)?.[1], rename=chunk.match(/^rename to (.+)$/mu)?.[1];
    let path=rename ? unquote(rename) : plus && plus!=='/dev/null' ? unquote(plus).replace(/^b\//u,'') : minus ? unquote(minus).replace(/^a\//u,'') : '';
    const item=files.get(path); if (!item) continue;
    const hunks: number[][]=[];
    for (const hunk of chunk.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gmu)) { const count=Number(hunk[4] ?? 1), start=Number(count ? hunk[3] : hunk[1]), length=count || Number(hunk[2] ?? 1); if (length) hunks.push([start,start+length-1]); }
    item.hunks=hunks;
  }
  const untracked=(git(root,'ls-files','--others','--exclude-standard','-z') ?? '').split('\0');
  for (const path of untracked) {
    if (!path || excluded(path)) continue;
    const full=join(root,path); if (!existsSync(full) || !statSync(full).isFile()) continue;
    const raw=readFileSync(full), binary=raw.includes(0), adds=binary ? 0 : raw.length ? raw.toString('utf8').split('\n').length-(raw[raw.length-1]===10 ? 1 : 0) : 0;
    files.set(path,{path,status:'A',adds,dels:0,hunks:adds ? [[1,adds]] : [],...(binary ? {binary:true} : {})});
  }
  return {...a,files:[...files.values()].sort((x,y)=>required(x,'path').localeCompare(required(y,'path'))),repo:root,base:requestedBase,head:git(root,'rev-parse','HEAD')?.trim() ?? null,head_subject:git(root,'log','-1','--format=%s')?.trim() ?? null,branch:git(root,'branch','--show-current')?.trim() || null,...(a.patch===true ? {patch:diff.slice(0,65536),patch_truncated:Buffer.byteLength(diff)>65536} : {})};
}
