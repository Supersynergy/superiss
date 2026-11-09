# Changelog

## 1.3.0 — WOOP and separate evidence stages (2026-11-09)

- Added bounded `woop` compilation to native atomic goal planning, with controller ownership, revision-bound intent, three ordered proof-gated tasks and native replay/rollback semantics. No jobs, claims or customer confirmations are created implicitly.
- Added a preview-first board form and SuperSynergy template; implementation/delivery/outcome show separate stored oracle receipts, contract drift and unknown source currency. Filter, draft and expanded intent survive refresh; untrusted text is escaped.
- Rejected case-folded hierarchy collisions and read board goals/tasks/receipt revisions in one SQLite snapshot.
- Kept the local 1.2 Forge completed-commit acknowledgement fix, old contract hashes, protocol/fence checks and explicit runtime mismatch refusal. Updated the runtime/catalog/package/docs to 1.3.0 (89 core operations); no database migration or new dependencies.


## 1.2.0 — Forge safety integration (2026-11-09)

- Added `forge reserve` across CLI, HTTP and MCP: atomically create the contract and claim, then bind the returned live fence. Native idempotency permits acknowledgement reconciliation without duplicate claims; binding failures preserve the claim and foreign work.
- Added repository/base merge exclusion shared across linked worktrees and separate project stores. Read-only reconciliation lists locks; changed owner markers, crashes and expired leases do not trigger reclamation.
- Bind merge path scope to the validated proof's exact contract revision. Preserve whitespace and Unicode BOM in Git paths; reject invalid UTF-8 bytes instead of allowing decoded aliases.
- Recheck branch and source identity after asynchronous preflight and after Git. Applied merges with lost acknowledgements report uncertainty and the observed target instead of a false no-effect result; native task closure remains fenced.
- Bound retained command output to 8 MiB, preserve split UTF-8 and distinguish failed spawn from dispatched timeout/overflow/exit. Propagate uncertainty through CLI, HTTP and MCP without automatic retries.
- Wait at most five seconds for short concurrent Forge-state writes. The restart oracle now observes the committed actor/epoch binding before interruption, while retaining its original recovery assertions.
- Extend the current hosted gate to API/capsule/customer-outcome and snapshot regressions alongside the existing complete wire/Forge/package gates. Existing installations and live stores are not replaced by source publication.

## 1.2.0 — local source candidate (2026-11-08)

- Reference builds invoke bounded Cargo directly; the disabled automatic resource wrapper stays disabled.

- Merged GitHub main `2b200f3` into the local 1.2 source. Retained API/client/capsules, local-zero/outbox protections, conflict reconciliation and optional workflow/service adapters alongside integrated Forge/MCP, `close_check`, repository routing and proof-gated local merges. Runtime and bundles remain 1.2.0; this merge does not switch installed daemons or publish a release.
- Forge stores task binding conflicts across restart and keeps unrelated tasks moving; added read-only reconciliation and a bounded ten-client regression. Existing ownership and infrastructure failure checks remain.
- Snapshot sync refuses another owner's staged index/unrelated tracked edits and commits only its snapshot path. Active task updates require a live actor/epoch even when omitted by a caller.
- Documented CLI/MCP/HTTP/client bridges, patch-based upstream remigration and the remaining remote merge boundary in `docs/FORGE-BRIDGES.md`. Historical 1.0 soak evidence remains separately pinned.

## Unreleased

- Preserve completed Forge Git commits in failed acknowledgements when HEAD, state writes or evidence recording fail. Return the known HEAD and require reconciliation without retrying the commit or releasing the claim/worktree; cover the boundary with real Git regressions.

- Preserve optional declared customer outcome in native contract revisions and mandatory compact briefs. Old tasks keep their existing revision input. Added budget/claim, acquire/resume and stale-proof regressions; no installed daemon cutover or customer-confirmation claim.

- Added opt-in source-bound worker capsules with exact local token budgets, mandatory contract/fence retention and explicit drift invalidation. Added a reusable loopback HTTP client with bounded keepalive connections, correlation, deadlines/cancellation, queued-request shutdown and no automatic retries or redirects. Documented controller/worker/reviewer ownership and evidence-based sweetspot decisions; no paid routing, runtime cutover or 1.1 publication.

- Added opt-in 1.1 tracker snapshots with consistent event cursors, bounded filters/paging and blocked/expired/failed-proof views. Compact source-bound loop receipts retain scope/oracle/fence/checkpoints and drift without auto-replaying commands; unknown timing/proof-currency values remain explicit. Restart/reconnect and input/security regressions are covered. This is not a published 1.1 release.

