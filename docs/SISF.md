# Integrated forge workflow — Superiss 1.2

Forge ships with the current runtime and release bundle. Use `sis forge …` or `sisf …`. It connects active task claims to locked Git worktrees, records evidence, creates real Git commits, pushes explicit branches, finds/creates PRs, reads exact-HEAD CI and performs proof-gated local fast-forward merges.

## Configuration

Place `sisf.config.json` beside the explicit task database. Keep tokens in environment variables, outside Git.

```json
{
  "repo": "/absolute/project",
  "base": "main",
  "backend": "git",
  "connector": "github",
  "actors": ["worker-a", "worker-b"],
  "repos": {
    "website": {"path": "/absolute/website", "base": "main"}
  }
}
```

`repo` defines the default repository. `meta.repo_key: "website"` routes a task to that configured repository. Relative configured paths resolve beside the configuration file. `--repo-key` selects the default for tasks without metadata. Actor scope omission allows all project actors; an explicit empty list disables automatic bindings. Lane paths remain advisory; the core acceptance contract is authoritative.

Set `backend: "worktrunk"` or `--backend worktrunk` for an installed Worktrunk exposing `switch --path --format json` and `merge --no-commit --no-rebase --no-remove`. `SISF_WT` selects an explicit executable. Calls use an exact path/base, disable hooks and do not rewrite verified commits. A backend change never silently adopts an existing binding. Superiss owns the binding/lock; do not independently remove its worktrees.

For Gitea/Forgejo, set `connector` accordingly and configure `SISF_GITEA_URL` / `SISF_GITEA_TOKEN` or a `gitea` object with `url` and optional `token`. `SISF_GH` can select the GitHub CLI executable. GitHub uses its normal authenticated `gh` setup. Redirects are rejected for REST calls.

## Commands

Existing-task commands require `--db PATH --actor NAME --epoch N`, or `SIS_DB` for the database. `reserve` creates a new claim and returns its epoch instead of requiring one. Use the actual claim epoch returned by the core.

| Command | Effect |
| --- | --- |
| `reserve TASK --title TEXT --oracle COMMAND --paths '["src","tests"]' [--idem KEY]` | Atomically create contract and claim, then bind the actual current fence; optional `--owner`, `--acceptance`, `--ttl` and `--repo-key` |
| `serve --repo PATH --port 8766` | Native event watcher, local board and JSON proxy |
| `status` | Current runtime/project and stored bindings |
| `bind TASK` | Create/reuse an ownership-checked, locked worktree |
| `changes TASK` | Compute diff from the immutable creation-base SHA |
| `record TASK` | Store changes and source-bound artifact evidence; no Git commit |
| `git-commit TASK --message TEXT` | Commit explicitly staged files, then record evidence |
| `git-commit TASK --message TEXT --all` | Explicitly stage all changes inside that worktree before committing |
| `push TASK` | Push that branch to origin, without force or an implicit base push |
| `verify TASK [--timeout-secs N]` | Execute the task oracle in its bound worktree |
| `pr TASK [--via github\|gitea\|forgejo]` | Reuse a matching open branch/base PR, or create one; no implicit push |
| `pr TASK --via mirror` | Compatibility route: explicitly push the bound branch to the configured mirror, never force |
| `ci TASK [--via …]` | Query statuses/check runs for the exact current commit |
| `rebase TASK` | Rebase onto the configured local base; verify again afterwards |
| `merge TASK --proof-id ID` | Check proof and CI, fast-forward local base, close; retain worktree/branch |
| `merge TASK --proof-id ID --skip-ci` | Explicit local workflow without CI; proof is still mandatory |
| `prune` / `prune --yes` | Preview/apply clean inactive owned-worktree removal; retain branches |
| `mcp` | Expose eleven forge tools over stdio MCP |

`wt` aliases `bind`. The old `commit` command and `/sisf/commit` endpoint remain deprecated **record-only** aliases. Use `git-commit` to create a Git commit.

## PR workflow versus local merge

A PR workflow is: work → commit → record/verify → explicit push → PR → CI/review → merge on the forge. Required checks, reviews and protected branches belong to that forge. Task closure still uses the core proof contract. No remote PR merge is performed by `sis forge merge`.

The local workflow requires a clean source and configured repository, with the configured base checked out. It preflights the exact `close` contract, requires successful exact-HEAD CI by default, acquires a repository/base merge slot, rechecks source/claim/proof, fast-forwards without rewriting the source, then closes the task. Missing/pending CI is never success. The introduced diff must fit a contract whose revision equals the validated proof's revision; an earlier task snapshot cannot authorize additional paths. The live lease must have at least 35 seconds remaining. If the base advanced incompatibly, rebase and verify again. No auto-fetch, force-push, source deletion or base push occurs.

