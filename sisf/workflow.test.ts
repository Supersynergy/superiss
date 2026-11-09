import { expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Engine } from '../packages/superiss/engine.ts';
import { _test, type Cfg } from './sisf.ts';
import { forgeAction } from './workflow.ts';
import { VERSION } from '../packages/superiss/runtime.ts';
import { acquireMergeLock } from './merge-lock.ts';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(),'sis-forge-v11-'))), repo = join(root,'repo'); mkdirSync(repo);
  const git = (...args: string[]) => {
    const result = spawnSync('git',['-C',repo,...args],{encoding:'utf8'});
    if (result.status !== 0) throw Error(result.stderr);
    return result.stdout.trim();
  };
  git('init','-qb','main');git('config','user.name','Test');git('config','user.email','test@example.invalid');
  writeFileSync(join(repo,'.gitignore'),'.sisf/\n');writeFileSync(join(repo,'f'),'initial\n');git('add','.');git('commit','-qm','initial');
  const cfg: Cfg = {db:join(root,'project.db'),state:join(root,'forge.db'),sock:join(root,'unused.sock'),host:'127.0.0.1',port:'0',repos:{default:{path:repo,base:'main'}},lanes:{},gitea:null,backend:'git',runtime:'current',connector:'github'};
  const engine = new Engine(cfg.db), state = _test.openState(cfg);
  const sis: any = {project:undefined,call:async(cmd: string,args: any={}) => {
    try { const data: any = await engine.dispatch(cmd,args); if (cmd === 'context') sis.project = data.project_id; return {ok:true,data}; }
    catch (error) { return {ok:false,error:{code:(error as any).code,msg:(error as Error).message}}; }
  }};
  const deps = _test.dependencies(cfg,sis,state), fence = {id:'task',actor:'worker',epoch:1};
  async function setup(meta: any = {}) {
    await sis.call('context');
    await engine.dispatch('create',{id:'task',title:'Task',oracle_cmd:'test "$(cat f)" = changed',allowed_paths:['f'],meta});
    await engine.dispatch('claim',{id:'task',actor:'worker'});
    return forgeAction(deps,'bind',fence);
  }
  return {root,repo,cfg,git,engine,sis,state,deps,fence,setup,async cleanup(){await engine.shutdown();engine.db.close();state.close();rmSync(root,{recursive:true,force:true});}};
}

test('1.1 uses the live version and advertises read-only close preflight',async()=>{
  const f=fixture();try{const c:any=await f.engine.dispatch('capabilities');expect(c.version).toBe(VERSION);expect(c.operations).toContain('close_check');expect(c.operations).toHaveLength(88);}finally{await f.cleanup();}
});

test('staged Git commit, evidence, verification, preflight and merge close one task without pushing or deleting work',async()=>{
  const f=fixture();try{
    const bound=await f.setup(),path=bound.data.path;writeFileSync(join(path,'f'),'changed\n');
    await expect(forgeAction(f.deps,'git-commit',{...f.fence,message:'change'})).rejects.toThrow(/staged/);
    const committed=await forgeAction(f.deps,'git-commit',{...f.fence,message:'change',all:true});expect(committed.ok).toBe(true);expect(committed.data.git_commit).toBe(true);
    const artifact=JSON.parse(String(f.engine.db.get("SELECT payload FROM attests ORDER BY rowid DESC LIMIT 1")?.payload));expect(artifact.files).toBe(1);expect(artifact.worktree).toBe(path);
    const proof=await forgeAction(f.deps,'verify',f.fence);expect(proof.data.passed).toBe(true);
    const before=f.engine.db.get('SELECT COUNT(*) AS n FROM events')?.n;
    const check=await f.engine.dispatch('close_check',{...f.fence,proof_id:proof.data.proof_id});expect((check as any).valid).toBe(true);
    expect(f.engine.db.get('SELECT COUNT(*) AS n FROM events')?.n).toBe(before);expect((await f.sis.call('show',{id:'task'})).data.issue.status).toBe('in_progress');
    const merged=await forgeAction(f.deps,'merge',{...f.fence,proof_id:proof.data.proof_id,skip_ci:true});expect(merged.ok).toBe(true);expect(merged.data.closed).toBe(true);expect(merged.data.remote_pushed).toBe(false);
    expect(readFileSync(join(f.repo,'f'),'utf8')).toBe('changed\n');expect(readFileSync(join(path,'f'),'utf8')).toBe('changed\n');
    expect((await f.sis.call('show',{id:'task'})).data.issue.status).toBe('closed');expect(f.engine.db.get('SELECT holder FROM slots')?.holder).toBeNull();
  }finally{await f.cleanup();}
});

