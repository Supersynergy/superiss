import { expect, test } from "bun:test";
import { _test } from "./sisf";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("socket drop rejects both uncertain inflight and queued calls", async () => {
  const client: any = new _test.Sis({} as any);
  const rejected: string[] = [];
  client.inflight = { reject: (e: Error) => rejected.push(e.message) };
  client.queue.push({ reject: (e: Error) => rejected.push(e.message) });
  client.drop(new Error("disconnected"));
  expect(rejected).toEqual(["disconnected", "disconnected"]);
  expect(client.queue).toHaveLength(0);
});

test("worktree binding refuses a different lease epoch", () => {
  const dir = mkdtempSync(join(tmpdir(), "sisf-fence-"));
  const cfg: any = { state: join(dir, "state.db"), repos: { default: { path: dir, base: "main" } }, lanes: {} };
  const state = _test.openState(cfg);
  try {
    state.run("INSERT INTO worktrees(task,path,branch,actor,epoch,status) VALUES(?,?,?,?,?,?)", ["t", dir, "sis/t", "old", 1, "active"]);
    expect(() => _test.ensureWorktree(cfg, state, "t", "new", 2)).toThrow(/ownership|lease|epoch/);
  } finally { state.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("failed changes cannot be reported as a successful artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sisf-attest-"));
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  git("init", "-q", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(join(dir, "f"), "initial\n"); git("add", "f"); git("commit", "-qm", "initial");
  const cfg: any = { db: join(dir, "sis.db"), state: join(dir, "state.db") };
  const s = _test.openState(cfg);
  s.run("INSERT INTO worktrees(task,path,branch,actor,epoch,base,status) VALUES(?,?,?,?,?,?,?)", ["t", dir, "main", "a", 1, "main", "active"]);
  const calls: string[] = [];
  const sis: any = { call: async (cmd: string) => {
    calls.push(cmd);
    if (cmd === "show") return { ok: true, data: { issue: { id: "t", status: "in_progress", claim_actor: "a", lease_epoch: 1, lease_until: Date.now()/1000 + 60 } } };
    return { ok: cmd !== "changes", error: { code: "changes_failed" } };
  }};
  try {
    const result = await _test.commitAttest(cfg, sis, s, "t", "a", 1);
    expect(result.ok).toBe(false);
    expect(calls).not.toContain("attest");
  } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
});
