# Integrated forge workflow — Superiss 1.1

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

All task commands require `--db PATH --actor NAME --epoch N`, or `SIS_DB` for the database. Use the actual claim epoch returned by the core.

| Command | Effect |
| --- | --- |
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
| `ci TASK [--via …]` | Query statuses/check runs for the exact current commit |
| `rebase TASK` | Rebase onto the configured local base; verify again afterwards |
| `merge TASK --proof-id ID` | Check proof and CI, fast-forward local base, close; retain worktree/branch |
| `merge TASK --proof-id ID --skip-ci` | Explicit local workflow without CI; proof is still mandatory |
| `prune` / `prune --yes` | Preview/apply clean inactive owned-worktree removal; retain branches |
| `mcp` | Expose ten forge tools over stdio MCP |

`wt` aliases `bind`. The old `commit` command and `/sisf/commit` endpoint remain deprecated **record-only** aliases. Use `git-commit` to create a Git commit.

## PR workflow versus local merge

A PR workflow is: work → commit → record/verify → explicit push → PR → CI/review → merge on the forge. Required checks, reviews and protected branches belong to that forge. Task closure still uses the core proof contract. No remote PR merge is performed by `sis forge merge`.

The local workflow requires a clean source and configured repository, with the configured base checked out. It preflights the exact `close` contract, requires successful exact-HEAD CI by default, acquires a repository/base merge slot, rechecks source/claim/proof, fast-forwards without rewriting the source, then closes the task. Missing/pending CI is never success. The introduced diff must fit the task's source scope, and the live lease must have at least 35 seconds remaining. If the base advanced incompatibly, rebase and verify again. No auto-fetch, force-push, source deletion or base push occurs.

Git and task closure are separate writes. If Git succeeded but close failed, the result includes `merged:true, closed:false`; inspect the current task and HEAD and reconcile instead of repeating writes blindly. PR lookup avoids normal duplicate creation, but a timeout after a remote write or concurrent remote creators still requires reconciliation.

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

Ten `sis_forge_*` tools use the same workflow and checks. The core worker profile exposes 13 tools. Neither interface grants a paid model provider or authenticates actor names.

## Recovery and trust boundary

Bindings are scoped to database filename and native project identity, in `<database-name>.sisf.state.db`, using SQLite WAL/FULL and mode 0600. The durable event cursor advances only after a lifecycle event is handled. Current daemons emit a single bounded-watch response; `--runtime reference` explicitly selects the old two-frame protocol. Unknown/current-version mismatches fail before mutation. Reference mode cannot use 1.1 `close_check`/merge.

Claim and worktree creation are separate operations. A Git failure preserves the claim and reports `bound:false, claim_preserved:true`. A crash between Git creation and state recording can leave a locked tree: inspect it explicitly. A newer actor/epoch cannot inherit it silently.

Cleanup verifies inactive task state, configured repository, current branch/path, cleanliness and the adapter lock. Dirty work and branches remain recoverable. No arbitrary external exactly-once guarantee is made.

The server checks Host/Origin, requires JSON for writes and bounds bodies. It is for trusted local processes under one Unix user, without multiuser authentication. Keep it on loopback. CI/PR connector fixture coverage does not establish acceptance against your production forge. [Validation](VALIDATION.md).