test('post-commit thrown evidence failure acknowledges the real commit and preserves the untracked symlink', async () => {
  const f = fixture(); try {
    const bound = await f.setup(), path = bound.data.path, before = f.git('-C', path, 'rev-parse', 'HEAD');
    writeFileSync(join(path, 'f'), 'changed\n'); f.git('-C', path, 'add', '--', 'f');
    const dependency = join(f.root, 'dependency'); mkdirSync(dependency); symlinkSync(dependency, join(path, 'node_modules'));
    const record = f.deps.record; let records = 0;
    f.deps.record = (...args) => { records++; return record(...args); };
    const result = await forgeAction(f.deps, 'git-commit', { ...f.fence, message: 'change' });
    const sha = f.git('-C', path, 'rev-parse', 'HEAD');
    expect(result).toMatchObject({ ok: false, git_commit: true, head: sha, reconcile_required: true });
    expect(result.error).toMatchObject({ code: 'sisf', msg: 'untracked symlink requires explicit review: node_modules' });
    expect(sha).not.toBe(before); expect(f.git('-C', path, 'rev-list', '--count', 'HEAD')).toBe('2'); expect(records).toBe(1);
    expect(lstatSync(join(path, 'node_modules')).isSymbolicLink()).toBe(true); expect(readFileSync(join(path, 'f'), 'utf8')).toBe('changed\n');
    expect(f.state.query('SELECT * FROM worktrees WHERE task=?').get('task')).toMatchObject({ path, branch: bound.data.branch, actor: 'worker', epoch: 1, status: 'active' });
    expect((await f.sis.call('show', { id: 'task' })).data.issue).toMatchObject({ status: 'in_progress', claim_actor: 'worker', lease_epoch: 1 });
  } finally { await f.cleanup(); }
});

test('post-commit structured evidence failure retains its error and requires reconciliation', async () => {
  const f = fixture(); try {
    const bound = await f.setup(), path = bound.data.path; writeFileSync(join(path, 'f'), 'changed\n');
    const call = f.sis.call.bind(f.sis), error = { code: 'evidence_unavailable', msg: 'fixture attestation rejected', detail: 'retained' }; let attempts = 0;
    f.sis.call = async (cmd: string, args: unknown) => cmd === 'attest' ? (attempts++, { ok: false, error }) : call(cmd, args);
    const result = await forgeAction(f.deps, 'git-commit', { ...f.fence, message: 'change', all: true });
    const sha = f.git('-C', path, 'rev-parse', 'HEAD');
    expect(result).toMatchObject({ ok: false, git_commit: true, head: sha, reconcile_required: true }); expect(result.error).toEqual(error);
    expect(f.git('-C', path, 'rev-list', '--count', 'HEAD')).toBe('2'); expect(attempts).toBe(1); expect(f.git('-C', path, 'status', '--porcelain')).toBe('');
    expect(f.state.query('SELECT * FROM worktrees WHERE task=?').get('task')).toMatchObject({ path, branch: bound.data.branch, actor: 'worker', epoch: 1, status: 'active', head: sha });
    expect((await call('show', { id: 'task' })).data.issue).toMatchObject({ status: 'in_progress', claim_actor: 'worker', lease_epoch: 1 });
  } finally { await f.cleanup(); }
});

test('post-commit state-write failure acknowledges the commit without retrying evidence or releasing ownership', async () => {
  const f = fixture(); try {
    const bound = await f.setup(), path = bound.data.path, before = f.git('-C', path, 'rev-parse', 'HEAD');
    writeFileSync(join(path, 'f'), 'changed\n');
    f.state.run("CREATE TRIGGER reject_commit_head BEFORE UPDATE OF head ON worktrees BEGIN SELECT RAISE(ABORT, 'fixture state write rejected'); END");
    let records = 0; f.deps.record = async () => { records++; throw Error('evidence must not run after failed state write'); };
    const result = await forgeAction(f.deps, 'git-commit', { ...f.fence, message: 'change', all: true });
    const sha = f.git('-C', path, 'rev-parse', 'HEAD');
    expect(result).toMatchObject({ ok: false, git_commit: true, head: sha, reconcile_required: true });
    expect(result.error).toMatchObject({ code: 'sisf', msg: 'fixture state write rejected' });
    expect(sha).not.toBe(before); expect(f.git('-C', path, 'rev-list', '--count', 'HEAD')).toBe('2'); expect(records).toBe(0);
    expect(f.state.query('SELECT * FROM worktrees WHERE task=?').get('task')).toMatchObject({ path, branch: bound.data.branch, actor: 'worker', epoch: 1, status: 'active', head: before });
    expect(readFileSync(join(path, 'f'), 'utf8')).toBe('changed\n');
    expect((await f.sis.call('show', { id: 'task' })).data.issue).toMatchObject({ status: 'in_progress', claim_actor: 'worker', lease_epoch: 1 });
  } finally { await f.cleanup(); }
});

