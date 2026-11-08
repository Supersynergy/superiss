# Contributing

Develop the current 1.1 runtime in `packages/superiss` and forge in `sisf`. Keep claims, source-bound proofs, bounded commands and explicit project selection intact. Add regression coverage for behavior changes, including failure/partial-success paths.

```sh
# Installed Bun >=1.4.4, TypeScript 7.1 and Node/Bun type declarations required.
bun tools/check-v11.ts
# Full hybrid analytics gate additionally requires DuckDB 2 and run-guard:
bun packages/superiss/check.ts
bun tools/check-v1-publication.ts
```

`SIS_TSC` pins the installed compiler; `SIS_TYPE_ROOTS` points to installed types. CI exercises current core and forge on Linux/macOS. Tests that cannot execute must be reported as blocked or skipped, never counted as passing. A short recovery test is not a production soak.

The Rust/Python reference uses the root `ops.json` and explicit `SIS_IMPL=rs|py`; its macOS sandbox/service gate is `tools/verify-all.sh`. Keep historical reference evidence identifiable when changing shared entry points.

Do not commit databases, credentials, task mirrors, caches or machine-specific binaries. Release packages use a new directory and exact file hashes. [Current feature boundaries](docs/FEATURES.md).
