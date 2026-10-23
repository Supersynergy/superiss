# Release validation — 23 October 2026

The public source was prepared from the installed fixed **0.9.0** source bundle and received the **0.9.1** loopback-startup fix. Original file hashes and publication changes are recorded in [source-snapshot.json](research/source-snapshot.json). The author’s working checkouts, active stores and installed pointer were preserved.

## Executed locally

- Native build: `CARGO_TARGET_DIR=.cache/cargo cargo build --locked -j2` — passed.
- Full project gate: `bash tools/verify-all.sh` — passed for both Rust and Python, including ownership, source drift, budget, sandbox, controller, recovery, socket, MCP and HTTP cases.
- Service suite: **35 passed, 0 failed** across five Bun files, including process kills, restart, pause, concurrency and defaults.
- Runnable quickstart: real claim, rejected proof-free close, oracle, source-bound close and final readback — passed.
- Publication secret scan: staged package scanned with Gitleaks; **zero findings**. Local databases, caches, private acceptance notes and machine binaries are excluded.
- Text checks: `slopcheck` on launch documentation; findings reviewed and German README revised.

The full gate ran under a bounded resource wrapper: exit 0, **145.503 seconds**, **166 MiB** observed process-tree peak. An initial native process-identity probe stopped the earlier run; the successful run used the wrapper's `ps` backend. This is a test-run observation, not a speed benchmark.

Machine-readable test summaries and gate-log hash: [validation.json](research/validation.json). The original full logs remain in the local ignored build cache. CI repeats the build, gate and demo on a GitHub macOS runner; its status badge reflects the remote result separately. The first public CI setup selected Python 3.15, which the pinned tokenizer's PyO3 dependency rejects. The follow-up CI configuration selects Python 3.14 explicitly.

## Review limits

Self-review covered public/private file boundaries, the generated operation inventory, documentation links, demo behavior and comparison claims. `grepgod review` and `aislop .` were also run. The generic scanner is **not clean**: it reports inherited style issues, Bun-global lint mismatches, empty catches and conservative query/command warnings in the bundled search workload. Inspected query examples use controlled SQL fragments and bound values. This is not a comprehensive security audit or a claim that every static warning has been resolved.

The 0.9.1 change removes reverse DNS lookup during Python loopback HTTP binding. A new regression first failed when name resolution was unavailable, then passed after binding directly through `TCPServer` and setting the known local server name/port. The full Python integration suite also passed locally. The initial hosted Python daemon timeout is recorded separately; the DNS link is a diagnosis to be checked by hosted execution, not a captured traceback from that first run.

The bundled search workload replaces embedded author build paths with `import.meta.dir`; its original and public hashes are recorded beside it. The new demo is exercised directly. Existing intentional runtime-specific skips are recorded in the machine summary.

## Claims this does not establish

A local passing gate does not prove production availability, a completed 24-hour soak, authenticated reviewer identity, exactly-once external effects, customer demand, billing savings or superiority over competing tools. The included historical benchmark has its own [scope and provenance](../bench/results/PROVENANCE.md).

## Optional forge adapter 0.1.2

The adapter was integrated with the public 0.9.1 core. Its separate gate, `bash tools/verify-forge.sh`, passes 16 Bun tests and four process oracles: race, board, lane-policy and lifecycle/restart. Regression tests first exposed unsettled socket calls, stale worktree ownership and false artifact success; the fixes passed those same cases. A further reconnect test caught a handshake rejection that did not settle its caller. A store-isolation regression also checks separate state files for databases sharing a directory and rejects a changed project identity.

The browser check confirmed the task/worktree join after reload and rendered task HTML as text. Actual HTTP checks reject cross-origin requests, hostile Host headers, form posts, malformed JSON and oversized bodies. The Gitea connector is checked against a local HTTP fixture, including configured base, PR payload, commit status, errors and redirects. This does not establish production Gitea, GitHub PR or mirror deployment acceptance.

Source-scoped Semgrep security-audit and adapter Gitleaks scans reported zero findings. The staged Aislop scan scored 97/100 with file-length and parameter-count notices remaining. These are limited automated checks plus self-review, not an independent security audit. Source hashes and results are recorded in [forge-validation.json](research/forge-validation.json).

The generated hero is also configured as GitHub's Social Preview. Public Open Graph and Twitter image metadata point to the uploaded repository image. The JPEG copy is below GitHub's upload size limit.

The shared-store actor selector was exercised against an Office store and in the process lifecycle oracle. Foreign proxied claims are rejected before native mutation, directly claimed foreign tasks produce no worktree, and the durable watcher cursor still advances. Configuration tests cover the omitted default, an explicit empty scope, environment/flag precedence and the configuration file.
