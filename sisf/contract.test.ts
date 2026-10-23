import { expect, test } from "bun:test";
import { _test, changesFromGit } from "./sisf";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sisf-contract-")));
  const repo = join(dir, "repo"); mkdirSync(repo);
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "f"), "initial\n"); git("add", "f"); git("commit", "-qm", "initial");
  const cfg: any = { db: join(dir, "sis.db"), state: join(dir, "state.db"), repos: { default: { path: repo, base: "main" } }, lanes: { code: { paths: ["src"] } }, gitea: null };
  const state = _test.openState(cfg);
  return { dir, repo, git, cfg, state, cleanup() { state.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("socket disconnect rejects queued requests and reconnect rejects project drift", async () => {
  const f = fixture(); writeFileSync(f.cfg.db, "fixture"); f.cfg.sock = join(f.dir, "test.sock");
  let project = "p";
  const server = createServer(s => {
    let buf = "";
    s.on("data", chunk => { buf += chunk; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const request = JSON.parse(buf.slice(0, i)); buf = buf.slice(i+1);
        if (request.cmd === "context") s.write(JSON.stringify({ ok: true, data: { project_id: project, db_path: f.cfg.db } }) + "\n");
        else s.destroy();
      }
    });
  });
  await new Promise<void>(r => server.listen(f.cfg.sock, r));
  const client = new _test.Sis(f.cfg);
  try {
    const results = await Promise.allSettled([client.call("show", { id: "a" }), client.call("show", { id: "b" })]);
    expect(results.every(r => r.status === "rejected")).toBe(true);
    expect((await client.call("context")).ok).toBe(true);
    client.close(); project = "changed";
    await expect(client.call("show", { id: "a" })).rejects.toThrow(/project changed/);
  } finally { client.close(); await new Promise<void>(r => server.close(() => r())); f.cleanup(); }
}, 3000);

test("wait-watch consumes snapshot plus later batch before the next command", async () => {
  const f = fixture(); writeFileSync(f.cfg.db, "fixture"); f.cfg.sock = join(f.dir, "test.sock");
  const server = createServer(s => { let buf = ""; s.on("data", chunk => {
    buf += chunk; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const req = JSON.parse(buf.slice(0,i)); buf = buf.slice(i+1);
      if (req.cmd === "context") s.write(JSON.stringify({ ok: true, data: { project_id: "p", db_path: f.cfg.db } })+"\n");
      else if (req.cmd === "watch") {
        s.write(JSON.stringify({ ok: true, data: { events: [{ seq: 1 }] } })+"\n");
        setTimeout(() => s.write(JSON.stringify({ ok: true, data: { events: [{ seq: 2 }] } })+"\n"), 10);
      } else s.write(JSON.stringify({ ok: true, data: { issue: { id: "expected" } } })+"\n");
    }
  }); });
  await new Promise<void>(r => server.listen(f.cfg.sock, r));
  const client = new _test.Sis(f.cfg);
  try {
    expect((await client.call("watch", { after: 0, wait: 1 })).data.events.map((x: any)=>x.seq)).toEqual([1,2]);
    expect((await client.call("show", { id: "expected" })).data.issue.id).toBe("expected");
  } finally { client.close(); await new Promise<void>(r => server.close(() => r())); f.cleanup(); }
}, 3000);

test("task identifiers do not collapse into another task's branch", () => {
  expect(_test.workspaceId("A/B")).not.toBe(_test.workspaceId("a-b"));
  expect(_test.workspaceId("a".repeat(80))).not.toBe(_test.workspaceId("a".repeat(79)+"b"));
  expect(_test.workspaceId("t1")).toBe("t1");
});

test("two stores in the same directory have distinct adapter state", () => {
  const f = fixture(), argv = process.argv;
  try {
    process.argv = ["bun", "sisf", "health", "--db", join(f.dir, "one.db")];
    const one = _test.loadCfg();
    process.argv = ["bun", "sisf", "health", "--db", join(f.dir, "two.db")];
    expect(_test.loadCfg().state).not.toBe(one.state);
    _test.bindProject(f.state,"one");
    expect(() => _test.bindProject(f.state,"two")).toThrow(/different sis project/);
  } finally { process.argv = argv; f.cleanup(); }
});

test("advisory policy binds to a locked worktree and immutable base", () => {
  const f = fixture();
  try {
    const base = f.git("rev-parse", "HEAD");
    const w = _test.ensureWorktree(f.cfg, f.state, "t", "a", 1, "code");
    const row: any = f.state.query("SELECT * FROM worktrees WHERE task='t'").get();
    expect(row.base).toBe(base);
    expect(JSON.parse(row.lane_policy)).toEqual({ lane: "code", allowed_paths: ["src"] });
    expect(f.git("worktree", "list", "--porcelain")).toContain("locked sisf:t");
    expect(_test.ensureWorktree(f.cfg, f.state, "t", "a", 1).created).toBe(false);
    f.git("-C", w.path, "checkout", "-qb", "foreign");
    expect(() => _test.ensureWorktree(f.cfg, f.state, "t", "a", 1)).toThrow(/branch changed/);
  } finally { f.cleanup(); }
});

