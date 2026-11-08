#!/usr/bin/env bun
// sisf — optional forge adapter. See docs/SISF.md.

import { Database } from "bun:sqlite";
import { serve as serveHTTP } from "bun";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, readFileSync, lstatSync, chmodSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { git, gitEnvironment, command } from "./process.ts";
import { parseRemote, safeURL, pullRequest, ciStatus, type Connector } from "./connectors.ts";
import { VERSION } from "../packages/superiss/runtime.ts";
export { parseRemote };
import { forgeAction, forgeOperations, type ForgeDependencies } from './workflow.ts';
import { serveMCP } from './mcp.ts';

export interface WorktreeRow {
  task: string; repo: string; path: string; branch: string; actor: string;
  epoch: number; base: string; head: string; status: string; pr: string | null;
  backend: string; repo_key: string; lane_policy: string | null; created: number; updated: number;
}
export interface RepoConf { path: string; base?: string; mirror?: string }
export interface Cfg {
  db: string; sock: string; port: string; host: string;
  state: string; repos: Record<string, RepoConf>;
  gitea: { url: string; token?: string } | null;
  lanes: Record<string, { paths?: string[] }>;
  actors?: string[];
  runtime?: 'current' | 'reference';
  backend?: 'git' | 'worktrunk';
  connector?: Connector;
  worktrunk?: string;
  defaultRepoKey?: string;
}
const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf("--" + k);
  return i >= 0 ? process.argv[i + 1] : d;
};
function loadCfg(): Cfg {
  const dbArg = arg("db", process.env.SIS_DB);
  if (!dbArg) fail(`Explicit --db or SIS_DB required; project selection is never inferred.`);
  const db = existsSync(dbArg!) ? realpathSync(dbArg!) : join(realpathSync(dirname(resolve(dbArg!))), basename(dbArg!));
  let file: any = {};
  const cf = join(dirname(db), "sisf.config.json");
  if (existsSync(cf)) try { file = JSON.parse(readFileSync(cf, "utf8")); } catch (e) { fail(`bad sisf.config.json: ${(e as Error).message}`); }
  const explicitRepo = arg("repo", process.env.SISF_REPO);
  const repoRoot = explicitRepo ? resolve(explicitRepo) : file.repo || findGitRoot(dirname(db)) || dirname(db);
  const actorArg = arg("actors", process.env.SISF_ACTORS);
  const actors = actorArg === undefined ? file.actors : actorArg.split(",").map(x => x.trim()).filter(Boolean);
  if (actors !== undefined && (!Array.isArray(actors) || actors.some(x => typeof x !== "string" || !x.trim()))) fail("actors must be a list of nonempty actor names");
  const backend = arg("backend", process.env.SISF_BACKEND) || file.backend || "git";
  if (!["git", "worktrunk"].includes(backend)) fail("backend must be git or worktrunk");
  const runtime = arg("runtime", process.env.SISF_RUNTIME) || "current";
  if (!["current", "reference"].includes(runtime)) fail("runtime must be current or reference");
  const connector = arg("via") || file.connector || (file.gitea || process.env.SISF_GITEA_URL ? "gitea" : "github");
  if (!["github", "gitea", "forgejo"].includes(connector)) fail("connector must be github, gitea or forgejo");
  const repos: Record<string, RepoConf> = { default: { path: repoRoot, base: file.base || "main", ...(file.mirror ? { mirror: file.mirror } : {}) }, ...file.repos };
  for (const [key, repo] of Object.entries(repos)) {
    if (!key || !repo || typeof repo.path !== 'string' || !repo.path.trim() || repo.base !== undefined && typeof repo.base !== 'string') fail("invalid repository configuration");
    repo.path = realpathSync(resolve(dirname(cf), repo.path));
  }
  const defaultRepoKey = arg("repo-key", process.env.SISF_REPO_KEY) || "default";
  if (!repos[defaultRepoKey]) fail("unknown repo-key");
  return {
    backend, runtime: runtime as Cfg["runtime"], connector, defaultRepoKey, worktrunk: process.env.SISF_WT || 'wt',
    db,
    sock: arg("sock", process.env.SIS_SOCK) || file.sock || "/tmp/sis-" + createHash("sha256").update(db).digest("hex").slice(0, 20) + ".sock",
    host: "127.0.0.1",
    port: arg("port", process.env.SISF_PORT) || String(file.port ?? 8766),
    state: join(dirname(db), basename(db) + ".sisf.state.db"),
    repos,
    gitea: file.gitea ?? (process.env.SISF_GITEA_URL ? { url: process.env.SISF_GITEA_URL, token: process.env.SISF_GITEA_TOKEN } : null),
    lanes: file.lanes ?? {},
    actors,
  };
}
function fail(msg: string): never { console.error(JSON.stringify({ ok: false, error: { code: "sisf", msg } })); process.exit(1); }
function findGitRoot(dir: string): string | null {
  let d = dir;
  for (;;) {
    if (existsSync(join(d, ".git"))) return d;
    const p = dirname(d);
    if (p === d) return null;
    d = p;
  }
}
const safeId = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "task";
const workspaceId = (s: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= 60 ? s : `${safeId(s).slice(0, 40)}--${createHash("sha256").update(s).digest("hex").slice(0, 20)}`;
const out = (v: any) => { if (v?.ok === false) process.exitCode = 1; console.log(JSON.stringify(v)); };

const MAX_FRAME = 1024 * 1024;
type Job = { cmd: string; args: any; frame: string; resolve: (r: any) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout>; watchSnapshot?: any };
class Sis {
  sock?: Socket; inflight?: Job; queue: Job[] = []; rbuf = ""; ready?: Promise<void>; project?: string;
  constructor(private cfg: Cfg, private dedicated = false) {}
  private legacyWatch = false;
  private sideClients = new Set<Sis>();
  private connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise((res, rej) => {
      const s = createConnection(this.cfg.sock);
      let hs = true;
      const abort = (e: Error) => { rej(e); this.drop(e); };
      s.setEncoding("utf8"); s.setTimeout(8000, () => abort(new Error("sis connect timeout")));
      s.once("connect", () => { s.write(JSON.stringify({ cmd: "context", args: {} }) + "\n"); });
      s.on("data", (c) => {
        this.rbuf += c.toString();
        if (Buffer.byteLength(this.rbuf) > MAX_FRAME) return abort(new Error("sis response >1MiB"));
        let i: number;
        while ((i = this.rbuf.indexOf("\n")) >= 0) {
          const line = this.rbuf.slice(0, i); this.rbuf = this.rbuf.slice(i + 1);
          if (!line.trim()) continue;
          if (hs) {
            hs = false;
            try {
              const id = JSON.parse(line);
              if (id.ok !== true || !id.data?.project_id || realpathSync(id.data.db_path) !== this.cfg.db)
                throw new Error("sis identity mismatch");
              if (this.project && this.project !== id.data.project_id) throw new Error("sis project changed");
              const caps = id.data.capabilities;
              if (this.cfg.runtime === 'reference') {
                if (!/^0\.[89]\./.test(caps?.version || '') || caps?.protocol !== 2 || caps?.proof_receipts !== true) throw new Error("reference runtime capability mismatch");
                this.legacyWatch = true;
              } else {
                if (caps?.version !== VERSION || caps?.protocol !== 2 || caps?.proof_receipts !== true) throw new Error("runtime_version_mismatch: Forge requires Superiss " + VERSION);
                this.legacyWatch = false;
              }
              this.project = id.data.project_id; s.setTimeout(0); res();
            } catch (e) { abort(e as Error); return; }
            continue;
          }
          const job = this.inflight;
          if (!job) return this.drop(new Error("unsolicited sis response"));
          try {
            let response = JSON.parse(line);
            // Native wait-watch emits the initial snapshot, then one long-poll batch.
            if (this.legacyWatch && job.cmd === "watch" && job.args.wait > 0 && response.ok) {
              if (!job.watchSnapshot) { job.watchSnapshot = response; continue; }
              response = { ...response, data: { ...response.data, events: [...(job.watchSnapshot.data?.events ?? []), ...(response.data?.events ?? [])] } };
            }
            this.inflight = undefined;
            if (job.timer) clearTimeout(job.timer);
            job.resolve(response);
          } catch { this.drop(new Error("malformed sis response")); return; }
          setImmediate(() => this.pump());
        }
      });
      s.on("error", abort);
      s.on("close", () => abort(new Error("sis socket closed; reconcile uncertain writes before retry")));
      this.sock = s;
    });
    return this.ready;
  }
  private drop(e: Error) {
    this.sock?.removeAllListeners(); this.sock?.destroy(); this.sock = undefined; this.ready = undefined;
    const jobs = [...(this.inflight ? [this.inflight] : []), ...this.queue];
    this.rbuf = ""; this.inflight = undefined; this.queue = [];
    for (const job of jobs) { if (job.timer) clearTimeout(job.timer); job.reject(e); }
  }
  close() { for (const child of this.sideClients) child.close(); this.sideClients.clear(); this.drop(new Error("sis client closed")); }
  private pump() {
    if (this.inflight || !this.queue.length) return;
    if (!this.sock || this.sock.destroyed) return this.drop(new Error("sis socket unavailable"));
    const job = this.queue.shift()!; this.inflight = job;
    const wait = Math.min(315, Math.max(15, (["verify", "attest"].includes(job.cmd) ? +job.args.timeout_secs || 10 : 0) + 15, (job.cmd === "watch" ? +job.args.wait || 0 : 0) + 15));
    job.timer = setTimeout(() => this.drop(new Error("sis call timeout; reconcile by idempotency key")), wait * 1000);
    this.sock!.write(job.frame);
  }
  async call(cmd: string, args: any = {}): Promise<any> {
    if (cmd === "watch" && args.follow) throw new Error("streaming watch is unsupported by this request client; use bounded wait");
    const frame = JSON.stringify({ cmd, args }) + "\n";
    if (Buffer.byteLength(frame) > MAX_FRAME) return { ok: false, error: { code: "too_big", msg: "request exceeds 1 MiB" } };
    await this.connect();
    if (!this.dedicated && (cmd === 'verify' || cmd === 'analytics' || cmd === 'attest' && args.kind === 'run')) {
      if (this.sideClients.size >= 8) throw new Error('sis long-call capacity full; keep lease alive and retry later');
      const child = new Sis(this.cfg,true); child.project = this.project; this.sideClients.add(child);
      try { return await child.call(cmd,args); } finally { this.sideClients.delete(child); child.close(); }
    }
    return new Promise((resolveJob, reject) => {
      if (this.queue.length + (this.inflight ? 1 : 0) >= 64) return reject(new Error("sis queue full"));
      this.queue.push({ cmd, args, frame, resolve: resolveJob, reject }); this.pump();
    });
  }
}

