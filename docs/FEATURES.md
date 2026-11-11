# Features and support — 1.5.1

| Capability | Current 1.5.1 runtime | Retained 0.9 reference |
| --- | --- | --- |
| Default source launcher | `bin/sis`, `bin/sis-v1` alias | `bin/sis-reference`, `sis reference`, explicit `SIS_IMPL=rs|py` |
| Implementation | Bun / TypeScript 7.1 | Rust / Python |
| Registry | `packages/superiss/ops.json`, 90 operations | `ops.json`, 85 operations |
| WOOP | `woop`: bounded atomic goal + implementation/delivery/outcome tasks; preview and separate board receipts | Not available |
| Persistent tasks and memory | SQLite, FTS, goals, subtasks, notes, Remember/Recall | SQLite |
| Ownership | Atomic claims, epochs, expiring leases, heartbeat, cancellation | Same core contract |
| Acceptance | Executed oracle; source fingerprint, contract revision, proof checked at close | Same core contract |
| Close preflight | `close_check`, read-only complete contract check | Not available |
| Evidence and cost | JUnit, coverage, command/artifact/custom receipts; recorded costs and close-time budget gate | Available |
| Recovery and exchange | Checkpoint/resume, handoff, outbox, JSONL, explicit Beads export migration | Available |
| Interfaces | JSON CLI, Unix socket, multiplexed requests, MCP, local HTTP/task board | CLI/socket/MCP/HTTP |
| Repeated agent calls | `sis rpc` serial NDJSON session or identity-checked persistent socket client | One-shot client or explicit socket |
| Search | SQLite FTS5 by default; optional local sqlite-vec hybrid projection with explicit rebuild and FTS fallback | SQLite search only |
| Analytics | Optional isolated DuckDB 2 snapshot worker | Recorded outcome aggregates |
| Forge | Packaged CLI, HTTP board, eleven MCP tools; atomic reservation, Git/Worktrunk, repository routing and cross-store local merge locks | Explicit adapter `--runtime reference`; no current proof-gated merge |
| macOS local-zero execution | Explicit zero budget and native sandbox boundary; unsupported platforms refuse it | Explicit supported workflow |
| Workflow / services | Optional workflow and foreground service adapters; launchd installation remains an explicit reference workflow | Explicit launchd workflow |

## What lives where

| Data or process | Location | Role |
| --- | --- | --- |
| Issues, claims, leases, proof receipts, events and FTS5 | Selected `--db /absolute/project/.sis/tasks.db` | Only task authority; FTS5 shares this SQLite database |
| Optional sqlite-vec | Sibling `<tasks.db>.search-vec-<project-model-hash>.sqlite` | Disposable search suggestions; `search_index action=build` rebuilds it from an authority snapshot |
| DuckDB 2 | Sibling `<tasks.db>.analytics.duckdb` | Explicit read-only analytics snapshot; never a claim or proof authority |
| Embedding model | Operator-supplied loopback endpoint and native sqlite-vec library | Opt-in; no downloads or model calls on default FTS5 searches |
| `sis rpc` / Unix socket | Client session / one project-owned daemon | Reuses a process or connection, not a second database; no automatic replay of ambiguous mutations |

Use one-shot `sis` for occasional human commands. For an agent making many calls
to the same database, hold `sis rpc --db /absolute/project/.sis/tasks.db` open
and send one JSON request per line; keep the returned `id`, `ok` and `data`
envelope. Existing socket clients can instead reuse their version- and
project-checked connection. This removes repeated CLI startup, not SQLite
transaction, oracle or model work. Never change a running daemon's version
under active clients without a controlled cutover.

`SIS_VERIFY_CONCURRENCY` is a separate operator choice (default 2, maximum 8).
Increasing it admits more simultaneous oracles but also increases subprocess
and host load. A `verify_busy` rejection is not a completed proof; keep the
lease alive and retry only after inspecting the claim and capacity.

## Forge operations

`reserve`, `bind`, `changes`, `record`, `git-commit`, `push`, `verify`, `pr`, `ci`, `rebase`, `merge`. CLI, HTTP and MCP use one dispatcher. `reserve` atomically creates the contract and claim, then binds the returned live fence. `commit` remains a deprecated adapter alias for `record`; it does not create a Git commit. [Full workflow](SISF.md).

## Completion contract

`close_check` and `close` share the same validation: current claim/lease, proof actor and epoch, contract revision, source fingerprint, oracle, optional review/evidence requirements, budget and child completion. Preflight does not reserve the task or make Git/database changes atomic. A merge checks again after CI and uses a repository/base merge slot.

`merge` advances the local base only by fast-forward, retains source work and closes only after a verified result. It refuses introduced changes outside the proof scope and claims with less than 35 seconds remaining. It does not perform a remote PR merge, enforce forge branch protection on local Git, fetch, force-push, automatically rebase or delete branches. Remote PR review and merge remain forge operations.

## Boundaries

- General allowed paths are source scope, not an OS sandbox. The local trust boundary is the Unix user.
- Cost records need trustworthy inputs; a close budget gate does not authorize provider spending.
- Task state, Git and remote effects are separate durable operations. No arbitrary exactly-once execution is claimed.
- `meta.repo_key` routes within the configured store. Cross-machine authentication and distributed scheduling are not included.
- Analytics is optional; SQLite remains authoritative. Reports cannot grant claims or approve closes.
- [Validation](VALIDATION.md) distinguishes executed tests, environment-blocked tests and historical receipts.