test('post-commit unreadable HEAD still acknowledges completion without inventing a commit hash', async () => {
  const f = fixture(); try {
    const bound = await f.setup(), path = bound.data.path; writeFileSync(join(path, 'f'), 'changed\n');
    const hook = join(f.repo, '.git/hooks/post-commit');
    writeFileSync(hook, '#!/bin/sh\ngit symbolic-ref HEAD refs/heads/missing\n'); chmodSync(hook, 0o700);
    let records = 0; f.deps.record = async () => { records++; throw Error('evidence must not run without HEAD'); };
    const result = await forgeAction(f.deps, 'git-commit', { ...f.fence, message: 'change', all: true });
    expect(result).toMatchObject({ ok: false, git_commit: true, reconcile_required: true }); expect(result.head).toBeUndefined();
    expect(result.error).toMatchObject({ code: 'sisf', msg: 'Missing worktree HEAD' });
    expect(f.git('-C', path, 'rev-list', '--count', bound.data.branch)).toBe('2'); expect(records).toBe(0);
    expect(f.state.query('SELECT * FROM worktrees WHERE task=?').get('task')).toMatchObject({ path, branch: bound.data.branch, actor: 'worker', epoch: 1, status: 'active' });
    expect(readFileSync(join(path, 'f'), 'utf8')).toBe('changed\n');
    expect((await f.sis.call('show', { id: 'task' })).data.issue).toMatchObject({ status: 'in_progress', claim_actor: 'worker', lease_epoch: 1 });
  } finally { await f.cleanup(); }
});

test('an unacknowledged Git commit retains command uncertainty instead of asserting completed acknowledgement', async () => {
  const f = fixture(); try {
    const bound = await f.setup(), path = bound.data.path; writeFileSync(join(path, 'f'), 'changed\n');
    const hook = join(f.repo, '.git/hooks/post-commit'); writeFileSync(hook, '#!/bin/sh\nkill -TERM "$PPID"\n'); chmodSync(hook, 0o700);
    let records = 0; f.deps.record = async () => { records++; throw Error('evidence must not run without Git acknowledgement'); };
    const error = await forgeAction(f.deps, 'git-commit', { ...f.fence, message: 'change', all: true }).catch(error => error);
    expect(error.kind).toBe('exit'); expect(error.started).toBe(true); expect(error.execution_uncertain).toBe(true); expect(error.git_commit).toBeUndefined();
    expect(f.git('-C', path, 'rev-list', '--count', 'HEAD')).toBe('2'); expect(records).toBe(0);
    expect((await f.sis.call('show', { id: 'task' })).data.issue).toMatchObject({ status: 'in_progress', claim_actor: 'worker', lease_epoch: 1 });
  } finally { await f.cleanup(); }
});

test('merge refuses missing or stale proof before changing main',async()=>{
  const f=fixture();try{
    const bound=await f.setup(),path=bound.data.path,main=f.git('rev-parse','HEAD');writeFileSync(join(path,'f'),'changed\n');
    await forgeAction(f.deps,'git-commit',{...f.fence,message:'change',all:true});
    const missing=await forgeAction(f.deps,'merge',{...f.fence,proof_id:'missing',skip_ci:true});expect(missing.error.code).toBe('proof_required');
    const proof=await forgeAction(f.deps,'verify',f.fence);writeFileSync(join(path,'f'),'drift\n');await forgeAction(f.deps,'git-commit',{...f.fence,message:'drift',all:true});
    const stale=await forgeAction(f.deps,'merge',{...f.fence,proof_id:proof.data.proof_id,skip_ci:true});expect(stale.error.code).toBe('stale_proof');expect(f.git('rev-parse','HEAD')).toBe(main);
  }finally{await f.cleanup();}
});