function openState(cfg: Cfg): Database {
  const s = new Database(cfg.state, { create: true });
  chmodSync(cfg.state, 0o600);
  s.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS worktrees(
      task TEXT PRIMARY KEY, repo TEXT, path TEXT, branch TEXT, actor TEXT,
      epoch INTEGER, base TEXT, head TEXT, status TEXT, pr TEXT,
      lane_policy TEXT, created REAL, updated REAL);
    CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);`);
  const cols = (s.query<{ name: string }, []>("PRAGMA table_info(worktrees)").all()).map(c => c.name);
  if (!cols.includes("lane_policy")) s.exec("ALTER TABLE worktrees ADD COLUMN lane_policy TEXT");
  for (const [name, fallback] of [['backend', 'git'], ['repo_key', 'default']]) if (!cols.includes(name)) s.exec(`ALTER TABLE worktrees ADD COLUMN ${name} TEXT NOT NULL DEFAULT '${fallback}'`);
  chmodSync(cfg.state, 0o600);
  return s;
}
const kv = (s: Database, k: string, d = "0") => s.query<{ v: string }, [string]>("SELECT v FROM kv WHERE k=?").get(k)?.v ?? d;
const kvPut = (s: Database, k: string, v: string) =>
  s.run("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [k, v]);
function bindProject(s: Database, project?: string) {
  if (!project) throw new Error("sis project identity required");
  const previous = kv(s, "sis_project", "");
  if (previous && previous !== project) throw new Error("adapter state belongs to a different sis project");
  if (!previous) kvPut(s, "sis_project", project);
}

function taskFrom(r: any) { return r?.ok ? r.data?.issue ?? r.data?.task ?? r.data : null; }
function actorAllowed(cfg: Cfg, actor?: string) { return cfg.actors === undefined || !!actor && cfg.actors.includes(actor); }
async function activeClaim(sis: Sis, task: string, actor?: string, epoch?: number, state?: Database) {
  const t = taskFrom(await sis.call("show", { id: task }));
  if (state) bindProject(state, sis.project);
  if (!actor || !Number.isSafeInteger(epoch) || !t || t.status !== "in_progress" || t.claim_actor !== actor || t.lease_epoch !== epoch || !(t.lease_until > Date.now() / 1000))
    throw new Error("active claim ownership/lease epoch required");
  return t;
}
function ensureWorktree(cfg: Cfg, s: Database, task: string, actor?: string, epoch?: number, lane?: string | null, repoKey?: string): { path: string; branch: string; created: boolean } {
  if (!actorAllowed(cfg, actor)) throw new Error("actor outside configured sisf scope");
  if (!actor || !Number.isSafeInteger(epoch) || epoch! < 1) throw new Error("claim actor and lease epoch required");
  const row = s.query<WorktreeRow, [string]>("SELECT * FROM worktrees WHERE task=?").get(task);
  if (row) {
    if (row.actor !== actor || row.epoch !== epoch || row.status !== "active") throw new Error("worktree ownership/lease epoch changed; reconcile previous worktree explicitly");
    if (repoKey && row.repo_key !== repoKey) throw new Error("task repository changed; reconcile binding");
    if (cfg.repos && (!cfg.repos[row.repo_key || 'default'] || realpathSync(cfg.repos[row.repo_key || 'default'].path) !== realpathSync(row.repo))) throw new Error("bound repository configuration changed");
    if ((row.backend || 'git') !== (cfg.backend || 'git')) throw new Error("worktree backend changed; reconcile binding");
    if (!existsSync(row.path) || git(row.path, "branch", "--show-current") !== row.branch) throw new Error("bound worktree missing or branch changed");
    return { path: row.path, branch: row.branch, created: false };
  }
  const selected = repoKey || cfg.defaultRepoKey || 'default';
  const repo = cfg.repos[selected];
  if (!repo) throw new Error("unknown task repository: " + selected);
  const branch = "sis/" + workspaceId(task);
  const wt = join(repo.path, ".sisf", "wt", workspaceId(task));
  mkdirSync(join(repo.path, ".sisf", "wt"), { recursive: true });
  const base = git(repo.path, "rev-parse", "--verify", "--end-of-options", (repo.base || "main") + "^{commit}");
  if (!base) throw new Error("configured base commit does not exist");
  if (cfg.backend === 'worktrunk') {
    const result = spawnSync(cfg.worktrunk || 'wt', ['-C', repo.path, 'switch', '--create', branch, '--base', base, '--path', wt, '--no-cd', '--no-hooks', '--format', 'json'], {env: gitEnvironment(), encoding:'utf8', timeout:30000, maxBuffer:1048576, stdio:['ignore','pipe','pipe']});
    if (result.status !== 0) throw new Error('Worktrunk creation failed; claim preserved; inspect partial worktree before retry');
    if (git(wt, 'worktree', 'lock', '--reason', 'sisf:' + task, wt) === null) throw new Error('Worktrunk tree created but lock failed; explicit reconciliation required');
  } else if (git(repo.path, "worktree", "add", "--lock", "--reason", "sisf:" + task, "-b", branch, wt, base) === null) throw new Error(`git worktree add failed for ${task}`);
  if (git(wt, 'branch', '--show-current') !== branch || git(wt, 'rev-parse', 'HEAD') !== base) throw new Error('created worktree identity/base mismatch; explicit reconciliation required');
  const head = git(wt, "rev-parse", "HEAD") ?? "";
  const lp = lanePolicy(cfg, lane);
  s.run(`INSERT INTO worktrees(task,repo,path,branch,actor,epoch,base,head,status,lane_policy,created,updated,backend,repo_key)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(task) DO UPDATE SET path=excluded.path, branch=excluded.branch,
           actor=excluded.actor, epoch=excluded.epoch, status='active',
           lane_policy=excluded.lane_policy, updated=excluded.updated`,
    [task, repo.path, wt, branch, actor ?? null, epoch ?? null, base, head, "active", lp ? JSON.stringify(lp) : null, Date.now() / 1000, Date.now() / 1000, cfg.backend || "git", selected]);
  return { path: wt, branch, created: true };
}
function releaseWorktree(s: Database, task: string, status: string) {
  s.run("UPDATE worktrees SET status=?, updated=? WHERE task=?", [status, Date.now() / 1000, task]);
}
// Port of superiss.py::_changes_from_git — numstat + -U0 hunk ranges +
// untracked files via porcelain. sis `changes` stores caller-computed files;
// sisf computes them so thin clients (and the proxy path) get the real diff.
interface ChgFile { path: string; adds: number | null; dels: number | null; status: string; hunks: number[][]; binary?: boolean; renamed_from?: string }
export function changesFromGit(repo: string, baseRef: string, mirror?: string) {
  if (git(repo, "rev-parse", "--git-dir") === null)
    throw new Error(`${repo} is not a git worktree`);
  const head = git(repo, "rev-parse", "--verify", "HEAD");
  const branch = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
  const base = git(repo, "rev-parse", "--verify", "--end-of-options", baseRef + "^{commit}");
  if (!base) throw new Error("diff base does not exist: " + baseRef);
  const files: ChgFile[] = [];
  let patch: string | undefined, patchTruncated = false;
  {
    const numstat = git(repo, "-c", "core.quotePath=false", "diff", "--numstat", "--no-renames", "-z", base, "--");
    if (numstat === null) throw new Error("git numstat failed or exceeded output limit");
    const stat = new Map<string, { ad: number | null; de: number | null; ren: string | null }>(), order: string[] = [];
    for (const line of numstat.split("\0")) {
      const p = line.split("\t");
      if (p.length < 3) continue;
      const ad = /^\d+$/.test(p[0]!) ? +p[0]! : null;
      const de = /^\d+$/.test(p[1]!) ? +p[1]! : null;
      let path = p.slice(2).join("\t"), ren: string | null = null;
      stat.set(path, { ad, de: de === null ? null : de, ren }); order.push(path);
    }
    const unified = git(repo, "-c", "core.quotePath=false", "diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", base, "--");
    if (unified === null) throw new Error("git patch failed or exceeded output limit");
    const hunks = new Map<string, number[][]>();
    let cur = "", old = "";
    for (const line of unified.split("\n")) {
      if (line.startsWith("--- a/")) old = line.slice(6);
      else if (line.startsWith("+++ b/")) cur = line.slice(6);
      else if (line.startsWith("+++ /dev/null")) cur = old;
      else if (line.startsWith("@@ ") && cur) {
        const m = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (!m) continue;
        const [os_, ol, ns, nl] = [+m[1]!, +(m[2] ?? 1), +m[3]!, +(m[4] ?? 1)];
        const s = nl === 0 ? os_ : ns, e = nl === 0 ? os_ + ol - 1 : ns + nl - 1;
        if (!hunks.has(cur)) hunks.set(cur, []);
        hunks.get(cur)!.push([s, e]);
      }
    }
    for (const path of order) {
      const { ad, de, ren } = stat.get(path)!;
      const exists = existsSync(join(repo, path));
      const f: ChgFile = { path, adds: ad, dels: de, status: ren ? "R" : !exists ? "D" : git(repo, "cat-file", "-e", base + ":" + path) === null ? "A" : "M", hunks: hunks.get(path) ?? [] };
      if (ad === null && de === null) f.binary = true;
      if (ren) f.renamed_from = ren;
      files.push(f);
    }
    const raw = unified;
    if (raw.length) { patch = raw.slice(0, 65536); patchTruncated = raw.length > 65536; }
  }
  const untracked = git(repo, "ls-files", "--others", "--exclude-standard", "-z");
  if (untracked === null) throw new Error("cannot read untracked files");
  for (const path of untracked.split("\0").filter(Boolean)) {
    const abs = join(repo, path);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) throw new Error("untracked symlink requires explicit review: " + path);
    if (!st.isFile()) throw new Error("unsupported untracked file: " + path);
    if (st.size > 4 * 1024 * 1024) throw new Error("untracked file exceeds 4 MiB: " + path);
    const bytes = readFileSync(abs);
    if (bytes.includes(0)) { files.push({ path, adds: null, dels: null, status: "A", hunks: [], binary: true }); continue; }
    const str = bytes.toString("utf8");
    const n = str ? str.split("\n").length - (str.endsWith("\n") ? 1 : 0) : 0;
    files.push({ path, adds: n, dels: 0, status: "A", hunks: n ? [[1, n]] : [] });
  }
  const filtered = mirror ? files.filter((f) => f.path !== mirror && !f.path.endsWith("/" + mirror)) : files;
  const subject = git(repo, "log", "-1", "--format=%s");
  if (filtered.length > 80 || filtered.some(f => f.path.length > 300)) throw new Error("diff exceeds native changes limits (80 files / 300 characters per path)");
  return { files: filtered, base, head: head ?? null, head_subject: subject ?? null, branch: branch ?? null, repo, ...(patch ? { patch, patch_truncated: patchTruncated } : {}) };
}

async function gitea(cfg: Cfg, repoPath: string, branch: string, task: string, title: string) {
  try { return {ok:true,data:await pullRequest(cfg.connector === 'forgejo' ? 'forgejo' : 'gitea',cfg.gitea,repoPath,branch,cfg.repos.default.base || 'main',task,title)}; }
  catch (error) { return {ok:false,error:{code:cfg.gitea ? 'gitea' : 'no_connector',msg:(error as Error).message}}; }
}
async function giteaCi(cfg: Cfg, repoPath: string, sha: string) {
  try { return {ok:true,data:await ciStatus(cfg.connector === 'forgejo' ? 'forgejo' : 'gitea',cfg.gitea,repoPath,sha)}; }
  catch (error) { return {ok:false,error:{code:cfg.gitea ? 'gitea' : 'no_connector',msg:(error as Error).message}}; }
}
// lane policy: advisory binding — lane X may declare writable globs; sisf
// records the bound policy on the worktree (enforcement = sis allowed_paths
// contract + changes evidence, not filesystem sandboxing).
function lanePolicy(cfg: Cfg, lane?: string | null) {
  if (!lane || !cfg.lanes[lane]?.paths?.length) return null;
  return { lane, allowed_paths: cfg.lanes[lane].paths };
}
function mirror(cfg: Cfg, repoPath: string, branch: string) {
  const m = cfg.repos.default.mirror;
  if (!m) return { ok: false, error: { code: "no_connector", msg: "no mirror configured" } };
  const r = git(repoPath, "push", m, branch);
  return r !== null ? { ok: true, data: { pushed: branch, to: m } } : { ok: false, error: { code: "git", msg: "push failed" } };
}

const CLAIM_OPS = new Set(["claim", "acquire", "claim_next"]);
const RELEASE_OPS: Record<string, string> = { reclaim: "released", reopen: "released", close: "closed", unclaim: "released", cancel_ack: "cancelled", handoff: "released", delete: "deleted" };
async function reconcileEvent(cfg: Cfg, sis: Sis, s: Database, e: any) {
  if (!e.issue || (!CLAIM_OPS.has(e.op) && !RELEASE_OPS[e.op])) return;
  const shown = await sis.call("show", { id: e.issue });
  bindProject(s, sis.project);
  if (!shown?.ok && shown?.error?.code !== "not_found") throw new Error("cannot reconcile lifecycle event: show failed");
  const t = taskFrom(shown);
  if (CLAIM_OPS.has(e.op)) {
    if (t?.status !== "in_progress" || !(t.lease_until > Date.now() / 1000)) return;
    if (!actorAllowed(cfg, t.claim_actor)) return;
    const wk = ensureWorktree(cfg, s, e.issue, t.claim_actor, t.lease_epoch, t.lane ?? null, t.meta?.repo_key);
    process.stderr.write(`[sisf] worktree ${wk.branch} → ${wk.path}\n`);
  } else if (t?.status !== "in_progress") releaseWorktree(s, e.issue, RELEASE_OPS[e.op]);
}
async function watcher(cfg: Cfg, sis: Sis, s: Database) {
  const w = new Sis(cfg); // dedicated socket: watch blocks, must not serialize ops
  let seq = +kv(s, "last_seq");
  let failures = 0;
  for (;;) {
    try {
      const r = await w.call("watch", { after: seq, wait: 25, limit: 500 });
      if (r?.ok && Array.isArray(r.data?.events)) {
        for (const e of r.data.events) {
          await reconcileEvent(cfg, sis, s, e);
          seq = Math.max(seq, +e.seq || 0);
          kvPut(s, "last_seq", String(seq));
        }
        failures = 0;
      } else {
        throw new Error("sis watch failed");
      }
    } catch (e) {
      if (++failures >= 6) { w.close(); throw e; }
      process.stderr.write(`[sisf] watch: ${(e as Error).message}; retry in 2s\n`);
      w.close();
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function commitAttest(cfg: Cfg, sis: Sis, s: Database, id: string, actor?: string, epoch?: number, base?: string) {
  const w = s.query<WorktreeRow, [string]>("SELECT * FROM worktrees WHERE task=?").get(id);
  if (!w) return { ok: false, error: { code: "no_worktree", msg: `no worktree for ${id}` } };
  await activeClaim(sis, id, actor, epoch, s);
  ensureWorktree(cfg, s, id, actor, epoch);
  const mirror = basename(cfg.db).replace(/\.db$/, "") + ".issues.jsonl";
  const d = changesFromGit(w.path, base || w.base || "main", mirror);
  const ctx = { ...(actor ? { actor } : {}), ...(epoch != null ? { epoch } : {}) };
  const chg = await sis.call("changes", { id, ...ctx, ...d });
  if (chg?.ok !== true) return chg;
  const att = await sis.call("attest", { id, cwd: w.path, kind: "artifact", ref: d.head ?? "", url: `git://${w.branch}@${d.head ?? "none"}`, payload: JSON.stringify({ files: d.files.length, adds: d.files.reduce((a, f) => a + (f.adds ?? 0), 0), dels: d.files.reduce((a, f) => a + (f.dels ?? 0), 0), worktree: w.path }), ...ctx });
  if (att?.ok !== true) return att;
  s.run("UPDATE worktrees SET head=?, updated=? WHERE task=?", [d.head, Date.now() / 1000, id]);
  return { ok: true, data: { task: id, worktree: w.path, branch: w.branch, head: d.head, files: d.files.length, changes: true, attest: true } };
}

