# Get started and upgrade — 1.5.2

## Requirements

Bun >=1.4.4 runs the current source and release bundle. Git is required for forge work. Worktrunk is optional; the selected backend never silently changes. GitHub PR and CI operations require installed/authenticated `gh`. Gitea/Forgejo use the configured REST endpoint. No tracker model API key is needed.

Analytics additionally requires an existing DuckDB 2 shared library and `run-guard`. Set `SIS_DUCKDB_LIBRARY` for an explicit library path. No extension or dependency is installed automatically. Unix sockets are required for daemon/forge use; Linux and macOS are the supported targets for those paths.

## Start an explicit project

```sh
mkdir -p /absolute/project/.sis
export SIS_DB=/absolute/project/.sis/project.db
/absolute/superiss/bin/sis up
/absolute/superiss/bin/sis capabilities
/absolute/superiss/bin/sis forge serve --repo /absolute/project --port 8766
```

The repository needs an initial commit and the configured base branch (`main` by default). Ignore `/.sis/` and `/.sisf/` in the project. Stop the foreground forge separately with Ctrl-C. `sis down` stops only the matching, owned current core daemon. Starting it with `SIS_HTTP=8765` adds the task board on that port.

For a new task, use [the README workflow](../README.md) and keep its claim alive with `heartbeat`. `resume` reads state; it does not acquire a claim. A task without an executable oracle cannot be completed merely by supplying text.

## Upgrade from 0.9 or 1.0

1. Keep the previous installation and its launcher. Do not overwrite an active database or its owner receipt.
2. Test copy-only adoption with `bin/sis migrate_copy source=/absolute/old.db --db /absolute/new.db`. The target must not exist. The source remains unchanged; this is not live synchronization.
3. Stop the old daemon with its own installation/owner before switching. A current client, lifecycle helper or forge refuses a different runtime version.
4. Start the current daemon on the explicitly selected database, inspect capabilities and perform a task proof/close smoke check before resuming workers.

The source default changes to TypeScript in 1.1. `SIS_IMPL=rs|py` and `sis reference` explicitly retain the reference implementation. Existing references are not erased. The 1.1 release bundle contains only the current runtime and forge; rollback uses the retained installation.

## Build and check

Install TypeScript **7.1** and Node/Bun type declarations explicitly in your development environment. `SIS_TSC` pins a compatible installed compiler; `SIS_TYPE_ROOTS` selects the type-root directory. Then run:

```sh
bun tools/check-v11.ts
# Additional full hybrid analytics/source gate, with its native dependencies installed:
bun packages/superiss/check.ts
bun tools/check-v1-publication.ts
bun tools/package-v1.ts /absolute/new-superiss-1.5.2 --with-adapters
```

The package manifest hashes every shipped runtime file, including the forge and MIT license. A package build is not a production installation or a completed soak.

## Upgrade from 1.5.1 to 1.5.2

The schema and protocol are unchanged. 1.5.2 adds CLI help and a tested FTS
fallback when a configured model lacks the vector extension. A 1.5.2 client
still rejects a 1.5.1 daemon by version before mutation. Install the new
bundle separately; keep the 1.5.1 client and owner running until a checked,
idle cutover is authorized. Switching a symlink alone does not upgrade a
running daemon. Use `sis --help` and `sis help search_index` without a DB;
inspect `sis context --db /absolute/project.db` to confirm the actual owner.

## Upgrade to 1.5.1

SQLite and FTS5 remain authoritative. sqlite-vec is a disposable, opt-in search projection built with `search_index action=build`; DuckDB remains an explicit analytics snapshot. Check a copy of each project database and the current owner receipt before a cutover. Existing 1.4 clients cannot write through a 1.5.1 daemon and 1.5.1 clients reject 1.4 before mutation. Allow running claims and their heartbeats to finish, then stop only the verified owner with its old launcher. Retain the old release and switch only after the new owner responds with `version: 1.5.1`, the original `project_id` and a passing read/claim/proof smoke. Roll back to the retained release only after stopping the new owner safely. Changing a CLI symlink does not change a running process.

The historical macOS runner/service remains explicit through `sis reference run` / `sis reference service`. Its platform and execution contracts are described in [the reference service guide](../SERVICE.md). [Current validation](VALIDATION.md).

## Upgrade to 1.3

WOOP adds an operation and bounded contract metadata; it adds no tables or dependencies. A 1.3 client requires a 1.3 daemon and refuses a 1.2/unversioned daemon before work, without a silent direct retry. Keep the old installation for existing consumers; use its absolute launcher while its jobs run. Test a database copy, arrange an owned idle cutover, and retain the previous artifact for rollback. Switching a CLI symlink does not upgrade already running processes. [WOOP input and board](WOOP.md).

## Resume an interrupted task

Keep the original runtime while its jobs run. Select the same existing project database and read the saved state first:

```sh
bin/sis resume id=task-id --db /absolute/project/.sis/tasks.db
```

Replace `task-id` with the existing task ID. Resume returns its contract and checkpoint; it does not acquire a claim or replay commands. Check the owner, lease/epoch and any cancellation or drift before continuing. Keep another worker's live claim intact. When work is available, use an explicit bounded `acquire` with your actor and the returned contract before writing. Verification and proof-gated close remain separate. [Native operation catalog](OPERATIONS.md).
