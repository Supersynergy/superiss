# Validation — Superiss 1.1.0

This page describes current validation separately from the [historical 0.9 record](archive/0.9/VALIDATION.md). JSON receipts under `docs/research/` describe their original source snapshots and are not current-file validation.

## Executed in this development environment

- Bun 1.4.4, TypeScript 7.1.0-dev.20261108.1, Linux x64; SQLite reported by Bun is 3.53.4.
- **45 distinct targeted tests passed locally**: 27 forge/connector/package checks, nine core checks and nine hybrid/compiler/SQLite checks. One installed-Worktrunk case was skipped; socket-dependent cases were excluded from these counts.
- Strict current-core and forge/release TypeScript checks passed with explicit installed Node/Bun types.
- Core checks executed locally cover schema/FTS/transactions, XML/JUnit, canonical JSON, compiler selection, complete-contract refusal, tokenizers, checkpoint/source drift, legacy fingerprint compatibility and evidence rejection.
- Forge checks executed locally cover a real Git worktree → staged commit → artifact → oracle → read-only close preflight → local fast-forward → task close; stale claims/proofs, insufficient remaining lease, out-of-scope introduced changes, advanced target refusal, repository routing/configuration drift and missing-backend failure.
- Connector fixtures cover matching PR reuse, explicit base/repository, Gitea/Forgejo payloads, exact-HEAD GitHub checks/statuses, empty/pending/failed/truncated CI and malformed API receipts. These use controlled responses and executable CLI fixtures, not production accounts.
- A newly built, relocated 1.1 bundle passed exact-file SHA-256 manifest checking, overwrite refusal, current core CLI, forge aliases, both MCP entry points and selected-tool enforcement.
- Source documentation links, version/catalog consistency, launcher shell syntax, MCP JS syntax and whitespace checks passed.

## Environment-blocked and separately checked paths

This local executor denies Unix socket creation (`EPERM`), including an independent Python/Node probe. Escalated execution was rejected by the environment approval policy. Socket/watch/concurrency/lifecycle/HTTP process tests therefore cannot be counted as passing locally. The complete current gate and the real installed-Worktrunk case are configured in `.github/workflows/v11.yml` on Linux/macOS runners; consult the actual workflow result for the reviewed commit. Publishing this branch was blocked by the automatic approval review, so those hosted checks have not been triggered from this environment.

The real Worktrunk binary was unavailable locally because its release download returned HTTP 504. The optional installed-binary test is explicitly skipped locally. Backend command construction is not a substitute for that integration result.

The complete inherited analytics/publication gates remain separate: `bun packages/superiss/check.ts` and `bun tools/check-v1-publication.ts`, requiring DuckDB 2 and `run-guard`. They have not been rerun in full in this socket-restricted environment. Historical 1.0 platform receipts remain in the changelog; they are not renamed to 1.1 acceptance.

## Reproduction

```sh
# Existing Bun, TypeScript 7.1 and Node/Bun types required.
bun tools/check-v11.ts
# Optional additional native analytics requirements:
bun packages/superiss/check.ts
bun tools/check-v1-publication.ts
```

No production forge deployment, authenticated multiuser operation, remote PR merge, power-loss/desaster test, independent security audit, comparative performance advantage or 24-hour production soak is established by these checks.
