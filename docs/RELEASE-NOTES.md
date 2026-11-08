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