function dependencies(cfg: Cfg, sis: Sis, state: Database): ForgeDependencies {
  return {cfg,state,sis,
    active:(id,actor,epoch)=>activeClaim(sis,id,actor,epoch,state),
    bind:(id,actor,epoch,lane,repo)=>ensureWorktree(cfg,state,id,actor,epoch,lane,repo),
    changes:changesFromGit,
    record:(id,actor,epoch)=>commitAttest(cfg,sis,state,id,actor,epoch),
    pr:args=>createPR(cfg,sis,state,args),
  };
}

function requestAllowed(req: Request): boolean {
  const u = new URL(req.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || req.headers.get("host") !== u.host) return false;
  const origin = req.headers.get("origin");
  if (origin && origin !== u.origin) return false;
  return req.method !== "POST" || /^application\/json(?:;|$)/i.test(req.headers.get("content-type") || "");
}

async function createPR(cfg: Cfg, sis: Sis, s: Database, b: any) {
  const via = b.via || cfg.connector || 'gitea';
  if (!['gitea','forgejo','github','mirror'].includes(via)) throw new Error('unknown connector');
  if (['gitea','forgejo'].includes(via) && !cfg.gitea) return {ok:false,error:{code:'no_connector',msg:via + ' not configured'}};
  const task = await activeClaim(sis,b.id,b.actor,b.epoch,s);
  const wk = ensureWorktree(cfg,s,b.id,b.actor,b.epoch,task.lane,task.meta?.repo_key);
  const row = s.query<WorktreeRow,[string]>('SELECT * FROM worktrees WHERE task=?').get(b.id)!;
  if (via === 'mirror') return mirror({...cfg,repos:{...cfg.repos,default:cfg.repos[row.repo_key || 'default']}},wk.path,wk.branch);
  if (git(wk.path,'status','--porcelain') !== '') throw new Error('Commit the worktree before creating a PR');
  const base = cfg.repos[row.repo_key || 'default'].base || 'main';
  const pr = await pullRequest(via,cfg.gitea,wk.path,wk.branch,base,b.id,b.title || task.title || b.id);
  s.run('UPDATE worktrees SET pr=?,head=?,updated=? WHERE task=?',[pr.pr_url,git(wk.path,'rev-parse','HEAD'),Date.now()/1000,b.id]);
  return {ok:true,data:pr};
}

