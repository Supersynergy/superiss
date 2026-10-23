# Contributing

Open an issue describing the concrete failure or proposed behavior. Include reproducible input, expected output and observed output. For a behavior-changing bug, add a failing regression before the fix.

Keep Rust and Python behavior compatible with `ops.json` and the protocol contract. Preserve lease fencing, source-bound receipts, explicit database selection and bounded retries. Run the relevant narrow check while editing, then the full gate for a release:

```bash
CARGO_TARGET_DIR=.cache/cargo cargo build --locked -j2
bash tools/verify-all.sh
```

The full gate requires macOS, Rust/Cargo, Python 3, Bun, Node.js and Python `tiktoken` with its local encoding cache. Use Python 3.14 for the pinned tokenizer; its PyO3 dependency rejects Python 3.15. The local sandbox/service tests exercise macOS behavior. Test output must identify skips; a short soak fixture is not a 24-hour availability result.

Do not commit databases, task mirrors, credentials, caches, private receipts or machine-specific binaries. Include documentation when changing the public operation contract. Generated launch artwork lives in `assets/`; it depicts the workflow conceptually.
