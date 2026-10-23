# sisf — connect accepted work to Git

`sisf` is an optional Bun/TypeScript adapter for Superiss 0.9.1. It links a claimed task to a Git worktree, records its changes and artifact reference, and shows tasks beside worktrees, commits and pull requests. The tracker core still has 85 operations; the adapter does not change its protocol or database schema.

## What ships

| Capability | Behavior |
| --- | --- |
| 🔗 Claim → worktree | Successful proxied claims return `data.sisf.bound`, `worktree` and `branch`. Claims made through the native socket are reconciled by the event watcher. |
| 🔒 Ownership checks | Bindings require the current actor, epoch and live lease. A different epoch cannot silently inherit an existing worktree. |
| 🌿 Git isolation | Each task gets a locked worktree and branch under `.sisf/wt/` and `sis/`. The creation base is stored as a commit SHA. Altered/truncated task identifiers receive a hash suffix. |
| 🧾 Change records | `changes` through the proxy computes the bound worktree's diff. `commit` requires both the native change record and artifact operation to succeed. |
| 🖥️ Board | `/forge` joins task state with stored worktree, head and PR references. The board refreshes every five seconds; it is an operational view, not a review UI. |
| 🔌 Connectors | Gitea PR creation and combined commit status, GitHub PR creation through `gh`, and push to an explicitly configured Git mirror. |
| 🛤️ Lanes | Configured lane paths are recorded as advisory policy on the binding. The task's native acceptance scope remains authoritative. |
| ♻️ Restart | SQLite WAL with `synchronous=FULL` stores bindings and the handled event cursor. Failed events are retried; six consecutive failures stop the watcher and make health report an error. |
| 🧹 Cleanup | `prune` lists inactive bindings. `prune --yes` removes only clean, inactive, correctly located worktrees with a matching sisf lock. Branches remain as recovery references. |

Runtime requirements: Bun, Git and a running project-bound Superiss daemon. GitHub PR creation also needs an authenticated `gh`. There are no third-party runtime packages; `bun:sqlite` provides the local state database.

## Start

From the cloned repository, after building the core:

```bash
export SIS_DB="$PWD/.sis/project.db"
mkdir -p .sis
bin/sis serve --db "$SIS_DB"
# Keep that terminal running. In another terminal with the same SIS_DB:
bin/sisf serve --db "$SIS_DB" --repo "$PWD" --port 8766
# Open http://127.0.0.1:8766/forge
```

The repository must have a commit and the configured base branch, `main` by default. Include `/.sisf/` in that repository's `.gitignore`. Each store has a separate adapter process and port. Its state is stored beside the task database as `<database-name>.sisf.state.db` and bound to the native project identity. An older unscoped `sisf.state.db` is preserved and is not imported automatically. The current command path uses the `default` repository; a `repos` map is configuration groundwork, not a tested multi-repository dispatcher.

Create a task with an executable oracle and relative source scope, then claim through the proxy:

```bash
bin/sis create --db "$SIS_DB" id=example title="Implement example" \
  oracle_cmd="test -f src/example.ts" 'allowed_paths=["src"]'
curl -sS http://127.0.0.1:8766/ \
  -H 'content-type: application/json' \
  -d '{"cmd":"acquire","args":{"id":"example","actor":"worker-a","ttl":600}}'
```

Create `src` and the required source files inside the returned worktree before recording an artifact or running acceptance. Keep the claim alive with native heartbeats. Use the returned epoch, rather than assuming it is always 1:

```bash
bin/sisf commit example --db "$SIS_DB" --actor worker-a --epoch 1
bin/sis verify example --db "$SIS_DB" actor=worker-a epoch=1 \
  cwd=/absolute/path/to/returned/worktree timeout_secs=120
# Only after passed:true, close using the returned proof_id.
```

`commit` records an artifact assertion. It does not execute the oracle, create a Git commit, authenticate a reviewer or authorize task closure. Native `verify` and `close` still enforce the task contract.

## Forge configuration

Place `sisf.config.json` beside the task database. Keep credentials out of Git; use environment variables where possible.

```json
{
  "repo": "/absolute/path/to/repository",
  "base": "main",
  "port": 8766,
  "lanes": { "implementation": { "paths": ["src", "tests"] } }
}
```

For Gitea, set `SISF_GITEA_URL` and, when required, `SISF_GITEA_TOKEN` before starting the adapter or CLI. If a `gitea` object exists in the config file, it takes precedence over these variables. Repository owner/name come from `origin`; HTTP, SSH URL forms with ports, and SCP-style remotes are recognized.

```bash
# First commit and explicitly push the task branch to the intended forge.
git -C /absolute/path/to/worktree push -u origin sis/example
bin/sisf pr example --db "$SIS_DB" --actor worker-a --epoch 1 --via gitea
bin/sisf ci example --db "$SIS_DB"
# GitHub: the same PR command with --via github.
```

PR creation does not implicitly push to `origin`. `--via mirror` is an explicit push operation and requires a configured `mirror` on the default repository. API requests time out after ten seconds and reject redirects. Git operations have thirty-second bounds; `gh pr create` has a sixty-second bound. Failed CLI operations exit nonzero.

## Operational boundaries

A native claim and a Git worktree creation are separate durable operations. They are not one cross-store transaction. If Git creation fails, the native claim is preserved and the response reports `data.sisf.bound:false` with `claim_preserved:true`. Inspect the failure and reconcile it before continuing work. A crash after Git creation but before the state write can leave an owned locked worktree that requires explicit reconciliation.

A new actor/epoch cannot reuse the previous binding automatically. Preserve or commit the old work, release the current claim when appropriate, then inspect `prune`. Cleanup retains branches; rename a retained branch to a recovery name before creating a new binding with the same task identifier. Do not bypass ownership checks by deleting another worker's files or locks.

The adapter listens on loopback. It checks Host/Origin, requires JSON POST requests, limits request bodies to 1 MiB and rejects unsafe PR URL schemes. It is intended for trusted local agents. It has no multiuser authentication and must not be exposed through a public reverse proxy. Local processes with equivalent filesystem/socket access remain inside its trust boundary.

The diff collector rejects unreadable Git output, missing bases, oversized untracked files, untracked symlinks and changes exceeding the native 80-file/300-character-path limits. It does not silently turn these failures into empty evidence. Rename detection is disabled: a rename appears as a delete and add. Hunk ranges are best-effort metadata; native source fingerprints govern acceptance.

Merge protection, required CI/reviews and access control belong to the forge configuration. No automatic merge gate, jj/Radicle backend, hosted authentication or multi-store fan-in is implemented here. GitHub and mirror connectors need environment-specific validation before relying on them in production.

## Executed acceptance

Run `bash tools/verify-forge.sh`. It checks socket disconnect settlement, two-frame wait-watch handling, epoch refusal, failed artifact propagation, immutable bases and locks, identifier collisions, binary/untracked diffs, browser request boundaries, safe cleanup and a local Gitea HTTP fixture. Separate process oracles cover simultaneous claims, independent diffs, native artifact records, the board join, lane policies, direct-socket claims, durable cursor restart and actual HTTP rejection paths.

The Gitea fixture checks request URLs, token header, configured PR base, PR response, commit status, HTTP errors and redirect refusal. It is not an end-to-end test against a running Gitea deployment. No current competitor speed or reliability benchmark is claimed.

[Forge comparison](FORGE-COMPARISON.md) · [Core features](FEATURES.md) · [Acceptance contract](../SPEC.md)