async function pruneWorktrees(cfg: Cfg, sis: Sis, s: Database) {
  const results: any[] = [];
  for (const w of s.query<WorktreeRow, []>("SELECT * FROM worktrees WHERE status!='active'").all()) {
    try {
      const t = taskFrom(await sis.call("show", { id: w.task }));
      bindProject(s, sis.project);
      if (!t || t.status === "in_progress") throw new Error("task cannot be confirmed inactive");
      const expected = join(realpathSync(w.repo), ".sisf", "wt", workspaceId(w.task));
      if (realpathSync(w.path) !== expected || git(w.path, "branch", "--show-current") !== w.branch) throw new Error("worktree identity changed");
      if (git(w.path, "status", "--porcelain") !== "") throw new Error("dirty or unreadable worktree retained");
      const admin = git(w.path, "rev-parse", "--git-path", "locked");
      if (!admin || !existsSync(admin) || readFileSync(admin, "utf8").trim() !== "sisf:" + w.task) throw new Error("worktree lock is not owned by sisf");
      if (git(w.repo, "worktree", "unlock", w.path) === null) throw new Error("unlock failed");
      if (git(w.repo, "worktree", "remove", w.path) === null) {
        git(w.repo, "worktree", "lock", "--reason", "sisf:" + w.task, w.path);
        throw new Error("remove failed; state retained");
      }
      s.run("DELETE FROM worktrees WHERE task=?", [w.task]);
      results.push({ ok: true, pruned: w.task, retained_branch: w.branch });
    } catch (e) { results.push({ ok: false, task: w.task, error: (e as Error).message }); }
  }
  return { ok: results.every(r => r.ok), results };
}