- Added opt-in versioned local HTTP API discovery/OpenAPI, correlated JSON RPC/named operations, atomic batches, resumable event cursors and browser-origin/body/header guards. The existing board remains a read-only tracker.
- Integrated version-pinned workflow/runner/service/Forge adapters and optional hash-bound relocatable bundles. Local-zero execution now enforces explicit zero budgets, security metadata/source binding, sandboxed execution and fenced bounded outbox delivery. Durable effect markers reconcile lost acknowledgements without replay; interrupted effects fail closed for manual reconciliation. Unsupported platforms fail closed; reference runtimes and running services are not switched.
- Added real isolated workflow/proof/close, interruption recovery, service drain, Forge/TypeScript watch and relocated adapter acceptance; documented usage and a separately scoped 1.1 loop-speed roadmap in `docs/V1-INTEGRATIONS.md`.

- Added a private installed-bundle endurance runner with real 24-hour wall/monotonic gates, native fenced lifecycle proofs, hourly analytics and three owned daemon crash recoveries. A short probe is explicitly not endurance acceptance. Existing production services and databases are not changed; see `docs/V1-FINAL.md`.

## 1.1.0 — 2026-11-08

- Unified current source CLI, MCP and relocatable bundle; reference runtimes are explicit.
- Integrated forge CLI/HTTP/MCP, version-bound current watch protocol, Git/Worktrunk backend and repository routing.
- Added real Git commit/push/rebase, matching-PR reuse and GitHub/Gitea/Forgejo CI connectors.
- Added read-only `close_check` and a proof/CI/merge-slot-gated local fast-forward-and-close workflow, with explicit partial-success reporting.
- Packaged forge/MCP with the core and manifest; corrected host-specific SQLite assertions to compare the actual library result.
- Enforced selected core MCP tools and JSON-only HTTP writes; disallowed mutating/executing HTTP GET operations.
- Replaced stale entry-point docs and corrected Beads lease/recovery comparison. Preserved historical records separately.
- No live database migration, daemon replacement or remote PR merge is performed automatically. See [validation](docs/VALIDATION.md).

## 1.0.0 — 2026-11-03

- Added the TypeScript 7.1/Bun runtime in `packages/superiss`, with 87 operations and a separate `bin/sis-v1` source launcher. The existing `bin/sis`, Rust/Python sources, service and forge adapter remain the 0.9 reference; their recorded validation is unchanged.
- SQLite remains authoritative. DuckDB 2.0 provides bounded, read-only snapshot analytics in a separate worker and database. Neither installation nor publication migrates live project databases.
- Added version-bound daemon identity checks, fenced verification/close, bounded concurrent work and explicit copy-only SQLite adoption.
- Added source-stable bundle packaging, runtime-file SHA-256 manifests and relocated lifecycle checks, including `up/status/down`, owner-receipt protection and the HTTP board. A bundle's `bin/sis` runs 1.0; retained 0.9 installations provide rollback.
- Removed automatic `mac-resource-run` invocation from the new runtime. Analytics still requires an installed `run-guard`, DuckDB 2.0 and Bun. No dependency or extension is installed automatically.

### Packaging correction

The initial 1.0.0 archive omitted the MIT license file. The corrected `superiss-1.0.0-bun-licensed.tar.gz` includes `LICENSE` in both its source-input hash and runtime-file manifest. It is accompanied by `manifest-licensed.json` and `SHA256SUMS-licensed`. The original tag and assets remain unchanged; use the licensed archive. Runtime code is unchanged.

### Verification boundaries

macOS/arm64: complete source and packaged lifecycle gates with Bun 1.4.4, a TypeScript 7.1 development compiler, SQLite 3.54.1 and DuckDB 2.0. Netcup/Linux: Bun 1.4.4, system SQLite 3.53.4 and DuckDB 2.0; 12 targeted hybrid/guard tests, 11 strict protocol checks and copy-only lifecycle/analytics checks on three existing schema-8 databases. The Linux checks exclude compiler/version fixtures and do not constitute a complete compiler gate or a 24-hour soak.

Existing daemons and the separately pinned Python runtime of the SynergyCoder night supervisor are not silently switched. Running jobs are preserved. The daemon owner must arrange any production cutover; a 1.0 client rejects a 0.9 daemon.