test("diff includes nested untracked and binary files; rejects missing base and symlinks", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.repo,"nested")); writeFileSync(join(f.repo,"nested","a b.txt"),"a\nb\n");
    writeFileSync(join(f.repo,"binary"),Buffer.from([0,1,2]));
    const d = changesFromGit(f.repo,"main");
    expect(d.files.find(x=>x.path === "nested/a b.txt")?.adds).toBe(2);
    expect(d.files.find(x=>x.path === "binary")?.binary).toBe(true);
    expect(() => changesFromGit(f.repo,"missing")).toThrow(/base/);
    symlinkSync("f",join(f.repo,"link"));
    expect(() => changesFromGit(f.repo,"main")).toThrow(/symlink/);
  } finally { f.cleanup(); }
});

test("HTTP boundary rejects browser cross-origin, DNS rebinding and form posts", () => {
  const request = (host: string, origin?: string, type="application/json") => new Request(`http://${host}/`, { method: "POST", headers: { host, "content-type": type, ...(origin?{origin}:{}) }, body: "{}" });
  expect(_test.requestAllowed(request("127.0.0.1:8766"))).toBe(true);
  expect(_test.requestAllowed(request("127.0.0.1:8766","http://127.0.0.1:8766"))).toBe(true);
  expect(_test.requestAllowed(request("127.0.0.1:8766","https://evil.invalid"))).toBe(false);
  expect(_test.requestAllowed(request("evil.invalid:8766"))).toBe(false);
  expect(_test.requestAllowed(request("127.0.0.1:8766",undefined,"text/plain"))).toBe(false);
  expect(_test.safeURL("javascript:alert(1)")).toBe("");
  expect(_test.safeURL("https://forge.example/pulls/1")).toBe("https://forge.example/pulls/1");
});

test("Gitea fixture verifies configured base, PR payload, CI status, failure and redirect refusal", async () => {
  const f = fixture(); f.git("remote","add","origin","ssh://git@forge.example:2222/owner/repo.git");
  const seen: any[] = [];
  let mode = "ok";
  const server = Bun.serve({ port:0, hostname:"127.0.0.1", async fetch(req) {
    seen.push({ path:new URL(req.url).pathname, auth:req.headers.get("authorization"), body:req.method === "POST" ? await req.json() : null });
    if (mode === "redirect") return Response.redirect("http://127.0.0.1:1",302);
    if (mode === "error") return Response.json({ message: "fixture denied" }, { status:403 });
    return req.method === "POST" ? Response.json({ number:1, html_url:"https://forge.example/owner/repo/pulls/1" }) : Response.json({ state:"success", statuses:[{}] });
  }});
  f.cfg.gitea = { url:`http://127.0.0.1:${server.port}`, token:"fixture-token" }; f.cfg.repos.default.base="release";
  try {
    expect((await _test.gitea(f.cfg,f.repo,"sis/t","t","Title")).ok).toBe(true);
    expect(seen[0]).toEqual({ path:"/api/v1/repos/owner/repo/pulls", auth:"token fixture-token", body:{ head:"sis/t",base:"release",title:"[t] Title" } });
    expect((await _test.giteaCi(f.cfg,f.repo,"abc")).data?.state).toBe("success");
    mode="error"; expect((await _test.giteaCi(f.cfg,f.repo,"abc")).ok).toBe(false);
    mode="redirect"; await expect(_test.giteaCi(f.cfg,f.repo,"abc")).rejects.toThrow();
    f.cfg.gitea=null;
    expect((await _test.createPR(f.cfg,{} as any,f.state,{id:"t"})).error?.code).toBe("no_connector");
    expect(f.git("branch","-r")).toBe("");
  } finally { server.stop(true); f.cleanup(); }
});

test("prune retains dirty work, then removes only a clean owned tree and retains its branch", async () => {
  const f = fixture(); const sis: any = { project: "fixture", call: async()=>({ok:true,data:{issue:{status:"open"}}}) };
  try {
    const w = _test.ensureWorktree(f.cfg,f.state,"t","a",1);
    f.state.run("UPDATE worktrees SET status='released'");
    writeFileSync(join(w.path,"uncommitted"),"keep");
    expect((await _test.pruneWorktrees(f.cfg,sis,f.state)).ok).toBe(false);
    expect(existsSync(join(w.path,"uncommitted"))).toBe(true);
    expect(f.state.query("SELECT task FROM worktrees").get()).not.toBeNull();
    rmSync(join(w.path,"uncommitted"));
    expect((await _test.pruneWorktrees(f.cfg,sis,f.state)).ok).toBe(true);
    expect(existsSync(w.path)).toBe(false);
    expect(f.git("rev-parse","sis/t")).toBeTruthy();
  } finally { f.cleanup(); }
});
