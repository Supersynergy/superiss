# Validation — Superiss 1.5.1

Current evidence is separate from the [historical 0.9 record](archive/0.9/VALIDATION.md). JSON receipts under `docs/research/` describe their original snapshots; their hashes are not current-file assertions.

## 1.5.1 acceptance scope

Run `bun tools/check-v11.ts`, `bun packages/superiss/check.ts` and `bun tools/check-v1-publication.ts` on the same source hash. The optional sqlite-vec integration test requires an installed extension selected with `SIS_TEST_VEC_EXTENSION`; otherwise it is explicitly skipped while the FTS-only case still runs. Bundle checks prove a relocated synthetic lifecycle and DuckDB snapshot, not the state of a production daemon. Verify each target's owner receipt, current leases and copied database before any live cutover; identify the new runtime by its actual `context` response. Hosted CI, other hosts and real-model search quality require separate evidence.

## 1.3 acceptance scope

Run `bun tools/check-v11.ts` for strict current/forge types, native store/API/WOOP/outcome regressions, the complete wire contract, Forge/process oracles, catalog and launcher checks. Run `bun packages/superiss/check.ts` and `bun tools/check-v1-publication.ts` for the additional full hybrid and relocated-release gates; these require the installed DuckDB 2 library and run-guard. No dependency is downloaded automatically.

`packages/superiss/woop.test.ts` covers atomic creation, exact bounds, dependency ordering, native idempotency, orphan collisions, whole-batch rollback, durable context, ownership and stale proofs. API regressions cover mutation method/origin boundaries, stored stage receipts, contract drift and restart. Browser acceptance additionally covers preview-before-write, template, keyboard/filter/focus, draft and expansion persistence, reload, escaping, failed/unknown/stale/passed receipts. Synthetic examples do not establish customer acceptance.

This section defines the 1.3 gate; the following numeric results belong to their original historical commits. Local acceptance does not assert a published 1.3 tag or GitHub CI run. [WOOP limits and upgrade](WOOP.md).

## Historical hosted 1.1 runtime and forge gate

[Passing Linux/macOS and Worktrunk run](https://github.com/Supersynergy/superiss/actions/runs/42485621381), code commit `5d6a8c2a91b38f0b99aa9a949144197bdfc54407`:

| Check | Result and scope |
| --- | --- |
| Current runtime, Linux x64 and macOS arm64 | Strict TypeScript core/forge/release checks; 15 core regressions on each platform |
| Complete wire contract | 11 PASS, 0 FAIL, 0 MISSING; all 88 registered operations present |
| Forge unit, transport, connector and package suite | 35 passed on each platform; installed-binary case covered separately |
| Process oracles | Race/isolation, board join, lane policy and lifecycle/restart/HTTP boundaries passed on both platforms |
| Actual Worktrunk 0.81.0 | Published-checksum installation; 11 workflow cases passed, including exact-path binding and source-preserving merge |
| Relocated 1.1 bundle | Exact SHA-256 file manifest, overwrite refusal, CLI/forge launchers, both MCP entry points and selected-tool enforcement |
| Publication content | Current version/catalog/docs links, JS/shell syntax and whitespace checks |

The current hosted gate is `bun tools/check-v11.ts`. It includes real socket/watch/heartbeat handling and HTTP process checks that the local executor cannot run. Repeated suite execution in the forge gate is not counted as additional distinct tests. The installed-Worktrunk case is intentionally skipped in the generic job and executed in its dedicated job.

The independent reference workflow (`.github/workflows/ci.yml`) additionally builds Rust and runs the retained Rust/Python, macOS local-zero and service checks. It packages `bin/sis-reference` for its native-bundle fixture; the current `bin/sis` belongs to 1.1. Consult [the repository checks](https://github.com/Supersynergy/superiss/actions) for the exact reviewed commit.

## Local checks and boundaries

Bun 1.4.4, TypeScript 7.1.0-dev.20261108.1, Linux x64; bundled SQLite reports 3.53.4. **47 distinct targeted tests passed locally**: 29 forge/connector/package cases, nine core cases and nine hybrid/compiler/SQLite cases. Strict typing, source documentation checks and the runnable claim → rejected proof-free close → oracle → close/readback example also passed.

Local socket creation is denied (`EPERM`), and local Worktrunk binary download returned HTTP 504. Those paths are validated by hosted execution above, not counted as local passes. Connector tests use controlled API/CLI fixtures; they do not establish acceptance against a production GitHub/Gitea/Forgejo account.

The complete inherited analytics/publication gates remain separate: `bun packages/superiss/check.ts` and `bun tools/check-v1-publication.ts`, requiring DuckDB 2 and `run-guard`. They have not been rerun in full in the socket-restricted local executor. Historical 1.0 analytics receipts are not relabelled as 1.1 acceptance.

## Reproduction

```sh
# Installed Bun, TypeScript 7.1 and Node/Bun types required.
bun tools/check-v11.ts
# Additional analytics prerequisites required for these full hybrid gates:
bun packages/superiss/check.ts
bun tools/check-v1-publication.ts
```

No production forge deployment, authenticated multiuser operation, remote PR merge, power-loss/disaster test, independent security audit, competitor performance advantage or completed 24-hour production soak is established by these checks.
