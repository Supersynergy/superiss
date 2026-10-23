# Get started

## Requirements

- Rust/Cargo and SQLite development libraries for the native build. macOS provides system SQLite; Linux distributions typically package development headers separately.
- Python 3 for the demo, reference implementation and runner.
- Node.js for optional MCP; Bun for lifecycle/service commands and TypeScript tooling.
- `fd` and `ripgrep` for the optional bundled search/soak workload and its full-gate fixture (`brew install fd ripgrep` on macOS). The tracker itself does not need these tools.
- macOS for Seatbelt `local_zero` execution and launchd installation. General tracker code is separate from those OS-specific features. This release's full local acceptance runs on macOS.

```bash
git clone https://github.com/Supersynergy/superiss.git
cd superiss
CARGO_TARGET_DIR=.cache/cargo cargo build --locked -j2
python3 examples/quickstart.py
```

The demo needs no daemon, model provider or permanent database. It executes a real oracle and confirms close and readback. The launcher defaults to Rust. Set `SIS_IMPL=py` explicitly for Python. Without optional local `tiktoken` and its cache, Python reports a labelled conservative token bound.

## A persistent project

```bash
export SIS_DB="$PWD/.sis/project.db"
mkdir -p .sis
bin/sis serve --db "$SIS_DB" --http 8765
```

The server stays in the foreground. Open [the local board](http://127.0.0.1:8765). In a second terminal, set the same absolute database and create work:

```bash
export SIS_DB="/absolute/path/project/.sis/project.db"
/absolute/path/superiss/bin/sis create '{
  "id":"check-readme", "title":"Check the project README", "owner":"worker-1",
  "oracle_cmd":"test -s README.md", "acceptance":"README.md contains text",
  "allowed_paths":["README.md"]
}' --db "$SIS_DB"
/absolute/path/superiss/bin/sis acquire actor=worker-1 ttl=300 --db "$SIS_DB"
```

Use the returned ID and epoch for `verify` with the project's absolute `cwd`. Check `passed:true`, then pass its actual `proof_id` to `close` with the same actor/epoch. [The runnable demo](../examples/quickstart.py) shows every step. Keep the lease alive with `heartbeat`. `resume` reads a checkpoint but does not acquire a claim. Stop the server with Ctrl-C; keep HTTP on loopback.

## Local execution

Task text is not executed automatically. Opt into `sis run` with an explicit local execution contract. Read [ZERO-RECOVERY.md](../ZERO-RECOVERY.md). The tracker database must remain outside the writable job directory. Start supervision with `sis service foreground --config /absolute/path/config.json`; [SERVICE.md](../SERVICE.md) describes configuration, ownership and lifecycle.

## Contributor setup

The tokenizer dependency is pinned with hashes. With [uv](https://docs.astral.sh/uv/) installed:

```bash
export TIKTOKEN_CACHE_DIR="$PWD/.cache/tiktoken"
uv venv --python 3.14 .venv
uv pip install --python .venv/bin/python --require-hashes -r requirements-tokenizer.lock
.venv/bin/python -c 'import tiktoken; tiktoken.get_encoding("o200k_base"); tiktoken.get_encoding("cl100k_base")'
export SIS_PYTHON="$PWD/.venv/bin/python"
bash tools/verify-all.sh
```

The full gate needs macOS, Rust, Python, Bun and Node.js. Downloading the test tokenizer is setup, not a model call. See [CONTRIBUTING.md](../CONTRIBUTING.md).
