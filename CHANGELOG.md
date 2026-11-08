# Changelog

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
