# Superiss, Worktrunk and Beads — 8 November 2026

Primary-source documentation/code review; no competitor performance benchmark. ✅ documented, △ different mechanism/integration, — exact capability not established. Current Superiss means 1.1 source, with the validation limits below.

| Capability | Superiss 1.2 | Worktrunk | Beads |
| --- | --- | --- | --- |
| Main purpose | Verified task coordination and Git integration | Worktree/merge ergonomics | Durable agent memory and issue graph |
| Tasks, goals and dependencies | ✅ SQLite | — | ✅ Dolt |
| Atomic claim | ✅ | — task-level | ✅ |
| Leases, heartbeat, dead-worker recovery | ✅ | △ Session markers | ✅ `heartbeat` / `reclaim` |
| Source-bound proof required at close | ✅ Current actor/epoch, revision, files | — | — equivalent contract not established |
| Read-only complete close preflight | ✅ `close_check` | — | — equivalent contract not established |
| Worktree lifecycle | ✅ Git or optional Worktrunk backend | ✅ Core purpose | ✅ `bd worktree` |
| Claim-to-worktree binding | ✅ Fenced bindings | △ Task integration | △ Separate commands |
| Local merge | ✅ Proof-gated fast-forward, no source rewrite | ✅ Squash/rebase/merge workflows | — equivalent pipeline not established |
| Build-cache sharing and rich picker | — native equivalent | ✅ | — equivalent not established |
| PR and CI | ✅ GitHub/Gitea/Forgejo connectors | ✅ Status/PR UX | ✅ Issue sync and PR/CI gates |
| Distributed task DB branching/sync | △ Explicit JSONL exchange | — task DB | ✅ Dolt |
| Recorded costs and close budget gate | ✅ | — | — exact contract not established |
| MCP | ✅ 88 core operations + eleven forge tools | △ Agent CLI plugins | △ Agent setup and ecosystem |

Beads now documents leases and heartbeat-based reclamation. The older Superiss table's “atomic claim only” wording is stale. Superiss' differentiation is the full source-bound proof/ownership/close contract, not the generic presence of claims or leases.

Worktrunk and Superiss can complement one another. In Superiss' optional backend, the adapter owns the task binding while Worktrunk performs explicit worktree creation and conservative merge. Hooks are disabled on automated calls; Worktrunk's complete independent hook/cache/picker feature set is not reimplemented or claimed as a Superiss core capability.

## Primary sources and limits

- [Worktrunk](https://github.com/max-sixty/worktrunk), [switch](https://worktrunk.dev/switch/), [merge](https://worktrunk.dev/merge/), [agent integration](https://worktrunk.dev/claude-code/).
- [Beads](https://github.com/gastownhall/beads), [reclaim/leases](https://github.com/gastownhall/beads/blob/main/docs/cli-reference/reclaim.md), [worktree commands](https://github.com/gastownhall/beads/blob/main/docs/cli-reference/worktree.md), [dependencies and gates](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/dependencies.md).
- [Superiss features](FEATURES.md), [forge behavior](SISF.md), [current validation](VALIDATION.md).

The [older five-tool comparison](archive/0.9/COMPARISON.md) is retained as a dated historical snapshot. Its counts, release observations and competitive claims are not current measurements.
