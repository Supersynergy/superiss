import { randomBytes, createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { relative, resolve, isAbsolute, sep } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { Cfg, WorktreeRow } from './sisf.ts';
import { command, git } from './process.ts';
import { ciStatus, type Connector } from './connectors.ts';

export interface ForgeDependencies {
  cfg: Cfg; state: Database;
  sis: { call(cmd: string, args?: any): Promise<any> };
  active(id: string, actor?: string, epoch?: number): Promise<any>;
  bind(id: string, actor?: string, epoch?: number, lane?: string, repo?: string): {path: string; branch: string};
  changes(path: string, base: string): any;
  record(id: string, actor?: string, epoch?: number): Promise<any>;
  pr(args: any): Promise<any>;
}
export const forgeOperations = ['bind', 'changes', 'record', 'git-commit', 'push', 'verify', 'pr', 'ci', 'rebase', 'merge'] as const;
export async function forgeAction(d: ForgeDependencies, action: string, args: any): Promise<any> {
  if (!forgeOperations.includes(action as any)) throw Error('Unknown forge operation: ' + action);
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.id !== 'string' || !args.id.trim()) throw Error('Task id required');
  if (action === 'merge' && (typeof args.proof_id !== 'string' || !args.proof_id)) throw Error('Merge requires an explicit proof_id from forge verify');
  const {cfg,state,sis} = d, fence = {id:args.id,actor:args.actor,epoch:args.epoch};
  // Even reads establish the native project binding before opening a task worktree.
  if (action === 'pr') return d.pr(args);
  const task = await d.active(args.id,args.actor,args.epoch);
  const wk = d.bind(args.id,args.actor,args.epoch,task.lane,task.meta?.repo_key);
  const row = state.query<WorktreeRow,[string]>('SELECT * FROM worktrees WHERE task=?').get(args.id)!;
  const repo = cfg.repos[row.repo_key || 'default'];
  const clean = (path: string) => { if (git(path,'status','--porcelain') !== '') throw Error('Worktree is dirty or unreadable: commit/reconcile before ' + action); };
  const head = () => { const value = git(wk.path,'rev-parse','--verify','HEAD'); if (!value) throw Error('Missing worktree HEAD'); return value; };
  if (action === 'bind') return {ok:true,data:{...wk,backend:row.backend,repo_key:row.repo_key}};
  if (action === 'changes') return {ok:true,data:d.changes(wk.path,row.base)};
  if (action === 'record') return d.record(args.id,args.actor,args.epoch);
  if (action === 'verify') return sis.call('verify',{...fence,cwd:wk.path,...(args.timeout_secs === undefined ? {} : {timeout_secs:args.timeout_secs})});
  if (action === 'ci') return {ok:true,data:await ciStatus((args.via || cfg.connector || 'github') as Connector,cfg.gitea,wk.path,head())};
  if (action === 'git-commit') {
    if (typeof args.message !== 'string' || !args.message.trim() || Buffer.byteLength(args.message) > 8192) throw Error('Explicit commit message required (max 8 KiB)');
    // Staging is opt-in: never sweep unrelated untracked files into a commit.
    if (args.all === true) await command('git',['add','--all','--','.'],wk.path,30000);
    if (git(wk.path,'diff','--cached','--quiet') !== '') {
      await d.active(args.id,args.actor,args.epoch);
      await command('git',['commit','-m',args.message],wk.path,30000);
    } else throw Error('No staged changes; stage files explicitly or use --all');
    const sha = head();
    state.run('UPDATE worktrees SET head=?,updated=? WHERE task=?',[sha,Date.now()/1000,args.id]);
    const recorded = await d.record(args.id,args.actor,args.epoch);
    return recorded.ok ? {ok:true,data:{...recorded.data,git_commit:true,head:sha}} : {ok:false,git_commit:true,head:sha,error:recorded.error};
  }
  if (action === 'push') {
    clean(wk.path); const sha = head();
    if (git(wk.path,'check-ref-format','refs/heads/' + wk.branch) === null) throw Error('Invalid bound branch');
    await command('git',['push','--','origin',`refs/heads/${wk.branch}:refs/heads/${wk.branch}`],wk.path,60000);
    return {ok:true,data:{pushed:true,head:sha,branch:wk.branch}};
  }
  if (action === 'rebase') {
    clean(wk.path);
    const target = git(row.repo,'rev-parse','--verify','--end-of-options',(repo.base || 'main') + '^{commit}');
    if (!target) throw Error('Configured base commit unavailable');
    await command('git',['rebase',target],wk.path,30000);
    return {ok:true,data:{head:head(),verify_required:true,note:'Run forge verify after rebase; old proofs may be stale'}};
  }
  // Merge never rewrites a verified source commit and never pushes the base.
  if (typeof args.proof_id !== 'string' || !args.proof_id) throw Error('Merge requires an explicit proof_id from forge verify');
  clean(wk.path); const sha = head(), target = repo.base || 'main';
  const check = await sis.call('close_check',{...fence,proof_id:args.proof_id});
  if (!check.ok) return check;
  if (realpathSync(check.data.cwd) !== realpathSync(wk.path)) throw Error('Proof belongs to another worktree');
  if (args.skip_ci !== true) {
    const ci = await ciStatus((args.via || cfg.connector || 'github') as Connector,cfg.gitea,wk.path,sha);
    if (ci.state !== 'success') throw Error('Merge requires passing CI for exact HEAD (no checks is not success)');
  }
  const slotActor = 'forge-' + randomBytes(16).toString('hex');
  const name = 'forge-merge:' + createHash('sha256').update(realpathSync(row.repo) + '\0' + target).digest('hex');
  const slot = await sis.call('slot_acquire',{name,actor:slotActor,ttl:120});
  if (!slot.ok) return slot;
  let merged = false;
  try {
    const live = await d.active(args.id,args.actor,args.epoch);
    if (live.lease_until < Date.now()/1000 + 35) throw Error('Renew the claim before merge: at least 35 seconds of lease required');
    clean(wk.path); clean(row.repo);
    if (head() !== sha) throw Error('Source HEAD changed while checking CI; verify again');
    if (git(row.repo,'branch','--show-current') !== target) throw Error('Target branch must be checked out in the configured repository');
    if (git(row.repo,'merge-base','--is-ancestor',target,sha) === null) throw Error('Target advanced: rebase and verify again before merge');
    const changed = git(wk.path,'diff','--name-only','-z',target,sha,'--');
    if (changed === null) throw Error('Cannot establish the merge diff');
    const rawScopes = typeof task.allowed_paths === 'string' ? JSON.parse(task.allowed_paths) : task.allowed_paths;
    if (!Array.isArray(rawScopes) || !rawScopes.length) throw Error('Explicit source scope required for merge');
    const scopes = rawScopes.map((scope: string) => {
      const path = relative(realpathSync(wk.path),resolve(wk.path,scope));
      if (isAbsolute(path) || path === '..' || path.startsWith('..' + sep)) throw Error('Merge source scope must remain inside the bound worktree');
      return path.split(sep).join('/');
    });
    const outside = changed.split('\0').filter(Boolean).filter(path => !scopes.some(scope => !scope || path === scope || path.startsWith(scope + '/')));
    if (outside.length) throw Error('Merge changes files outside the proof source scope; update the contract and verify again');
    const current = await sis.call('close_check',{...fence,proof_id:args.proof_id});
    if (!current.ok) return current;
    if (row.backend === 'worktrunk') {
      await command(cfg.worktrunk || 'wt',['-C',wk.path,'merge',target,'--branch',wk.branch,'--no-commit','--no-rebase','--no-remove','--no-hooks'],wk.path,30000);
    } else await command('git',['merge','--ff-only','--no-edit',sha],row.repo,30000);
    merged = true; clean(row.repo);
    if (git(row.repo,'rev-parse','HEAD') !== sha || head() !== sha) throw Error('Merge result differs from verified HEAD; reconcile');
    const closed = await sis.call('close',{...fence,proof_id:args.proof_id});
    if (!closed.ok) return {ok:false,merged:true,closed:false,head:sha,error:closed.error};
    state.run("UPDATE worktrees SET status='closed',head=?,updated=? WHERE task=?",[sha,Date.now()/1000,args.id]);
    return {ok:true,data:{merged:true,closed:true,head:sha,target,backend:row.backend,retained_worktree:wk.path,remote_pushed:false}};
  } catch (error) {
    return {ok:false,merged,closed:false,head:sha,error:{code:'forge_merge',msg:(error as Error).message,reconcile:merged}};
  } finally {
    // A failed release never rolls back an already applied merge or steals a slot.
    const released = await sis.call('slot_release',{name,actor:slotActor,epoch:slot.data.epoch}).catch(() => null);
    if (!released?.ok) process.stderr.write('[sisf] merge slot release uncertain; inspect slot_list before retry\n');
  }
}
