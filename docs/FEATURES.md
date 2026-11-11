# Features and support — 1.3.0

| Capability | Current 1.3 runtime | Retained 0.9 reference |
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
| Analytics | Optional isolated DuckDB 2 snapshot worker | Recorded outcome aggregates |
| Forge | Packaged CLI, HTTP board, eleven MCP tools; atomic reservation, Git/Worktrunk, repository routing and cross-store local merge locks | Explicit adapter `--runtime reference`; no current proof-gated merge |
| macOS local-zero execution | Explicit zero budget and native sandbox boundary; unsupported platforms refuse it | Explicit supported workflow |
| Workflow / services | Optional workflow and foreground service adapters; launchd installation remains an explicit reference workflow | Explicit launchd workflow |

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
