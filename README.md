<p align="center"><img src="assets/superiss-hero.png" alt="Superiss — Done needs proof. Local-first agent coordination." width="100%"></p>

<p align="center">
  <a href="https://github.com/Supersynergy/superiss/actions/workflows/ci.yml"><img src="https://github.com/Supersynergy/superiss/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-D7FF64?style=flat-square&labelColor=101410" alt="MIT license"></a>
  <a href="docs/OPERATIONS.md"><img src="https://img.shields.io/badge/operations-85-D7FF64?style=flat-square&labelColor=101410" alt="85 operations"></a>
  <img src="https://img.shields.io/badge/storage-local_SQLite-D7FF64?style=flat-square&labelColor=101410" alt="Local SQLite">
</p>

<h1 align="center">Your agent says done.<br>Superiss asks for proof.</h1>

<p align="center"><strong>Local-first task coordination and durable memory for AI agents.<br>A Beads alternative with executable acceptance, fenced ownership and recovery.</strong></p>

<p align="center"><a href="docs/GETTING-STARTED.md">Get started</a> · <a href="docs/FEATURES.md">All features</a> · <a href="docs/COMPARISON.md">Compare 5 tools</a> · <a href="docs/BEADS-ALTERNATIVE.md">Coming from Beads?</a> · <a href="README.de.md">Deutsch</a></p>

---

## The missing step between work and done

An agent can finish a conversation while leaving a broken feature behind. Superiss gives each task an executable acceptance contract and stores the result against the declared sources. Closing requires a matching proof, a live ownership lease and the current contract revision.

```text
PLAN → CLAIM → WORK → VERIFY → CLOSE
        │              │        │
   actor + epoch   run the    check proof,
   + live lease    oracle    revision + files
```

Changed files? The old proof expires. Stale worker? Its epoch is rejected. Missing required evidence? The task stays open. The oracle's quality still determines what a passing check proves.

## Built for work that survives the chat

| | What you get |
| --- | --- |
| 🧠 **Persistent memory** | Tasks, goals, dependencies, notes and project knowledge in SQLite. |
| 🧾 **Checked completion** | Execute the oracle; bind its receipt to sources and contract; require it at close. |
| 🔒 **Worker ownership** | Atomic claims, epochs, leases, heartbeat, cancellation and fenced handoff. |
| 🗺️ **Goal trees** | Atomic plans, subtasks, templates, ready queues, approval gates and merge slots. |
| 🔁 **Recovery** | Checkpoints, resume, leased outbox delivery and explicit replay rules. |
| 🔬 **Evidence** | JUnit, coverage, command runs and optional review/attestation requirements. |
| 💸 **Cost visibility** | Recorded usage, goal rollups, close-time budget gates and outcome aggregates. |
| 🔌 **Agent interfaces** | JSON CLI, Unix socket, MCP, loopback HTTP and a local browser board. |
| ⚙️ **Local execution** | Opt-in command-to-close workflow and a bounded macOS service. |
| 📦 **Portable state** | JSONL snapshots, conflict-aware sync and explicit Beads-export migration. |

**85 registered operations. Rust core. Python reference. No model API key required for the tracker.**

## Try the proof loop

You need Rust/Cargo, system SQLite development libraries and Python 3. Full sandbox/service features require macOS; Bun and Node.js support the service and MCP adapter. [Installation and platform boundaries →](docs/GETTING-STARTED.md)

```bash
git clone https://github.com/Supersynergy/superiss.git
cd superiss
CARGO_TARGET_DIR=.cache/cargo cargo build --locked -j2
python3 examples/quickstart.py
```

The demo uses a private temporary database and a real file. It rejects close without proof, executes the oracle, closes with its `proof_id` and reads back the result:

```text
✓ Claimed task with an actor, epoch and lease
✓ Close without proof rejected
✓ Oracle passed; source-bound proof stored
✓ Task closed and read back
```

For a persistent project, choose the database explicitly:

```bash
export SIS_DB="$PWD/.sis/project.db"
mkdir -p .sis
bin/sis serve --db "$SIS_DB" --http 8765
# Open http://127.0.0.1:8765 for the local board.
```

## Compare the approaches

Five established alternatives, researched **23 October 2026**. ✅ documented · 🧩 integration/different mechanism · 🔎 exact capability not established by the reviewed sources.

| | **Superiss** | **Beads** | **beads_rust** | **Task Master AI** | **Vibe Kanban** | **Taskwarrior** |
| --- | --- | --- | --- | --- | --- | --- |
| 🎯 Focus | Verified coordination | Agent memory | Local Rust tracker | AI planning | Visual orchestration | Terminal tasks |
| 🗃️ Local tasks | ✅ SQLite | ✅ Dolt | ✅ SQLite | ✅ Task files | ✅ Local backend | ✅ Local store |
| 🔗 Dependencies | ✅ | ✅ | ✅ | ✅ | 🔎 | ✅ |
| 🔌 Agent interface | ✅ CLI/MCP/HTTP | ✅ CLI/setup | ✅ CLI/MCP option | ✅ CLI/MCP | ✅ Agents/MCP | ✅ CLI/hooks |
| 🧾 Source-bound proof required at close | ✅ | 🔎 | 🔎 | 🔎 | 🔎 | 🧩 Hooks |
| 🔒 Actor + epoch + expiring task lease | ✅ | 🧩 Atomic claim | 🧩 Coordination | 🔎 | 🔎 | 🔎 |
| 💸 Cost rollup + close budget gate | ✅ | 🔎 | 🔎 | 🔎 | 🔎 | 🧩 Custom rules |
| 🖥️ Browser board | ✅ Local | 🧩 Community | 🧩 Companion | 🧩 Integrations | ✅ | 🧩 Third party |

[Read the sourced comparison, strengths, definitions and limits →](docs/COMPARISON.md)

This is a curated research comparison, not a performance ranking. 🔎 does not mean an extension could never implement the feature. Vibe Kanban's official site currently announces a transition to community maintenance.

## Use it with your agent

Start the project daemon, then add this adapter to a host supporting stdio MCP:

```json
{
  "mcpServers": {
    "superiss": {
      "command": "node",
      "args": ["/absolute/path/superiss/mcp/sis-mcp.js"],
      "env": {
        "SIS_DB": "/absolute/path/project/.sis/project.db",
        "SIS_MCP_PROFILE": "agent"
      }
    }
  }
}
```

The worker profile offers twelve tools. The host remains responsible for permissions, model access and acceptance quality. Any coding agent with shell access can also use the CLI.

## Read deeper

| Guide | Contents |
| --- | --- |
| [Getting started](docs/GETTING-STARTED.md) | Build, demo, persistent projects and requirements |
| [All features](docs/FEATURES.md) / [85 operations](docs/OPERATIONS.md) | Capabilities and complete registry-derived catalog |
| [Beads alternative](docs/BEADS-ALTERNATIVE.md) | Workflow mapping and deliberate export migration |
| [Five-tool comparison](docs/COMPARISON.md) | Emoji matrix, sources and market observations |
| [Protocol](SPEC.md) | Source binding, wire formats and operational limits |
| [Local execution](ZERO-RECOVERY.md) / [Service](SERVICE.md) | Sandbox, replay policy, lifecycle and watchdog |
| [Multiworker](MULTIWORKER.md) | Delivery fencing and benchmark methodology |
| [Release validation](docs/VALIDATION.md) | Executed checks and evidence boundaries |

## Honest boundaries

General `allowed_paths` metadata is not a sandbox. The explicit macOS local workflow adds sandboxing. Cost ledgers are recorded observations, not invoices; close-time gates do not authorize provider spending. Arbitrary external commands do not gain exactly-once semantics. Green local tests do not establish production reliability or a completed 24-hour soak.

The hero is generated conceptual artwork, not a screenshot. [MIT licensed](LICENSE). Built by [Supersynergy](https://github.com/Supersynergy).