function boardHTML(): string {
  return `<!doctype html><meta charset=utf-8><title>superiss-forge</title>
<style>body{font:13px/1.4 ui-monospace,monospace;background:#0d1117;color:#c9d1d9;margin:0;display:flex}
.col{flex:1;padding:14px;border-right:1px solid #21262d;min-width:0}h2{font-size:12px;color:#8b949e;text-transform:uppercase}
.t{border:1px solid #21262d;border-radius:6px;padding:8px;margin:6px 0;background:#161b22}
.b{color:#58a6ff}.m{color:#8b949e;font-size:11px}.st{display:inline-block;padding:0 6px;border-radius:8px;background:#21262d;margin-right:4px}
.wt{border-left:3px solid #3fb950}.wt.stale{border-color:#f85149}</style>
<div class=col><h2>SOLL — sis tasks</h2><div id=soll></div></div>
<div class=col><h2>IST — worktrees / commits / prs</h2><div id=ist></div></div>
<script>const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeURL=v=>{try{const u=new URL(String(v));return ['http:','https:'].includes(u.protocol)?u.href:''}catch{return ''}};
async function load(){const r=await fetch('/forge/board');const d=await r.json();
const wts={};for(const w of d.worktrees||[])wts[w.task]=w;
document.getElementById('soll').innerHTML=(d.tasks||[]).map(t=>{
const w=wts[t.id];return '<div class="t'+(w?' wt':'')+'"><b>'+esc(t.id)+'</b> <span class=st>'+esc(t.status||'')+'</span><br>'+esc(t.title||'')+'<div class=m>'+esc(t.claim_actor||t.owner||'unassigned')+(t.lane?' · lane '+esc(t.lane):'')+'</div></div>'}).join('')||'<i>no tasks</i>';
document.getElementById('ist').innerHTML=(d.worktrees||[]).map(w=>'<div class="t wt'+(w.status!=='active'?' stale':'')+'"><b class=b>'+esc(w.branch)+'</b> <span class=st>'+esc(w.status)+'</span><br><span class=m>'+esc(w.path)+'</span><div class=m>head '+(esc(w.head)||'—').slice(0,12)+(safeURL(w.pr)?' · <a class=b rel="noreferrer" href="'+esc(safeURL(w.pr))+'">pr</a>':'')+'</div></div>').join('')||'<i>no worktrees</i>';}
load();setInterval(load,5000);</script>`;
}
async function serve(cfg: Cfg) {
  const sis = new Sis(cfg);
  const id = await sis.call("context", {}).catch((e) => fail(`sis daemon not reachable at ${cfg.sock}: ${e.message}`));
  if (!id?.ok) fail(`sis context failed`);
  const s = openState(cfg);
  bindProject(s, id.data.project_id);
  process.stderr.write(`[sisf] bound to ${cfg.db} (${id.data.project_id}), watch cursor seq=${kv(s, "last_seq")}\n`);
  let watchError: string | null = null;
  watcher(cfg, sis, s).catch((e) => { watchError = e.message; process.stderr.write(`[sisf] watcher stopped: ${e.message}\n`); });
  const srv = serveHTTP({
    hostname: cfg.host, port: +cfg.port, maxRequestBodySize: MAX_FRAME,
    async fetch(req) {
      if (!requestAllowed(req)) return Response.json({ ok: false, error: { code: "forbidden_request" } }, { status: 403 });
      try {
      const u = new URL(req.url);
      if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/forge")) return new Response(boardHTML(), { headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'" } });
      if (req.method === "GET" && u.pathname === "/health") {
        const context = await sis.call("context");
        const healthy = context?.ok === true && !watchError;
        return Response.json({ ok: healthy, watcher_error: watchError, db: cfg.db, project: sis.project, worktrees: s.query<{n:number}, []>("SELECT count(*) n FROM worktrees").get()!.n }, { status: healthy ? 200 : 503 });
      }
      if (req.method === "GET" && u.pathname === "/forge/board") {
        const [lt, wt] = await Promise.all([sis.call("list", {}), Promise.resolve(s.query("SELECT * FROM worktrees ORDER BY updated DESC LIMIT 200").all())]);
        const tasks = Array.isArray(lt?.data?.issues) ? lt.data.issues : Array.isArray(lt?.data) ? lt.data : [];
        if (!lt?.ok) return Response.json(lt, { status: 502 });
        return Response.json({ ok: true, tasks, worktrees: wt });
      }
      if (req.method === "GET" && u.pathname === "/sisf/worktrees") return Response.json({ ok: true, data: s.query("SELECT * FROM worktrees ORDER BY updated DESC").all() });
      if (req.method === "POST" && (u.pathname === "/forge/op" || /^\/sisf\/(bind|changes|record|git-commit|push|verify|rebase|merge|ci|pr)$/.test(u.pathname))) {
        const body: any = await req.json();
        const operation = u.pathname === '/forge/op' ? body.op : u.pathname.slice('/sisf/'.length);
        return Response.json(await forgeAction(dependencies(cfg,sis,s),operation,u.pathname === '/forge/op' ? body.args : body));
      }
      if (req.method === "POST" && u.pathname === "/sisf/commit") {
        const b: any = await req.json();
        return Response.json(await commitAttest(cfg, sis, s, b.id, b.actor, b.epoch, b.base));
      }
      if (req.method === "POST" && u.pathname === "/") {
        const body: any = await req.json().catch(() => null);
        if (!body?.cmd) return Response.json({ ok: false, error: { code: "bad_args", msg: "{cmd,args} required" } }, { status: 400 });
        const { cmd, args = {} } = body;
        if (CLAIM_OPS.has(cmd) && !actorAllowed(cfg, args.actor)) return Response.json({ ok: false, error: { code: "actor_scope", msg: "actor outside configured sisf scope" } }, { status: 403 });
        if (cmd === "changes" && args.id) {
          await activeClaim(sis, args.id, args.actor, args.epoch, s);
          const wk = ensureWorktree(cfg, s, args.id, args.actor, args.epoch);
          if (args.repo && realpathSync(args.repo) !== realpathSync(wk.path)) throw new Error("changes repo differs from bound worktree");
          const row = s.query<{ base: string }, [string]>("SELECT base FROM worktrees WHERE task=?").get(args.id);
          const mirror = basename(cfg.db).replace(/\.db$/, "") + ".issues.jsonl";
          Object.assign(args, changesFromGit(wk.path, args.base || row!.base, mirror));
        }
        const r = await sis.call(cmd, args);
        // Claim and Git are separate durable operations; report binding failure explicitly.
        if (r?.ok && CLAIM_OPS.has(cmd) && r.data?.id) {
          try {
            const t = await activeClaim(sis, r.data.id, args.actor, r.data.epoch, s);
            const lane = t.lane;
            const wk = ensureWorktree(cfg, s, r.data.id, args.actor, r.data.epoch, lane ?? null, t.meta?.repo_key);
            const lp = lanePolicy(cfg, lane);
            r.data.sisf = { bound: true, worktree: wk.path, branch: wk.branch, ...(lp ? { lane_policy: lp } : {}) };
          } catch (e) { r.data.sisf = { bound: false, claim_preserved: true, error: (e as Error).message }; }
        }
        if (r?.ok && args?.id && RELEASE_OPS[cmd]) releaseWorktree(s, args.id, RELEASE_OPS[cmd]);
        return Response.json(r);
      }
      return Response.json({ ok: false, error: { code: "not_found" } }, { status: 404 });
      } catch (e) {
        return Response.json({ ok: false, error: { code: "sisf", msg: (e as Error).message } }, { status: e instanceof SyntaxError ? 400 : 502 });
      }
    },
  });
  process.stderr.write(`[sisf] http ${cfg.host}:${srv.port} (proxy POST /, board /forge)\n`);
  await new Promise(() => {}); // daemon: stay alive until killed
  return srv;
}