test('merge refuses an advanced target and preserves source branch and live claim',async()=>{
  const f=fixture();try{
    const bound=await f.setup(),path=bound.data.path;writeFileSync(join(path,'f'),'changed\n');await forgeAction(f.deps,'git-commit',{...f.fence,message:'change',all:true});const proof=await forgeAction(f.deps,'verify',f.fence);
    writeFileSync(join(f.repo,'other'),'main advanced');f.git('add','other');f.git('commit','-qm','main advances');const main=f.git('rev-parse','HEAD');
    const result=await forgeAction(f.deps,'merge',{...f.fence,proof_id:proof.data.proof_id,skip_ci:true});expect(result.ok).toBe(false);expect(result.merged).toBe(false);expect(result.error.msg).toContain('rebase');expect(f.git('rev-parse','HEAD')).toBe(main);expect((await f.sis.call('show',{id:'task'})).data.issue.status).toBe('in_progress');
  }finally{await f.cleanup();}
});

test('stale epoch and lease cannot operate on a bound worktree',async()=>{
  const f=fixture();try{
    await f.setup();await expect(forgeAction(f.deps,'changes',{...f.fence,epoch:2})).rejects.toThrow(/ownership/);
    f.engine.db.run('UPDATE issues SET lease_until=0 WHERE id=?','task');await expect(forgeAction(f.deps,'changes',f.fence)).rejects.toThrow(/lease/);
  }finally{await f.cleanup();}
});

test('task metadata chooses a configured repository and configuration drift is rejected',async()=>{
  const f=fixture();try{
    const second=join(f.root,'second');f.git('clone','-q',f.repo,second);f.cfg.repos.second={path:second,base:'main'};
    const bound=await f.setup({repo_key:'second'});expect(bound.data.path.startsWith(second)).toBe(true);expect(bound.data.repo_key).toBe('second');
    f.cfg.repos.second.path=f.repo;await expect(forgeAction(f.deps,'changes',f.fence)).rejects.toThrow(/configuration changed/);
  }finally{await f.cleanup();}
});

test('missing Worktrunk preserves native claim and creates no fake binding',async()=>{
  const f=fixture();try{
    f.cfg.backend='worktrunk';f.cfg.worktrunk=join(f.root,'does-not-exist');await expect(f.setup()).rejects.toThrow(/Worktrunk/);expect(f.state.query('SELECT task FROM worktrees').get()).toBeNull();expect((await f.sis.call('show',{id:'task'})).data.issue.status).toBe('in_progress');
  }finally{await f.cleanup();}
});

test.skipIf(!process.env.SIS_TEST_WORKTRUNK)('installed Worktrunk creates the exact bound tree and merges the verified tip without rewriting it',async()=>{
  const f=fixture();try{
    f.cfg.backend='worktrunk';f.cfg.worktrunk=process.env.SIS_TEST_WORKTRUNK;
    const bound=await f.setup(),path=bound.data.path;writeFileSync(join(path,'f'),'changed\n');
    await forgeAction(f.deps,'git-commit',{...f.fence,message:'Worktrunk lifecycle',all:true});const proof=await forgeAction(f.deps,'verify',f.fence);
    const source=f.git('-C',path,'rev-parse','HEAD');const result=await forgeAction(f.deps,'merge',{...f.fence,proof_id:proof.data.proof_id,skip_ci:true});
    expect(result.ok,JSON.stringify(result)).toBe(true);expect(result.data.head).toBe(source);expect(f.git('rev-parse','HEAD')).toBe(source);expect(f.git('-C',path,'rev-parse','HEAD')).toBe(source);
  }finally{await f.cleanup();}
});

test('merge refuses committed changes outside the proof scope even when the scoped oracle passes',async()=>{
  const f=fixture();try{
    const bound=await f.setup(),path=bound.data.path;writeFileSync(join(path,'f'),'changed\n');writeFileSync(join(path,'unverified'),'outside scope');
    await forgeAction(f.deps,'git-commit',{...f.fence,message:'extra file',all:true});const proof=await forgeAction(f.deps,'verify',f.fence);expect(proof.data.passed).toBe(true);
    const main=f.git('rev-parse','HEAD');const result=await forgeAction(f.deps,'merge',{...f.fence,proof_id:proof.data.proof_id,skip_ci:true});expect(result.ok).toBe(false);expect(result.error.msg).toContain('outside the proof source scope');expect(f.git('rev-parse','HEAD')).toBe(main);
  }finally{await f.cleanup();}
});

