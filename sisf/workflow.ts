import { randomBytes, createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { relative, resolve, isAbsolute, sep } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { Cfg, WorktreeRow } from './sisf.ts';
import { command, git, failureDetails } from './process.ts';
import { acquireMergeLock, MergeLockConflict } from './merge-lock.ts';
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
export const forgeOperations = ['reserve', 'bind', 'changes', 'record', 'git-commit', 'push', 'verify', 'pr', 'ci', 'rebase', 'merge'] as const;
export async function forgeAction(d: ForgeDependencies, action: string, args: any): Promise<any> {
  if (!forgeOperations.includes(action as any)) throw Error('Unknown forge operation: ' + action);
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.id !== 'string' || !args.id.trim()) throw Error('Task id required');
  if (action === 'merge' && (typeof args.proof_id !== 'string' || !args.proof_id)) throw Error('Merge requires an explicit proof_id from forge verify');
  const {cfg,state,sis} = d, fence = {id:args.id,actor:args.actor,epoch:args.epoch};
  if (action === 'reserve') {
    if (typeof args.actor !== 'string' || !args.actor.trim() || cfg.actors !== undefined && !cfg.actors.includes(args.actor)) throw Error('Explicit actor inside configured scope required');
    if (typeof args.title !== 'string' || !args.title.trim() || typeof args.oracle_cmd !== 'string' || !args.oracle_cmd.trim()) throw Error('Explicit title and executable oracle_cmd required');
    if (!Array.isArray(args.allowed_paths) || !args.allowed_paths.length || args.allowed_paths.some((scope: unknown) => typeof scope !== 'string' || !scope.trim() || isAbsolute(scope) || scope.split(/[\\/]/).includes('..'))) throw Error('Explicit nonempty relative allowed_paths inside the worktree required');
    if (args.idem !== undefined && (typeof args.idem !== 'string' || !args.idem.trim() || args.idem.length > 256)) throw Error('idem must be a nonempty key of at most 256 characters');
    if (args.ttl !== undefined && (!Number.isSafeInteger(args.ttl) || args.ttl < 60 || args.ttl > 86400)) throw Error('ttl must be an integer from 60 to 86400 seconds');
    if (args.acceptance !== undefined && typeof args.acceptance !== 'string') throw Error('acceptance must be a string');
    const owner = args.owner ?? args.actor;
    if (typeof owner !== 'string' || !owner.trim()) throw Error('owner must be nonempty');
    const selected = args.repo_key ?? cfg.defaultRepoKey ?? 'default';
    if (typeof selected !== 'string' || !Object.hasOwn(cfg.repos, selected)) throw Error('Unknown reservation repository');
    const reserved = await sis.call('batch', { actor: args.actor, ...(args.idem ? { idem: args.idem } : {}), ops: [
      { cmd: 'create', args: { id: args.id, title: args.title, owner, oracle_cmd: args.oracle_cmd, allowed_paths: args.allowed_paths, acceptance: args.acceptance ?? '', meta: { controller: owner, repo_key: selected } } },
      { cmd: 'contract', args: { id: args.id } },
      { cmd: 'claim', args: { id: args.id, actor: args.actor, ttl: args.ttl ?? 1800 } },
    ] });
    if (!reserved?.ok) return reserved;
    const claim = reserved.data?.results?.[2];
    if (!claim || !Number.isSafeInteger(claim.epoch)) throw Error('Reservation acknowledgement invalid; reconcile native task before retry');
    const claimed = { ...claim, actor: args.actor };
    let bound: ReturnType<ForgeDependencies['bind']> | undefined;
    try {
      await d.active(args.id, args.actor, claim.epoch);
      // A retry with the same idem key may return an older contract. Read it fresh.
      const contract = await sis.call('contract', { id: args.id });
      if (!contract?.ok) return { ok: false, data: { claim: claimed, bound: false, claim_preserved: true }, error: contract?.error };
      // Contract refresh is async. Its earlier claim observation is no longer
      // sufficient authority for a Git write.
      const live = await d.active(args.id, args.actor, claim.epoch);
      if (live.lease_until < Date.now()/1000 + 35) throw Error('Renew the claim before binding: at least 35 seconds of lease required');
      bound = d.bind(args.id, args.actor, claim.epoch, live.lane, live.meta?.repo_key);
      // Git creation may outlast the lease or race another native actor. Keep
      // its artifact for reconciliation, but never return an owned stale tree.
      const current = await d.active(args.id, args.actor, claim.epoch);
      return { ok: true, data: { ...bound, bound: true, claim: { ...claimed, lease_until: current.lease_until }, contract: contract.data?.structured ?? contract.data?.task } };
    } catch (error) {
      return { ok: false, data: { claim: claimed, bound: false, claim_preserved: true, ...(bound ? { worktree: bound.path, branch: bound.branch, reconcile_required: true } : {}) }, error: { code: 'binding_failed', msg: (error as Error).message } };
    }
  }
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
  if (action === 'ci') {
    const via = (args.via || cfg.connector || 'github') as Connector;
    if (['gitea','forgejo'].includes(via) && !cfg.gitea) return {ok:false,error:{code:'no_connector',msg:via + ' not configured'}};
    return {ok:true,data:await ciStatus(via,cfg.gitea,wk.path,head())};
  }
  if (action === 'git-commit') {
    if (typeof args.message !== 'string' || !args.message.trim() || Buffer.byteLength(args.message) > 8192) throw Error('Explicit commit message required (max 8 KiB)');
    // Staging is opt-in: never sweep unrelated untracked files into a commit.
    if (args.all === true) await command('git',['add','--all','--','.'],wk.path,30000);
    if (git(wk.path,'diff','--cached','--quiet') !== '') {
      await d.active(args.id,args.actor,args.epoch);
      await command('git',['commit','-m',args.message],wk.path,30000);
    } else throw Error('No staged changes; stage files explicitly or use --all');
    // Git has acknowledged the write. Later failures must not hide that effect
    // or invite a caller to replay the commit.
    let sha: string | undefined;
    try {
      sha = head();
      state.run('UPDATE worktrees SET head=?,updated=? WHERE task=?',[sha,Date.now()/1000,args.id]);
      const recorded = await d.record(args.id,args.actor,args.epoch);
      return recorded.ok ? {ok:true,data:{...recorded.data,git_commit:true,head:sha}} : {ok:false,git_commit:true,head:sha,reconcile_required:true,error:recorded.error};
    } catch (error) {
      return {ok:false,git_commit:true,...(sha ? {head:sha} : {}),reconcile_required:true,error:failureDetails(error,'sisf')};
    }
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
  let merged: boolean | null = false, attempted = false;
  let repositoryLock: ReturnType<typeof acquireMergeLock> | undefined;
  try {
    repositoryLock = acquireMergeLock(row.repo, target, { task: args.id, actor: args.actor, epoch: args.epoch, db: cfg.db });
    const live = await d.active(args.id,args.actor,args.epoch);
    if (live.lease_until < Date.now()/1000 + 35) throw Error('Renew the claim before merge: at least 35 seconds of lease required');
    clean(wk.path); clean(row.repo);
    if (head() !== sha) throw Error('Source HEAD changed while checking CI; verify again');
    if (git(row.repo,'branch','--show-current') !== target) throw Error('Target branch must be checked out in the configured repository');
    if (git(row.repo,'merge-base','--is-ancestor',target,sha) === null) throw Error('Target advanced: rebase and verify again before merge');
    const changed = git(wk.path,'diff','--name-only','-z',target,sha,'--');
    if (changed === null) throw Error('Cannot establish the merge diff');
    // A separate show snapshot can be wider than the contract validated by
    // close_check. Authorize paths only from that exact proof revision.
    const scopeReply = await sis.call('contract', { id: args.id });
    const proofContract = scopeReply?.data?.structured ?? scopeReply?.data?.task;
    if (!scopeReply?.ok || !proofContract || scopeReply.data.revision !== check.data.revision || proofContract.revision !== check.data.revision) throw Error('Cannot establish the proof-matching source contract');
    const rawScopes = typeof proofContract.allowed_paths === 'string' ? JSON.parse(proofContract.allowed_paths) : proofContract.allowed_paths;
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
    // Native proof preflight is async: re-check Git identity immediately before the write.
    clean(wk.path); clean(row.repo);
    if (head() !== sha || git(row.repo, 'branch', '--show-current') !== target) throw Error('Branch or source HEAD changed during merge preflight; reconcile before retry');
    attempted = true; merged = null;
    if (row.backend === 'worktrunk') {
      await command(cfg.worktrunk || 'wt',['-C',wk.path,'merge',target,'--branch',wk.branch,'--no-commit','--no-rebase','--no-remove','--no-hooks'],wk.path,30000);
    } else await command('git',['merge','--ff-only','--no-edit',sha],row.repo,30000);
    merged = true; clean(row.repo);
    if (git(row.repo,'branch','--show-current') !== target || git(row.repo,'rev-parse','refs/heads/' + target) !== sha || git(row.repo,'rev-parse','HEAD') !== sha || head() !== sha) throw Error('Merge branch/result differs from verified target and HEAD; reconcile');
    const closed = await sis.call('close',{...fence,proof_id:args.proof_id});
    if (!closed.ok) return {ok:false,merged:true,closed:false,head:sha,error:closed.error};
    state.run("UPDATE worktrees SET status='closed',head=?,updated=? WHERE task=?",[sha,Date.now()/1000,args.id]);
    return {ok:true,data:{merged:true,closed:true,head:sha,target,backend:row.backend,retained_worktree:wk.path,remote_pushed:false}};
  } catch (error) {
    const observedTarget = attempted ? git(row.repo, 'rev-parse', '--verify', '--end-of-options', 'refs/heads/' + target) : undefined;
    if (attempted) merged = observedTarget === sha ? true : null;
    return {ok:false,merged,closed:false,head:sha,...(attempted ? { execution_uncertain:true, observed_target_head:observedTarget } : {}),error:{...failureDetails(error,'forge_merge'),...(error instanceof MergeLockConflict ? {code:error.code,lock_path:error.lock_path} : {}),reconcile:attempted || merged === true}};
  } finally {
    if (repositoryLock && !repositoryLock.release()) process.stderr.write('[sisf] repository merge lock release uncertain; inspect forge reconcile before retry\n');
    // A failed release never rolls back an already applied merge or steals a slot.
    const released = await sis.call('slot_release',{name,actor:slotActor,epoch:slot.data.epoch}).catch(() => null);
    if (!released?.ok) process.stderr.write('[sisf] merge slot release uncertain; inspect slot_list before retry\n');
  }
}