export const _test = { loadCfg, bindProject, safeId, workspaceId, parseRemote, Sis, openState, ensureWorktree, commitAttest, requestAllowed, safeURL, boardHTML, gitea, giteaCi, createPR, pruneWorktrees, lanePolicy, dependencies };
export async function cli() {
  const cmd = process.argv[2];
  if (cmd === '--version') { console.log(VERSION); return; }
  if (!cmd || ['--help','-h','help'].includes(cmd)) {
    console.log(`Superiss ${VERSION} forge — integrated Git lifecycle

  sis forge serve --db PATH --repo PATH [--backend git|worktrunk]
  sis forge status --db PATH
  sis forge bind|changes|record|git-commit|push|verify|pr|ci|rebase|merge TASK --db PATH --actor NAME --epoch N
  sis forge git-commit TASK ... --message TEXT [--all]
  sis forge merge TASK ... --proof-id ID [--skip-ci]
  sis forge prune --db PATH [--yes]
  sis forge mcp --db PATH

commit remains a deprecated alias for record; use git-commit for a real Git commit.
The board is local at /forge. Explicit DB, claim fencing and proof rules always apply.`);
    return;
  }
  const cfg = loadCfg();
  if (cmd === 'serve') { await serve(cfg); return; }
  const sis = new Sis(cfg); let state: Database | undefined;
  try {
    if (cmd === 'status' || cmd === 'health') {
      const context = await sis.call('context');
      state = openState(cfg); bindProject(state,sis.project);
      out({ok:true,version:VERSION,sis_daemon:true,sis:context.data,backend:cfg.backend,worktrees:state.query('SELECT * FROM worktrees').all()});
      return;
    }
    if (cmd === 'mcp') {
      await serveMCP(async (op,args)=>{
        await sis.call('context');
        state ??= openState(cfg); bindProject(state,sis.project);
        return forgeAction(dependencies(cfg,sis,state),op,args);
      }); return;
    }
    // Establish identity even for cleanup previews. Never act on an unbound state.
    await sis.call('context'); state = openState(cfg); bindProject(state,sis.project);
    if (cmd === 'prune') {
      if (!process.argv.includes('--yes')) out({ok:true,would_prune:state.query("SELECT task FROM worktrees WHERE status!='active'").all()});
      else out(await pruneWorktrees(cfg,sis,state));
      return;
    }
    const operation = cmd === 'wt' ? 'bind' : cmd === 'commit' ? 'record' : cmd;
    if (cmd === 'commit') process.stderr.write('sisf commit is deprecated: use record for evidence or git-commit for Git commits\n');
    if (!forgeOperations.includes(operation as any)) throw new Error('unknown forge command; run sis forge --help');
    out(await forgeAction(dependencies(cfg,sis,state),operation,{
      id:process.argv[3],actor:arg('actor'),epoch:Number(arg('epoch')),
      ...(arg('message') === undefined ? {} : {message:arg('message')}),
      ...(arg('title') === undefined ? {} : {title:arg('title')}),
      ...(arg('via') === undefined ? {} : {via:arg('via')}),
      ...(arg('proof-id') === undefined ? {} : {proof_id:arg('proof-id')}),
      ...(arg('timeout-secs') === undefined ? {} : {timeout_secs:Number(arg('timeout-secs'))}),
      all:process.argv.includes('--all'),skip_ci:process.argv.includes('--skip-ci'),
    }));
  } finally { sis.close(); state?.close(); }
}
// cli() only returns for one-shot commands (serve never returns) → hard exit
// releases the persistent sis socket without waiting for linger.
if (import.meta.main) {
  try { await cli(); } catch (e) { out({ ok: false, error: { code: "sisf", msg: (e as Error).message } }); }
  process.exit(process.exitCode || 0);
}
