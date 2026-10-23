# Release validation — 23 October 2026

The public source was prepared from the installed fixed **0.9.0** source bundle. Original file hashes and publication changes are recorded in [source-snapshot.json](research/source-snapshot.json). The author’s working checkouts, active stores and installed pointer were preserved.

## Executed locally

- Native build: `CARGO_TARGET_DIR=.cache/cargo cargo build --locked -j2` — passed.
- Full project gate: `bash tools/verify-all.sh` — passed for both Rust and Python, including ownership, source drift, budget, sandbox, controller, recovery, socket, MCP and HTTP cases.
- Service suite: **35 passed, 0 failed** across five Bun files, including process kills, restart, pause, concurrency and defaults.
- Runnable quickstart: real claim, rejected proof-free close, oracle, source-bound close and final readback — passed.
- Publication secret scan: staged package scanned with Gitleaks; **zero findings**. Local databases, caches, private acceptance notes and machine binaries are excluded.
- Text checks: `slopcheck` on launch documentation; findings reviewed and German README revised.

The full gate ran under a bounded resource wrapper: exit 0, **137.603 seconds**, **215 MiB** observed process-tree peak. An initial native process-identity probe stopped the earlier run; the successful run used the wrapper's `ps` backend. This is a test-run observation, not a speed benchmark.

Machine-readable test summaries and gate-log hash: [validation.json](research/validation.json). The original full logs remain in the local ignored build cache. CI repeats the build, gate and demo on a GitHub macOS runner; its status badge reflects the remote result separately.

## Review limits

Self-review covered public/private file boundaries, the generated operation inventory, documentation links, demo behavior and comparison claims. `grepgod review` and `aislop .` were also run. The generic scanner is **not clean**: it reports inherited style issues, Bun-global lint mismatches, empty catches and conservative query/command warnings in the bundled search workload. Inspected query examples use controlled SQL fragments and bound values. This is not a comprehensive security audit or a claim that every static warning has been resolved.

The publication changes preserve the core Rust/Python source. The bundled search workload replaces embedded author build paths with `import.meta.dir`; its original and public hashes are recorded beside it. The new demo is exercised directly. Existing intentional runtime-specific skips are recorded in the machine summary.

## Claims this does not establish

A local passing gate does not prove production availability, a completed 24-hour soak, authenticated reviewer identity, exactly-once external effects, customer demand, billing savings or superiority over competing tools. The included historical benchmark has its own [scope and provenance](../bench/results/PROVENANCE.md).