test('a task whose lease is close to expiry cannot start a bounded merge',async()=>{
  const f=fixture();try{
    const bound=await f.setup(),path=bound.data.path;writeFileSync(join(path,'f'),'changed\n');await forgeAction(f.deps,'git-commit',{...f.fence,message:'change',all:true});const proof=await forgeAction(f.deps,'verify',f.fence);
    f.engine.db.run('UPDATE issues SET lease_until=? WHERE id=?',Date.now()/1000+10,'task');const main=f.git('rev-parse','HEAD');const result=await forgeAction(f.deps,'merge',{...f.fence,proof_id:proof.data.proof_id,skip_ci:true});expect(result.ok).toBe(false);expect(result.error.msg).toContain('Renew the claim');expect(f.git('rev-parse','HEAD')).toBe(main);
  }finally{await f.cleanup();}
});

test('explicit mirror push retains its configured destination without force pushing',async()=>{
  const f=fixture();try{
    const bound=await f.setup();const backup=join(f.root,'backup.git');f.git('init','--bare',backup);f.cfg.repos.default.mirror=backup;
    writeFileSync(join(bound.data.path,'f'),'changed\n');await forgeAction(f.deps,'git-commit',{...f.fence,message:'mirror fixture',all:true});
    const result=await forgeAction(f.deps,'pr',{...f.fence,via:'mirror'});expect(result.ok).toBe(true);expect(result.data.to).toBe(backup);
    expect(f.git('--git-dir',backup,'rev-parse','refs/heads/sis/task')).toBe(f.git('-C',bound.data.path,'rev-parse','HEAD'));
  }finally{await f.cleanup();}
});

test('merge refuses branch drift during close preflight without changing the foreign branch', async () => {
  const f = fixture(); try {
    const bound = await f.setup(); writeFileSync(join(bound.data.path, 'f'), 'changed\n');
    await forgeAction(f.deps, 'git-commit', { ...f.fence, message: 'change', all: true });
    const proof = await forgeAction(f.deps, 'verify', f.fence), original = f.git('rev-parse', 'main');
    const call = f.sis.call.bind(f.sis); let checks = 0;
    f.sis.call = async (cmd: string, args: unknown) => {
      const result = await call(cmd, args);
      if (cmd === 'close_check' && ++checks === 2) f.git('checkout', '-qb', 'foreign');
      return result;
    };
    const result = await forgeAction(f.deps, 'merge', { ...f.fence, proof_id: proof.data.proof_id, skip_ci: true });
    expect(result.ok).toBe(false); expect(result.merged).toBe(false);
    expect(f.git('rev-parse', 'main')).toBe(original); expect(f.git('rev-parse', 'foreign')).toBe(original);
    expect((await call('show', { id: 'task' })).data.issue.status).toBe('in_progress');
  } finally { await f.cleanup(); }
});

test('merge honors a lock held by a different project store and releases only its own native slot', async () => {
  const f = fixture(); let lock: ReturnType<typeof acquireMergeLock> | undefined;
  try {
    const bound = await f.setup(); writeFileSync(join(bound.data.path, 'f'), 'changed\n');
    await forgeAction(f.deps, 'git-commit', { ...f.fence, message: 'change', all: true });
    const proof = await forgeAction(f.deps, 'verify', f.fence), before = f.git('rev-parse', 'main');
    lock = acquireMergeLock(f.repo, 'main', { task: 'foreign', actor: 'foreign-worker', epoch: 2, db: join(f.root, 'other.db') });
    const result = await forgeAction(f.deps, 'merge', { ...f.fence, proof_id: proof.data.proof_id, skip_ci: true });
    expect(result.ok).toBe(false); expect(result.error.code).toBe('merge_locked'); expect(f.git('rev-parse', 'main')).toBe(before);
    expect(f.engine.db.get('SELECT holder FROM slots')?.holder).toBeNull(); expect(lock.release()).toBe(true); lock = undefined;
  } finally { lock?.release(); await f.cleanup(); }
});

test('a post-merge branch change cannot close the native task', async () => {
  const f = fixture(); try {
    const bound = await f.setup(); writeFileSync(join(bound.data.path, 'f'), 'changed\n');
    await forgeAction(f.deps, 'git-commit', { ...f.fence, message: 'change', all: true }); const proof = await forgeAction(f.deps, 'verify', f.fence);
    const hook = join(f.repo, '.git/hooks/post-merge');
    writeFileSync(hook, '#!/bin/sh\ngit branch foreign HEAD\ngit symbolic-ref HEAD refs/heads/foreign\n'); chmodSync(hook, 0o700);
    const result = await forgeAction(f.deps, 'merge', { ...f.fence, proof_id: proof.data.proof_id, skip_ci: true });
    expect(result.ok).toBe(false); expect(result.merged).toBe(true); expect(result.closed).toBe(false); expect(result.error.reconcile).toBe(true);
    expect(f.git('branch', '--show-current')).toBe('foreign'); expect((await f.sis.call('show', { id: 'task' })).data.issue.status).toBe('in_progress');
  } finally { await f.cleanup(); }
});

