# Superiss vs five established alternatives

Research snapshot: **23 October 2026**. These five tools cover adjacent needs: agent memory, a Rust local tracker, AI-assisted planning, visual agent orchestration and a mature terminal task manager. This is a curated shortlist, not a claim that all five rank highest by a single global metric.

✅ = documented in the cited primary sources. 🧩 = optional integration, hook or different mechanism. 🔎 = the reviewed sources do not establish the exact capability. 🔎 does not mean impossible or absent everywhere. This is documentation research, not a hands-on competitor benchmark.

| Capability | **Superiss** | **Beads** | **beads_rust** | **Task Master AI** | **Vibe Kanban** | **Taskwarrior** |
| --- | --- | --- | --- | --- | --- | --- |
| 🎯 Main strength | Verified agent coordination | Durable agent memory | Local Rust tracker | AI-assisted planning | Visual agent orchestration | Terminal task management |
| 🗃️ Persistent local task data | ✅ SQLite | ✅ Dolt | ✅ SQLite + JSONL | ✅ Project task files | ✅ Local backend | ✅ Local task store |
| 🔗 Dependency-aware tasks | ✅ Typed edges + readiness | ✅ Graph + ready queue | ✅ Graph + ready queue | ✅ Dependencies | 🔎 | ✅ Dependencies |
| 🗺️ Hierarchy / decomposition | ✅ Goals + atomic plan trees | ✅ Epics + subtasks | ✅ Epics + children | ✅ PRD → subtasks | ✅ Board projects/tasks | 🧩 Projects + dependencies |
| 🔌 Agent/tool interface | ✅ CLI + MCP + HTTP | ✅ CLI + agent setup | ✅ CLI + optional MCP | ✅ CLI + MCP | ✅ Agent integrations + MCP | ✅ CLI + hooks |
| 🧾 Native source-bound proof required to close | ✅ Revision + source hash + proof | 🔎 | 🔎 | 🔎 | 🔎 | 🧩 Custom hooks |
| 🔒 Actor + epoch + expiring task lease | ✅ Fenced ownership | 🧩 Atomic claim; exact contract differs | 🧩 Claim/coordination; exact contract differs | 🔎 | 🔎 | 🔎 |
| ♻️ Source-bound checkpoints + replay contract | ✅ Checkpoint / resume / local run | 🧩 Persistent memory | 🧩 Persistent issue history | 🧩 Persistent task state | 🧩 Agent sessions | 🧩 Task state + annotations |
| 🖥️ Browser board in core | ✅ Local board | 🧩 Community tools | 🧩 Companion tools | 🧩 Editor integrations | ✅ Central interface | 🧩 Third-party tools |
| 🤖 Built-in AI planning | 🧩 Bring your agent | 🧩 Bring your agent | 🧩 Bring your agent | ✅ Model-assisted commands | ✅ Connected coding agents | 🧩 External tooling |
| 💸 Recorded-cost rollup + close budget gate | ✅ Explicit ledger | 🔎 | 🔎 | 🔎 | 🔎 | 🧩 Custom fields/hooks |
| 🛡️ Explicit sandboxed local command-to-close flow | ✅ macOS `local_zero` | 🔎 | 🔎 | 🔎 | 🧩 Isolated worktrees differ from sandboxing | 🔎 |

The strict proof/lease/checkpoint rows describe Superiss' specific contract, not generic checklists or assignment. Other products may achieve similar outcomes through extensions or workflows. Confirm the exact release and integration before choosing.

## Where each tool fits

| Tool | Best reason to consider it | Tradeoff relevant to Superiss users | Primary source |
| --- | --- | --- | --- |
| **Beads** | Agent-oriented memory, typed graph and a substantial ecosystem. | Dolt branching/sync is a distinct storage model; a documented atomic claim alone does not establish Superiss' proof contract. | [Repository](https://github.com/gastownhall/beads/tree/bc0cc87fd9fda412e2eaca669fa6ae3ec2c713fb) |
| **beads_rust** | Rust tracker with SQLite, explicit JSONL exchange and optional MCP. | Its current workflow/coordination capabilities deserve evaluation; this review does not establish matching source-bound close proofs. | [Repository](https://github.com/Dicklesworthstone/beads_rust/tree/1ef8421bdb7400f9d6ab235fef449015df59fe8a) |
| **Task Master AI** | PRD decomposition, task expansion and model-assisted research/planning. | AI commands depend on configured providers or supported host authentication. Evaluate provider usage separately from task storage. | [Repository](https://github.com/eyaltoledano/claude-task-master/tree/c0c98d367c55296bfe69e65680625b6db437af02) |
| **Vibe Kanban** | Plan, run and review coding agents through a visual worktree workflow. | Its official site currently announces sunsetting with open-source/community continuation. Worktree isolation is not the Superiss local-zero sandbox contract. | [Repository](https://github.com/BloopAI/vibe-kanban/tree/d5cbb5380fa0b32e98ef9b8d987f63decce4be3a), [official site](https://www.vibekanban.com/) |
| **Taskwarrior** | Mature terminal workflows, dependencies, filters, sync and hooks. | General task management rather than a built-in agent acceptance protocol; custom hooks can enforce user-defined rules. | [Documentation](https://taskwarrior.org/docs/), [hooks](https://taskwarrior.org/docs/hooks/) |

## Market signal and method

GitHub API observations on the snapshot date: Vibe Kanban **28,438** stars; Task Master AI **28,269**; Beads **28,137**; Taskwarrior **6,132**; beads_rust **1,134**. These are repository visibility signals, not usage, revenue, correctness or market share. They explain the shortlist's visibility; they do not determine a product-quality ranking.

We reviewed official repositories, their READMEs and linked documentation. Repository HEADs are pinned above; Taskwarrior's inspected development HEAD was `c280c347c1adc47e9bb1ad42c92958e2d7f92e9c`. Counts and repository metadata are recorded in [the research snapshot](research/market-snapshot.json). The Superiss column is grounded in this release's source, registry and local verification gate. No comparative speed, cost-saving or superiority benchmark was executed.

The opportunity is specific: teams can already capture and dispatch agent work. Superiss focuses on making a completed task depend on a declared, executed acceptance check. That positioning is an inference from the reviewed feature sets, not evidence of customer demand.