Git and task closure are separate writes. If Git succeeded but close failed, the result includes `merged:true, closed:false`; inspect the current task and HEAD and reconcile instead of repeating writes blindly. PR lookup avoids normal duplicate creation, but a timeout after a remote write or concurrent remote creators still requires reconciliation.

An interrupted merge reports `execution_uncertain:true`, `closed:false` and the observed target ref. `merged` is `true` when that ref equals the intended commit and `null` when the attempted write cannot be established; it is not falsely reported as a known no-op. A branch or source-HEAD change during preflight or after Git prevents task closure. External-command errors expose `kind`, `started` and `execution_uncertain`; a missing executable is known not to have started, while a dispatched timeout, output overflow or nonzero exit requires reconciliation. No command is automatically retried.

The native merge slot is supplemented by an exclusive directory in the Git common directory, shared by linked worktrees and separate project databases targeting the same base. A lock contains its task/fence/store metadata and is released only by its original in-process owner when the inode and random marker still match. `forge reconcile` previews these `merge_locks` without exposing the release marker. A crash, malformed owner file, changed marker or expired lease never authorizes automatic reclamation. Inspect the owner and actual refs before arranging explicit recovery; this cooperative lock does not authenticate other local users or stop unrelated raw Git commands.

The Forge state uses WAL, full synchronous durability and a five-second SQLite busy timeout for short concurrent writes. A longer conflict still fails; it never removes another writer's lock or silently adopts a partially created worktree.

`reserve` uses a native atomic `create` → `contract` → `claim` batch. Failed native claims roll back task creation, so another tool never sees the task as ready between those steps. Worktree creation follows that transaction. If Git fails or an existing tree conflicts, the result retains the claim receipt and reports `bound:false, claim_preserved:true`. An idempotent replay reads the current contract and rechecks actor/epoch immediately before and after binding; it cannot adopt a newer owner's worktree. A lost claim after Git creation returns the retained worktree with `reconcile_required:true`, never a successful binding. Reservation TTL is 60–86400 seconds (default 1800); binding requires at least 35 seconds of remaining lease.

## HTTP and MCP

The loopback board is `/forge`; `/forge/board` joins task state and up to 200 bindings. `POST /forge/op` accepts `{"op":"verify","args":{"id":"task","actor":"worker","epoch":1}}`. The equivalent `/sisf/<operation>` paths share the dispatcher. The core proxy remains `POST /` with `cmd` and `args`.

Core and forge can be registered as two MCP servers:

```json
{
  "mcpServers": {
    "superiss": {"command":"/absolute/superiss/bin/sis","args":["mcp","--db","/absolute/project/.sis/project.db"]},
    "superiss-forge": {"command":"/absolute/superiss/bin/sis","args":["forge","mcp","--db","/absolute/project/.sis/project.db","--repo","/absolute/project"]}
  }
}
```

Eleven `sis_forge_*` tools use the same workflow and checks. `sis_forge_reserve` requires title, oracle and relative paths, then returns the claim epoch. The core worker profile exposes 13 tools. Neither interface grants a paid model provider or authenticates actor names.

Git pathname output retains whitespace and a leading Unicode BOM. Non-UTF-8 output is rejected before string-based source-scope checks; it requires explicit reconciliation rather than replacement-character decoding.

## Recovery and trust boundary

Deterministic binding conflicts are persisted across restart and later tasks continue. Inspect them with `bin/sis forge reconcile --db /absolute/project/tasks.db` or `GET /sisf/reconcile`; preview never changes ownership or repairs a worktree.

Bindings are scoped to database filename and native project identity, in `<database-name>.sisf.state.db`, using SQLite WAL/FULL and mode 0600. The durable event cursor advances only after a lifecycle event is handled. Current daemons emit a single bounded-watch response; `--runtime reference` explicitly selects the old two-frame protocol. Unknown/current-version mismatches fail before mutation. Reference mode cannot use 1.1 `close_check`/merge.

Claim and worktree creation are separate operations. A Git failure preserves the claim and reports `bound:false, claim_preserved:true`. A crash between Git creation and state recording can leave a locked tree: inspect it explicitly. A newer actor/epoch cannot inherit it silently.

Cleanup verifies inactive task state, configured repository, current branch/path, cleanliness and the adapter lock. Dirty work and branches remain recoverable. No arbitrary external exactly-once guarantee is made.

The server checks Host/Origin, requires JSON for writes and bounds bodies. It is for trusted local processes under one Unix user, without multiuser authentication. Keep it on loopback. CI/PR connector fixture coverage does not establish acceptance against your production forge. [Validation](VALIDATION.md).