test('a lost Git acknowledgement after applied merge is uncertain and never falsely reports no effect', async () => {
  const f = fixture(); try {
    const bound = await f.setup(); writeFileSync(join(bound.data.path, 'f'), 'changed\n');
    await forgeAction(f.deps, 'git-commit', { ...f.fence, message: 'change', all: true }); const proof = await forgeAction(f.deps, 'verify', f.fence);
    const hook = join(f.repo, '.git/hooks/post-merge'); writeFileSync(hook, '#!/bin/sh\nkill -TERM "$PPID"\n'); chmodSync(hook, 0o700);
    const result = await forgeAction(f.deps, 'merge', { ...f.fence, proof_id: proof.data.proof_id, skip_ci: true });
    expect(result.ok).toBe(false); expect(result.execution_uncertain).toBe(true); expect(result.merged).toBe(true); expect(result.closed).toBe(false);
    expect(result.error.reconcile).toBe(true); expect(result.observed_target_head).toBe(f.git('rev-parse', 'main'));
    expect((await f.sis.call('show', { id: 'task' })).data.issue.status).toBe('in_progress');
  } finally { await f.cleanup(); }
});

for (const prefix of [' ', '\t', '\n']) test(`a leading-whitespace path cannot masquerade as an allowed file (${JSON.stringify(prefix)})`, async () => {
  const f = fixture(); try {
    const bound = await f.setup(), outside = prefix + 'f'; writeFileSync(join(bound.data.path, 'f'), 'changed\n'); writeFileSync(join(bound.data.path, outside), 'outside proof scope');
    await forgeAction(f.deps, 'git-commit', { ...f.fence, message: 'scope regression', all: true }); const proof = await forgeAction(f.deps, 'verify', f.fence); expect(proof.data.passed).toBe(true);
    const before = f.git('rev-parse', 'main'), result = await forgeAction(f.deps, 'merge', { ...f.fence, proof_id: proof.data.proof_id, skip_ci: true });
    expect(result.ok).toBe(false); expect(result.error.msg).toContain('outside the proof source scope'); expect(f.git('rev-parse', 'main')).toBe(before);
    expect((await f.sis.call('show', { id: 'task' })).data.issue.status).toBe('in_progress'); expect(readFileSync(join(bound.data.path, outside), 'utf8')).toBe('outside proof scope');
  } finally { await f.cleanup(); }
});

test('a restored narrow proof cannot authorize files from an earlier broad task snapshot', async () => {
  const f = fixture(); try {
    const bound = await f.setup(); writeFileSync(join(bound.data.path, 'f'), 'changed\n');
    await forgeAction(f.deps, 'git-commit', { ...f.fence, message: 'proved scope', all: true });
    const proof = await forgeAction(f.deps, 'verify', f.fence); expect(proof.data.passed).toBe(true);
    writeFileSync(join(bound.data.path, 'g'), 'outside the narrow proof');
    await forgeAction(f.deps, 'git-commit', { ...f.fence, message: 'outside change', all: true });
    await f.engine.dispatch('update', { ...f.fence, allowed_paths: ['f', 'g'] });
    const call = f.sis.call.bind(f.sis); let restore = true;
    f.sis.call = async (cmd: string, args: any = {}) => {
      const result = await call(cmd, args);
      if (cmd === 'show' && restore) { restore = false; await f.engine.dispatch('update', { ...f.fence, allowed_paths: ['f'] }); }
      return result;
    };
    const before = f.git('rev-parse', 'main'), result = await forgeAction(f.deps, 'merge', { ...f.fence, proof_id: proof.data.proof_id, skip_ci: true });
    expect(result.ok).toBe(false); expect(result.error.msg).toContain('outside the proof source scope');
    expect(f.git('rev-parse', 'main')).toBe(before); expect((await call('show', { id: 'task' })).data.issue.status).toBe('in_progress');
    expect(readFileSync(join(bound.data.path, 'g'), 'utf8')).toBe('outside the narrow proof');
  } finally { await f.cleanup(); }
});
