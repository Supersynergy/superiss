# Superiss 1.3.0

- Added `sis woop`: one atomic native goal with implementation, delivery and outcome tasks, separate oracles/scopes/acceptance, ordered dependencies and explicit controller ownership. No execution or claims occur on creation.
- Versioned intent and stage references travel through the existing revision-bound contract/brief/acquire/resume path. Input is bounded and exact; replay uses native idempotency. No database migration or dependencies.
- Added a board form with preview and a SuperSynergy template. Each stage shows its stored native proof, stale-contract state and unknown source currency; customer impact and payment are not inferred.
- Preserved the installed local Forge completed-commit acknowledgement fix. Runtime, schema catalog, packaging and MCP advertise 1.3.0 with 89 core operations and eleven forge tools.
- Existing daemons retain their old runtime. A 1.3 client refuses mismatched daemons; rollback uses the retained installation. [Upgrade](GETTING-STARTED.md), [WOOP](WOOP.md), [validation scope](VALIDATION.md).

## Historical 1.1 release notes

# Superiss 1.1.0

The source default, release bundle and forge now use one current Bun/TypeScript runtime. Previously the source default and forge remained on the 0.9 reference while the 1.0 bundle used a separate runtime.

- Integrated `sis forge`, packaged `sisf`, CLI/HTTP/MCP dispatch and the current single-frame watch protocol.
- Added explicit Git commits, branch push, rebase and proof-gated local fast-forward merge with a merge slot, final source/claim checks and task closure.
- Added a shared read-only `close_check` preflight: 88 core operations plus ten forge tools.
- Added optional Worktrunk lifecycle calls without automatic fallback, hooks or rewriting verified commits.
- Added configured repository routing through task `meta.repo_key`, GitHub CI/check runs and matching-PR reuse, plus explicit Gitea/Forgejo REST connectors.
- Retained record-only compatibility aliases and safe worktree cleanup. Updated MCP versions, selected-tool enforcement, current docs and comparison claims about Beads leases.
- Retained explicit reference entry points and labelled historical receipts. Existing databases/daemons are never automatically migrated or replaced.

[Upgrade](GETTING-STARTED.md) · [Forge operations and limits](SISF.md) · [Validation](VALIDATION.md) · [Historical 0.9 release notes](archive/0.9/RELEASE-NOTES.md).
