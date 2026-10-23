# Superiss 0.9.1 — Done needs proof.

Superiss provides local task coordination with persistent memory for AI agents. Each task has an executable acceptance contract from claim to close.

## 0.9.1 fixes

The Python loopback HTTP server binds without reverse DNS lookup. A failing regression demonstrated the unwanted dependency on name resolution; the fix preserves the bound address and port. CI uses Python 3.14 for the pinned tokenizer and checks daemon startup before running the full gate.

## Included

- 🧾 Source-bound oracle proofs required for task completion.
- 🔒 Atomic ownership with epoch fencing. Workers keep leases alive and acknowledge cancellation.
- 🗺️ Goal trees with executable leaves. Atomic plans preserve dependencies; gates and merge slots coordinate shared work.
- 🧠 Persistent project knowledge. Checkpoints support resume and fenced handoff.
- 🔬 Required attestations for test evidence and command runs, plus optional review receipts.
- 💸 A recorded-cost ledger with subtree rollups. Optional budget checks apply at close.
- 🔁 Leased outbox delivery with idempotency. Replay requires an explicit contract.
- 🔌 Rust/Python implementations, 85 operations, CLI, MCP, socket and local HTTP board.
- ⚙️ Opt-in macOS local command workflow, sandbox and bounded service/watchdog.
- 📦 JSONL snapshots and conflict-aware exchange. Beads exports have an explicit migration path.

The launch includes original generated cover artwork, English/German READMEs, a runnable proof-loop demo, a complete operation catalog and a sourced emoji comparison against Beads, beads_rust, Task Master AI, Vibe Kanban and Taskwarrior.

## Install

This is a **source release**; no cross-platform binary packages are claimed.

```bash
git clone https://github.com/Supersynergy/superiss.git
cd superiss
CARGO_TARGET_DIR=.cache/cargo cargo build --locked -j2
python3 examples/quickstart.py
```

Read the [getting-started guide](GETTING-STARTED.md) for dependencies and platform boundaries. General tracker operations and the explicit macOS sandbox/service are separate capabilities.

## Validation and limits

The full local project gate passed for both implementations, alongside 35 Bun service tests and the runnable demo. Publication secret scanning found no leaks. See [validation](VALIDATION.md) for skips, static-analysis findings and source provenance.

The market comparison is documentation research, not a competitor benchmark. Cost entries are observations rather than invoices. A passing oracle proves its own checked behavior; source hashes do not make a weak check sufficient. No completed 24-hour availability claim or production reliability claim is made.

## Optional sisf 0.1.1

Adds a Bun forge adapter beside the unchanged 0.9.1 core: claim/worktree binding, computed Git changes, artifact records, a task × worktree board, Gitea PR/status APIs, GitHub PR creation through `gh`, explicit mirror push and conservative cleanup. Ownership, socket failures and native watch framing have regression coverage. See [setup and boundaries](SISF.md) and the [forge comparison](FORGE-COMPARISON.md).

Gitea API validation uses a local HTTP fixture. Merge protection and production forge acceptance remain environment-specific. The new hero is configured as the repository's Social Preview.
