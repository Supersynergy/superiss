# Changelog

## 1.2.0 — local source candidate (2026-11-08)

- Combined the local 1.1 API/client/capsule work with fetched public main `17bff9e`; runtime, lifecycle and portable bundle identify as 1.2.0. No remote release or installed runtime switch.
- Forge stores task binding conflicts across restart and keeps unrelated tasks moving; added read-only reconciliation and a bounded ten-client regression. Existing ownership and infrastructure failure checks remain.
- Snapshot sync refuses another owner's staged index/unrelated tracked edits and commits only its snapshot path. Active task updates require a live actor/epoch even when omitted by a caller.
- Documented CLI/MCP/HTTP/client bridges, patch-based upstream remigration and the remaining remote merge boundary in `docs/FORGE-BRIDGES.md`. Historical 1.0 soak evidence remains separately pinned.

## Unreleased

- Added opt-in source-bound worker capsules with exact local token budgets, mandatory contract/fence retention and explicit drift invalidation. Added a reusable loopback HTTP client with bounded keepalive connections, correlation, deadlines/cancellation, queued-request shutdown and no automatic retries or redirects. Documented controller/worker/reviewer ownership and evidence-based sweetspot decisions; no paid routing, runtime cutover or 1.1 publication.

- Added opt-in 1.1 tracker snapshots with consistent event cursors, bounded filters/paging and blocked/expired/failed-proof views. Compact source-bound loop receipts retain scope/oracle/fence/checkpoints and drift without auto-replaying commands; unknown timing/proof-currency values remain explicit. Restart/reconnect and input/security regressions are covered. This is not a published 1.1 release.

- Added opt-in versioned local HTTP API discovery/OpenAPI, correlated JSON RPC/named operations, atomic batches, resumable event cursors and browser-origin/body/header guards. The existing board remains a read-only tracker.
- Integrated version-pinned workflow/runner/service/Forge adapters and optional hash-bound relocatable bundles. Local-zero execution now enforces explicit zero budgets, security metadata/source binding, sandboxed execution and fenced bounded outbox delivery. Durable effect markers reconcile lost acknowledgements without replay; interrupted effects fail closed for manual reconciliation. Unsupported platforms fail closed; reference runtimes and running services are not switched.
- Added real isolated workflow/proof/close, interruption recovery, service drain, Forge/TypeScript watch and relocated adapter acceptance; documented usage and a separately scoped 1.1 loop-speed roadmap in `docs/V1-INTEGRATIONS.md`.

- Added a private installed-bundle endurance runner with real 24-hour wall/monotonic gates, native fenced lifecycle proofs, hourly analytics and three owned daemon crash recoveries. A short probe is explicitly not endurance acceptance. Existing production services and databases are not changed; see `docs/V1-FINAL.md`.

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
